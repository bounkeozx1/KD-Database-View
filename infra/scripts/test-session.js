'use strict';
/**
 * infra/scripts/test-session.js — P1 session-security test suite.
 *
 *   npm run test-session
 *
 * Runs against a THROWAWAY database in the OS temp dir; the live kd.db is never
 * opened. Time-based rules (30-minute idle, 30-day absolute lifetime) are tested
 * by rewriting the stored timestamps rather than by waiting — the rule under
 * test is "what does the server do when last_seen/created_at is old", and that
 * is exactly what backdating produces.
 */
const http = require('node:http');
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-sess-test-'));
process.env.KD_DATA_DIR = TMP;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

/* ── Task 5: device-name helper (pure, no DB) ── */
const device = require('../device');
section('Task 5 — device name helper');
const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  edgeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0 Mobile Safari/537.36',
};
ok('Chrome · Windows',  device.deviceName(UA.chromeWin) === 'Chrome · Windows', device.deviceName(UA.chromeWin));
ok('Chrome · Android',  device.deviceName(UA.chromeAndroid) === 'Chrome · Android', device.deviceName(UA.chromeAndroid));
ok('Safari · iPhone',   device.deviceName(UA.safariIphone) === 'Safari · iPhone', device.deviceName(UA.safariIphone));
ok('Edge beats Chrome', device.deviceName(UA.edgeWin) === 'Edge · Windows', device.deviceName(UA.edgeWin));
ok('Firefox · macOS',   device.deviceName(UA.firefoxMac) === 'Firefox · macOS', device.deviceName(UA.firefoxMac));
ok('Samsung Internet beats Chrome', device.deviceName(UA.samsung) === 'Samsung Internet · Android', device.deviceName(UA.samsung));
ok('empty UA is safe',  device.deviceName('') === 'Unknown device');
ok('null UA is safe',   device.deviceName(null) === 'Unknown device');
ok('output is whitelisted (no injection)',
   device.deviceName('<script>alert(1)</script>') === 'Unknown device');

/* ── Boot ── */
const dbmod = require('../db');
dbmod.init();
const db   = dbmod.db;
const repo = require('../repo');
const pw   = require('../password');

section('Task 1 — token hashing at rest');
const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
ok('sessions has token_hash',  cols.includes('token_hash'));
ok('sessions has NO raw token', !cols.includes('token'));
['id', 'user_id', 'ip', 'user_agent', 'device_name', 'created_at', 'last_seen', 'expires_at']
  .forEach(c => ok('sessions has ' + c, cols.includes(c)));

const ADMIN = 'p1admin_' + Date.now().toString(36);
const PASS  = 'S3ss10n&Test!x';
repo.addUser({ username: ADMIN, password: PASS, role: 'admin', name: 'P1 Admin' },
             { mustChange: false, actor: 'test' });

const s1 = repo.createSession(ADMIN, false, { ip: '10.0.0.1', userAgent: UA.chromeWin });
const stored = db.prepare('SELECT token_hash, device_name, ip, user_agent FROM sessions WHERE username=?').get(ADMIN);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
ok('stored value is sha256(token)', stored.token_hash === sha(s1.token));
ok('raw token appears nowhere in the row', JSON.stringify(stored).indexOf(s1.token) === -1);
ok('token is 64 hex chars (256 bit)', /^[0-9a-f]{64}$/.test(s1.token));
ok('device_name recorded', stored.device_name === 'Chrome · Windows', stored.device_name);
ok('ip recorded', stored.ip === '10.0.0.1');
ok('resolveSession accepts the raw token', repo.resolveSession(s1.token).ok);
ok('resolveSession rejects the HASH as a token', !repo.resolveSession(stored.token_hash).ok);
ok('a leaked DB row cannot be replayed',
   repo.resolveSession(stored.token_hash).reason === 'unknown-session');
ok('unknown token rejected', repo.resolveSession('deadbeef').reason === 'unknown-session');
ok('empty token rejected',   repo.resolveSession('').reason === 'no-token');

section('Task 2 — idle timeout (role-based)');
ok('admin policy = 30 min / 2 devices',
   repo.policyFor('admin').idleMs === 30 * 60000 && repo.policyFor('admin').maxDevices === 2);
ok('manager policy = 60 min / 3 devices',
   repo.policyFor('manager').idleMs === 60 * 60000 && repo.policyFor('manager').maxDevices === 3);
ok('employee policy = 120 min / 5 devices',
   repo.policyFor('employee').idleMs === 120 * 60000 && repo.policyFor('employee').maxDevices === 5);
