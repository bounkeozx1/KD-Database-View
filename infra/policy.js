'use strict';
/**
 * infra/policy.js — the security policies an administrator may tune (P4).
 *
 * ══════════════════════════════════════════════════════════════════
 * Why a module rather than constants
 * ══════════════════════════════════════════════════════════════════
 * Password rules, MFA requirements and session limits were compile-time
 * constants spread across password.js, rbac.js and repo.js. Changing any of them
 * meant editing source and redeploying, which in practice means they were never
 * changed — the opposite of what an ISO 27001 control review expects to find.
 *
 * They now live in app_settings, read through here, with the source constants
 * kept as the DEFAULTS. Nothing that already worked changes: an installation
 * with no override behaves exactly as it did before this file existed.
 *
 * ══════════════════════════════════════════════════════════════════
 * The one rule that makes this safe
 * ══════════════════════════════════════════════════════════════════
 * Every setting is CLAMPED and every clamp is one-directional:
 *
 *   • password: floors only. minLength can be raised above 12, never below 8;
 *     the composition switches can be turned ON, and can only be turned off
 *     down to a floor that still leaves a mixed-character requirement.
 *   • mfa: an override may only TIGHTEN. A role the catalogue marks 'required'
 *     (admin, manager, auditor) cannot be relaxed to 'optional' through the API,
 *     because that is the single change that would most cheaply undo P3.
 *   • session: idle and device limits are bounded on both sides — a 30-day idle
 *     window is not a policy, it is the absence of one.
 *
 * A configuration surface that can be tuned into uselessness is worse than no
 * configuration surface at all: it converts a hardened default into an
 * administrator's mistake. The clamps are the reason this is not that.
 */

const rbac = require('./rbac');
const pwmod = require('./password');

/* Storage keys. Namespaced so a future settings browser can show them together
 * and so they cannot collide with the application's own settings. */
const K_PASSWORD = 'security.password_policy';
const K_MFA      = 'security.mfa_policy';
const K_SESSION  = 'security.session_policy';

/* ══════════════════════════════════════════════════════════════════
 * Defaults — the values this system shipped with before P4
 * ══════════════════════════════════════════════════════════════════ */

const DEFAULT_PASSWORD = Object.freeze({
  minLength:      pwmod.MIN_LENGTH,   // 12
  maxLength:      pwmod.MAX_LENGTH,   // 200
  requireUpper:   true,
  requireLower:   true,
  requireDigit:   true,
  requireSpecial: true,
  blockRepeats:   true,   // no character 4+ times in a row
  blockCommon:    true,   // offline common-password list
  blockUsername:  true,   // password must not contain the account name
  maxAgeDays:     0,      // 0 = passwords do not expire
  historyDepth:   5,      // remember N previous hashes; 0 = reuse permitted
});

/* Per-role MFA requirement. Mirrors rbac.ROLES[].mfa, which stays the source of
 * truth for what the catalogue DEMANDS; this records what the operator has
 * additionally chosen. */
const DEFAULT_MFA = Object.freeze(
  rbac.ROLES.reduce((acc, r) => { acc[r.key] = r.mfa; return acc; }, {})
);

/* Mirrors repo.SESSION_POLICY. Times in minutes/days because that is what the
 * administration UI shows; repo converts to ms at the point of use. */
const DEFAULT_SESSION = Object.freeze({
  idleMinutes:  Object.freeze({ admin: 30, manager: 60, employee: 120, auditor: 60, data_entry: 120, viewer: 120 }),
  maxDevices:   Object.freeze({ admin: 2,  manager: 3,  employee: 5,   auditor: 3,  data_entry: 5,   viewer: 5 }),
  absoluteDays: 30,   // hard ceiling on session age, however active
  rememberDays: 30,   // "keep me logged in"
  sessionHours: 12,   // ordinary sign-in
});

/* ══════════════════════════════════════════════════════════════════
 * Bounds
 * ══════════════════════════════════════════════════════════════════
 * MIN is a security floor, MAX stops a typo (idle: 99999) from disabling a
 * control by accident. Both are enforced on write AND on read, so a value that
 * reached the table by another route — a restored backup from an older build, a
 * hand-edited row — is still clamped before anything acts on it.
 */
const BOUNDS = Object.freeze({
  minLength:    { min: 8,  max: 64 },
  maxLength:    { min: 64, max: 512 },
  maxAgeDays:   { min: 0,  max: 365 },   // 0 = never expires
  historyDepth: { min: 0,  max: 24 },
  idleMinutes:  { min: 5,  max: 480 },
  maxDevices:   { min: 1,  max: 20 },
  absoluteDays: { min: 1,  max: 90 },
  rememberDays: { min: 1,  max: 90 },
  sessionHours: { min: 1,  max: 24 },
});

