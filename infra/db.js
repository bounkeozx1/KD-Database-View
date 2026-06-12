'use strict';
/**
 * backend/db.js — SQLite connection + schema (Node built-in `node:sqlite`)
 *
 * Zero npm dependencies. The DB file is created automatically on first launch
 * and all tables use `CREATE TABLE IF NOT EXISTS`.
 *
 * Postgres-future note: all SQL lives in db.js + repo.js. To migrate to
 * PostgreSQL later, swap the driver here (and make repo calls async). The rest
 * of the app talks to the REST API, not the database directly.
 */
const { DatabaseSync } = require('node:sqlite');
const fs   = require('node:fs');
const path = require('node:path');

const ROOT        = path.join(__dirname, '..');
const DB_DIR      = path.join(ROOT, 'data', 'db');
const DB_PATH     = path.join(DB_DIR, 'kd.db');
const UPLOADS_DIR = path.join(ROOT, 'data', 'uploads');
const UPLOAD_SUBDIRS = ['employee-photos', 'passports', 'id-cards', 'documents'];

fs.mkdirSync(DB_DIR, { recursive: true });
UPLOAD_SUBDIRS.forEach(d => fs.mkdirSync(path.join(UPLOADS_DIR, d), { recursive: true }));

let db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  username  TEXT UNIQUE NOT NULL,
  password  TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'viewer',
  name      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employers (
  code TEXT PRIMARY KEY,
  name TEXT
);

CREATE TABLE IF NOT EXISTS cities (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  country TEXT NOT NULL,            -- 'kr' | 'la'
  code    TEXT NOT NULL,
  name    TEXT NOT NULL,
  UNIQUE(country, code)
);

CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  departure  TEXT,
  route      TEXT,
  pinned     INTEGER DEFAULT 0,
  archived   INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  uid              TEXT PRIMARY KEY,
  group_id         TEXT REFERENCES groups(id) ON DELETE CASCADE,
  worker_id        TEXT,
  employer_code    TEXT,
  group_supervisor TEXT,
  en_name          TEXT,
  lo_name          TEXT,
  dob              TEXT,
  village          TEXT,
  nationality      TEXT,
  sex              TEXT,
  blood            TEXT,
  hand             TEXT,
  weight           TEXT,
  height           TEXT,
  size             TEXT,
  couple           TEXT,
  tel              TEXT,
  emg_tel          TEXT,
  kr_city          TEXT,
  la_city          TEXT,
  photo_path       TEXT,
  sort_order       INTEGER DEFAULT 0,
  created_at       TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_emp_group ON employees(group_id);

CREATE TABLE IF NOT EXISTS passports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid  TEXT UNIQUE REFERENCES employees(uid) ON DELETE CASCADE,
  passport_no   TEXT,
  issue_date    TEXT,
  expiry_date   TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_uid TEXT REFERENCES employees(uid) ON DELETE CASCADE,
  category     TEXT NOT NULL,        -- passport|id_card|land|work_permit|other
  file_path    TEXT NOT NULL,
  type         TEXT,                 -- image|pdf
  name         TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doc_emp ON documents(employee_uid);
`;

// Default master data (so login + dropdowns work on a fresh install).
const DEFAULT_USERS = [
  { username: 'admin',   password: 'admin1234',   role: 'admin',  name: 'Administrator' },
  { username: 'manager', password: 'manager1234', role: 'admin',  name: 'Manager' },
  { username: 'viewer',  password: 'viewer1234',  role: 'viewer', name: 'Viewer' },
];
const DEFAULT_EMPLOYERS = ['VK','TK','VV','HSF','NXT','XTN','PH','PL','TMX'];
const DEFAULT_CITIES = {
  kr: [['SEO','Seoul'],['BUS','Busan'],['ICN','Incheon'],['DY','Damyang']],
  la: [['VTE','Vientiane'],['CHM','Champasak'],['SVK','Savannakhet'],['LPB','Luang Prabang']],
};

function migrate() {
  const docCols = db.prepare('PRAGMA table_info(documents)').all().map(c => c.name);
  if (!docCols.includes('version'))     db.exec('ALTER TABLE documents ADD COLUMN version INTEGER DEFAULT 1');
  if (!docCols.includes('is_current'))  db.exec('ALTER TABLE documents ADD COLUMN is_current INTEGER DEFAULT 1');
  if (!docCols.includes('group_id'))    db.exec('ALTER TABLE documents ADD COLUMN group_id TEXT');
  if (!docCols.includes('uploaded_by')) db.exec('ALTER TABLE documents ADD COLUMN uploaded_by TEXT');

  const empCols = db.prepare('PRAGMA table_info(employees)').all().map(c => c.name);
  if (!empCols.includes('grade'))           db.exec("ALTER TABLE employees ADD COLUMN grade TEXT DEFAULT ''");
  if (!empCols.includes('visa_status'))     db.exec("ALTER TABLE employees ADD COLUMN visa_status TEXT DEFAULT ''");
  if (!empCols.includes('education'))       db.exec("ALTER TABLE employees ADD COLUMN education TEXT DEFAULT ''");
  if (!empCols.includes('work_experience')) db.exec("ALTER TABLE employees ADD COLUMN work_experience TEXT DEFAULT ''");
  if (!empCols.includes('languages'))       db.exec("ALTER TABLE employees ADD COLUMN languages TEXT DEFAULT ''");

  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_uid TEXT,
    action       TEXT NOT NULL,
    detail       TEXT,
    performed_by TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  ); CREATE INDEX IF NOT EXISTS idx_act_emp ON activity_log(employee_uid);`);
}

function init() {
  db.exec(SCHEMA);
  migrate();
  seedDefaults();
  return db;
}

function seedDefaults() {
  const tx = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (tx.c === 0) {
    const ins = db.prepare('INSERT INTO users (username,password,role,name) VALUES (?,?,?,?)');
    DEFAULT_USERS.forEach(u => ins.run(u.username, u.password, u.role, u.name));
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM employers').get().c === 0) {
    const ins = db.prepare('INSERT INTO employers (code,name) VALUES (?,?)');
    DEFAULT_EMPLOYERS.forEach(c => ins.run(c, c));
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM cities').get().c === 0) {
    const ins = db.prepare('INSERT INTO cities (country,code,name) VALUES (?,?,?)');
    Object.entries(DEFAULT_CITIES).forEach(([country, list]) =>
      list.forEach(([code, name]) => ins.run(country, code, name)));
  }
}

// Re-open the DB (used after a restore replaces the file)
function reopen() {
  try { db.close(); } catch (e) {}
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

module.exports = {
  get db() { return db; },
  init, reopen, seedDefaults,
  DB_PATH, DB_DIR, UPLOADS_DIR, ROOT,
  DEFAULT_USERS, DEFAULT_CITIES,
};