ok('viewer mapped to employee tier', repo.policyFor('viewer').idleMs === 120 * 60000);
ok('unknown role fails CLOSED (strictest)', repo.policyFor('nonsense').idleMs === 30 * 60000);

// Backdate last_seen past the admin idle window.
const backdate = (token, field, ms) => {
  db.prepare('UPDATE sessions SET ' + field + '=? WHERE token_hash=?')
    .run(new Date(Date.now() - ms).toISOString(), sha(token));
};
const idleTok = repo.createSession(ADMIN, false, { ip: '10.0.0.2', userAgent: UA.chromeWin }).token;
ok('fresh session is alive', repo.resolveSession(idleTok).ok);
backdate(idleTok, 'last_seen', 29 * 60000);
ok('29 min idle: still alive (admin limit 30)', repo.resolveSession(idleTok).ok);
backdate(idleTok, 'last_seen', 31 * 60000);
const idleRes = repo.resolveSession(idleTok, { ip: '10.0.0.2' });
ok('31 min idle: revoked', !idleRes.ok && idleRes.reason === 'idle-timeout', JSON.stringify(idleRes));
ok('idle session is DELETED, not just rejected',
   !db.prepare('SELECT 1 FROM sessions WHERE token_hash=?').get(sha(idleTok)));
ok('idle timeout audited',
   repo.getAuthLog({ limit: 50 }).some(e => e.action === 'SESSION_EXPIRE' && /idle-timeout/.test(e.reason || '')));

// A viewer gets 120 minutes, so 31 minutes must NOT kill it — proves the limit
// is genuinely per-role and not a single global constant.
const VIEWER = 'p1viewer_' + Date.now().toString(36);
repo.addUser({ username: VIEWER, password: PASS, role: 'viewer', name: 'P1 Viewer' },
             { mustChange: false, actor: 'test' });
const vTok = repo.createSession(VIEWER, false, { ip: '10.0.0.3', userAgent: UA.safariIphone }).token;
backdate(vTok, 'last_seen', 31 * 60000);
ok('viewer at 31 min idle: still alive (limit 120)', repo.resolveSession(vTok).ok);
backdate(vTok, 'last_seen', 121 * 60000);
ok('viewer at 121 min idle: revoked', repo.resolveSession(vTok).reason === 'idle-timeout');

section('Task 3 — absolute lifetime (30 days)');
const absTok = repo.createSession(ADMIN, true, { ip: '10.0.0.4', userAgent: UA.chromeWin }).token;
// Keep it "active" so only the absolute rule can end it.
db.prepare('UPDATE sessions SET created_at=?, last_seen=?, expires_at=? WHERE token_hash=?')
  .run(new Date(Date.now() - 31 * 86400000).toISOString(),
       new Date().toISOString(),
       new Date(Date.now() + 86400000).toISOString(),
       sha(absTok));
const absRes = repo.resolveSession(absTok, { ip: '10.0.0.4' });
ok('31-day-old session revoked despite activity', !absRes.ok && absRes.reason === 'absolute-lifetime', JSON.stringify(absRes));
ok('absolute lifetime audited',
   repo.getAuthLog({ limit: 50 }).some(e => e.action === 'SESSION_EXPIRE' && /absolute-lifetime/.test(e.reason || '')));

const okTok = repo.createSession(ADMIN, true, { ip: '10.0.0.5', userAgent: UA.chromeWin }).token;
db.prepare('UPDATE sessions SET created_at=? WHERE token_hash=?')
  .run(new Date(Date.now() - 29 * 86400000).toISOString(), sha(okTok));
ok('29-day-old session survives', repo.resolveSession(okTok).ok);
ok('remember-me never exceeds the 30-day ceiling',
   Date.parse(repo.createSession(ADMIN, true, {}).expiresAt) - Date.now() <= repo.ABSOLUTE_MAX_MS + 1000);

section('Task 4 — concurrent session limit');
db.prepare('DELETE FROM sessions WHERE username=?').run(ADMIN);
const t1 = repo.createSession(ADMIN, false, { ip: '10.1.0.1', userAgent: UA.chromeWin }).token;
const t2 = repo.createSession(ADMIN, false, { ip: '10.1.0.2', userAgent: UA.firefoxMac }).token;
ok('admin: 2 devices allowed', repo.resolveSession(t1).ok && repo.resolveSession(t2).ok);
const t3 = repo.createSession(ADMIN, false, { ip: '10.1.0.3', userAgent: UA.safariIphone }).token;
ok('admin: 3rd device evicts the OLDEST', !repo.resolveSession(t1).ok, 't1 should be gone');
ok('admin: newest two survive', repo.resolveSession(t2).ok && repo.resolveSession(t3).ok);
ok('admin: never more than 2 rows',
   db.prepare('SELECT COUNT(*) c FROM sessions WHERE username=?').get(ADMIN).c === 2);