function clamp(n, bound, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(bound.max, Math.max(bound.min, Math.round(v)));
}
function bool(v, fallback) {
  if (v === true || v === false) return v;
  if (v === 1 || v === '1' || v === 'true')  return true;
  if (v === 0 || v === '0' || v === 'false') return false;
  return fallback;
}

/* ══════════════════════════════════════════════════════════════════
 * Storage
 * ══════════════════════════════════════════════════════════════════
 * The db handle is a parameter with a lazy default. db.js calls in during
 * migrate(), i.e. before require('./db') would resolve to a ready module, so it
 * passes its own handle; everybody else omits it.
 */
function _db(handle) {
  if (handle) return handle;
  return require('./db').db;
}

function _read(key, handle) {
  try {
    const row = _db(handle).prepare('SELECT value FROM app_settings WHERE key=?').get(key);
    if (!row || row.value == null) return null;
    const parsed = JSON.parse(row.value);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (e) {
    // A missing table (very early boot) or a corrupt row must fall back to the
    // secure defaults, never throw — an unreadable policy row cannot be allowed
    // to take the server down or, worse, to skip the check.
    return null;
  }
}

function _write(key, obj, handle) {
  _db(handle).prepare(
    'INSERT INTO app_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, JSON.stringify(obj));
  return obj;
}

/* ══════════════════════════════════════════════════════════════════
 * Password policy
 * ══════════════════════════════════════════════════════════════════ */

/** The effective policy: defaults, overlaid with the stored override, clamped. */
function passwordPolicy(handle) {
  return normalisePassword(_read(K_PASSWORD, handle) || {});
}

function normalisePassword(patch) {
  const d = DEFAULT_PASSWORD;
  const p = patch || {};
  const out = {
    minLength:      clamp(p.minLength, BOUNDS.minLength, d.minLength),
    maxLength:      clamp(p.maxLength, BOUNDS.maxLength, d.maxLength),
    requireUpper:   bool(p.requireUpper,   d.requireUpper),
    requireLower:   bool(p.requireLower,   d.requireLower),
    requireDigit:   bool(p.requireDigit,   d.requireDigit),
    requireSpecial: bool(p.requireSpecial, d.requireSpecial),
    blockRepeats:   bool(p.blockRepeats,   d.blockRepeats),
    blockCommon:    bool(p.blockCommon,    d.blockCommon),
    blockUsername:  bool(p.blockUsername,  d.blockUsername),
    maxAgeDays:     clamp(p.maxAgeDays,   BOUNDS.maxAgeDays,   d.maxAgeDays),
    historyDepth:   clamp(p.historyDepth, BOUNDS.historyDepth, d.historyDepth),
  };
  // maxLength below minLength would reject every password including compliant
  // ones — an availability failure dressed as a security setting.
  if (out.maxLength < out.minLength) out.maxLength = Math.max(out.minLength, d.maxLength);

  /* Composition floor. Turning off ALL four character-class requirements while
   * also sitting at the minimum length leaves "eight lowercase letters", which
   * is a few seconds of offline cracking. At least two classes are always
   * required; if an operator disables too many, digits and lowercase are
   * reinstated — the pair that costs a user the least and an attacker the most. */
  const classes = [out.requireUpper, out.requireLower, out.requireDigit, out.requireSpecial].filter(Boolean).length;
  if (classes < 2) { out.requireLower = true; out.requireDigit = true; }
  // The common-password list is never optional. It costs nothing and blocks the
  // first few hundred guesses of every credential-stuffing run.
  out.blockCommon = true;
  return out;
}

function setPasswordPolicy(patch, handle) {
  const merged = normalisePassword(Object.assign({}, passwordPolicy(handle), patch || {}));
  return _write(K_PASSWORD, merged, handle);
}

/* ══════════════════════════════════════════════════════════════════
 * MFA policy
 * ══════════════════════════════════════════════════════════════════ */

/** Effective per-role MFA requirement: { roleKey: 'required'|'optional' }. */
function mfaPolicy(handle) {
  return normaliseMfa(_read(K_MFA, handle) || {});
}

/**
 * An override may tighten, never relax.
 *
 * The catalogue value is the FLOOR: if rbac.js says a role requires MFA, no
 * stored value can turn that off. The reverse is allowed — a role the catalogue
 * leaves optional can be made required, which is the whole point of the screen.
 */
function normaliseMfa(patch) {
  const out = {};
  Object.keys(DEFAULT_MFA).forEach(key => {
    const floor = DEFAULT_MFA[key];
    const want  = String((patch || {})[key] || '').toLowerCase();
    if (floor === 'required') { out[key] = 'required'; return; }
    out[key] = want === 'required' ? 'required' : 'optional';
  });
  return out;
}

function setMfaPolicy(patch, handle) {
  const merged = normaliseMfa(Object.assign({}, mfaPolicy(handle), patch || {}));
  _write(K_MFA, merged, handle);
  // roles.mfa is what repo.mfaPolicyFor reads first, so keep the table in step
  // rather than leaving two sources of truth to disagree.
  try {
    const upd = _db(handle).prepare('UPDATE roles SET mfa=? WHERE key=?');
    Object.keys(merged).forEach(k => upd.run(merged[k], k));
  } catch (e) { /* roles table absent during very early boot */ }
  return merged;
}

/** Raw overrides for db.js to re-apply after seedRbac(). Null when unset. */
function mfaPolicyOverrides(handle) {
  const stored = _read(K_MFA, handle);
  return stored ? normaliseMfa(stored) : null;
}

/* ══════════════════════════════════════════════════════════════════
 * Session policy
 * ══════════════════════════════════════════════════════════════════ */

function sessionPolicy(handle) {
  return normaliseSession(_read(K_SESSION, handle) || {});
}

function normaliseSession(patch) {
  const d = DEFAULT_SESSION;
  const p = patch || {};
  const idle = {}, devices = {};
  Object.keys(d.idleMinutes).forEach(role => {
    idle[role] = clamp((p.idleMinutes || {})[role], BOUNDS.idleMinutes, d.idleMinutes[role]);
    devices[role] = clamp((p.maxDevices || {})[role], BOUNDS.maxDevices, d.maxDevices[role]);
  });
  // A role the operator added after this module was written still gets bounded
  // values rather than being dropped from the policy entirely.
  Object.keys(p.idleMinutes || {}).forEach(role => {
    if (idle[role] === undefined) idle[role] = clamp(p.idleMinutes[role], BOUNDS.idleMinutes, 30);
  });
  Object.keys(p.maxDevices || {}).forEach(role => {
    if (devices[role] === undefined) devices[role] = clamp(p.maxDevices[role], BOUNDS.maxDevices, 2);
  });
  return {
    idleMinutes:  idle,
    maxDevices:   devices,
    absoluteDays: clamp(p.absoluteDays, BOUNDS.absoluteDays, d.absoluteDays),
    rememberDays: clamp(p.rememberDays, BOUNDS.rememberDays, d.rememberDays),
    sessionHours: clamp(p.sessionHours, BOUNDS.sessionHours, d.sessionHours),
  };
}

function setSessionPolicy(patch, handle) {
  const cur = sessionPolicy(handle);
  const p   = patch || {};
  const merged = normaliseSession({
    idleMinutes:  Object.assign({}, cur.idleMinutes, p.idleMinutes || {}),
    maxDevices:   Object.assign({}, cur.maxDevices,  p.maxDevices  || {}),
    absoluteDays: p.absoluteDays == null ? cur.absoluteDays : p.absoluteDays,
    rememberDays: p.rememberDays == null ? cur.rememberDays : p.rememberDays,
    sessionHours: p.sessionHours == null ? cur.sessionHours : p.sessionHours,
  });
  return _write(K_SESSION, merged, handle);
}

/* Everything at once, for GET /api/security/policies. `defaults` and `bounds`
 * travel with the values so the UI can render the allowed range and mark which
 * fields have been changed from stock without hard-coding either. */
function all(handle) {
  return {
    password: passwordPolicy(handle),
    mfa:      mfaPolicy(handle),
    session:  sessionPolicy(handle),
    defaults: { password: DEFAULT_PASSWORD, mfa: DEFAULT_MFA, session: DEFAULT_SESSION },
    bounds:   BOUNDS,
    // Which role keys the MFA screen may switch. A role whose catalogue value is
    // 'required' is displayed locked rather than pretending to be editable.
    mfaLocked: Object.keys(DEFAULT_MFA).filter(k => DEFAULT_MFA[k] === 'required'),
  };
}

module.exports = {
  passwordPolicy, setPasswordPolicy, normalisePassword,
  mfaPolicy, setMfaPolicy, normaliseMfa, mfaPolicyOverrides,
  sessionPolicy, setSessionPolicy, normaliseSession,
  all,
  DEFAULT_PASSWORD, DEFAULT_MFA, DEFAULT_SESSION, BOUNDS,
  K_PASSWORD, K_MFA, K_SESSION,
};
