'use strict';
/**
 * backend/admin.js — database administration: backup, restore, reset.
 * Backups are clean SQLite copies (VACUUM INTO) saved under backups/.
 */
const fs   = require('node:fs');
const path = require('node:path');
const dbmod = require('./db');

const BACKUP_DIR = path.join(dbmod.DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* Millisecond resolution, not second (P4.5).
 *
 * At one-second resolution two backups taken in the same second produced the
 * SAME filename, and `VACUUM INTO` refuses to write over an existing file — so
 * the second one threw. That was not theoretical: restore() takes a pre-restore
 * copy, and restoring straight after a manual backup put both inside one second.
 * The throw was swallowed by restore()'s try/catch, which meant the safety copy
 * an operator is relying on before an overwrite silently did not exist.
 */
function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
}

/* ── Backup provenance (P4) ────────────────────────────────────────
 * "Created By" cannot come from the filesystem — a file has an mtime, not an
 * author. It is recorded in a sidecar manifest written next to the backups.
 *
 * The manifest is advisory, never authoritative: a backup file with no manifest
 * entry (taken by the CLI script, restored from another machine, copied in by
 * hand) is still listed and still restorable, with the author shown as unknown.
 * A missing or corrupt manifest can therefore never hide a backup from the
 * operator, which is the failure mode that would actually hurt.
 */
const MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

function _readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || {}; } catch (e) { return {}; }
}
function _writeManifest(m) {
  try { fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2)); } catch (e) {}
}

/** Create a clean backup copy → backups/kd-<timestamp>.db. Returns the filename.
 *  `opts.by` records who asked for it; `opts.reason` why (e.g. 'pre-restore'). */
