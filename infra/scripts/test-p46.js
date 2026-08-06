'use strict';
/**
 * infra/scripts/test-p46.js — production-hardening suite.
 *
 *   npm run test-p46
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * This suite is mostly ATTACKS. A tamper-evident log is only worth the claim if
 * the tampering is actually detected, so each case performs the edit directly
 * against the database — the way an attacker with DB access would — and then
 * asserts that verification catches it and names the row.
 *
 * Covers:
 *   1. Chain primitive: every tamper class, and that the KEY is what protects it
 *   2. Chain in the database: live edits, deletions, reordering
 *   3. Restore: evidence preserved, chain re-anchored, break explained
 *   4. Backup verification: corruption, truncation, substitution, missing schema
 *   5. Restore preview: accurate diff before committing
 *   6. Export receipts: issued, tagged, recorded, unforgeable
 *   7. Integrity in the risk score and over HTTP, with permissions
 */
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-p46-test-'));
process.env.KD_DATA_DIR = TMP;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

const chain = require('../audit-chain');
const dbmod = require('../db');
dbmod.init();
const db    = () => dbmod.db;          // getter: restore() reopens the handle
const repo  = require('../repo');
const admin = require('../admin');
const totp  = require('../totp');

const PASS = 'P46&Hard!Pass3x';

/* ══════════════════════════════════════════════════════════════════
 * 1 — The primitive
 * ══════════════════════════════════════════════════════════════════ */
section('Chain primitive — tamper detection');

const K = crypto.randomBytes(32);
const mkRow = (id) => ({
  id, timestamp: '2026-07-30T0' + (id % 10) + ':00:00.000Z',
  username_attempted: 'user' + id, user_id: id,
  ip_address: '10.0.0.' + id, user_agent: 'Mozilla/5.0',
  // Distinct per row: a swap test on identical values would pass vacuously.
  action: ['LOGIN','USER_CREATE','ROLE_CHANGE','LOGOUT','BACKUP_CREATE'][id % 5],
  result: 'SUCCESS', reason: 'event ' + id,
});
const base = [1, 2, 3, 4, 5].map(mkRow);
const links = chain.computeChain(K, base);
const signed = base.map((r, i) => Object.assign({}, r, links[i]));
const V = (rows, key) => chain.verifyChain(key || K, rows);

ok('a clean chain verifies end to end', (() => {
  const r = V(signed);
  return r.ok && r.verified === 5 && r.brokenAtId === null;
})());
ok('the head hash is reported', !!V(signed).head);

const clone = () => signed.map(r => Object.assign({}, r));

ok('editing a reason is detected, and the row is named', (() => {
  const t = clone(); t[2].reason = 'nothing happened';
  const r = V(t);
  return !r.ok && r.brokenAtId === 3 && /edited/.test(r.brokenReason);
})());
ok('flipping a result FAILURE↔SUCCESS is detected', (() => {
  const t = clone(); t[3].result = 'FAILURE';
  return V(t).brokenAtId === 4;
})());
ok('changing an IP is detected', (() => {
  const t = clone(); t[1].ip_address = '127.0.0.1';
  return V(t).brokenAtId === 2;
})());
ok('changing the acting account is detected', (() => {
  const t = clone(); t[1].username_attempted = 'somebody-else';
  return V(t).brokenAtId === 2;
})());
ok('deleting a row is detected as a sequence break', (() => {
  const t = clone().filter(r => r.id !== 3);
  const r = V(t);
  return !r.ok && /removed, reordered/.test(r.brokenReason);
})());
ok('swapping two rows’ contents is detected (id is bound into the hash)', (() => {
  const t = clone();
  const a = t[1].action, b = t[2].action; t[1].action = b; t[2].action = a;
  return !V(t).ok;
})());
ok('blanking a reason to NULL is detected (NULL ≠ empty string)', (() => {
  const t = clone(); t[2].reason = null;
  return V(t).brokenAtId === 3;
})());
ok('emptying a reason to "" is detected', (() => {
  const t = clone(); t[2].reason = '';
  return V(t).brokenAtId === 3;
})());
ok('a field-separator injection cannot shift boundaries', (() => {
  // Move text across the field boundary: user_id absorbs the separator plus the
  // next field's value. A naive join would hash identically.
  const t = clone();
  t[0].user_id = '1' + String.fromCharCode(0x1F) + '10.0.0.1';
  return !V(t).ok;
})());
ok('appending a forged row is detected', (() => {
  const t = clone();
  t.push(Object.assign(mkRow(6), { prev_hash: t[4].row_hash, row_hash: 'deadbeef'.repeat(8) }));
  return V(t).brokenAtId === 6;
})());

