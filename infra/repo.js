'use strict';
/**
 * backend/repo.js — Repository layer (all SQL).
 * Returns "worker" objects in the SAME flat shape the front-end already uses,
 * so the UI code does not change. To move to PostgreSQL later, reimplement this
 * file against a pg client — nothing else in the app references SQL.
 */
const crypto = require('node:crypto');
const fs     = require('node:fs');
const dbmod  = require('./db');
const devmod = require('./device');
const totp   = require('./totp');
const rbac   = require('./rbac');
const { saveDataUrl, saveDocFile, deleteStored, isStoredPath } = require('./files');

const EMP_COLS = ['worker_id','employer_code','group_supervisor','en_name','lo_name','dob',
  'village','nationality','sex','blood','hand','weight','height','size','couple',
  'tel','emg_tel','kr_city','la_city',
  'grade','visa_status','education','work_experience','languages',
  'province','district'];

const d = () => dbmod.db;
const uid = () => 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');

/* ── Password hashing ──
 * Moved to infra/password.js so db.js (which seeds the first administrator) can
 * hash without a circular require. Aliases kept so the rest of this file — and
 * anything outside it — reads the same as before. */
const pwmod     = require('./password');
const _hashPw   = pwmod.hash;
const _isHashed = pwmod.isHashed;
const _verifyPw = pwmod.verify;

/* ── Configurable security policy (P4) ──
 * password.js stays dependency-free and policy-free; the EFFECTIVE policy is
 * read here and passed in at each call site. Required lazily so this module can
 * still be loaded by tooling that has not opened a database yet. */
const policyMod = require('./policy');
const _pwPolicy = () => { try { return policyMod.passwordPolicy(); } catch (e) { return pwmod.BUILTIN_POLICY; } };
const _validatePw = (plain, username) => pwmod.validate(plain, { username: username, policy: _pwPolicy() });

/* ── Password history (P4) ─────────────────────────────────────────
 * Only ever stores hashes of passwords that have been RETIRED, and only as many
 * as the policy asks for. Reuse is checked by verifying the candidate against
 * each stored hash — the same constant-time comparison used at sign-in — so the
 * plaintext of an old password never has to exist anywhere to enforce this.
 */
function _recordPasswordHistory(username, retiredHash, depth) {
  if (!retiredHash || !depth) return;
  try {
    d().prepare('INSERT INTO password_history (username,password) VALUES (?,?)').run(username, retiredHash);
    // Keep exactly `depth` rows: an unbounded table would grow forever and, worse,
    // would keep old hashes long after policy says they stop mattering.
    d().prepare(
      'DELETE FROM password_history WHERE username=? AND id NOT IN ' +
      '(SELECT id FROM password_history WHERE username=? ORDER BY id DESC LIMIT ?)'
    ).run(username, username, depth);
  } catch (e) { console.error('[password_history]', e && e.message || e); }
}

/** True when `plain` matches one of the account's last `depth` passwords. */
function _isPasswordReused(username, plain, depth) {
  if (!depth) return false;
  let rows = [];
  try {
    rows = d().prepare('SELECT password FROM password_history WHERE username=? ORDER BY id DESC LIMIT ?')
             .all(username, depth);
  } catch (e) { return false; }
  return rows.some(r => { try { return _verifyPw(plain, r.password); } catch (e) { return false; } });
}

/** Days since the account's password was last set, or null when unknown. */
function _passwordAgeDays(changedAt) {
  const iso = dbmod.toIsoUtc(changedAt);
  if (!iso) return null;
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
}

/* ── Authentication audit log ──────────────────────────────────────
 * Every credential- and account-lifecycle event lands here. Deliberately
 * best-effort (never throws): an audit write must not be able to break a sign-in
 * or a user edit, and a caller must never be able to tell from the response
 * whether a row was written. Failures go to stderr so they are still noticed.
 *
 * `ctx` carries request-scoped facts the repo cannot see for itself:
 *   { ip, userAgent, username, reason }
 */
const AUTH_ACTIONS = new Set([
  'LOGIN', 'LOGOUT', 'LOGOUT_ALL', 'SESSION_CREATE', 'SESSION_EXPIRE',
  'PASSWORD_CHANGE', 'USER_CREATE', 'USER_DELETE', 'ROLE_CHANGE',
  // P3 — MFA lifecycle and use
  'MFA_ENABLED', 'MFA_DISABLED', 'MFA_SUCCESS', 'MFA_FAILURE',
  'PASSKEY_REGISTER', 'PASSKEY_DELETE', 'PASSKEY_LOGIN',
  'RECOVERY_CODE_USED', 'DEVICE_TRUSTED', 'DEVICE_REVOKED',
  // RBAC — authorisation-sensitive actions (requirement 13)
  'PERMISSION_DENIED', 'PERMISSION_USED', 'ROLE_PERMISSION_CHANGE',
  /* P4.5 — data-lifecycle events.
   *
   * These were previously recorded only as the generic PERMISSION_USED that the
   * RBAC gate writes for any sensitive permission. That proved the permission
   * was exercised but not WHAT happened, so "was a backup restored last month?"
   * could not be answered from the trail without reading the reason strings of
   * every database.manage row. They are named events now. */
  'BACKUP_CREATE', 'BACKUP_RESTORE', 'BACKUP_DOWNLOAD',
  'DATA_EXPORT', 'DATA_IMPORT', 'POLICY_CHANGE',
  /* P4.6 — integrity operations. BACKUP_VERIFY records that somebody checked a
   * backup and what they were told; AUDIT_VERIFY and AUDIT_REANCHOR do the same
   * for the trail itself, so a failed integrity check cannot be quietly observed
   * and left unreported. */
  'BACKUP_VERIFY', 'AUDIT_VERIFY', 'AUDIT_REANCHOR',
  /* P5.1 — full-system recovery.
   *
   * The restore lifecycle is three events, not one. A restore that STARTED and
   * never COMPLETED is the single most important thing an investigator can see —
   * it means the system may be in a half-applied state — and one combined
   * "restore happened" event cannot express that. */
  'BACKUP_PACKAGE_CREATE', 'BACKUP_RESTORE_STARTED', 'BACKUP_RESTORE_COMPLETED',
  'BACKUP_RESTORE_FAILED', 'BACKUP_OFFSITE_UPLOAD', 'BACKUP_RETENTION',
  /* The per-worker export package. Its own event rather than another
   * DATA_EXPORT: building one is recorded as DATA_EXPORT (format=package), but
   * the DOWNLOAD is a second, later act — often by a different session — and it
   * is the download that puts loose passport scans on somebody's laptop. */
  'EXPORT_PACKAGE_DOWNLOAD',
]);

/* ── P4.6: chain support ───────────────────────────────────────────
 * The key is loaded lazily and cached by audit-chain.js. A failure here disables
 * chaining rather than audit logging: an unhashed row still records what
 * happened, and verification reports it as unattested. Losing the event
 * altogether would be the worse outcome.
 */
const chainmod = require('./audit-chain');
function _chainKey() {
  try { return chainmod.loadKey(dbmod.DB_DIR); } catch (e) { return null; }
}

/** Current chain head, or null when the log is empty. */
function _chainHead() {
  try {
    const r = d().prepare(
      'SELECT row_hash FROM auth_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get();
    return r ? r.row_hash : null;
  } catch (e) { return null; }
}

/**
 * Hash the row that was just inserted and link it to the head.
 *
 * Read back after the INSERT rather than hashed from the values passed in: the
 * timestamp is generated by SQLite's DEFAULT and the id by AUTOINCREMENT, so the
 * only way to hash exactly what is stored is to read exactly what is stored.
 * Hashing the inputs instead would produce a chain that verified against values
 * the table does not contain.
 */
function _chainRow(rowId) {
  const key = _chainKey();
  if (!key) return;
  try {
    const row = d().prepare(
      'SELECT ' + chainmod.CHAINED_FIELDS.join(',') + ' FROM auth_log WHERE id=?'
    ).get(rowId);
    if (!row) return;
    const prev = d().prepare(
      'SELECT row_hash FROM auth_log WHERE row_hash IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1'
    ).get(rowId);
    const prevHash = prev ? prev.row_hash : chainmod.GENESIS;
    const hash = chainmod.hashRow(key, prevHash, row);
    d().prepare('UPDATE auth_log SET prev_hash=?, row_hash=? WHERE id=?').run(prevHash, hash, rowId);
  } catch (e) {
    console.error('[audit] could not chain row ' + rowId + ':', e && e.message || e);
  }
}

function logAuth(action, result, ctx) {
  const c = ctx || {};
  try {
    // A rogue action string would poison the audit vocabulary and hide events
    // from the ISO 27001 report, so unknown values are recorded as-is but marked.
    const act = AUTH_ACTIONS.has(action) ? action : 'UNKNOWN:' + String(action).slice(0, 32);
    let userId = c.userId;
    if (userId === undefined && c.username) {
      const row = d().prepare('SELECT id FROM users WHERE username=?').get(c.username);
      userId = row ? row.id : null;
    }
    const info = d().prepare(
      'INSERT INTO auth_log (username_attempted,user_id,ip_address,user_agent,action,result,reason) ' +
      'VALUES (?,?,?,?,?,?,?)'
    ).run(
      c.username == null ? null : String(c.username).slice(0, 128),
      userId == null ? null : userId,
      c.ip == null ? null : String(c.ip).slice(0, 64),
      // UA strings are attacker-controlled and unbounded; cap before storage.
      c.userAgent == null ? null : String(c.userAgent).slice(0, 256),
      act,
      result === 'SUCCESS' || result === 'FAILURE' || result === 'LOCKED' ? result : 'FAILURE',
      c.reason == null ? null : String(c.reason).slice(0, 256)
    );
    // P4.6 — link the new row into the tamper-evident chain. Inside the same
    // try/catch, and _chainRow swallows its own errors too, so a chain problem
    // can never turn an audit write into a failed sign-in.
    if (info && info.lastInsertRowid != null) _chainRow(Number(info.lastInsertRowid));
  } catch (e) {
    console.error('[auth_log] write failed:', e && e.message || e);
  }
}

/** Read the audit trail (admin-only at the API layer). */
function getAuthLog(opts) {
  const o     = opts || {};
  const limit = Math.min(Math.max(parseInt(o.limit, 10) || 200, 1), 1000);
  const where = [], vals = [];
  if (o.username) { where.push('username_attempted = ?'); vals.push(o.username); }
  if (o.action)   { where.push('action = ?');             vals.push(o.action); }
  if (o.result)   { where.push('result = ?');             vals.push(o.result); }
  if (o.since)    { where.push('timestamp >= ?');         vals.push(o.since); }
  vals.push(limit);
  return d().prepare(
    'SELECT id, timestamp, username_attempted, user_id, ip_address, user_agent, action, result, reason ' +
    'FROM auth_log ' + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY id DESC LIMIT ?'
  ).all(...vals);
}

/* ── Read: assemble the flat worker object ──
 * `passportMap` / `docsMap` are optional pre-fetched batches (uid → rows). When
 * provided (the bootstrap path), no per-employee query is issued — this turns the
 * old N+1 (2 queries × every employee) into a constant 2 queries total. */
function employeeToWorker(row, passportMap, docsMap) {
  const p = passportMap
    ? (passportMap[row.uid] || {})
    : (d().prepare('SELECT passport_no, issue_date, expiry_date FROM passports WHERE employee_uid=?').get(row.uid) || {});
  const docs = {};
  const docRows = docsMap
    ? (docsMap[row.uid] || [])
    : d().prepare('SELECT category, file_path, type, name FROM documents WHERE employee_uid=? ORDER BY id').all(row.uid);
  docRows.forEach(doc => {
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
    photo: row.photo_path || '', photo_orig: row.photo_orig || '', photo_thumb: row.photo_thumb || '',
    passport_no: p.passport_no || '', passport_issue: p.issue_date || '', passport_expiry: p.expiry_date || '',
    documents: docs,
  };
  return w;
}

function getBootstrap() {
  // Batch-load everything in a handful of queries instead of N+1 per employee.
  const empByGroup = {};
  d().prepare('SELECT * FROM employees WHERE deleted_at IS NULL ORDER BY group_id, sort_order, created_at').all()
     .forEach(e => { (empByGroup[e.group_id] = empByGroup[e.group_id] || []).push(e); });
  const passportMap = {};
  d().prepare('SELECT employee_uid, passport_no, issue_date, expiry_date FROM passports').all()
     .forEach(p => { passportMap[p.employee_uid] = p; });
  const docsMap = {};
  d().prepare('SELECT employee_uid, category, file_path, type, name FROM documents ORDER BY id').all()
     .forEach(doc => { (docsMap[doc.employee_uid] = docsMap[doc.employee_uid] || []).push(doc); });

  const groups = d().prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY sort_order, created_at').all().map(g => ({
    id: g.id, name: g.name, departure: g.departure || '', route: g.route || '',
    site_code: g.site_code || '',
    province_code: g.province_code || '',
    pinned: !!g.pinned, archived: !!g.archived,
    workers: (empByGroup[g.id] || []).map(e => employeeToWorker(e, passportMap, docsMap)),
  }));
  const cities = { kr: [], la: [] };
  d().prepare('SELECT country, code, name FROM cities ORDER BY id').all()
     .forEach(c => { (cities[c.country] = cities[c.country] || []).push({ code: c.code, name: c.name }); });
  const users = d().prepare('SELECT username, role, name FROM users ORDER BY id').all();
  const settings = getSettings();
  settings.doc_cats = getDocCategories(settings);   // self-healed, server-persisted list
  return { groups, cities, users, settings };
}

/* ── Document categories (server-persisted + self-healing) ──
 * Categories used to live only in the browser's localStorage, so they vanished
 * whenever the site was opened from a new origin (e.g. each fresh Cloudflare
 * quick-tunnel URL) — and every document filed under them looked "lost". They
 * now live in app_settings, and the list is augmented with any category that
 * actually has documents but isn't in the configured list, so no uploaded
 * document can ever be hidden by a missing category definition. */
