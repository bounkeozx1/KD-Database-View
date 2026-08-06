'use strict';
/**
 * infra/export-package.js — the per-worker export package.
 *
 * ══════════════════════════════════════════════════════════════════
 * What this produces
 * ══════════════════════════════════════════════════════════════════
 * One ZIP holding a folder per selected worker, each containing that worker's
 * photograph and every version of every document:
 *
 *     KD-Export_DAM-2026_2026-08-03.zip
 *     ├─ manifest.txt                        who exported, when, and what was skipped
 *     ├─ summary.csv                         one row per worker, with its folder name
 *     └─ Somchai-Keo_KD-2026-001_2026-08-03/
 *        ├─ photos/
 *        │  └─ profile_Somchai-Keo.jpg       the original, not the thumbnail
 *        └─ documents/
 *           └─ passport/
 *              ├─ v3-current/ passport_Somchai-Keo_v3.jpg
 *              ├─ v2/         passport_Somchai-Keo_v2.jpg
 *              └─ v1/         passport_Somchai-Keo_v1.jpg
 *
 * ══════════════════════════════════════════════════════════════════
 * Why it runs here and not in the browser
 * ══════════════════════════════════════════════════════════════════
 * The existing exports are all client-side, and for a spreadsheet or a card PDF
 * that is the right place for them. This one is different in kind: fifty workers
 * is several hundred megabytes of scans, and building that in a tab means
 * downloading every file through the page, holding the whole archive in memory,
 * and losing the lot if the tab is closed. Here the bytes never leave the
 * machine that already stores them, and the archive is streamed to disk.
 *
 * ══════════════════════════════════════════════════════════════════
 * Why a job, not a request
 * ══════════════════════════════════════════════════════════════════
 * The site is served through a Cloudflare tunnel, which cuts an origin request
 * at around 100 seconds. A build of any size would be killed mid-way, and the
 * user would see a network error with no way to tell whether the export had
 * happened. So the POST starts the build and returns an id; the browser polls
 * for progress and then downloads the finished file.
 *
 * ══════════════════════════════════════════════════════════════════
 * SECURITY — this is the most sensitive artefact a non-admin path can request
 * ══════════════════════════════════════════════════════════════════
 * A package contains passport scans in the clear. Consequences, enforced in
 * server.js but recorded here because this is where the file is created:
 *
 *   • building, polling and downloading all require `export.package`, which
 *     only Admin holds — an Export-PDF grant must not reach it;
 *   • a job may only be polled or downloaded by the account that started it;
 *   • the file is served as an attachment with no-store, never inline;
 *   • packages are deleted 24 hours after they are built. They are a delivery
 *     mechanism, not storage, and an archive of everyone's documents must not
 *     sit on disk indefinitely because somebody exported once.
 */
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const dbmod = require('./db');
const repo  = require('./repo');
const zip   = require('./zip');
const r2    = require('./r2');

const EXPORTS_DIR = path.join(dbmod.DATA_DIR, 'exports');

/** How long a built package survives. See the SECURITY note above. */
const TTL_MS = 24 * 60 * 60 * 1000;

/* An upper bound on one request, so a mis-click on "select all" across a merged
 * view cannot ask for an archive nobody wanted. Well above any real selection —
 * the largest group on the live system is under 900 workers in total. */
const MAX_WORKERS = 500;

/* Two builds at once. Each one is a long run of file reads; more in parallel
 * would make every one of them slower without finishing any of them sooner. */
const MAX_CONCURRENT = 2;

/* Jobs live in memory only. A restart loses them, which is correct: the build
 * itself did not survive the restart either, and a job record pointing at a
 * half-written archive would be worse than no record. */
const JOBS = new Map();

/* ══════════════════════════════════════════════════════════════════
 * Attachments — the files the BROWSER makes
 * ══════════════════════════════════════════════════════════════════
 * The spreadsheet, the card PDF and the PowerPoint are built in the page, by
 * generators that already exist and are worth keeping there: they use pdf-lib
 * and a hand-rolled OOXML writer, and reimplementing either on the server would
 * mean two copies of the same layout drifting apart.
 *
 * So the browser makes them, uploads them here, and they are dropped into
 * `reports/` inside the archive. They are small — a spreadsheet is kilobytes, a
 * card PDF a few megabytes — which is exactly why this split is the right one:
 * the megabytes stay on the server, the kilobytes travel.
 */
