'use strict';
/**
 * infra/scripts/test-auth.js — P0 authentication test suite.
 *
 *   npm run test-auth
 *
 * Runs the server for real against a THROWAWAY database in the OS temp dir, so
 * it never touches data/db/kd.db. Every test that maps to a fixed vulnerability
 * is written as the attack, not as a happy path — a green run means the exploit
 * no longer works, which is the only assertion worth having here.
 *
 * Zero dependencies: a tiny assert/harness, node:http for the client.
 */
const http = require('node:http');
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs');

/* ── Isolate the database BEFORE anything requires infra/db.js ── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-auth-test-'));
process.env.KD_DATA_DIR = TMP;

/* ── Harness ── */
let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else {
    failed++; failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

/* ── Unit tests: password module (no server needed) ── */
const pw = require('../password');

section('password policy');
ok('rejects < 12 chars',            !pw.validate('Ab1!xyz').ok);
ok('rejects missing uppercase',     !pw.validate('abcdef123456!').ok);
ok('rejects missing lowercase',     !pw.validate('ABCDEF123456!').ok);
ok('rejects missing digit',         !pw.validate('AbcdefGhijk!').ok);
ok('rejects missing special',       !pw.validate('Abcdef123456').ok);
ok('rejects the old default',       !pw.validate('admin1234').ok);
ok('rejects 4x repeated char',      !pw.validate('Aaaaa12345!x').ok);
ok('rejects password w/ username',  !pw.validate('Bounkeo123!xy', { username: 'bounkeo' }).ok);
ok('rejects app name',              !pw.validate('KdDatabase12!').ok);
ok('accepts a compliant password',   pw.validate('Tr0ub4dor&3xK9').ok);

section('password hashing');
const h = pw.hash('Tr0ub4dor&3xK9');
ok('hash is self-describing',        /^scrypt\$32768\$8\$1\$64\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(h), h.slice(0, 40));
ok('verifies correct password',      pw.verify('Tr0ub4dor&3xK9', h));
ok('rejects wrong password',        !pw.verify('Tr0ub4dor&3xK8', h));
ok('salts differ per hash',          pw.hash('same') !== pw.hash('same'));
ok('current format needs no rehash',!pw.needsRehash(h));
ok('legacy 3-part hash verifies',     (() => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const legacy = 'scrypt$' + salt.toString('hex') + '$' +
    crypto.scryptSync('admin1234', salt, 64).toString('hex');
  return pw.verify('admin1234', legacy) && pw.needsRehash(legacy);
})());
ok('plaintext row verifies + flags', pw.verify('admin1234', 'admin1234') && pw.needsRehash('admin1234'));
ok('rejects tampered cost params',  !pw.verify('x', 'scrypt$99999999$8$1$64$aa$bb'));
ok('generated password is compliant', pw.validate(pw.generate(20)).ok);
ok('generated passwords are unique',  pw.generate(20) !== pw.generate(20));

/* ── Boot a real server against the temp DB ── */
const dbmod = require('../db');

section('first-run seeding');
// db.js resolves paths at require time, so point it at the temp dir by copying
// the freshly-seeded DB out of the way is not possible — instead assert on the
// live instance, which init() has already seeded.
dbmod.init();
const db = dbmod.db;
const admins = db.prepare("SELECT username, password, must_change_password FROM users WHERE role='admin'").all();
ok('an admin account exists', admins.length >= 1);
const seeded = admins[0];
if (seeded) {
  ok('seeded password is hashed',        pw.isHashed(seeded.password));
  ok('seeded password is NOT admin1234',!pw.verify('admin1234', seeded.password));
  ok('seeded account must change pw',    !!seeded.must_change_password);
}

/* ── HTTP-level tests ── */
const repo = require('../repo');

// A known account with a known password, so login paths can be exercised.
const TEST_USER = 'testuser_' + Date.now().toString(36);
const TEST_PASS = 'Val1d&Passw0rd!';
ok('addUser accepts compliant password',
   repo.addUser({ username: TEST_USER, password: TEST_PASS, role: 'viewer', name: 'Test' },
                { mustChange: false, actor: 'test' }) === 'ok');
ok('addUser rejects weak password',
   String(repo.addUser({ username: TEST_USER + '_w', password: 'weak', role: 'viewer' })).startsWith('weak-password'));
ok('addUser rejects caller-supplied hash',
   repo.addUser({ username: TEST_USER + '_h', password: pw.hash('x'), role: 'admin' }) === 'weak-password:pre-hashed-not-allowed');

