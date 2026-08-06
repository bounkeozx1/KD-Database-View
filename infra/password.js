'use strict';
/**
 * infra/password.js — one source of truth for credential hashing + policy.
 *
 * Why this file exists
 * ────────────────────
 * Hashing used to live inside repo.js. That made it unreachable from db.js,
 * which is the module that has to seed the very first administrator account —
 * repo.js requires db.js, so db.js can never require repo.js back. The seed
 * therefore stored its password in PLAINTEXT ('admin1234'), and that row stayed
 * plaintext until somebody happened to sign in with it.
 *
 * Both modules now depend on this one, which depends on nothing. Zero npm
 * dependencies, in keeping with the rest of the project.
 *
 * Stored format (self-describing, versioned)
 * ──────────────────────────────────────────
 *   scrypt$<N>$<r>$<p>$<keylen>$<saltHex>$<hashHex>          ← written today
 *
 * The cost parameters are stored WITH the hash. The previous format baked them
 * in implicitly, so raising the work factor would have made every existing
 * password unverifiable. Now the verifier reads each row's own parameters, and
 * `needsRehash()` reports rows below current policy so they can be upgraded
 * silently on the owner's next successful sign-in.
 *
 * Formats still accepted for verification (never written):
 *   scrypt$<saltHex>$<hashHex>   — legacy, Node scryptSync defaults (N=16384)
 *   <anything else>              — legacy plaintext, pre-hashing installs
 */
const crypto = require('node:crypto');

/* ── Work factor ───────────────────────────────────────────────────
 * N=2^15, r=8, p=1 is the OWASP 2024 minimum for scrypt (the previous default
 * was N=2^14). Memory cost is 128·N·r ≈ 33 MB; one hash takes roughly 100 ms on
 * a laptop.
 *
 * Deliberately sized to stay on scryptSync. Node's sync scrypt blocks the event
 * loop, and this server is single-threaded — at N=2^17 (~1 s/hash) ten queued
 * sign-ins would stall every other request for ten seconds, converting the
 * password hash into a denial-of-service amplifier. 100 ms keeps that harmless
 * while still costing an offline cracker ~10x more than the old parameters.
 * Moving to Argon2id (P1) switches this to the async API at the same time.
 */
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };
// scrypt refuses to allocate past maxmem; the default 32 MB is under 128·N·r.
const MAXMEM = 192 * 1024 * 1024;

/* ── Password policy ──────────────────────────────────────────────
 * NIST SP 800-63B leans on length over composition, but the brief for this
 * system specifies composition rules explicitly, so both are enforced. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;   // bounds the hash input; scrypt cost is length-independent but this stops abuse

/**
 * Passwords that a credential-stuffing list would try in its first few hundred
 * guesses. Not a substitute for the k-anonymity breach check in P1 — this is the
 * offline floor that works with no network and no dependency.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssw0rd', 'p@ssword123', 'passw0rd123', 'password!23',
  'qwertyuiop', 'qwerty123456', '1qaz2wsx3edc', 'zaq12wsxcde3',
  '123456789012', '1234567890123', '12345678901234', '111111111111',
  'administrator', 'admin1234', 'admin12345', 'administrator1', 'admin@12345',
  'letmein12345', 'welcome12345', 'welcome@12345', 'changeme1234',
  'iloveyou1234', 'sunshine1234', 'princess1234', 'football1234',
  'monkey123456', 'dragon123456', 'baseball1234', 'superman1234',
  'trustno1234', 'whatever1234', 'qazwsxedcrfv', 'asdfghjkl123',
  'kdemployment', 'kddatabase12', 'kdemployment1', 'kddatabase123',
]);

/* The rule set applied when no configured policy is supplied. Identical to the
 * constants above, so a caller that passes nothing behaves exactly as it did
 * before the policy became configurable (P4). */
