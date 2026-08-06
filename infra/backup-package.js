'use strict';
/**
 * infra/backup-package.js — complete system backup and recovery (P5.1).
 *
 * ══════════════════════════════════════════════════════════════════
 * The problem this fixes
 * ══════════════════════════════════════════════════════════════════
 * `admin.backup()` is `VACUUM INTO` — it copies kd.db and nothing else. Measured
 * on the live system before this module existed:
 *
 *     database        4.3 MB   backed up
 *     uploads       686.0 MB   NOT backed up   (3 212 files, 2 939 referenced)
 *     audit-chain.key    64 B  NOT backed up
 *
 * So a restore returned 881 worker records, 2 445 document ROWS, and zero
 * document images. It also returned an audit trail that could no longer be
 * verified, because the HMAC key lives outside the database and was never
 * copied. Recovery coverage by bytes: 0.62%.
 *
 * Worse, P4.6's verification told the operator "Restorable" — true of the
 * database file, dangerously misleading about the system.
 *
 * A backup package fixes all three: one archive holding the database, every
 * upload, the chain key, and a manifest that makes each of them checkable.
 *
 * ══════════════════════════════════════════════════════════════════
 * Design decisions worth knowing
 * ══════════════════════════════════════════════════════════════════
 * 1. TWO TIERS, both honestly labelled. Full packages (.zip) are the recovery
 *    artefact. Database snapshots (.db) are kept — they are seconds to make and
 *    are the right pre-restore safety net — but the health dashboard scores them
 *    as partial, so the UI can never again imply a .db is full recovery.
 *
 * 2. THE DATABASE IS SNAPSHOTTED, NOT COPIED. `VACUUM INTO` produces a
 *    transactionally consistent file while the server keeps serving. Reading
 *    kd.db with the filesystem while WAL is active would capture a torn state.
 *
 * 3. THE KEY IS IN THE PACKAGE, AND THAT IS A DELIBERATE TRADE. Without it a
 *    recovered system cannot verify its own audit history — the evidence
 *    survives but becomes unprovable. With it, anyone holding the package holds
 *    the key. The package is therefore as sensitive as the database itself, which
 *    it already was (it contains every passport scan). See `SECURITY` below.
 *
 * 4. ORPHANS ARE INCLUDED. 286 upload files are referenced by no database row.
 *    They are backed up anyway: a file that looks orphaned because of a bug we
 *    have not found yet is not a file to discard during a disaster-recovery
 *    build. Cleanup is a separate, deliberate operation.
 */
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const dbmod = require('./db');
const zip   = require('./zip');

/* Package layout. These names are part of the format — an operator who unzips a
 * package by hand relies on them, and so does restore(). */
const ENTRY_DB       = 'kd.db';
const ENTRY_KEY      = 'audit-chain.key';
const ENTRY_MANIFEST = 'manifest.json';
const ENTRY_UPLOADS  = 'uploads/';        // prefix

const PACKAGE_VERSION = 1;
const PACKAGE_EXT     = '.zip';

/* ══════════════════════════════════════════════════════════════════
 * SECURITY
 * ══════════════════════════════════════════════════════════════════
 * A package contains every passport scan and the audit-chain key. It is the most
 * sensitive artefact this system produces. Consequences, enforced elsewhere but
 * recorded here because this is where the artefact is created:
 *
 *   • creation and download need `backup.create`; restore needs `backup.restore`
 *   • download is served with no-store and attachment disposition
 *   • every create/verify/download/restore is written to the audit trail
 *   • offsite copies go to a private bucket, never a public one
 *
 * What this module does NOT do is encrypt the package. Encryption without a
 * managed key is theatre — the key would have to live beside the backup to be
 * usable in a disaster, which is where the audit-chain key already is. Recorded
 * as a known limitation rather than implemented badly.
 */

function _dirSize(dir) {
  let bytes = 0, count = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs);
      else { try { bytes += fs.statSync(abs).size; count++; } catch (e) {} }
    }
  };
  walk(dir);
  return { bytes, count };
}

/** Every file under uploads/, as { abs, rel } with forward-slash relative paths. */
function _listUploads() {
  const root = dbmod.UPLOADS_DIR;
  const out = [];
  const walk = (d, prefix) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    // Sorted so two packages of identical content list entries in the same order,
    // which makes diffing two manifests meaningful.
    ents.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const ent of ents) {
      const abs = path.join(d, ent.name);
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, rel);
      else out.push({ abs, rel });
    }
  };
  walk(root, '');
  return out;
}

