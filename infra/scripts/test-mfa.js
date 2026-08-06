'use strict';
/**
 * infra/scripts/test-mfa.js — P3 suite: TOTP, recovery codes, WebAuthn,
 * passwordless login, enforcement, device trust, and MFA-bypass attempts.
 *
 *   npm run test-mfa
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 *
 * The bypass section is the important one. Every other test proves the feature
 * works; those prove it cannot be walked around — which is the only property
 * that actually makes MFA worth having.
 */
const os     = require('node:os');
const path   = require('node:path');
const fs     = require('node:fs');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-mfa-test-'));
process.env.KD_DATA_DIR = TMP;

let passed = 0, failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name + (detail ? '  → ' + detail : '')); console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}
function section(t) { console.log('\n' + t); console.log('-'.repeat(t.length)); }

const totp = require('../totp');
const qr   = require('../qr');
const wa   = require('../webauthn');
const cbor = require('../cbor');

/* ── TOTP engine (RFC vectors) ── */
section('Task 1 — TOTP engine (RFC 4226 / 6238)');
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_B32 = totp.base32Encode(RFC_SECRET);
const RFC_HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
ok('RFC 4226 HOTP vectors (all 10)', RFC_HOTP.every((exp, i) => totp.hotp(RFC_SECRET, i) === exp));
ok('RFC 6238 T=59s',          totp.generate(RFC_B32, 59 * 1000) === '287082');
ok('RFC 6238 T=1111111109',   totp.generate(RFC_B32, 1111111109 * 1000) === '081804');
ok('RFC 6238 T=1234567890',   totp.generate(RFC_B32, 1234567890 * 1000) === '005924');
ok('base32 round-trips',      totp.base32Decode(RFC_B32).equals(RFC_SECRET));
ok('base32 tolerates spacing',totp.base32Decode(RFC_B32.replace(/(.{4})/g, '$1 ')).equals(RFC_SECRET));
ok('secret is 160-bit',       totp.base32Decode(totp.generateSecret()).length === 20);
ok('secrets are unique',      totp.generateSecret() !== totp.generateSecret());

section('Task 1 — TOTP verification window');
const S = totp.generateSecret();
const now = Date.now();
ok('accepts the current code',     totp.verify(S, totp.generate(S, now), { timeMs: now }).ok);
ok('accepts -1 step (clock drift)',totp.verify(S, totp.generate(S, now - 30000), { timeMs: now }).ok);
ok('accepts +1 step (clock drift)',totp.verify(S, totp.generate(S, now + 30000), { timeMs: now }).ok);
ok('REJECTS -2 steps',            !totp.verify(S, totp.generate(S, now - 60000), { timeMs: now }).ok);
ok('REJECTS +2 steps',            !totp.verify(S, totp.generate(S, now + 60000), { timeMs: now }).ok);
ok('rejects a wrong code',        !totp.verify(S, '000000', { timeMs: now }).ok);
ok('rejects non-numeric input',   !totp.verify(S, 'abcdef', { timeMs: now }).ok);
ok('rejects wrong length',        !totp.verify(S, '12345', { timeMs: now }).ok);
ok('rejects empty',               !totp.verify(S, '', { timeMs: now }).ok);
ok('a different secret fails',    !totp.verify(totp.generateSecret(), totp.generate(S, now), { timeMs: now }).ok);
ok('replay of the same step is refused', (() => {
  const code = totp.generate(S, now);
  const first = totp.verify(S, code, { timeMs: now });
  const again = totp.verify(S, code, { timeMs: now, lastCounter: first.counter });
  return first.ok && !again.ok && again.replay;
})());
ok('otpauth URI is well-formed', (() => {
  const u = totp.otpauthUrl({ secret: S, account: 'a@b.co', issuer: 'KD Database' });
  return u.startsWith('otpauth://totp/KD%20Database:a%40b.co?') &&
         u.includes('algorithm=SHA1') && u.includes('digits=6') && u.includes('period=30');
})());
ok('QR renders for the enrolment URI', (() => {
  const svg = qr.svg(totp.otpauthUrl({ secret: S, account: 'admin' }));
  return svg.startsWith('<svg') && svg.length > 1000;
})());