// Shared with the browser, which falls back to the same list — see infra/doc-cats.js.
const { DEFAULT_DOC_CATS } = require('./doc-cats');
function _deriveCatLabel(key) {
  if (/^doc_/i.test(key)) return 'Document ' + key.replace(/^doc_/i, '').slice(0, 6);
  return key.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
}
function getDocCategories(settings) {
  settings = settings || getSettings();
  const cats = Array.isArray(settings.doc_cats) && settings.doc_cats.length
    ? settings.doc_cats.slice() : DEFAULT_DOC_CATS.slice();
  const known = new Set(cats.map(c => c && c.key));
  let changed = false;
  d().prepare('SELECT DISTINCT category FROM documents').all().forEach(r => {
    const key = r.category;
    if (key && key !== 'photo' && !known.has(key)) {
      cats.push({ key, label: _deriveCatLabel(key) });
      known.add(key);
      changed = true;
    }
  });
  if (changed) setSetting('doc_cats', cats);   // persist the recovered list once
  return cats;
}

/* ── App settings (key-value, server-persisted) ── */
function getSettings() {
  const out = {};
  d().prepare('SELECT key, value FROM app_settings').all().forEach(r => {
    try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; }
  });
  return out;
}
function setSetting(key, value) {
  if (!key) return 'invalid';
  const v = JSON.stringify(value);
  d().prepare('INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(String(key), v);
  return 'ok';
}

function countEmployees() { return d().prepare('SELECT COUNT(*) AS c FROM employees').get().c; }

/* ── Groups ── */
function createGroup(g) {
  const id = g.id || 'g-' + Date.now().toString(36);
  // created_by comes from the session via _by — see addEmployee.
  d().prepare('INSERT INTO groups (id,name,departure,route,site_code,province_code,pinned,archived,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
     .run(id, g.name || 'Group', g.departure || '', g.route || '', g.site_code || '', g.province_code || '', g.pinned ? 1 : 0, g.archived ? 1 : 0, g._by || null);
  logGroupActivity(id, 'created', g.name || id, g._by || null);
  return id;
}
function updateGroup(id, patch) {
  const cols = [], vals = [];
  ['name','departure','route','site_code','province_code'].forEach(k => { if (k in patch) { cols.push(k + '=?'); vals.push(patch[k]); } });
  if ('pinned' in patch)   { cols.push('pinned=?');   vals.push(patch.pinned ? 1 : 0); }
  if ('archived' in patch) { cols.push('archived=?'); vals.push(patch.archived ? 1 : 0); }
  if (!cols.length) return;
  // Read the old name before the UPDATE so a rename can show "old → new".
  const prev = ('name' in patch)
    ? (d().prepare('SELECT name FROM groups WHERE id=?').get(id) || {}).name
    : null;
  vals.push(id);
  d().prepare('UPDATE groups SET ' + cols.join(',') + ' WHERE id=?').run(...vals);

  const by = patch._by || null;
  // Archive and rename are the events people actually look for, so they get
  // their own action rather than hiding inside a generic "updated".
  if ('archived' in patch) logGroupActivity(id, patch.archived ? 'archived' : 'unarchived', null, by);
  if ('name' in patch && prev && prev !== patch.name) logGroupActivity(id, 'renamed', prev + ' → ' + patch.name, by);
  const other = Object.keys(patch).filter(k => !['_by', 'archived', 'name', 'pinned'].includes(k));
  if (other.length) logGroupActivity(id, 'updated', other.join(', '), by);
}
function deleteGroup(id) {
  // remove stored files for this group's employees first
  d().prepare('SELECT uid, photo_path, photo_orig, photo_thumb FROM employees WHERE group_id=?').all(id).forEach(e => {
    if (e.photo_path) deleteStored(e.photo_path);
    if (e.photo_orig) deleteStored(e.photo_orig);
    if (e.photo_thumb) deleteStored(e.photo_thumb);
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
/* ── Activity Log ──
   One table, two entity types. Logging must never break the write that
   triggered it, hence the swallowed catch. */
function _logEvent(entityType, entityId, action, detail, performedBy) {
  try {
    d().prepare('INSERT INTO activity_log (employee_uid,entity_type,entity_id,action,detail,performed_by) VALUES (?,?,?,?,?,?)')
      .run(entityType === 'employee' ? (entityId || null) : null,
           entityType, entityId || null, action, detail || null, performedBy || null);
  } catch (e) {}
}
function logActivity(employeeUid, action, detail, performedBy) {
  _logEvent('employee', employeeUid, action, detail, performedBy);
}
function logGroupActivity(groupId, action, detail, performedBy) {
  _logEvent('group', groupId, action, detail, performedBy);
}
function _readLog(entityType, entityId) {
  return d().prepare(
    'SELECT id, action, detail, performed_by, created_at FROM activity_log ' +
    'WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 50'
  ).all(entityType, entityId);
}
function getActivity(employeeUid)  { return _readLog('employee', employeeUid); }
function getGroupActivity(groupId) { return _readLog('group', groupId); }

function addEmployee(groupId, w) {
  const id = w.uid || uid();
  const photo     = saveDataUrl(w.photo, 'photo');
  const photoOrig = saveDataUrl(w.photo_orig, 'photo');
  const photoThumb = saveDataUrl(w.photo_thumb, 'photo');
  /* created_by is written from w._by, which the API layer sets from the SESSION
   * (never from the request body) — so ownership cannot be forged by editing the
   * payload. Without it the 'own' scope has nothing to compare against and every
   * Data Entry edit would fail closed. */
  const cols = ['uid','group_id','photo_path','photo_orig','photo_thumb','created_by', ...EMP_COLS];
  const vals = [id, groupId, photo, photoOrig, photoThumb, w._by || null, ...EMP_COLS.map(c => w[c] || '')];
  d().prepare('INSERT INTO employees (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...vals);
  _writePassport(id, w);
  if (w.documents) _writeDocuments(id, w.documents);
  logActivity(id, 'created', w.en_name || id, w._by || null);
  logGroupActivity(groupId, 'worker_added', w.en_name || id, w._by || null);
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
  let oldOrig = null, newOrig = null, origChanged = false;
  if ('photo_orig' in patch) {
    const cur = d().prepare('SELECT photo_orig FROM employees WHERE uid=?').get(id);
    oldOrig = cur && cur.photo_orig || '';
    newOrig = saveDataUrl(patch.photo_orig, 'photo');
    origChanged = true;
    cols.push('photo_orig=?'); vals.push(newOrig);
  }
  let oldThumb = null, newThumb = null, thumbChanged = false;
  if ('photo_thumb' in patch) {
    const cur = d().prepare('SELECT photo_thumb FROM employees WHERE uid=?').get(id);
    oldThumb = cur && cur.photo_thumb || '';
    newThumb = saveDataUrl(patch.photo_thumb, 'photo');
    thumbChanged = true;
    cols.push('photo_thumb=?'); vals.push(newThumb);
  }
  /* ── Moving a worker between groups ──
   * Not in EMP_COLS, and deliberately so: group_id is not an ordinary field. It
   * re-parents the record, and with it the team every scope check reads, so it
   * is written only when the destination is a group that really exists and is
   * not in the trash — otherwise a typo would strand the worker in a group no
   * view lists. Both groups' activity logs record the move, because "where did
   * this person go" is a question asked from either side. */
  let moveFrom = null, moveTo = null;
  if ('group_id' in patch && patch.group_id) {
    const cur  = d().prepare('SELECT group_id, en_name FROM employees WHERE uid=?').get(id);
    const dest = d().prepare('SELECT id, name FROM groups WHERE id=? AND deleted_at IS NULL').get(String(patch.group_id));
    if (cur && dest && cur.group_id !== dest.id) {
      moveFrom = cur.group_id; moveTo = dest.id;
      cols.push('group_id=?'); vals.push(dest.id);
    }
  }

  if (cols.length) { vals.push(id); d().prepare('UPDATE employees SET ' + cols.join(',') + ' WHERE uid=?').run(...vals); }
  if (moveTo) {
    const who  = patch._by || null;
    const name = d().prepare('SELECT en_name FROM employees WHERE uid=?').get(id);
    const label = (name && name.en_name) || id;
    logActivity(id, 'moved', moveFrom + ' → ' + moveTo, who);
    logGroupActivity(moveFrom, 'worker_moved_out', label, who);
    logGroupActivity(moveTo,   'worker_moved_in',  label, who);
  }
  if (photoChanged && oldPhoto && oldPhoto !== newPhoto && isStoredPath(oldPhoto)) deleteStored(oldPhoto);
  if (origChanged && oldOrig && oldOrig !== newOrig && isStoredPath(oldOrig)) deleteStored(oldOrig);
  if (thumbChanged && oldThumb && oldThumb !== newThumb && isStoredPath(oldThumb)) deleteStored(oldThumb);
  if ('passport_no' in patch || 'passport_issue' in patch || 'passport_expiry' in patch) _writePassport(id, patch);
  if ('documents' in patch) _writeDocuments(id, patch.documents);
  // group_id is excluded: the move above already wrote its own, clearer entry.
  const changed = Object.keys(patch).filter(k => !['photo','photo_orig','photo_thumb','documents','_by','group_id'].includes(k)).join(', ');
  if (changed) logActivity(id, 'updated', changed, patch._by || null);
}
function deleteEmployee(id) {
  const e = d().prepare('SELECT photo_path, photo_orig, photo_thumb, en_name FROM employees WHERE uid=?').get(id);
  if (e && e.photo_path) deleteStored(e.photo_path);
  if (e && e.photo_orig) deleteStored(e.photo_orig);
  if (e && e.photo_thumb) deleteStored(e.photo_thumb);
  d().prepare('SELECT file_path FROM documents WHERE employee_uid=?').all(id).forEach(x => deleteStored(x.file_path));
  d().prepare('DELETE FROM employees WHERE uid=?').run(id);
}

/* ── Trash (soft-delete bin) ──────────────────────────────────────────
 * "Delete" moves a row to the trash (sets deleted_at) instead of destroying it.
 * Live reads (getBootstrap) filter on `deleted_at IS NULL`, so trashed rows
 * simply disappear from every normal view but keep all their data + files and
 * can be restored. Only "Delete forever" / "Empty trash" hard-delete (reusing
 * deleteEmployee/deleteGroup, which also remove the stored photo/doc files).   */
function softDeleteEmployee(id) {
  // Resolve the owner before the row is hidden, so the group's history records
  // who left it.
  const e = d().prepare('SELECT group_id, en_name FROM employees WHERE uid=?').get(id);
  d().prepare("UPDATE employees SET deleted_at=datetime('now') WHERE uid=? AND deleted_at IS NULL").run(id);
  logActivity(id, 'trashed', e && e.en_name || null, null);
  if (e && e.group_id) logGroupActivity(e.group_id, 'worker_removed', e.en_name || id, null);
}
function softDeleteGroup(id) {
  // Trash the group only; its employees keep deleted_at=NULL so restoring the
  // group brings them all back, and the trash list shows one entry, not 100.
  d().prepare("UPDATE groups SET deleted_at=datetime('now') WHERE id=? AND deleted_at IS NULL").run(id);
  logGroupActivity(id, 'trashed', null, null);
}
function restoreEmployee(id) {
  d().prepare('UPDATE employees SET deleted_at=NULL WHERE uid=?').run(id);
  logActivity(id, 'restored', null, null);
  const e = d().prepare('SELECT group_id, en_name FROM employees WHERE uid=?').get(id);
  if (e && e.group_id) logGroupActivity(e.group_id, 'worker_added', e.en_name || id, null);
}
function restoreGroup(id) {
  d().prepare('UPDATE groups SET deleted_at=NULL WHERE id=?').run(id);
  logGroupActivity(id, 'restored', null, null);
}

function listTrash() {
  const groups = d().prepare(
    'SELECT id, name, deleted_at FROM groups WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all().map(g => ({
    id: g.id, name: g.name || '', deletedAt: g.deleted_at,
    count: d().prepare('SELECT COUNT(*) AS c FROM employees WHERE group_id=? AND deleted_at IS NULL').get(g.id).c,
  }));
  // Standalone trashed workers (those trashed individually). Workers that are
  // merely inside a trashed group are NOT listed here — restore the group instead.
  const employees = d().prepare(
    'SELECT e.uid, e.en_name, e.lo_name, e.worker_id, e.deleted_at, e.group_id, g.name AS group_name ' +
    'FROM employees e LEFT JOIN groups g ON g.id=e.group_id ' +
    'WHERE e.deleted_at IS NOT NULL ORDER BY e.deleted_at DESC'
  ).all().map(e => ({
    uid: e.uid, en_name: e.en_name || '', lo_name: e.lo_name || '', worker_id: e.worker_id || '',
    groupId: e.group_id, groupName: e.group_name || '', deletedAt: e.deleted_at,
  }));
  return { groups, employees };
}

function emptyTrash() {
  // Hard-delete everything currently in the trash (files included). Groups first
  // so their cascade removes contained employees; the employee pass then clears
  // any individually-trashed workers (already-gone uids are harmless no-ops).
  d().prepare('SELECT id FROM groups WHERE deleted_at IS NOT NULL').all().forEach(g => deleteGroup(g.id));
  d().prepare('SELECT uid FROM employees WHERE deleted_at IS NOT NULL').all().forEach(e => deleteEmployee(e.uid));
}

/* ── Cities ── */
function addCity(country, c) {
  try { d().prepare('INSERT INTO cities (country,code,name) VALUES (?,?,?)').run(country, (c.code||'').toUpperCase(), c.name||''); return 'ok'; }
  catch (e) { return 'dup'; }
}
function deleteCity(country, code) { d().prepare('DELETE FROM cities WHERE country=? AND code=?').run(country, code); }

/* ── Users ── */

/**
 * Create an account. Returns 'ok' | 'dup' | 'weak-password:<code>'.
 *
 * `allowPreHashed` exists for backup/bundle restore, where the stored value is
 * already a hash and re-hashing it would lock the owner out. It must stay OFF
 * for the API path — otherwise a caller could POST a hash it chose itself and
 * skip the policy check entirely.
 */
function addUser(u, opts) {
  const o = opts || {};
  let stored;
  let mustChange = o.mustChange === false ? 0 : 1;

  if (_isHashed(u.password)) {
    // Only the restore path may supply a hash. On the API path this would let a
    // caller pick the stored value directly and bypass the policy check.
    if (!o.allowPreHashed) return 'weak-password:pre-hashed-not-allowed';
    stored = u.password;
  } else if (o.allowPreHashed) {
    // Restore of an OLD bundle, whose rows are still plaintext. Rejecting these
    // on policy would silently drop accounts from a restore, so hash them as-is
    // and force the owner onto a compliant password at next sign-in instead.
    stored = _hashPw(u.password);
    if (!_validatePw(u.password, u.username).ok) mustChange = 1;
  } else {
    const v = _validatePw(u.password, u.username);
    if (!v.ok) return 'weak-password:' + v.code;
    stored = _hashPw(u.password);
  }

  /* Role is now resolved against the roles table rather than being coerced to
   * admin-or-viewer. An unrecognised role falls back to the LEAST privileged
   * one — never to admin. */
  const wanted = String(u.role || 'viewer').toLowerCase();
  let roleRow = d().prepare('SELECT id, key, rank FROM roles WHERE key=?').get(wanted);
  if (!roleRow) roleRow = d().prepare("SELECT id, key, rank FROM roles WHERE key='viewer'").get();
  if (!roleRow) return 'unknown-role';

  /* Rank invariant, enforced at creation as well as at role change: an actor
   * may not create an account at or above their own privilege. This is what
   * makes "Manager cannot create Admin accounts" structural rather than a
   * matter of which routes happen to be wired up. */
  if (o.actorRank != null && !rbac.canAssignRole(o.actorRank, roleRow.rank))
    return 'rank-violation';

  try {
    d().prepare(
      'INSERT INTO users (username,password,role,role_id,name,must_change_password,password_changed_at) ' +
      "VALUES (?,?,?,?,?,?,datetime('now'))"
    ).run(u.username, stored, roleRow.key, roleRow.id, u.name || u.username,
          // An admin-chosen password is temporary by definition — the new owner
          // must replace it before the account can do anything.
          mustChange);
  } catch (e) { return 'dup'; }
  const role = roleRow.key;
  logAuth('USER_CREATE', 'SUCCESS', {
    username: u.username, ip: o.ip, userAgent: o.userAgent,
    reason: 'role=' + role + ' by=' + (o.actor || 'system'),
  });
  return 'ok';
}

function deleteUser(username, opts) {
  const o = opts || {};
  const u = d().prepare('SELECT role FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  if (u.role === 'admin' && d().prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c <= 1) return 'last-admin';
  // Resolve the id before the row disappears, so the audit entry keeps it.
  const row = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  d().prepare('DELETE FROM users WHERE username=?').run(username);
  deleteUserSessions(username);   // a deleted account must not stay signed in
  logAuth('USER_DELETE', 'SUCCESS', {
    username: username, userId: row ? row.id : null, ip: o.ip, userAgent: o.userAgent,
    reason: 'by=' + (o.actor || 'system'),
  });
  return 'ok';
}

// Edit a user: change display name, role, and/or reset password. Guards the last admin.
function updateUser(username, patch, opts) {
  const o = opts || {};
  const u = d().prepare('SELECT role, password FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  if (u.role === 'admin' && patch.role && patch.role !== 'admin'
      && d().prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get().c <= 1) return 'last-admin';

  const cols = [], vals = [];
  if (typeof patch.name === 'string')     { cols.push('name=?'); vals.push(patch.name.trim() || username); }

  /* Role changes go through setUserRole() below rather than being written here,
   * so the rank invariant and the last-admin guard cannot be bypassed by using
   * the generic update path. `patch.role` used to be coerced to admin-or-viewer,
   * which silently discarded any other role. */
  let roleChange = null;
  if (patch.role) {
    const target = d().prepare('SELECT id, key, rank FROM roles WHERE key=?')
      .get(String(patch.role).toLowerCase());
    if (!target) return 'unknown-role';
    if (o.actorRank != null && !rbac.canAssignRole(o.actorRank, target.rank)) return 'rank-violation';
    roleChange = target.key;
  }
  if (patch.password) {
    // An admin resetting somebody's password supplies plaintext, which must meet
    // policy. Pre-hashed values are only legitimate on the restore path.
    if (_isHashed(patch.password)) {
      if (!o.allowPreHashed) return 'weak-password:pre-hashed-not-allowed';
      cols.push('password=?'); vals.push(patch.password);
    } else {
      const v = _validatePw(patch.password, username);
      if (!v.ok) return 'weak-password:' + v.code;
      /* Reuse check applies to an administrator's reset too. Without it, "reset
       * it to what it was" defeats both the history rule and the expiry rule in
       * one step, and it is the reset path — not the self-service one — where
       * that shortcut is most tempting. */
      if (_isPasswordReused(username, patch.password, _pwPolicy().historyDepth))
        return 'password-reused';
      cols.push('password=?'); vals.push(_hashPw(patch.password));
    }
    cols.push("password_changed_at=datetime('now')");
    // Reset by somebody else ⇒ temporary; the owner must set their own next.
    cols.push('must_change_password=?'); vals.push(o.mustChange === false ? 0 : 1);
  }
  if (cols.length) {
    vals.push(username);
    d().prepare('UPDATE users SET ' + cols.join(',') + ' WHERE username=?').run(...vals);
  }
  if (roleChange) {
    const s = setUserRole(username, roleChange, o);
    if (s !== 'ok') return s;                    // 'last-admin' | 'rank-violation' | …
  }
  if (!cols.length && !roleChange) return 'ok';

  // A new password invalidates every session opened with the old one.
  // (A role change needs no revoke: the role is re-read from users per request.)
  if (patch.password) {
    _recordPasswordHistory(username, u.password, _pwPolicy().historyDepth);
    deleteUserSessions(username);
    logAuth('PASSWORD_CHANGE', 'SUCCESS', {
      username: username, ip: o.ip, userAgent: o.userAgent,
      reason: 'admin-reset by=' + (o.actor || 'system') + '; sessions revoked',
    });
  }
  // setUserRole() writes its own ROLE_CHANGE audit entry.
  return 'ok';
}

/**
 * Self-service password change. Requires the CURRENT password even though the
 * caller already holds a valid session — a hijacked session must not be enough
 * to lock the real owner out of their own account.
 *
 * Returns 'ok' | 'missing' | 'bad-current' | 'weak-password:<code>' |
 *         'same-password' | 'password-reused'.
 */
function changeOwnPassword(username, currentPassword, newPassword, opts) {
  const o = opts || {};
  const u = d().prepare('SELECT id, password FROM users WHERE username=?').get(username);
  if (!u) { pwmod.dummyVerify(currentPassword); return 'missing'; }

  if (!_verifyPw(currentPassword, u.password)) {
    logAuth('PASSWORD_CHANGE', 'FAILURE', {
      username: username, userId: u.id, ip: o.ip, userAgent: o.userAgent,
      reason: 'current-password-incorrect',
    });
    return 'bad-current';
  }
  const pol = _pwPolicy();
  const v = pwmod.validate(newPassword, { username: username, policy: pol });
  if (!v.ok) return 'weak-password:' + v.code;
  // Blocks the "change it and change it straight back" defeat of a forced reset.
  if (_verifyPw(newPassword, u.password)) return 'same-password';
  /* And the longer version of the same trick: cycling through a handful of
   * passwords to land back on a favourite. Checked against the configured
   * history depth (0 disables it, which is the pre-P4 behaviour). */
  if (_isPasswordReused(username, newPassword, pol.historyDepth)) return 'password-reused';

  _recordPasswordHistory(username, u.password, pol.historyDepth);
  d().prepare(
    "UPDATE users SET password=?, must_change_password=0, password_changed_at=datetime('now') WHERE username=?"
  ).run(_hashPw(newPassword), username);

  // Every other session for this account dies; the caller's own session is
  // re-issued by the API layer so the user is not signed out mid-change.
  deleteUserSessions(username);
  logAuth('PASSWORD_CHANGE', 'SUCCESS', {
    username: username, userId: u.id, ip: o.ip, userAgent: o.userAgent,
    reason: 'self-service; all sessions revoked',
  });

  // The first-run credential is no longer valid — remove the note from disk.
  try {
    if (fs.existsSync(dbmod.INITIAL_PW_PATH)) fs.unlinkSync(dbmod.INITIAL_PW_PATH);
  } catch (e) {}
  return 'ok';
}

/**
 * Verify credentials. Returns the user record, or null.
 *
 * Two behaviours here are load-bearing and easy to "tidy" away:
 *  1. The unknown-username path still runs a full hash (dummyVerify). Returning
 *     early made an unknown account answer in ~0 ms and a real one in ~100 ms,
 *     which enumerates staff accounts over the network.
 *  2. Nothing about WHY it failed reaches the caller — the API returns one
 *     generic 401 for both cases. The distinction goes to auth_log only.
 */
function login(username, password, ctx) {
  const c = ctx || {};
  const u = d().prepare(
    'SELECT id, username, role, name, password, must_change_password, password_changed_at FROM users WHERE username=?'
  ).get(username);

  if (!u) {
    pwmod.dummyVerify(password);
    logAuth('LOGIN', 'FAILURE', {
      username: username, userId: null, ip: c.ip, userAgent: c.userAgent, reason: 'no-such-user',
    });
    return null;
  }
  if (!_verifyPw(password, u.password)) {
    logAuth('LOGIN', 'FAILURE', {
      username: username, userId: u.id, ip: c.ip, userAgent: c.userAgent, reason: 'bad-password',
    });
    return null;
  }

  // Upgrade the stored hash whenever the row is below current policy — legacy
  // plaintext, or the old implicit-parameter scrypt format. This is the only
  // moment the plaintext is available, so it is the only moment it can be done.
  if (pwmod.needsRehash(u.password)) {
    try {
      d().prepare('UPDATE users SET password=? WHERE username=?').run(_hashPw(password), username);
    } catch (e) { console.error('[login] rehash failed:', e && e.message || e); }
  }

  /* ── Password expiry (P4) ──
   * Evaluated at sign-in rather than by a background job: expiry only matters at
   * the moment the credential is used, and a scheduled sweep would have to run
   * on a machine that may be asleep. Setting must_change_password reuses the
   * existing forced-change gate, so an expired password lands the user on the
   * same screen as an admin-issued one — no second code path to keep correct. */
  let mustChange = !!u.must_change_password;
  const maxAgeDays = _pwPolicy().maxAgeDays;
  if (!mustChange && maxAgeDays > 0) {
    const age = _passwordAgeDays(u.password_changed_at);
    if (age != null && age >= maxAgeDays) {
      try {
        d().prepare('UPDATE users SET must_change_password=1 WHERE username=?').run(username);
        mustChange = true;
        logAuth('PASSWORD_CHANGE', 'SUCCESS', {
          username: u.username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
          reason: 'expired after ' + age + ' days (policy ' + maxAgeDays + '); change forced',
        });
      } catch (e) { console.error('[login] expiry flag failed:', e && e.message || e); }
    }
  }

  logAuth('LOGIN', 'SUCCESS', {
    username: u.username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: mustChange ? 'password-change-required' : null,
  });
  return {
    username: u.username, role: u.role, name: u.name,
    mustChangePassword: mustChange,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * Sessions  (P1)
 * ══════════════════════════════════════════════════════════════════
 * A successful username+password login is the ONLY way to get a session, and a
 * session is the ONLY way to reach the API. The browser never holds the role —
 * it is re-read from the users table on every request, so promoting/demoting a
 * user (or deleting them) takes effect on their very next call.
 *
 * The server stores SHA-256(token), never the token. See the schema comment in
 * db.js for why an unsalted digest is the right primitive for a 256-bit random
 * token (and why that is not inconsistent with how passwords are stored).
 */
const SESSION_TTL_MS  = 12 * 60 * 60 * 1000;        // normal sign-in: 12 hours
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // "keep me logged in": 30 days

/* Absolute ceiling. Applies no matter how active the session is and no matter
 * what expires_at says — a session that has existed for 30 days ends, full
 * stop. This is the backstop that guarantees credentials are re-presented
 * periodically even if every other timer keeps getting refreshed. */
const ABSOLUTE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/* Per-role session policy.
 *
 * `manager` and `employee` are defined here even though the current role model
 * is admin/viewer — the P2 role split then needs no change on this side. Until
 * that lands, `viewer` is the account type real staff hold, so it is mapped to
 * the employee tier rather than left on the fallback.
 *
 * Rationale for tighter limits on admin: an admin session can read every
 * passport in the database and mutate any record, so it gets the shortest idle
 * window and the fewest concurrent devices. */
const SESSION_POLICY = {
  admin:      { idleMs:  30 * 60 * 1000, maxDevices: 2 },
  manager:    { idleMs:  60 * 60 * 1000, maxDevices: 3 },
  // Operational staff work a full shift in the system; a 30-minute idle timeout
  // would interrupt data entry constantly for no security gain, since the role
  // cannot delete, export or manage accounts.
  data_entry: { idleMs: 120 * 60 * 1000, maxDevices: 5 },
  employee:   { idleMs: 120 * 60 * 1000, maxDevices: 5 },   // retained: pre-RBAC name
  viewer:     { idleMs: 120 * 60 * 1000, maxDevices: 5 },
};
const DEFAULT_POLICY = { idleMs: 30 * 60 * 1000, maxDevices: 2 };
/**
 * Unknown roles get the STRICTEST policy, never the loosest: a typo in a role
 * name must fail closed.
 *
 * P4: an administrator-configured policy (Security → Session Policy) takes
 * precedence over the table above, which is now the DEFAULT rather than the
 * only answer. infra/policy.js clamps every value it returns, so a configured
 * policy cannot be looser than the bounds allow — and if reading it fails for
 * any reason we fall back to the compiled-in table rather than to "no limit".
 */
function policyFor(role) {
  const key = String(role || '').toLowerCase();
  const base = SESSION_POLICY[key] || DEFAULT_POLICY;
  try {
    const cfg = policyMod.sessionPolicy();
    const idle = cfg.idleMinutes[key];
    const dev  = cfg.maxDevices[key];
    if (idle == null && dev == null) return base;
    return {
      idleMs:     idle != null ? idle * 60 * 1000 : base.idleMs,
      maxDevices: dev  != null ? dev              : base.maxDevices,
    };
  } catch (e) { return base; }
}

/** Session lifetimes, honouring the configured policy. */
function _sessionTtls() {
  try {
    const cfg = policyMod.sessionPolicy();
    return {
      sessionMs:  cfg.sessionHours * 60 * 60 * 1000,
      rememberMs: cfg.rememberDays * 24 * 60 * 60 * 1000,
      absoluteMs: cfg.absoluteDays * 24 * 60 * 60 * 1000,
    };
  } catch (e) {
    return { sessionMs: SESSION_TTL_MS, rememberMs: REMEMBER_TTL_MS, absoluteMs: ABSOLUTE_MAX_MS };
  }
}

const _sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const _nowIso = () => new Date().toISOString();

/** Parse a stored timestamp to epoch ms, tolerating both formats.
 *  Rows written before P1 use SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no zone
 *  marker) which Date.parse treats as LOCAL time — a silent multi-hour error
 *  that would expire sessions early. dbmod.toIsoUtc normalises both. */
function _ms(ts) {
  const iso = dbmod.toIsoUtc(ts);
  return iso ? Date.parse(iso) : NaN;
}

/**
 * Issue a session. Enforces the concurrent-device limit for the account's role
 * before inserting, so the limit can never be exceeded even momentarily.
 */
function createSession(username, remember, ctx) {
  const c     = ctx || {};
  const token = crypto.randomBytes(32).toString('hex');
  const ttl   = _sessionTtls();
  const ttlMs = remember ? ttl.rememberMs : ttl.sessionMs;
  const now   = Date.now();
  // expires_at never exceeds the absolute ceiling, so the two limits can't disagree.
  const effectiveTtl = Math.min(ttlMs, ttl.absoluteMs);
  const expires = new Date(now + effectiveTtl).toISOString();

  const u    = d().prepare('SELECT id, role FROM users WHERE username=?').get(username);
  const pol  = policyFor(u && u.role);
  const dev  = devmod.deviceName(c.userAgent);

  purgeExpiredSessions();
  // Evict BEFORE inserting, leaving room for this one (maxDevices - 1).
  const evicted = _enforceDeviceLimit(username, pol.maxDevices - 1, c);

  // Per-session CSRF secret, minted with the session and never reused across
  // sessions — so a token captured from one login is useless after re-auth.
  const csrf = crypto.randomBytes(32).toString('hex');

  d().prepare(
    'INSERT INTO sessions (token_hash,username,user_id,ip,user_agent,device_name,created_at,last_seen,expires_at,csrf_token) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(_sha256(token), username, u ? u.id : null,
        c.ip || null,
        c.userAgent ? String(c.userAgent).slice(0, 256) : null,
        dev, new Date(now).toISOString(), new Date(now).toISOString(), expires, csrf);

  logAuth('SESSION_CREATE', 'SUCCESS', {
    username: username, userId: u ? u.id : null, ip: c.ip, userAgent: c.userAgent,
    reason: (remember ? 'remember-me ' + Math.round(ttl.rememberMs / 86400000) + 'd'
                      : 'standard ' + Math.round(ttl.sessionMs / 3600000) + 'h') + '; device=' + dev +
            '; expires=' + expires + (evicted ? '; evicted ' + evicted + ' oldest' : ''),
  });
  return { token, expiresAt: expires, maxAge: Math.floor(effectiveTtl / 1000), deviceName: dev, csrfToken: csrf };
}

/**
 * The CSRF secret for a session, minting one if the row predates the column.
 * Lazy backfill rather than a bulk UPDATE at migration time: sessions created
 * before P2 keep working, and each gets a secret the first time it needs one.
 */
function ensureCsrfToken(token) {
  if (!token) return null;
  const hash = _sha256(token);
  const row = d().prepare('SELECT id, csrf_token FROM sessions WHERE token_hash=?').get(hash);
  if (!row) return null;
  if (row.csrf_token) return row.csrf_token;
  const fresh = crypto.randomBytes(32).toString('hex');
  try { d().prepare('UPDATE sessions SET csrf_token=? WHERE id=?').run(fresh, row.id); }
  catch (e) { return null; }
  return fresh;
}

/** Constant-time compare of a presented CSRF token against the session's. */
function verifyCsrfToken(token, presented) {
  if (!token || !presented) return false;
  const row = d().prepare('SELECT csrf_token FROM sessions WHERE token_hash=?').get(_sha256(token));
  if (!row || !row.csrf_token) return false;
  const a = Buffer.from(String(row.csrf_token));
  const b = Buffer.from(String(presented));
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Task 4 — concurrent session limit. Keeps the NEWEST sessions and revokes the
 * oldest beyond `keep`, ordered by created_at (not last_seen: "oldest device"
 * should mean the one signed in longest ago, not merely the one idle longest).
 * @returns {number} how many were revoked
 */
function _enforceDeviceLimit(username, keep, ctx) {
  const c = ctx || {};
  const rows = d().prepare(
    'SELECT id, device_name, created_at FROM sessions WHERE username=? ORDER BY datetime(created_at) DESC, id DESC'
  ).all(username);
  if (rows.length <= keep) return 0;

  const doomed = rows.slice(Math.max(0, keep));
  const del = d().prepare('DELETE FROM sessions WHERE id=?');
  doomed.forEach(r => {
    del.run(r.id);
    logAuth('SESSION_EXPIRE', 'SUCCESS', {
      username: username, ip: c.ip, userAgent: c.userAgent,
      reason: 'concurrent-session-limit; revoked oldest device=' + (r.device_name || 'unknown') +
              ' created=' + r.created_at,
    });
  });
  return doomed.length;
}

/**
 * Resolve a presented token to the live account, applying every session rule.
 *
 * Returns { ok: true, user, session } or { ok: false, reason }, where reason is
 * one of: no-token | unknown-session | session-expired | absolute-lifetime |
 * idle-timeout. The API turns that into a precise 401 so the sign-in page can
 * tell the user WHY they were signed out instead of silently bouncing them.
 */
function resolveSession(token, ctx) {
  const c = ctx || {};
  if (!token) return { ok: false, reason: 'no-token' };

  const row = d().prepare(
    'SELECT s.id, s.token_hash, s.created_at, s.last_seen, s.expires_at, s.device_name, s.ip, ' +
    '       u.id AS uid, u.username, u.role, u.name, u.must_change_password ' +
    'FROM sessions s JOIN users u ON u.username = s.username WHERE s.token_hash=?'
  ).get(_sha256(token));
  if (!row) return { ok: false, reason: 'unknown-session' };

  const now = Date.now();
  const kill = (reason, detail) => {
    d().prepare('DELETE FROM sessions WHERE id=?').run(row.id);
    logAuth('SESSION_EXPIRE', 'SUCCESS', {
      username: row.username, userId: row.uid, ip: c.ip, userAgent: c.userAgent,
      reason: reason + (detail ? '; ' + detail : ''),
    });
    return { ok: false, reason: reason };
  };

  // 1. Absolute lifetime — checked first, because it must win regardless of any
  //    activity or of what expires_at was set to.
  const created = _ms(row.created_at);
  if (Number.isFinite(created) && now - created >= _sessionTtls().absoluteMs)
    return kill('absolute-lifetime', 'created=' + row.created_at + ' age=' +
      Math.floor((now - created) / 86400000) + 'd');

  // 2. Scheduled expiry.
  const exp = _ms(row.expires_at);
  if (Number.isFinite(exp) && exp <= now)
    return kill('session-expired', 'expired=' + row.expires_at);

  // 3. Idle timeout, per role.
  const pol  = policyFor(row.role);
  const seen = _ms(row.last_seen) || created;
  if (Number.isFinite(seen) && now - seen >= pol.idleMs)
    return kill('idle-timeout', 'role=' + row.role + ' idle=' +
      Math.floor((now - seen) / 60000) + 'm limit=' + Math.floor(pol.idleMs / 60000) + 'm');

  // Alive — slide the idle window forward.
  try {
    d().prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(_nowIso(), row.id);
  } catch (e) {}

  return {
    ok: true,
    user: {
      username: row.username, role: row.role, name: row.name,
      mustChangePassword: !!row.must_change_password,
    },
    session: { id: row.id, deviceName: row.device_name, createdAt: row.created_at, expiresAt: row.expires_at },
  };
}

/** The user fields safe to return to a client (never the password hash). */
function getUserPublic(username) {
  const u = d().prepare(
    'SELECT username, role, name, must_change_password FROM users WHERE username=?'
  ).get(username);
  if (!u) return null;
  return {
    username: u.username, role: u.role, name: u.name,
    mustChangePassword: !!u.must_change_password,
  };
}

/** Back-compatible wrapper: the live user record, or null. */
function sessionUser(token, ctx) {
  const r = resolveSession(token, ctx);
  return r.ok ? r.user : null;
}

/** Task 7 — session dashboard. Never leaks token_hash. */
function listSessions(username, currentToken) {
  const currentHash = currentToken ? _sha256(currentToken) : null;
  return d().prepare(
    'SELECT id, token_hash, device_name, ip, user_agent, created_at, last_seen, expires_at ' +
    'FROM sessions WHERE username=? ORDER BY datetime(last_seen) DESC, id DESC'
  ).all(username).map(r => ({
    id: r.id,
    device_name: r.device_name || 'Unknown device',
    ip: r.ip || null,
    created_at: r.created_at,
    last_seen: r.last_seen,
    expires_at: r.expires_at,
    // Lets the UI label "This device" and refuse to revoke it by accident.
    current: !!currentHash && r.token_hash === currentHash,
  }));
}

/** Revoke one session by id, but only if it belongs to `username`.
 *  The ownership check is the authorisation boundary: without it any signed-in
 *  account could revoke any other account's session by guessing a small integer. */
function revokeSession(username, sessionId, ctx) {
  const c   = ctx || {};
  const row = d().prepare('SELECT id, username, device_name FROM sessions WHERE id=?').get(sessionId);
  if (!row || row.username !== username) return 'not-found';
  d().prepare('DELETE FROM sessions WHERE id=?').run(row.id);
  logAuth('LOGOUT', 'SUCCESS', {
    username: username, ip: c.ip, userAgent: c.userAgent,
    reason: 'session revoked from dashboard; device=' + (row.device_name || 'unknown'),
  });
  return 'ok';
}

/** Task 6 — sign out every device. `keepToken` optionally spares the caller's
 *  own session so the user is not logged out of the device they are using. */
function logoutAllSessions(username, keepToken, ctx) {
  const c = ctx || {};
  const keepHash = keepToken ? _sha256(keepToken) : null;
  const rows = d().prepare('SELECT id, token_hash FROM sessions WHERE username=?').all(username);
  const del = d().prepare('DELETE FROM sessions WHERE id=?');
  let n = 0;
  rows.forEach(r => { if (!keepHash || r.token_hash !== keepHash) { del.run(r.id); n++; } });
  logAuth('LOGOUT_ALL', 'SUCCESS', {
    username: username, ip: c.ip, userAgent: c.userAgent,
    reason: 'revoked ' + n + ' session(s)' + (keepHash ? '; kept current device' : '; including current device'),
  });
  return n;
}

function deleteSession(token) {
  if (token) d().prepare('DELETE FROM sessions WHERE token_hash=?').run(_sha256(token));
}
// Kick every device a user is signed in on — used when their password is reset
// or their account is removed, so an old session can't outlive the credential.
function deleteUserSessions(username) {
  d().prepare('DELETE FROM sessions WHERE username=?').run(username);
}
/** Sweep sessions that are past ANY of the three limits.
 *  expires_at/created_at are ISO-8601 UTC strings, so a lexicographic compare is
 *  a correct chronological compare (do NOT swap in datetime('now') — SQLite's
 *  format sorts differently and would silently stop matching). */
function purgeExpiredSessions() {
  const nowIso = _nowIso();
  try { d().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso); } catch (e) {}
  try {
    d().prepare('DELETE FROM sessions WHERE created_at <= ?')
       .run(new Date(Date.now() - _sessionTtls().absoluteMs).toISOString());
  } catch (e) {}
}

/* ══════════════════════════════════════════════════════════════════
 * RBAC — permission resolution
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Every permission an account holds, as { permissionKey: scope }.
 *
 * Resolved from the database on each request rather than cached in the session:
 * revoking a permission or changing a role must take effect on the user's very
 * next call, not whenever their session happens to expire. This mirrors how the
 * role itself is already re-read per request.
 *
 * The query is a two-join lookup on indexed integer keys — cheap enough that
 * caching would trade a real security property for an imaginary saving.
 */
function getPermissions(username) {
  const rows = d().prepare(
    'SELECT p.key AS key, rp.scope AS scope ' +
    'FROM users u ' +
    'JOIN role_permissions rp ON rp.role_id = u.role_id ' +
    'JOIN permissions p       ON p.id = rp.permission_id ' +
    'WHERE u.username = ?'
  ).all(username);
  const out = {};
  rows.forEach(r => { out[r.key] = r.scope; });
  return out;
}

/** The acting user's role record (key, rank, mfa). */
function getRole(username) {
  return d().prepare(
    'SELECT r.id, r.key, r.name, r.rank, r.mfa, r.is_system ' +
    'FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username=?'
  ).get(username) || null;
}

function listRoles() {
  return d().prepare(
    'SELECT r.id, r.key, r.name, r.description, r.rank, r.mfa, r.is_system, ' +
    '       r.is_legacy, r.replaced_by, ' +
    '       (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id=r.id) AS permission_count, ' +
    '       (SELECT COUNT(*) FROM users u WHERE u.role_id=r.id) AS user_count ' +
    'FROM roles r ORDER BY r.rank'
  ).all();
}

function listPermissions() {
  return d().prepare(
    'SELECT id, key, resource, action, description, is_sensitive FROM permissions ORDER BY resource, action'
  ).all();
}

/** The full matrix, for the admin UI and for the compliance report. */
function getPermissionMatrix() {
  const roles = listRoles();
  const perms = listPermissions();
  const grants = d().prepare(
    'SELECT r.key AS role, p.key AS permission, rp.scope AS scope ' +
    'FROM role_permissions rp JOIN roles r ON r.id=rp.role_id JOIN permissions p ON p.id=rp.permission_id'
  ).all();
  const matrix = {};
  roles.forEach(r => { matrix[r.key] = {}; });
  grants.forEach(g => { if (matrix[g.role]) matrix[g.role][g.permission] = g.scope; });
  return { roles, permissions: perms, matrix };
}

/**
 * The group ids an account supervises — the concrete meaning of 'team' scope.
 *
 * Derived from groups.group_supervisor matching the account's username or
 * display name, because that is the supervisor field the application already
 * maintains. A dedicated team-membership table would be the next step if teams
 * ever need to be many-to-many (see the scalability notes).
 */
function getTeamGroupIds(username) {
  const u = d().prepare('SELECT name FROM users WHERE username=?').get(username);
  const names = [username];
  if (u && u.name) names.push(u.name);
  const ph = names.map(() => '?').join(',');
  const ids = new Set();

  // 1. Explicit assignment: groups.supervisor names this account. This is the
  //    intended mechanism going forward — unambiguous and directly editable.
  try {
    d().prepare('SELECT id FROM groups WHERE supervisor IN (' + ph + ')')
       .all(...names).forEach(r => ids.add(r.id));
  } catch (e) { /* column added by migration; ignore on an older schema */ }

  // 2. Derived: the application already records a supervisor per WORKER
  //    (employees.group_supervisor). Deriving team membership from it means
  //    'team' scope works against existing data without anyone having to
  //    re-enter supervisors first.
  try {
    d().prepare(
      'SELECT DISTINCT group_id AS id FROM employees ' +
      'WHERE group_supervisor IN (' + ph + ') AND group_id IS NOT NULL'
    ).all(...names).forEach(r => ids.add(r.id));
  } catch (e) { /* ignore */ }

  // 3. Groups this account created are its own by definition.
  try {
    d().prepare('SELECT id FROM groups WHERE created_by=?')
       .all(username).forEach(r => ids.add(r.id));
  } catch (e) { /* ignore */ }

  return [...ids];
}

/** Who created an employee record, for 'own' scope. */
function getEmployeeOwner(uid) {
  const r = d().prepare('SELECT created_by, group_id FROM employees WHERE uid=?').get(uid);
  return r ? { ownerId: r.created_by, teamId: r.group_id } : null;
}
function getGroupOwner(id) {
  const r = d().prepare('SELECT created_by, id FROM groups WHERE id=?').get(id);
  return r ? { ownerId: r.created_by, teamId: r.id } : null;
}

/**
 * Change an account's role, enforcing the rank invariant.
 *
 * Returns 'ok' | 'missing' | 'unknown-role' | 'rank-violation' | 'last-admin'.
 *
 * The rank check is the whole point: without it any role holding user.update
 * could promote itself (or a confederate) to Admin. It is enforced HERE, in the
 * repository, rather than only at the route — so a future caller that forgets
 * the check still cannot escalate.
 */
function setUserRole(username, roleKey, opts) {
  const o = opts || {};
  const target = d().prepare('SELECT id, key, rank FROM roles WHERE key=?').get(String(roleKey || '').toLowerCase());
  if (!target) return 'unknown-role';
  const u = d().prepare('SELECT id, role, role_id FROM users WHERE username=?').get(username);
  if (!u) return 'missing';

  if (o.actorRank != null && !rbac.canAssignRole(o.actorRank, target.rank)) return 'rank-violation';

  // Never allow the last administrator to be demoted — that would leave the
  // system with nobody able to manage users, and no way back short of the CLI.
  const current = d().prepare('SELECT r.key FROM users u JOIN roles r ON r.id=u.role_id WHERE u.username=?').get(username);
  if (current && current.key === 'admin' && target.key !== 'admin') {
    const admins = d().prepare(
      "SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='admin'"
    ).get().c;
    if (admins <= 1) return 'last-admin';
  }

  // role_id drives authorisation; the legacy text column is kept in step so the
  // existing display code and any older query keep telling the truth.
  d().prepare('UPDATE users SET role_id=?, role=? WHERE username=?').run(target.id, target.key, username);

  logAuth('ROLE_CHANGE', 'SUCCESS', {
    username, userId: u.id, ip: o.ip, userAgent: o.userAgent,
    reason: (current ? current.key : u.role) + ' -> ' + target.key + ' by=' + (o.actor || 'system'),
  });
  return 'ok';
}

/* ══════════════════════════════════════════════════════════════════
 * Multi-factor authentication  (P3)
 * ══════════════════════════════════════════════════════════════════ */

/* Per-role MFA policy.
 *
 * `manager` and `employee` are defined ahead of the P2-role split (which is not
 * part of this phase) so no change is needed here when it lands. `viewer` is the
 * role real staff hold today and maps to the employee tier.
 *
 *   required  — the account cannot reach the API until a second factor exists
 *   passwordOnly — may sign in with a password alone when no factor is enrolled
 *
 * Admins and managers can read every passport in the database, so for them a
 * password alone is never sufficient: it is passkey, or password + TOTP. */
/* Whether a role must hold a second factor is now a property OF THE ROLE
 * (roles.mfa), not a hard-coded list of role names. A role added later carries
 * its own answer, so this needs no edit — requirement 11 applied to MFA.
 *
 * Resolution order: the roles table (authoritative, editable at runtime), then
 * the catalogue in rbac.js, then the strictest default. An unknown or
 * unreadable role is ALWAYS treated as requiring MFA. */
function mfaPolicyFor(role) {
  const key = String(role || '').toLowerCase();
  let mfa = null;
  try {
    const row = d().prepare('SELECT mfa FROM roles WHERE key=?').get(key);
    if (row) mfa = row.mfa;
  } catch (e) { /* table may not exist yet during early migration */ }
  if (!mfa) mfa = rbac.mfaFor(key);
  const required = mfa !== 'optional';
  return { required, passwordOnly: !required };
}
// Kept for callers/tests that want the static view of the catalogue.
const MFA_POLICY = Object.freeze(rbac.ROLES.reduce((acc, r) => {
  acc[r.key] = { required: r.mfa !== 'optional', passwordOnly: r.mfa === 'optional' };
  return acc;
}, {}));

const _hashCode = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Everything the login flow needs to decide which factors apply. */
function getMfaStatus(username) {
  const u = d().prepare(
    'SELECT id, username, role, mfa_enabled, mfa_secret, mfa_enrolled_at, mfa_required FROM users WHERE username=?'
  ).get(username);
  if (!u) return null;
  const passkeys = d().prepare('SELECT COUNT(*) AS c FROM passkeys WHERE username=?').get(username).c;
  const codes    = d().prepare(
    'SELECT COUNT(*) AS c FROM mfa_recovery_codes WHERE username=? AND used_at IS NULL'
  ).get(username).c;
  const rolePolicy = mfaPolicyFor(u.role);
  /* P4 "Force Enrollment": a per-account requirement that can only ADD to the
   * role's. It is deliberately incapable of waiving one — an administrator who
   * could clear the flag on an admin account would have a one-click way to undo
   * the enforcement P3 exists to provide. */
  const forced = u.mfa_required === 1;
  const policy = forced && !rolePolicy.required
    ? { required: true, passwordOnly: false, source: 'account' }
    : Object.assign({ source: 'role' }, rolePolicy);
  return {
    username: u.username, role: u.role, userId: u.id,
    totpEnabled: !!u.mfa_enabled,
    passkeyCount: passkeys,
    recoveryCodesRemaining: codes,
    enrolledAt: u.mfa_enrolled_at,
    forcedByAdmin: forced,
    policy,
    // Any second factor at all?
    hasFactor: !!u.mfa_enabled || passkeys > 0,
    // Must the user enrol before they can use the app?
    setupRequired: policy.required && !u.mfa_enabled && passkeys === 0,
  };
}

/* ── TOTP enrolment ── */

/** Begin enrolment: store a secret but leave MFA disabled until proven. */
function beginTotpEnrolment(username) {
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return null;
  const secret = totp.generateSecret();
  d().prepare('UPDATE users SET mfa_secret=?, mfa_enabled=0 WHERE username=?').run(secret, username);
  return {
    secret,
    otpauthUrl: totp.otpauthUrl({ secret, account: username, issuer: 'KD Database' }),
  };
}

/**
 * Finish enrolment by proving possession of the secret.
 * Generates the recovery codes as a side effect — an account with a second
 * factor and no way around a lost phone is a lockout waiting to happen.
 * @returns {{ok:true, recoveryCodes:string[]}} | {ok:false, error}
 */
function confirmTotpEnrolment(username, code, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id, mfa_secret, mfa_enabled FROM users WHERE username=?').get(username);
  if (!u || !u.mfa_secret) return { ok: false, error: 'no-enrolment-in-progress' };

  const v = totp.verify(u.mfa_secret, code);
  if (!v.ok) {
    logAuth('MFA_FAILURE', 'FAILURE', {
      username, userId: u.id, ip: c.ip, userAgent: c.userAgent, reason: 'enrolment code rejected',
    });
    return { ok: false, error: 'invalid-code' };
  }

  d().prepare(
    "UPDATE users SET mfa_enabled=1, mfa_enrolled_at=datetime('now'), mfa_last_counter=? WHERE username=?"
  ).run(v.counter, username);

  const codes = regenerateRecoveryCodes(username, ctx);
  logAuth('MFA_ENABLED', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'TOTP enrolled; ' + codes.length + ' recovery codes issued',
  });
  return { ok: true, recoveryCodes: codes };
}

/**
 * Verify a TOTP code at sign-in, enforcing single-use per time step.
 * @returns {{ok:boolean, reason?:string}}
 */
function verifyTotp(username, code, ctx) {
  const c = ctx || {};
  const u = d().prepare(
    'SELECT id, mfa_secret, mfa_enabled, mfa_last_counter FROM users WHERE username=?'
  ).get(username);
  if (!u || !u.mfa_enabled || !u.mfa_secret) return { ok: false, reason: 'totp-not-enabled' };

  const v = totp.verify(u.mfa_secret, code, { lastCounter: u.mfa_last_counter });
  if (!v.ok) {
    logAuth('MFA_FAILURE', 'FAILURE', {
      username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
      reason: v.replay ? 'TOTP code replayed' : 'TOTP code incorrect',
    });
    return { ok: false, reason: v.replay ? 'code-already-used' : 'invalid-code' };
  }

  // Burn this step so the same code cannot be presented twice.
  d().prepare('UPDATE users SET mfa_last_counter=? WHERE username=?').run(v.counter, username);
  logAuth('MFA_SUCCESS', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent, reason: 'TOTP',
  });
  return { ok: true };
}

/** Turn MFA off. Removes the secret, the recovery codes — everything. */
function disableMfa(username, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  d().prepare(
    'UPDATE users SET mfa_enabled=0, mfa_secret=NULL, mfa_enrolled_at=NULL, mfa_last_counter=NULL WHERE username=?'
  ).run(username);
  d().prepare('DELETE FROM mfa_recovery_codes WHERE username=?').run(username);
  // A trusted device is a standing MFA bypass; it must not outlive MFA itself.
  d().prepare('DELETE FROM trusted_devices WHERE username=?').run(username);
  logAuth('MFA_DISABLED', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'by=' + (c.actor || 'self') + '; recovery codes and trusted devices cleared',
  });
  return 'ok';
}

/* ── Recovery codes ── */

/** Format XXXX-XXXX from an unambiguous alphabet (no O/0, I/1, S/5). */
function _newRecoveryCode() {
  const A = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += A[crypto.randomInt(A.length)];
  }
  return out;
}

/**
 * Issue a fresh set of 10, revoking every previous code.
 * Returns the plaintext — the ONLY time it exists. Only hashes are stored.
 */
function regenerateRecoveryCodes(username, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return [];
  d().prepare('DELETE FROM mfa_recovery_codes WHERE username=?').run(username);
  const ins = d().prepare(
    "INSERT INTO mfa_recovery_codes (username,user_id,code_hash,created_at) VALUES (?,?,?,datetime('now'))"
  );
  const codes = [];
  const seen = new Set();
  while (codes.length < 10) {
    const code = _newRecoveryCode();
    if (seen.has(code)) continue;          // no duplicates within a set
    seen.add(code);
    ins.run(username, u.id, _hashCode(code));
    codes.push(code);
  }
  if (c.log !== false) logAuth('MFA_ENABLED', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'recovery codes regenerated (previous set revoked)',
  });
  return codes;
}

/**
 * Spend a recovery code. One-time: the row is marked used, never reusable.
 * @returns {{ok:boolean, remaining?:number, reason?:string}}
 */
function useRecoveryCode(username, code, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return { ok: false, reason: 'invalid-code' };

  // Normalise the way a user would type it: case and the dash are incidental.
  const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formatted = norm.length === 8 ? norm.slice(0, 4) + '-' + norm.slice(4) : norm;

  const row = d().prepare(
    'SELECT id FROM mfa_recovery_codes WHERE username=? AND code_hash=? AND used_at IS NULL'
  ).get(username, _hashCode(formatted));

  if (!row) {
    logAuth('MFA_FAILURE', 'FAILURE', {
      username, userId: u.id, ip: c.ip, userAgent: c.userAgent, reason: 'recovery code rejected',
    });
    return { ok: false, reason: 'invalid-code' };
  }

  d().prepare("UPDATE mfa_recovery_codes SET used_at=datetime('now') WHERE id=?").run(row.id);
  const remaining = d().prepare(
    'SELECT COUNT(*) AS c FROM mfa_recovery_codes WHERE username=? AND used_at IS NULL'
  ).get(username).c;

  logAuth('RECOVERY_CODE_USED', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: remaining + ' code(s) remaining',
  });
  return { ok: true, remaining };
}

/* ── Passkeys (WebAuthn) ── */

function addPasskey(username, cred, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  try {
    d().prepare(
      'INSERT INTO passkeys (user_id,username,credential_id,public_key,counter,alg,aaguid,name,transports,created_at) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))"
    ).run(u.id, username, cred.credentialId, cred.publicKey, cred.counter || 0,
          cred.alg == null ? null : cred.alg, cred.aaguid || null,
          String(cred.name || 'Passkey').slice(0, 64),
          cred.transports ? JSON.stringify(cred.transports).slice(0, 200) : null);
  } catch (e) { return 'duplicate'; }

  logAuth('PASSKEY_REGISTER', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'name=' + (cred.name || 'Passkey') + ' alg=' + cred.alg,
  });
  return 'ok';
}