const BUILTIN_POLICY = Object.freeze({
  minLength: MIN_LENGTH, maxLength: MAX_LENGTH,
  requireUpper: true, requireLower: true, requireDigit: true, requireSpecial: true,
  blockRepeats: true, blockCommon: true, blockUsername: true,
});

/**
 * Validate a candidate password against policy.
 *
 * @param {string} plain
 * @param {object} [opts]
 * @param {string} [opts.username]  checked against the password when the policy asks
 * @param {object} [opts.policy]    an infra/policy.js password policy; defaults to BUILTIN_POLICY
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 *
 * This function never reads the database. The effective policy is passed IN, so
 * the module keeps its defining property — zero dependencies — and stays usable
 * by db.js during first-run seeding, before any settings row exists.
 */
function validate(plain, opts) {
  const o        = opts || {};
  const p        = o.policy || BUILTIN_POLICY;
  const pw       = String(plain == null ? '' : plain);
  const username = String(o.username || '');
  const min      = Number.isFinite(+p.minLength) ? +p.minLength : MIN_LENGTH;
  const max      = Number.isFinite(+p.maxLength) ? +p.maxLength : MAX_LENGTH;

  if (pw.length < min)
    return fail('too-short', 'Password must be at least ' + min + ' characters.');
  if (pw.length > max)
    return fail('too-long', 'Password must be at most ' + max + ' characters.');
  if (p.requireUpper   && !/[A-Z]/.test(pw))        return fail('need-upper',   'Password must contain an uppercase letter.');
  if (p.requireLower   && !/[a-z]/.test(pw))        return fail('need-lower',   'Password must contain a lowercase letter.');
  if (p.requireDigit   && !/[0-9]/.test(pw))        return fail('need-digit',   'Password must contain a number.');
  if (p.requireSpecial && !/[^A-Za-z0-9]/.test(pw)) return fail('need-special', 'Password must contain a special character.');
  if (p.blockRepeats   && /(.)\1{3,}/.test(pw))     return fail('repeated',     'Password must not repeat the same character 4+ times.');

  const lower = pw.toLowerCase();
  if (p.blockCommon !== false && COMMON_PASSWORDS.has(lower))
    return fail('common', 'That password appears on common-password lists. Choose another.');
  // A password containing the account name is trivially guessable from a leaked
  // user list, which this system exposes to every admin.
  if (p.blockUsername !== false && username.length >= 3 && lower.includes(username.toLowerCase()))
    return fail('contains-username', 'Password must not contain your username.');
  // Not policy-switchable: an installation-specific word is as guessable as a
  // list entry, and nobody has a legitimate reason to allow it.
  if (lower.includes('kdemployment') || lower.includes('kddatabase'))
    return fail('contains-app-name', 'Password must not contain the application name.');

  return { ok: true };
}
function fail(code, message) { return { ok: false, code: code, message: message }; }

/** Generate a policy-compliant random password (used to seed the first admin).
 *  `opts.policy` lets a caller honour a configured minimum longer than 12. */
function generate(length, opts) {
  const policy = (opts && opts.policy) || BUILTIN_POLICY;
  const floor  = Number.isFinite(+policy.minLength) ? +policy.minLength : MIN_LENGTH;
  const len = Math.max(floor + 4, length || 20);
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';   // no I/O — ambiguous when read off a console
  const LOWER = 'abcdefghijkmnopqrstuvwxyz';  // no l
  const DIGIT = '23456789';                   // no 0/1
  const SPEC  = '!@#$%^&*-_=+?';
  const ALL   = UPPER + LOWER + DIGIT + SPEC;

  for (let attempt = 0; attempt < 50; attempt++) {
    // One character guaranteed from each class, remainder uniform, then shuffled
    // — so the class positions are not predictable.
    const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SPEC)];
    while (chars.length < len) chars.push(pick(ALL));
    shuffle(chars);
    const pw = chars.join('');
    if (validate(pw, { policy: policy }).ok) return pw;
  }
  throw new Error('password.generate: could not produce a compliant password');
}
// Rejection sampling — `% n` on a raw byte biases toward low indices.
function pick(set) {
  const limit = 256 - (256 % set.length);
  for (;;) {
    const b = crypto.randomBytes(1)[0];
    if (b < limit) return set[b % set.length];
  }
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
}