/** Upload paths the database currently references, as absolute paths. */
function _referencedPaths() {
  const set = new Set();
  const add = (p) => {
    if (typeof p === 'string' && p.startsWith('/uploads/'))
      set.add(path.join(dbmod.UPLOADS_DIR, p.replace(/^\/uploads\//, '')));
  };
  try {
    dbmod.db.prepare('SELECT photo_path, photo_orig, photo_thumb FROM employees').all()
      .forEach(r => { add(r.photo_path); add(r.photo_orig); add(r.photo_thumb); });
  } catch (e) {}
  try {
    dbmod.db.prepare('SELECT file_path FROM documents').all().forEach(r => add(r.file_path));
  } catch (e) {}
  return set;
}

function _rowCounts(handle) {
  const h = handle || dbmod.db;
  const one = (sql) => { try { return h.prepare(sql).get().c; } catch (e) { return null; } };
  return {
    employees: one('SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NULL'),
    groups:    one('SELECT COUNT(*) AS c FROM groups WHERE deleted_at IS NULL'),
    documents: one('SELECT COUNT(*) AS c FROM documents'),
    passports: one('SELECT COUNT(*) AS c FROM passports'),
    users:     one('SELECT COUNT(*) AS c FROM users'),
    auth_log:  one('SELECT COUNT(*) AS c FROM auth_log'),
    roles:     one('SELECT COUNT(*) AS c FROM roles'),
    settings:  one('SELECT COUNT(*) AS c FROM app_settings'),
  };
}

function _appVersion() {
  try { return require('../package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
}

/** Current audit chain head, so a package records what the trail looked like. */
function _chainHead() {
  try {
    const r = dbmod.db.prepare(
      'SELECT row_hash FROM auth_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    return r ? r.row_hash : null;
  } catch (e) { return null; }
}

function timestampName(d) {
  const iso = (d || new Date()).toISOString();
  return iso.slice(0, 19).replace(/[:]/g, '-').replace('T', '_');
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 2 — create a full system package
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Build backup-YYYYMMDD-HHMMSS.zip containing the whole system.
 *
 * @param {object} opts { dir (required), by, reason, onProgress }
 * @returns package summary including the manifest
 */
function createPackage(opts) {
  const o = opts || {};
  if (!o.dir) throw new Error('createPackage requires a destination dir');
  fs.mkdirSync(o.dir, { recursive: true });

  const started = Date.now();
  const stamp = new Date();
  let name = 'backup-' + timestampName(stamp) + PACKAGE_EXT;
  // Collision guard, same reasoning as the P4.5 fix to admin.backup(): two
  // packages inside one second must not overwrite each other.
  for (let n = 2; fs.existsSync(path.join(o.dir, name)) && n < 100; n++)
    name = 'backup-' + timestampName(stamp) + '-' + n + PACKAGE_EXT;
  const dest = path.join(o.dir, name);

  /* A consistent database snapshot, taken to a temp file first. Reading kd.db
   * directly while WAL is active would archive a torn state that might not even
   * open. */
  const tmpDb = path.join(o.dir, '.snapshot-' + Date.now() + '.db');
  try { fs.unlinkSync(tmpDb); } catch (e) {}
  dbmod.db.exec("VACUUM INTO '" + tmpDb.replace(/'/g, "''") + "'");

  const writer = new zip.ZipWriter(dest);
  let manifest = null;

  try {
    const dbEntry = writer.addFile(ENTRY_DB, tmpDb, { compress: true });

    // The chain key. Absent on an installation that never enabled chaining —
    // recorded as absent rather than failing the backup.
    const keyPath = path.join(dbmod.DB_DIR, 'audit-chain.key');
    let keyEntry = null;
    if (fs.existsSync(keyPath)) keyEntry = writer.addFile(ENTRY_KEY, keyPath, { compress: false });

    // Uploads. Streamed one at a time; nothing is held in memory.
    const referenced = _referencedPaths();
    const files = _listUploads();
    const uploadEntries = [];
    let uploadBytes = 0, referencedCount = 0, orphanCount = 0;

    files.forEach((f, i) => {
      let e;
      try {
        e = writer.addFile(ENTRY_UPLOADS + f.rel, f.abs, { compress: false });
      } catch (err) {
        /* A file that vanished mid-backup (a concurrent delete) must not abort
         * the whole package. It is skipped and named in the manifest, so the
         * gap is recorded rather than silently absent. */
        uploadEntries.push({ name: ENTRY_UPLOADS + f.rel, error: String(err && err.message || err) });
        return;
      }
      uploadBytes += e.size;
      const isRef = referenced.has(f.abs);
      if (isRef) referencedCount++; else orphanCount++;
      uploadEntries.push({ name: e.name, size: e.size, sha256: e.sha256, referenced: isRef });
      if (o.onProgress && (i % 250 === 0)) o.onProgress({ done: i + 1, total: files.length });
    });

    /* Referenced files that are not on disk at all. This is the "missing files"
     * check the spec asks for, and it found 13 real cases on the live system —
     * database rows pointing at images that no longer exist. A backup should
     * record that, not hide it. */
    const missingReferenced = [];
    for (const abs of referenced) {
      if (!fs.existsSync(abs)) {
        missingReferenced.push('/uploads/' + path.relative(dbmod.UPLOADS_DIR, abs).split(path.sep).join('/'));
      }
    }

    manifest = {
      package_version: PACKAGE_VERSION,
      kind: 'full',
      created_at: stamp.toISOString(),
      created_by: o.by || 'system',
      reason: o.reason || 'manual',
      app_version: _appVersion(),

      database: {
        entry: ENTRY_DB,
        size: dbEntry.size,
        sha256: dbEntry.sha256,
        rows: _rowCounts(),
      },
      audit_chain: {
        entry: keyEntry ? ENTRY_KEY : null,
        key_present: !!keyEntry,
        key_sha256: keyEntry ? keyEntry.sha256 : null,
        head: _chainHead(),
      },
      uploads: {
        prefix: ENTRY_UPLOADS,
        file_count: uploadEntries.filter(e => !e.error).length,
        size: uploadBytes,
        referenced_count: referencedCount,
        orphan_count: orphanCount,
        /* Referenced-but-absent, carried in the manifest so verification can
         * report it without re-querying a database it may not have. */
        missing_referenced: missingReferenced,
        skipped: uploadEntries.filter(e => e.error),
        files: uploadEntries.filter(e => !e.error),
      },
    };

    // Totals, computed after the parts are known.
    manifest.file_count = 1 + (keyEntry ? 1 : 0) + manifest.uploads.file_count + 1;   // +manifest itself
    manifest.database_size = dbEntry.size;
    manifest.uploads_size = uploadBytes;

    writer.addBuffer(ENTRY_MANIFEST, JSON.stringify(manifest, null, 2), { compress: true });
    const result = writer.close();

    /* The package's own digest, over the finished archive. Recorded by the
     * caller in the backup manifest so a later verification can tell a file that
     * was MODIFIED from one that is merely old. */
    const sha256 = _sha256File(dest);

    return {
      file: name, path: dest, bytes: result.bytes, sha256,
      manifest, entries: result.entries.length,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    writer.abort();
    throw e;
  } finally {
    try { fs.unlinkSync(tmpDb); } catch (e) {}
  }
}

function _sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 3 — verification
 * ══════════════════════════════════════════════════════════════════
 * Four independent checks, reported separately. "Partially recoverable" is a
 * real and useful answer: a package whose database is sound but is missing 40
 * images is worth knowing about precisely, not collapsing into "corrupt".
 */

const STATUS_FULL      = 'fully-recoverable';
const STATUS_PARTIAL   = 'partially-recoverable';
const STATUS_CORRUPTED = 'corrupted';

/**
 * Verify a package without extracting it anywhere permanent.
 *
 * @param {string} absPath
 * @param {object} opts { deep: verify EVERY upload's CRC (slow), expectSha256 }
 */
function verifyPackage(absPath, opts) {
  const o = opts || {};
  const started = Date.now();
  const report = {
    file: path.basename(absPath), path: absPath,
    exists: false, readable: false, bytes: 0,
    packageSha256: null, expectedSha256: o.expectSha256 || null, packageChecksumOk: null,
    manifest: { valid: false, errors: [] },
    database: { valid: false, integrity: null, rows: null, errors: [] },
    audit:    { valid: false, keyPresent: false, head: null, chain: null, errors: [] },
    uploads:  { valid: false, expected: 0, present: 0, missing: [], corrupt: [], checked: 0, deep: !!o.deep, errors: [] },
    status: STATUS_CORRUPTED,
    durationMs: 0,
  };

  if (!fs.existsSync(absPath)) {
    report.manifest.errors.push('package not found');
    report.durationMs = Date.now() - started;
    return report;
  }
  report.exists = true;
  try { report.bytes = fs.statSync(absPath).size; } catch (e) {}
  if (report.bytes === 0) {
    report.manifest.errors.push('package is empty');
    report.durationMs = Date.now() - started;
    return report;
  }

  // Whole-archive digest, when the caller has a recorded value to compare.
  try {
    report.packageSha256 = _sha256File(absPath);
    if (o.expectSha256) report.packageChecksumOk = (report.packageSha256 === o.expectSha256);
  } catch (e) { report.manifest.errors.push('checksum failed: ' + (e && e.message || e)); }

  let reader = null;
  let tmpDir = null;
  try {
    reader = new zip.ZipReader(absPath);
    report.readable = true;

    /* ── Manifest ── */
    let manifest = null;
    try {
      manifest = JSON.parse(reader.readFile(ENTRY_MANIFEST).toString('utf8'));
      const need = ['package_version', 'created_at', 'app_version', 'database', 'uploads'];
      const missing = need.filter(k => manifest[k] === undefined);
      if (missing.length) report.manifest.errors.push('manifest missing: ' + missing.join(', '));
      else report.manifest.valid = true;
      report.manifest.data = manifest;
      report.manifest.createdAt = manifest.created_at;
      report.manifest.createdBy = manifest.created_by;
      report.manifest.appVersion = manifest.app_version;
      report.manifest.packageVersion = manifest.package_version;
      if (manifest.package_version > PACKAGE_VERSION) {
        report.manifest.errors.push(
          'package was written by a newer build (v' + manifest.package_version +
          '); this build understands v' + PACKAGE_VERSION);
        report.manifest.valid = false;
      }
    } catch (e) {
      report.manifest.errors.push('unreadable manifest: ' + (e && e.message || e));
    }

    /* ── Database ──
     * Extracted to a temp file and opened READ-ONLY. A database inside an
     * archive cannot be integrity-checked in place. */
    tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'kd-verify-'));
    try {
      const dbTmp = path.join(tmpDir, 'kd.db');
      const ex = reader.extractTo(ENTRY_DB, dbTmp);
      if (manifest && manifest.database && manifest.database.sha256 &&
          ex.sha256 !== manifest.database.sha256) {
        report.database.errors.push('database digest does not match the manifest');
      }
      const { DatabaseSync } = require('node:sqlite');
      const h = new DatabaseSync(dbTmp, { readOnly: true });
      try {
        const rows = h.prepare('PRAGMA integrity_check').all();
        report.database.integrity = rows.map(r => String(Object.values(r)[0])).join('; ');
        report.database.rows = _rowCounts(h);
        const tables = new Set(h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
        const required = ['users', 'employees', 'documents', 'passports', 'groups', 'app_settings', 'auth_log', 'roles'];
        const missingTables = required.filter(t => !tables.has(t));
        if (missingTables.length) report.database.errors.push('missing tables: ' + missingTables.join(', '));

        /* ── Audit chain, verified INSIDE the package ──
         * Uses the key from the package when present, which is the only way to
         * check that the package is self-sufficient: a key that does not match
         * its own database is a package that cannot prove its history after a
         * bare-metal restore. */
        report.audit.head = manifest && manifest.audit_chain ? manifest.audit_chain.head : null;
        let key = null;
        if (reader.has(ENTRY_KEY)) {
          report.audit.keyPresent = true;
          const hex = reader.readFile(ENTRY_KEY).toString('utf8').trim();
          if (/^[0-9a-f]{64}$/i.test(hex)) key = Buffer.from(hex, 'hex');
          else report.audit.errors.push('the packaged key is not a 32-byte hex key');
        } else {
          report.audit.errors.push('no audit-chain key in the package — a restored system could not verify its own history');
        }
        if (key) {
          const chainmod = require('./audit-chain');
          const cols = h.prepare('PRAGMA table_info(auth_log)').all().map(c => c.name);
          if (!cols.includes('row_hash')) {
            report.audit.chain = { available: false, reason: 'database predates hash chaining' };
            report.audit.valid = true;      // legitimately unchained, not corrupt
          } else {
            const rows2 = h.prepare(
              'SELECT ' + chainmod.CHAINED_FIELDS.join(',') + ', prev_hash, row_hash FROM auth_log ORDER BY id'
            ).all();
            const v = chainmod.verifyChain(key, rows2);
            report.audit.chain = { available: true, ok: v.ok, rows: v.rows, verified: v.verified,
                                   brokenAtId: v.brokenAtId, brokenReason: v.brokenReason, unhashed: v.unhashed };
            report.audit.valid = v.ok;
            if (!v.ok) report.audit.errors.push('chain broken at row ' + v.brokenAtId + ': ' + v.brokenReason);
          }
        }
      } finally { try { h.close(); } catch (e) {} }

      report.database.valid = report.database.integrity === 'ok' && report.database.errors.length === 0;
    } catch (e) {
      report.database.errors.push('database unusable: ' + (e && e.message || e));
    }

    /* ── Uploads ──
     * The manifest lists every file with its digest. Presence and CRC are always
     * checked; SHA-256 of every file only in deep mode, because that means
     * reading 686 MB and an operator asking "is this backup OK?" should not wait
     * for that by default.
     */
    if (manifest && manifest.uploads) {
      const expected = manifest.uploads.files || [];
      report.uploads.expected = expected.length;
      const present = new Set(reader.entries.map(e => e.name));
      expected.forEach(f => {
        if (!present.has(f.name)) { report.uploads.missing.push(f.name); return; }
        report.uploads.present++;
      });

      const toCheck = o.deep ? expected.filter(f => present.has(f.name)) : [];
      toCheck.forEach(f => {
        const v = reader.verifyEntry(f.name);
        report.uploads.checked++;
        if (!v.ok) report.uploads.corrupt.push(f.name);
      });

      // Not deep: still CRC a sample, so a wholly corrupt archive is caught fast.
      if (!o.deep && expected.length) {
        const step = Math.max(1, Math.floor(expected.length / 25));
        for (let i = 0; i < expected.length; i += step) {
          const f = expected[i];
          if (!present.has(f.name)) continue;
          const v = reader.verifyEntry(f.name);
          report.uploads.checked++;
          if (!v.ok) report.uploads.corrupt.push(f.name);
        }
      }
      report.uploads.valid = report.uploads.missing.length === 0 && report.uploads.corrupt.length === 0;
      report.uploads.missingReferencedAtBackupTime = manifest.uploads.missing_referenced || [];
      report.uploads.skippedAtBackupTime = manifest.uploads.skipped || [];
    } else {
      report.uploads.errors.push('manifest does not describe the uploads');
    }
  } catch (e) {
    report.manifest.errors.push('unreadable archive: ' + (e && e.message || e));
  } finally {
    if (reader) reader.close();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {} }
  }

  /* ── Overall status ──
   * Deliberately three-valued. Anything that makes the database unusable is
   * CORRUPTED, because without it nothing else can be restored. Missing images or
   * an unverifiable chain still leave a usable system, so they are PARTIAL — an
   * operator can make an informed choice instead of being told "corrupt" and
   * discarding a package that would have recovered 95% of the business.
   */
  if (!report.readable || !report.database.valid || !report.manifest.valid ||
      report.packageChecksumOk === false) {
    report.status = STATUS_CORRUPTED;
  } else if (report.uploads.valid && report.audit.valid) {
    report.status = STATUS_FULL;
  } else {
    report.status = STATUS_PARTIAL;
  }
  report.databaseValid = report.database.valid;
  report.auditValid    = report.audit.valid;
  report.uploadsValid  = report.uploads.valid;
  report.manifestValid = report.manifest.valid;
  report.durationMs = Date.now() - started;
  return report;
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 4 — restore preview
 * ══════════════════════════════════════════════════════════════════ */

/**
 * What restoring this package would change, computed before anything is touched.
 *
 * Reports gains and losses per entity AND for the image set, which the P4.6
 * preview could not do because the images were never in a backup to compare
 * against.
 */
function previewPackage(absPath, opts) {
  const o = opts || {};
  const verification = verifyPackage(absPath, { expectSha256: o.expectSha256 });

  const live = _rowCounts();
  const liveUploads = _dirSize(dbmod.UPLOADS_DIR);
  const backupRows = verification.database.rows || {};
  const backupUploads = verification.manifest.data
    ? verification.manifest.data.uploads : null;

  const delta = {};
  Object.keys(live).forEach(k => {
    const b = backupRows[k];
    delta[k] = (b == null || live[k] == null) ? null : b - live[k];
  });
  const uploadDelta = backupUploads ? backupUploads.file_count - liveUploads.count : null;

  const RECORD_KEYS = ['employees', 'groups', 'documents', 'passports', 'users'];
  const willLose = {}, willGain = {};
  RECORD_KEYS.forEach(k => {
    if (delta[k] == null) return;
    if (delta[k] < 0) willLose[k] = -delta[k];
    else if (delta[k] > 0) willGain[k] = delta[k];
  });
  if (uploadDelta != null) {
    if (uploadDelta < 0) willLose.upload_files = -uploadDelta;
    else if (uploadDelta > 0) willGain.upload_files = uploadDelta;
  }

  return {
    file: path.basename(absPath),
    verification,
    createdAt: verification.manifest.createdAt || null,
    createdBy: verification.manifest.createdBy || null,
    appVersion: verification.manifest.appVersion || null,
    currentAppVersion: _appVersion(),
    /* A package from a different build is restorable — migrations are
     * idempotent and run on the next boot — but the operator should be told,
     * because a downgrade can mean a schema this build has since moved past. */
    versionMismatch: !!(verification.manifest.appVersion &&
                        verification.manifest.appVersion !== _appVersion()),

    databaseSize: verification.manifest.data ? verification.manifest.data.database_size : null,
    uploadsSize:  verification.manifest.data ? verification.manifest.data.uploads_size : null,

    live: Object.assign({}, live, { upload_files: liveUploads.count, upload_bytes: liveUploads.bytes }),
    backup: Object.assign({}, backupRows, {
      upload_files: backupUploads ? backupUploads.file_count : null,
      upload_bytes: backupUploads ? backupUploads.size : null,
    }),
    delta: Object.assign({}, delta, { upload_files: uploadDelta }),
    willLose, willGain,
    losesRecords: Object.keys(willLose).length > 0,

    /* Audit rows the live system has beyond the package. These are PRESERVED by
     * restore (P4.5) and the chain re-anchored (P4.6), so this is information,
     * not a loss warning — naming it that way keeps the real warning credible. */
    auditRowsNewerThanBackup: delta.auth_log != null && delta.auth_log < 0 ? -delta.auth_log : 0,
    auditTrailPreserved: true,

    safe: verification.status === STATUS_FULL,
    status: verification.status,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 5 — safe restore
 * ══════════════════════════════════════════════════════════════════
 * The most destructive operation in the product. Every step below exists because
 * of a way this can go wrong:
 *
 *   verify first          — a corrupt package must never be applied
 *   pre-restore package   — a FULL one, not database-only: you are about to
 *                           overwrite 686 MB of images, and a database snapshot
 *                           cannot undo that. Making the safety net weaker than
 *                           the operation is how P5.1's whole finding happened.
 *   uploads via swap      — extract to a sibling directory, then rename. A crash
 *                           mid-extraction leaves the live set untouched.
 *   preserve the trail    — read auth_log out before the swap, merge after
 *   re-anchor the chain   — ids change on merge, so the chain is rebuilt and the
 *                           rebuild recorded (P4.6)
 *   keep the local key    — unless there is none. Replacing a working key would
 *                           orphan verification of every report already issued
 *                           under it.
 */

/**
 * Restore a full system package.
 *
 * Reports every stage so the caller can write precise audit events. Throws only
 * on a refusal (corrupt package); operational failures are returned so the
 * caller can log BACKUP_RESTORE_FAILED with a reason.
 *
 * @param {string} absPath
 * @param {object} opts { by, backupDir, expectSha256, allowPartial, dryRun }
 */
function restorePackage(absPath, opts) {
  const o = opts || {};
  const started = Date.now();
  const stages = [];
  const stage = (name, ok, detail) => { stages.push({ name, ok, detail: detail == null ? null : String(detail) }); };

  /* ── 1. Verify before touching anything ── */
  const verification = verifyPackage(absPath, { deep: true, expectSha256: o.expectSha256 });
  stage('verify', verification.status !== STATUS_CORRUPTED, verification.status);

  if (verification.status === STATUS_CORRUPTED) {
    return { ok: false, refused: true, reason: 'package-corrupted',
             verification, stages, durationMs: Date.now() - started };
  }
  /* A partially-recoverable package is a judgement call, so it is the operator's
   * to make — but they have to make it explicitly. Silently restoring a package
   * with 40 missing images would recreate exactly the false confidence this phase
   * set out to remove. */
  if (verification.status === STATUS_PARTIAL && !o.allowPartial) {
    return { ok: false, refused: true, reason: 'package-partial',
             detail: 'uploads or audit chain incomplete; pass allowPartial to proceed',
             verification, stages, durationMs: Date.now() - started };
  }

  if (o.dryRun) {
    return { ok: true, dryRun: true, verification, stages, durationMs: Date.now() - started };
  }

  const admin = require('./admin');
  const backupDir = o.backupDir || path.join(dbmod.DATA_DIR, 'backups');

  /* ── 2. Pre-restore snapshot of the whole system ── */
  let safety = null, safetyError = null;
  try {
    safety = createPackage({ dir: backupDir, by: o.by || 'system',
                             reason: 'pre-restore of ' + path.basename(absPath) });
    stage('pre-restore-package', true, safety.file);
  } catch (e) {
    safetyError = String(e && e.message || e);
    stage('pre-restore-package', false, safetyError);
    /* Not fatal, but it changes the risk profile completely, so it is reported
     * and recorded rather than swallowed — the P4.5 lesson. */
    console.error('[restore] PRE-RESTORE PACKAGE FAILED — the overwritten state is not recoverable:', safetyError);
  }

  const reader = new zip.ZipReader(absPath);
  const tmpRoot = path.join(dbmod.DATA_DIR, '.restore-' + Date.now());
  const replacedUploads = dbmod.UPLOADS_DIR + '.replaced-' + Date.now();
  let uploadsSwapped = false;

  try {
    fs.mkdirSync(tmpRoot, { recursive: true });

    /* ── 3. Stage the database and the uploads OUTSIDE the live paths ──
     * Nothing live is modified until every byte has been extracted and
     * CRC-checked, so a failure here costs nothing. */
    const stagedDb = path.join(tmpRoot, 'kd.db');
    reader.extractTo(ENTRY_DB, stagedDb);
    stage('extract-database', true);

    const manifest = JSON.parse(reader.readFile(ENTRY_MANIFEST).toString('utf8'));
    const uploadEntries = (manifest.uploads && manifest.uploads.files) || [];
    const stagedUploads = path.join(tmpRoot, 'uploads');
    fs.mkdirSync(stagedUploads, { recursive: true });

    let extracted = 0;
    const failedFiles = [];
    for (const f of uploadEntries) {
      const rel = f.name.slice(ENTRY_UPLOADS.length);
      try {
        const res = reader.extractTo(f.name, path.join(stagedUploads, rel));
        if (f.sha256 && res.sha256 !== f.sha256) {
          failedFiles.push({ name: f.name, error: 'digest mismatch' });
        } else extracted++;
      } catch (e) {
        failedFiles.push({ name: f.name, error: String(e && e.message || e) });
      }
    }
    stage('extract-uploads', failedFiles.length === 0, extracted + '/' + uploadEntries.length);
    if (failedFiles.length && !o.allowPartial) {
      throw new Error('extraction failed for ' + failedFiles.length + ' upload(s); nothing was changed');
    }

    /* ── 4. Preserve the audit trail before the database is replaced ── */
    const preserved = admin.readAuthLogRows();
    stage('preserve-audit', true, preserved.length + ' rows');

    /* ── 5. Swap the uploads directory ──
     * Rename-based, so the live set is replaced in one step. Windows will not
     * rename over an existing directory, hence the move-aside first. */
    if (fs.existsSync(dbmod.UPLOADS_DIR)) fs.renameSync(dbmod.UPLOADS_DIR, replacedUploads);
    fs.renameSync(stagedUploads, dbmod.UPLOADS_DIR);
    uploadsSwapped = true;
    stage('swap-uploads', true, extracted + ' files');

    /* ── 6. Replace the database ── */
    try { dbmod.db.close(); } catch (e) {}
    ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(dbmod.DB_PATH + s); } catch (e) {} });
    fs.copyFileSync(stagedDb, dbmod.DB_PATH);
    dbmod.reopen();
    stage('replace-database', true);

    /* ── 7. The audit-chain key ──
     * Installed ONLY when this installation has none — a bare-metal recovery.
     * Otherwise the working key stays: it is the key referenced by every existing
     * anchor's fingerprint, and swapping it would make previously-issued
     * integrity reports unreproducible. */
    const localKeyPath = path.join(dbmod.DB_DIR, 'audit-chain.key');
    let keyAction = 'kept-local';
    if (reader.has(ENTRY_KEY)) {
      if (!fs.existsSync(localKeyPath)) {
        reader.extractTo(ENTRY_KEY, localKeyPath);
        try { fs.chmodSync(localKeyPath, 0o600); } catch (e) {}
        keyAction = 'installed-from-package';
        try { require('./audit-chain')._resetKeyCache(); } catch (e) {}
      } else {
        const packaged = reader.readFile(ENTRY_KEY).toString('utf8').trim();
        const local = fs.readFileSync(localKeyPath, 'utf8').trim();
        if (packaged !== local) keyAction = 'kept-local-differs-from-package';
      }
    } else {
      keyAction = 'package-has-no-key';
    }
    stage('audit-key', true, keyAction);

    /* ── 8. Merge the preserved trail and rebuild the chain ── */
    const carried = admin.mergeAuthLogRows(preserved);
    stage('merge-audit', true, carried + ' rows carried forward');

    let reanchor = null;
    try {
      reanchor = require('./repo').reanchorAuditChain(
        'full-system restore of ' + path.basename(absPath) + ' — ' + carried + ' row(s) carried forward',
        o.by || 'system');
      stage('reanchor-chain', !!(reanchor && reanchor.ok), reanchor && reanchor.rows);
    } catch (e) {
      stage('reanchor-chain', false, String(e && e.message || e));
    }

    /* ── 9. Discard the replaced uploads only if the safety net exists ── */
    let replacedKept = replacedUploads;
    if (safety && !safetyError) {
      try { fs.rmSync(replacedUploads, { recursive: true, force: true }); replacedKept = null; }
      catch (e) { /* left in place; harmless, just disk */ }
    }
    stage('cleanup', true, replacedKept ? 'previous uploads kept at ' + path.basename(replacedKept) : 'previous uploads discarded (pre-restore package holds them)');

    return {
      ok: true, verification,
      restored: {
        database: true,
        uploadFiles: extracted,
        uploadFailures: failedFiles,
        rows: manifest.database ? manifest.database.rows : null,
      },
      preservedAuditRows: carried,
      reanchor, keyAction,
      safetyCopy: safety ? safety.file : null, safetyError,
      replacedUploadsKeptAt: replacedKept ? path.basename(replacedKept) : null,
      stages, durationMs: Date.now() - started,
    };
  } catch (e) {
    /* Roll the uploads back if they were swapped but a later step failed. The
     * database swap is the last irreversible step, so a failure before it leaves
     * the system exactly as it was. */
    if (uploadsSwapped && fs.existsSync(replacedUploads)) {
      try {
        if (fs.existsSync(dbmod.UPLOADS_DIR)) fs.rmSync(dbmod.UPLOADS_DIR, { recursive: true, force: true });
        fs.renameSync(replacedUploads, dbmod.UPLOADS_DIR);
        stage('rollback-uploads', true);
      } catch (e2) {
        stage('rollback-uploads', false, String(e2 && e2.message || e2));
      }
    }
    return { ok: false, refused: false, reason: 'restore-failed',
             error: String(e && e.message || e), verification, stages,
             safetyCopy: safety ? safety.file : null, safetyError,
             durationMs: Date.now() - started };
  } finally {
    reader.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = {
  createPackage, verifyPackage, previewPackage, restorePackage,
  timestampName, _sha256File, _listUploads, _referencedPaths, _rowCounts, _dirSize,
  ENTRY_DB, ENTRY_KEY, ENTRY_MANIFEST, ENTRY_UPLOADS,
  PACKAGE_VERSION, PACKAGE_EXT,
  STATUS_FULL, STATUS_PARTIAL, STATUS_CORRUPTED,
};
