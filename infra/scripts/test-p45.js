'use strict';
/**
 * infra/scripts/test-p45.js — P4.5 suite: the gaps the Settings audit found.
 *
 *   npm run test-p45
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * Each section below corresponds to a finding, and every assertion is written so
 * that it FAILS on the pre-P4.5 code. That is the point: a regression test that
 * would have passed before the fix proves nothing.
 *
 * Findings covered:
 *   1. Restore silently discarded every audit event recorded after the backup.
 *   2. export.excel / export.pdf / export.bundle were granted but never enforced
 *      or audited — no route mapped onto them.
 *   3. Backup / restore / import / export / policy changes had no named audit
 *      event, only the generic PERMISSION_USED.
 *   4. Permission coverage was only proven for 4 of the 6 roles.
 */
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-p45-test-'));
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
/* Getter, not a cached handle: admin.restore() reopens the database. */
const db    = () => dbmod.db;
const repo  = require('../repo');
const admin = require('../admin');
const totp  = require('../totp');

const PASS = 'P45&Suite!Pass7x';

/* ══════════════════════════════════════════════════════════════════
 * FINDING 1 — the audit trail must survive a restore
 * ══════════════════════════════════════════════════════════════════
 * auth_log is documented as append-only and A.12.4.2 expects log information to
 * be protected. Before this fix, restoring an older snapshot erased every
 * security event recorded since — giving anyone holding backup.restore a
 * one-click way to delete the record of what they had just done.
 */
section('Audit trail survives a restore');

const countAuth = () => db().prepare('SELECT COUNT(*) c FROM auth_log').get().c;

repo.logAuth('LOGIN', 'SUCCESS', { username: 'early', reason: 'before the backup' });
const snapshot = admin.backup({ by: 'suite', reason: 'audit-preservation test' });
const beforeEvents = countAuth();

// Security events recorded AFTER the snapshot — exactly what a restore used to erase.
for (let i = 0; i < 4; i++) {
  repo.logAuth('PERMISSION_DENIED', 'FAILURE', { username: 'prober', reason: 'attempt ' + i });
}
repo.logAuth('USER_CREATE', 'SUCCESS', { username: 'latecomer', reason: 'created after the backup' });
const afterEvents = countAuth();
ok('events accumulate before the restore', afterEvents === beforeEvents + 5,
   beforeEvents + ' → ' + afterEvents);

const restoreResult = admin.restore(snapshot, { by: 'suite' });
ok('restore reports how many audit rows it carried forward',
   restoreResult && typeof restoreResult.preservedAuditRows === 'number',
   JSON.stringify(restoreResult));
ok('NO security event was lost across the restore', countAuth() >= afterEvents,
   'expected ≥' + afterEvents + ', got ' + countAuth());
ok('the specific post-backup denials survived',
   db().prepare("SELECT COUNT(*) c FROM auth_log WHERE username_attempted='prober'").get().c === 4);
ok('the post-backup account creation survived',
   db().prepare("SELECT COUNT(*) c FROM auth_log WHERE username_attempted='latecomer'").get().c === 1);
ok('restoring the SAME backup twice does not duplicate rows', (() => {
  const before = countAuth();
  admin.restore(snapshot, { by: 'suite' });
  return countAuth() === before;
})());
ok('the pre-restore state is itself backed up first',
   admin.listBackupsDetailed().some(e => /pre-restore/.test(e.reason || '')),
   admin.listBackupsDetailed().map(e => e.reason).join(' | '));
ok('the restore reports which file holds the overwritten state',
   !!restoreResult.safetyCopy && !restoreResult.safetyError,
   JSON.stringify({ copy: restoreResult.safetyCopy, err: restoreResult.safetyError }));

/* Regression: two backups inside the same second used to collide on filename,
 * because the timestamp had one-second resolution and VACUUM INTO refuses to
 * overwrite. It failed loudly for a manual backup and SILENTLY for the
 * pre-restore safety copy, which is the one that matters most. */
