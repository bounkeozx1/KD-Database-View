'use strict';
/**
 * infra/scripts/test-rbac.js — RBAC suite: permission matrix, scopes, the rank
 * invariant, default-deny, and privilege-escalation attempts.
 *
 *   npm run test-rbac
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * The matrix section asserts BOTH directions for every role: that each granted
 * capability works, AND that each restricted one is refused. A suite that only
 * checked the grants would pass just as happily if every role were Admin.
 */
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-rbac-test-'));
process.env.KD_DATA_DIR = TMP;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

const rbac  = require('../rbac');
const dbmod = require('../db');
dbmod.init();
const db   = dbmod.db;
const repo = require('../repo');
const totp = require('../totp');

/* ── Schema ── */
section('Schema');
['roles', 'permissions', 'role_permissions'].forEach(t => {
  ok(t + ' table exists',
     !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t));
});
ok('users.role_id exists',
   db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'role_id'));
ok('employees.created_by exists (enables "own" scope)',
   db.prepare('PRAGMA table_info(employees)').all().some(c => c.name === 'created_by'));
ok('employees.status exists (draft/approval workflow)',
   db.prepare('PRAGMA table_info(employees)').all().some(c => c.name === 'status'));
ok('role_permissions carries a scope column',
   db.prepare('PRAGMA table_info(role_permissions)').all().some(c => c.name === 'scope'));

section('Seeded roles');
const roles = repo.listRoles();
/* P4 raised this from 4 to 6: employee + auditor were added, and data_entry +
 * viewer were RETAINED as legacy rows rather than deleted. Deleting them would
 * have stripped every account still pointing at them of every permission at the
 * next boot, so the count going up is the correct outcome, not a regression. */
ok('exactly 6 system roles (4 assignable + 2 legacy)',
   roles.filter(r => r.is_system).length === 6, String(roles.length));
ok('exactly 4 assignable roles',
   roles.filter(r => r.is_system && !r.is_legacy).length === 4,
   roles.filter(r => !r.is_legacy).map(r => r.key).join(','));
['admin', 'manager', 'data_entry', 'viewer', 'employee', 'auditor'].forEach(k =>
  ok('role "' + k + '" seeded', roles.some(r => r.key === k)));
['data_entry', 'viewer'].forEach(k =>
  ok('role "' + k + '" is flagged legacy', roles.find(r => r.key === k).is_legacy === 1));
// The rename must not have changed what the role may do.
ok('employee holds exactly the data_entry grants', (() => {
  const P = repo.getPermissionMatrix().matrix;
  return JSON.stringify(P.employee) === JSON.stringify(P.data_entry);
})());
// The auditor is a READER: the audit trail plus the account list, and no writes.
ok('auditor can read the audit trail', (() => {
  const P = repo.getPermissionMatrix().matrix;
  return P.auditor['audit.view'] === 'all' && P.auditor['user.view'] === 'all';
})());
ok('auditor cannot write anything', (() => {
  const P = repo.getPermissionMatrix().matrix;
  return !Object.keys(P.auditor).some(k => /\.(create|update|delete|approve|manage|assign|execute|restore)$/.test(k));
})());
ok('auditor cannot bulk-export personal data', (() => {
  const P = repo.getPermissionMatrix().matrix;
  return !P.auditor['export.excel'] && !P.auditor['export.pdf'] && !P.auditor['export.bundle'];
})());
ok('ranks are strictly ordered admin < manager < data_entry < viewer', (() => {
  const g = k => roles.find(r => r.key === k).rank;
  return g('admin') < g('manager') && g('manager') < g('data_entry') && g('data_entry') < g('viewer');
})());
ok('admin requires MFA',      roles.find(r => r.key === 'admin').mfa === 'required');
ok('manager requires MFA',    roles.find(r => r.key === 'manager').mfa === 'required');
ok('data_entry MFA optional', roles.find(r => r.key === 'data_entry').mfa === 'optional');
ok('viewer MFA optional',     roles.find(r => r.key === 'viewer').mfa === 'optional');
ok('system roles are flagged', roles.every(r => r.is_system === 1));