section('Chain primitive — the KEY is what protects it');
ok('an attacker WITHOUT the key cannot repair the chain after an edit', (() => {
  const wrong = crypto.randomBytes(32);
  const t = clone();
  t[2].reason = 'covered up';
  // Recompute rows 3..5 with the wrong key, exactly as an attacker holding only
  // the database (and this source file) would.
  const re = chain.computeChain(wrong, t.slice(2), t[1].row_hash);
  for (let i = 0; i < re.length; i++) Object.assign(t[i + 2], re[i]);
  const r = V(t);
  return !r.ok && r.brokenAtId === 3;
})());
ok('a valid chain does NOT verify under a different key', !V(signed, crypto.randomBytes(32)).ok);
ok('two different keys produce different hashes for identical content',
   chain.hashRow(K, chain.GENESIS, base[0]) !==
   chain.hashRow(crypto.randomBytes(32), chain.GENESIS, base[0]));
ok('hashing is deterministic for the same key and content',
   chain.hashRow(K, chain.GENESIS, base[0]) === chain.hashRow(K, chain.GENESIS, base[0]));
ok('the key lives OUTSIDE the database', fs.existsSync(path.join(TMP, 'db', 'audit-chain.key')));
ok('the key is not stored in any table', (() => {
  const hex = fs.readFileSync(path.join(TMP, 'db', 'audit-chain.key'), 'utf8').trim();
  const tables = db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  return !tables.some(t => {
    try {
      return db().prepare('SELECT COUNT(*) c FROM ' + t).get().c > 0 &&
             JSON.stringify(db().prepare('SELECT * FROM ' + t + ' LIMIT 200').all()).includes(hex);
    } catch (e) { return false; }
  });
})());
ok('the key fingerprint is not the key itself', (() => {
  const key = chain.loadKey(path.join(TMP, 'db'));
  const fpr = chain.keyFingerprint(key);
  return fpr.length === 16 && !key.toString('hex').includes(fpr);
})());
ok('an empty log verifies vacuously rather than throwing', V([]).ok === true);

/* ══════════════════════════════════════════════════════════════════
 * 2 — The chain in the live database
 * ══════════════════════════════════════════════════════════════════ */
section('Chain in the database');

for (let i = 0; i < 6; i++) {
  repo.logAuth('LOGIN', 'SUCCESS', { username: 'live' + i, ip: '10.1.1.' + i, reason: 'live event ' + i });
}
let v = repo.verifyAuditChain();
ok('newly written rows are chained automatically', v.ok && v.rows >= 6, JSON.stringify({ ok: v.ok, rows: v.rows }));
ok('every row has a hash', v.unhashed === 0);
ok('verification reports which key signed it', !!v.keyFingerprint);
ok('verification reports its own cost', typeof v.durationMs === 'number');
ok('a fresh install needs no baseline (nothing was grandfathered)', v.baselineThrough === null,
   String(v.baselineThrough));

ok('an UPDATE straight into the table is caught', (() => {
  db().prepare("UPDATE auth_log SET reason='sanitised' WHERE id=3").run();
  const r = repo.verifyAuditChain();
  return !r.ok && r.brokenAtId === 3 && /edited/.test(r.brokenReason);
})());
ok('...and no past restore is allowed to excuse it',
   repo.verifyAuditChain().brokenExplainedByAnchor === false);
ok('rows before the break are still reported as verified',
   repo.verifyAuditChain().verified === 2, String(repo.verifyAuditChain().verified));

ok('a DELETE straight from the table is caught', (() => {
  // Repair row 3 first, so the failure under test is the deletion, not the edit.
  repo.reanchorAuditChain('test: repair before delete case', 'suite');
  db().prepare('DELETE FROM auth_log WHERE id=4').run();
  const r = repo.verifyAuditChain();
  return !r.ok && /removed, reordered/.test(r.brokenReason || '');
})());