function listPasskeys(username) {
  return d().prepare(
    'SELECT id, credential_id, name, alg, created_at, last_used_at FROM passkeys WHERE username=? ORDER BY id'
  ).all(username).map(r => ({
    id: r.id, name: r.name || 'Passkey', alg: r.alg,
    created_at: r.created_at, last_used_at: r.last_used_at,
    // Enough to distinguish two keys in the UI, not the whole credential id.
    credential_preview: String(r.credential_id).slice(0, 12) + '…',
  }));
}

function getPasskeyByCredentialId(credentialId) {
  return d().prepare('SELECT * FROM passkeys WHERE credential_id=?').get(credentialId) || null;
}
function listPasskeyCredentialIds(username) {
  return d().prepare('SELECT credential_id, transports FROM passkeys WHERE username=?').all(username);
}
function touchPasskey(id, counter) {
  try {
    d().prepare("UPDATE passkeys SET counter=?, last_used_at=datetime('now') WHERE id=?").run(counter, id);
  } catch (e) {}
}

/** Delete one, but refuse to strip the last factor from an account that needs one. */
function deletePasskey(username, id, ctx) {
  const c = ctx || {};
  const row = d().prepare('SELECT id, username, name FROM passkeys WHERE id=?').get(id);
  if (!row || row.username !== username) return 'not-found';

  const st = getMfaStatus(username);
  if (st && st.policy.required && !st.totpEnabled && st.passkeyCount <= 1)
    return 'last-factor';

  d().prepare('DELETE FROM passkeys WHERE id=?').run(id);
  logAuth('PASSKEY_DELETE', 'SUCCESS', {
    username, ip: c.ip, userAgent: c.userAgent, reason: 'name=' + (row.name || 'Passkey'),
  });
  return 'ok';
}