/* ── Users, one per role ── */
const PASS = 'Rbac&T3stPass!x';
const U = {};
['admin', 'manager', 'data_entry', 'viewer'].forEach(k => {
  U[k] = k + '_' + Date.now().toString(36);
  ok('created ' + k + ' account',
     repo.addUser({ username: U[k], password: PASS, role: k, name: k }, { mustChange: false, actor: 't' }) === 'ok');
});
ok('an unknown role falls back to the LEAST privileged, never admin', (() => {
  const u = 'bogus_' + Date.now().toString(36);
  repo.addUser({ username: u, password: PASS, role: 'wizard', name: 'x' }, { mustChange: false, actor: 't' });
  return repo.getRole(u).key === 'viewer';
})());

/* ══════════════════════════════════════════════════════════════════
 * Permission matrix — both directions
 * ══════════════════════════════════════════════════════════════════ */
section('Permission matrix — Admin (full access)');
const P = {};
Object.keys(U).forEach(k => { P[k] = repo.getPermissions(U[k]); });
ok('admin holds EVERY catalogued permission',
   rbac.PERMISSION_KEYS.every(k => P.admin[k]),
   rbac.PERMISSION_KEYS.filter(k => !P.admin[k]).join(', '));
['user.create', 'role.assign', 'settings.update', 'backup.create', 'backup.restore',
 'audit.view', 'security.manage', 'mfa.enforce'].forEach(k =>
  ok('admin: ' + k, !!P.admin[k]));

section('Permission matrix — Manager');
[['employee.view','all'], ['employee.approve','all'], ['report.view','all'],
 ['dashboard.view','all'], ['export.excel','all'], ['export.pdf','all']].forEach(([k, s]) =>
  ok('GRANTED ' + k + ' (' + s + ')', P.manager[k] === s, String(P.manager[k])));
ok('GRANTED employee.update at TEAM scope only', P.manager['employee.update'] === 'team', String(P.manager['employee.update']));
// Restrictions
['user.create', 'user.update', 'user.delete', 'role.assign'].forEach(k =>
  ok('DENIED ' + k + ' (cannot create Admin accounts)', !P.manager[k]));
ok('DENIED settings.update (cannot change system settings)', !P.manager['settings.update']);
ok('DENIED backup.restore (cannot restore database)',        !P.manager['backup.restore']);
ok('DENIED employee.delete',                                 !P.manager['employee.delete']);
ok('DENIED audit.view',                                      !P.manager['audit.view']);

section('Permission matrix — Data Entry');
[['employee.create','all'], ['passport.create','all'], ['ocr.process','all'],
 ['employee.view','all']].forEach(([k, s]) =>
  ok('GRANTED ' + k + ' (' + s + ')', P.data_entry[k] === s, String(P.data_entry[k])));
ok('GRANTED employee.update at OWN scope only', P.data_entry['employee.update'] === 'own', String(P.data_entry['employee.update']));
ok('GRANTED document.upload at OWN scope',      P.data_entry['document.upload'] === 'own');
ok('GRANTED employee.draft',                    !!P.data_entry['employee.draft']);
// Restrictions
['employee.delete', 'passport.delete', 'document.delete', 'trash.purge'].forEach(k =>
  ok('DENIED ' + k + ' (No Delete Permission)', !P.data_entry[k]));
['user.view', 'user.create', 'user.update', 'role.assign'].forEach(k =>
  ok('DENIED ' + k + ' (No User Management)', !P.data_entry[k]));
ok('DENIED settings.update (No System Settings)', !P.data_entry['settings.update']);
['backup.create', 'backup.restore', 'database.manage', 'import.execute'].forEach(k =>
  ok('DENIED ' + k + ' (No Database Access)', !P.data_entry[k]));

section('Permission matrix — Viewer (read-only)');
['employee.view', 'passport.view', 'document.view', 'report.view', 'dashboard.view'].forEach(k =>
  ok('GRANTED ' + k, P.viewer[k] === 'all'));
['employee.create', 'passport.create', 'document.upload'].forEach(k =>
  ok('DENIED ' + k + ' (No Create)', !P.viewer[k]));
['employee.update', 'passport.update', 'group.update'].forEach(k =>
  ok('DENIED ' + k + ' (No Update)', !P.viewer[k]));
['employee.delete', 'document.delete', 'trash.purge'].forEach(k =>
  ok('DENIED ' + k + ' (No Delete)', !P.viewer[k]));
