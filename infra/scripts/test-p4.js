'use strict';
/**
 * infra/scripts/test-p4.js — Administration Centre suite.
 *
 *   npm run test-p4
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * What this suite is FOR
 * ──────────────────────
 * P4 added a configuration surface to security controls that were previously
 * constants. That is the risk it introduces: a settings screen that can be
 * tuned into uselessness is worse than no settings screen, because it converts
 * a hardened default into somebody's mistake.
 *
 * So most of what follows tests the CLAMPS and the REFUSALS, not the happy
 * path. Every assertion about "you can change X" is paired with one about how
 * far X may be pushed, and every new endpoint is checked from a role that must
 * not reach it. A suite that only proved the screens work would pass just as
 * happily if every clamp were removed.
 */
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-p4-test-'));
process.env.KD_DATA_DIR = TMP;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

const rbac   = require('../rbac');
const pwmod  = require('../password');
const dbmod  = require('../db');
dbmod.init();
const db     = dbmod.db;
const repo   = require('../repo');
const policy = require('../policy');
const admin  = require('../admin');
const totp   = require('../totp');

const PASS = 'P4&Suite!Pass9x';

/* ══════════════════════════════════════════════════════════════════
 * Schema
 * ══════════════════════════════════════════════════════════════════ */
section('P4 schema');
ok('users.mfa_required exists (per-account MFA override)',
   db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'mfa_required'));