ok('eviction audited',
   repo.getAuthLog({ limit: 80 }).some(e => /concurrent-session-limit/.test(e.reason || '')));

db.prepare('DELETE FROM sessions WHERE username=?').run(VIEWER);
const vt = [];
for (let i = 0; i < 6; i++) vt.push(repo.createSession(VIEWER, false, { ip: '10.2.0.' + i, userAgent: UA.chromeWin }).token);
ok('viewer: capped at 5 devices',
   db.prepare('SELECT COUNT(*) c FROM sessions WHERE username=?').get(VIEWER).c === 5);
ok('viewer: oldest evicted, newest kept', !repo.resolveSession(vt[0]).ok && repo.resolveSession(vt[5]).ok);

/* ── HTTP-level: Tasks 6 & 7 ── */
const PORT = 35800 + (process.pid % 500);
process.env.PORT = String(PORT);
require('../../shell/server.js');

// CSRF-aware client — see test-auth.js. CSRF itself is tested in test-security.js.
const { request } = require('./_testhttp').makeClient(PORT);
const cookieOf = (res) => {
  const sc = res.headers['set-cookie'];
  if (!sc) return null;
  const m = /kd_sid=([^;]*)/.exec(sc[0]);
  return m && m[1] ? 'kd_sid=' + m[1] : null;
};
const rawOf = (c) => (c || '').replace(/^kd_sid=/, '');