const STAGING_DIR = path.join(EXPORTS_DIR, '.staging');
/** Per file, and generous: a 500-card PDF is the realistic worst case. */
const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
/** Staged files not claimed by a build within this are abandoned uploads. */
const STAGING_TTL_MS = 60 * 60 * 1000;
/* How many unclaimed uploads one account may hold. The dialog sends at most one
 * file per format, so this is far above any real export — it exists so that a
 * loop that uploads and never builds cannot fill the disk before the hourly
 * sweep notices. */
const MAX_STAGED_PER_USER = 16;
/**
 * Everything that is ABOUT the export rather than about a person lives here:
 * the manifest, the summary spreadsheet, and whatever reports the browser
 * generated. Its own folder for one reason — it leaves the top level of the
 * archive holding nothing but one folder per worker, plus this. A reader
 * opening the package sees the people first and the paperwork second, instead
 * of hunting for a name among loose files.
 */
const DATA_PREFIX = 'data/';

/* Names this folder owns. An uploaded report called `summary.csv` must not be
 * able to take the place of the real one. */
const RESERVED_DATA_NAMES = ['manifest.txt', 'summary.csv'];

const STAGED = new Map();       // id → { path, name, bytes, by, at }

/**
 * Stream one uploaded file to disk. Never buffers it whole: the point of the
 * upload is to avoid holding a large file in memory, and doing it here would
 * simply move the problem from the browser to the server.
 *
 * @param {IncomingMessage} req  the request, unread
 * @param {string} name          the client's filename (sanitised here)
 * @param {string} by            the account uploading
 */
function stage(req, name, by) {
  return new Promise((resolve) => {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    sweepStaging();

    let mine = 0;
    for (const s of STAGED.values()) if (s.by === by) mine++;
    if (mine >= MAX_STAGED_PER_USER) return resolve({ refused: true, reason: 'too-many-attachments' });

    const id = crypto.randomUUID();
    const abs = path.join(STAGING_DIR, id + '.part');
    const safe = safeAttachmentName(name);
    const out = fs.createWriteStream(abs);
    let bytes = 0, failed = null;

    const abort = (reason) => {
      if (failed) return;
      failed = reason;
      try { out.destroy(); } catch (e) {}
      try { req.destroy(); } catch (e) {}
      try { fs.unlinkSync(abs); } catch (e) {}
      resolve({ refused: true, reason });
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_ATTACHMENT_BYTES) return abort('attachment-too-large');
      out.write(chunk);
    });
    req.on('error', () => abort('upload-failed'));
    req.on('end', () => {
      if (failed) return;
      out.end(() => {
        if (!bytes) { try { fs.unlinkSync(abs); } catch (e) {} return resolve({ refused: true, reason: 'empty' }); }
        STAGED.set(id, { path: abs, name: safe, bytes, by: by || 'system', at: Date.now() });
        resolve({ id, name: safe, bytes });
      });
    });
  });
}

/** A filename safe to place inside the archive, keeping its extension. */
const safeAttachmentName = require('./safe-name').upload;

/** Discard staged uploads nobody claimed. */
function sweepStaging(now) {
  const cutoff = (now || Date.now()) - STAGING_TTL_MS;
  for (const [id, s] of STAGED) {
    if (s.at > cutoff) continue;
    try { fs.unlinkSync(s.path); } catch (e) {}
    STAGED.delete(id);
  }
  let files = [];
  try { files = fs.readdirSync(STAGING_DIR); } catch (e) { return; }
  files.forEach(f => {
    const abs = path.join(STAGING_DIR, f);
    try { if (fs.statSync(abs).mtimeMs < cutoff) fs.unlinkSync(abs); } catch (e) {}
  });
}

