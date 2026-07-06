'use strict';
/**
 * backend/admin.js — database administration: backup, restore, reset.
 * Backups are clean SQLite copies (VACUUM INTO) saved under backups/.
 */
const fs   = require('node:fs');
const path = require('node:path');
const dbmod = require('./db');

const BACKUP_DIR = path.join(dbmod.ROOT, 'data', 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Create a clean backup copy → backups/kd-<timestamp>.db. Returns the filename. */
function backup() {
  const file = 'kd-' + timestamp() + '.db';
  const dest = path.join(BACKUP_DIR, file).replace(/'/g, "''");
  dbmod.db.exec("VACUUM INTO '" + dest + "'");
  return file;
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort().reverse();
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

/** Restore from backups/<file>: replace the live DB and reopen. */
function restore(file) {
  const safe = path.basename(file);                 // prevent traversal
  const src = path.join(BACKUP_DIR, safe);
  if (!fs.existsSync(src)) throw new Error('Backup not found: ' + safe);
  // auto-backup current state before overwriting
  try { backup(); } catch (e) {}
  try { dbmod.db.close(); } catch (e) {}
  // remove WAL/SHM sidecars so the restored file is authoritative
  ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(dbmod.DB_PATH + s); } catch (e) {} });
  fs.copyFileSync(src, dbmod.DB_PATH);
  dbmod.reopen();
  return true;
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
  backup, restore, reset, listBackups, storageStats, referencedUploadPaths,
  pruneBackups, vacuum, cleanOrphans, BACKUP_DIR,
};