section('Rapid successive backups do not collide');
ok('three backups in immediate succession all succeed and are distinct', (() => {
  const files = [];
  for (let i = 0; i < 3; i++) files.push(admin.backup({ by: 'suite', reason: 'burst ' + i }));
  const unique = new Set(files);
  return unique.size === 3 && files.every(f => !!admin.backupPath(f));
})());
ok('each burst backup is recorded in the manifest with its own reason', (() => {
  const reasons = admin.listBackupsDetailed().map(e => e.reason || '');
  return ['burst 0', 'burst 1', 'burst 2'].every(r => reasons.includes(r));
})());
ok('a backup taken immediately before a restore is not lost', (() => {
  const manual = admin.backup({ by: 'suite', reason: 'manual right before a restore' });
  const res = admin.restore(manual, { by: 'suite' });   // same second as the line above
  return !!admin.backupPath(manual) && !!res.safetyCopy && !res.safetyError;
})());

/* ══════════════════════════════════════════════════════════════════
 * FINDING 2 — export permissions map to something
 * ══════════════════════════════════════════════════════════════════ */
section('Export format → permission mapping');
ok('a CSV needs export.excel',        rbac.exportPermissionFor('csv') === 'export.excel');
ok('a spreadsheet needs export.excel', rbac.exportPermissionFor('xlsx') === 'export.excel');
ok('a card PDF needs export.pdf',     rbac.exportPermissionFor('kd-pdf') === 'export.pdf');
ok('a PowerPoint needs export.pdf',   rbac.exportPermissionFor('pptx') === 'export.pdf');
ok('a .kdb bundle needs export.bundle (records AND images)',
   rbac.exportPermissionFor('kdb') === 'export.bundle');
ok('a full JSON dump needs export.bundle',
   rbac.exportPermissionFor('json') === 'export.bundle');
ok('an audit-log CSV needs audit.view', rbac.exportPermissionFor('audit') === 'audit.view');
ok('an UNKNOWN format fails closed to the narrowest grant',
   rbac.exportPermissionFor('some-new-thing') === 'export.bundle');
ok('a missing format fails closed', rbac.exportPermissionFor(undefined) === 'export.bundle');
ok('case does not open a hole', rbac.exportPermissionFor('CSV') === 'export.excel');

section('Named audit actions exist');
['BACKUP_CREATE', 'BACKUP_RESTORE', 'BACKUP_DOWNLOAD', 'DATA_EXPORT', 'DATA_IMPORT', 'POLICY_CHANGE']
  .forEach(a => {
    repo.logAuth(a, 'SUCCESS', { username: 'suite', reason: 'vocabulary check' });
    const row = db().prepare('SELECT action FROM auth_log ORDER BY id DESC LIMIT 1').get();
    ok(a + ' is a recognised action (not recorded as UNKNOWN)', row.action === a, row.action);
  });

/* ══════════════════════════════════════════════════════════════════
 * FINDING 4 — all six roles
 * ══════════════════════════════════════════════════════════════════
 * P4 proved permissions for admin/manager/employee/auditor. The two legacy roles
 * are still held by real accounts, so they need the same proof.
 */
section('All six roles resolve to the right permissions');
const U = {};
['admin', 'manager', 'employee', 'auditor', 'data_entry', 'viewer'].forEach(k => {
  U[k] = k + '_' + Date.now().toString(36);
  ok('created a ' + k + ' account',
     repo.addUser({ username: U[k], password: PASS, role: k, name: k },
                  { mustChange: false, actor: 'suite' }) === 'ok');
});
const M = repo.getPermissionMatrix().matrix;

ok('viewer holds NO export permission',
   !M.viewer['export.excel'] && !M.viewer['export.pdf'] && !M.viewer['export.bundle']);
ok('data_entry holds NO export permission',
   !M.data_entry['export.excel'] && !M.data_entry['export.pdf'] && !M.data_entry['export.bundle']);