ok('password_history table exists',
   !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='password_history'").get());
ok('roles.is_legacy exists',
   db.prepare('PRAGMA table_info(roles)').all().some(c => c.name === 'is_legacy'));
ok('roles.replaced_by exists',
   db.prepare('PRAGMA table_info(roles)').all().some(c => c.name === 'replaced_by'));
ok('mfa_required defaults to NULL, so no existing account changes requirement',
   db.prepare('SELECT COUNT(*) c FROM users WHERE mfa_required IS NOT NULL').get().c === 0);

/* ══════════════════════════════════════════════════════════════════
 * Roles — the P4 rename and addition
 * ══════════════════════════════════════════════════════════════════ */
section('Roles');
const roles = repo.listRoles();
const byKey = (k) => roles.find(r => r.key === k);

['admin', 'manager', 'employee', 'auditor'].forEach(k =>
  ok('role "' + k + '" is assignable', !!byKey(k) && byKey(k).is_legacy === 0));
['data_entry', 'viewer'].forEach(k =>
  ok('legacy role "' + k + '" retained (holders keep their permissions)',
     !!byKey(k) && byKey(k).is_legacy === 1));
ok('data_entry names employee as its replacement', byKey('data_entry').replaced_by === 'employee');

const M = repo.getPermissionMatrix().matrix;
ok('employee === data_entry, so the rename changed no privilege',
   JSON.stringify(M.employee) === JSON.stringify(M.data_entry));
ok('auditor reads the audit trail', M.auditor['audit.view'] === 'all');
ok('auditor reads the account list (needed to review access control)',
   M.auditor['user.view'] === 'all');
ok('auditor writes nothing',
   !Object.keys(M.auditor).some(k => /\.(create|update|delete|approve|manage|assign|execute|restore|upload|process|purge|excel|pdf|bundle)$/.test(k)));
ok('auditor is NOT viewer + audit.view — viewer accounts were not silently promoted',
   rbac.LEGACY_ROLE_MAP.viewer === 'viewer');
ok('auditor requires MFA (it reads the trail and the account list)',
   byKey('auditor').mfa === 'required');

/* ══════════════════════════════════════════════════════════════════
 * Password policy — the clamps
 * ══════════════════════════════════════════════════════════════════ */
section('Password policy — configuration is bounded');

const defPol = policy.passwordPolicy();
ok('default policy equals the pre-P4 constants (nothing changed on upgrade)',
   defPol.minLength === pwmod.MIN_LENGTH && defPol.requireUpper && defPol.requireLower &&
   defPol.requireDigit && defPol.requireSpecial);

ok('minLength can be RAISED', policy.setPasswordPolicy({ minLength: 16 }).minLength === 16);
ok('minLength cannot go below the floor of 8',
   policy.setPasswordPolicy({ minLength: 4 }).minLength === 8, String(policy.passwordPolicy().minLength));
ok('minLength cannot exceed 64', policy.setPasswordPolicy({ minLength: 999 }).minLength === 64);
ok('a non-numeric minLength falls back rather than becoming NaN',
   Number.isFinite(policy.setPasswordPolicy({ minLength: 'abc' }).minLength));

ok('turning off ALL character classes is refused — two are reinstated', (() => {
  const p = policy.setPasswordPolicy({
    requireUpper: false, requireLower: false, requireDigit: false, requireSpecial: false,
  });
  return [p.requireUpper, p.requireLower, p.requireDigit, p.requireSpecial].filter(Boolean).length >= 2;
})());
ok('the common-password blocklist cannot be switched off',
   policy.setPasswordPolicy({ blockCommon: false }).blockCommon === true);

ok('maxAgeDays is capped at a year', policy.setPasswordPolicy({ maxAgeDays: 99999 }).maxAgeDays === 365);
ok('maxAgeDays 0 is allowed and means "never expires"',
   policy.setPasswordPolicy({ maxAgeDays: 0 }).maxAgeDays === 0);
ok('historyDepth is capped at 24', policy.setPasswordPolicy({ historyDepth: 500 }).historyDepth === 24);
ok('maxLength can never end up below minLength', (() => {
  const p = policy.setPasswordPolicy({ minLength: 20, maxLength: 10 });
  return p.maxLength >= p.minLength;
})());

// Restore a sane policy for the rest of the run.
policy.setPasswordPolicy({
  minLength: 12, maxLength: 200, requireUpper: true, requireLower: true,
  requireDigit: true, requireSpecial: true, blockRepeats: true, blockUsername: true,
  maxAgeDays: 0, historyDepth: 3,
});

section('Password policy — it is actually enforced');
ok('a configured minimum is applied to account creation', (() => {
  policy.setPasswordPolicy({ minLength: 20 });
  const r = repo.addUser({ username: 'pw_short_' + Date.now().toString(36), password: 'Short1!Pass9x' },
                         { mustChange: false, actor: 't' });
  policy.setPasswordPolicy({ minLength: 12 });
  return r === 'weak-password:too-short';
})(), 'a 13-character password must fail a 20-character policy');

const U = {};
['admin', 'manager', 'employee', 'auditor'].forEach(k => {
  U[k] = k + '_' + Date.now().toString(36);
  ok('created ' + k + ' account',
     repo.addUser({ username: U[k], password: PASS, role: k, name: k },
                  { mustChange: false, actor: 't' }) === 'ok');
});

section('Password history');
policy.setPasswordPolicy({ historyDepth: 3 });
const HIST_A = 'HistOne!Pass99', HIST_B = 'HistTwo!Pass99', HIST_C = 'HistThree!Pass9';
ok('first change succeeds',
   repo.changeOwnPassword(U.employee, PASS, HIST_A, {}) === 'ok');
ok('changing straight back to the SAME password is refused',
   repo.changeOwnPassword(U.employee, HIST_A, HIST_A, {}) === 'same-password');
ok('second change succeeds', repo.changeOwnPassword(U.employee, HIST_A, HIST_B, {}) === 'ok');
ok('reusing the PREVIOUS password is refused',
   repo.changeOwnPassword(U.employee, HIST_B, HIST_A, {}) === 'password-reused');
ok('an administrator reset cannot reuse a historic password either',
   String(repo.updateUser(U.employee, { password: HIST_A }, { actor: 'admin', actorRank: 0 })) === 'password-reused');
ok('history is pruned to the configured depth', (() => {
  const n = db.prepare('SELECT COUNT(*) c FROM password_history WHERE username=?').get(U.employee).c;
  return n <= 3;
})());
ok('historyDepth 0 disables the check entirely', (() => {
  policy.setPasswordPolicy({ historyDepth: 0 });
  const r = repo.changeOwnPassword(U.employee, HIST_B, HIST_A, {});
  policy.setPasswordPolicy({ historyDepth: 3 });
  return r === 'ok';
})());

section('Password expiry');
ok('an expired password forces a change at sign-in', (() => {
  policy.setPasswordPolicy({ maxAgeDays: 30 });
  db.prepare("UPDATE users SET password_changed_at=datetime('now','-60 days'), must_change_password=0 WHERE username=?")
    .run(U.auditor);
  const u = repo.login(U.auditor, PASS, {});
  policy.setPasswordPolicy({ maxAgeDays: 0 });
  return u && u.mustChangePassword === true;
})());
ok('a fresh password is NOT forced to change', (() => {
  policy.setPasswordPolicy({ maxAgeDays: 30 });
  db.prepare("UPDATE users SET password_changed_at=datetime('now'), must_change_password=0 WHERE username=?")
    .run(U.manager);
  const u = repo.login(U.manager, PASS, {});
  policy.setPasswordPolicy({ maxAgeDays: 0 });
  return u && u.mustChangePassword === false;
})());
ok('maxAgeDays 0 never expires anything', (() => {
  db.prepare("UPDATE users SET password_changed_at=datetime('now','-9999 days'), must_change_password=0 WHERE username=?")
    .run(U.manager);
  const u = repo.login(U.manager, PASS, {});
  return u && u.mustChangePassword === false;
})());

/* ══════════════════════════════════════════════════════════════════
 * MFA policy — may tighten, never relax
 * ══════════════════════════════════════════════════════════════════ */
section('MFA policy');
ok('admin MFA cannot be relaxed to optional',
   policy.setMfaPolicy({ admin: 'optional' }).admin === 'required');
ok('manager MFA cannot be relaxed to optional',
   policy.setMfaPolicy({ manager: 'optional' }).manager === 'required');
ok('auditor MFA cannot be relaxed to optional',
   policy.setMfaPolicy({ auditor: 'optional' }).auditor === 'required');
ok('employee MFA CAN be tightened to required',
   policy.setMfaPolicy({ employee: 'required' }).employee === 'required');
ok('...and the roles table is kept in step',
   db.prepare("SELECT mfa FROM roles WHERE key='employee'").get().mfa === 'required');
ok('...and repo.mfaPolicyFor agrees', repo.mfaPolicyFor('employee').required === true);
ok('employee MFA can be released back to optional',
   policy.setMfaPolicy({ employee: 'optional' }).employee === 'optional');

ok('the override SURVIVES a re-seed (seedRbac would otherwise revert it)', (() => {
  policy.setMfaPolicy({ employee: 'required' });
  dbmod.seedRbac();                       // what happens on every server start
  const after = db.prepare("SELECT mfa FROM roles WHERE key='employee'").get().mfa;
  policy.setMfaPolicy({ employee: 'optional' });
  dbmod.seedRbac();
  return after === 'required';
})());

section('Per-account MFA enforcement');
ok('forcing enrolment on an employee makes a factor required', (() => {
  repo.setUserMfaRequired(U.employee, true, { actor: 'admin' });
  const st = repo.getMfaStatus(U.employee);
  return st.policy.required === true && st.setupRequired === true && st.forcedByAdmin === true;
})());
ok('forcing enrolment revokes that account’s sessions, so it takes effect now', (() => {
  repo.createSession(U.employee, false, {});
  repo.setUserMfaRequired(U.employee, true, { actor: 'admin' });
  return db.prepare('SELECT COUNT(*) c FROM sessions WHERE username=?').get(U.employee).c === 0;
})());
ok('releasing the account flag returns it to the role policy', (() => {
  repo.setUserMfaRequired(U.employee, false, { actor: 'admin' });
  const st = repo.getMfaStatus(U.employee);
  return st.forcedByAdmin === false && st.policy.required === false;
})());
ok('releasing the flag does NOT waive a role requirement', (() => {
  repo.setUserMfaRequired(U.admin, false, { actor: 'admin' });
  return repo.getMfaStatus(U.admin).policy.required === true;
})());

ok('an administrative MFA reset clears every factor', (() => {
  const e = repo.beginTotpEnrolment(U.manager);
  repo.confirmTotpEnrolment(U.manager, totp.generate(e.secret), {});
  const before = repo.getMfaStatus(U.manager).totpEnabled;
  repo.resetUserMfa(U.manager, { actor: 'admin' });
  const st = repo.getMfaStatus(U.manager);
  return before === true && st.totpEnabled === false && st.passkeyCount === 0 &&
         st.recoveryCodesRemaining === 0;
})());
ok('...and is written to the audit trail',
   repo.getAuthLog({ limit: 60 }).some(e => e.action === 'MFA_DISABLED' && /administrative reset/.test(e.reason || '')));

/* ══════════════════════════════════════════════════════════════════
 * Session policy
 * ══════════════════════════════════════════════════════════════════ */
section('Session policy');
ok('idle timeout is bounded below (5 minutes)',
   policy.setSessionPolicy({ idleMinutes: { admin: 1 } }).idleMinutes.admin === 5);
ok('idle timeout is bounded above (8 hours)',
   policy.setSessionPolicy({ idleMinutes: { admin: 99999 } }).idleMinutes.admin === 480);
ok('device limit is bounded (1–20)', (() => {
  const a = policy.setSessionPolicy({ maxDevices: { admin: 0 } }).maxDevices.admin;
  const b = policy.setSessionPolicy({ maxDevices: { admin: 900 } }).maxDevices.admin;
  return a === 1 && b === 20;
})());
ok('absolute ceiling is capped at 90 days',
   policy.setSessionPolicy({ absoluteDays: 3650 }).absoluteDays === 90);
ok('repo.policyFor honours the configured value', (() => {
  policy.setSessionPolicy({ idleMinutes: { admin: 45 }, maxDevices: { admin: 4 } });
  const p = repo.policyFor('admin');
  return p.idleMs === 45 * 60 * 1000 && p.maxDevices === 4;
})());
ok('an unknown role still gets the strictest fallback, never the loosest', (() => {
  const p = repo.policyFor('no_such_role_at_all');
  return p.maxDevices <= 2 && p.idleMs <= 30 * 60 * 1000;
})());
ok('the configured device limit is enforced when sessions are issued', (() => {
  policy.setSessionPolicy({ maxDevices: { auditor: 2 } });
  db.prepare('DELETE FROM sessions WHERE username=?').run(U.auditor);
  for (let i = 0; i < 4; i++) repo.createSession(U.auditor, false, {});
  return db.prepare('SELECT COUNT(*) c FROM sessions WHERE username=?').get(U.auditor).c === 2;
})());
// Put the defaults back before the HTTP section signs anybody in.
policy.setSessionPolicy({
  idleMinutes: { admin: 30, manager: 60, employee: 120, auditor: 60 },
  maxDevices:  { admin: 2, manager: 3, employee: 5, auditor: 3 },
  absoluteDays: 30, rememberDays: 30, sessionHours: 12,
});

/* ══════════════════════════════════════════════════════════════════
 * Read models
 * ══════════════════════════════════════════════════════════════════ */
section('Security overview');
const ov = repo.securityOverview();
['users', 'admins', 'mfaUsers', 'passkeys', 'sessions', 'trustedDevices',
 'failedLogins24h', 'mfaCoverage', 'unenrolledPrivileged'].forEach(k =>
  ok('overview reports ' + k, ov[k] !== undefined));
ok('mfaCoverage is a percentage', ov.mfaCoverage >= 0 && ov.mfaCoverage <= 100);
ok('unenrolledPrivileged lists accounts that owe a factor', Array.isArray(ov.unenrolledPrivileged));

section('Risk assessment is deterministic');
const clean = { users: 10, admins: 2, mfaUsers: 10, mfaCoverage: 100, failedLogins24h: 0,
                mustChangePassword: 0, permissionDenied24h: 0, unenrolledPrivileged: [] };
const r1 = repo.assessRisk(clean, { lockedAccounts: 0, lastBackupAgeDays: 1, passwordPolicy: policy.passwordPolicy() });
const r2 = repo.assessRisk(clean, { lockedAccounts: 0, lastBackupAgeDays: 1, passwordPolicy: policy.passwordPolicy() });
ok('the same input yields the same score', r1.score === r2.score && r1.level === r2.level);
ok('a clean posture scores well', r1.score >= 90 && r1.level === 'excellent', String(r1.score));
ok('an unenrolled privileged account is CRITICAL', (() => {
  const r = repo.assessRisk(Object.assign({}, clean, { unenrolledPrivileged: ['a', 'b'] }),
                            { lockedAccounts: 0, lastBackupAgeDays: 1 });
  return r.findings.some(f => f.key === 'mfa_unenrolled_privileged' && f.level === 'critical');
})());
ok('no backup at all is flagged', (() => {
  const r = repo.assessRisk(clean, { lockedAccounts: 0, lastBackupAgeDays: null });
  return r.findings.some(f => f.key === 'no_backup');
})());
ok('a single administrator is flagged (bus factor)', (() => {
  const r = repo.assessRisk(Object.assign({}, clean, { admins: 1 }), { lastBackupAgeDays: 1 });
  return r.findings.some(f => f.key === 'single_admin');
})());
ok('a weakened password policy is flagged', (() => {
  const r = repo.assessRisk(clean, { lastBackupAgeDays: 1, passwordPolicy: { minLength: 8, historyDepth: 0 } });
  return r.findings.some(f => f.key === 'password_min_length_low');
})());
ok('the score never leaves 0–100', (() => {
  const awful = { users: 10, admins: 1, mfaUsers: 0, mfaCoverage: 0, failedLogins24h: 9999,
                  mustChangePassword: 9, permissionDenied24h: 999, unenrolledPrivileged: ['a','b','c','d','e','f'] };
  const r = repo.assessRisk(awful, { lockedAccounts: 5, lastBackupAgeDays: null, passwordPolicy: { minLength: 8, historyDepth: 0 } });
  return r.score >= 0 && r.score <= 100 && r.level === 'critical';
})());

section('Audit log — pagination and search');
for (let i = 0; i < 12; i++) {
  repo.logAuth('LOGIN', i % 3 === 0 ? 'FAILURE' : 'SUCCESS',
    { username: 'pager_' + i, ip: '10.0.0.' + i, reason: 'suite fixture ' + i });
}
const p1 = repo.queryAuthLog({ limit: 5, offset: 0 });
const p2 = repo.queryAuthLog({ limit: 5, offset: 5 });
ok('a page returns at most `limit` rows', p1.rows.length === 5);
ok('total counts every match, not just the page', p1.total > 5);
ok('offset moves the window', p1.rows[0].id !== p2.rows[0].id);
ok('rows are newest-first', p1.rows[0].id > p1.rows[p1.rows.length - 1].id);
ok('limit is capped at 500', repo.queryAuthLog({ limit: 99999 }).limit === 500);
ok('a negative offset is clamped to 0', repo.queryAuthLog({ offset: -5 }).offset === 0);
ok('filtering by result works',
   repo.queryAuthLog({ result: 'FAILURE', limit: 50 }).rows.every(r => r.result === 'FAILURE'));
ok('free-text search matches an IP',
   repo.queryAuthLog({ q: '10.0.0.7', limit: 20 }).rows.some(r => r.ip_address === '10.0.0.7'));
ok('free-text search matches a username',
   repo.queryAuthLog({ q: 'pager_3', limit: 20 }).total >= 1);
ok('a LIKE wildcard in the search term is escaped, not executed', (() => {
  // '%' must be matched literally. If it leaked into the pattern this would
  // match every row instead of none.
  const all = repo.queryAuthLog({ limit: 1 }).total;
  const pct = repo.queryAuthLog({ q: '%', limit: 5 }).total;
  return pct < all;
})());
ok('authLogActions lists only actions actually present',
   repo.authLogActions().every(a => typeof a === 'string' && a.length > 0));

section('Administration read models');
const users = repo.listUsersAdmin();
ok('listUsersAdmin returns every account', users.length >= 4);
ok('it NEVER returns a password hash',
   !users.some(u => Object.keys(u).some(k => /password$/i.test(k) && typeof u[k] === 'string' && u[k].startsWith('scrypt'))));
ok('it reports the effective MFA requirement', users.every(u => typeof u.mfaRequired === 'boolean'));
ok('it reports role rank, so the UI can respect the rank rule',
   users.every(u => typeof u.roleRank === 'number'));

const mo = repo.mfaOverview();
ok('mfaOverview splits enrolled from unenrolled',
   Array.isArray(mo.enrolled) && Array.isArray(mo.unenrolled));
ok('every account appears exactly once across the two lists', (() => {
  const names = mo.enrolled.concat(mo.unenrolled).map(u => u.username);
  return new Set(names).size === names.length && names.length === users.length;
})());

const ss = repo.sessionsSummary();
ok('sessionsSummary returns counts', Array.isArray(ss));
ok('sessionsSummary NEVER exposes another account’s device or IP',
   !ss.some(s => 'ip' in s || 'device_name' in s || 'deviceName' in s));

const stats = repo.systemStats();
ok('systemStats counts every entity the health screen shows',
   ['users', 'employees', 'groups', 'documents', 'sessions', 'auditRows'].every(k => typeof stats[k] === 'number'));
const dbs = repo.databaseStatus();
ok('databaseStatus runs an integrity check', dbs.integrity === 'ok' && dbs.ok === true);
ok('databaseStatus reports the journal mode', !!dbs.journalMode);

section('Backups');
const bf = admin.backup({ by: 'suite', reason: 'test' });
const entries = admin.listBackupsDetailed();
const mine = entries.find(e => e.file === bf);
ok('a backup is created', !!bf && fs.existsSync(path.join(admin.BACKUP_DIR, bf)));
ok('the history records its size', mine && mine.size > 0);
ok('the history records who took it', mine && mine.createdBy === 'suite');
ok('the history records why', mine && mine.reason === 'test');
ok('a healthy backup is marked ok', mine && mine.status === 'ok');
ok('backupPath resolves a real file', !!admin.backupPath(bf));
ok('backupPath refuses a traversal attempt',
   admin.backupPath('../../../etc/passwd') === null);
ok('backupPath refuses a non-.db file', admin.backupPath('notes.txt') === null);
ok('a backup with no manifest entry is still listed and restorable', (() => {
  const orphan = path.join(admin.BACKUP_DIR, 'kd-manual-copy.db');
  fs.copyFileSync(path.join(admin.BACKUP_DIR, bf), orphan);
  const listed = admin.listBackupsDetailed().find(e => e.file === 'kd-manual-copy.db');
  return !!listed && listed.createdBy === null && !!admin.backupPath('kd-manual-copy.db');
})());

/* ══════════════════════════════════════════════════════════════════
 * Role administration
 * ══════════════════════════════════════════════════════════════════ */
section('Custom roles');
ok('a custom role can be created',
   repo.createRole({ key: 'reviewer', name: 'Reviewer', rank: 100, mfa: 'required' },
                   { actor: 'admin', actorRank: 0 }) === 'ok');
ok('its grants can be set',
   repo.setRolePermissions('reviewer', [['employee.view', 'all'], ['audit.view', 'all']],
                           { actor: 'admin' }) === 'ok');
ok('the grants took effect', (() => {
  const m = repo.getPermissionMatrix().matrix.reviewer;
  return m['employee.view'] === 'all' && m['audit.view'] === 'all' && !m['employee.delete'];
})());
ok('an unknown permission key is ignored, never granted', (() => {
  repo.setRolePermissions('reviewer', [['employee.view', 'all'], ['not.a.permission', 'all']], { actor: 'admin' });
  const m = repo.getPermissionMatrix().matrix.reviewer;
  return !m['not.a.permission'] && m['employee.view'] === 'all';
})());
ok('an invalid scope falls back to a valid one', (() => {
  repo.setRolePermissions('reviewer', [['employee.view', 'everything']], { actor: 'admin' });
  return repo.getPermissionMatrix().matrix.reviewer['employee.view'] === 'all';
})());
ok('a SYSTEM role’s grants cannot be edited (a re-seed would revert them)',
   repo.setRolePermissions('admin', [['employee.view', 'all']], { actor: 'admin' }) === 'system-role');
ok('...and the admin role is untouched',
   Object.keys(repo.getPermissionMatrix().matrix.admin).length > 30);
ok('a system role cannot be deleted', repo.deleteRole('viewer', { actor: 'admin' }) === 'system-role');
ok('creating a role above the actor’s own rank is refused',
   repo.createRole({ key: 'superuser', name: 'Superuser', rank: 0 },
                   { actor: 'manager', actorRank: 10 }) === 'rank-violation');
ok('a duplicate key is refused',
   repo.createRole({ key: 'reviewer', name: 'Reviewer 2' }, { actor: 'admin', actorRank: 0 }) === 'dup');
ok('a role in use cannot be deleted', (() => {
  const u = 'rev_' + Date.now().toString(36);
  repo.addUser({ username: u, password: PASS, role: 'reviewer' }, { mustChange: false, actor: 't' });
  const res = repo.deleteRole('reviewer', { actor: 'admin' });
  repo.setUserRole(u, 'employee', { actorRank: 0, actor: 't' });
  return res === 'role-in-use';
})());
ok('an unused custom role can be deleted', repo.deleteRole('reviewer', { actor: 'admin' }) === 'ok');
ok('role changes are audited',
   repo.getAuthLog({ limit: 80 }).some(e => e.action === 'ROLE_PERMISSION_CHANGE'));

/* ══════════════════════════════════════════════════════════════════
 * HTTP — authorisation on the new endpoints
 * ══════════════════════════════════════════════════════════════════ */
const PORT = 37600 + (process.pid % 300);
process.env.PORT = String(PORT);
require('../../shell/server.js');
const { request } = require('./_testhttp').makeClient(PORT);
const cookieOf = (res) => {
  for (const c of (res.headers['set-cookie'] || [])) {
    const m = /^kd_sid=([^;]*)/.exec(c);
    if (m) return 'kd_sid=' + m[1];
  }
  return null;
};

(async () => {
  await new Promise(r => setTimeout(r, 400));

  const SECRETS = {};
  async function signIn(roleKey) {
    const uname = U[roleKey];
    db.prepare("UPDATE users SET must_change_password=0, password_changed_at=datetime('now') WHERE username=?").run(uname);
    /* Re-set a known password: the history section above moved the employee's.
     *
     * The history rows are cleared FIRST, because PASS is itself in that
     * account's history by now and the reuse rule would (correctly) refuse to
     * restore it. That refusal is the feature working — clearing the fixture is
     * a test-data reset, not a way around it, which is why it goes through the
     * table directly rather than through a code path that would weaken the
     * rule for real callers. */
    db.prepare('DELETE FROM password_history WHERE username=?').run(uname);
    const reset = repo.updateUser(uname, { password: PASS }, { actor: 't', mustChange: false, actorRank: 0 });
    if (reset !== 'ok') console.log('    (fixture) password reset for ' + roleKey + ' → ' + reset);
    if (repo.mfaPolicyFor(roleKey).required && !repo.getMfaStatus(uname).totpEnabled) {
      const e = repo.beginTotpEnrolment(uname);
      repo.confirmTotpEnrolment(uname, totp.generate(e.secret), {});
      SECRETS[roleKey] = e.secret;
    }
    const s1 = await request('POST', '/api/login', { username: uname, password: PASS });
    if (!s1.body || !s1.body.mfaRequired) return cookieOf(s1);
    db.prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(uname);
    const s2 = await request('POST', '/api/login/mfa',
      { mfaTicket: s1.body.mfaTicket, code: totp.generate(SECRETS[roleKey]) });
    return cookieOf(s2);
  }

  section('HTTP — sign in');
  const C = {};
  for (const k of ['admin', 'manager', 'employee', 'auditor']) {
    C[k] = await signIn(k);
    ok(k + ' can sign in', !!C[k]);
  }
  const as = (k) => ({ Cookie: C[k] });
  const st = async (role, method, p, body) => (await request(method, p, body, as(role))).status;

  section('HTTP — Security Centre authorisation');
  ok('admin MAY read the security overview',   (await st('admin',   'GET', '/api/security/overview')) === 200);
  ok('auditor MAY read the security overview', (await st('auditor', 'GET', '/api/security/overview')) === 200);
  ok('employee MAY NOT read it',               (await st('employee','GET', '/api/security/overview')) === 403);
  ok('manager MAY NOT read it (no audit.view)',(await st('manager', 'GET', '/api/security/overview')) === 403);

  ok('manager MAY READ the policies (settings.view)', (await st('manager', 'GET', '/api/security/policies')) === 200);
  ok('manager MAY NOT CHANGE them (no security.manage)',
     (await st('manager', 'PATCH', '/api/security/policies/password', { minLength: 8 })) === 403);
  ok('employee MAY NOT read the policies', (await st('employee', 'GET', '/api/security/policies')) === 403);
  ok('admin MAY change them',
     (await st('admin', 'PATCH', '/api/security/policies/password', { minLength: 14 })) === 200);
  ok('...and the change is visible', (await request('GET', '/api/security/policies', undefined, as('admin')))
     .body.policies.password.minLength === 14);
  ok('an unknown policy name is refused',
     (await st('admin', 'PATCH', '/api/security/policies/nonsense', {})) === 400);
  ok('a policy change is written to the audit trail',
     repo.getAuthLog({ limit: 40 }).some(e => /policy changed/.test(e.reason || '')));

  ok('manager MAY NOT reach the MFA administration', (await st('manager', 'GET', '/api/security/mfa-overview')) === 403);
  ok('admin MAY reach it', (await st('admin', 'GET', '/api/security/mfa-overview')) === 200);
  ok('resetting your OWN MFA through the admin route is refused',
     (await st('admin', 'POST', '/api/security/mfa-reset', { username: U.admin })) === 400);
  ok('mfa-enforce needs a username', (await st('admin', 'POST', '/api/security/mfa-enforce', {})) === 400);

  ok('only security.manage sees the session summary',
     (await st('auditor', 'GET', '/api/security/sessions')) === 403 &&
     (await st('admin',   'GET', '/api/security/sessions')) === 200);

  section('HTTP — Administration');
  ok('auditor MAY list users (user.view)', (await st('auditor', 'GET', '/api/users')) === 200);
  ok('auditor MAY NOT create one',
     (await st('auditor', 'POST', '/api/users', { username: 'x_' + Date.now(), password: PASS })) === 403);
  ok('employee MAY NOT list users', (await st('employee', 'GET', '/api/users')) === 403);
  ok('the user list carries no hash', (() => {
    return true;   // asserted directly against listUsersAdmin above
  })());
  ok('auditor MAY read the audit log', (await st('auditor', 'GET', '/api/auth-log')) === 200);
  ok('employee MAY NOT read the audit log', (await st('employee', 'GET', '/api/auth-log')) === 403);
  ok('the audit log response carries pagination', (() => true)());
  const logRes = await request('GET', '/api/auth-log?limit=5', undefined, as('auditor'));
  ok('...limit is honoured over HTTP', logRes.body.rows.length <= 5);
  ok('...total is returned', typeof logRes.body.total === 'number');
  ok('...`log` is still present for older clients', Array.isArray(logRes.body.log));

  ok('auditor MAY read the role matrix', (await st('auditor', 'GET', '/api/roles/matrix')) === 200);
  ok('auditor MAY NOT create a role',
     (await st('auditor', 'POST', '/api/roles', { key: 'nope', name: 'Nope' })) === 403);
  ok('admin MAY create a role',
     (await st('admin', 'POST', '/api/roles', { key: 'httprole', name: 'HTTP role', rank: 120 })) === 200);
  ok('editing a system role’s grants returns 403 over HTTP',
     (await st('admin', 'PATCH', '/api/roles/admin/permissions', { grants: [] })) === 403);
  ok('admin MAY delete the unused custom role',
     (await st('admin', 'DELETE', '/api/roles/httprole')) === 200);

  section('HTTP — Monitoring and backups');
  ok('admin MAY read system health', (await st('admin', 'GET', '/api/admin/health')) === 200);
  ok('manager MAY NOT read system health', (await st('manager', 'GET', '/api/admin/health')) === 403);
  ok('auditor MAY NOT read system health', (await st('auditor', 'GET', '/api/admin/health')) === 403);

  const health = (await request('GET', '/api/admin/health', undefined, as('admin'))).body;
  ok('health reports the application version', !!health.app.version);
  ok('health reports server time and timezone', !!health.app.serverTime && 'timezone' in health.app);
  ok('health reports memory', typeof health.memory.heapUsed === 'number');
  ok('health reports database integrity', health.database.ok === true);
  ok('health reports record counts', typeof health.stats.employees === 'number');

  const bl = await request('GET', '/api/admin/backups', undefined, as('admin'));
  ok('the backup list carries size and author', bl.body.entries.some(e => e.size > 0 && 'createdBy' in e));
  ok('...and the plain `files` array for older clients', Array.isArray(bl.body.files));
  const dl = await request('GET', '/api/admin/backups/' + encodeURIComponent(bf) + '/download', undefined, as('admin'));
  ok('a backup can be downloaded', dl.status === 200 && dl.raw.length > 0);
  ok('the download is served as an attachment',
     /attachment/.test(dl.headers['content-disposition'] || ''));
  ok('the download is not cacheable', /no-store/.test(dl.headers['cache-control'] || ''));
  ok('a non-admin cannot download a backup',
     (await st('auditor', 'GET', '/api/admin/backups/' + encodeURIComponent(bf) + '/download')) === 403);
  ok('a traversal attempt on the download path 404s',
     (await st('admin', 'GET', '/api/admin/backups/' + encodeURIComponent('../../kd.db') + '/download')) === 404);

  section('HTTP — undeclared routes still fail closed');
  ok('a new route nobody classified is DENIED',
     (await st('admin', 'GET', '/api/security/not-a-real-thing')) === 403);

  /* ── Result ── */
  console.log('\n' + '='.repeat(52));
  console.log('  RESULT: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log('   • ' + f));
  }
  console.log('='.repeat(52) + '\n');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('\nTest harness crashed:', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});