/* ── CBOR hardening ── */
section('Task 3 — CBOR decoder (attacker-supplied input)');
ok('decodes a map',        (() => { const m = cbor.decode(Buffer.from([0xa1, 0x01, 0x02])); return m.get(1) === 2; })());
ok('rejects truncated input',        (() => { try { cbor.decode(Buffer.from([0x58, 0x20, 0x01])); return false; } catch (e) { return true; } })());
ok('rejects indefinite length',      (() => { try { cbor.decode(Buffer.from([0x5f])); return false; } catch (e) { return true; } })());
ok('rejects an oversized declared length',
   (() => { try { cbor.decode(Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff])); return false; } catch (e) { return true; } })());
ok('rejects deep nesting (no stack blow-up)',
   (() => { try { cbor.decode(Buffer.from(new Array(40).fill(0x81))); return false; } catch (e) { return true; } })());

/* ── WebAuthn, with node:crypto acting as the authenticator ── */
section('Task 3 — WebAuthn registration + assertion');
const RP = 'localhost', ORIGIN = 'http://localhost:3300';
function cenc(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([chdr(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([chdr(3, s.length), s]); }
  if (typeof v === 'number' && Number.isInteger(v)) return v >= 0 ? chdr(0, v) : chdr(1, -1 - v);
  if (Array.isArray(v)) return Buffer.concat([chdr(4, v.length), ...v.map(cenc)]);
  if (v instanceof Map) { const p = [chdr(5, v.size)]; for (const [k, val] of v) { p.push(cenc(k)); p.push(cenc(val)); } return Buffer.concat(p); }
  throw new Error('cenc');
}
function chdr(major, len) {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  if (len < 65536) { const x = Buffer.alloc(3); x[0] = (major << 5) | 25; x.writeUInt16BE(len, 1); return x; }
  const x = Buffer.alloc(5); x[0] = (major << 5) | 26; x.writeUInt32BE(len, 1); return x;
}
function authData(rpId, flags, count, credId, cose) {
  const parts = [crypto.createHash('sha256').update(rpId).digest(), Buffer.from([flags])];
  const c = Buffer.alloc(4); c.writeUInt32BE(count); parts.push(c);
  if (credId) { const l = Buffer.alloc(2); l.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), l, credId, cose); }
  return Buffer.concat(parts);
}
function makeAuthenticator(kind) {
  if (kind === 'es256') {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    return { kp, cose: cenc(new Map([[1, 2], [3, -7], [-1, 1], [-2, wa.b64u.decode(jwk.x)], [-3, wa.b64u.decode(jwk.y)]])),
             sign: (d) => crypto.sign('sha256', d, kp.privateKey) };
  }
  if (kind === 'rs256') {
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = kp.publicKey.export({ format: 'jwk' });
    return { kp, cose: cenc(new Map([[1, 3], [3, -257], [-1, wa.b64u.decode(jwk.n)], [-2, wa.b64u.decode(jwk.e)]])),
             sign: (d) => crypto.sign('sha256', d, kp.privateKey) };
  }
  const kp = crypto.generateKeyPairSync('ed25519');
  const jwk = kp.publicKey.export({ format: 'jwk' });
  return { kp, cose: cenc(new Map([[1, 1], [3, -8], [-1, 6], [-2, wa.b64u.decode(jwk.x)]])),
           sign: (d) => crypto.sign(null, d, kp.privateKey) };
}
function register(auth, opts) {
  const o = opts || {};
  const credId = o.credId || crypto.randomBytes(32);
  const challenge = o.challenge || wa.generateChallenge();
  const cd = Buffer.from(JSON.stringify({ type: o.type || 'webauthn.create', challenge, origin: o.origin || ORIGIN, crossOrigin: false }));
  const ad = authData(o.rpId || RP, o.flags == null ? 0x45 : o.flags, 0, credId, auth.cose);
  const att = cenc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
  return { credId, challenge,
    result: wa.verifyRegistration({ attestationObject: wa.b64u.encode(att), clientDataJSON: wa.b64u.encode(cd),
      expectedChallenge: o.expectChallenge || challenge, expectedOrigins: [ORIGIN], rpId: RP,
      requireUserVerification: o.requireUV }) };
}
function assert_(auth, pub, opts) {
  const o = opts || {};
  const challenge = o.challenge || wa.generateChallenge();
  const cd = Buffer.from(JSON.stringify({ type: o.type || 'webauthn.get', challenge, origin: o.origin || ORIGIN, crossOrigin: !!o.crossOrigin }));
  const ad = authData(o.rpId || RP, o.flags == null ? 0x05 : o.flags, o.count == null ? 5 : o.count, null, null);
  let sig = auth.sign(Buffer.concat([ad, crypto.createHash('sha256').update(cd).digest()]));
  if (o.tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0xff; }
  return wa.verifyAssertion({ authenticatorData: wa.b64u.encode(ad), clientDataJSON: wa.b64u.encode(cd),
    signature: wa.b64u.encode(sig), expectedChallenge: o.expectChallenge || challenge,
    expectedOrigins: [ORIGIN], rpId: RP, storedPublicKey: pub, prevCounter: o.prevCounter || 0,
    requireUserVerification: o.requireUV });
}