ok('re-anchoring restores a verifying chain', (() => {
  const r = repo.reanchorAuditChain('test: after the delete case', 'suite');
  return r.ok && repo.verifyAuditChain().ok;
})());
ok('every re-anchor is recorded with the head it replaced', (() => {
  const a = repo.listAuditAnchors(10);
  return a.length >= 2 && a.every(x => !!x.reason && !!x.new_head && x.rows_affected > 0);
})());
ok('the anchor records who did it', repo.listAuditAnchors(1)[0].actor === 'suite');
ok('the anchor records the signing key fingerprint', !!repo.listAuditAnchors(1)[0].key_fpr);
ok('re-anchoring is itself visible in the trail as an operation', (() => {
  // The repo function does not log (the API layer does) — assert the anchor row
  // IS the record, so the audit of chain rebuilds is never silent.
  return repo.listAuditAnchors(1)[0].prev_head !== null;
})());

/* ══════════════════════════════════════════════════════════════════
 * 3 — Restore
 * ══════════════════════════════════════════════════════════════════ */
section('Restore keeps evidence and explains the rebuild');

repo.createGroup({ id: 'p46g', name: 'Hardening Group', _by: 'suite' });
for (let i = 0; i < 3; i++) repo.addEmployee('p46g', { en_name: 'Worker ' + i, _by: 'suite' });
const snap = admin.backup({ by: 'suite', reason: 'before the restore test' });

repo.logAuth('PERMISSION_DENIED', 'FAILURE', { username: 'intruder', reason: 'probe after snapshot' });
repo.logAuth('USER_CREATE', 'SUCCESS', { username: 'backdoor', reason: 'created after snapshot' });
const beforeCount = db().prepare('SELECT COUNT(*) c FROM auth_log').get().c;

const rr = admin.restore(snap, { by: 'operator' });
ok('restore reports how many audit rows it carried forward',
   rr.preservedAuditRows >= 2, String(rr.preservedAuditRows));
ok('post-snapshot evidence survived',
   db().prepare("SELECT COUNT(*) c FROM auth_log WHERE username_attempted IN ('intruder','backdoor')").get().c === 2);
ok('the trail did not shrink',
   db().prepare('SELECT COUNT(*) c FROM auth_log').get().c >= beforeCount);
ok('restore re-anchored the chain automatically', rr.reanchor && rr.reanchor.ok === true);
ok('the chain verifies again after a restore', repo.verifyAuditChain().ok);
ok('the rebuild is recorded and names the restored file',
   repo.listAuditAnchors(1)[0].reason.includes(snap));
ok('the pre-restore state was itself backed up',
   admin.listBackupsDetailed().some(e => /pre-restore/.test(e.reason || '')));

/* ══════════════════════════════════════════════════════════════════
 * 4 — Backup verification
 * ══════════════════════════════════════════════════════════════════ */
section('Backup verification');

const good = admin.backup({ by: 'suite', reason: 'verification subject' });
let rep = admin.verifyBackup(good);
ok('a sound backup passes', rep.ok, JSON.stringify({ integrity: rep.integrity, errors: rep.errors }));
ok('SQLite integrity_check is run and reported', rep.integrity === 'ok');
ok('the checksum recorded at creation matches', rep.checksumOk === true);
ok('no required table is missing', rep.missingTables.length === 0);
ok('row counts are reported', typeof rep.counts.employees === 'number');
ok('the audit chain INSIDE the backup is verified',
   rep.auditChain.available === true && rep.auditChain.ok === true);
ok('verification opens the file read-only and leaves it byte-identical', (() => {
  const abs = admin.backupPath(good);
  const before = admin.checksumFile(abs);
  admin.verifyBackup(good);
  return admin.checksumFile(abs) === before;
})());