ok('employee holds NO export permission',
   !M.employee['export.excel'] && !M.employee['export.pdf'] && !M.employee['export.bundle']);
ok('manager CAN export spreadsheets and PDFs',
   M.manager['export.excel'] === 'all' && M.manager['export.pdf'] === 'all');
ok('manager CANNOT export the full bundle', !M.manager['export.bundle']);
ok('admin can export everything',
   M.admin['export.excel'] && M.admin['export.pdf'] && M.admin['export.bundle']);
ok('auditor holds NO export permission (reads on screen, cannot bulk-extract)',
   !M.auditor['export.excel'] && !M.auditor['export.pdf'] && !M.auditor['export.bundle']);
ok('only admin may change security settings',
   !!M.admin['security.manage'] && !M.manager['security.manage'] &&
   !M.auditor['security.manage'] && !M.employee['security.manage'] &&
   !M.viewer['security.manage'] && !M.data_entry['security.manage']);
ok('only admin may manage the database',
   !!M.admin['database.manage'] && ['manager','auditor','employee','viewer','data_entry']
     .every(r => !M[r]['database.manage']));
ok('only admin and auditor may read the audit trail',
   !!M.admin['audit.view'] && !!M.auditor['audit.view'] &&
   ['manager','employee','viewer','data_entry'].every(r => !M[r]['audit.view']));

/* ══════════════════════════════════════════════════════════════════
 * Settings-backed data is real, not local
 * ══════════════════════════════════════════════════════════════════ */
section('Company branding is server-persisted');
repo.setSetting('company_logo', 'data:image/png;base64,AAAA');
repo.setSetting('company_name', 'KD Test Co');
ok('company_logo round-trips through app_settings',
   repo.getSettings().company_logo === 'data:image/png;base64,AAAA');
ok('company_name round-trips through app_settings',
   repo.getSettings().company_name === 'KD Test Co');
ok('the logo reaches every client via /bootstrap settings',
   repo.getBootstrap().settings.company_logo === 'data:image/png;base64,AAAA');
ok('clearing the logo persists as empty, not as a stale value', (() => {
  repo.setSetting('company_logo', '');
  return repo.getBootstrap().settings.company_logo === '';
})());

/* ══════════════════════════════════════════════════════════════════
 * HTTP — enforcement, not UI restriction
 * ══════════════════════════════════════════════════════════════════ */