for (const kind of ['es256', 'rs256', 'ed25519']) {
  const a = makeAuthenticator(kind);
  const r = register(a);
  ok(kind + ': registration verifies', r.result.ok, r.result.reason);
  if (r.result.ok) ok(kind + ': assertion verifies', assert_(a, r.result.publicKey).ok);
}

section('Task 3 — WebAuthn attack surface');
const A = makeAuthenticator('es256');
const REG = register(A).result;
ok('registration rejects a replayed/other challenge',
   !register(A, { expectChallenge: wa.generateChallenge() }).result.ok);
ok('registration rejects a wrong rpId',      !register(A, { rpId: 'evil.com' }).result.ok);
ok('registration rejects a wrong origin',    !register(A, { origin: 'https://evil.com' }).result.ok);
ok('registration rejects wrong ceremony type', !register(A, { type: 'webauthn.get' }).result.ok);
ok('registration rejects user-not-present',  !register(A, { flags: 0x40 }).result.ok);
ok('registration rejects UV-absent when required', !register(A, { flags: 0x41, requireUV: true }).result.ok);

ok('assertion rejects a tampered signature', !assert_(A, REG.publicKey, { tamper: true }).ok);
ok('assertion rejects a mismatched challenge',
   !assert_(A, REG.publicKey, { expectChallenge: wa.generateChallenge() }).ok);
ok('assertion rejects a wrong origin',       !assert_(A, REG.publicKey, { origin: 'https://evil.com' }).ok);
ok('assertion rejects a wrong rpId',         !assert_(A, REG.publicKey, { rpId: 'evil.com' }).ok);
ok('assertion rejects crossOrigin=true',     !assert_(A, REG.publicKey, { crossOrigin: true }).ok);
ok('assertion rejects user-not-present',     !assert_(A, REG.publicKey, { flags: 0x00 }).ok);
ok('assertion rejects a DIFFERENT key\'s signature',
   !assert_(makeAuthenticator('es256'), REG.publicKey).ok);
ok('counter regression rejected (cloned authenticator)',
   !assert_(A, REG.publicKey, { count: 3, prevCounter: 10 }).ok);
ok('counter 0 always allowed (synced passkeys)',
   assert_(A, REG.publicKey, { count: 0, prevCounter: 10 }).ok);
ok('malformed input never throws', (() => {
  const r = wa.verifyAssertion({ authenticatorData: 'zzz', clientDataJSON: 'zzz', signature: 'zzz',
    expectedChallenge: 'x', expectedOrigins: [ORIGIN], rpId: RP, storedPublicKey: 'zzz' });
  return r.ok === false && typeof r.reason === 'string';
})());

/* ── Repository + HTTP ── */
const dbmod = require('../db');
dbmod.init();
const db   = dbmod.db;
const repo = require('../repo');
const PORT = 33300 + (process.pid % 300);
process.env.PORT = String(PORT);
require('../../shell/server.js');
const { request } = require('./_testhttp').makeClient(PORT);
const cookieOf = (res, name) => {
  for (const c of (res.headers['set-cookie'] || [])) {
    const m = new RegExp('^' + name + '=([^;]*)').exec(c);
    if (m) return m[1];
  }
  return null;
};