/** Take the staged files belonging to `by`, removing them from the registry. */
function claimAttachments(ids, by) {
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach(id => {
    const s = STAGED.get(String(id));
    // Another account's upload is not claimable — a staging id is a capability.
    if (!s || (by && s.by !== by)) return;
    STAGED.delete(String(id));
    out.push(s);
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════
 * Names
 * ══════════════════════════════════════════════════════════════════ */

/**
 * One path segment, safe on every filesystem an operator might unzip onto.
 *
 * Unicode letters are KEPT — Lao and Thai names must survive, and zip.js already
 * flags entry names as UTF-8 for exactly that reason. Only the characters
 * Windows genuinely refuses are replaced.
 */
const safeSegment = require('./safe-name').segment;

function todayStamp(d) {
  const t = d || new Date();
  const p = n => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

/**
 * `EnglishName_workerId_YYYY-MM-DD`, the layout agreed with the operator.
 *
 * A worker with no ID gets `NOID-<last 4 of uid>` rather than an empty slot, so
 * two unidentified workers still land in two different folders — the folder name
 * is how a person finds someone's papers, and a collision would hide one of them.
 */
function folderName(w, dateStr) {
  const name = safeSegment(w.en_name || w.lo_name, 'worker');
  // The fallback is the NOID form itself — safeSegment returns its fallback for
  // an empty or whitespace-only id, and a uid suffix is already path-safe.
  const id = safeSegment(w.worker_id, 'NOID-' + String(w.uid || 'xxxx').slice(-4));
  return name + '_' + id + '_' + dateStr;
}

const EXT_BY_TYPE = { pdf: 'pdf', image: 'jpg' };
function extFor(publicPath, type) {
  const e = path.extname(String(publicPath || '')).replace(/^\./, '').toLowerCase();
  if (e && /^[a-z0-9]{1,5}$/.test(e)) return e;
  return EXT_BY_TYPE[type] || 'bin';
}

/* ══════════════════════════════════════════════════════════════════
 * Reading an upload
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Resolve `/uploads/...` to bytes: local disk first, then R2.
 *
 * The R2 fallback is not optional. Once a file has been offloaded its local copy
 * is freed, so a package built from disk alone would quietly omit exactly the
 * older documents most likely to be wanted — and it would look complete.
 *
 * Returns { abs } to stream from disk, { buffer } for a remote copy, or null.
 */
async function readUpload(publicPath) {
  if (typeof publicPath !== 'string' || !publicPath.startsWith('/uploads/')) return null;
  const rel  = publicPath.replace(/^\/uploads\//, '');
  const root = path.resolve(dbmod.UPLOADS_DIR);
  const abs  = path.resolve(path.join(root, rel));
  // A stored path is not user input today, but it is the only thing standing
  // between a database value and an arbitrary file read.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;

  try { if (fs.statSync(abs).isFile()) return { abs }; } catch (e) { /* try R2 */ }

  if (r2.isEnabled()) {
    try {
      const obj = await r2.get(rel);
      if (obj && obj.ok && obj.hasBody) return { buffer: await obj.buffer() };
    } catch (e) { /* recorded as skipped by the caller */ }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════
 * The rows going into the package
 * ══════════════════════════════════════════════════════════════════ */

/* Every key here is one the export dialog's field picker can tick — the two
 * lists have to agree, or a user ticks "Age" and gets a spreadsheet without it
 * and no indication why. `age` and `folder` are derived rather than stored;
 * the rest are columns. */
const SUMMARY_COLUMNS = [
  ['folder',           'Folder'],
  ['worker_id',        'Worker ID'],
  ['en_name',          'EN Name'],
  ['lo_name',          'Lao Name'],
  ['sex',              'Sex'],
  ['dob',              'DOB'],
  ['age',              'Age'],
  ['nationality',      'Nationality'],
  ['blood',            'Blood'],
  ['height',           'Height(cm)'],
  ['weight',           'Weight(kg)'],
  ['size',             'Size'],
  ['hand',             'Hand'],
  ['grade',            'Grade'],
  ['couple',           'Couple'],
  ['village',          'Village'],
  ['district',         'District'],
  ['province',         'Province'],
  ['tel',              'Tel'],
  ['emg_tel',          'Emergency Tel'],
  ['employer_code',    'Employer'],
  ['group_supervisor', 'Supervisor'],
  ['passport_no',      'Passport No'],
  ['passport_issue',   'Issue'],
  ['passport_expiry',  'Expiry'],
  ['visa_status',      'Visa'],
  ['group_name',       'Group'],
];
/* `folder` is not a field of the record — it is the whole point of the CSV.
 * Without it the spreadsheet and the folders are two unrelated lists. */
const ALWAYS_COLUMNS = new Set(['folder', 'worker_id', 'en_name']);

function loadWorkers(uids) {
  const out = [];
  const stmt = dbmod.db.prepare(
    'SELECT e.*, g.name AS group_name FROM employees e ' +
    'LEFT JOIN groups g ON g.id = e.group_id ' +
    'WHERE e.uid = ? AND e.deleted_at IS NULL');
  const pass = dbmod.db.prepare(
    'SELECT passport_no, issue_date, expiry_date FROM passports WHERE employee_uid = ?');
  uids.forEach(uid => {
    const row = stmt.get(String(uid));
    if (!row) return;                     // deleted between selecting and exporting
    const p = pass.get(row.uid) || {};
    row.passport_no     = p.passport_no  || '';
    row.passport_issue  = p.issue_date   || '';
    row.passport_expiry = p.expiry_date  || '';
    row.age             = ageFrom(row.dob);
    out.push(row);
  });
  return out;
}

/* The same function the browser uses. Two implementations disagreed on
 * birthdays — see infra/age.js. */
const ageFrom = require('./age').age;

const csv = require('./csv');

function buildSummaryCsv(workers, fields) {
  const wanted = Array.isArray(fields) && fields.length ? new Set(fields) : null;
  const cols = SUMMARY_COLUMNS.filter(([key]) => !wanted || wanted.has(key) || ALWAYS_COLUMNS.has(key));
  // BOM, quoting and CRLF all come from the shared writer — see infra/csv.js.
  return csv.build(cols.map(([, label]) => label),
                   workers.map(w => cols.map(([key]) => w[key])));
}

function buildManifest(job) {
  const L = [];
  const pad = (k) => (k + '               ').slice(0, 15);
  L.push('KD Database — export package / ແພັກເກັດສົ່ງອອກ / แพ็กเกจส่งออก');
  L.push('='.repeat(64));
  L.push('');
  L.push(pad('Created') + ': ' + job.createdAt);
  L.push(pad('Created by') + ': ' + job.by);
  if (job.exportId) L.push(pad('Export ID') + ': ' + job.exportId);
  L.push(pad('Group') + ': ' + (job.groupName || '—'));
  L.push(pad('Workers') + ': ' + job.workers.length);
  L.push(pad('Photos') + ': ' + job.stats.photos);
  L.push(pad('Documents') + ': ' + job.stats.documents +
         (job.options.allVersions ? ' (all versions)' : ' (current version only)'));
  if (job.stats.reports) L.push(pad('Reports') + ': ' + job.stats.reports + ' in ' + DATA_PREFIX);
  L.push(pad('Skipped') + ': ' + job.skipped.length + ' file(s)');
  L.push('');
  L.push('Folder layout / ໂຄງສ້າງໂຟນເດີ / โครงสร้างโฟลเดอร์');
  L.push('-'.repeat(64));
  L.push('  Everything is inside ONE folder: ' + job.root);
  L.push('');
  L.push('  ' + job.root + '/');
  L.push('      data/                         everything about the export itself');
  L.push('          manifest.txt              this file');
  L.push('          summary.csv               one row per worker; first column = folder');
  if (job.stats.reports) {
    L.push('          <spreadsheet / PDF / slides for this selection>');
  }
  L.push('      <English name>_<worker ID>_<export date>/     one per person');
  L.push('          photos/                   the profile photo, full resolution');
  L.push('          documents/<category>/v<N>/    one folder per version');
  L.push('          ...v<N>-current/              the version in force today');
  L.push('');
  L.push('Workers / ລາຍຊື່ / รายชื่อ');
  L.push('-'.repeat(64));
  job.workers.forEach((w, i) => {
    L.push('  ' + String(i + 1).padStart(3, ' ') + '. ' + w.folder +
      '   photo: ' + (w.hasPhoto ? 'yes' : 'no') + '   documents: ' + w.docCount +
      (w.empty ? '   (nothing on file — the folder is empty)' : ''));
  });
  if (job.skipped.length) {
    L.push('');
    L.push('Files that could not be included / ໄຟລ໌ທີ່ຂາດ / ไฟล์ที่ขาดไป');
    L.push('-'.repeat(64));
    L.push('  These are recorded rather than omitted silently: a package that is');
    L.push('  quietly incomplete is worse than one that says so.');
    L.push('');
    job.skipped.forEach(s => L.push('  ' + s.folder + '  ' + s.what + '  (' + s.path + ')'));
  }
  L.push('');
  return L.join('\r\n');
}

/* ══════════════════════════════════════════════════════════════════
 * The build
 * ══════════════════════════════════════════════════════════════════ */

async function runBuild(job) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const writer = new zip.ZipWriter(job.path);
  const dateStr = job.dateStr;
  const opts = job.options;
  /* Everything goes inside ONE top-level folder. Without it, "extract here"
   * spills a dozen worker folders plus two loose files into whatever directory
   * the operator happened to be in — which is how an export stops looking like
   * one deliverable and starts looking like a mess to tidy up. `R` is prefixed
   * at every write; `folder` below stays the plain per-worker name, because
   * that is what the manifest and the CSV's Folder column refer to. */
  const R = job.root + '/';
  const wantCats = Array.isArray(opts.categories) && opts.categories.length
    ? new Set(opts.categories) : null;

  try {
    const taken = new Set();
    for (let i = 0; i < job.rows.length; i++) {
      const w = job.rows[i];

      let folder = folderName(w, dateStr);
      // Same name, same ID, same day: two people would share one folder and one
      // set of papers would be hidden inside the other's.
      if (taken.has(folder)) {
        let n = 2;
        while (taken.has(folder + '-' + n)) n++;
        folder = folder + '-' + n;
      }
      taken.add(folder);

      const label = safeSegment(w.en_name || w.lo_name, 'worker');
      const entry = { folder, name: w.en_name || w.lo_name || w.uid, worker_id: w.worker_id || '',
                      hasPhoto: false, docCount: 0 };

      /* ── The photograph ──
       * photo_orig is the untouched upload; photo_path may have been rotated or
       * re-encoded in the browser, and photo_thumb is a small preview. The
       * operator asked for the original, so prefer it and fall back in that
       * order rather than shipping a thumbnail as if it were the photo. */
      if (opts.photos !== false) {
        const src = w.photo_orig || w.photo_path || '';
        if (src) {
          const got = await readUpload(src);
          if (got) {
            const name = R + folder + '/photos/profile_' + label + '.' + extFor(src, 'image');
            if (got.abs) writer.addFile(name, got.abs, { compress: false });
            else writer.addBuffer(name, got.buffer, { compress: false });
            entry.hasPhoto = true;
            job.stats.photos++;
          } else {
            job.skipped.push({ folder, what: 'photo', path: src });
          }
        }
      }

      /* ── The documents ── */
      if (opts.documents !== false) {
        const byCat = repo.listDocuments(w.uid);
        for (const catKey of Object.keys(byCat)) {
          if (wantCats && !wantCats.has(catKey)) continue;
          const cat = safeSegment(catKey, 'other');
          let versions = byCat[catKey] || [];
          if (!opts.allVersions) {
            const cur = versions.find(v => v.isCurrent) || versions[0];
            versions = cur ? [cur] : [];
          }
          for (const doc of versions) {
            const got = await readUpload(doc.path);
            const vdir = 'v' + (doc.version || 1) + (doc.isCurrent ? '-current' : '');
            if (!got) {
              job.skipped.push({ folder, what: cat + ' ' + vdir, path: doc.path || '(no path)' });
              continue;
            }
            const name = R + folder + '/documents/' + cat + '/' + vdir + '/' +
              cat + '_' + label + '_v' + (doc.version || 1) + '.' + extFor(doc.path, doc.type);
            if (got.abs) writer.addFile(name, got.abs, { compress: false });
            else writer.addBuffer(name, got.buffer, { compress: false });
            entry.docCount++;
            job.stats.documents++;
          }
        }
      }

      /* A worker with no photo and no readable document would otherwise leave no
       * trace in the archive at all, and "their folder is missing" reads as "I
       * forgot to tick them" rather than "there is nothing on file for them".
       * An empty directory entry says the second thing. */
      if (!entry.hasPhoto && !entry.docCount) {
        writer.addBuffer(R + folder + '/', Buffer.alloc(0), { compress: false });
        entry.empty = true;
      }

      job.workers.push(entry);
      job.done = i + 1;
      job.phase = 'workers';
      /* Yield between workers. The reads are synchronous, and without this a
       * local-only build would hold the event loop for its whole duration —
       * which would stall the very status polls that make the job model work. */
      await new Promise(r => setImmediate(r));
    }

    /* ── The browser's own files ──
     * Added after the workers so a failure here cannot cost the expensive part
     * of the build, and into `data/` alongside the manifest and the summary —
     * everything that describes the export rather than a person.
     *
     * Deduplicated, and the reserved names are claimed FIRST: two exports of
     * the same group produce the same filename, and an upload called
     * `summary.csv` must not displace the real one. */
    job.phase = 'reports';
    const usedNames = new Set(RESERVED_DATA_NAMES);
    for (const att of job.attachments) {
      let name = att.name;
      if (usedNames.has(name)) {
        const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
        let n = 2;
        while (usedNames.has(stem + '-' + n + ext)) n++;
        name = stem + '-' + n + ext;
      }
      usedNames.add(name);
      try {
        writer.addFile(R + DATA_PREFIX + name, att.path);
        job.stats.reports++;
      } catch (e) {
        job.skipped.push({ folder: DATA_PREFIX, what: name, path: String(e && e.message || e) });
      }
    }

    job.phase = 'summary';
    const rowsForCsv = job.rows.map((w, i) => Object.assign({}, w, { folder: job.workers[i].folder }));
    writer.addBuffer(R + DATA_PREFIX + 'summary.csv',
                     Buffer.from(buildSummaryCsv(rowsForCsv, opts.fields), 'utf8'), { compress: true });
    writer.addBuffer(R + DATA_PREFIX + 'manifest.txt',
                     Buffer.from(buildManifest(job), 'utf8'), { compress: true });

    const result = writer.close();
    job.bytes = result.bytes;
    job.entries = result.entries.length;
    job.state = 'done';
    job.phase = 'done';
    job.finishedAt = new Date().toISOString();
    return job;
  } catch (e) {
    // Never leave a partial archive that looks like a finished export.
    writer.abort();
    job.state = 'error';
    job.phase = 'error';
    job.error = String((e && e.message) || e);
    job.finishedAt = new Date().toISOString();
    throw e;
  } finally {
    /* The staged uploads exist only to be copied into the archive. Whether that
     * succeeded or not, leaving them behind would keep a second copy of the
     * same reports on disk outside the 24-hour retention. */
    job.attachments.forEach(a => { try { fs.unlinkSync(a.path); } catch (e) {} });
  }
}

/* ══════════════════════════════════════════════════════════════════
 * Job registry
 * ══════════════════════════════════════════════════════════════════ */

/** Delete finished packages past their TTL, and forget the jobs that made them. */
function sweep(now) {
  const cutoff = (now || Date.now()) - TTL_MS;
  for (const [id, job] of JOBS) {
    if (job.state === 'running') continue;
    if (job.startedMs > cutoff) continue;
    try { if (job.path) fs.unlinkSync(job.path); } catch (e) {}
    JOBS.delete(id);
  }
  /* Also anything left on disk by a build whose job record died with a restart.
   * Without this, a crash at the wrong moment would leave passport scans in
   * data/exports/ with nothing left to clean them up. */
  let files = [];
  try { files = fs.readdirSync(EXPORTS_DIR, { withFileTypes: true }); } catch (e) { files = []; }
  files.forEach(ent => {
    if (!ent.isFile()) return;            // .staging is a directory, swept below
    const abs = path.join(EXPORTS_DIR, ent.name);
    try {
      if (fs.statSync(abs).mtimeMs < cutoff) fs.unlinkSync(abs);
    } catch (e) {}
  });
  sweepStaging(now);
}

function runningCount() {
  let n = 0;
  for (const job of JOBS.values()) if (job.state === 'running') n++;
  return n;
}

/**
 * Start a build. Returns the job immediately; the archive is written in the
 * background and polled through status().
 *
 * @param {object} o { uids, by, options, exportId }
 * @returns {object} the public job view, or { refused, reason }
 */
function start(o) {
  const opts = (o && o.options) || {};
  const uids = Array.isArray(o && o.uids) ? o.uids.map(String).filter(Boolean) : [];

  if (!uids.length) return { refused: true, reason: 'no-workers' };
  if (uids.length > MAX_WORKERS)
    return { refused: true, reason: 'too-many', limit: MAX_WORKERS, asked: uids.length };
  if (runningCount() >= MAX_CONCURRENT) return { refused: true, reason: 'busy' };

  sweep();

  const rows = loadWorkers([...new Set(uids)]);
  if (!rows.length) return { refused: true, reason: 'no-workers' };

  const stamp = new Date();
  const dateStr = todayStamp(stamp);
  const groupName = rows[0].group_name || '';
  const id = crypto.randomUUID();

  /* Three names, and the difference matters:
   *   root         the single folder inside the archive, and the name the
   *                operator ends up with after extracting
   *   downloadName what the browser saves — the same, plus .zip. Clean, with no
   *                machine noise in it
   *   file         the name on the server's disk, which carries a short id
   *                because two exports of the same group on the same day must
   *                not overwrite each other while both are still live
   */
  const root = 'KD-Export_' + safeSegment(groupName, 'workers') + '_' + dateStr;
  const downloadName = root + '.zip';
  const file = root + '_' + id.slice(0, 8) + '.zip';

  const job = {
    id, by: o.by || 'system',
    exportId: o.exportId || null,
    // Both from the SAME instant, so "expires 24h after it was created" is
    // exactly true rather than true to within a millisecond or two.
    createdAt: stamp.toISOString(), startedMs: stamp.getTime(), finishedAt: null,
    dateStr, groupName, root, downloadName,
    file, path: path.join(EXPORTS_DIR, file),
    state: 'running', phase: 'starting', error: null,
    total: rows.length, done: 0,
    bytes: 0, entries: 0,
    options: {
      photos:      opts.photos !== false,
      documents:   opts.documents !== false,
      allVersions: opts.allVersions !== false,
      categories:  Array.isArray(opts.categories) ? opts.categories.map(String) : null,
      fields:      Array.isArray(opts.fields) ? opts.fields.map(String) : null,
    },
    rows,
    attachments: claimAttachments(o.attachments, o.by),
    workers: [], skipped: [], stats: { photos: 0, documents: 0, reports: 0 },
  };
  JOBS.set(id, job);

  /* Detached on purpose: the caller has already been answered. A failure is
   * recorded on the job and surfaces through status(), which is where the
   * browser is looking. */
  runBuild(job).catch(e => {
    console.error('[export-package] build failed for job ' + id + ':', e && e.message || e);
  });

  return publicView(job);
}

/** What the browser is allowed to see. Never the resolved paths or the rows. */
function publicView(job) {
  return {
    id: job.id,
    state: job.state, phase: job.phase, error: job.error,
    total: job.total, done: job.done,
    percent: job.total ? Math.round(job.done / job.total * 100) : 0,
    file: job.state === 'done' ? job.downloadName : null,
    folder: job.root,
    bytes: job.bytes, entries: job.entries,
    photos: job.stats.photos, documents: job.stats.documents, reports: job.stats.reports,
    skipped: job.skipped.length,
    /* The first few gaps by name, so the user learns WHICH papers are missing
     * without the response carrying the whole list. */
    skippedSample: job.skipped.slice(0, 8).map(s => s.folder + ' — ' + s.what),
    createdAt: job.createdAt, finishedAt: job.finishedAt,
    expiresAt: new Date(job.startedMs + TTL_MS).toISOString(),
  };
}

/** A job, for `username`. Returns null when it is not theirs or does not exist. */
function status(id, username) {
  const job = JOBS.get(String(id || ''));
  if (!job) return null;
  if (username && job.by !== username) return null;
  return publicView(job);
}

/** The finished archive's absolute path, for `username`. */
function fileFor(id, username) {
  const job = JOBS.get(String(id || ''));
  if (!job || job.state !== 'done') return null;
  if (username && job.by !== username) return null;
  if (!fs.existsSync(job.path)) return null;
  // `file` is what the browser is told to save it as — the clean name, not the
  // server's collision-proofed one.
  return { path: job.path, file: job.downloadName, diskFile: job.file,
           bytes: job.bytes, workers: job.total,
           documents: job.stats.documents, photos: job.stats.photos, skipped: job.skipped.length };
}

module.exports = {
  start, status, fileFor, sweep, stage, sweepStaging,
  // exported for the tests
  safeSegment, safeAttachmentName, folderName, extFor, readUpload,
  buildSummaryCsv, loadWorkers, claimAttachments,
  EXPORTS_DIR, STAGING_DIR, DATA_PREFIX, RESERVED_DATA_NAMES,
  TTL_MS, STAGING_TTL_MS, MAX_WORKERS, MAX_CONCURRENT, MAX_ATTACHMENT_BYTES,
  MAX_STAGED_PER_USER,
  SUMMARY_COLUMNS,
};