const PORT = 38200 + (process.pid % 200);
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
    db().prepare("UPDATE users SET must_change_password=0, password_changed_at=datetime('now') WHERE username=?").run(uname);
    db().prepare('DELETE FROM password_history WHERE username=?').run(uname);
    repo.updateUser(uname, { password: PASS }, { actor: 'suite', mustChange: false, actorRank: 0 });
    if (repo.mfaPolicyFor(roleKey).required && !repo.getMfaStatus(uname).totpEnabled) {
      const e = repo.beginTotpEnrolment(uname);
      repo.confirmTotpEnrolment(uname, totp.generate(e.secret), {});
      SECRETS[roleKey] = e.secret;
    }
    const s1 = await request('POST', '/api/login', { username: uname, password: PASS });
    if (!s1.body || !s1.body.mfaRequired) return cookieOf(s1);
    db().prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(uname);
    const s2 = await request('POST', '/api/login/mfa',
      { mfaTicket: s1.body.mfaTicket, code: totp.generate(SECRETS[roleKey]) });
    return cookieOf(s2);
  }

  section('HTTP — all six roles sign in');
  const C = {};
  for (const k of ['admin', 'manager', 'employee', 'auditor', 'data_entry', 'viewer']) {
    C[k] = await signIn(k);
    ok(k + ' can sign in', !!C[k]);
  }
  const as = (k) => ({ Cookie: C[k] });
  const st = async (role, method, p, body) => (await request(method, p, body, as(role))).status;

  section('HTTP — export authorisation is enforced by the SERVER');
  ok('viewer is REFUSED a CSV export',
     (await st('viewer', 'POST', '/api/export', { format: 'csv', scope: 'group', records: 5 })) === 403);
  ok('employee is REFUSED a CSV export',
     (await st('employee', 'POST', '/api/export', { format: 'csv' })) === 403);
  ok('data_entry is REFUSED a CSV export',
     (await st('data_entry', 'POST', '/api/export', { format: 'csv' })) === 403);
  ok('auditor is REFUSED a spreadsheet export',
     (await st('auditor', 'POST', '/api/export', { format: 'xlsx' })) === 403);
  ok('manager IS allowed a CSV export',
     (await st('manager', 'POST', '/api/export', { format: 'csv', records: 5 })) === 200);
  ok('manager IS allowed a PDF export',
     (await st('manager', 'POST', '/api/export', { format: 'kd-pdf' })) === 200);
  ok('manager is REFUSED the full .kdb bundle (no export.bundle)',
     (await st('manager', 'POST', '/api/export', { format: 'kdb' })) === 403);
  ok('manager is REFUSED the full JSON dump',
     (await st('manager', 'POST', '/api/export', { format: 'json' })) === 403);
  ok('admin IS allowed the full bundle',
     (await st('admin', 'POST', '/api/export', { format: 'kdb', records: 100 })) === 200);
  ok('an unknown format is refused for anyone without export.bundle',
     (await st('manager', 'POST', '/api/export', { format: 'brand-new-format' })) === 403);
  ok('auditor IS allowed to export the audit log itself (audit.view)',
     (await st('auditor', 'POST', '/api/export', { format: 'audit', records: 20 })) === 200);
  ok('viewer is REFUSED an audit-log export',
     (await st('viewer', 'POST', '/api/export', { format: 'audit' })) === 403);

  section('HTTP — every export lands in the trail');
  const exportRows = repo.queryAuthLog({ action: 'DATA_EXPORT', limit: 50 }).rows;
  ok('DATA_EXPORT events were recorded', exportRows.length >= 4, String(exportRows.length));
  ok('the event names the format', exportRows.some(r => /format=csv/.test(r.reason || '')));
  ok('the event names the record count', exportRows.some(r => /records=5/.test(r.reason || '')));
  ok('the event names the permission that authorised it',
     exportRows.some(r => /permission=export\.(excel|bundle|pdf)/.test(r.reason || '')));
  ok('the event is attributed to the exporting account',
     exportRows.some(r => r.username_attempted === U.manager));
  ok('a REFUSED export is recorded as a denial, not silently dropped',
     repo.queryAuthLog({ action: 'PERMISSION_DENIED', limit: 100 }).rows
       .some(r => /export\./.test(r.reason || '')));

  section('HTTP — named data-lifecycle events');
  await request('POST', '/api/admin/backup', {}, as('admin'));
  ok('creating a backup writes BACKUP_CREATE',
     repo.queryAuthLog({ action: 'BACKUP_CREATE', limit: 10 }).total >= 1);
  ok('...and names the file and its size',
     repo.queryAuthLog({ action: 'BACKUP_CREATE', limit: 5 }).rows
       .some(r => /file=kd-.*bytes=\d+/.test(r.reason || '')));

  const list = await request('GET', '/api/admin/backups', undefined, as('admin'));
  const file = list.body.files[0];
  await request('GET', '/api/admin/backups/' + encodeURIComponent(file) + '/download', undefined, as('admin'));
  ok('downloading a backup writes BACKUP_DOWNLOAD',
     repo.queryAuthLog({ action: 'BACKUP_DOWNLOAD', limit: 10 }).total >= 1);

  await request('POST', '/api/import', { groups: [], cities: { kr: [], la: [] }, users: [] }, as('admin'));
  ok('an import writes DATA_IMPORT',
     repo.queryAuthLog({ action: 'DATA_IMPORT', limit: 10 }).total >= 1);
  ok('...and records the shape of what arrived',
     repo.queryAuthLog({ action: 'DATA_IMPORT', limit: 5 }).rows
       .some(r => /groups=\d+; workers=\d+/.test(r.reason || '')));

  await request('PATCH', '/api/security/policies/password', { minLength: 13 }, as('admin'));
  ok('a policy change writes POLICY_CHANGE (not ROLE_PERMISSION_CHANGE)',
     repo.queryAuthLog({ action: 'POLICY_CHANGE', limit: 10 }).total >= 1);
  ok('...and records the new values, so the trail shows WHAT changed',
     repo.queryAuthLog({ action: 'POLICY_CHANGE', limit: 5 }).rows
       .some(r => /minLength/.test(r.reason || '')));
  ok('filtering for role changes no longer returns policy changes',
     repo.queryAuthLog({ action: 'ROLE_PERMISSION_CHANGE', limit: 50 }).rows
       .every(r => !/policy changed/.test(r.reason || '')));

  section('HTTP — restore through the API preserves the trail');
  const before = repo.queryAuthLog({ limit: 1 }).total;
  repo.logAuth('PERMISSION_DENIED', 'FAILURE', { username: 'evidence', reason: 'must survive an API restore' });
  const fresh = await request('POST', '/api/admin/backup', {}, as('admin'));
  repo.logAuth('PERMISSION_DENIED', 'FAILURE', { username: 'evidence2', reason: 'recorded after the snapshot' });
  const rr = await request('POST', '/api/admin/restore', { file: fresh.body.file }, as('admin'));
  ok('the restore response reports the preserved count',
     rr.status === 200 && typeof rr.body.preservedAuditRows === 'number',
     JSON.stringify(rr.body && rr.body.preservedAuditRows));
  ok('post-snapshot evidence survived an API restore',
     db().prepare("SELECT COUNT(*) c FROM auth_log WHERE username_attempted='evidence2'").get().c === 1);
  ok('the restore itself is recorded as BACKUP_RESTORE',
     repo.queryAuthLog({ action: 'BACKUP_RESTORE', limit: 10 }).total >= 1);
  ok('...and states how much evidence was carried forward',
     repo.queryAuthLog({ action: 'BACKUP_RESTORE', limit: 5 }).rows
       .some(r => /carried forward=\d+/.test(r.reason || '')));
  ok('the trail did not shrink', repo.queryAuthLog({ limit: 1 }).total >= before);

  section('HTTP — Settings writes stay permission-gated for all six roles');
  for (const r of ['manager', 'employee', 'auditor', 'viewer', 'data_entry']) {
    ok(r + ' CANNOT change a setting',
       (await st(r, 'POST', '/api/settings', { key: 'company_logo', value: 'x' })) === 403);
  }
  ok('admin CAN change a setting',
     (await st('admin', 'POST', '/api/settings', { key: 'company_name', value: 'KD' })) === 200);
  for (const r of ['manager', 'employee', 'auditor', 'viewer', 'data_entry']) {
    ok(r + ' CANNOT create a backup', (await st(r, 'POST', '/api/admin/backup', {})) === 403);
  }
  for (const r of ['manager', 'employee', 'auditor', 'viewer', 'data_entry']) {
    ok(r + ' CANNOT restore the database',
       (await st(r, 'POST', '/api/admin/restore', { file: 'anything.db' })) === 403);
  }
  for (const r of ['employee', 'auditor', 'viewer', 'data_entry']) {
    ok(r + ' CANNOT import data', (await st(r, 'POST', '/api/import', {})) === 403);
  }

  section('HTTP — the version is served, not hard-coded');
  const h = await request('GET', '/api/health');
  ok('/api/health reports a version', !!(h.body && h.body.version), JSON.stringify(h.body));
  ok('...and it matches package.json',
     h.body.version === require('../../package.json').version);
  ok('/api/health needs no session (the sign-in page uses it)', h.status === 200);
  ok('/api/health exposes nothing else',
     Object.keys(h.body).sort().join(',') === 'db,ok,ts,version');

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
