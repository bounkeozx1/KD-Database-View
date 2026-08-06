'use strict';
/**
 * infra/webauthn.js — server-side WebAuthn / passkey verification (W3C Level 2).
 *
 * Covers Windows Hello, Touch ID / Face ID, Android passkeys and hardware
 * security keys (YubiKey et al). Zero dependencies: node:crypto verifies the
 * signatures, infra/cbor.js parses the structures.
 *
 * Attestation policy — deliberate: attestation statements are NOT verified, and
 * `none` is the requested conveyance. This system authenticates its own staff;
 * it has no need to prove which manufacturer made the authenticator, and
 * demanding attestation would exclude exactly the platform passkeys (iCloud
 * Keychain, Google Password Manager) that make this usable. What IS verified on
 * every request is the part that carries the security guarantee:
 *
 *   • the challenge is one this server issued, is unexpired, and is single-use
 *   • the origin matches this deployment exactly
 *   • rpIdHash matches SHA-256(rpId)
 *   • the user-present flag is set (and user-verified where required)
 *   • the assertion signature verifies against the stored public key
 *   • the signature counter has not gone backwards (cloned-authenticator check)
 */
const crypto = require('node:crypto');
const cbor   = require('./cbor');

/* ── base64url ── */
const b64u = {
  encode: (buf) => Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (str) => {
    const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
  },
};

/* ── COSE algorithm identifiers (IANA) ── */
const ALG = {
  ES256: -7,      // ECDSA P-256 + SHA-256  — the near-universal default
  EdDSA: -8,      // Ed25519
  ES384: -35,
  ES512: -36,
  RS256: -257,    // RSASSA-PKCS1-v1_5 + SHA-256 — used by older Windows Hello
  RS384: -258,
  RS512: -259,
  PS256: -37,
};
// Offered to the browser in order of preference.
const SUPPORTED_ALGS = [ALG.ES256, ALG.EdDSA, ALG.RS256, ALG.ES384, ALG.ES512, ALG.PS256];

/**
 * COSE_Key → a Node KeyObject, via JWK.
 * Going through JWK avoids hand-rolling DER/SPKI encoding, which is where this
 * kind of code usually goes wrong.
 */
function coseToPublicKey(coseBuf) {
  const m = cbor.decode(coseBuf);
  if (!(m instanceof Map)) throw new Error('webauthn: COSE key is not a map');

  const kty = m.get(1);
  const alg = m.get(3);

  if (kty === 2) {                       // EC2
    const crvId = m.get(-1);
    const crv = { 1: 'P-256', 2: 'P-384', 3: 'P-521' }[crvId];
    if (!crv) throw new Error('webauthn: unsupported EC curve ' + crvId);
    const x = m.get(-2), y = m.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('webauthn: malformed EC key');
    return {
      key: crypto.createPublicKey({
        key: { kty: 'EC', crv, x: b64u.encode(x), y: b64u.encode(y) },
        format: 'jwk',
      }),
      alg: alg == null ? ALG.ES256 : alg,
    };
  }

  if (kty === 3) {                       // RSA
    const n = m.get(-1), e = m.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('webauthn: malformed RSA key');
    return {
      key: crypto.createPublicKey({
        key: { kty: 'RSA', n: b64u.encode(n), e: b64u.encode(e) },
        format: 'jwk',
      }),
      alg: alg == null ? ALG.RS256 : alg,
    };
  }

  if (kty === 1) {                       // OKP (Ed25519)
    const crvId = m.get(-1);
    if (crvId !== 6) throw new Error('webauthn: unsupported OKP curve ' + crvId);
    const x = m.get(-2);
    if (!Buffer.isBuffer(x)) throw new Error('webauthn: malformed OKP key');
    return {
      key: crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: b64u.encode(x) },
        format: 'jwk',
      }),
      alg: ALG.EdDSA,
    };
  }

  throw new Error('webauthn: unsupported key type ' + kty);
}

