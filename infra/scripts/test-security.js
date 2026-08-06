'use strict';
/**
 * infra/scripts/test-security.js — P2 suite: CSRF, origin validation, CSP,
 * security headers, Clear-Site-Data.
 *
 *   npm run test-security
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * Every CSRF/origin test is written as the ATTACK, not the happy path: the
 * assertion is that the forged request is refused. A suite that only proves the
 * legitimate client still works would pass just as happily with the protection
 * deleted.
 */
const http = require('node:http');
const os   = require('node:os');
const path = require('node:path');
const fs   = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-sec-test-'));
process.env.KD_DATA_DIR = TMP;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

const dbmod = require('../db');
dbmod.init();
const repo = require('../repo');

const USER = 'p2user_' + Date.now().toString(36);
const PASS = 'CsrfT3st&Pass!x';
repo.addUser({ username: USER, password: PASS, role: 'admin', name: 'P2' },
             { mustChange: false, actor: 'test' });
// Satisfy the P3 MFA policy for this admin: enrol TOTP, then mark the device
// trusted so /api/login still completes in ONE step and the CSRF assertions
// below stay focused on CSRF rather than on the second factor.
const totpmod = require('../totp');
const P2_ENROL = repo.beginTotpEnrolment(USER);
repo.confirmTotpEnrolment(USER, totpmod.generate(P2_ENROL.secret), {});
const P2_TRUST = repo.trustDevice(USER, { ip: '127.0.0.1', userAgent: 'test' });

const PORT = 36400 + (process.pid % 400);
process.env.PORT = String(PORT);
require('../../shell/server.js');

