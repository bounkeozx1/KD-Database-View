'use strict';
/**
 * login.js — sign-in page behaviour.
 *
 * Extracted from an inline <script> in login.html so the page can be served
 * under a strict CSP (script-src 'self'), which forbids inline script and
 * on*= attributes. Every handler that used to be an onclick/onsubmit attribute
 * is now bound with addEventListener in wireHandlers() at the bottom.
 */
function showDiag() {
    var dbOk = (typeof DB !== 'undefined' && typeof DB.login === 'function');
    var el = document.getElementById('diag');
    if (el) el.innerHTML = 'scripts: ' + (dbOk ? 'ok' : '<span class="bad">FAILED TO LOAD — Ctrl+Shift+R</span>');
  }

  var _serverDown = false;

  /* The footer version, from the server (P4.5).
   * It used to be the literal "v2.1.0" in login.html, which was already wrong
   * against a 2.2.0 build. /api/health needs no session, so this works on the
   * sign-in page — and it fails silently, because a missing version number must
   * never be a reason somebody cannot log in. */
  async function showVersion() {
    const el = document.getElementById('footer-version');
    if (!el) return;
    try {
      const r = await fetch('/api/health', { credentials: 'same-origin' });
      const j = await r.json();
      if (j && j.version) el.textContent = 'KD Database Management System v' + j.version;
    } catch (e) { /* leave the un-versioned label in place */ }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    showDiag();
    showVersion();

    try {
      await DB.init();
    } catch (e) {
      _serverDown = true;
      var errEl = document.getElementById('error');
      if (errEl) {
        errEl.style.color = '#b45309';
        errEl.innerHTML = '⚠ ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ &mdash; กรุณา refresh หน้านี้อีกครั้ง';
      }
      var btn = document.querySelector('.signin-btn');
      if (btn) { btn.disabled = true; btn.style.opacity = '0.45'; btn.style.cursor = 'not-allowed'; }
    }

    try {
      if (new URLSearchParams(location.search).has('reset') && typeof DB !== 'undefined' && DB.hardReset) {
        DB.hardReset();
      }
    } catch (e) {}

    /* Arriving with a valid session that still owes a step — typically an admin
     * who was signed in before MFA became mandatory. Show the screen that
     * resolves it instead of bouncing to index.html (which would 403 and send
     * them straight back here, forever). Checked BEFORE the redirect below. */
    try {
      var pending = (typeof DB !== 'undefined' && DB.pendingStep) ? DB.pendingStep() : '';
      if (pending === 'mfa-setup-required') {
        applyTranslations();
        showMfaSetup();
        return;
      }
      if (pending === 'password-change-required') {
        applyTranslations();
        showPasswordChange('');
        return;
      }
    } catch (e) {}

    try {
      if (typeof DB !== 'undefined' && DB.getCurrentUser && DB.getCurrentUser()) {
        window.location.replace('index.html');
        return;
      }
    } catch (e) {}

    try { if (typeof applyTranslations === 'function') applyTranslations(); } catch (e) {}
    try { document.documentElement.lang = (typeof currentLang !== 'undefined') ? currentLang : 'en'; } catch (e) {}

    document.querySelectorAll('.lang-btn').forEach(b => {
      b.addEventListener('click', () => {
        try { setLang(b.dataset.lang); applyTranslations(); document.documentElement.lang = b.dataset.lang; } catch (e) {}
      });
    });

    // If we arrived here because a session ended, say why rather than leaving
    // the user to guess. Consumed once, so a later manual visit stays clean.
    try {
      const lost = sessionStorage.getItem('kd_auth_lost');
      if (lost) {
        sessionStorage.removeItem('kd_auth_lost');
        const notes = {
          'idle-timeout':      'You were signed out after a period of inactivity.',
          'absolute-lifetime': 'Your session reached its 30-day limit. Please sign in again.',
          'session-expired':   'Your session expired. Please sign in again.',
          'unknown-session':   'Your session is no longer valid. Please sign in again.',
        };
        const key = 'session_' + lost.replace(/-/g, '_');
        const msg = (typeof t === 'function' && t(key) !== key) ? t(key) : notes[lost];
        if (msg && !_serverDown) {
          const el = document.getElementById('error');
          el.style.color = '#b45309';
          el.textContent = msg;
        }
      }
    } catch (e) {}

    const u = document.getElementById('username');
    if (u) u.focus();
  });

  function togglePw() {
    const input = document.getElementById('password');
    const eye = document.getElementById('pw-eye');
    const btn = document.getElementById('pw-toggle');
    // Screen readers need the state, not just the icon swap.
    if (btn) {
      const showing = input.type === 'password';   // about to become visible
      btn.setAttribute('aria-pressed', showing ? 'true' : 'false');
      btn.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
    }
    if (input.type === 'password') {
      input.type = 'text';
      eye.innerHTML = '<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>';
    } else {
      input.type = 'password';
      eye.innerHTML = '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
    }
  }

  async function submitLogin(e) {
    if (e) e.preventDefault();
    const errEl = document.getElementById('error');
    try {
      if (typeof DB === 'undefined' || typeof DB.login !== 'function') {
        errEl.textContent = 'Scripts not loaded — hard-refresh the page (Ctrl+Shift+R).';
        return false;
      }
      const uname = document.getElementById('username').value.trim();
      const pwd   = document.getElementById('password').value;
      if (!uname || !pwd) {
        errEl.textContent = (typeof t === 'function' ? t('login_err') : 'Invalid username or password') +
          ' — ' + (!uname && !pwd ? 'both fields are empty' : !uname ? 'username is empty' : 'password is empty');
        return false;
      }
      errEl.style.color = '#dc2626';
      // "Keep me logged in" decides how long the server-side session lives
      // (30 days vs. the default 12 hours) — the account's rights ride on it.
      const remember = !!document.getElementById('remember').checked;
      const user = await DB.login(uname, pwd, remember);
      if (!user) { errEl.textContent = (typeof t === 'function' ? t('login_err') : 'Invalid username or password'); return false; }
      // Temporary credential (first-run seed or admin reset): the server will
      // 403 every other route until it is replaced, so go there instead of the app.
      // The password was accepted, but a second factor may still be owed. In
      // that case DB.login returns the challenge instead of a session — no
      // cookie has been issued yet, so this is not a signed-in state.
      if (user.mfaRequired) { showMfaChallenge(user.mfaTicket, user.methods); return false; }
      if (user.mustChangePassword) { showPasswordChange(pwd); return false; }
      // Role requires MFA but nothing is enrolled — the server will 403
      // everything until it is, so go straight to enrolment.
      if (user.mfaSetupRequired) { showMfaSetup(); return false; }
      window.location.replace('index.html');
    } catch (err) {
      if (err && err.code === 'too-many-attempts') {
        const mins = Math.max(1, Math.ceil((err.retryAfter || 900) / 60));
        errEl.textContent = (typeof t === 'function' ? t('login_locked', { mins: mins })
          : 'Too many failed attempts — try again in ' + mins + ' min');
        return false;
      }
      // Right password, but no usable session → say which of the two causes it
      // is instead of bouncing the user back to this page forever.
      if (err && (err.code === 'server-outdated' || err.code === 'no-session')) {
        errEl.style.color = '#b45309';
        errEl.textContent = (typeof t === 'function' ? t(err.code === 'server-outdated' ? 'login_err_server_old' : 'login_err_no_cookie')
          : (err.code === 'server-outdated'
              ? 'Server is running an older build — restart it (npm start) and try again'
              : 'The browser refused the session cookie — check cookie settings and try again'));
        return false;
      }
      errEl.textContent = 'Error: ' + ((err && err.message) ? err.message : String(err));
    }
    return false;
  }

  /* ── Forced password change ───────────────────────────────────── */

  // Client-side rule display only. The server re-validates every rule in
  // infra/password.js — this is feedback, never the enforcement point.
  const PW_RULES = {
    len:     (v) => v.length >= 12,
    upper:   (v) => /[A-Z]/.test(v),
    lower:   (v) => /[a-z]/.test(v),
    digit:   (v) => /[0-9]/.test(v),
    special: (v) => /[^A-Za-z0-9]/.test(v),
  };

  function showPasswordChange(currentPw) {
    document.querySelector('form.card').hidden = true;
    const card = document.getElementById('pw-card');
    card.hidden = false;

    const title = document.querySelector('.title');
    const sub   = document.querySelector('.subtitle');
    if (title) title.textContent = (typeof t === 'function') ? t('pw_title') : 'Choose a new password';
    if (sub)   sub.textContent   = (typeof t === 'function') ? t('pw_subtitle') : 'One more step before you can sign in.';

    // Carry the password just verified so the user need not retype it, but keep
    // the field visible and editable — the server still demands it, and a
    // password manager should see a normal change-password form.
    const cur = document.getElementById('pw-current');
    if (cur && currentPw) cur.value = currentPw;

    const next = document.getElementById('pw-next');
    next.addEventListener('input', updateRules);
    updateRules();
    next.focus();
  }

  function updateRules() {
    const v = document.getElementById('pw-next').value || '';
    document.querySelectorAll('#pw-rules li').forEach(li => {
      const fn = PW_RULES[li.dataset.rule];
      li.classList.toggle('met', !!(fn && fn(v)));
    });
  }

  const PW_ERRORS = {
    'bad-current':                'The current password is incorrect.',
    'same-password':             'The new password must be different from the current one.',
    'weak-password:too-short':   'Password must be at least 12 characters.',
    'weak-password:need-upper':  'Password must contain an uppercase letter.',
    'weak-password:need-lower':  'Password must contain a lowercase letter.',
    'weak-password:need-digit':  'Password must contain a number.',
    'weak-password:need-special':'Password must contain a special character.',
    'weak-password:common':      'That password is too common. Choose another.',
    'weak-password:repeated':    'Password must not repeat the same character 4+ times.',
    'weak-password:contains-username': 'Password must not contain your username.',
    'weak-password:contains-app-name': 'Password must not contain the application name.',
  };

  async function submitNewPassword(e) {
    if (e) e.preventDefault();
    const errEl = document.getElementById('pw-error');
    const btn   = document.getElementById('pw-submit');
    errEl.style.color = '#dc2626';

    const current = document.getElementById('pw-current').value;
    const next    = document.getElementById('pw-next').value;
    const confirm = document.getElementById('pw-confirm').value;

    if (next !== confirm) {
      errEl.textContent = (typeof t === 'function') ? t('pw_err_match') : 'The two passwords do not match.';
      return false;
    }
    const unmet = Object.keys(PW_RULES).filter(k => !PW_RULES[k](next));
    if (unmet.length) {
      errEl.textContent = (typeof t === 'function') ? t('pw_err_rules') : 'The new password does not meet all requirements.';
      return false;
    }

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = (typeof t === 'function') ? t('pw_saving') : 'Saving…';
    try {
      await DB.changePassword(current, next);
      window.location.replace('index.html');
    } catch (err) {
      const code = (err && err.code) || 'change-failed';
      const msg  = (typeof t === 'function' && t('pwerr_' + code) !== 'pwerr_' + code)
        ? t('pwerr_' + code)
        : (PW_ERRORS[code] || ('Could not change the password (' + code + ').'));
      errEl.textContent = msg;
      btn.disabled = false;
      btn.textContent = label;
    }
    return false;
  }

  function showReset(e) {
    if (e) e.preventDefault();
    const el = document.getElementById('error');
    el.style.color = 'var(--muted)';
    el.textContent = (typeof t === 'function') ? t('login_reset_note')
      : 'Front-end demo — ask an admin to reset it in Settings → User Accounts.';
  }

  /* ── Handler wiring (CSP: no inline on*= attributes) ──────────────
   * These five bindings replace, one for one:
   *   <form onsubmit="return submitLogin(event)">        → #login-form submit
   *   <form id="pw-card" onsubmit="…submitNewPassword">  → #pw-card submit
   *   <a class="forgot" onclick="showReset(event)">      → #forgot-btn click
   *   <a onclick="showReset(event)">                     → #request-btn click
   *   <button id="pw-toggle" onclick="togglePw()">       → #pw-toggle click
   *
   * The two "links" are now real <button type="button"> elements: an <a> with
   * no href was never focusable by keyboard, so those controls were previously
   * unreachable for anyone not using a mouse. */
  function wireHandlers() {
    const on = (id, event, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(event, fn);
    };
    on('login-form', 'submit', submitLogin);
    on('pw-card',    'submit', submitNewPassword);
    on('forgot-btn', 'click',  showReset);
    on('request-btn','click',  showReset);
    on('pw-toggle',  'click',  togglePw);
  }

  document.addEventListener('DOMContentLoaded', wireHandlers);