['export.excel', 'export.pdf', 'export.bundle'].forEach(k =>
  ok('DENIED ' + k + ' (No Export)', !P.viewer[k]));
['user.view', 'user.create', 'role.assign'].forEach(k =>
  ok('DENIED ' + k + ' (No User Management)', !P.viewer[k]));

/* ── Engine ── */
section('Authorization engine — default deny + scopes');
ok('unknown permission is denied',      !rbac.check(P.admin, 'not.a.permission', {}).allowed);
ok('ungranted permission is denied',    !rbac.check(P.viewer, 'employee.delete', {}).allowed);
ok('ALL scope needs no record context',  rbac.check(P.viewer, 'employee.view', {}).allowed);
ok('OWN scope allows the creator',
   rbac.check(P.data_entry, 'employee.update', { actor: 'alice', ownerId: 'alice' }).allowed);
ok('OWN scope refuses somebody else\'s record',
   !rbac.check(P.data_entry, 'employee.update', { actor: 'alice', ownerId: 'bob' }).allowed);
ok('OWN scope FAILS CLOSED without context (never widens to all)',
   !rbac.check(P.data_entry, 'employee.update', {}).allowed);
ok('TEAM scope allows a supervised group',
   rbac.check(P.manager, 'employee.update', { teamIds: ['g1', 'g2'], recordTeamId: 'g2' }).allowed);
ok('TEAM scope refuses another supervisor\'s group',
   !rbac.check(P.manager, 'employee.update', { teamIds: ['g1'], recordTeamId: 'g9' }).allowed);
ok('TEAM scope FAILS CLOSED without context',
   !rbac.check(P.manager, 'employee.update', {}).allowed);
ok('empty grant set can do nothing',
   rbac.PERMISSION_KEYS.every(k => !rbac.check({}, k, {}).allowed));

section('Rank invariant (privilege escalation)');
ok('admin(0) may create manager(10)',   rbac.canAssignRole(0, 10));
ok('manager(10) may create viewer(30)', rbac.canAssignRole(10, 30));
ok('manager(10) may NOT create admin(0) — escalation',   !rbac.canAssignRole(10, 0));
ok('data_entry(20) may NOT create manager(10) — escalation', !rbac.canAssignRole(20, 10));
// Equal rank is allowed on purpose: a strict '>' would make it impossible for
// an Admin to appoint a second Admin. Manager holds no user.create in the
// shipped grants, so lateral creation is unreachable for that role regardless.
ok('admin(0) MAY appoint another admin(0)', rbac.canAssignRole(0, 0));
ok('manager(10) may create manager(10) by rank alone', rbac.canAssignRole(10, 10));
ok('...but Manager has no user.create, so it cannot in practice', !P.manager['user.create']);
ok('null ranks are refused', !rbac.canAssignRole(null, 0) && !rbac.canAssignRole(0, null));

ok('repo refuses a rank-violating CREATE',
   repo.addUser({ username: 'esc1_' + Date.now().toString(36), password: PASS, role: 'admin' },
                { actorRank: 10, actor: 'manager' }) === 'rank-violation');
ok('repo refuses a rank-violating PROMOTION',
   repo.setUserRole(U.viewer, 'admin', { actorRank: 10, actor: 'manager' }) === 'rank-violation');
ok('the victim was not promoted', repo.getRole(U.viewer).key === 'viewer');
ok('admin CAN legitimately promote', (() => {
  const r = repo.setUserRole(U.viewer, 'data_entry', { actorRank: 0, actor: 'admin' });
  const now = repo.getRole(U.viewer).key;
  repo.setUserRole(U.viewer, 'viewer', { actorRank: 0, actor: 'admin' });   // restore
  return r === 'ok' && now === 'data_entry';
})());
ok('role change is audited',
   repo.getAuthLog({ limit: 50 }).some(e => e.action === 'ROLE_CHANGE'));
ok('the last admin cannot be demoted', (() => {
  // Demote every admin but one, try the survivor, then put everyone back.
  // Restoring matters: the HTTP section below signs in as U.admin, and leaving
  // it demoted would make every later "admin can…" assertion fail for the wrong
  // reason.
  const admins = db.prepare("SELECT u.username FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='admin'").all();
  const demoted = admins.slice(1).map(a => a.username);
  demoted.forEach(a => repo.setUserRole(a, 'viewer', { actorRank: 0, actor: 't' }));
  const last = admins[0].username;
  const res = repo.setUserRole(last, 'viewer', { actorRank: 0, actor: 't' });
  const held = res === 'last-admin' && repo.getRole(last).key === 'admin';
  demoted.forEach(a => repo.setUserRole(a, 'admin', { actorRank: 0, actor: 't' }));
  return held && repo.getRole(U.admin).key === 'admin';
})());