/** Hash a password with current parameters. */
function hash(plain) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(norm(plain), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: MAXMEM,
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, PARAMS.keylen,
          salt.toString('hex'), h.toString('hex')].join('$');
}

/** True if `stored` is any hashed form (current or legacy) rather than plaintext. */
function isHashed(s) { return typeof s === 'string' && s.startsWith('scrypt$'); }

/** True if the row was written with weaker-than-current parameters. */
function needsRehash(stored) {
  if (!isHashed(stored)) return true;                 // plaintext → always
  const p = parse(stored);
  if (!p) return true;
  return p.N < PARAMS.N || p.r < PARAMS.r || p.keylen < PARAMS.keylen;
}

function parse(stored) {
  const parts = String(stored).split('$');
  // scrypt$salt$hash — legacy, implicit Node defaults
  if (parts.length === 3)
    return { N: 16384, r: 8, p: 1, keylen: 64, salt: parts[1], hash: parts[2] };
  // scrypt$N$r$p$keylen$salt$hash — current
  if (parts.length === 7) {
    const N = +parts[1], r = +parts[2], p = +parts[3], keylen = +parts[4];
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keylen)) return null;
    // Refuse absurd parameters from a tampered/corrupt row rather than trying to
    // allocate them — a hostile row could otherwise exhaust memory at verify time.
    if (N < 1024 || N > 1048576 || r < 1 || r > 32 || p < 1 || p > 16 || keylen < 16 || keylen > 128) return null;
    return { N: N, r: r, p: p, keylen: keylen, salt: parts[5], hash: parts[6] };
  }
  return null;
}

/** Constant-time verification. Accepts current, legacy and plaintext rows. */
function verify(plain, stored) {
  if (stored == null) return false;

  if (isHashed(stored)) {
    const p = parse(stored);
    if (!p) return false;
    let salt, expected;
    try {
      salt     = Buffer.from(p.salt, 'hex');
      expected = Buffer.from(p.hash, 'hex');
    } catch (e) { return false; }
    if (!salt.length || expected.length !== p.keylen) return false;
    let actual;
    try {
      actual = crypto.scryptSync(norm(plain), salt, p.keylen, {
        N: p.N, r: p.r, p: p.p, maxmem: MAXMEM,
      });
    } catch (e) { return false; }
    return crypto.timingSafeEqual(expected, actual);
  }

  // Legacy plaintext row. `===` on strings short-circuits at the first differing
  // byte and leaks length, so compare digests of equal size in constant time.
  const a = crypto.createHash('sha256').update(norm(stored)).digest();
  const b = crypto.createHash('sha256').update(norm(plain)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Burn one hash's worth of CPU without revealing whether an account exists.
 *
 * `login()` used to return the moment the username missed, so an unknown user
 * answered in ~0 ms and a known user in ~100 ms — a reliable oracle for
 * enumerating staff accounts. Callers now run this on the miss path so both
 * outcomes cost the same.
 */
const DUMMY_HASH = hash(crypto.randomBytes(32).toString('hex'));
function dummyVerify(plain) { try { return verify(plain, DUMMY_HASH); } catch (e) { return false; } }

// Unicode-normalise so a password typed with a different but visually identical
// composition (common with Lao/Korean IMEs) still verifies. NFKC per NIST 800-63B §5.1.1.2.
function norm(s) { return String(s == null ? '' : s).normalize('NFKC'); }

module.exports = {
  hash, verify, isHashed, needsRehash, validate, generate, dummyVerify,
  MIN_LENGTH, MAX_LENGTH, PARAMS, BUILTIN_POLICY,
};