const PORT = 34567 + (process.pid % 1000);
process.env.PORT = String(PORT);
require('../../shell/server.js');

// CSRF-aware client: P2 requires an X-CSRF-Token on every state-changing call,
// so this behaves like a browser and attaches one. The CSRF protection itself is
// tested in test-security.js with a deliberately raw client.
const { request } = require('./_testhttp').makeClient(PORT);
const cookieOf = (res) => {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  const m = /kd_sid=([^;]*)/.exec(sc[0]);
  return m && m[1] ? 'kd_sid=' + m[1] : null;
};
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(400);   // let the listener bind

  section('login + session');
  let r = await request('POST', '/api/login', { username: TEST_USER, password: TEST_PASS });
  ok('valid credentials → 200', r.status === 200, 'got ' + r.status);
  const sid = cookieOf(r);
  ok('session cookie issued', !!sid);
  const setCookie = (r.headers['set-cookie'] || [''])[0];
  ok('cookie is HttpOnly',   /HttpOnly/i.test(setCookie));
  ok('cookie is SameSite=Strict', /SameSite=Strict/i.test(setCookie));
  ok('token is not the password', !!sid && !sid.includes(TEST_PASS));

  r = await request('GET', '/api/me', undefined, { Cookie: sid });
  ok('session resolves via /api/me', r.status === 200 && r.body.user.username === TEST_USER);

  r = await request('GET', '/api/me');
  ok('no cookie → 401', r.status === 401);

  section('user enumeration');
  const t0 = Date.now();
  r = await request('POST', '/api/login', { username: 'definitely_no_such_user', password: 'Val1d&Passw0rd!' });
  const dtUnknown = Date.now() - t0;
  ok('unknown user → 401', r.status === 401);
  ok('unknown user body is generic', JSON.stringify(r.body) === '{"ok":false}', r.raw);

  const t1 = Date.now();
  r = await request('POST', '/api/login', { username: TEST_USER, password: 'Wr0ng&Passw0rd!' });
  const dtKnown = Date.now() - t1;
  ok('bad password → 401', r.status === 401);
  ok('bad password body is generic', JSON.stringify(r.body) === '{"ok":false}', r.raw);
  // Both paths must hash. Allow a wide band — this is a smoke test for the
  // early-return oracle, not a statistical timing analysis.
  ok('unknown-user path still hashes (no timing oracle)',
     dtUnknown > dtKnown * 0.4, 'unknown=' + dtUnknown + 'ms known=' + dtKnown + 'ms');

  section('rate limiting — the map-flood bypass');
  // The original bug: >5000 distinct keys triggered _loginFails.clear(), wiping
  // every counter. Drive an account to its limit, then flood with junk
  // usernames, then confirm the account is STILL locked.
  const VICTIM = 'victim_' + Date.now().toString(36);
  repo.addUser({ username: VICTIM, password: 'V1ct1m&Passw0rd!', role: 'viewer' }, { mustChange: false, actor: 'test' });

  let locked = false;
  for (let i = 0; i < 12; i++) {
    const res = await request('POST', '/api/login', { username: VICTIM, password: 'bad-guess-' + i });
    if (res.status === 429) { locked = true; break; }
  }
  ok('account locks after repeated failures', locked);

  // Flood: distinct usernames, each also incrementing this IP's counter.
  for (let i = 0; i < 300; i++) {
    await request('POST', '/api/login', { username: 'flood_' + i, password: 'x' });
  }
  r = await request('POST', '/api/login', { username: VICTIM, password: 'V1ct1m&Passw0rd!' });
  ok('lockout SURVIVES the flood (bypass fixed)', r.status === 429, 'got ' + r.status);

  // The flood also drove this source IP past LOGIN_MAX_PER_IP, so loopback is
  // now throttled for everything — which is the per-IP spray limit doing its
  // job. Prove that, then reset the throttle so later sections can sign in.
  r = await request('POST', '/api/login', { username: TEST_USER, password: TEST_PASS });
  ok('per-IP limit blocks even a VALID login during a spray', r.status === 429, 'got ' + r.status);
  require('../../shell/server.js')._resetThrottle();
  r = await request('POST', '/api/login', { username: TEST_USER, password: TEST_PASS });
  ok('valid login works again after the window', r.status === 200, 'got ' + r.status);

  section('IP spoofing via X-Forwarded-For');
  // Requests here come from 127.0.0.1, which IS a trusted proxy by default, so
  // XFF is honoured — that is the configured topology. The security property
  // under test is that an UNTRUSTED peer cannot spoof. Assert the helper
  // directly, since the test client cannot originate from a non-loopback IP.
  const srv = require('../../shell/server.js');
  if (srv && srv._clientIp) {
    const fake = (peer, headers) => srv._clientIp({ socket: { remoteAddress: peer }, headers: headers });
    ok('untrusted peer: XFF ignored',
       fake('203.0.113.9', { 'x-forwarded-for': '1.2.3.4' }) === '203.0.113.9');
    ok('untrusted peer: CF-Connecting-IP ignored',
       fake('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4' }) === '203.0.113.9');
    ok('trusted peer: CF-Connecting-IP honoured',
       fake('127.0.0.1', { 'cf-connecting-ip': '5.6.7.8' }) === '5.6.7.8');
    ok('trusted peer: CF wins over XFF',
       fake('127.0.0.1', { 'cf-connecting-ip': '5.6.7.8', 'x-forwarded-for': '9.9.9.9' }) === '5.6.7.8');
    ok('v4-mapped loopback is trusted',
       fake('::ffff:127.0.0.1', { 'cf-connecting-ip': '5.6.7.8' }) === '5.6.7.8');
  } else {
    ok('server exports _clientIp for testing', false, 'not exported');
  }

  section('forced password change');
  const FORCED = 'forced_' + Date.now().toString(36);
  const FORCED_PW = 'Temp0rary&Pass!';
  repo.addUser({ username: FORCED, password: FORCED_PW, role: 'viewer' }, { actor: 'test' });   // mustChange defaults ON

  r = await request('POST', '/api/login', { username: FORCED, password: FORCED_PW });
  ok('flagged account can still sign in', r.status === 200);
  ok('login response signals mustChangePassword', r.body && r.body.mustChangePassword === true);
  const fsid = cookieOf(r);

  r = await request('GET', '/api/bootstrap', undefined, { Cookie: fsid });
  ok('flagged session is BLOCKED from the API', r.status === 403 && r.body.error === 'password-change-required',
     r.status + ' ' + r.raw);

  r = await request('GET', '/api/me', undefined, { Cookie: fsid });
  ok('flagged session may still call /me', r.status === 200);

  r = await request('POST', '/api/password', { current: 'wrong', next: 'An0ther&Passw0rd!' }, { Cookie: fsid });
  ok('change rejects wrong current password', r.status === 400 && r.body.error === 'bad-current');

  r = await request('POST', '/api/password', { current: FORCED_PW, next: 'short' }, { Cookie: fsid });
  ok('change rejects weak new password', r.status === 400 && String(r.body.error).startsWith('weak-password'));

  r = await request('POST', '/api/password', { current: FORCED_PW, next: FORCED_PW }, { Cookie: fsid });
  ok('change rejects reusing the same password', r.status === 400 && r.body.error === 'same-password');

  r = await request('POST', '/api/password', { current: FORCED_PW, next: 'An0ther&Passw0rd!' }, { Cookie: fsid });
  ok('valid change → 200', r.status === 200, r.raw);
  const rotated = cookieOf(r);
  ok('session cookie is rotated on change', !!rotated && rotated !== fsid);

  r = await request('GET', '/api/bootstrap', undefined, { Cookie: rotated });
  ok('rotated session can now reach the API', r.status === 200, r.status + ' ' + r.raw);

  r = await request('GET', '/api/bootstrap', undefined, { Cookie: fsid });
  ok('OLD session was revoked by the change', r.status === 401, 'got ' + r.status);

  section('audit log');
  const log = repo.getAuthLog({ limit: 1000 });
  const has = (action, result, user) =>
    log.some(e => e.action === action && e.result === result && (!user || e.username_attempted === user));

  ok('LOGIN/SUCCESS recorded',        has('LOGIN', 'SUCCESS', TEST_USER));
  ok('LOGIN/FAILURE recorded',        has('LOGIN', 'FAILURE', TEST_USER));
  ok('LOGIN/LOCKED recorded',         has('LOGIN', 'LOCKED', VICTIM));
  ok('SESSION_CREATE recorded',       has('SESSION_CREATE', 'SUCCESS', TEST_USER));
  ok('PASSWORD_CHANGE recorded',      has('PASSWORD_CHANGE', 'SUCCESS', FORCED));
  ok('USER_CREATE recorded',          has('USER_CREATE', 'SUCCESS', TEST_USER));
  ok('unknown-user attempt recorded', log.some(e => e.username_attempted === 'definitely_no_such_user' && e.reason === 'no-such-user'));
  ok('bad-password reason recorded',  log.some(e => e.username_attempted === TEST_USER && e.reason === 'bad-password'));
  // Only HTTP-originated events can have an IP. Rows written by CLI scripts and
  // by the test's own direct repo calls legitimately have none.
  ok('HTTP-originated entries carry an IP',
     log.filter(e => e.action === 'LOGIN' || e.action === 'LOGOUT')
        .every(e => !!e.ip_address));
  ok('entries carry a timestamp',     log.every(e => !!e.timestamp));

  // /api/auth-log is admin-only, and P3 requires admins to hold a second
  // factor. Give this one a passkey so it satisfies the policy, then complete
  // the two-step sign-in the way a real admin now does.
  const LOGADMIN = 'logadmin_' + Date.now().toString(36);
  repo.addUser({ username: LOGADMIN, password: TEST_PASS, role: 'admin', name: 'Log' }, { mustChange: false, actor: 'test' });
  const totpmod = require('../totp');
  const enrol = repo.beginTotpEnrolment(LOGADMIN);
  repo.confirmTotpEnrolment(LOGADMIN, totpmod.generate(enrol.secret), {});
  const step1 = await request('POST', '/api/login', { username: LOGADMIN, password: TEST_PASS });
  ok('admin login demands a second factor', step1.body.mfaRequired === true, step1.raw);
  dbmod.db.prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(LOGADMIN);
  const step2 = await request('POST', '/api/login/mfa', { mfaTicket: step1.body.mfaTicket, code: totpmod.generate(enrol.secret) });
  const adminSid = (function(){ for (const c of (step2.headers['set-cookie']||[])) { const m=/^kd_sid=([^;]*)/.exec(c); if(m) return m[1]; } return null; })();
  ok('admin completes MFA sign-in', step2.status === 200 && !!adminSid, step2.raw);
  r = await request('GET', '/api/auth-log?limit=5', undefined, { Cookie: 'kd_sid=' + adminSid });
  ok('admin can read /api/auth-log', r.status === 200 && Array.isArray(r.body.log), r.status + ' ' + r.raw);
  r = await request('GET', '/api/auth-log');
  ok('unauthenticated cannot read /api/auth-log', r.status === 401);

  section('logout');
  r = await request('POST', '/api/logout', {}, { Cookie: sid });
  ok('logout → 200', r.status === 200);
  r = await request('GET', '/api/me', undefined, { Cookie: sid });
  ok('session dead after logout', r.status === 401);
  ok('LOGOUT recorded', repo.getAuthLog({ limit: 1000 }).some(e => e.action === 'LOGOUT' && e.username_attempted === TEST_USER));

  section('backward compatibility');
  ok('bootstrap still serves the app', (await request('GET', '/api/bootstrap', undefined, { Cookie: rotated })).status === 200);
  const boot = (await request('GET', '/api/bootstrap', undefined, { Cookie: rotated })).body;
  ok('bootstrap shape unchanged', boot && boot.data && Array.isArray(boot.data.users) && 'me' in boot);
  ok('user list omits password hashes',
     boot.data.users.every(u => !('password' in u)), JSON.stringify(boot.data.users[0] || {}));
  ok('legacy plaintext account can still sign in + is upgraded', await (async () => {
    const LEG = 'legacy_' + Date.now().toString(36);
    db.prepare('INSERT INTO users (username,password,role,name,must_change_password) VALUES (?,?,?,?,0)')
      .run(LEG, 'admin1234', 'viewer', 'Legacy');
    const res = await request('POST', '/api/login', { username: LEG, password: 'admin1234' });
    if (res.status !== 200) return false;
    const after = db.prepare('SELECT password FROM users WHERE username=?').get(LEG).password;
    return pw.isHashed(after) && !pw.needsRehash(after);
  })());

  /* ── Report ── */
  const bar = '='.repeat(66);
  console.log('\n' + bar);
  console.log('  RESULT: ' + passed + ' passed, ' + failed + ' failed');
  console.log(bar);
  if (failed) {
    console.log('  Failures:');
    failures.forEach(f => console.log('    - ' + f));
    console.log(bar);
  }
  console.log('');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('\nTest harness crashed:', err && err.stack || err);
  process.exit(1);
});