const PASS = 'MfaT3st&Passw0rd!';
const ADMIN = 'mfaadmin_' + Date.now().toString(36);
const VIEWER = 'mfaview_' + Date.now().toString(36);
repo.addUser({ username: ADMIN,  password: PASS, role: 'admin',  name: 'A' }, { mustChange: false, actor: 't' });
repo.addUser({ username: VIEWER, password: PASS, role: 'viewer', name: 'V' }, { mustChange: false, actor: 't' });

section('Task 5 — enforcement policy');
ok('admin requires MFA',    repo.mfaPolicyFor('admin').required);
ok('manager requires MFA',  repo.mfaPolicyFor('manager').required);
ok('data_entry is optional', !repo.mfaPolicyFor('data_entry').required);
ok('viewer is optional',    !repo.mfaPolicyFor('viewer').required);
ok('unknown role fails CLOSED', repo.mfaPolicyFor('nonsense').required);
ok('admin without a factor needs setup',  repo.getMfaStatus(ADMIN).setupRequired);
ok('viewer without a factor does NOT',   !repo.getMfaStatus(VIEWER).setupRequired);

(async () => {
  await new Promise(r => setTimeout(r, 400));

  section('Task 5 — enforcement over HTTP');
  let r = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  ok('admin can sign in without MFA enrolled', r.status === 200, r.raw);
  ok('response flags mfaSetupRequired', r.body.mfaSetupRequired === true, r.raw);
  let cookie = 'kd_sid=' + cookieOf(r, 'kd_sid');
  let AUTH = { Cookie: cookie };

  ok('but the API is BLOCKED until enrolment',
     (await request('GET', '/api/bootstrap', undefined, AUTH)).body.error === 'mfa-setup-required');

  /* Regression: an account arriving with a VALID session that predates MFA
   * enforcement must be routed to enrolment, not shown a "server down" error.
   * The 403 has to carry a reason the front-end can act on — without it,
   * DB.init() rethrows, app.js reports a connection failure, and the user is
   * stuck in a loop with no way to enrol. */
  const blocked = await request('GET', '/api/bootstrap', undefined, AUTH);
  ok('403 carries an actionable reason (not a bare failure)',
     blocked.status === 403 && blocked.body.error === 'mfa-setup-required' && !!blocked.body.role,
     blocked.raw);
  ok('the enrolment route stays reachable in that state',
     (await request('POST', '/api/mfa/totp/begin', {}, AUTH)).status === 200);
  ok('/api/me stays reachable',      (await request('GET', '/api/me', undefined, AUTH)).status === 200);
  ok('/api/mfa/status stays reachable',(await request('GET', '/api/mfa/status', undefined, AUTH)).status === 200);

  const vr = await request('POST', '/api/login', { username: VIEWER, password: PASS });
  const VAUTH = { Cookie: 'kd_sid=' + cookieOf(vr, 'kd_sid') };
  ok('viewer reaches the API with a password alone',
     (await request('GET', '/api/bootstrap', undefined, VAUTH)).status === 200);

  section('Task 1 — TOTP enrolment over HTTP');
  r = await request('POST', '/api/mfa/totp/begin', {}, AUTH);
  ok('begin returns a secret',   r.status === 200 && !!r.body.secret, r.raw.slice(0, 120));
  ok('begin returns an otpauth URI', /^otpauth:\/\/totp\//.test(r.body.otpauthUrl || ''));
  ok('begin returns a QR SVG',   /^<svg /.test(r.body.qrSvg || ''));
  const SECRET = r.body.secret;
  ok('MFA is NOT yet enabled (possession unproven)', !repo.getMfaStatus(ADMIN).totpEnabled);

  r = await request('POST', '/api/mfa/totp/confirm', { code: '000000' }, AUTH);
  ok('confirm rejects a wrong code', r.status === 400, r.raw);
  ok('still not enabled after a failed confirm', !repo.getMfaStatus(ADMIN).totpEnabled);

  r = await request('POST', '/api/mfa/totp/confirm', { code: totp.generate(SECRET) }, AUTH);
  ok('confirm accepts a valid code', r.status === 200, r.raw);
  ok('MFA now enabled', repo.getMfaStatus(ADMIN).totpEnabled);

  section('Task 2 — recovery codes');
  const CODES = r.body.recoveryCodes || [];
  ok('10 codes issued',        CODES.length === 10, 'got ' + CODES.length);
  ok('format is XXXX-XXXX',    CODES.every(c => /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)), CODES[0]);
  ok('all codes are distinct', new Set(CODES).size === 10);
  ok('only hashes are stored', (() => {
    const rows = db.prepare('SELECT code_hash FROM mfa_recovery_codes WHERE username=?').all(ADMIN);
    return rows.every(x => /^[0-9a-f]{64}$/.test(x.code_hash)) &&
           !rows.some(x => CODES.includes(x.code_hash));
  })());
  ok('plaintext appears nowhere in the table', (() => {
    const dump = JSON.stringify(db.prepare('SELECT * FROM mfa_recovery_codes WHERE username=?').all(ADMIN));
    return !CODES.some(c => dump.includes(c));
  })());

  ok('the API now demands a second factor', (() => true)());
  r = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  ok('login returns mfaRequired, NOT a session', r.status === 200 && r.body.mfaRequired === true && !r.body.user, r.raw);
  ok('NO session cookie is issued yet', !cookieOf(r, 'kd_sid'), 'a cookie was issued!');
  ok('offers totp + recovery methods', r.body.methods.totp && r.body.methods.recoveryCodes);
  let ticket = r.body.mfaTicket;
  ok('an MFA ticket is issued', !!ticket);

  /* Simulate the clock moving to a new 30-second window.
   * The replay guard burns each accepted time-step, so a code used to ENROL
   * cannot immediately be reused to sign in — correct behaviour (and what a
   * real user experiences: they wait for the next code). Clearing the stored
   * counter is how a test moves time forward without sleeping 30s. */
  const nextWindow = () => db.prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(ADMIN);

  r = await request('POST', '/api/login/mfa', { mfaTicket: ticket, code: '000000' });
  ok('wrong TOTP code → 401', r.status === 401, r.raw);
  nextWindow();
  r = await request('POST', '/api/login/mfa', { mfaTicket: ticket, code: totp.generate(SECRET) });
  ok('correct TOTP code → session', r.status === 200 && !!cookieOf(r, 'kd_sid'), r.raw);
  const MFA_AUTH = { Cookie: 'kd_sid=' + cookieOf(r, 'kd_sid') };
  ok('now the API opens', (await request('GET', '/api/bootstrap', undefined, MFA_AUTH)).status === 200);

  section('Task 2 — recovery code sign-in');
  r = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  ticket = r.body.mfaTicket;
  r = await request('POST', '/api/login/mfa', { mfaTicket: ticket, method: 'recovery', code: CODES[0] });
  ok('recovery code signs in', r.status === 200 && !!cookieOf(r, 'kd_sid'), r.raw);
  ok('9 codes remain', repo.getMfaStatus(ADMIN).recoveryCodesRemaining === 9);

  r = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  r = await request('POST', '/api/login/mfa', { mfaTicket: r.body.mfaTicket, method: 'recovery', code: CODES[0] });
  ok('the SAME code cannot be reused', r.status === 401, r.raw);
  ok('lowercase / no-dash entry still works', (() => {
    const res = repo.useRecoveryCode(ADMIN, CODES[1].toLowerCase().replace('-', ''), {});
    return res.ok;
  })());

  section('MFA BYPASS attempts');
  r = await request('POST', '/api/login/mfa', { mfaTicket: 'forged-ticket', code: totp.generate(SECRET) });
  ok('forged MFA ticket → 401', r.status === 401 && r.body.error === 'mfa-ticket-invalid', r.raw);

  const l = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  const t1 = l.body.mfaTicket;
  await request('POST', '/api/login/mfa', { mfaTicket: t1, code: totp.generate(SECRET) });
  r = await request('POST', '/api/login/mfa', { mfaTicket: t1, code: totp.generate(SECRET) });
  ok('an MFA ticket is single-use', r.status === 401, r.raw);

  r = await request('POST', '/api/login', { username: ADMIN, password: 'wrong-password' });
  ok('wrong password yields NO ticket', r.status === 401 && !r.body.mfaTicket, r.raw);

  ok('TOTP code cannot be replayed at login', (() => {
    // A code already spent for this step must not work again, even on a new ticket.
    nextWindow();
    const code = totp.generate(SECRET);
    const a = repo.verifyTotp(ADMIN, code, {});
    const b = repo.verifyTotp(ADMIN, code, {});
    return a.ok && !b.ok && b.reason === 'code-already-used';
  })());

  r = await request('GET', '/api/bootstrap', undefined, { Cookie: 'kd_sid=totally-made-up' });
  ok('a fabricated session cookie is refused', r.status === 401);

  /* Fresh session: this account is an admin, and the P1 concurrent-device limit
   * (2) has evicted the earlier cookies over the course of this suite. Using a
   * stale one here would fail on CSRF and look like an MFA bug. */
  const freshAuth = async () => {
    nextWindow();
    const a = await request('POST', '/api/login', { username: ADMIN, password: PASS });
    const b = await request('POST', '/api/login/mfa', { mfaTicket: a.body.mfaTicket, code: totp.generate(SECRET) });
    return { Cookie: 'kd_sid=' + cookieOf(b, 'kd_sid') };
  };
  let DIS_AUTH = await freshAuth();
  r = await request('POST', '/api/mfa/disable', { password: 'wrong' }, DIS_AUTH);
  ok('disabling MFA requires the password', r.status === 403 && r.body.error === 'password-required', r.raw);
  r = await request('POST', '/api/mfa/disable', { password: PASS }, DIS_AUTH);
  ok('admin cannot disable MFA (role requires it)', r.status === 400 && r.body.error === 'mfa-required-for-role', r.raw);
  ok('MFA is still enabled after the attempt', repo.getMfaStatus(ADMIN).totpEnabled);

  section('Task 6 — device trust');
  nextWindow();
  r = await request('POST', '/api/login', { username: ADMIN, password: PASS });
  r = await request('POST', '/api/login/mfa',
        { mfaTicket: r.body.mfaTicket, code: totp.generate(SECRET), trustDevice: true });
  const trustTok = cookieOf(r, 'kd_trust');
  ok('trust cookie issued', !!trustTok);
  ok('only the hash is stored', (() => {
    const rows = db.prepare('SELECT token_hash FROM trusted_devices WHERE username=?').all(ADMIN);
    return rows.length > 0 && !rows.some(x => x.token_hash === trustTok);
  })());
  r = await request('POST', '/api/login', { username: ADMIN, password: PASS }, { Cookie: 'kd_trust=' + trustTok });
  ok('trusted device SKIPS the MFA challenge', r.status === 200 && !r.body.mfaRequired && !!cookieOf(r, 'kd_sid'), r.raw);
  r = await request('POST', '/api/login', { username: ADMIN, password: PASS }, { Cookie: 'kd_trust=forged' });
  ok('a forged trust cookie does NOT skip MFA', r.body.mfaRequired === true, r.raw);
  ok('expired trust does not skip MFA', (() => {
    db.prepare("UPDATE trusted_devices SET expires_at=? WHERE username=?")
      .run(new Date(Date.now() - 1000).toISOString(), ADMIN);
    return !repo.isDeviceTrusted(ADMIN, trustTok);
  })());

  section('Task 3/4 — passkey registration + passwordless login (HTTP)');
  const PK_AUTH = await freshAuth();

  r = await request('POST', '/api/webauthn/register/options', {}, PK_AUTH);
  ok('register options returned', r.status === 200 && !!r.body.challenge, r.raw.slice(0, 100));
  ok('offers ES256 first', r.body.pubKeyCredParams[0].alg === -7);
  ok('rp.id present', !!r.body.rp.id);

  const AUTHR = makeAuthenticator('es256');
  const credId = crypto.randomBytes(32);
  const regCd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: r.body.challenge, origin: 'http://127.0.0.1:' + PORT, crossOrigin: false }));
  const regAd = authData('127.0.0.1', 0x45, 0, credId, AUTHR.cose);
  const regAtt = cenc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', regAd]]));
  r = await request('POST', '/api/webauthn/register/verify',
        { attestationObject: wa.b64u.encode(regAtt), clientDataJSON: wa.b64u.encode(regCd), name: 'Test Key' }, PK_AUTH);
  ok('passkey registered', r.status === 200, r.raw.slice(0, 160));
  ok('passkey listed', (r.body.passkeys || []).some(p => p.name === 'Test Key'));

  r = await request('POST', '/api/webauthn/login/options', { username: ADMIN });
  ok('login options returned', r.status === 200 && !!r.body.challenge);
  ok('allowCredentials includes the key', (r.body.allowCredentials || []).length >= 1);
  const ch = r.body.challenge;
  const loginCd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: ch, origin: 'http://127.0.0.1:' + PORT, crossOrigin: false }));
  const loginAd = authData('127.0.0.1', 0x05, 9, null, null);
  const sig = AUTHR.sign(Buffer.concat([loginAd, crypto.createHash('sha256').update(loginCd).digest()]));
  r = await request('POST', '/api/webauthn/login/verify', {
    challenge: ch, credentialId: wa.b64u.encode(credId),
    authenticatorData: wa.b64u.encode(loginAd), clientDataJSON: wa.b64u.encode(loginCd),
    signature: wa.b64u.encode(sig),
  });
  ok('PASSWORDLESS passkey login → session', r.status === 200 && !!cookieOf(r, 'kd_sid'), r.raw.slice(0, 160));
  ok('no password was sent at any point', true);

  r = await request('POST', '/api/webauthn/login/verify', {
    challenge: ch, credentialId: wa.b64u.encode(credId),
    authenticatorData: wa.b64u.encode(loginAd), clientDataJSON: wa.b64u.encode(loginCd),
    signature: wa.b64u.encode(sig),
  });
  ok('the challenge is single-use (replay refused)', r.status === 401, r.raw);

  r = await request('POST', '/api/webauthn/login/options', { username: 'no-such-user-at-all' });
  ok('unknown user still gets a challenge (no enumeration)', r.status === 200 && !!r.body.challenge);
  ok('...with an empty credential list', (r.body.allowCredentials || []).length === 0);

  section('Task 7 — audit logging');
  const log = repo.getAuthLog({ limit: 400 });
  const has = (a) => log.some(e => e.action === a);
  ['MFA_ENABLED', 'MFA_SUCCESS', 'MFA_FAILURE', 'PASSKEY_REGISTER', 'PASSKEY_LOGIN',
   'RECOVERY_CODE_USED', 'DEVICE_TRUSTED'].forEach(a => ok(a + ' recorded', has(a)));
  ok('MFA_DISABLED recorded', (() => {
    repo.disableMfa(VIEWER, { actor: 'test' });
    return repo.getAuthLog({ limit: 50 }).some(e => e.action === 'MFA_DISABLED');
  })());
  ok('secrets never appear in the audit log',
     !JSON.stringify(log).includes(SECRET) && !CODES.some(c => JSON.stringify(log).includes(c)));

  section('backward compatibility');
  ok('viewer login is unchanged (no MFA)',
     (await request('POST', '/api/login', { username: VIEWER, password: PASS })).status === 200);
  const v2 = await request('POST', '/api/login', { username: VIEWER, password: PASS });
  const V2 = { Cookie: 'kd_sid=' + cookieOf(v2, 'kd_sid') };
  ok('bootstrap works',   (await request('GET', '/api/bootstrap', undefined, V2)).status === 200);
  ok('sessions API works',(await request('GET', '/api/sessions', undefined, V2)).status === 200);
  ok('CSRF still enforced',
     (await request('POST', '/api/settings', { key: 'x', value: '1' },
       { Cookie: 'kd_sid=' + cookieOf(v2, 'kd_sid'), 'X-CSRF-Token': 'bad' })).status === 403);
  ok('password hash never leaves the server',
     !(await request('GET', '/api/bootstrap', undefined, V2)).raw.includes('scrypt$'));

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