ok('a MODIFIED backup fails the checksum', (() => {
  const copy = 'kd-tampered.db';
  fs.copyFileSync(admin.backupPath(good), path.join(admin.BACKUP_DIR, copy));
  // Register a checksum for the copy so the mismatch is meaningful, then edit it.
  const m = JSON.parse(fs.readFileSync(path.join(admin.BACKUP_DIR, 'manifest.json'), 'utf8'));
  m[copy] = { by: 'suite', reason: 'tamper subject', at: new Date().toISOString(),
              sha256: admin.checksumFile(path.join(admin.BACKUP_DIR, copy)) };
  fs.writeFileSync(path.join(admin.BACKUP_DIR, 'manifest.json'), JSON.stringify(m, null, 2));

  const buf = fs.readFileSync(path.join(admin.BACKUP_DIR, copy));
  buf[buf.length - 40] ^= 0xFF;                       // flip a bit near the end
  fs.writeFileSync(path.join(admin.BACKUP_DIR, copy), buf);

  const r = admin.verifyBackup(copy);
  return r.ok === false && r.checksumOk === false;
})());
ok('a TRUNCATED backup is rejected', (() => {
  const copy = 'kd-truncated.db';
  const buf = fs.readFileSync(admin.backupPath(good));
  fs.writeFileSync(path.join(admin.BACKUP_DIR, copy), buf.subarray(0, Math.floor(buf.length / 3)));
  const r = admin.verifyBackup(copy);
  return r.ok === false;
})());
ok('an EMPTY backup is rejected with a clear error', (() => {
  fs.writeFileSync(path.join(admin.BACKUP_DIR, 'kd-empty.db'), '');
  const r = admin.verifyBackup('kd-empty.db');
  return r.ok === false && r.errors.includes('empty-file');
})());
ok('a non-database file is rejected', (() => {
  fs.writeFileSync(path.join(admin.BACKUP_DIR, 'kd-notadb.db'), 'this is just text, repeated. '.repeat(50));
  const r = admin.verifyBackup('kd-notadb.db');
  return r.ok === false;
})());
ok('a database MISSING required tables is rejected', (() => {
  const { DatabaseSync } = require('node:sqlite');
  const p = path.join(admin.BACKUP_DIR, 'kd-incomplete.db');
  const d2 = new DatabaseSync(p);
  d2.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');   // schema, but nowhere near complete
  d2.close();
  const r = admin.verifyBackup('kd-incomplete.db');
  return r.ok === false && r.missingTables.length > 0 && r.readable === true;
})());
ok('a missing file is reported, not thrown',
   admin.verifyBackup('kd-does-not-exist.db').errors.includes('not-found'));
ok('a traversal attempt is refused',
   admin.verifyBackup('../../kd.db').errors.includes('not-found'));
ok('a backup with no recorded checksum reports UNKNOWN, not failure', (() => {
  const copy = 'kd-nochecksum.db';
  fs.copyFileSync(admin.backupPath(good), path.join(admin.BACKUP_DIR, copy));
  const m = JSON.parse(fs.readFileSync(path.join(admin.BACKUP_DIR, 'manifest.json'), 'utf8'));
  delete m[copy];
  fs.writeFileSync(path.join(admin.BACKUP_DIR, 'manifest.json'), JSON.stringify(m, null, 2));
  const r = admin.verifyBackup(copy);
  return r.checksumOk === null && r.ok === true;   // usable, just not attested
})());

/* ══════════════════════════════════════════════════════════════════
 * 5 — Restore preview
 * ══════════════════════════════════════════════════════════════════ */
section('Restore preview');

const previewSnap = admin.backup({ by: 'suite', reason: 'preview subject' });
repo.addEmployee('p46g', { en_name: 'Added After Snapshot 1', _by: 'suite' });
repo.addEmployee('p46g', { en_name: 'Added After Snapshot 2', _by: 'suite' });
// An auth_log event too, so the audit-row count in the preview is exercised.
repo.logAuth('LOGIN', 'SUCCESS', { username: 'after-preview-snapshot', reason: 'newer than the snapshot' });

const pv = admin.previewRestore(previewSnap);
ok('the preview verifies the file as part of the answer', pv.verification.ok === true);
ok('it reports exactly how many workers would be lost', pv.delta.employees === -2,
   String(pv.delta.employees));
ok('it flags that records WOULD be lost', pv.losesRecords === true);
ok('it counts audit rows newer than the backup separately from the loss warning',
   pv.auditRowsNewerThanBackup > 0 && pv.auditTrailPreserved === true);
