'use strict';
/**
 * login-mfa.js — second-factor UI for the sign-in page (P3).
 *
 * Separate file from login.js purely for readability; both are plain classic
 * scripts sharing the global scope, so this can call showPasswordChange() and
 * t() from login.js.
 *
 * Runs under the strict CSP applied to login.html: no inline script, no on*=
 * attributes, no eval. Every handler is bound with addEventListener below.
 *
 * Four screens share the one page, swapped by showCard():
 *   login → mfa (challenge) → [mfa-setup → recovery codes] → app
 */

var CARDS = ['login-form', 'pw-card', 'mfa-card', 'mfa-setup-card', 'codes-card'];

function showCard(id, title, subtitle) {
  CARDS.forEach(function (c) {
    var el = document.getElementById(c);
    if (el) el.hidden = (c !== id);
  });
  var t1 = document.querySelector('.title');
  var s1 = document.querySelector('.subtitle');
  if (t1 && title) t1.textContent = title;
  if (s1 && subtitle) s1.textContent = subtitle;
}

// Translate with a fallback, so a missing key shows English rather than the key.
function tx(key, fallback) {
  return (typeof t === 'function' && t(key) !== key) ? t(key) : fallback;
}

var _mfaTicket = null;
var _useRecovery = false;

/* ── Step two: the MFA challenge ──────────────────────────────── */
function showMfaChallenge(ticket, methods) {
  _mfaTicket = ticket;
  _useRecovery = false;
  showCard('mfa-card',
    tx('mfa_title', 'Two-factor authentication'),
    tx('mfa_subtitle', 'One more step to confirm it is you.'));

  // Only offer the recovery link when codes actually remain.
  var rec = document.getElementById('mfa-use-recovery');
  if (rec) rec.hidden = !(methods && methods.recoveryCodes);
  setRecoveryMode(false);
}

/** Toggle the single input between a 6-digit TOTP code and an XXXX-XXXX code. */
function setRecoveryMode(on) {
  _useRecovery = !!on;
  var input = document.getElementById('mfa-code');
  var intro = document.querySelector('#mfa-card .pw-intro');
  var link = document.getElementById('mfa-use-recovery');
  if (!input) return;

  if (_useRecovery) {
    input.classList.remove('code-input');
    input.maxLength = 9;                       // XXXX-XXXX
    input.setAttribute('inputmode', 'text');
    input.setAttribute('autocomplete', 'off');
    input.placeholder = 'XXXX-XXXX';
    if (intro) intro.textContent = tx('mfa_recovery_intro', 'Enter one of your recovery codes.');
    if (link) link.textContent = tx('mfa_use_totp', 'Use your authenticator app');
  } else {
    input.classList.add('code-input');
    input.maxLength = 6;
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'one-time-code');
    input.placeholder = '';
    if (intro) intro.textContent = tx('mfa_intro', 'Enter the 6-digit code from your authenticator app.');
    if (link) link.textContent = tx('mfa_use_recovery', 'Use a recovery code');
  }
  input.value = '';
  input.focus();
}

async function submitMfa(e) {
  if (e) e.preventDefault();
  var err = document.getElementById('mfa-error');
  var btn = document.getElementById('mfa-submit');
  err.textContent = '';

  var code = (document.getElementById('mfa-code').value || '').trim();
  if (!code) { err.textContent = tx('mfa_err_empty', 'Enter your code.'); return false; }

  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = tx('mfa_verifying', 'Verifying…');
  try {
    var r = await DB.completeMfa(_mfaTicket, code, {
      method: _useRecovery ? 'recovery' : 'totp',
      trustDevice: !!document.getElementById('mfa-trust').checked,
    });
    afterLogin(r);
  } catch (ex) {
    var code2 = (ex && ex.code) || 'invalid-code';
    if (code2 === 'mfa-ticket-invalid') {
      // The 5-minute ticket expired. Send them back to the password step rather
      // than leaving them retrying a code that can never work.
      err.textContent = tx('mfa_err_expired', 'That took too long. Please sign in again.');
      setTimeout(function () { location.reload(); }, 1800);
    } else if (code2 === 'too-many-attempts') {
      err.textContent = tx('mfa_err_locked', 'Too many attempts. Try again later.');
    } else {
      err.textContent = tx('mfa_err_invalid', 'That code is not valid. Try again.');
    }
    btn.disabled = false;
    btn.textContent = label;
    var f = document.getElementById('mfa-code');
    if (f) { f.value = ''; f.focus(); }
  }
  return false;
}

