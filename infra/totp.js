'use strict';
/**
 * infra/totp.js — RFC 6238 time-based one-time passwords.
 *
 * Interoperable with Google Authenticator, Microsoft Authenticator, Authy,
 * Bitwarden and 1Password. Those apps only implement the profile below, so the
 * parameters are fixed rather than configurable — an app that silently assumes
 * SHA-1/6/30 would produce codes that never match anything else:
 *
 *   algorithm  HMAC-SHA1      (RFC 4226 default; universally supported)
 *   digits     6
 *   period     30 seconds
 *   drift      ±1 step        (accepts the previous and next window)
 *   secret     160-bit, base32 (RFC 4648, no padding)
 *
 * Zero dependencies — node:crypto provides HMAC.
 */
const crypto = require('node:crypto');

const DIGITS  = 6;
const PERIOD  = 30;          // seconds
const DRIFT   = 1;           // ±1 step
const ALGO    = 'sha1';
const SECRET_BYTES = 20;     // 160 bits, per RFC 4226 §4

/* ── base32 (RFC 4648, no padding) ───────────────────────────────── */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  // Authenticator apps display secrets in groups with spaces, and users paste
  // them back with the spacing intact — strip whitespace and padding first.
  const clean = String(str || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32-encoded for display/QR. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/* ── Code generation ─────────────────────────────────────────────── */

/** HOTP (RFC 4226) for an explicit counter. */
function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  // 64-bit big-endian counter. writeBigUInt64BE avoids the >2^32 precision loss
  // a naive two-word write would hit in ~2106.
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(ALGO, secretBuf).update(msg).digest();
  // Dynamic truncation, RFC 4226 §5.3
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) |
              ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(bin % (10 ** DIGITS)).padStart(DIGITS, '0');
}

function counterFor(timeMs) { return Math.floor((timeMs == null ? Date.now() : timeMs) / 1000 / PERIOD); }

/** The code an authenticator app is showing right now (used by tests). */
function generate(secretB32, timeMs) {
  return hotp(base32Decode(secretB32), counterFor(timeMs));
}

/* ── Verification ────────────────────────────────────────────────── */

/**
 * Verify a submitted code against the secret, allowing ±DRIFT steps for clock
 * skew between the phone and this server.
 *
 * @returns {{ok:boolean, counter?:number}} `counter` is the step that matched —
 *   the caller MUST persist it and reject any future code whose step is <= it,
 *   otherwise a code observed over someone's shoulder stays valid for its whole
 *   30-second window and can be replayed.
 */
function verify(secretB32, code, opts) {
  const o = opts || {};
  const submitted = String(code == null ? '' : code).replace(/[\s-]/g, '');
  // Reject before doing any HMAC work: a non-numeric or wrong-length input can
  // never match, and this keeps malformed input off the crypto path.
  if (!new RegExp('^[0-9]{' + DIGITS + '}$').test(submitted)) return { ok: false };

  let secret;
  try { secret = base32Decode(secretB32); } catch (e) { return { ok: false }; }
  if (!secret.length) return { ok: false };

  const centre = counterFor(o.timeMs);
  const drift  = o.drift == null ? DRIFT : o.drift;

  // Every candidate is compared in constant time, and the loop does NOT break
  // early on a match — so the time taken does not reveal which step matched
  // (which would leak the phone's clock offset).
  let matched = -1;
  for (let i = -drift; i <= drift; i++) {
    const step = centre + i;
    if (step < 0) continue;
    const expected = hotp(secret, step);
    if (timingSafeEqualStr(expected, submitted)) matched = step;
  }
  if (matched === -1) return { ok: false };

  // Replay guard: this step (or an earlier one) has already been spent.
  if (o.lastCounter != null && matched <= Number(o.lastCounter))
    return { ok: false, replay: true };

  return { ok: true, counter: matched };
}

/** Constant-time string compare that does not leak length. */
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ── Enrolment URI ───────────────────────────────────────────────── */

/**
 * otpauth:// URI consumed by every authenticator app (rendered as a QR).
 * Algorithm/digits/period are stated explicitly: some apps default differently
 * when the parameters are omitted, which produces codes that never verify.
 */
function otpauthUrl(opts) {
  const o       = opts || {};
  const issuer  = o.issuer || 'KD Database';
  const account = o.account || 'user';
  // The label is "Issuer:account" and BOTH halves must be encoded — an issuer
  // containing a space or colon otherwise corrupts the URI.
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  const params = [
    'secret=' + o.secret,
    'issuer=' + encodeURIComponent(issuer),
    'algorithm=SHA1',
    'digits=' + DIGITS,
    'period=' + PERIOD,
  ];
  return 'otpauth://totp/' + label + '?' + params.join('&');
}

module.exports = {
  generateSecret, generate, verify, hotp, otpauthUrl,
  base32Encode, base32Decode, timingSafeEqualStr, counterFor,
  DIGITS, PERIOD, DRIFT,
};