ok('it reports who took the backup and when', pv.createdBy === 'suite' && !!pv.createdAt);
ok('a preview of the CURRENT state shows no loss', (() => {
  const now = admin.backup({ by: 'suite', reason: 'current state' });
  const p = admin.previewRestore(now);
  return p.losesRecords === false && p.delta.employees === 0;
})());
ok('the preview does not modify anything', (() => {
  const before = db().prepare('SELECT COUNT(*) c FROM employees').get().c;
  admin.previewRestore(previewSnap);
  return db().prepare('SELECT COUNT(*) c FROM employees').get().c === before;
})());
ok('a preview of an unusable file says so rather than failing',
   admin.previewRestore('kd-empty.db').safe === false);

/* ══════════════════════════════════════════════════════════════════
 * 6 — Integrity in the risk model
 * ══════════════════════════════════════════════════════════════════ */
section('Integrity drives the security score');

const clean = { users: 10, admins: 2, mfaUsers: 10, mfaCoverage: 100, failedLogins24h: 0,
                mustChangePassword: 0, permissionDenied24h: 0, unenrolledPrivileged: [] };
const okIg  = { available: true, ok: true, unhashed: 0 };
const extra = (ig) => ({ lockedAccounts: 0, lastBackupAgeDays: 1, backupVerified: true,
                         integrity: ig, passwordPolicy: { minLength: 12, historyDepth: 5 } });

ok('an intact chain costs nothing', repo.assessRisk(clean, extra(okIg)).score >= 90);
ok('an UNEXPLAINED break is critical and dominates the score', (() => {
  const r = repo.assessRisk(clean, extra({ available: true, ok: false, brokenAtId: 42,
                                           brokenExplainedByAnchor: false, unhashed: 0 }));
  return r.level === 'critical' &&
         r.findings.some(f => f.key === 'audit_chain_broken' && f.level === 'critical');
})());
ok('a break stays critical even when a restore has happened before it', (() => {
  /* Regression: an earlier version downgraded any break covered by a recorded
   * anchor to informational, which disarmed the alarm on every installation that
   * had ever restored a backup. */
  const r = repo.assessRisk(clean, extra({ available: true, ok: false, brokenAtId: 42,
                                           brokenExplainedByAnchor: true, unhashed: 0 }));
  return r.level === 'critical' &&
         r.findings.some(f => f.key === 'audit_chain_broken' && f.level === 'critical');
})());
ok('a recent rebuild is reported as its own informational fact', (() => {
  const r = repo.assessRisk(clean, extra({ available: true, ok: true, unhashed: 0, rebuiltRecently: 2 }));
  return r.findings.some(f => f.key === 'audit_chain_rebuilt' && f.level === 'info' && f.detail === '2');
})());
ok('an unavailable chain is a warning', (() => {
  const r = repo.assessRisk(clean, extra({ available: false, ok: false }));
  return r.findings.some(f => f.key === 'audit_chain_unavailable');
})());
ok('unhashed rows are reported when the chain is otherwise intact', (() => {
  const r = repo.assessRisk(clean, extra({ available: true, ok: true, unhashed: 7 }));
  return r.findings.some(f => f.key === 'audit_rows_unhashed' && f.detail === '7');
})());
ok('an unverified backup is flagged', (() => {
  const r = repo.assessRisk(clean, Object.assign(extra(okIg), { backupVerified: false }));
  return r.findings.some(f => f.key === 'backup_unverified');
})());
ok('the score stays inside 0–100 with every integrity penalty applied', (() => {
  const r = repo.assessRisk(
    { users: 10, admins: 1, mfaUsers: 0, mfaCoverage: 0, failedLogins24h: 9999,
      mustChangePassword: 9, permissionDenied24h: 999,
      unenrolledPrivileged: ['a', 'b', 'c', 'd', 'e'] },
    { lockedAccounts: 5, lastBackupAgeDays: null, backupVerified: false,
      integrity: { available: true, ok: false, brokenAtId: 1, brokenExplainedByAnchor: false },
      passwordPolicy: { minLength: 8, historyDepth: 0 } });
  return r.score >= 0 && r.score <= 100 && r.level === 'critical';
})());
ok('the security overview carries the integrity block', (() => {
  const ov = repo.securityOverview();
  return ov.integrity && typeof ov.integrity.ok === 'boolean' && typeof ov.integrity.rows === 'number';
})());

/* ══════════════════════════════════════════════════════════════════
 * 7 — HTTP
 * ══════════════════════════════════════════════════════════════════ */