/* ── Enrolment (forced for roles that require MFA) ─────────────── */
async function showMfaSetup() {
  showCard('mfa-setup-card',
    tx('mfa_setup_title', 'Set up two-factor'),
    tx('mfa_setup_subtitle', 'Required for your role.'));
  var err = document.getElementById('mfa-setup-error');
  try {
    var info = await DB.beginTotpEnrolment();
    // Same-origin SVG produced by our own encoder from a URI we built — never
    // user input, so innerHTML is safe here (and the strict CSP still applies).
    document.getElementById('mfa-qr').innerHTML = info.qrSvg;
    document.getElementById('mfa-secret').textContent = info.secret;
    document.getElementById('mfa-confirm-code').focus();
  } catch (ex) {
    err.textContent = tx('mfa_err_setup', 'Could not start setup. Reload and try again.');
  }
}

async function submitMfaSetup(e) {
  if (e) e.preventDefault();
  var err = document.getElementById('mfa-setup-error');
  var btn = document.getElementById('mfa-setup-submit');
  err.textContent = '';

  var code = (document.getElementById('mfa-confirm-code').value || '').trim();
  if (!/^[0-9]{6}$/.test(code)) {
    err.textContent = tx('mfa_err_six', 'Enter the 6-digit code.');
    return false;
  }
  var label = btn.textContent;
  btn.disabled = true;
  btn.textContent = tx('mfa_activating', 'Activating…');
  try {
    var r = await DB.confirmTotpEnrolment(code);
    showRecoveryCodes((r && r.recoveryCodes) || []);
  } catch (ex) {
    err.textContent = tx('mfa_err_invalid', 'That code is not valid. Try again.');
    btn.disabled = false;
    btn.textContent = label;
    var f = document.getElementById('mfa-confirm-code');
    if (f) { f.value = ''; f.focus(); }
  }
  return false;
}

/* ── Recovery codes: shown exactly once ────────────────────────── */
function showRecoveryCodes(codes) {
  showCard('codes-card',
    tx('codes_title', 'Save your recovery codes'),
    tx('codes_subtitle', 'You will not see these again.'));
  var list = document.getElementById('codes-list');
  list.textContent = '';
  codes.forEach(function (c) {
    var li = document.createElement('li');
    li.textContent = c;                        // textContent, never innerHTML
    list.appendChild(li);
  });
  var copy = document.getElementById('codes-copy');
  if (copy) copy.textContent = tx('codes_copy', 'Copy codes');
}

async function copyCodes() {
  var codes = [].slice.call(document.querySelectorAll('#codes-list li'))
    .map(function (li) { return li.textContent; });
  var btn = document.getElementById('codes-copy');
  try {
    await navigator.clipboard.writeText(codes.join('\n'));
    btn.textContent = tx('codes_copied', 'Copied ✓');
  } catch (e) {
    // Clipboard access can be denied; the codes are on screen regardless.
    btn.textContent = tx('codes_copy_failed', 'Select and copy them manually');
  }
}

/* ── Passkeys (WebAuthn) ───────────────────────────────────────── */
function hasWebAuthn() { return !!(window.PublicKeyCredential && navigator.credentials); }