/** Verify `sig` over `data` with the algorithm the credential declared. */
function verifySignature(alg, key, data, sig) {
  try {
    switch (alg) {
      case ALG.ES256: return crypto.verify('sha256', data, key, sig);
      case ALG.ES384: return crypto.verify('sha384', data, key, sig);
      case ALG.ES512: return crypto.verify('sha512', data, key, sig);
      case ALG.RS256: return crypto.verify('sha256', data, key, sig);
      case ALG.RS384: return crypto.verify('sha384', data, key, sig);
      case ALG.RS512: return crypto.verify('sha512', data, key, sig);
      case ALG.PS256: return crypto.verify('sha256', data, {
        key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      }, sig);
      // Ed25519 signs the message directly — passing a hash name would throw.
      case ALG.EdDSA: return crypto.verify(null, data, key, sig);
      default: return false;
    }
  } catch (e) {
    // A malformed signature makes verify() throw. That is a failed
    // verification, not a server error — never let it become a 500.
    return false;
  }
}

/* ── authenticatorData ────────────────────────────────────────────
 * rpIdHash(32) | flags(1) | signCount(4) | [attestedCredentialData] | [ext]
 * flags: bit0 UP (user present), bit2 UV (user verified),
 *        bit6 AT (attested credential data present), bit7 ED (extensions) */
function parseAuthData(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 37) throw new Error('webauthn: authData too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const out = {
    rpIdHash, flags, signCount,
    userPresent:  !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    attested:     !!(flags & 0x40),
  };

  if (out.attested) {
    if (buf.length < 55) throw new Error('webauthn: attested credential data truncated');
    out.aaguid = buf.subarray(37, 53);
    const idLen = buf.readUInt16BE(53);
    if (idLen > 1023) throw new Error('webauthn: credential id too long');
    if (buf.length < 55 + idLen) throw new Error('webauthn: credential id truncated');
    out.credentialId = buf.subarray(55, 55 + idLen);
    // The COSE key runs to the end (minus any extensions); decodeFirst stops at
    // its own boundary so trailing extension data does not corrupt the parse.
    const rest = buf.subarray(55 + idLen);
    const { value, bytesRead } = cbor.decodeFirst(rest);
    out.credentialPublicKey = rest.subarray(0, bytesRead);
    out.coseMap = value;
  }
  return out;
}

/** Shared clientDataJSON checks for both ceremonies. */
function checkClientData(clientDataJSON, expectedType, expectedChallenge, expectedOrigins) {
  let parsed;
  try { parsed = JSON.parse(Buffer.from(clientDataJSON).toString('utf8')); }
  catch (e) { return { ok: false, reason: 'clientData-not-json' }; }

  if (parsed.type !== expectedType) return { ok: false, reason: 'wrong-ceremony-type' };

  // Constant-time compare of the challenge. A non-constant compare here is a
  // real (if narrow) oracle, and the check costs nothing.
  const got = Buffer.from(String(parsed.challenge || ''));
  const want = Buffer.from(String(expectedChallenge || ''));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want))
    return { ok: false, reason: 'challenge-mismatch' };

  const origins = Array.isArray(expectedOrigins) ? expectedOrigins : [expectedOrigins];
  if (!origins.includes(parsed.origin)) return { ok: false, reason: 'origin-mismatch' };

  // Set by the browser when the assertion crossed an origin boundary — a
  // legitimate ceremony for this app never does.
  if (parsed.crossOrigin === true) return { ok: false, reason: 'cross-origin' };

  return { ok: true, clientData: parsed };
}

/**
 * Registration — navigator.credentials.create() result.
 * @returns {{ok:true, credentialId, publicKey, counter, alg, aaguid, userVerified}}
 *        | {ok:false, reason}
 */