/* ── Trusted devices ("remember this device for 30 days") ── */
const TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function trustDevice(username, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return null;
  // 256-bit random token; only its SHA-256 is stored, exactly as for sessions,
  // so a leaked database yields nothing that can be replayed to skip MFA.
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + TRUST_TTL_MS).toISOString();
  d().prepare(
    'INSERT INTO trusted_devices (username,user_id,token_hash,device_name,ip,user_agent,created_at,last_used_at,expires_at) ' +
    'VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(username, u.id, _sha256(token), devmod.deviceName(c.userAgent), c.ip || null,
        c.userAgent ? String(c.userAgent).slice(0, 256) : null,
        new Date().toISOString(), new Date().toISOString(), expires);

  logAuth('DEVICE_TRUSTED', 'SUCCESS', {
    username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'device=' + devmod.deviceName(c.userAgent) + '; expires=' + expires,
  });
  return { token, expiresAt: expires, maxAge: Math.floor(TRUST_TTL_MS / 1000) };
}

/** Is this device allowed to skip the MFA challenge? */
function isDeviceTrusted(username, token) {
  if (!token) return false;
  const row = d().prepare(
    'SELECT id, expires_at, revoked_at FROM trusted_devices WHERE username=? AND token_hash=?'
  ).get(username, _sha256(token));
  if (!row || row.revoked_at) return false;
  if (Date.parse(row.expires_at) <= Date.now()) {
    d().prepare('DELETE FROM trusted_devices WHERE id=?').run(row.id);
    return false;
  }
  try { d().prepare('UPDATE trusted_devices SET last_used_at=? WHERE id=?').run(new Date().toISOString(), row.id); } catch (e) {}
  return true;
}