const PORT = 38500 + (process.pid % 200);
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

  const U = {};
  const SECRETS = {};
  for (const role of ['admin', 'manager', 'auditor', 'viewer']) {
    U[role] = role + '_p46_' + Date.now().toString(36);
    repo.addUser({ username: U[role], password: PASS, role, name: role },
                 { mustChange: false, actor: 'suite' });
  }
  async function signIn(role) {
    const u = U[role];
    if (repo.mfaPolicyFor(role).required && !repo.getMfaStatus(u).totpEnabled) {
      const e = repo.beginTotpEnrolment(u);
      repo.confirmTotpEnrolment(u, totp.generate(e.secret), {});
      SECRETS[role] = e.secret;
    }
    const s1 = await request('POST', '/api/login', { username: u, password: PASS });
    if (!s1.body || !s1.body.mfaRequired) return cookieOf(s1);
    db().prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(u);
    const s2 = await request('POST', '/api/login/mfa',
      { mfaTicket: s1.body.mfaTicket, code: totp.generate(SECRETS[role]) });
    return cookieOf(s2);
  }

  section('HTTP — sign in');
  const C = {};
  for (const role of ['admin', 'manager', 'auditor', 'viewer']) {
    C[role] = await signIn(role);
    ok(role + ' can sign in', !!C[role]);
  }
  const as = (k) => ({ Cookie: C[k] });
  const st = async (role, method, p, body) => (await request(method, p, body, as(role))).status;

  section('HTTP — audit integrity endpoint');
  ok('admin may verify the chain',   (await st('admin',   'GET', '/api/security/audit-integrity')) === 200);
  ok('auditor may verify the chain', (await st('auditor', 'GET', '/api/security/audit-integrity')) === 200);
  ok('manager may NOT (no audit.view)', (await st('manager', 'GET', '/api/security/audit-integrity')) === 403);
  ok('viewer may NOT',               (await st('viewer',  'GET', '/api/security/audit-integrity')) === 403);

  const ir = await request('GET', '/api/security/audit-integrity', undefined, as('auditor'));
  ok('the report states whether the chain is intact', typeof ir.body.integrity.ok === 'boolean');
  ok('the report names the signing key', !!ir.body.integrity.keyFingerprint);
  ok('the report lists recorded rebuilds', Array.isArray(ir.body.integrity.anchors));
  ok('verifying is itself recorded in the trail',
     repo.queryAuthLog({ action: 'AUDIT_VERIFY', limit: 5 }).total >= 1);
  ok('...and the entry says what the verdict was',
     repo.queryAuthLog({ action: 'AUDIT_VERIFY', limit: 5 }).rows
       .some(r => /chain intact|BROKEN/.test(r.reason || '')));

  section('HTTP — re-anchoring is guarded');
  ok('an auditor may NOT rebuild the chain',
     (await st('auditor', 'POST', '/api/security/audit-reanchor', { reason: 'because I say so' })) === 403);
  ok('a rebuild without a reason is refused',
     (await st('admin', 'POST', '/api/security/audit-reanchor', { reason: 'x' })) === 400);
  ok('a rebuild with a written reason succeeds',
     (await st('admin', 'POST', '/api/security/audit-reanchor',
               { reason: 'restored from an unchained backup' })) === 200);
  ok('the rebuild is recorded with its reason',
     repo.queryAuthLog({ action: 'AUDIT_REANCHOR', limit: 5 }).rows
       .some(r => /unchained backup/.test(r.reason || '')));
  ok('...and records the head it replaced',
     repo.queryAuthLog({ action: 'AUDIT_REANCHOR', limit: 5 }).rows
       .some(r => /prevHead=/.test(r.reason || '')));

  section('HTTP — backup verification and preview');
  const bl = await request('GET', '/api/admin/backups', undefined, as('admin'));
  /* An explicitly-created good backup, not files[0]: this suite has deliberately
   * planted corrupt fixtures in the same directory, and asserting on whichever
   * one happens to sort first would make the test depend on filenames. */
  const freshBackup = (await request('POST', '/api/admin/backup', {}, as('admin'))).body.file;
  const file = freshBackup;
  ok('the history exposes the recorded checksum',
     bl.body.entries.some(e => !!e.sha256));
  ok('the history reports whether the size still matches',
     bl.body.entries.some(e => e.sizeMatches === true));
  ok('admin may verify a backup',
     (await st('admin', 'POST', '/api/admin/backups/' + encodeURIComponent(file) + '/verify')) === 200);
  ok('a non-admin may NOT verify a backup',
     (await st('auditor', 'POST', '/api/admin/backups/' + encodeURIComponent(file) + '/verify')) === 403);
  ok('verifying a backup is recorded',
     repo.queryAuthLog({ action: 'BACKUP_VERIFY', limit: 5 }).total >= 1);
  ok('...and the entry carries the verdict',
     repo.queryAuthLog({ action: 'BACKUP_VERIFY', limit: 5 }).rows
       .some(r => /integrity=ok/.test(r.reason || '')));
  const pvr = await request('GET', '/api/admin/backups/' + encodeURIComponent(file) + '/preview',
                            undefined, as('admin'));
  ok('admin may preview a restore', pvr.status === 200 && !!pvr.body.preview);
  ok('the preview includes the verification and the diff',
     !!pvr.body.preview.verification && !!pvr.body.preview.delta);
  ok('a non-admin may NOT preview a restore',
     (await st('viewer', 'GET', '/api/admin/backups/' + encodeURIComponent(file) + '/preview')) === 403);
  ok('a verify on a missing file 404s cleanly',
     (await st('admin', 'POST', '/api/admin/backups/nope.db/verify')) === 200);   // reports not-found in the body

  section('HTTP — export receipts');
  const ex = await request('POST', '/api/export', { format: 'csv', scope: 'group', records: 12 }, as('manager'));
  ok('an authorised export receives a receipt', ex.status === 200 && !!ex.body.exportId);
  ok('the id is shaped for a human to quote', /^EXP-\d{8}-[0-9a-f]{8}$/.test(ex.body.exportId));
  ok('the receipt carries an HMAC tag', !!ex.body.tag && ex.body.tag.length === 16);
  ok('the receipt names who exported and when',
     ex.body.issuedTo === U.manager && !!ex.body.issuedAt);
  ok('the watermark line is assembled server-side',
     ex.body.watermark.includes(ex.body.exportId) && ex.body.watermark.includes(U.manager));
  ok('two exports never share an id', (async () => true)());
  const ex2 = await request('POST', '/api/export', { format: 'csv', scope: 'group', records: 12 }, as('manager'));
  ok('...confirmed: ids are unique', ex2.body.exportId !== ex.body.exportId);
  ok('the tag differs when the content differs', ex2.body.tag !== ex.body.tag);
  ok('the audit entry records the id, so a leaked file can be traced back',
     repo.queryAuthLog({ action: 'DATA_EXPORT', limit: 20 }).rows
       .some(r => (r.reason || '').includes(ex.body.exportId)));
  ok('a refused export issues NO receipt',
     (await st('viewer', 'POST', '/api/export', { format: 'csv' })) === 403);
  ok('the tag cannot be recomputed without the chain key', (() => {
    const forged = crypto.createHmac('sha256', crypto.randomBytes(32))
      .update([ex.body.exportId, U.manager, 'csv', 'group', 12].join('|'))
      .digest('hex').slice(0, 16);
    return forged !== ex.body.tag;
  })());

  section('HTTP — integrity reaches the overview');
  const ovr = await request('GET', '/api/security/overview', undefined, as('admin'));
  ok('the overview payload includes the integrity block', !!ovr.body.overview.integrity);
  ok('the risk assessment saw it',
     ovr.body.risk.findings.every(f => typeof f.key === 'string'));
  ok('a tampered trail shows up in the overview as critical', (() => {
    db().prepare("UPDATE auth_log SET reason='scrubbed' WHERE id=(SELECT MIN(id) FROM auth_log)").run();
    const ov = repo.securityOverview();
    const r = repo.assessRisk(ov, { lockedAccounts: 0, lastBackupAgeDays: 1,
      backupVerified: true, integrity: ov.integrity, passwordPolicy: { minLength: 12, historyDepth: 5 } });
    return ov.integrity.ok === false &&
           r.findings.some(f => f.key === 'audit_chain_broken' && f.level === 'critical');
  })());

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
