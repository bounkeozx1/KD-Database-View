'use strict';
/**
 * infra/scripts/audit-coverage.js — measure audit coverage of every write route.
 *
 *   npm run audit-coverage
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * Why this exists
 * ───────────────
 * "Every write is audited" is the kind of claim that is easy to assert and hard
 * to verify by reading — the coverage comes from three different places (the
 * RBAC gate's PERMISSION_USED for sensitive permissions, explicit logAuth calls
 * in repo.js, and route-level calls in server.js), so no single file shows the
 * whole picture.
 *
 * This drives each write endpoint for real and reports whether a row landed in
 * auth_log. The output IS the audit coverage matrix — measured, not claimed.
 *
 * A route that writes nothing to the trail is printed as a GAP, and the script
 * exits non-zero, so this can gate a release.
 */
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-auditcov-'));
process.env.KD_DATA_DIR = TMP;

const dbmod = require('../db');
dbmod.init();
/* Always go through the getter: admin.restore() closes and REOPENS the database,
 * so a handle cached at startup goes stale mid-run and every later query fails
 * with ERR_INVALID_STATE "database is not open". */
const db = () => dbmod.db;
const repo  = require('../repo');
const totp  = require('../totp');

const PASS = 'Aud1t&Cover!9xz';
const ADMIN = 'covadmin';

repo.addUser({ username: ADMIN, password: PASS, role: 'admin', name: 'Coverage Admin' },
             { mustChange: false, actor: 'setup' });
const enrol = repo.beginTotpEnrolment(ADMIN);
repo.confirmTotpEnrolment(ADMIN, totp.generate(enrol.secret), {});

// A second account for the actions that need a target other than yourself.
const TARGET = 'covtarget';
repo.addUser({ username: TARGET, password: PASS, role: 'employee', name: 'Coverage Target' },
             { mustChange: false, actor: 'setup' });

const PORT = 37900 + (process.pid % 200);
process.env.PORT = String(PORT);
require('../../shell/server.js');
const { request } = require('./_testhttp').makeClient(PORT);

const results = [];
const maxId = (table) => {
  try {
    const r = db().prepare('SELECT MAX(id) AS m FROM ' + table).get();
    return r && r.m ? r.m : 0;
  } catch (e) { return 0; }
};

/**
 * Run one write and report what it left in the trail.
 *
 * BOTH log tables are measured, because the system deliberately has two and
 * writes land in whichever is correct:
 *
 *   auth_log      — what happened to an ACCOUNT or to the system's security
 *                   posture (sign-ins, roles, policy, backups, exports).
 *   activity_log  — what happened to a WORKER RECORD (created, edited, deleted).
 *
 * The split is not incidental: it is what stops a retention policy on worker
 * data from quietly deleting security evidence (db.js schema comment). A probe
 * that watched only auth_log reported three false gaps — record writes ARE
 * audited, just in the table that is meant to hold them.
 */
async function probe(label, method, route, body, headers, expect) {
  const beforeAuth = maxId('auth_log');
  const beforeAct  = maxId('activity_log');
  let status = 0;
  try {
    const res = await request(method, route, body, headers);
    status = res.status;
  } catch (e) { status = -1; }

  const authRows = db().prepare(
    'SELECT action, result, reason FROM auth_log WHERE id > ? ORDER BY id'
  ).all(beforeAuth);
  let actRows = [];
  try {
    actRows = db().prepare(
      'SELECT entity_type, action, detail FROM activity_log WHERE id > ? ORDER BY id'
    ).all(beforeAct);
  } catch (e) {}

  results.push({
    label, method, route, status,
    events: authRows.map(r => r.action),
    activity: actRows.map(r => r.entity_type + '.' + r.action),
    reasons: authRows.map(r => r.reason || '').filter(Boolean),
    expect: expect || 'audited',
  });
  return status;
}