function listTrustedDevices(username, currentToken) {
  const cur = currentToken ? _sha256(currentToken) : null;
  return d().prepare(
    'SELECT id, token_hash, device_name, ip, created_at, last_used_at, expires_at, revoked_at ' +
    'FROM trusted_devices WHERE username=? AND revoked_at IS NULL ORDER BY id DESC'
  ).all(username).map(r => ({
    id: r.id, device_name: r.device_name || 'Unknown device', ip: r.ip,
    created_at: r.created_at, last_used_at: r.last_used_at, expires_at: r.expires_at,
    current: !!cur && r.token_hash === cur,
  }));
}

function revokeTrustedDevice(username, id, ctx) {
  const c = ctx || {};
  const row = d().prepare('SELECT id, username, device_name FROM trusted_devices WHERE id=?').get(id);
  if (!row || row.username !== username) return 'not-found';
  d().prepare('DELETE FROM trusted_devices WHERE id=?').run(id);
  logAuth('DEVICE_REVOKED', 'SUCCESS', {
    username, ip: c.ip, userAgent: c.userAgent, reason: 'device=' + (row.device_name || 'unknown'),
  });
  return 'ok';
}

function revokeAllTrustedDevices(username, ctx) {
  const c = ctx || {};
  const n = d().prepare('SELECT COUNT(*) AS c FROM trusted_devices WHERE username=?').get(username).c;
  d().prepare('DELETE FROM trusted_devices WHERE username=?').run(username);
  logAuth('DEVICE_REVOKED', 'SUCCESS', {
    username, ip: c.ip, userAgent: c.userAgent, reason: 'all ' + n + ' trusted device(s) revoked',
  });
  return n;
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
      // Restore path: the bundle carries hashes, not plaintext. allowPreHashed
      // keeps them intact (re-hashing a hash would lock the owner out) and
      // mustChange:false avoids forcing a reset on every restored account.
      // This is the ONLY caller allowed to pass allowPreHashed — see addUser.
      if (u.password && !tx.prepare('SELECT id FROM users WHERE username=?').get(u.username))
        addUser(u, { allowPreHashed: true, mustChange: false, actor: 'import' });
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

/* ══════════════════════════════════════════════════════════════════
 * P4 — Administration centre
 * ══════════════════════════════════════════════════════════════════
 * Read models for the Security / Administration / Monitoring sections of
 * Settings, plus the few write actions those screens perform.
 *
 * Everything here is aggregate or account-lifecycle. Note what is deliberately
 * ABSENT: there is no function that enumerates another user's sessions, devices
 * or IP addresses in detail. An administrator can see COUNTS and can revoke, but
 * cannot follow a colleague around. That boundary was set in P1 and P4 keeps it
 * — administration is not surveillance.
 */

/** Accounts, with the facts the Users screen shows. Never returns a hash. */
function listUsersAdmin() {
  return d().prepare(
    'SELECT u.id, u.username, u.name, u.role, u.created_at, u.must_change_password, ' +
    '       u.password_changed_at, u.mfa_enabled, u.mfa_required, ' +
    '       r.key AS role_key, r.name AS role_name, r.rank AS role_rank, r.mfa AS role_mfa, ' +
    '       r.is_legacy AS role_legacy, ' +
    '       (SELECT COUNT(*) FROM passkeys pk WHERE pk.username = u.username) AS passkeys, ' +
    '       (SELECT COUNT(*) FROM sessions s WHERE s.username = u.username) AS sessions, ' +
    '       (SELECT MAX(timestamp) FROM auth_log a ' +
    "         WHERE a.username_attempted = u.username AND a.action='LOGIN' AND a.result='SUCCESS') AS last_login " +
    'FROM users u LEFT JOIN roles r ON r.id = u.role_id ' +
    'ORDER BY COALESCE(r.rank, 999), u.username'
  ).all().map(u => ({
    username: u.username,
    name: u.name || u.username,
    role: u.role_key || u.role,
    roleName: u.role_name || u.role,
    roleRank: u.role_rank == null ? 999 : u.role_rank,
    roleLegacy: !!u.role_legacy,
    createdAt: dbmod.toIsoUtc(u.created_at),
    lastLogin: dbmod.toIsoUtc(u.last_login),
    passwordChangedAt: dbmod.toIsoUtc(u.password_changed_at),
    passwordAgeDays: _passwordAgeDays(u.password_changed_at),
    mustChangePassword: !!u.must_change_password,
    totpEnabled: !!u.mfa_enabled,
    passkeyCount: u.passkeys,
    activeSessions: u.sessions,
    mfaForced: u.mfa_required === 1,
    // The effective requirement, so the UI never has to re-derive policy.
    mfaRequired: (u.role_mfa || 'optional') === 'required' || u.mfa_required === 1,
    hasFactor: !!u.mfa_enabled || u.passkeys > 0,
  }));
}

/* ── Audit log: paginated, searchable ──────────────────────────────
 * getAuthLog() above is kept unchanged for existing callers. This is the query
 * the P4 viewer uses: it returns a total alongside the page so the UI can show
 * "51–100 of 4 312" without a second round trip, and it accepts a free-text term
 * matched against the three columns an investigator actually searches.
 */
function queryAuthLog(opts) {
  const o      = opts || {};
  const limit  = Math.min(Math.max(parseInt(o.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(o.offset, 10) || 0, 0);
  const where = [], vals = [];

  if (o.username) { where.push('username_attempted = ?'); vals.push(o.username); }
  if (o.action)   { where.push('action = ?');             vals.push(o.action); }
  if (o.result)   { where.push('result = ?');             vals.push(o.result); }
  if (o.since)    { where.push('timestamp >= ?');         vals.push(o.since); }
  if (o.until)    { where.push('timestamp <= ?');         vals.push(o.until); }
  if (o.q) {
    /* LIKE with the wildcards supplied by us, never by the caller: the term is
     * escaped so a search for "100%" cannot turn into a table scan matching
     * everything, and ESCAPE makes that explicit to SQLite. */
    const term = '%' + String(o.q).replace(/[\\%_]/g, m => '\\' + m) + '%';
    where.push("(username_attempted LIKE ? ESCAPE '\\' OR ip_address LIKE ? ESCAPE '\\' " +
               "OR action LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\')");
    vals.push(term, term, term, term);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '';
  const total = d().prepare('SELECT COUNT(*) AS c FROM auth_log ' + clause).get(...vals).c;
  const rows = d().prepare(
    'SELECT id, timestamp, username_attempted, user_id, ip_address, user_agent, action, result, reason ' +
    'FROM auth_log ' + clause + 'ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(...vals, limit, offset).map(r => Object.assign({}, r, { timestamp: dbmod.toIsoUtc(r.timestamp) }));

  return { rows, total, limit, offset };
}

/** The action values actually present, so the filter offers real options only. */
function authLogActions() {
  return d().prepare('SELECT DISTINCT action FROM auth_log ORDER BY action').all().map(r => r.action);
}

/* ══════════════════════════════════════════════════════════════════
 * P4.6 — audit-trail integrity
 * ══════════════════════════════════════════════════════════════════ */

/** Every recorded rebuild of the chain, newest first. */
function listAuditAnchors(limit) {
  try {
    return d().prepare(
      'SELECT id, created_at, reason, actor, through_id, prev_head, new_head, rows_affected, key_fpr ' +
      'FROM audit_anchors ORDER BY id DESC LIMIT ?'
    ).all(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200))
     .map(a => Object.assign({}, a, { created_at: dbmod.toIsoUtc(a.created_at) }));
  } catch (e) { return []; }
}

/** The id through which rows were hashed retroactively, or null. */
function _auditBaselineThrough() {
  try {
    const row = d().prepare(
      "SELECT through_id FROM audit_anchors WHERE reason LIKE 'baseline:%' ORDER BY id LIMIT 1"
    ).get();
    return row ? row.through_id : null;
  } catch (e) { return null; }
}

/**
 * Verify the audit chain end to end.
 *
 * Reports the first broken row rather than a boolean, because "the log was
 * tampered with" and "the log was tampered with AT ROW 8 412, and everything
 * before it is intact" are very different findings for an investigator.
 *
 * Deliberately reads every row: a spot check would be trivially defeated by
 * editing something outside the sample. `durationMs` is reported so an operator
 * can see the cost as the table grows.
 */
function verifyAuditChain(opts) {
  const o = opts || {};
  const started = Date.now();
  const key = _chainKey();
  if (!key) {
    return {
      ok: false, available: false,
      error: 'chain key unavailable — integrity cannot be verified',
      rows: 0, verified: 0, durationMs: Date.now() - started,
    };
  }
  let rows = [];
  try {
    rows = d().prepare(
      'SELECT ' + chainmod.CHAINED_FIELDS.join(',') + ', prev_hash, row_hash ' +
      'FROM auth_log ORDER BY id' + (o.limit ? ' LIMIT ' + (parseInt(o.limit, 10) || 0) : '')
    ).all();
  } catch (e) {
    return { ok: false, available: false, error: String(e && e.message || e),
             rows: 0, verified: 0, durationMs: Date.now() - started };
  }

  const baselineThrough = _auditBaselineThrough();
  const report = chainmod.verifyChain(key, rows, { baselineThrough });
  const anchors = listAuditAnchors(20);

  return Object.assign(report, {
    available: true,
    keyFingerprint: chainmod.keyFingerprint(key),
    chainVersion: chainmod.VERSION,
    anchors,

    /* ── Why there is no "this break is explained" escape hatch ──
     *
     * The first version of this reported a break as benign when any recorded
     * anchor covered the row id, on the theory that a restore had rebuilt the
     * chain and said so. That reasoning is wrong, and dangerously so.
     *
     * A rebuild leaves the chain FULLY VERIFYING. So any break found afterwards
     * was necessarily introduced after the rebuild, and the anchor cannot account
     * for it — yet the heuristic matched on row id alone, which meant that on any
     * installation that had ever performed one restore, every subsequent genuine
     * tamper would be downgraded to "informational". The alarm would have been
     * disarmed by normal operation.
     *
     * There is no false positive to suppress: legitimate restores re-anchor
     * immediately (admin.restore), and rows written before chaining are counted
     * as `unhashed` rather than reported as edits. A break is a break.
     *
     * The field is retained, always false, so any caller still reading it gets
     * the safe answer instead of `undefined`. */
    brokenExplainedByAnchor: false,

    // Recent rebuilds are still worth surfacing — as their own fact, not as an
    // excuse for a broken chain.
    lastRebuild: anchors.length ? anchors[0] : null,
    durationMs: Date.now() - started,
  });
}

/**
 * Recompute the whole chain and record that it happened.
 *
 * Needed after a restore: P4.5 re-inserts preserved rows, which gives them new
 * ids, and ids are part of what each row hashes. Without a rebuild the chain
 * would read as tampered after every legitimate restore.
 *
 * The anchor row is what keeps this from being a laundering tool. It records who
 * rebuilt the chain, why, how many rows, and — crucially — the head hash from
 * BEFORE the rebuild, so an earlier verification result can still be tied to the
 * state it described.
 */
function reanchorAuditChain(reason, actor) {
  const key = _chainKey();
  if (!key) return { ok: false, error: 'chain key unavailable' };
  try {
    const prevHead = _chainHead();
    const rows = d().prepare(
      'SELECT ' + chainmod.CHAINED_FIELDS.join(',') + ' FROM auth_log ORDER BY id'
    ).all();
    if (!rows.length) return { ok: true, rows: 0, newHead: null };

    const links = chainmod.computeChain(key, rows, null);
    const upd = d().prepare('UPDATE auth_log SET prev_hash=?, row_hash=? WHERE id=?');
    d().exec('BEGIN');
    try {
      links.forEach(l => upd.run(l.prev_hash, l.row_hash, l.id));
      d().exec('COMMIT');
    } catch (e) {
      try { d().exec('ROLLBACK'); } catch (e2) {}
      throw e;
    }
    const newHead = links[links.length - 1].row_hash;
    const through = rows[rows.length - 1].id;
    d().prepare(
      'INSERT INTO audit_anchors (reason,actor,through_id,prev_head,new_head,rows_affected,key_fpr) ' +
      'VALUES (?,?,?,?,?,?,?)'
    ).run(String(reason || 'rebuild').slice(0, 200), actor || 'system', through,
          prevHead, newHead, links.length, chainmod.keyFingerprint(key));
    return { ok: true, rows: links.length, prevHead, newHead, throughId: through };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ── Security overview (Task 1) ────────────────────────────────────
 * Everything derivable from the database. Runtime facts the DB cannot know —
 * how many accounts the in-memory throttle is currently holding, when the last
 * backup file was written — are merged in by the API layer, which owns them.
 */
function securityOverview() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso   = _nowIso();
  const one = (sql, ...args) => d().prepare(sql).get(...args).c;

  const users        = one('SELECT COUNT(*) AS c FROM users');
  const totpUsers    = one('SELECT COUNT(*) AS c FROM users WHERE mfa_enabled=1');
  const passkeyUsers = one('SELECT COUNT(DISTINCT username) AS c FROM passkeys');
  const mfaUsers     = one(
    'SELECT COUNT(*) AS c FROM users u WHERE u.mfa_enabled=1 ' +
    'OR EXISTS (SELECT 1 FROM passkeys pk WHERE pk.username=u.username)');
  const passkeys     = one('SELECT COUNT(*) AS c FROM passkeys');
  const sessions     = one('SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?', nowIso);
  const sessionUsers = one('SELECT COUNT(DISTINCT username) AS c FROM sessions WHERE expires_at > ?', nowIso);
  const trusted      = one('SELECT COUNT(*) AS c FROM trusted_devices WHERE revoked_at IS NULL AND expires_at > ?', nowIso);
  const failed24h    = one("SELECT COUNT(*) AS c FROM auth_log WHERE action='LOGIN' AND result='FAILURE' AND timestamp >= ?", since24h);
  const failed7d     = one("SELECT COUNT(*) AS c FROM auth_log WHERE action='LOGIN' AND result='FAILURE' AND timestamp >= ?", since7d);
  const throttled24h = one("SELECT COUNT(*) AS c FROM auth_log WHERE result='LOCKED' AND timestamp >= ?", since24h);
  const denied24h    = one("SELECT COUNT(*) AS c FROM auth_log WHERE action='PERMISSION_DENIED' AND timestamp >= ?", since24h);
  const mustChange   = one('SELECT COUNT(*) AS c FROM users WHERE must_change_password=1');
  const recoveryLeft = one('SELECT COUNT(*) AS c FROM mfa_recovery_codes WHERE used_at IS NULL');

  /* Accounts that MUST hold a factor and do not. This is the one number on the
   * screen that describes an active hole rather than a statistic: every account
   * counted here can sign in to a privileged role with a password alone.
   * (In practice the server's enrolment gate stops them at the door — but the
   * account still exists in that state, and that is what wants fixing.) */
  const unenrolledPrivileged = d().prepare(
    'SELECT u.username FROM users u JOIN roles r ON r.id=u.role_id ' +
    "WHERE (r.mfa='required' OR u.mfa_required=1) AND u.mfa_enabled=0 " +
    'AND NOT EXISTS (SELECT 1 FROM passkeys pk WHERE pk.username=u.username)'
  ).all().map(r => r.username);

  const admins = one("SELECT COUNT(*) AS c FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='admin'");

  /* P4.6 — trail integrity, folded into the same payload the dashboard already
   * fetches. A separate request would have meant the overview could show a clean
   * risk score while the integrity check was still pending, which is the one
   * combination that must never appear. */
  let integrity = null;
  try {
    const v = verifyAuditChain();
    integrity = {
      available: v.available !== false,
      ok: !!v.ok,
      rows: v.rows,
      verified: v.verified,
      brokenAtId: v.brokenAtId,
      brokenReason: v.brokenReason,
      brokenExplainedByAnchor: false,      // retained for older callers; see verifyAuditChain
      unhashed: v.unhashed,
      baselineThrough: v.baselineThrough,
      keyFingerprint: v.keyFingerprint,
      /* How long ago the chain was last rebuilt, in days, when that was recent.
       * A rebuild rewrites every hash, so it belongs on the dashboard as an event
       * in its own right — not as a reason to ignore a broken chain. */
      rebuiltRecently: (() => {
        const a = v.lastRebuild;
        if (!a || !a.created_at) return null;
        const days = Math.floor((Date.now() - Date.parse(a.created_at)) / 86400000);
        return Number.isFinite(days) && days <= 7 ? days : null;
      })(),
      lastRebuild: v.lastRebuild
        ? { at: v.lastRebuild.created_at, by: v.lastRebuild.actor, reason: v.lastRebuild.reason }
        : null,
      durationMs: v.durationMs,
    };
  } catch (e) { integrity = { available: false, ok: false, error: String(e && e.message || e) }; }

  return {
    integrity,
    users, admins,
    mfaUsers, totpUsers, passkeyUsers, passkeys,
    mfaCoverage: users ? Math.round((mfaUsers / users) * 100) : 0,
    sessions, sessionUsers,
    trustedDevices: trusted,
    failedLogins24h: failed24h, failedLogins7d: failed7d,
    throttled24h, permissionDenied24h: denied24h,
    mustChangePassword: mustChange,
    recoveryCodesRemaining: recoveryLeft,
    unenrolledPrivileged,
  };
}

/**
 * Turn the overview into a level and a list of findings.
 *
 * Deliberately deterministic and pure: same input, same output, no clock, no
 * database. That is what makes it testable — and a risk indicator nobody can
 * reproduce is decoration, not a control.
 *
 * `extra` carries the runtime facts from the API layer:
 *   { lockedAccounts, lastBackupAgeDays, passwordPolicy }
 */
function assessRisk(overview, extra) {
  const o = overview || {}, x = extra || {};
  const findings = [];
  let score = 100;
  /* Some findings are not just heavy — they are categorically disqualifying, and
   * no amount of good posture elsewhere offsets them. `decisive` marks those:
   * they set the level directly instead of relying on the score crossing a
   * threshold. Without it a single tampered audit trail scored 70/100 and read
   * as "warning", which is exactly the wrong summary for "the security record
   * cannot be trusted". */
  let decisiveLevel = null;
  const add = (level, key, weight, detail, decisive) => {
    findings.push({ level, key, detail: detail == null ? null : String(detail) });
    score -= weight;
    if (decisive) decisiveLevel = 'critical';
  };

  const unenrolled = (o.unenrolledPrivileged || []).length;
  if (unenrolled) add('critical', 'mfa_unenrolled_privileged', 8 * Math.min(unenrolled, 4), unenrolled);
  if (o.users && o.mfaCoverage < 50) add('warning', 'mfa_coverage_low', 10, o.mfaCoverage + '%');
  else if (o.users && o.mfaCoverage < 80) add('info', 'mfa_coverage_partial', 3, o.mfaCoverage + '%');

  if (o.admins === 1) add('warning', 'single_admin', 6, o.admins);
  if (o.admins > 4) add('info', 'many_admins', 4, o.admins);

  if (o.failedLogins24h > 50) add('critical', 'failed_logins_high', 12, o.failedLogins24h);
  else if (o.failedLogins24h > 15) add('warning', 'failed_logins_elevated', 6, o.failedLogins24h);

  if (x.lockedAccounts > 0) add('warning', 'accounts_locked', 4, x.lockedAccounts);
  if (o.mustChangePassword > 0) add('info', 'pending_password_change', 2, o.mustChangePassword);
  if (o.permissionDenied24h > 20) add('warning', 'permission_denied_spike', 5, o.permissionDenied24h);

  if (x.lastBackupAgeDays == null) add('warning', 'no_backup', 8);
  else if (x.lastBackupAgeDays > 7) add('warning', 'backup_stale', 6, x.lastBackupAgeDays);
  else if (x.lastBackupAgeDays > 3) add('info', 'backup_ageing', 2, x.lastBackupAgeDays);

  const pol = x.passwordPolicy;
  if (pol) {
    if (!pol.historyDepth) add('info', 'no_password_history', 2);
    if (pol.minLength < 12) add('warning', 'password_min_length_low', 5, pol.minLength);
  }

  /* ── Audit-trail integrity (P4.6) ──
   * An UNEXPLAINED break is the most serious finding this system can produce: it
   * means the security record itself is not trustworthy, so every other number
   * on the page is suspect. It therefore carries the largest single weight —
   * enough on its own to drag any posture out of "good".
   *
   * A break that a recorded rebuild accounts for is a different matter: a
   * restore did it and said so. That is worth noticing, not alarming about. */
  /* Integrity is a runtime fact like the others, so it arrives in `extra`; the
   * fallback to the overview keeps the call simple for callers that already
   * fetched it there. Reading only the overview made the parameter silently
   * ignored — the findings below never fired when integrity was passed the way
   * every other fact in this function is. */
  const ig = x.integrity || o.integrity;
  if (ig) {
    if (ig.available === false) add('warning', 'audit_chain_unavailable', 10);
    else if (!ig.ok) {
      /* Decisive, with no exceptions. The trail is the evidence every other
       * number here rests on, and a rebuild never leaves a broken chain — so a
       * break has no innocent explanation. See verifyAuditChain for why the
       * "explained by an anchor" downgrade was removed. */
      add('critical', 'audit_chain_broken', 30, ig.brokenAtId, true);
    }
    if (ig.ok && ig.unhashed > 0) add('info', 'audit_rows_unhashed', 3, ig.unhashed);
    /* A rebuild is a legitimate but notable event: it rewrote every hash. Worth
     * a line on the dashboard so it does not pass unnoticed, separate from the
     * question of whether the chain currently verifies. */
    if (ig.rebuiltRecently) add('info', 'audit_chain_rebuilt', 2, ig.rebuiltRecently);
  }
  if (x.backupVerified === false) add('warning', 'backup_unverified', 6);

  score = Math.max(0, Math.min(100, score));
  const scored = score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 50 ? 'warning' : 'critical';
  // A decisive finding overrides the arithmetic; the score is still reported, so
  // an operator can see both the number and why it is not the whole story.
  return { score, level: decisiveLevel || scored, findings };
}

/* ── MFA administration (Task 3) ───────────────────────────────────
 * Per-account enrolment state. Counts only — no device names, no IPs.
 */
function mfaOverview() {
  const users = listUsersAdmin();
  const trusted = {};
  d().prepare(
    'SELECT username, COUNT(*) AS c FROM trusted_devices ' +
    'WHERE revoked_at IS NULL AND expires_at > ? GROUP BY username'
  ).all(_nowIso()).forEach(r => { trusted[r.username] = r.c; });
  const codes = {};
  d().prepare(
    'SELECT username, COUNT(*) AS c FROM mfa_recovery_codes WHERE used_at IS NULL GROUP BY username'
  ).all().forEach(r => { codes[r.username] = r.c; });

  const rows = users.map(u => Object.assign({}, u, {
    trustedDevices: trusted[u.username] || 0,
    recoveryCodes:  codes[u.username] || 0,
  }));
  return {
    enrolled:   rows.filter(u => u.hasFactor),
    unenrolled: rows.filter(u => !u.hasFactor),
    policy:     policyMod.mfaPolicy(),
  };
}

/**
 * Force (or release) a per-account MFA requirement.
 *
 * Releasing only ever clears the ACCOUNT-level flag; a role that demands MFA
 * still demands it afterwards. There is no code path here that lets an
 * administrator switch enforcement off for a privileged account.
 */
function setUserMfaRequired(username, required, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id, role FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  d().prepare('UPDATE users SET mfa_required=? WHERE username=?').run(required ? 1 : null, username);
  /* Revoke sessions when enrolment is newly demanded: the gate is evaluated per
   * request, but a signed-in user would otherwise keep working until their
   * session happened to end. "Force" has to mean now. */
  if (required) deleteUserSessions(username);
  logAuth(required ? 'MFA_ENABLED' : 'MFA_DISABLED', 'SUCCESS', {
    username: username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: (required ? 'enrolment forced' : 'account-level enforcement cleared (role policy still applies)') +
            ' by=' + (c.actor || 'system'),
  });
  return 'ok';
}

/**
 * Clear every second factor on an account and make it enrol again.
 * The administrative answer to "my phone is gone" — the same effect as the
 * npm run mfa-reset script, reachable by an operator holding mfa.enforce.
 */
function resetUserMfa(username, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return 'missing';
  d().prepare('UPDATE users SET mfa_enabled=0, mfa_secret=NULL, mfa_enrolled_at=NULL, mfa_last_counter=NULL WHERE username=?').run(username);
  d().prepare('DELETE FROM passkeys WHERE username=?').run(username);
  d().prepare('DELETE FROM mfa_recovery_codes WHERE username=?').run(username);
  d().prepare("UPDATE trusted_devices SET revoked_at=datetime('now') WHERE username=? AND revoked_at IS NULL").run(username);
  deleteUserSessions(username);
  logAuth('MFA_DISABLED', 'SUCCESS', {
    username: username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'administrative reset (factors, recovery codes, trusted devices and sessions cleared) by=' + (c.actor || 'system'),
  });
  return 'ok';
}

/** Sign an account out everywhere. Counts, then revokes — no device detail. */
function adminRevokeUserSessions(username, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return { status: 'missing', revoked: 0 };
  const n = d().prepare('SELECT COUNT(*) AS c FROM sessions WHERE username=?').get(username).c;
  deleteUserSessions(username);
  logAuth('LOGOUT_ALL', 'SUCCESS', {
    username: username, userId: u.id, ip: c.ip, userAgent: c.userAgent,
    reason: 'revoked ' + n + ' session(s) by administrator ' + (c.actor || 'system'),
  });
  return { status: 'ok', revoked: n };
}

/** Revoke every "remember this device" token an account holds. */
function adminRevokeUserTrusted(username, ctx) {
  const c = ctx || {};
  const u = d().prepare('SELECT id FROM users WHERE username=?').get(username);
  if (!u) return { status: 'missing', revoked: 0 };
  const n = revokeAllTrustedDevices(username, Object.assign({}, c, { actor: c.actor }));
  return { status: 'ok', revoked: n };
}

/* ── Active sessions, in aggregate (Task 5) ────────────────────────
 * Per-account counts and a last-seen timestamp; never the device list. An
 * administrator needs to know that an account is signed in on four devices and
 * to be able to end that — not to know which four.
 */
function sessionsSummary() {
  const now = _nowIso();
  return d().prepare(
    'SELECT s.username, COUNT(*) AS sessions, MAX(s.last_seen) AS last_seen, ' +
    '       MIN(s.created_at) AS oldest, u.name, u.role, r.key AS role_key, r.name AS role_name ' +
    'FROM sessions s LEFT JOIN users u ON u.username=s.username ' +
    'LEFT JOIN roles r ON r.id=u.role_id ' +
    'WHERE s.expires_at > ? GROUP BY s.username ORDER BY COUNT(*) DESC, s.username'
  ).all(now).map(r => ({
    username: r.username,
    name: r.name || r.username,
    role: r.role_key || r.role,
    roleName: r.role_name || r.role,
    sessions: r.sessions,
    lastSeen: dbmod.toIsoUtc(r.last_seen),
    oldest:   dbmod.toIsoUtc(r.oldest),
  }));
}

/* ── System health (Task 9) ────────────────────────────────────────
 * Row counts and integrity, all cheap. The storage and process figures live in
 * admin.js / the API layer, which own the filesystem and the process.
 */
function systemStats() {
  const one = (sql) => { try { return d().prepare(sql).get().c; } catch (e) { return null; } };
  return {
    users:      one('SELECT COUNT(*) AS c FROM users'),
    employees:  one('SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NULL'),
    groups:     one('SELECT COUNT(*) AS c FROM groups WHERE deleted_at IS NULL'),
    documents:  one('SELECT COUNT(*) AS c FROM documents'),
    passports:  one('SELECT COUNT(*) AS c FROM passports'),
    sessions:   one('SELECT COUNT(*) AS c FROM sessions'),
    auditRows:  one('SELECT COUNT(*) AS c FROM auth_log'),
    trashed:    one('SELECT COUNT(*) AS c FROM employees WHERE deleted_at IS NOT NULL'),
    roles:      one('SELECT COUNT(*) AS c FROM roles'),
    permissions:one('SELECT COUNT(*) AS c FROM permissions'),
  };
}

/** SQLite's own health check plus the pragmas an operator asks about. */
function databaseStatus() {
  const pragma = (name) => {
    try {
      const row = d().prepare('PRAGMA ' + name).get();
      return row ? Object.values(row)[0] : null;
    } catch (e) { return null; }
  };
  let integrity = 'unknown';
  try {
    // quick_check, not integrity_check: same failure detection for our purposes
    // at a fraction of the cost, so this is safe to run on a page load.
    const r = d().prepare('PRAGMA quick_check(1)').get();
    integrity = r ? String(Object.values(r)[0]) : 'unknown';
  } catch (e) { integrity = 'error: ' + (e && e.message || e); }

  return {
    integrity,
    ok: integrity === 'ok',
    journalMode:   pragma('journal_mode'),
    pageSize:      pragma('page_size'),
    pageCount:     pragma('page_count'),
    freelistCount: pragma('freelist_count'),
    foreignKeys:   pragma('foreign_keys'),
    userVersion:   pragma('user_version'),
    walAutocheckpoint: pragma('wal_autocheckpoint'),
  };
}

/* ── Role administration (Task 7) ──────────────────────────────────
 * Custom roles only, and that restriction is structural rather than a policy
 * choice: db.seedRbac() rewrites every SYSTEM role's grants from rbac.js on each
 * boot, so an edit to one would be silently reverted at the next restart. A
 * control that appears to work and does not is worse than one that refuses, so
 * the API refuses.
 */
function createRole(def, opts) {
  const o = opts || {};
  const key = String(def.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!key || key.length < 2) return 'invalid-key';
  if (d().prepare('SELECT id FROM roles WHERE key=?').get(key)) return 'dup';

  /* `|| 100` would be wrong here: rank 0 is falsy, and 0 is precisely the value
   * an attacker would send to mint a role as powerful as Admin. A missing rank
   * defaults to 100; a supplied 0 is clamped to 1 and then refused by the rank
   * check below, rather than being quietly rewritten to something harmless. */
  const asked = parseInt(def.rank, 10);
  const rank = Math.max(1, Math.min(999, Number.isFinite(asked) ? asked : 100));
  /* The rank invariant applies to CREATING a role as much as to assigning one:
   * an actor who could mint a rank-0 role could then assign themselves to it. */
  if (o.actorRank != null && !rbac.canAssignRole(o.actorRank, rank)) return 'rank-violation';

  const mfa = def.mfa === 'optional' ? 'optional' : 'required';
  d().prepare(
    'INSERT INTO roles (key,name,description,rank,mfa,is_system,is_legacy) VALUES (?,?,?,?,?,0,0)'
  ).run(key, String(def.name || key).slice(0, 60), String(def.description || '').slice(0, 300), rank, mfa);

  if (Array.isArray(def.permissions)) setRolePermissions(key, def.permissions, o);
  logAuth('ROLE_PERMISSION_CHANGE', 'SUCCESS', {
    username: o.actor, ip: o.ip, userAgent: o.userAgent,
    reason: 'created role ' + key + ' rank=' + rank + ' mfa=' + mfa,
  });
  return 'ok';
}

function updateRole(key, patch, opts) {
  const o = opts || {};
  const row = d().prepare('SELECT id, key, is_system, rank FROM roles WHERE key=?').get(String(key || '').toLowerCase());
  if (!row) return 'missing';
  const p = patch || {};
  const cols = [], vals = [];

  if (typeof p.name === 'string' && !row.is_system)        { cols.push('name=?'); vals.push(p.name.slice(0, 60)); }
  if (typeof p.description === 'string' && !row.is_system) { cols.push('description=?'); vals.push(p.description.slice(0, 300)); }
  if (p.rank != null && !row.is_system) {
    const rank = Math.max(1, Math.min(999, parseInt(p.rank, 10) || 100));
    if (o.actorRank != null && !rbac.canAssignRole(o.actorRank, rank)) return 'rank-violation';
    cols.push('rank=?'); vals.push(rank);
  }
  /* mfa is editable on system roles too — tightening enrolment is exactly what
   * Security → MFA Policy is for. policy.setMfaPolicy() owns the direction rule
   * (it may only tighten) and persists the choice so seedRbac cannot undo it. */
  if (p.mfa === 'required' || p.mfa === 'optional') {
    const applied = policyMod.setMfaPolicy({ [row.key]: p.mfa });
    if (applied[row.key] !== p.mfa && row.is_system) return 'mfa-locked';
    if (applied[row.key] === undefined) { cols.push('mfa=?'); vals.push(p.mfa); }
  }
  if (cols.length) {
    vals.push(row.id);
    d().prepare('UPDATE roles SET ' + cols.join(',') + ' WHERE id=?').run(...vals);
  }
  logAuth('ROLE_PERMISSION_CHANGE', 'SUCCESS', {
    username: o.actor, ip: o.ip, userAgent: o.userAgent,
    reason: 'updated role ' + row.key + ' ' + JSON.stringify(p).slice(0, 160),
  });
  return 'ok';
}

/** Replace a custom role's grants wholesale. `grants` = [[permissionKey, scope]]. */
function setRolePermissions(key, grants, opts) {
  const o = opts || {};
  const row = d().prepare('SELECT id, key, is_system FROM roles WHERE key=?').get(String(key || '').toLowerCase());
  if (!row) return 'missing';
  if (row.is_system) return 'system-role';

  const permId = d().prepare('SELECT id FROM permissions WHERE key=?');
  const wanted = [];
  (grants || []).forEach(g => {
    const [pk, scope] = Array.isArray(g) ? g : [g, 'all'];
    const p = permId.get(String(pk));
    if (!p) return;                                    // unknown key ⇒ ignored, never granted
    const s = ['all', 'team', 'own'].includes(scope) ? scope : 'all';
    wanted.push([p.id, s]);
  });

  /* All-or-nothing. The DELETE strips the role of every permission, so a failure
   * between it and the INSERTs would leave the role holding nothing at all —
   * a silent, total revocation. node:sqlite has no transaction() helper, so the
   * statements are issued directly, matching the idiom used elsewhere here. */
  const conn = d();
  conn.exec('BEGIN');
  try {
    conn.prepare('DELETE FROM role_permissions WHERE role_id=?').run(row.id);
    const ins = conn.prepare('INSERT INTO role_permissions (role_id,permission_id,scope) VALUES (?,?,?)');
    wanted.forEach(([pid, s]) => ins.run(row.id, pid, s));
    conn.exec('COMMIT');
  } catch (e) {
    try { conn.exec('ROLLBACK'); } catch (e2) {}
    throw e;
  }

  logAuth('ROLE_PERMISSION_CHANGE', 'SUCCESS', {
    username: o.actor, ip: o.ip, userAgent: o.userAgent,
    reason: 'set ' + wanted.length + ' grant(s) on role ' + row.key + ' by=' + (o.actor || 'system'),
  });
  return 'ok';
}

function deleteRole(key, opts) {
  const o = opts || {};
  const row = d().prepare('SELECT id, key, is_system FROM roles WHERE key=?').get(String(key || '').toLowerCase());
  if (!row) return 'missing';
  if (row.is_system) return 'system-role';
  // Deleting a role that accounts still hold would strip them of every
  // permission at once (role_id goes dangling), so it is refused outright.
  const holders = d().prepare('SELECT COUNT(*) AS c FROM users WHERE role_id=?').get(row.id).c;
  if (holders) return 'role-in-use';

  d().prepare('DELETE FROM roles WHERE id=?').run(row.id);   // grants cascade
  logAuth('ROLE_PERMISSION_CHANGE', 'SUCCESS', {
    username: o.actor, ip: o.ip, userAgent: o.userAgent,
    reason: 'deleted role ' + row.key,
  });
  return 'ok';
}

module.exports = {
  getBootstrap, countEmployees,
  createGroup, updateGroup, deleteGroup,
  addEmployee, updateEmployee, deleteEmployee,
  softDeleteEmployee, softDeleteGroup, restoreEmployee, restoreGroup, listTrash, emptyTrash,
  addCity, deleteCity, addUser, deleteUser, updateUser, login, importAll,
  changeOwnPassword,
  getUserPublic,
  createSession, sessionUser, resolveSession, deleteSession, deleteUserSessions, purgeExpiredSessions,
  listSessions, revokeSession, logoutAllSessions, SESSION_POLICY, ABSOLUTE_MAX_MS, policyFor,
  ensureCsrfToken, verifyCsrfToken,
  // RBAC
  getPermissions, getRole, listRoles, listPermissions, getPermissionMatrix,
  getTeamGroupIds, getEmployeeOwner, getGroupOwner, setUserRole,
  // P3 — MFA
  mfaPolicyFor, MFA_POLICY, getMfaStatus,
  beginTotpEnrolment, confirmTotpEnrolment, verifyTotp, disableMfa,
  regenerateRecoveryCodes, useRecoveryCode,
  addPasskey, listPasskeys, deletePasskey, getPasskeyByCredentialId,
  listPasskeyCredentialIds, touchPasskey,
  trustDevice, isDeviceTrusted, listTrustedDevices, revokeTrustedDevice, revokeAllTrustedDevices,
  listDocuments, addDocument, deleteDocument,
  getActivity, getGroupActivity, getSettings, setSetting,
  logAuth, getAuthLog,
  // P4 — administration centre
  listUsersAdmin, queryAuthLog, authLogActions,
  securityOverview, assessRisk, mfaOverview,
  setUserMfaRequired, resetUserMfa, adminRevokeUserSessions, adminRevokeUserTrusted,
  sessionsSummary, systemStats, databaseStatus,
  createRole, updateRole, setRolePermissions, deleteRole,
  // P4.6 — audit-trail integrity
  verifyAuditChain, reanchorAuditChain, listAuditAnchors,
};