(async () => {
  await new Promise(r => setTimeout(r, 400));

  section('Task 7 — GET /api/sessions');
  db.prepare('DELETE FROM sessions WHERE username=?').run(ADMIN);
  let r = await request('POST', '/api/login', { username: ADMIN, password: PASS },
                        { 'User-Agent': UA.chromeWin });
  ok('login ok', r.status === 200, r.raw);
  const cookieA = cookieOf(r);
  // Second device for the same account.
  r = await request('POST', '/api/login', { username: ADMIN, password: PASS },
                    { 'User-Agent': UA.safariIphone });
  const cookieB = cookieOf(r);

  r = await request('GET', '/api/sessions', undefined, { Cookie: cookieA, 'User-Agent': UA.chromeWin });
  ok('GET /api/sessions → 200', r.status === 200, r.raw);
  const list = (r.body && r.body.sessions) || [];
  ok('returns both devices', list.length === 2, 'got ' + list.length);
  ok('shape matches spec',
     list.every(s => 'id' in s && 'device_name' in s && 'ip' in s && 'created_at' in s && 'last_seen' in s && 'current' in s),
     JSON.stringify(list[0]));
  ok('exactly one is marked current', list.filter(s => s.current).length === 1);
  ok('current device is the caller', (list.find(s => s.current) || {}).device_name === 'Chrome · Windows');
  ok('other device identified', list.some(s => s.device_name === 'Safari · iPhone'));
  ok('token_hash is NEVER returned', !/token_hash/.test(r.raw) && !r.raw.includes(sha(rawOf(cookieA))));
  r = await request('GET', '/api/sessions');
  ok('unauthenticated → 401', r.status === 401);

  section('Task 7 — DELETE /api/sessions/:id');
  const other = list.find(s => !s.current);
  r = await request('DELETE', '/api/sessions/' + other.id, undefined, { Cookie: cookieA });
  ok('revoke other device → 200', r.status === 200, r.raw);
  r = await request('GET', '/api/me', undefined, { Cookie: cookieB });
  ok('revoked device is signed out', r.status === 401);
  r = await request('GET', '/api/me', undefined, { Cookie: cookieA });
  ok('caller still signed in', r.status === 200);

  // Ownership boundary: another account must not be able to revoke this one's.
  const OTHERU = 'p1other_' + Date.now().toString(36);
  repo.addUser({ username: OTHERU, password: PASS, role: 'admin', name: 'Other' }, { mustChange: false, actor: 'test' });
  r = await request('POST', '/api/login', { username: OTHERU, password: PASS }, { 'User-Agent': UA.firefoxMac });
  const cookieO = cookieOf(r);
  const mine = ((await request('GET', '/api/sessions', undefined, { Cookie: cookieA })).body.sessions || [])[0];
  r = await request('DELETE', '/api/sessions/' + mine.id, undefined, { Cookie: cookieO });
  ok('cannot revoke ANOTHER account\'s session', r.status === 404, r.status + ' ' + r.raw);
  ok('victim session still alive',
     (await request('GET', '/api/me', undefined, { Cookie: cookieA })).status === 200);

  section('Task 6 — POST /api/logout-all');
  db.prepare('DELETE FROM sessions WHERE username=?').run(ADMIN);
  const c1 = cookieOf(await request('POST', '/api/login', { username: ADMIN, password: PASS }, { 'User-Agent': UA.chromeWin }));
  const c2 = cookieOf(await request('POST', '/api/login', { username: ADMIN, password: PASS }, { 'User-Agent': UA.safariIphone }));

  r = await request('POST', '/api/logout-all', { keepCurrent: true }, { Cookie: c2 });
  ok('logout-all (keepCurrent) → 200', r.status === 200, r.raw);
  ok('reports how many were revoked', r.body.revoked === 1, JSON.stringify(r.body));
  ok('current device kept', (await request('GET', '/api/me', undefined, { Cookie: c2 })).status === 200);
  ok('other device signed out', (await request('GET', '/api/me', undefined, { Cookie: c1 })).status === 401);

  r = await request('POST', '/api/logout-all', { keepCurrent: false }, { Cookie: c2 });
  ok('logout-all (keepCurrent:false) → 200', r.status === 200);
  ok('current device also signed out', (await request('GET', '/api/me', undefined, { Cookie: c2 })).status === 401);
  ok('no sessions remain', db.prepare('SELECT COUNT(*) c FROM sessions WHERE username=?').get(ADMIN).c === 0);
  ok('LOGOUT_ALL audited',
     repo.getAuthLog({ limit: 100 }).some(e => e.action === 'LOGOUT_ALL' && e.result === 'SUCCESS'));

  section('401 reason surfaced to the client');
  const rt = repo.createSession(ADMIN, false, { ip: '10.9.9.9', userAgent: UA.chromeWin }).token;
  backdate(rt, 'last_seen', 45 * 60000);
  r = await request('GET', '/api/me', undefined, { Cookie: 'kd_sid=' + rt });
  ok('idle 401 carries reason=idle-timeout', r.status === 401 && r.body.reason === 'idle-timeout', r.raw);
  r = await request('GET', '/api/me');
  ok('no-cookie 401 carries reason=no-token', r.status === 401 && r.body.reason === 'no-token', r.raw);

  section('backward compatibility');
  ok('P0 login flow unchanged',
     (await request('POST', '/api/login', { username: ADMIN, password: PASS })).status === 200);
  const okc = cookieOf(await request('POST', '/api/login', { username: ADMIN, password: PASS }));

  /* P3 blocks an admin with no second factor from the API, so `okc` above can
   * open a session but not use it. bootstrap needs only *a* signed-in account →
   * use the viewer. auth-log is admin-only → build an admin that satisfies the
   * MFA policy and sign it in through both steps, as a real admin now does. */
  const vsess = cookieOf(await request('POST', '/api/login', { username: VIEWER, password: PASS }));
  ok('bootstrap still works', (await request('GET', '/api/bootstrap', undefined, { Cookie: vsess })).status === 200);

  const totpmod = require('../totp');
  const LOGADMIN = 'p1logadmin_' + Date.now().toString(36);
  repo.addUser({ username: LOGADMIN, password: PASS, role: 'admin', name: 'Log' }, { mustChange: false, actor: 'test' });
  const enrol = repo.beginTotpEnrolment(LOGADMIN);
  repo.confirmTotpEnrolment(LOGADMIN, totpmod.generate(enrol.secret), {});
  const s1 = await request('POST', '/api/login', { username: LOGADMIN, password: PASS });
  db.prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(LOGADMIN);
  const s2 = await request('POST', '/api/login/mfa',
    { mfaTicket: s1.body.mfaTicket, code: totpmod.generate(enrol.secret) });
  ok('auth-log still works',
     (await request('GET', '/api/auth-log?limit=5', undefined, { Cookie: cookieOf(s2) })).status === 200,
     s2.raw.slice(0, 120));
  ok('password change still works',
     (await request('POST', '/api/password', { current: PASS, next: 'N3wS3ss10n&Pass!' }, { Cookie: okc })).status === 200);
  ok('sessionUser() wrapper still returns a user or null',
     (() => { const t = repo.createSession(VIEWER, false, {}).token;
              const u = repo.sessionUser(t);
              return u && u.username === VIEWER && repo.sessionUser('nope') === null; })());

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