(async () => {
  await new Promise(r => setTimeout(r, 400));

  // Sign in (admin requires MFA).
  const cookieOf = (res) => {
    for (const c of (res.headers['set-cookie'] || [])) {
      const m = /^kd_sid=([^;]*)/.exec(c);
      if (m) return 'kd_sid=' + m[1];
    }
    return null;
  };
  const s1 = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  db().prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(ADMIN);
  const s2 = await request('POST', '/api/login/mfa',
    { mfaTicket: s1.body.mfaTicket, code: totp.generate(enrol.secret) });
  const A = { Cookie: cookieOf(s2) };
  if (!A.Cookie) { console.error('could not sign in'); process.exit(1); }

  // ── Application settings ──
  await probe('Setting changed', 'POST', '/api/settings', { key: 'company_name', value: 'Cov Co' }, A);
  await probe('City added', 'POST', '/api/cities', { country: 'kr', name: 'Covtown', code: 'CVT' }, A);
  await probe('City deleted', 'DELETE', '/api/cities/kr/CVT', undefined, A);

  // ── Records ──
  await probe('Group created', 'POST', '/api/groups', { id: 'covg1', name: 'Coverage Group' }, A);
  await probe('Group updated', 'PATCH', '/api/groups/covg1', { name: 'Coverage Group 2' }, A);
  const emp = await request('POST', '/api/groups/covg1/employees', { en_name: 'Cov Worker' }, A);
  const uid = emp.body && emp.body.worker && emp.body.worker.uid;
  await probe('Employee created', 'POST', '/api/groups/covg1/employees', { en_name: 'Cov Worker 2' }, A);
  if (uid) {
    await probe('Employee updated', 'PATCH', '/api/employees/' + uid, { en_name: 'Cov Worker Edited' }, A);
    await probe('Employee deleted (trash)', 'DELETE', '/api/employees/' + uid, undefined, A);
    await probe('Trash restore', 'POST', '/api/trash/restore', { type: 'employee', id: uid }, A);
    await probe('Trash purge', 'POST', '/api/trash/purge', { type: 'employee', id: uid }, A);
  }
  await probe('Group deleted (trash)', 'DELETE', '/api/groups/covg1', undefined, A);
  await probe('Trash emptied', 'POST', '/api/trash/empty', {}, A);

  // ── Accounts ──
  await probe('User created', 'POST', '/api/users',
    { username: 'covnew', password: 'C0v!NewPass9xy', role: 'employee' }, A);
  await probe('User renamed', 'PATCH', '/api/users/covnew', { name: 'Renamed' }, A);
  await probe('Role changed', 'PATCH', '/api/users/covnew', { role: 'auditor' }, A);
  await probe('Password reset by admin', 'PATCH', '/api/users/covnew', { password: 'C0v!Reset9xyz' }, A);
  await probe('User deleted', 'DELETE', '/api/users/covnew', undefined, A);

  // ── Roles ──
  await probe('Role created', 'POST', '/api/roles', { key: 'covrole', name: 'Cov Role', rank: 150 }, A);
  await probe('Role grants set', 'PATCH', '/api/roles/covrole/permissions',
    { grants: [['employee.view', 'all']] }, A);
  await probe('Role updated', 'PATCH', '/api/roles/covrole', { description: 'x' }, A);
  await probe('Role deleted', 'DELETE', '/api/roles/covrole', undefined, A);

  // ── Security policy ──
  await probe('Password policy changed', 'PATCH', '/api/security/policies/password', { minLength: 13 }, A);
  await probe('MFA policy changed', 'PATCH', '/api/security/policies/mfa', { employee: 'required' }, A);
  await probe('Session policy changed', 'PATCH', '/api/security/policies/session', { absoluteDays: 20 }, A);
  await probe('MFA forced on account', 'POST', '/api/security/mfa-enforce',
    { username: TARGET, required: true }, A);
  await probe('MFA reset on account', 'POST', '/api/security/mfa-reset', { username: TARGET }, A);
  await probe('Sessions revoked for account', 'POST', '/api/security/revoke-sessions',
    { username: TARGET }, A);
  await probe('Trusted devices revoked for account', 'POST', '/api/security/revoke-trusted',
    { username: TARGET }, A);

  // ── Self-service security ──
  await probe('Own password changed', 'POST', '/api/password',
    { current: PASS, next: 'C0v!SelfChange9x' }, A);
  // That revoked and re-issued the session cookie; pick the new one up.
  const relog1 = await request('POST', '/api/login', { username: ADMIN, password: 'C0v!SelfChange9x' });
  db().prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(ADMIN);
  const relog2 = await request('POST', '/api/login/mfa',
    { mfaTicket: relog1.body.mfaTicket, code: totp.generate(enrol.secret) });
  A.Cookie = cookieOf(relog2) || A.Cookie;
  await probe('Logout all devices', 'POST', '/api/logout-all', { keepCurrent: true }, A);

  // ── Data operations ──
  await probe('Backup created', 'POST', '/api/admin/backup', {}, A);
  const backups = await request('GET', '/api/admin/backups', undefined, A);
  const file = backups.body && backups.body.files && backups.body.files[0];
  if (file) {
    await probe('Backup downloaded', 'GET',
      '/api/admin/backups/' + encodeURIComponent(file) + '/download', undefined, A);
    await probe('Backup restored', 'POST', '/api/admin/restore', { file }, A);
  }
  await probe('Storage cleanup', 'POST', '/api/admin/cleanup', { orphans: true, vacuum: true }, A);
  await probe('Import executed', 'POST', '/api/import',
    { groups: [], cities: { kr: [], la: [] }, users: [] }, A);
  await probe('Export recorded', 'POST', '/api/export/record',
    { format: 'csv', scope: 'group', records: 3 }, A);

  /* ── Report ── */
  const ok2xx = (r) => r.status >= 200 && r.status < 300;
  const logged = (r) => r.events.length > 0 || r.activity.length > 0;
  const gaps = results.filter(r => r.expect === 'audited' && ok2xx(r) && !logged(r));
  const failedCalls = results.filter(r => !ok2xx(r));

  console.log('\nAUDIT COVERAGE MATRIX');
  console.log('='.repeat(104));
  console.log(pad('Write operation', 32) + pad('HTTP', 6) +
              pad('auth_log', 40) + pad('activity_log', 18) + 'Covered');
  console.log('-'.repeat(104));
  results.forEach(r => {
    const covered = logged(r) ? 'YES' : (ok2xx(r) ? 'NO  <- GAP' : 'n/a');
    console.log(pad(r.label, 32) + pad(String(r.status), 6) +
                pad(r.events.join(', ') || '—', 40) +
                pad(r.activity.join(', ') || '—', 18) + covered);
  });
  console.log('='.repeat(104));
  console.log('  probed: ' + results.length +
              '   covered: ' + results.filter(logged).length +
              '   (auth_log: ' + results.filter(r => r.events.length).length +
              ', activity_log only: ' + results.filter(r => !r.events.length && r.activity.length).length + ')' +
              '   gaps: ' + gaps.length +
              '   non-2xx: ' + failedCalls.length);
  if (failedCalls.length) {
    console.log('\n  Non-2xx responses (these were not measured for coverage):');
    failedCalls.forEach(r => console.log('   · ' + r.label + ' → ' + r.method + ' ' + r.route + ' = ' + r.status));
  }
  if (gaps.length) {
    console.log('\n  UNAUDITED WRITES:');
    gaps.forEach(r => console.log('   ✗ ' + r.label + '  (' + r.method + ' ' + r.route + ')'));
  }
  console.log('');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(gaps.length ? 1 : 0);
})().catch(e => {
  console.error('\nProbe crashed:', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) {}
  process.exit(1);
});

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length); }
