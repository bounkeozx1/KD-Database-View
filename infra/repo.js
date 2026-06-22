'use strict';
/**
 * backend/repo.js — Repository layer (all SQL).
 * Returns "worker" objects in the SAME flat shape the front-end already uses,
 * so the UI code does not change. To move to PostgreSQL later, reimplement this
 * file against a pg client — nothing else in the app references SQL.
 */
const crypto = require('node:crypto');
const dbmod  = require('./db');
const { saveDataUrl, saveDocFile, deleteStored, isStoredPath } = require('./files');

const EMP_COLS = ['worker_id','employer_code','group_supervisor','en_name','lo_name','dob',
  'village','nationality','sex','blood','hand','weight','height','size','couple',
  'tel','emg_tel','kr_city','la_city',
  'grade','visa_status','education','work_experience','languages',
  'province','district'];

const d = () => dbmod.db;
const uid = () => 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

/* ── Password hashing (scrypt) ──
 * Stored format: "scrypt$<saltHex>$<hashHex>". Legacy plaintext rows are still
 * accepted at login and transparently upgraded to a hash on first success. */
function _hashPw(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain == null ? '' : plain), salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');
}
function _isHashed(s) { return typeof s === 'string' && s.startsWith('scrypt$'); }
function _verifyPw(plain, stored) {
  if (stored == null) return false;
  if (_isHashed(stored)) {
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const salt     = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    let actual;
    try { actual = crypto.scryptSync(String(plain == null ? '' : plain), salt, expected.length); }
    catch (e) { return false; }
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  return String(stored) === String(plain == null ? '' : plain); // legacy plaintext
}

/* ── Read: assemble the flat worker object ── */
function employeeToWorker(row) {
  const p = d().prepare('SELECT passport_no, issue_date, expiry_date FROM passports WHERE employee_uid=?').get(row.uid) || {};
  const docs = {};
  d().prepare('SELECT category, file_path, type, name FROM documents WHERE employee_uid=? ORDER BY id').all(row.uid)
     .forEach(doc => {
       (docs[doc.category] = docs[doc.category] || []).push({ name: doc.name, type: doc.type, data: doc.file_path });
     });
  const w = {
    uid: row.uid,
    worker_id: row.worker_id || '', employer_code: row.employer_code || '',
    group_supervisor: row.group_supervisor || '', en_name: row.en_name || '', lo_name: row.lo_name || '',
    dob: row.dob || '', province: row.province || '', district: row.district || '', village: row.village || '',
    nationality: row.nationality || '', sex: row.sex || '',
    blood: row.blood || '', hand: row.hand || '', weight: row.weight || '', height: row.height || '',
    size: row.size || '', couple: row.couple || '', tel: row.tel || '', emg_tel: row.emg_tel || '',
    kr_city: row.kr_city || '', la_city: row.la_city || '',
    grade: row.grade || '', visa_status: row.visa_status || '',
    education: row.education || '', work_experience: row.work_experience || '', languages: row.languages || '',
    photo: row.photo_path || '',
    passport_no: p.passport_no || '', passport_issue: p.issue_date || '', passport_expiry: p.expiry_date || '',
    documents: docs,
  };
  return w;
}

function getBootstrap() {
  const groups = d().prepare('SELECT * FROM groups ORDER BY sort_order, created_at').all().map(g => ({
    id: g.id, name: g.name, departure: g.departure || '', route: g.route || '',
    site_code: g.site_code || '',
    province_code: g.province_code || '',
    pinned: !!g.pinned, archived: !!g.archived,
    workers: d().prepare('SELECT * FROM employees WHERE group_id=? ORDER BY sort_order, created_at').all(g.id).map(employeeToWorker),
  }));
  const cities = { kr: [], la: [] };
  d().prepare('SELECT country, code, name FROM cities ORDER BY id').all()
     .forEach(c => { (cities[c.country] = cities[c.country] || []).push({ code: c.code, name: c.name }); });
  const users = d().prepare('SELECT username, role, name FROM users ORDER BY id').all();
  return { groups, cities, users };
}

function countEmployees() { return d().prepare('SELECT COUNT(*) AS c FROM employees').get().c; }

/* ── Groups ── */
function createGroup(g) {
  const id = g.id || 'g-' + Date.now().toString(36);
  d().prepare('INSERT INTO groups (id,name,departure,route,site_code,province_code,pinned,archived) VALUES (?,?,?,?,?,?,?,?)')
     .run(id, g.name || 'Group', g.departure || '', g.route || '', g.site_code || '', g.province_code || '', g.pinned ? 1 : 0, g.archived ? 1 : 0);
  return id;
}
function updateGroup(id, patch) {
  const cols = [], vals = [];
  ['name','departure','route','site_code','province_code'].forEach(k => { if (k in patch) { cols.push(k + '=?'); vals.push(patch[k]); } });
  if ('pinned' in patch)   { cols.push('pinned=?');   vals.push(patch.pinned ? 1 : 0); }
  if ('archived' in patch) { cols.push('archived=?'); vals.push(patch.archived ? 1 : 0); }
  if (!cols.length) return;
  vals.push(id);
  d().prepare('UPDATE groups SET ' + cols.join(',') + ' WHERE id=?').run(...vals);
}
function deleteGroup(id) {
  // remove stored files for this group's employees first
  d().prepare('SELECT uid, photo_path FROM employees WHERE group_id=?').all(id).forEach(e => {
    if (e.photo_path) deleteStored(e.photo_path);
    d().prepare('SELECT file_path FROM documents WHERE employee_uid=?').all(e.uid).forEach(x => deleteStored(x.file_path));
  });
  d().prepare('DELETE FROM groups WHERE id=?').run(id); // cascades to employees/passports/documents
}

/* ── Employees ── */
function _writePassport(employeeUid, w) {
  const no = w.passport_no || '', iss = w.passport_issue || '', exp = w.passport_expiry || '';
  if (!no && !iss && !exp) return;
  const exists = d().prepare('SELECT id FROM passports WHERE employee_uid=?').get(employeeUid);
  if (exists) d().prepare('UPDATE passports SET passport_no=?, issue_date=?, expiry_date=? WHERE employee_uid=?').run(no, iss, exp, employeeUid);
  else        d().prepare('INSERT INTO passports (employee_uid,passport_no,issue_date,expiry_date) VALUES (?,?,?,?)').run(employeeUid, no, iss, exp);
}
/**
 * Safe document sync. The incoming `documents` map is the FULL desired set for
 * this employee; each file's `data` is either an already-stored path
 * ("/uploads/…", keep it) or a fresh `data:` URL (new, save it).
 *
 * Critical fix: the previous version deleted EVERY existing file from disk and
 * re-inserted the paths — which wiped already-saved passport/ID/document images
 * the moment a second file was added. We now delete only files the payload no
 * longer references, leave kept files (and their rows) untouched, and persist
 * only the genuinely new uploads. No referenced file is ever deleted.
 */
function _writeDocuments(employeeUid, documents) {
  if (!documents || typeof documents !== 'object') return;

  // 1) What stored files does the incoming payload still reference?
  const referenced = new Set();
  Object.values(documents).forEach(files => (files || []).forEach(f => {
    if (f && typeof f.data === 'string' && isStoredPath(f.data)) referenced.add(f.data);
  }));

  // 2) Delete ONLY rows/files that are no longer referenced.
  const delRow = d().prepare('DELETE FROM documents WHERE id=?');
  d().prepare('SELECT id, file_path FROM documents WHERE employee_uid=?').all(employeeUid).forEach(row => {
    if (!referenced.has(row.file_path)) { deleteStored(row.file_path); delRow.run(row.id); }
  });

  // 3) Insert genuinely NEW uploads (data: URLs). Kept files keep their rows.
  const ins = d().prepare('INSERT INTO documents (employee_uid,category,file_path,type,name) VALUES (?,?,?,?,?)');
  Object.entries(documents).forEach(([cat, files]) => (files || []).forEach(f => {
    if (!f || typeof f.data !== 'string' || isStoredPath(f.data)) return; // already persisted → leave intact
    const p = saveDataUrl(f.data, cat);
    if (p) ins.run(employeeUid, cat, p, f.type || 'image', f.name || '');
  }));
}
/* ── Activity Log ── */
function logActivity(employeeUid, action, detail, performedBy) {
  try {
    d().prepare('INSERT INTO activity_log (employee_uid,action,detail,performed_by) VALUES (?,?,?,?)')
      .run(employeeUid || null, action, detail || null, performedBy || null);
  } catch (e) {}
}
function getActivity(employeeUid) {
  return d().prepare(
    'SELECT id, action, detail, performed_by, created_at FROM activity_log WHERE employee_uid=? ORDER BY id DESC LIMIT 50'
  ).all(employeeUid);
}

function addEmployee(groupId, w) {
  const id = w.uid || uid();
  const photo = saveDataUrl(w.photo, 'photo');
  const cols = ['uid','group_id','photo_path', ...EMP_COLS];
  const vals = [id, groupId, photo, ...EMP_COLS.map(c => w[c] || '')];
  d().prepare('INSERT INTO employees (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...vals);
  _writePassport(id, w);
  if (w.documents) _writeDocuments(id, w.documents);
  logActivity(id, 'created', w.en_name || id, w._by || null);
  return id;
}
function updateEmployee(id, patch) {
  const cols = [], vals = [];
  EMP_COLS.forEach(c => { if (c in patch) { cols.push(c + '=?'); vals.push(patch[c] || ''); } });
  let oldPhoto = null, newPhoto = null, photoChanged = false;
  if ('photo' in patch) {
    const cur = d().prepare('SELECT photo_path FROM employees WHERE uid=?').get(id);
    oldPhoto = cur && cur.photo_path || '';
    newPhoto = saveDataUrl(patch.photo, 'photo');
    photoChanged = true;
    cols.push('photo_path=?'); vals.push(newPhoto);
  }
  if (cols.length) { vals.push(id); d().prepare('UPDATE employees SET ' + cols.join(',') + ' WHERE uid=?').run(...vals); }
  if (photoChanged && oldPhoto && oldPhoto !== newPhoto && isStoredPath(oldPhoto)) deleteStored(oldPhoto);
  if ('passport_no' in patch || 'passport_issue' in patch || 'passport_expiry' in patch) _writePassport(id, patch);
  if ('documents' in patch) _writeDocuments(id, patch.documents);
  const changed = Object.keys(patch).filter(k => !['photo','documents','_by'].includes(k)).join(', ');
  if (changed) logActivity(id, 'updated', changed, patch._by || null);
}
function deleteEmployee(id) {
  const e = d().prepare('SELECT photo_path, en_name FROM employees WHERE uid=?').get(id);
  if (e && e.photo_path) deleteStored(e.photo_path);
  d().prepare('SELECT file_path FROM documents WHERE employee_uid=?').all(id).forEach(x => deleteStored(x.file_path));
  d().prepare('DELETE FROM employees WHERE uid=?').run(id);
}

/* ── Cities ── */
function addCity(country, c) {
  try { d().prepare('INSERT INTO cities (country,code,name) VALUES (?,?,?)').run(country, (c.code||'').toUpperCase(), c.name||''); return 'ok'; }
  catch (e) { return 'dup'; }
}
function deleteCity(country, code) { d().prepare('DELETE FROM cities WHERE country=? AND code=?').run(country, code); }

/* ── Users ── */
function addUser(u) {
  // Already-hashed passwords (e.g. re-importing a backup) are stored as-is;
  // plaintext is hashed before storage.
  const pw = _isHashed(u.password) ? u.password : _hashPw(u.password);
  try { d().prepare('INSERT INTO users (username,password,role,name) VALUES (?,?,?,?)').run(u.username, pw, u.role === 'admin' ? 'admin' : 'viewer', u.name || u.username); return 'ok'; }
  catch (e) { return 'dup'; }
}
function deleteUser(username) {
  const u = d().prepare('SELECT role FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  if (u.role === 'admin' && d().prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c <= 1) return 'last-admin';
  d().prepare('DELETE FROM users WHERE username=?').run(username); return 'ok';
}
// Edit a user: change display name, role, and/or reset password. Guards the last admin.
function updateUser(username, patch) {
  const u = d().prepare('SELECT role FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  if (u.role === 'admin' && patch.role && patch.role !== 'admin'
      && d().prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c <= 1) return 'last-admin';
  const cols = [], vals = [];
  if (typeof patch.name === 'string')     { cols.push('name=?'); vals.push(patch.name.trim() || username); }
  if (patch.role)                         { cols.push('role=?'); vals.push(patch.role === 'admin' ? 'admin' : 'viewer'); }
  if (patch.password)                     { cols.push('password=?'); vals.push(_isHashed(patch.password) ? patch.password : _hashPw(patch.password)); }
  if (!cols.length) return 'ok';
  vals.push(username);
  d().prepare('UPDATE users SET ' + cols.join(',') + ' WHERE username=?').run(...vals);
  return 'ok';
}
function login(username, password) {
  const u = d().prepare('SELECT username, role, name, password FROM users WHERE username=?').get(username);
  if (!u || !_verifyPw(password, u.password)) return null;
  // Transparently upgrade a legacy plaintext row to a hash on first valid login.
  if (!_isHashed(u.password)) {
    try { d().prepare('UPDATE users SET password=? WHERE username=?').run(_hashPw(password), username); } catch (e) {}
  }
  return { username: u.username, role: u.role, name: u.name };
}

/* ── Bulk import (auto-migration from the browser's localStorage) ── */
function importAll(data) {
  const tx = d();
  tx.exec('BEGIN');
  try {
    if (Array.isArray(data.groups)) {
      data.groups.forEach(g => {
        const exists = tx.prepare('SELECT id FROM groups WHERE id=?').get(g.id);
        if (!exists) createGroup(g);
        else updateGroup(g.id, { name: g.name, departure: g.departure, route: g.route, site_code: g.site_code || '', province_code: g.province_code || '' });
        (g.workers || []).forEach(w => {
          const has = w.uid && tx.prepare('SELECT uid FROM employees WHERE uid=?').get(w.uid);
          if (has) updateEmployee(w.uid, w); else addEmployee(g.id, w);
        });
      });
    }
    if (data.cities) ['kr','la'].forEach(ctry => (data.cities[ctry] || []).forEach(c => {
      if (!tx.prepare('SELECT id FROM cities WHERE country=? AND code=?').get(ctry, c.code)) addCity(ctry, c);
    }));
    if (Array.isArray(data.users)) data.users.forEach(u => {
      if (u.password && !tx.prepare('SELECT id FROM users WHERE username=?').get(u.username)) addUser(u);
    });
    tx.exec('COMMIT');
  } catch (e) { tx.exec('ROLLBACK'); throw e; }
}

/* ── Documents (versioned) ── */
function listDocuments(workerUid) {
  const rows = d().prepare(
    'SELECT id, category, file_path, type, name, version, is_current, created_at, uploaded_by ' +
    'FROM documents WHERE employee_uid=? ORDER BY category, version DESC'
  ).all(workerUid);
  const result = {};
  rows.forEach(r => {
    if (!result[r.category]) result[r.category] = [];
    result[r.category].push({
      id: r.id, path: r.file_path, type: r.type, name: r.name || '',
      version: r.version || 1, isCurrent: !!r.is_current,
      uploadedAt: r.created_at, uploadedBy: r.uploaded_by || '',
    });
  });
  return result;
}

function addDocument(workerUid, groupId, category, dataUrl, name, uploadedBy) {
  const maxRow = d().prepare(
    "SELECT COALESCE(MAX(version),0) AS m FROM documents WHERE employee_uid=? AND category=?"
  ).get(workerUid, category);
  const newVer = (maxRow.m || 0) + 1;
  d().prepare("UPDATE documents SET is_current=0 WHERE employee_uid=? AND category=?").run(workerUid, category);
  const filePath = saveDocFile(dataUrl, groupId, workerUid, category, newVer);
  const mime = /^data:([^;,]+)/.exec(dataUrl || '');
  const type = mime && mime[1].startsWith('application/pdf') ? 'pdf' : 'image';
  d().prepare(
    'INSERT INTO documents (employee_uid,group_id,category,file_path,type,name,version,is_current,uploaded_by) VALUES (?,?,?,?,?,?,?,1,?)'
  ).run(workerUid, groupId, category, filePath, type, name || '', newVer, uploadedBy || '');
  return { version: newVer, path: filePath, type };
}

function deleteDocument(docId) {
  const row = d().prepare('SELECT file_path, employee_uid, category FROM documents WHERE id=?').get(docId);
  if (!row) return 'not-found';
  deleteStored(row.file_path);
  d().prepare('DELETE FROM documents WHERE id=?').run(docId);
  // if we deleted the current version, promote the next latest
  d().prepare(
    'UPDATE documents SET is_current=1 WHERE id=(' +
    'SELECT id FROM documents WHERE employee_uid=? AND category=? ORDER BY version DESC LIMIT 1)'
  ).run(row.employee_uid, row.category);
  return 'ok';
}

module.exports = {
  getBootstrap, countEmployees,
  createGroup, updateGroup, deleteGroup,
  addEmployee, updateEmployee, deleteEmployee,
  addCity, deleteCity, addUser, deleteUser, updateUser, login, importAll,
  listDocuments, addDocument, deleteDocument,
  getActivity,
};
