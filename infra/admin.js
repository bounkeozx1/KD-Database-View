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

module.exports = { backup, restore, reset, listBackups, BACKUP_DIR };