const HOST = '127.0.0.1:' + PORT;
function request(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({},
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers || {}),
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const cookieVal = (res, name) => {
  const sc = res.headers['set-cookie'] || [];
  for (const c of sc) { const m = new RegExp('^' + name + '=([^;]*)').exec(c); if (m) return m[1]; }
  return null;
};
const cookieAttrs = (res, name) => {
  const sc = res.headers['set-cookie'] || [];
  return sc.find(c => c.startsWith(name + '=')) || '';
};

(async () => {
  await new Promise(r => setTimeout(r, 400));

  /* ── Task 4: security headers ── */
  section('Task 4 — security headers');
  let r = await request('GET', '/api/health');
  const H = r.headers;
  ok('X-Content-Type-Options: nosniff',        H['x-content-type-options'] === 'nosniff', H['x-content-type-options']);
  ok('Cross-Origin-Opener-Policy: same-origin',H['cross-origin-opener-policy'] === 'same-origin', H['cross-origin-opener-policy']);
  ok('Cross-Origin-Resource-Policy: same-origin', H['cross-origin-resource-policy'] === 'same-origin', H['cross-origin-resource-policy']);
  ok('Strict-Transport-Security present',      /max-age=31536000/.test(H['strict-transport-security'] || ''), H['strict-transport-security']);
  ok('HSTS includeSubDomains',                 /includeSubDomains/.test(H['strict-transport-security'] || ''));
  ok('X-Frame-Options present',                !!H['x-frame-options'], H['x-frame-options']);
  ok('Referrer-Policy strict-origin-when-cross-origin', H['referrer-policy'] === 'strict-origin-when-cross-origin', H['referrer-policy']);
  ok('Permissions-Policy present',             !!H['permissions-policy']);
  ok('Content-Security-Policy present',        !!H['content-security-policy']);

  /* ── Task 3: CSP ── */
  section('Task 3 — CSP hardening');
  const appCsp   = (await request('GET', '/index.html')).headers['content-security-policy'] || '';
  const loginRes = await request('GET', '/shell/pages/login.html');
  const loginCsp = loginRes.headers['content-security-policy'] || '';

  ok('login page served',                       loginRes.status === 200, 'status ' + loginRes.status);
  ok('login CSP has NO unsafe-inline',         !/unsafe-inline/.test(loginCsp), loginCsp);
  ok('login CSP has NO unsafe-eval',           !/unsafe-eval/.test(loginCsp), loginCsp);
  ok("login CSP: default-src 'self'",           /default-src 'self'/.test(loginCsp));
  ok("login CSP: script-src 'self' (exactly)",  /script-src 'self'(;|$)/.test(loginCsp), loginCsp);
  ok("login CSP: style-src 'self' (exactly)",   /style-src 'self'(;|$)/.test(loginCsp), loginCsp);
  ok("login CSP: img-src 'self' data:",         /img-src 'self' data:/.test(loginCsp));
  ok("login CSP: frame-ancestors 'none'",       /frame-ancestors 'none'/.test(loginCsp));
  ok('login page gets X-Frame-Options: DENY',   loginRes.headers['x-frame-options'] === 'DENY', loginRes.headers['x-frame-options']);
  ok('app shell keeps its relaxed CSP',         /unsafe-inline/.test(appCsp), 'app CSP must stay permissive or the UI breaks');
  ok('login and app CSPs genuinely differ',     loginCsp !== appCsp);

  section('Task 3 — login page is inline-free');
  const html = loginRes.raw;
  ok('no inline <style> block',   !/<style[\s>]/.test(html));
  ok('no inline <script> block',  !/<script>/.test(html));
  ok('no on*= handler attributes', !/\son(click|submit|change|input|load|error)\s*=/i.test(html),
     (html.match(/\son[a-z]+\s*=/gi) || []).slice(0, 5).join(' '));
  ok('no style= attributes',      !/<[^>]+\sstyle\s*=/.test(html));
  ok('links to external login.css', /href="[^"]*login\.css"/.test(html));
  ok('links to external login.js',  /src="[^"]*login\.js"/.test(html));
  ok('login.css is served',       (await request('GET', '/shell/styles/login.css')).status === 200);
  ok('login.js is served',        (await request('GET', '/shell/scripts/login.js')).status === 200);

  /* ── Task 1: CSRF ── */
  section('Task 1 — CSRF: unauthenticated (login)');
  r = await request('GET', '/api/csrf');
  ok('GET /api/csrf → 200',            r.status === 200 && !!r.body.csrfToken);
  const preTok = r.body.csrfToken;
  const preCookie = cookieVal(r, 'kd_csrf');
  ok('csrf cookie issued',             !!preCookie);
  ok('cookie matches returned token',  preCookie === preTok);
  ok('csrf cookie is SameSite=Strict', /SameSite=Strict/i.test(cookieAttrs(r, 'kd_csrf')));
  ok('csrf cookie is NOT HttpOnly (page JS must read it)',
     !/HttpOnly/i.test(cookieAttrs(r, 'kd_csrf')));

  // THE ATTACK: a forged cross-site login POST carries the cookie but no header.
  r = await request('POST', '/api/login', { username: USER, password: PASS },
                    { Cookie: 'kd_csrf=' + preCookie });
  ok('login WITHOUT csrf header → 403', r.status === 403 && r.body.error === 'csrf-failed', r.status + ' ' + r.raw);
  ok('reason is csrf-token-missing',    r.body.reason === 'csrf-token-missing', r.body.reason);

  r = await request('POST', '/api/login', { username: USER, password: PASS },
                    { Cookie: 'kd_csrf=' + preCookie, 'X-CSRF-Token': 'wrong-value-entirely' });
  ok('login with WRONG csrf token → 403', r.status === 403 && r.body.reason === 'csrf-token-invalid', r.raw);

  r = await request('POST', '/api/login', { username: USER, password: PASS },
                    { 'X-CSRF-Token': preTok });
  ok('header without the matching cookie → 403', r.status === 403, r.status + ' ' + r.raw);

  // Legitimate: header AND cookie agree.
  r = await request('POST', '/api/login', { username: USER, password: PASS },
                    { Cookie: 'kd_csrf=' + preCookie + '; kd_trust=' + P2_TRUST.token, 'X-CSRF-Token': preTok });
  ok('login with valid double-submit → 200', r.status === 200, r.status + ' ' + r.raw);
  const sid  = cookieVal(r, 'kd_sid');
  const csrf = cookieVal(r, 'kd_csrf');
  ok('session cookie issued',              !!sid);
  ok('CSRF token ROTATED on login',        !!csrf && csrf !== preTok);
  ok('login response carries the new token', r.body.csrfToken === csrf);
  const AUTH = { Cookie: 'kd_sid=' + sid + '; kd_csrf=' + csrf, 'X-CSRF-Token': csrf };
  const NOCSRF = { Cookie: 'kd_sid=' + sid + '; kd_csrf=' + csrf };

  section('Task 1 — CSRF: authenticated (server-side token)');
  ok('pre-session token no longer works',
     (await request('POST', '/api/logout-all', { keepCurrent: true },
        { Cookie: 'kd_sid=' + sid, 'X-CSRF-Token': preTok })).status === 403);

  // Each protected surface, attacked then exercised.
  const surfaces = [
    ['password change', 'POST',   '/api/password', { current: 'x', next: 'y' }],
    ['user management', 'POST',   '/api/users',    { username: 'x', password: 'y', role: 'viewer' }],
    ['user delete',     'DELETE', '/api/users/nobody', undefined],
    ['employee update', 'PATCH',  '/api/employees/none', { en_name: 'x' }],
    ['group create',    'POST',   '/api/groups',   { id: 'g1', name: 'G' }],
    ['logout',          'POST',   '/api/logout',   {}],
    ['logout-all',      'POST',   '/api/logout-all', {}],
    ['session revoke',  'DELETE', '/api/sessions/1', undefined],
    ['settings',        'POST',   '/api/settings', { key: 'k', value: 'v' }],
    ['import',          'POST',   '/api/import',   {}],
  ];
  for (const [label, method, p, b] of surfaces) {
    const res = await request(method, p, b, NOCSRF);
    ok(label + ' blocked without CSRF token', res.status === 403 && res.body && res.body.error === 'csrf-failed',
       res.status + ' ' + res.raw.slice(0, 90));
  }

  ok('GET is never CSRF-checked', (await request('GET', '/api/me', undefined, NOCSRF)).status === 200);
  ok('valid token still permits a write',
     (await request('POST', '/api/settings', { key: 'p2test', value: '1' }, AUTH)).status === 200);

  section('Task 1 — Bearer clients are exempt (no ambient credentials)');
  ok('Bearer without CSRF header works',
     (await request('POST', '/api/settings', { key: 'p2bearer', value: '1' },
        { Authorization: 'Bearer ' + sid })).status === 200);

  /* ── Task 2: origin validation ── */
  section('Task 2 — Origin / Sec-Fetch-Site validation');
  r = await request('POST', '/api/settings', { key: 'x', value: '1' },
                    Object.assign({}, AUTH, { Origin: 'https://evil.example.com' }));
  ok('cross-origin Origin → 403', r.status === 403 && r.body.error === 'cross-site-request-blocked', r.raw);
  ok('reason is origin-mismatch', r.body.reason === 'origin-mismatch', r.body.reason);

  r = await request('POST', '/api/settings', { key: 'x', value: '1' },
                    Object.assign({}, AUTH, { 'Sec-Fetch-Site': 'cross-site' }));
  ok('Sec-Fetch-Site: cross-site → 403', r.status === 403 && /sec-fetch-site/.test(r.body.reason || ''), r.raw);

  r = await request('POST', '/api/settings', { key: 'x', value: '1' },
                    Object.assign({}, AUTH, { 'Sec-Fetch-Site': 'same-site' }));
  ok('Sec-Fetch-Site: same-site → 403 (subdomain is not same-origin)', r.status === 403, r.raw);

  r = await request('POST', '/api/settings', { key: 'x', value: '1' },
                    Object.assign({}, AUTH, { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://' + HOST }));
  ok('same-origin Origin + Sec-Fetch-Site → 200', r.status === 200, r.raw);

  r = await request('POST', '/api/settings', { key: 'x', value: '1' },
                    Object.assign({}, AUTH, { 'Sec-Fetch-Site': 'none' }));
  ok("Sec-Fetch-Site: none (direct navigation) allowed", r.status === 200, r.raw);

  ok('origin check runs BEFORE authentication (unauthenticated login too)',
     (await request('POST', '/api/login', { username: USER, password: PASS },
        { Origin: 'https://evil.example.com' })).status === 403);

  section('Origin/CSRF failures are audited');
  const alog = repo.getAuthLog({ limit: 200 });
  ok('cross-site rejection logged', alog.some(e => /cross-site request rejected/.test(e.reason || '')));
  ok('CSRF failure logged',         alog.some(e => /CSRF check failed/.test(e.reason || '')));

  /* ── Task 5: Clear-Site-Data ── */
  section('Task 5 — Clear-Site-Data on logout');
  r = await request('POST', '/api/logout', {}, AUTH);
  ok('logout → 200', r.status === 200, r.raw);
  const csd = r.headers['clear-site-data'] || '';
  ok('Clear-Site-Data sent',        !!csd, csd);
  ok('includes "cookies"',          /"cookies"/.test(csd), csd);
  ok('includes "storage"',          /"storage"/.test(csd), csd);
  ok('session cookie cleared',      /kd_sid=;/.test((r.headers['set-cookie'] || []).join(' ')));
  ok('csrf cookie cleared',         /kd_csrf=;/.test((r.headers['set-cookie'] || []).join(' ')));
  ok('session really is dead',      (await request('GET', '/api/me', undefined, AUTH)).status === 401);

  /* ── Backward compatibility ── */
  section('backward compatibility');
  const c2 = await request('GET', '/api/csrf');
  const t2 = c2.body.csrfToken, k2 = cookieVal(c2, 'kd_csrf');
  const lg = await request('POST', '/api/login', { username: USER, password: PASS },
                           { Cookie: 'kd_csrf=' + k2 + '; kd_trust=' + P2_TRUST.token, 'X-CSRF-Token': t2 });
  const s2 = cookieVal(lg, 'kd_sid'), x2 = cookieVal(lg, 'kd_csrf');
  const A2 = { Cookie: 'kd_sid=' + s2 + '; kd_csrf=' + x2, 'X-CSRF-Token': x2 };
  ok('login still works',      lg.status === 200);
  ok('bootstrap still works',  (await request('GET', '/api/bootstrap', undefined, A2)).status === 200);
  ok('sessions API still works',(await request('GET', '/api/sessions', undefined, A2)).status === 200);
  ok('auth-log still works',   (await request('GET', '/api/auth-log?limit=5', undefined, A2)).status === 200);
  ok('health is unauthenticated', (await request('GET', '/api/health')).status === 200);
  ok('sessions carry a csrf_token column',
     dbmod.db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'csrf_token'));
  ok('pre-P2 session gets a token lazily', (() => {
    const t = repo.createSession(USER, false, {}).token;
    dbmod.db.prepare('UPDATE sessions SET csrf_token=NULL WHERE token_hash=(SELECT token_hash FROM sessions ORDER BY id DESC LIMIT 1)').run();
    const minted = repo.ensureCsrfToken(t);
    return !!minted && repo.verifyCsrfToken(t, minted);
  })());

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