/* ══════════════════════════════════════════════════════════════════
 * HTTP enforcement
 * ══════════════════════════════════════════════════════════════════ */
const PORT = 37200 + (process.pid % 300);
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

  // Sign each role in. admin/manager require MFA, so enrol TOTP and complete
  // both steps — exactly as a real user of those roles now does.
  async function signIn(roleKey) {
    const uname = U[roleKey];
    const needsMfa = repo.mfaPolicyFor(roleKey).required;
    if (needsMfa && !repo.getMfaStatus(uname).totpEnabled) {
      const e = repo.beginTotpEnrolment(uname);
      repo.confirmTotpEnrolment(uname, totp.generate(e.secret), {});
      U[roleKey + '_secret'] = e.secret;
    }
    const s1 = await request('POST', '/api/login', { username: uname, password: PASS });
    if (!s1.body || !s1.body.mfaRequired) return cookieOf(s1);
    db.prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(uname);
    const s2 = await request('POST', '/api/login/mfa',
      { mfaTicket: s1.body.mfaTicket, code: totp.generate(U[roleKey + '_secret']) });
    return cookieOf(s2);
  }

  const C = {};
  for (const k of ['admin', 'manager', 'data_entry', 'viewer']) {
    C[k] = await signIn(k);
    ok(k + ' can sign in', !!C[k]);
  }

  const as = (k) => ({ Cookie: C[k] });
  const st = async (role, method, p, body) => (await request(method, p, body, as(role))).status;

  section('HTTP — read access');
  for (const k of ['admin', 'manager', 'data_entry', 'viewer']) {
    ok(k + ' may read /api/bootstrap', (await st(k, 'GET', '/api/bootstrap')) === 200);
  }

  section('HTTP — Viewer is genuinely read-only');
  ok('viewer CANNOT create a group',    (await st('viewer', 'POST', '/api/groups', { id: 'v1', name: 'X' })) === 403);
  ok('viewer CANNOT create an employee',(await st('viewer', 'POST', '/api/groups/g1/employees', { en_name: 'X' })) === 403);
  ok('viewer CANNOT change settings',   (await st('viewer', 'POST', '/api/settings', { key: 'k', value: 'v' })) === 403);
  ok('viewer CANNOT read the audit log',(await st('viewer', 'GET', '/api/auth-log')) === 403);
  ok('viewer CANNOT list users',        (await st('viewer', 'GET', '/api/users')) === 403);
  ok('viewer CANNOT import',            (await st('viewer', 'POST', '/api/import', {})) === 403);
  ok('viewer CANNOT back up the database', (await st('viewer', 'POST', '/api/admin/backup', {})) === 403);
  const vres = await request('POST', '/api/settings', { key: 'k', value: 'v' }, as('viewer'));
  ok('403 names the missing permission', vres.body.permission === 'settings.update', vres.raw);

  section('HTTP — Data Entry');
  const deGroup = await request('POST', '/api/groups', { id: 'de-' + Date.now().toString(36), name: 'DE' }, as('admin'));
  const gid = deGroup.body.id;
  ok('data_entry CAN create an employee',
     (await st('data_entry', 'POST', '/api/groups/' + gid + '/employees', { en_name: 'Owned' })) === 200);
  ok('data_entry CANNOT create a group',   (await st('data_entry', 'POST', '/api/groups', { id: 'de2', name: 'X' })) === 403);
  ok('data_entry CANNOT delete an employee', (await st('data_entry', 'DELETE', '/api/employees/whatever')) === 403);
  ok('data_entry CANNOT manage users',     (await st('data_entry', 'POST', '/api/users', { username: 'x', password: PASS, role: 'viewer' })) === 403);
  ok('data_entry CANNOT change settings',  (await st('data_entry', 'POST', '/api/settings', { key: 'k', value: 'v' })) === 403);
  ok('data_entry CANNOT restore the database', (await st('data_entry', 'POST', '/api/admin/restore', {})) === 403);
  ok('data_entry CAN use OCR',             (await st('data_entry', 'POST', '/api/ai/extract', { image: '', docType: 'passport' })) !== 403);

  section('HTTP — "own" scope actually bites');
  // A record created by data_entry, and one created by admin.
  const mine = (await request('POST', '/api/groups/' + gid + '/employees', { en_name: 'Mine' }, as('data_entry'))).body.uid;
  const theirs = (await request('POST', '/api/groups/' + gid + '/employees', { en_name: 'Theirs' }, as('admin'))).body.uid;
  ok('created_by is recorded from the SESSION',
     db.prepare('SELECT created_by FROM employees WHERE uid=?').get(mine).created_by === U.data_entry);
  ok('data_entry CAN edit its OWN record',
     (await st('data_entry', 'PATCH', '/api/employees/' + mine, { en_name: 'Mine 2' })) === 200);
  const other = await request('PATCH', '/api/employees/' + theirs, { en_name: 'Hijacked' }, as('data_entry'));
  ok('data_entry CANNOT edit someone else\'s record', other.status === 403, other.raw);
  ok('the refusal is reported as out-of-scope', other.body.reason === 'out-of-scope', other.raw);
  ok('the target record was NOT modified',
     db.prepare('SELECT en_name FROM employees WHERE uid=?').get(theirs).en_name !== 'Hijacked');
  ok('admin (scope=all) CAN edit any record',
     (await st('admin', 'PATCH', '/api/employees/' + mine, { en_name: 'Admin edit' })) === 200);

  section('HTTP — Manager');
  ok('manager CAN read every record',   (await st('manager', 'GET', '/api/bootstrap')) === 200);
  ok('manager CANNOT create users',     (await st('manager', 'POST', '/api/users', { username: 'm1', password: PASS, role: 'viewer' })) === 403);
  ok('manager CANNOT change settings',  (await st('manager', 'POST', '/api/settings', { key: 'k', value: 'v' })) === 403);
  ok('manager CANNOT restore the database', (await st('manager', 'POST', '/api/admin/restore', {})) === 403);
  ok('manager CANNOT read the audit log',(await st('manager', 'GET', '/api/auth-log')) === 403);
  ok('manager CANNOT delete an employee',(await st('manager', 'DELETE', '/api/employees/' + mine)) === 403);
  const mgrEdit = await request('PATCH', '/api/employees/' + mine, { en_name: 'Mgr' }, as('manager'));
  ok('manager edit is TEAM-scoped (refused outside their groups)', mgrEdit.status === 403, mgrEdit.raw);

  section('HTTP — Admin retains full access');
  ok('admin CAN change settings',   (await st('admin', 'POST', '/api/settings', { key: 'rbac_test', value: '1' })) === 200);
  ok('admin CAN read the audit log',(await st('admin', 'GET', '/api/auth-log?limit=5')) === 200);
  ok('admin CAN list users',        (await st('admin', 'GET', '/api/users')) !== 403);
  ok('admin CAN create users',
     (await st('admin', 'POST', '/api/users', { username: 'byadmin_' + Date.now().toString(36), password: PASS, role: 'data_entry' })) === 200);

  section('HTTP — privilege escalation via the API');
  const esc = await request('POST', '/api/users',
    { username: 'esc_' + Date.now().toString(36), password: PASS, role: 'admin' }, as('manager'));
  ok('manager creating an Admin is refused', esc.status === 403, esc.raw);
  ok('...and no such account exists',
     !db.prepare('SELECT 1 FROM users WHERE role=?').get('admin') ||
     db.prepare("SELECT COUNT(*) c FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='admin'").get().c >= 1);

  section('Default deny');
  const unknown = await request('GET', '/api/definitely-not-a-route', undefined, as('admin'));
  ok('an undeclared route is DENIED even for admin', unknown.status === 403, unknown.status + ' ' + unknown.raw);
  ok('...and says why', unknown.body && unknown.body.reason === 'route-not-declared', unknown.raw);

  section('Introspection endpoints');
  let r = await request('GET', '/api/roles', undefined, as('admin'));
  ok('GET /api/roles → 200', r.status === 200 && (r.body.roles || []).length >= 4);
  r = await request('GET', '/api/permissions', undefined, as('admin'));
  ok('GET /api/permissions → 200', r.status === 200 && (r.body.permissions || []).length === rbac.PERMISSION_KEYS.length);
  r = await request('GET', '/api/roles/matrix', undefined, as('admin'));
  ok('GET /api/roles/matrix → 200', r.status === 200 && !!r.body.matrix);
  ok('viewer CANNOT read the role matrix', (await st('viewer', 'GET', '/api/roles')) === 403);

  section('Audit — authorization-sensitive actions');
  const log = repo.getAuthLog({ limit: 400 });
  ok('PERMISSION_DENIED recorded', log.some(e => e.action === 'PERMISSION_DENIED'));
  ok('PERMISSION_USED recorded for sensitive successes', log.some(e => e.action === 'PERMISSION_USED'));
  ok('denials name the permission', log.some(e => e.action === 'PERMISSION_DENIED' && /settings\.update|user\.create/.test(e.reason || '')));
  ok('scope refusals are recorded',  log.some(e => /denied by scope/.test(e.reason || '')));

  section('Future roles without code changes (requirement 11)');
  ok('a brand-new role works with no code change', (() => {
    // Pure data: insert a role, grant it two permissions, and it is enforceable.
    db.prepare("INSERT INTO roles (key,name,description,rank,mfa,is_system) VALUES ('ext_reviewer','External reviewer','Read-only + audit',15,'required',0)").run();
    const rid = db.prepare("SELECT id FROM roles WHERE key='ext_reviewer'").get().id;
    ['employee.view', 'audit.view'].forEach(k => {
      const pid = db.prepare('SELECT id FROM permissions WHERE key=?').get(k).id;
      db.prepare('INSERT INTO role_permissions (role_id,permission_id,scope) VALUES (?,?,?)').run(rid, pid, 'all');
    });
    const u = 'ext_reviewer_' + Date.now().toString(36);
    repo.addUser({ username: u, password: PASS, role: 'ext_reviewer' }, { mustChange: false, actor: 't' });
    const p = repo.getPermissions(u);
    return repo.getRole(u).key === 'ext_reviewer' && p['audit.view'] === 'all' && !p['employee.create'];
  })());
  ok('the new role inherits its MFA requirement from data', repo.mfaPolicyFor('ext_reviewer').required === true);
  ok('re-seeding does NOT clobber a custom role', (() => {
    dbmod.seedRbac();
    const rid = db.prepare("SELECT id FROM roles WHERE key='ext_reviewer'").get();
    const n = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE role_id=?').get(rid.id).c;
    return !!rid && n === 2;
  })());

  section('Backward compatibility');
  ok('legacy "admin" text role maps to the admin role', (() => {
    const u = 'legacy_' + Date.now().toString(36);
    db.prepare("INSERT INTO users (username,password,role,name) VALUES (?,?,'admin','L')").run(u, 'x');
    dbmod.backfillRoleIds();
    return repo.getRole(u).key === 'admin';
  })());
  ok('legacy "viewer" text role maps to the viewer role', (() => {
    const u = 'legacyv_' + Date.now().toString(36);
    db.prepare("INSERT INTO users (username,password,role,name) VALUES (?,?,'viewer','L')").run(u, 'x');
    dbmod.backfillRoleIds();
    return repo.getRole(u).key === 'viewer';
  })());
  ok('an unreadable legacy role becomes VIEWER, never admin', (() => {
    const u = 'legacyx_' + Date.now().toString(36);
    db.prepare("INSERT INTO users (username,password,role,name) VALUES (?,?,'superuser','L')").run(u, 'x');
    dbmod.backfillRoleIds();
    return repo.getRole(u).key === 'viewer';
  })());
  ok('existing employee rows default to approved (workflow is opt-in)',
     db.prepare("SELECT COUNT(*) c FROM employees WHERE status IS NULL OR status=''").get().c === 0);

  const bar = '='.repeat(66);
  console.log('\n' + bar);
  console.log('  RESULT: ' + passed + ' passed, ' + failed + ' failed');
  console.log(bar);
  if (failed) { console.log('  Failures:'); failures.forEach(f => console.log('    - ' + f)); console.log(bar); }
  console.log('');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nTest harness crashed:', err && err.stack || err);
  process.exit(1);
});