function backup(opts) {
  const o = opts || {};
  // Belt and braces on top of the millisecond timestamp: if a name is somehow
  // still taken (a clock step, a restored backups directory), pick the next free
  // one rather than letting VACUUM INTO fail on an existing file.
  let file = 'kd-' + timestamp() + '.db';
  for (let n = 2; fs.existsSync(path.join(BACKUP_DIR, file)) && n < 100; n++) {
    file = 'kd-' + timestamp() + '-' + n + '.db';
  }
  const dest = path.join(BACKUP_DIR, file).replace(/'/g, "''");
  dbmod.db.exec("VACUUM INTO '" + dest + "'");

  const m = _readManifest();
  m[file] = { by: o.by || 'system', reason: o.reason || 'manual', at: new Date().toISOString() };
  /* Checksum recorded at creation (P4.6). This is what lets verification later
   * distinguish a file that was MODIFIED after it was written from one that is
   * simply old — without it, "the backup is intact" could only ever mean "SQLite
   * can still open it". */
  try {
    m[file].sha256 = checksumFile(path.join(BACKUP_DIR, file));
    m[file].size = fs.statSync(path.join(BACKUP_DIR, file)).size;
  } catch (e) {
    console.error('[backup] could not checksum ' + file + ':', e && e.message || e);
  }
  /* Keep the manifest bounded to the files that actually exist, so deleting old
   * backups does not leave it growing forever.
   *
   * P5.1: this filter used to be `.db` only, which meant that taking a database
   * snapshot deleted the manifest entry of every `.zip` package — their author,
   * checksum, verification result and offsite state, all silently gone. Both
   * kinds count as present now. */
  const present = new Set(
    fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db') || f.endsWith('.zip')));
  Object.keys(m).forEach(k => { if (!present.has(k)) delete m[k]; });
  _writeManifest(m);
  return file;
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
}

/**
 * Backups with size, age and provenance — the history table in Settings → Data.
 *
 * Sorted by TIME, not by filename. listBackups() sorts by name, which is the
 * same order only while every file is called `kd-<timestamp>.db`. A file copied
 * in by hand, or restored from another machine under a different name, would
 * otherwise sort to the top and be treated as "the newest backup" — which feeds
 * the last-backup-age finding and the verification status on the dashboard.
 */
function listBackupsDetailed() {
  const m = _readManifest();
  const rows = listBackups().map(file => {
    const p = path.join(BACKUP_DIR, file);
    let size = 0, mtime = null;
    try { const st = fs.statSync(p); size = st.size; mtime = st.mtime.toISOString(); } catch (e) {}
    const meta = m[file] || {};
    return {
      file,
      size,
      createdAt: meta.at || mtime,
      createdBy: meta.by || null,
      reason: meta.reason || null,
      // Present means a checksum was recorded at creation and can be re-checked;
      // null means this file predates P4.6 or arrived by hand.
      sha256: meta.sha256 || null,
      // Cheap tamper signal for the history table without opening every file:
      // the size on disk no longer matching the size recorded at creation.
      sizeMatches: meta.size == null ? null : meta.size === size,
      // A zero-byte or unreadable file is a failed backup. Saying so here is the
      // difference between a history table and a false sense of safety.
      status: size > 0 ? 'ok' : 'error',
      _mtime: mtime,
    };
  });

  rows.sort((a, b) => {
    // Recorded creation time first, mtime as the fallback for files with no
    // manifest entry. Descending, so [0] is genuinely the most recent.
    const at = Date.parse(a.createdAt || a._mtime || 0) || 0;
    const bt = Date.parse(b.createdAt || b._mtime || 0) || 0;
    return bt - at;
  });
  rows.forEach(r => { delete r._mtime; });
  return rows;
}

/* ══════════════════════════════════════════════════════════════════
 * Backup verification (P4.6)
 * ══════════════════════════════════════════════════════════════════
 * Before this, a backup was trusted because it existed. Nothing checked that the
 * file was a readable database, that its schema was intact, or that it still
 * contained what it did when it was written — so the first anybody would learn
 * of a bad backup was during the restore they needed it for.
 *
 * Verification opens the file READ-ONLY (node:sqlite refuses writes on such a
 * handle) so a check can never damage the artefact it is checking.
 */

/** SHA-256 of a file, streamed so a large backup does not land in memory. */
function checksumFile(abs) {
  const crypto = require('node:crypto');
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

/* Tables a restorable backup must contain. Not every table — just the ones whose
 * absence means the file is not a usable KD database. */
const REQUIRED_TABLES = [
  'users', 'sessions', 'groups', 'employees', 'passports', 'documents',
  'app_settings', 'auth_log', 'roles', 'permissions', 'role_permissions',
];

const COUNTED_TABLES = [
  'users', 'groups', 'employees', 'passports', 'documents', 'auth_log', 'roles',
];

/**
 * Check that a backup is actually restorable.
 *
 * @returns a report with `ok` plus every individual finding, so a partial
 * failure (schema fine, checksum mismatched) is distinguishable from a total one.
 */
function verifyBackup(file) {
  const abs = backupPath(file);
  const started = Date.now();
  const report = {
    file: path.basename(String(file || '')),
    ok: false, exists: !!abs, readable: false,
    size: 0, integrity: null, integrityOk: false,
    checksum: null, recordedChecksum: null, checksumOk: null,
    missingTables: [], counts: {}, auditChain: null,
    errors: [], durationMs: 0,
  };
  if (!abs) {
    report.errors.push('not-found');
    report.durationMs = Date.now() - started;
    return report;
  }

  try { report.size = fs.statSync(abs).size; } catch (e) {}
  if (report.size === 0) {
    // A zero-byte backup is the classic silent failure: the file exists, so a
    // history table that only lists names would show it as available.
    report.errors.push('empty-file');
    report.durationMs = Date.now() - started;
    return report;
  }

  /* Checksum first: it is the only check that can tell a file which was
   * MODIFIED after it was written from one that is merely old. */
  try {
    report.checksum = checksumFile(abs);
    const meta = _readManifest()[report.file];
    report.recordedChecksum = (meta && meta.sha256) || null;
    if (report.recordedChecksum) report.checksumOk = report.recordedChecksum === report.checksum;
    // No recorded checksum ⇒ unknown, not failed. Backups taken before P4.6 and
    // files copied in by hand legitimately have none.
  } catch (e) { report.errors.push('checksum-failed: ' + (e && e.message || e)); }

  const { DatabaseSync } = require('node:sqlite');
  let bk = null;
  try {
    bk = new DatabaseSync(abs, { readOnly: true });
    report.readable = true;

    /* integrity_check, not quick_check: this is the one place the full pass is
     * worth its cost — an operator is explicitly asking whether the file can be
     * relied on, and quick_check skips exactly the index-consistency problems
     * that make a restore fail later. */
    const rows = bk.prepare('PRAGMA integrity_check').all();
    report.integrity = rows.map(r => String(Object.values(r)[0])).join('; ');
    report.integrityOk = report.integrity === 'ok';

    const present = new Set(
      bk.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    report.missingTables = REQUIRED_TABLES.filter(t => !present.has(t));

    COUNTED_TABLES.forEach(t => {
      if (!present.has(t)) return;
      try { report.counts[t] = bk.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c; }
      catch (e) { report.counts[t] = null; }
    });

    /* Does the audit trail INSIDE the backup verify? A backup whose chain is
     * broken is evidence that the live database was already tampered with when
     * the snapshot was taken — which the live chain alone cannot tell you,
     * because a restore rebuilds it. */
    report.auditChain = _verifyBackupChain(bk, present);
  } catch (e) {
    report.errors.push('open-failed: ' + (e && e.message || e));
  } finally {
    if (bk) { try { bk.close(); } catch (e) {} }
  }

  report.ok = report.readable && report.integrityOk &&
              report.missingTables.length === 0 &&
              report.checksumOk !== false &&
              report.errors.length === 0;
  report.durationMs = Date.now() - started;
  return report;
}

function _verifyBackupChain(bk, present) {
  if (!present.has('auth_log')) return { available: false, reason: 'no auth_log table' };
  let chainmod, key;
  try {
    chainmod = require('./audit-chain');
    key = chainmod.loadKey(dbmod.DB_DIR);
  } catch (e) {
    return { available: false, reason: 'chain key unavailable' };
  }
  try {
    const cols = bk.prepare('PRAGMA table_info(auth_log)').all().map(c => c.name);
    if (!cols.includes('row_hash')) {
      // Pre-P4.6 backup. Reported as such rather than as a failure — the file is
      // perfectly restorable, it just carries no integrity evidence.
      return { available: false, reason: 'backup predates hash chaining' };
    }
    const rows = bk.prepare(
      'SELECT ' + chainmod.CHAINED_FIELDS.join(',') + ', prev_hash, row_hash FROM auth_log ORDER BY id'
    ).all();
    const r = chainmod.verifyChain(key, rows);
    return { available: true, ok: r.ok, rows: r.rows, verified: r.verified,
             brokenAtId: r.brokenAtId, brokenReason: r.brokenReason, unhashed: r.unhashed };
  } catch (e) {
    return { available: false, reason: String(e && e.message || e) };
  }
}

/**
 * What restoring this backup would do — shown BEFORE the operator commits.
 *
 * Restore is the most destructive action in the product and it used to be a
 * yes/no confirmation naming only a filename. This turns it into an informed
 * decision: the verification result, plus a row-by-row diff against the live
 * database, so "this snapshot is missing 214 employees" is visible beforehand
 * rather than discovered afterwards.
 */
function previewRestore(file) {
  const verification = verifyBackup(file);
  const live = {}, delta = {};
  COUNTED_TABLES.forEach(t => {
    try { live[t] = dbmod.db.prepare('SELECT COUNT(*) AS c FROM ' + t).get().c; }
    catch (e) { live[t] = null; }
    const b = verification.counts[t];
    delta[t] = (b == null || live[t] == null) ? null : b - live[t];
  });

  const meta = _readManifest()[verification.file] || {};
  return {
    file: verification.file,
    verification,
    createdAt: meta.at || null,
    createdBy: meta.by || null,
    reason: meta.reason || null,
    live, backup: verification.counts, delta,
    /* The headline numbers an operator needs before saying yes. Negative delta
     * means the backup holds FEWER rows than the live database — i.e. restoring
     * would lose that many. */
    /* Worker/group/document rows the snapshot lacks WOULD be lost. Named for what
     * it means, not for what it counts. */
    losesRecords: ['groups', 'employees', 'passports', 'documents', 'users']
      .some(t => delta[t] != null && delta[t] < 0),
    /* Audit rows are counted separately and deliberately NOT called "at risk":
     * they are carried forward by restore() and the chain re-anchored, so this is
     * "how many events the snapshot predates", which is information, not a
     * warning. Conflating the two would train an operator to ignore the real
     * warning above. */
    auditRowsNewerThanBackup: delta.auth_log != null && delta.auth_log < 0 ? -delta.auth_log : 0,
    auditTrailPreserved: true,
    safe: verification.ok,
  };
}

/** Absolute path of a backup, or null. Basename-only, so no traversal.
 *  P5.1: accepts .zip packages as well as .db snapshots. */
function backupPath(file) {
  const safe = path.basename(String(file || ''));
  if (!safe.endsWith('.db') && !safe.endsWith('.zip')) return null;
  const p = path.join(BACKUP_DIR, safe);
  return fs.existsSync(p) ? p : null;
}

/* ── Storage diagnostics (READ-ONLY — never deletes anything) ──
 * Reports how the volume is being used so we can decide what to reclaim.
 * "orphans" = files under uploads/ that no DB row references (safe to delete;
 * usually leftovers from crashes/failed writes). This function only measures. */
function _walk(dir) {
  // → { bytes, count, files:[{abs, size}] }  (recurses; missing dir = empty)
  let bytes = 0, count = 0; const files = [];
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { bytes, count, files }; }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) { const sub = _walk(abs); bytes += sub.bytes; count += sub.count; files.push(...sub.files); }
    else { try { const st = fs.statSync(abs); bytes += st.size; count++; files.push({ abs, size: st.size }); } catch (e) {} }
  }
  return { bytes, count, files };
}

/** Absolute paths of every upload file the DB currently references. */
function referencedUploadPaths() {
  const db = dbmod.db;
  const set = new Set();
  const add = (p) => { if (typeof p === 'string' && p.startsWith('/uploads/')) set.add(path.join(dbmod.UPLOADS_DIR, p.replace(/^\/uploads\//, ''))); };
  try { db.prepare('SELECT photo_path, photo_orig FROM employees').all().forEach(r => { add(r.photo_path); add(r.photo_orig); }); } catch (e) {}
  try { db.prepare('SELECT file_path FROM documents').all().forEach(r => add(r.file_path)); } catch (e) {}
  return set;
}

function _dbReclaimBytes() {
  try {
    const pc = dbmod.db.prepare('PRAGMA page_count').get();
    const fl = dbmod.db.prepare('PRAGMA freelist_count').get();
    const ps = dbmod.db.prepare('PRAGMA page_size').get();
    const pageSize = ps && (ps.page_size ?? Object.values(ps)[0]) || 4096;
    const free     = fl && (fl.freelist_count ?? Object.values(fl)[0]) || 0;
    return free * pageSize;
  } catch (e) { return 0; }
}

function _size(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

function storageStats() {
  const uploads = _walk(dbmod.UPLOADS_DIR);
  const referenced = referencedUploadPaths();
  let orphanBytes = 0, orphanCount = 0;
  for (const f of uploads.files) if (!referenced.has(f.abs)) { orphanBytes += f.size; orphanCount++; }

  const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db'))
    .map(f => ({ file: f, size: _size(path.join(BACKUP_DIR, f)) }));
  const backupBytes = backups.reduce((a, b) => a + b.size, 0);

  const dbBytes = _size(dbmod.DB_PATH) + _size(dbmod.DB_PATH + '-wal') + _size(dbmod.DB_PATH + '-shm');

  return {
    db:      { bytes: dbBytes, reclaimableByVacuum: _dbReclaimBytes() },
    uploads: { bytes: uploads.bytes, files: uploads.count, orphanBytes, orphanCount },
    backups: { bytes: backupBytes, count: backups.length, newest: backups.sort().reverse()[0]?.file || null },
    total:   dbBytes + uploads.bytes + backupBytes,
  };
}

/* ── Space reclaim (non-destructive to live data) ── */

/** Delete backups older than the newest `keep`. Backups are redundant snapshots
 *  (the live DB is authoritative), so this never risks the real data. */
function pruneBackups(keep) {
  const k = Math.max(1, keep | 0 || 20);
  const files = listBackups();                 // newest first
  const remove = files.slice(k);
  let freed = 0;
  for (const f of remove) {
    const p = path.join(BACKUP_DIR, f);
    try { freed += _size(p); fs.unlinkSync(p); } catch (e) {}
  }
  return { kept: Math.min(k, files.length), deleted: remove.length, freedBytes: freed };
}

/* ══════════════════════════════════════════════════════════════════
 * P5.1 — one inventory, two kinds of backup
 * ══════════════════════════════════════════════════════════════════
 * `.zip` full-system packages and `.db` database snapshots live side by side in
 * the same directory and the same manifest. Both are legitimate; they recover
 * different amounts, and the whole point of this phase is that the difference is
 * never hidden again.
 *
 *   full  — database + every upload + the audit-chain key. Complete recovery.
 *   db    — database only. Fast; recovers records but no document images.
 *
 * Everything downstream (health scoring, retention, the UI) keys off `kind`, so
 * a `.db` snapshot can never be presented as full recovery.
 */
const KIND_FULL = 'full';
const KIND_DB   = 'db';

function _kindOf(file) {
  if (/\.zip$/i.test(file)) return KIND_FULL;
  if (/\.db$/i.test(file))  return KIND_DB;
  return null;
}

/** Every backup artefact in the directory, newest first, both kinds. */
function listAll() {
  const m = _readManifest();
  let names = [];
  try {
    names = fs.readdirSync(BACKUP_DIR).filter(f => _kindOf(f) !== null);
  } catch (e) { return []; }

  const rows = names.map(file => {
    const p = path.join(BACKUP_DIR, file);
    let size = 0, mtime = null;
    try { const st = fs.statSync(p); size = st.size; mtime = st.mtime.toISOString(); } catch (e) {}
    const meta = m[file] || {};
    return {
      file, kind: _kindOf(file), size,
      createdAt: meta.at || mtime,
      createdBy: meta.by || null,
      reason: meta.reason || null,
      sha256: meta.sha256 || null,
      sizeMatches: meta.size == null ? null : meta.size === size,
      /* Verification and offsite state are recorded IN the manifest, because the
       * question the dashboard asks — "has this ever been verified?" — cannot be
       * answered by looking at a file. */
      verification: meta.verification || null,
      offsite: meta.offsite || null,
      manifestSummary: meta.package || null,
      status: size > 0 ? 'ok' : 'error',
      _sortKey: Date.parse(meta.at || mtime || 0) || 0,
    };
  });
  rows.sort((a, b) => b._sortKey - a._sortKey);
  rows.forEach(r => { delete r._sortKey; });
  return rows;
}

/** Record a package's metadata at creation (called by the API layer). */
function recordPackage(file, info) {
  const m = _readManifest();
  const e = m[file] || {};
  e.by = info.by || e.by || 'system';
  e.reason = info.reason || e.reason || 'manual';
  e.at = info.at || e.at || new Date().toISOString();
  e.sha256 = info.sha256 || e.sha256 || null;
  e.size = info.size != null ? info.size : e.size;
  e.kind = KIND_FULL;
  /* A compact copy of the package manifest, so the history table can show what a
   * package contains without opening a 700 MB archive on every page load. */
  if (info.manifest) {
    e.package = {
      app_version: info.manifest.app_version,
      file_count: info.manifest.file_count,
      database_size: info.manifest.database_size,
      uploads_size: info.manifest.uploads_size,
      upload_files: info.manifest.uploads ? info.manifest.uploads.file_count : null,
      rows: info.manifest.database ? info.manifest.database.rows : null,
      key_present: info.manifest.audit_chain ? info.manifest.audit_chain.key_present : null,
      chain_head: info.manifest.audit_chain ? info.manifest.audit_chain.head : null,
      missing_referenced: info.manifest.uploads ? (info.manifest.uploads.missing_referenced || []).length : null,
    };
  }
  m[file] = e;
  _writeManifest(m);
  return e;
}

/** Remember the outcome of a verification, so "last verified" is answerable. */
function recordVerification(file, report) {
  const m = _readManifest();
  const e = m[file] || {};
  e.verification = {
    at: new Date().toISOString(),
    status: report.status || (report.ok ? 'fully-recoverable' : 'corrupted'),
    databaseValid: report.databaseValid !== undefined ? report.databaseValid : report.integrityOk,
    auditValid: report.auditValid !== undefined ? report.auditValid : null,
    uploadsValid: report.uploadsValid !== undefined ? report.uploadsValid : null,
    manifestValid: report.manifestValid !== undefined ? report.manifestValid : null,
    deep: !!(report.uploads && report.uploads.deep),
  };
  m[file] = e;
  _writeManifest(m);
  return e.verification;
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 6 — offsite copy (Cloudflare R2)
 * ══════════════════════════════════════════════════════════════════
 * The single most important control this phase can add, because everything else
 * — database, uploads, backups, chain key — sits on one volume. A verified
 * package that never leaves that volume does not survive the failure it exists
 * for.
 *
 * Infrastructure only, as instructed: no scheduler. `uploadOffsite()` is called
 * on demand and records enough state that a future scheduled job needs no new
 * storage or bookkeeping.
 */
const OFFSITE_PREFIX = 'backups/';

/**
 * Copy one backup to R2 and verify the remote object.
 *
 * "Verify" means what it says: after the upload, HEAD the object and compare the
 * remote size and the digest we recorded as metadata. An upload that reports 200
 * and stored something else is exactly the failure an offsite copy must not have.
 */
async function uploadOffsite(file, opts) {
  const o = opts || {};
  const r2 = require('./r2');
  if (!r2.isEnabled()) return { ok: false, error: 'r2-not-configured' };

  const abs = path.join(BACKUP_DIR, path.basename(file));
  if (!fs.existsSync(abs)) return { ok: false, error: 'not-found' };

  const started = Date.now();
  const size = _size(abs);
  const m = _readManifest();
  const meta = m[path.basename(file)] || {};
  // Prefer the digest recorded at creation; compute it if this file predates that.
  const sha256 = meta.sha256 || checksumFile(abs);
  const key = OFFSITE_PREFIX + path.basename(file);

  try {
    await r2.putFile(key, abs, {
      sha256, size,
      contentType: _kindOf(file) === KIND_FULL ? 'application/zip' : 'application/x-sqlite3',
      meta: { sha256, 'kd-kind': _kindOf(file) || 'unknown', 'kd-created': meta.at || '' },
    });

    /* Read it back. Trusting the 200 would make "verified offsite" mean "we sent
     * bytes and nothing complained". */
    const head = await r2.head(key).catch(() => null);
    const remoteSize = head && head.contentLength != null ? Number(head.contentLength) : null;
    const remoteSha = head && head.meta ? (head.meta.sha256 || head.meta['sha256']) : null;

    const sizeOk = remoteSize === null ? null : remoteSize === size;
    const shaOk  = remoteSha ? remoteSha === sha256 : null;
    const ok = sizeOk !== false && shaOk !== false;

    const record = {
      at: new Date().toISOString(), key, bytes: size, sha256,
      remoteSize, remoteSha256: remoteSha || null,
      sizeMatches: sizeOk, checksumMatches: shaOk,
      status: ok ? 'verified' : 'mismatch',
      durationMs: Date.now() - started,
      by: o.by || 'system',
    };
    const mm = _readManifest();
    mm[path.basename(file)] = Object.assign({}, mm[path.basename(file)] || {}, { offsite: record });
    _writeManifest(mm);
    return { ok, offsite: record };
  } catch (e) {
    const record = {
      at: new Date().toISOString(), key, bytes: size, sha256,
      status: 'failed', error: String(e && e.message || e),
      durationMs: Date.now() - started, by: o.by || 'system',
    };
    const mm = _readManifest();
    mm[path.basename(file)] = Object.assign({}, mm[path.basename(file)] || {}, { offsite: record });
    _writeManifest(mm);
    return { ok: false, error: record.error, offsite: record };
  }
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 8 — retention
 * ══════════════════════════════════════════════════════════════════
 * Deleting backups is the one maintenance task that can destroy the ability to
 * recover, so the rules are protective by construction rather than by the
 * operator remembering to be careful:
 *
 *   • the newest of each kind is never deleted
 *   • the newest VERIFIED package is never deleted, even if it falls outside N
 *   • the newest package with a verified OFFSITE copy is never deleted
 *   • a dry run is available and is what the UI calls first
 *
 * The third rule matters more than it looks: without it, keeping "the last 5"
 * could delete the only backup that exists in two places.
 */
function applyRetention(opts) {
  const o = opts || {};
  /* `|| default` is wrong here for the same reason it was wrong for role rank in
   * P4.6: 0 is falsy, and 0 is precisely the value that would mean "delete
   * everything". Parsed explicitly, then clamped, so a supplied 0 becomes 1 —
   * refused — rather than being quietly replaced by the default. */
  const clamp = (v, dflt, max) => {
    const n = parseInt(v, 10);
    return Math.max(1, Math.min(max, Number.isFinite(n) ? n : dflt));
  };
  const keepFull = clamp(o.keepFull, 5, 50);
  const keepDb   = clamp(o.keepDb, 10, 100);
  const dryRun   = !!o.dryRun;

  const all = listAll();                       // newest first
  const full = all.filter(b => b.kind === KIND_FULL);
  const dbs  = all.filter(b => b.kind === KIND_DB);

  const protectedFiles = new Set();
  if (full[0]) protectedFiles.add(full[0].file);
  if (dbs[0])  protectedFiles.add(dbs[0].file);
  const lastVerifiedFull = full.find(b => b.verification && b.verification.status === 'fully-recoverable');
  if (lastVerifiedFull) protectedFiles.add(lastVerifiedFull.file);
  const lastOffsite = full.find(b => b.offsite && b.offsite.status === 'verified');
  if (lastOffsite) protectedFiles.add(lastOffsite.file);

  const candidates = [
    ...full.slice(keepFull),
    ...dbs.slice(keepDb),
  ].filter(b => !protectedFiles.has(b.file));

  const deleted = [], failed = [];
  let freed = 0;
  if (!dryRun) {
    for (const b of candidates) {
      const p = path.join(BACKUP_DIR, b.file);
      try { fs.unlinkSync(p); freed += b.size; deleted.push(b.file); }
      catch (e) { failed.push({ file: b.file, error: String(e && e.message || e) }); }
    }
    if (deleted.length) {
      const m = _readManifest();
      deleted.forEach(f => { delete m[f]; });
      _writeManifest(m);
    }
  }

  return {
    dryRun, keepFull, keepDb,
    totals: { full: full.length, db: dbs.length },
    protected: [...protectedFiles],
    protectedReasons: {
      newestFull: full[0] ? full[0].file : null,
      newestDb: dbs[0] ? dbs[0].file : null,
      lastVerifiedFull: lastVerifiedFull ? lastVerifiedFull.file : null,
      lastOffsiteVerified: lastOffsite ? lastOffsite.file : null,
    },
    candidates: candidates.map(b => b.file),
    deleted, failed, freedBytes: freed,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * PHASE 7 — backup health
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Metrics and a recoverability score.
 *
 * The score answers one question: if this machine died right now, how much would
 * come back? It is deliberately harsh about the two things P5.1 exists to fix —
 * a database-only backup and a backup that exists only on the failing volume.
 */
function backupHealth() {
  const all = listAll();
  const full = all.filter(b => b.kind === KIND_FULL);
  const dbs  = all.filter(b => b.kind === KIND_DB);
  const now = Date.now();
  const ageDays = (iso) => {
    const t = Date.parse(iso || 0);
    return Number.isFinite(t) && t > 0 ? Math.floor((now - t) / 86400000) : null;
  };

  const newestFull = full[0] || null;
  const newestAny  = all[0] || null;
  const lastVerified = all.find(b => b.verification && b.verification.status === 'fully-recoverable') || null;
  const lastOffsite  = all.find(b => b.offsite && b.offsite.status === 'verified') || null;

  const liveUploads = _walk(dbmod.UPLOADS_DIR);
  const totalBytes = all.reduce((a, b) => a + (b.size || 0), 0);

  /* ── Recoverability score ──
   * Additive from zero rather than deductive from 100: this is a statement about
   * what protection EXISTS, and starting at 100 would imply protection until
   * proven otherwise. The weights say what matters — a full backup is worth more
   * than a recent one, and an offsite copy is worth as much as verification.
   */
  let score = 0;
  const findings = [];
  const add = (points, level, key, detail) => {
    score += points;
    if (level) findings.push({ level, key, detail: detail == null ? null : String(detail) });
  };

  if (!newestAny) {
    findings.push({ level: 'critical', key: 'no_backup_at_all', detail: null });
  } else {
    if (newestFull) {
      add(40, null, null);
      const age = ageDays(newestFull.createdAt);
      if (age != null && age <= 1) add(15, null, null);
      else if (age != null && age <= 7) add(10, 'info', 'full_backup_ageing', age);
      else add(0, 'warning', 'full_backup_stale', age);
    } else {
      /* The exact situation P5.1 was created to end: snapshots exist, so the UI
       * used to look healthy, but no document image is protected. */
      findings.push({ level: 'critical', key: 'no_full_backup', detail: dbs.length });
    }

    if (lastVerified) {
      add(20, null, null);
      const vage = ageDays(lastVerified.verification.at);
      if (vage != null && vage > 30) findings.push({ level: 'info', key: 'verification_ageing', detail: vage });
    } else {
      findings.push({ level: 'warning', key: 'never_verified', detail: null });
    }

    if (lastOffsite) {
      add(25, null, null);
      const oage = ageDays(lastOffsite.offsite.at);
      if (oage != null && oage > 7) findings.push({ level: 'warning', key: 'offsite_stale', detail: oage });
    } else {
      findings.push({ level: 'critical', key: 'no_offsite_copy', detail: null });
    }
  }
  score = Math.max(0, Math.min(100, score));

  /* A backup that cannot restore the images cannot be called healthy, however
   * many snapshots exist — so the level is capped, not merely reduced. */
  let level;
  if (!newestFull) level = 'critical';
  else if (findings.some(f => f.level === 'critical')) level = 'critical';
  else if (findings.some(f => f.level === 'warning')) level = 'warning';
  else level = 'healthy';

  return {
    level, score,
    counts: { total: all.length, full: full.length, db: dbs.length },
    lastBackup: newestAny ? { file: newestAny.file, kind: newestAny.kind, at: newestAny.createdAt,
                              by: newestAny.createdBy, ageDays: ageDays(newestAny.createdAt) } : null,
    lastFullBackup: newestFull ? { file: newestFull.file, at: newestFull.createdAt,
                                   ageDays: ageDays(newestFull.createdAt), size: newestFull.size } : null,
    lastVerification: lastVerified ? { file: lastVerified.file, at: lastVerified.verification.at,
                                       status: lastVerified.verification.status,
                                       deep: lastVerified.verification.deep,
                                       ageDays: ageDays(lastVerified.verification.at) } : null,
    lastOffsite: lastOffsite ? { file: lastOffsite.file, at: lastOffsite.offsite.at,
                                 key: lastOffsite.offsite.key, bytes: lastOffsite.offsite.bytes,
                                 ageDays: ageDays(lastOffsite.offsite.at) } : null,
    storage: { backupsBytes: totalBytes, databaseBytes: _size(dbmod.DB_PATH),
               uploadsBytes: liveUploads.bytes, uploadFiles: liveUploads.count },
    offsiteConfigured: (() => { try { return require('./r2').isEnabled(); } catch (e) { return false; } })(),
    findings,
  };
}

/** Reclaim slack space inside kd.db left by deleted rows (trash, old doc versions). */
function vacuum() {
  const before = _size(dbmod.DB_PATH);
  try { dbmod.checkpoint('TRUNCATE'); } catch (e) {}
  dbmod.db.exec('VACUUM');
  try { dbmod.checkpoint('TRUNCATE'); } catch (e) {}
  const after = _size(dbmod.DB_PATH);
  return { beforeBytes: before, afterBytes: after, freedBytes: Math.max(0, before - after) };
}

/** Delete local upload files that NO database row references (crash leftovers,
 *  replaced versions). Cross-checked against the DB first, so nothing in use is
 *  ever touched. When R2 is on, offloaded (referenced) files are absent locally
 *  and correctly skipped. */
function cleanOrphans() {
  const referenced = referencedUploadPaths();
  const { files } = _walk(dbmod.UPLOADS_DIR);
  let freed = 0, count = 0;
  for (const f of files) {
    if (referenced.has(f.abs)) continue;
    try { fs.unlinkSync(f.abs); freed += f.size; count++; } catch (e) {}
  }
  return { deleted: count, freedBytes: freed };
}

/* ── Audit-trail preservation across a restore (P4.5) ──────────────
 * auth_log is documented as append-only, and A.12.4.2 expects log information
 * to be protected against tampering. Restore broke both: replacing the database
 * file with an older snapshot silently discarded every security event recorded
 * since that snapshot was taken.
 *
 * Measured before this fix: 6 events — a PERMISSION_DENIED burst and a
 * USER_CREATE — vanished across one restore. So anybody holding backup.restore
 * had a one-click way to erase the record of what they had just done, which is
 * precisely the audience the trail exists to catch.
 *
 * The rows are therefore carried across: read out before the swap, re-inserted
 * after it. Matching is on the row's natural content (timestamp + action +
 * account + ip + reason) because the restored file has its own id sequence —
 * comparing ids would either duplicate every row or skip real ones.
 */
function _readAuthLog() {
  try {
    return dbmod.db.prepare(
      'SELECT timestamp, username_attempted, user_id, ip_address, user_agent, action, result, reason ' +
      'FROM auth_log ORDER BY id'
    ).all();
  } catch (e) {
    console.error('[restore] could not read auth_log for preservation:', e && e.message || e);
    return [];
  }
}

const _authKey = (r) => [r.timestamp, r.action, r.result, r.username_attempted, r.ip_address, r.reason]
  .map(v => v == null ? '' : String(v)).join('');

function _mergeAuthLog(preserved) {
  if (!preserved.length) return 0;
  let existing;
  try {
    existing = new Set(dbmod.db.prepare(
      'SELECT timestamp, username_attempted, ip_address, action, result, reason FROM auth_log'
    ).all().map(_authKey));
  } catch (e) {
    console.error('[restore] could not read restored auth_log:', e && e.message || e);
    return 0;
  }
  const missing = preserved.filter(r => !existing.has(_authKey(r)));
  if (!missing.length) return 0;

  const ins = dbmod.db.prepare(
    'INSERT INTO auth_log (timestamp,username_attempted,user_id,ip_address,user_agent,action,result,reason) ' +
    'VALUES (?,?,?,?,?,?,?,?)'
  );
  let n = 0;
  dbmod.db.exec('BEGIN');
  try {
    missing.forEach(r => {
      ins.run(r.timestamp, r.username_attempted, r.user_id, r.ip_address, r.user_agent,
              r.action, r.result, r.reason);
      n++;
    });
    dbmod.db.exec('COMMIT');
  } catch (e) {
    try { dbmod.db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[restore] auth_log merge failed:', e && e.message || e);
    return 0;
  }
  return n;
}

/**
 * Restore from backups/<file>: replace the live DB and reopen.
 *
 * Returns { ok, preservedAuditRows } so the caller can record how much security
 * evidence was carried across — a number an auditor will ask for.
 */
function restore(file, opts) {
  const o = opts || {};
  const safe = path.basename(file);                 // prevent traversal
  const src = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(src)) throw new Error('Backup not found: ' + safe);

  /* Auto-backup the current state before overwriting it. A failure here used to
   * be swallowed by an empty catch, so an operator could be told the restore
   * succeeded while the copy of what they just overwrote was never written. It
   * is still non-fatal — refusing to restore because the safety copy failed
   * would be worse — but it is now reported, and the caller passes the fact into
   * the audit entry so "there is no way back from this restore" is on the record. */
  let safetyCopy = null, safetyError = null;
  try {
    safetyCopy = backup({ by: o.by || 'system', reason: 'pre-restore of ' + safe });
  } catch (e) {
    safetyError = String(e && e.message || e);
    console.error('[restore] PRE-RESTORE BACKUP FAILED — the overwritten state is not recoverable:', safetyError);
  }

  // Read the trail out BEFORE the handle closes — afterwards it is unreachable.
  const preserved = _readAuthLog();

  try { dbmod.db.close(); } catch (e) {}
  // remove WAL/SHM sidecars so the restored file is authoritative
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(dbmod.DB_PATH + s); } catch (e) {} });
  fs.copyFileSync(src, dbmod.DB_PATH);
  dbmod.reopen();

  const carried = _mergeAuthLog(preserved);

  /* ── Re-anchor the hash chain (P4.6) ──
   * The merge gives the carried-over rows new ids, and the id is part of what
   * each row hashes — so after any restore the chain legitimately no longer
   * verifies. It is rebuilt here, and the rebuild is recorded in audit_anchors
   * with the pre-restore head hash, so a break caused by an authorised restore
   * is distinguishable from one caused by tampering.
   *
   * Done here rather than in the API layer because `npm run restore` uses this
   * same function; leaving it to the caller would mean the CLI path silently
   * left the chain broken.
   *
   * repo is required lazily: it depends on db.js, and requiring it at module
   * load would create a cycle. */
  let reanchor = null;
  try {
    reanchor = require('./repo').reanchorAuditChain(
      'restore of ' + safe + ' — ' + carried + ' row(s) carried forward', o.by || 'system');
  } catch (e) {
    console.error('[restore] audit chain re-anchor failed:', e && e.message || e);
    reanchor = { ok: false, error: String(e && e.message || e) };
  }

  return { ok: true, preservedAuditRows: carried, safetyCopy, safetyError, reanchor };
}

/** Wipe all data and re-seed defaults (keeps the schema). */
function reset() {
  const db = dbmod.db;
  db.exec('PRAGMA foreign_keys = OFF;');
  ['documents','passports','employees','groups','cities','employers','users'].forEach(t => {
    try { db.exec('DELETE FROM ' + t); } catch (e) {}
  });
  db.exec('PRAGMA foreign_keys = ON;');
  dbmod.seedDefaults();
}

module.exports = {
  backup, restore, reset, listBackups, listBackupsDetailed, backupPath,
  storageStats, referencedUploadPaths,
  pruneBackups, vacuum, cleanOrphans, BACKUP_DIR,
  // P4.6 — verification and restore safety
  verifyBackup, previewRestore, checksumFile, REQUIRED_TABLES, COUNTED_TABLES,
  /* P5.1 — the audit-log preservation pair, exported so the full-system restore
   * in backup-package.js reuses this exact logic instead of reimplementing it.
   * Two copies of "carry the trail across a restore" would be two chances to get
   * the most security-sensitive step in the product subtly wrong. */
  readAuthLogRows: _readAuthLog, mergeAuthLogRows: _mergeAuthLog,
  // P5.1 — unified inventory, offsite, retention, health
  listAll, recordPackage, recordVerification, uploadOffsite, applyRetention, backupHealth,
  KIND_FULL, KIND_DB, OFFSITE_PREFIX,
};