function verifyRegistration(opts) {
  const o = opts || {};
  try {
    const attestationObject = b64u.decode(o.attestationObject);
    const clientDataJSON    = b64u.decode(o.clientDataJSON);

    const cd = checkClientData(clientDataJSON, 'webauthn.create', o.expectedChallenge, o.expectedOrigins);
    if (!cd.ok) return cd;

    const att = cbor.decode(attestationObject);
    if (!(att instanceof Map)) return { ok: false, reason: 'attestation-not-map' };
    const authDataBuf = att.get('authData');
    if (!Buffer.isBuffer(authDataBuf)) return { ok: false, reason: 'authData-missing' };

    const auth = parseAuthData(authDataBuf);
    if (!auth.attested) return { ok: false, reason: 'no-attested-credential-data' };

    const expectedRpIdHash = crypto.createHash('sha256').update(String(o.rpId)).digest();
    if (!auth.rpIdHash.equals(expectedRpIdHash)) return { ok: false, reason: 'rpid-mismatch' };
    if (!auth.userPresent) return { ok: false, reason: 'user-not-present' };
    if (o.requireUserVerification && !auth.userVerified)
      return { ok: false, reason: 'user-not-verified' };

    // Parse the key now, at registration, rather than discovering at first
    // sign-in that we stored something unusable.
    const { alg } = coseToPublicKey(auth.credentialPublicKey);
    if (!SUPPORTED_ALGS.includes(alg)) return { ok: false, reason: 'unsupported-algorithm:' + alg };

    return {
      ok: true,
      credentialId: b64u.encode(auth.credentialId),
      publicKey:    b64u.encode(auth.credentialPublicKey),   // COSE, stored as-is
      counter:      auth.signCount,
      alg,
      aaguid:       auth.aaguid ? auth.aaguid.toString('hex') : null,
      userVerified: auth.userVerified,
      fmt:          att.get('fmt') || 'none',
    };
  } catch (e) {
    return { ok: false, reason: 'malformed:' + (e && e.message || e) };
  }
}

/**
 * Authentication — navigator.credentials.get() result.
 * `storedPublicKey` is the base64url COSE key saved at registration.
 */
function verifyAssertion(opts) {
  const o = opts || {};
  try {
    const authDataBuf    = b64u.decode(o.authenticatorData);
    const clientDataJSON = b64u.decode(o.clientDataJSON);
    const signature      = b64u.decode(o.signature);

    const cd = checkClientData(clientDataJSON, 'webauthn.get', o.expectedChallenge, o.expectedOrigins);
    if (!cd.ok) return cd;

    const auth = parseAuthData(authDataBuf);
    const expectedRpIdHash = crypto.createHash('sha256').update(String(o.rpId)).digest();
    if (!auth.rpIdHash.equals(expectedRpIdHash)) return { ok: false, reason: 'rpid-mismatch' };
    if (!auth.userPresent) return { ok: false, reason: 'user-not-present' };
    if (o.requireUserVerification && !auth.userVerified)
      return { ok: false, reason: 'user-not-verified' };

    const { key, alg } = coseToPublicKey(b64u.decode(o.storedPublicKey));

    // The signed message is authenticatorData || SHA-256(clientDataJSON).
    const clientHash = crypto.createHash('sha256').update(clientDataJSON).digest();
    const signedData = Buffer.concat([authDataBuf, clientHash]);

    if (!verifySignature(alg, key, signedData, signature))
      return { ok: false, reason: 'bad-signature' };

    /* Cloned-authenticator detection. The counter must strictly increase — a
     * replayed or duplicated authenticator shows a counter at or below what we
     * already saw.
     *
     * Exception, and it matters: platform passkeys that sync (iCloud Keychain,
     * Google Password Manager) legitimately report 0 forever, because the
     * credential exists on several devices by design. Enforcing monotonicity
     * against those would break sign-in on every second device, so the check
     * applies only when the authenticator actually uses counters. */
    const prev = Number(o.prevCounter || 0);
    if (auth.signCount !== 0 && auth.signCount <= prev)
      return { ok: false, reason: 'counter-regression', counter: auth.signCount };

    return { ok: true, counter: auth.signCount, userVerified: auth.userVerified };
  } catch (e) {
    return { ok: false, reason: 'malformed:' + (e && e.message || e) };
  }
}

/** Fresh 32-byte challenge, base64url — what the browser echoes in clientData. */
function generateChallenge() { return b64u.encode(crypto.randomBytes(32)); }

module.exports = {
  verifyRegistration, verifyAssertion, generateChallenge,
  coseToPublicKey, parseAuthData, verifySignature,
  b64u, ALG, SUPPORTED_ALGS,
};