function b64uToBuf(s) {
  var b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
}
function bufToB64u(buf) {
  var s = '';
  new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Passwordless sign-in: username + passkey, no password at all. */
async function passkeyLogin() {
  var err = document.getElementById('error');
  var username = (document.getElementById('username').value || '').trim();
  err.style.color = '#dc2626';
  if (!username) { err.textContent = tx('pk_need_user', 'Enter your username first.'); return; }
  if (!hasWebAuthn()) { err.textContent = tx('pk_unsupported', 'This browser does not support passkeys.'); return; }

  try {
    var opts = await DB.passkeyLoginOptions(username);
    var cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64uToBuf(opts.challenge),
        rpId: opts.rpId,
        timeout: opts.timeout,
        userVerification: opts.userVerification,
        allowCredentials: (opts.allowCredentials || []).map(function (c) {
          return { type: 'public-key', id: b64uToBuf(c.id), transports: c.transports };
        }),
      },
    });
    if (!cred) return;
    var r = await DB.passkeyLoginVerify({
      challenge: opts.challenge,
      credentialId: bufToB64u(cred.rawId),
      authenticatorData: bufToB64u(cred.response.authenticatorData),
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      signature: bufToB64u(cred.response.signature),
    });
    afterLogin(r);
  } catch (ex) {
    // NotAllowedError = the user dismissed the prompt. Not worth an error message.
    if (ex && ex.name === 'NotAllowedError') return;
    err.textContent = tx('pk_failed', 'Passkey sign-in failed. Use your password instead.');
  }
}

/** Register a passkey during forced enrolment — an alternative to TOTP. */
async function registerPasskey() {
  var err = document.getElementById('mfa-setup-error');
  if (!hasWebAuthn()) { err.textContent = tx('pk_unsupported', 'This browser does not support passkeys.'); return; }
  try {
    var opts = await DB.passkeyRegisterOptions();
    var cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64uToBuf(opts.challenge),
        rp: opts.rp,
        user: {
          id: b64uToBuf(opts.user.id),
          name: opts.user.name,
          displayName: opts.user.displayName,
        },
        pubKeyCredParams: opts.pubKeyCredParams,
        timeout: opts.timeout,
        attestation: opts.attestation,
        authenticatorSelection: opts.authenticatorSelection,
        excludeCredentials: (opts.excludeCredentials || []).map(function (c) {
          return { type: 'public-key', id: b64uToBuf(c.id) };
        }),
      },
    });
    if (!cred) return;
    await DB.passkeyRegisterVerify({
      attestationObject: bufToB64u(cred.response.attestationObject),
      clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      name: 'Passkey',
    });
    // A passkey satisfies the policy on its own — straight into the app.
    window.location.replace('index.html');
  } catch (ex) {
    if (ex && ex.name === 'NotAllowedError') return;
    err.textContent = tx('pk_reg_failed', 'Could not register a passkey. Try the authenticator app instead.');
  }
}

/** The single place that decides where a completed sign-in goes next. */
function afterLogin(r) {
  if (r && r.mustChangePassword) { showPasswordChange(''); return; }
  if (r && r.mfaSetupRequired) { showMfaSetup(); return; }
  window.location.replace('index.html');
}

function wireMfaHandlers() {
  var on = function (id, ev, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  on('mfa-card', 'submit', submitMfa);
  on('mfa-setup-card', 'submit', submitMfaSetup);
  on('codes-card', 'submit', function (e) {
    e.preventDefault();
    window.location.replace('index.html');
  });
  on('codes-copy', 'click', copyCodes);
  on('mfa-use-recovery', 'click', function () { setRecoveryMode(!_useRecovery); });
  on('mfa-use-passkey-setup', 'click', registerPasskey);
  on('passkey-btn', 'click', passkeyLogin);

  // Auto-submit once six digits are in — saves a tap on mobile, where the
  // keyboard usually covers the button.
  var auto = function (inputId, formId) {
    var el = document.getElementById(inputId);
    if (!el) return;
    el.addEventListener('input', function () {
      if (!_useRecovery && /^[0-9]{6}$/.test(el.value)) {
        var f = document.getElementById(formId);
        if (f) { if (f.requestSubmit) f.requestSubmit(); else f.dispatchEvent(new Event('submit')); }
      }
    });
  };
  auto('mfa-code', 'mfa-card');
  auto('mfa-confirm-code', 'mfa-setup-card');

  // Hide the passkey button where the browser cannot honour it.
  var pk = document.getElementById('passkey-btn');
  if (pk && !hasWebAuthn()) pk.hidden = true;
}

document.addEventListener('DOMContentLoaded', wireMfaHandlers);
