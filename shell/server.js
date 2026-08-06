'use strict';
/**
 * backend/server.js — zero-dependency HTTP server.
 * Serves the static front-end + /uploads + a small JSON REST API backed by SQLite.
 *
 * Run:  node backend/server.js   (or: npm start)
 * Then open http://localhost:3000
 */
const http = require('node:http');
const fs   = require('node:fs');
const path = require('node:path');
const url  = require('node:url');
const zlib = require('node:zlib');

const dbmod   = require('../infra/db');
const repo    = require('../infra/repo');
const admin   = require('../infra/admin');
const backupPackage = require('../infra/backup-package');
const exportPackage = require('../infra/export-package');
const ai      = require('../infra/ai');
const r2      = require('../infra/r2');
const offload = require('../infra/offload');
const webauthn = require('../infra/webauthn');
const qr       = require('../infra/qr');
const rbac     = require('../infra/rbac');
const policy   = require('../infra/policy');

dbmod.init();   // auto-create DB + tables + default master data on first launch

const ROOT = dbmod.ROOT;
const PORT = process.env.PORT || 3000;

/* Single source of truth for the version the About and Monitoring screens show.
 * Read from package.json rather than duplicated in a constant, so `npm version`
 * remains the one place it changes. Falls back rather than throwing: a missing
 * or unreadable manifest must not stop the server from starting. */
const APP_VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
})();

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.pdf':'application/pdf', '.ico':'image/x-icon',
  // Fonts + Tesseract assets — an explicit type matters once X-Content-Type-Options:
  // nosniff is set: WebAssembly.instantiateStreaming REQUIRES application/wasm, and
  // the browser won't sniff it. Without this the offline OCR core can fail to load.
  '.woff2':'font/woff2', '.woff':'font/woff', '.ttf':'font/ttf',
  '.wasm':'application/wasm',
};

// ── Security response headers ─────────────────────────────────────
// Applied to EVERY response (static, API, uploads, R2 proxy, errors) via
// setHeader before any writeHead — Node merges them with the per-response
// Content-Type/Cache-Control/ETag (no name collisions).
//
// CSP: the app is 100% same-origin (every vendor lib is bundled, never a CDN),
// so 'self' is the base. What the app genuinely needs, and why relaxing it is
// unavoidable here — do NOT tighten these without testing or you break features:
//   • 'unsafe-inline' (script/style): the UI is built from inline onclick=…
//     handlers and inline style="…" throughout, plus the inline bootstrap loader.
//   • 'unsafe-eval' / 'wasm-unsafe-eval' + blob: (script/worker): the offline
//     Tesseract passport-OCR compiles WebAssembly and runs in a web worker.
//   • data:/blob: (img/font/connect/media): generated avatars & photos stored as
//     data: URLs, canvas/blob exports, and export code that fetch()es data: URLs.
// object-src 'none', base-uri 'self', frame-ancestors 'self' and form-action
// 'self' still give real clickjacking / injection hardening.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
].join('; ');

/* ── Strict CSP for the sign-in page (P2.3) ────────────────────────
 * The app shell genuinely needs 'unsafe-inline' and 'unsafe-eval' (inline
 * onclick handlers throughout, plus Tesseract's WebAssembly OCR). The LOGIN page
 * needs none of that — and it is the one page where an injected script would
 * read a password straight out of the form. So it gets its own policy with no
 * escape hatches at all.
 *
 * This is only possible because login.html no longer contains an inline <style>,
 * an inline <script>, or a single on*= attribute — they now live in
 * shell/styles/login.css and shell/scripts/login.js. Adding any inline handler
 * back to that page will silently break it under this policy.
 *
 * frame-ancestors 'none' (stricter than the shell's 'self'): nothing should ever
 * frame the sign-in form, which kills clickjacking of the credential fields.
 */
const CSP_LOGIN = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "upgrade-insecure-requests",
].join('; ');

/** True for the sign-in document itself (and the assets only it uses). */
function isLoginAsset(pathname) {
  return pathname === '/login.html'
      || pathname === '/shell/pages/login.html'
      || /\/pages\/login\.html$/.test(pathname);
}

function applySecurityHeaders(res, pathname) {
  // HSTS is ignored by browsers over plain HTTP (localhost dev) and enforced over
  // HTTPS (behind the Cloudflare tunnel / any TLS front) — safe to always send.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', isLoginAsset(pathname || '') ? CSP_LOGIN : CSP);
  // SAMEORIGIN (not DENY): the document viewer frames same-origin PDFs from /uploads.
  // The login page overrides this to DENY via frame-ancestors 'none' above.
  res.setHeader('X-Frame-Options', isLoginAsset(pathname || '') ? 'DENY' : 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // camera=(self): needed by the passport scanner (getUserMedia); the rest off.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // CORP same-origin: stops another site embedding worker photos, passport scans
  // or API responses as a subresource. These are personal data — no other origin
  // has any business loading them, and this is the header that says so.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/* ── Sessions / authorisation ──────────────────────────────────────
 * Everything below the sign-in page is gated on a server-issued session:
 *   • the browser holds only an opaque token in an HttpOnly cookie — it can
 *     neither read nor forge it, so "being admin" is no longer a client claim;
 *   • the role is re-read from the users table on every single request, so it
 *     always reflects the account that actually signed in;
 *   • read (GET) needs any signed-in account, every write needs role=admin.
 * This is what makes username+password — not localStorage — the source of
 * permissions. */
const SID = 'kd_sid';

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (k) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = part.slice(i + 1).trim(); } }
  });
  return out;
}

// Cookie first (browser); Bearer header is for scripts/curl against the API.
function sessionToken(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers['authorization'] || '');
  return (parseCookies(req)[SID] || (m && m[1]) || null);
}
/**
 * Resolve the request's session, applying idle / absolute / expiry rules.
 * Returns repo's { ok, user, session } | { ok:false, reason } — the reason is
 * surfaced to the client so the sign-in page can explain WHY the user was
 * signed out rather than bouncing them with no message.
 */
function sessionOf(req) {
  // The ctx is only consumed when the session turns out to be dead, so the
  // SESSION_EXPIRE audit row carries the real IP/UA of the request that hit it.
  try {
    return repo.resolveSession(sessionToken(req), { ip: _clientIp(req), userAgent: _userAgent(req) });
  } catch (e) { return { ok: false, reason: 'error' }; }
}
function currentUser(req) {
  const r = sessionOf(req);
  return r.ok ? r.user : null;
}

// Secure only over TLS — behind the Cloudflare tunnel the origin request is
// plain HTTP, so trust X-Forwarded-Proto; on http://localhost we must omit it
// or the browser drops the cookie entirely.
function isHttps(req) {
  const p = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return p === 'https' || !!(req.socket && req.socket.encrypted);
}
const CSRF_COOKIE = 'kd_csrf';
const CSRF_HEADER = 'x-csrf-token';

/** Append a Set-Cookie without clobbering one already queued on this response. */
function addCookie(res, value) {
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(value);
  res.setHeader('Set-Cookie', list);
}

function setSessionCookie(res, req, token, maxAgeSec) {
  const bits = [SID + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + maxAgeSec];
  if (isHttps(req)) bits.push('Secure');
  addCookie(res, bits.join('; '));
}
/* The CSRF cookie is deliberately NOT HttpOnly: the page's own JavaScript has to
 * read it to echo the value back in the X-CSRF-Token header. That is safe — it
 * is not a credential. Holding it proves nothing; only presenting it *together
 * with* the HttpOnly session cookie authorises anything, and a cross-origin
 * attacker can never read it (same-origin policy) even though the browser would
 * happily send the session cookie for them. */
function setCsrfCookie(res, req, value, maxAgeSec) {
  const bits = [CSRF_COOKIE + '=' + value, 'Path=/', 'SameSite=Strict',
                'Max-Age=' + (maxAgeSec == null ? 43200 : maxAgeSec)];
  if (isHttps(req)) bits.push('Secure');
  addCookie(res, bits.join('; '));
}
function clearSessionCookie(res, req) {
  const sec = isHttps(req) ? '; Secure' : '';
  addCookie(res, SID + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' + sec);
  addCookie(res, CSRF_COOKIE + '=; Path=/; SameSite=Strict; Max-Age=0' + sec);
}

/* ── Pending MFA challenges + WebAuthn challenges (P3) ─────────────
 * After a password is accepted but BEFORE the second factor is proven, there is
 * no session yet — so this half-authenticated state is held server-side, keyed
 * by a random ticket handed to the browser.
 *
 * In-memory and short-lived by design:
 *   • single-use — a ticket is deleted the moment it is spent, so a captured
 *     one cannot be replayed;
 *   • 5-minute TTL — an abandoned challenge cannot linger;
 *   • a restart drops them, which costs an in-flight user one re-login. That is
 *     the right trade against persisting half-authenticated state to disk.
 *
 * Note this is NOT a signed stateless token. A signed ticket could not be
 * revoked or made single-use without server state anyway, so the state is the
 * honest design.
 */
const MFA_TICKET_TTL_MS  = 5 * 60 * 1000;
const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const _mfaTickets = new Map();      // ticket → { username, remember, expiresAt, ip }
const _waChallenges = new Map();    // key    → { challenge, username, expiresAt }

function _sweepMaps() {
  const now = Date.now();
  for (const [k, v] of _mfaTickets)   if (v.expiresAt <= now) _mfaTickets.delete(k);
  for (const [k, v] of _waChallenges) if (v.expiresAt <= now) _waChallenges.delete(k);
}
const _mfaSweep = setInterval(_sweepMaps, 60 * 1000);
if (_mfaSweep.unref) _mfaSweep.unref();

function issueMfaTicket(username, remember, ip) {
  _sweepMaps();
  const ticket = require('node:crypto').randomBytes(32).toString('hex');
  _mfaTickets.set(ticket, { username, remember: !!remember, ip, expiresAt: Date.now() + MFA_TICKET_TTL_MS });
  return ticket;
}
/** Consume a ticket. Single-use: it is removed whether or not it was valid. */
function takeMfaTicket(ticket) {
  if (!ticket) return null;
  const rec = _mfaTickets.get(ticket);
  _mfaTickets.delete(ticket);
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return rec;
}
/** Peek without consuming — for flows that may legitimately retry (wrong code). */
function peekMfaTicket(ticket) {
  const rec = ticket && _mfaTickets.get(ticket);
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return rec;
}

function putChallenge(key, challenge, username) {
  _sweepMaps();
  _waChallenges.set(key, { challenge, username, expiresAt: Date.now() + WEBAUTHN_CHALLENGE_TTL_MS });
}
function takeChallenge(key) {
  const rec = _waChallenges.get(key);
  _waChallenges.delete(key);                 // single-use — never accept a replay
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return rec;
}

/* Relying-Party ID and allowed origins for WebAuthn.
 * rpId must be the registrable domain the page is served from — a passkey
 * registered against one rpId is invisible to any other, so getting this wrong
 * silently breaks sign-in rather than erroring. Derived from the request host so
 * the same code works on localhost and on kdb.kdemployment.com; override with
 * WEBAUTHN_RPID / WEBAUTHN_ORIGIN when behind a proxy that rewrites Host. */
function webauthnRpId(req) {
  if (process.env.WEBAUTHN_RPID) return process.env.WEBAUTHN_RPID;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return host.split(':')[0];            // strip the port — rpId is a domain, never host:port
}
function webauthnOrigins(req) {
  if (process.env.WEBAUTHN_ORIGIN) return process.env.WEBAUTHN_ORIGIN.split(',').map(s => s.trim());
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return ['https://' + host, 'http://' + host];
}

/* Trusted-device cookie ("remember this device for 30 days"). */
const TRUST_COOKIE = 'kd_trust';
function setTrustCookie(res, req, token, maxAgeSec) {
  const bits = [TRUST_COOKIE + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + maxAgeSec];
  if (isHttps(req)) bits.push('Secure');
  addCookie(res, bits.join('; '));
}

/* ── Origin validation (P2.2) ──────────────────────────────────────
 * Two independent signals, checked on every state-changing request:
 *
 *   Sec-Fetch-Site  — set by the BROWSER, not by page script, so it cannot be
 *                     forged from JavaScript. 'same-origin' / 'none' (a direct
 *                     navigation) are fine; 'cross-site' and 'same-site' are not.
 *   Origin          — compared against the Host we were actually reached on.
 *
 * Either one alone is enough to reject. A request that presents NEITHER header
 * is allowed through only to the extent that CSRF token validation still applies
 * — that combination is a non-browser client (curl, the test suite), which by
 * definition carries no ambient cookies to abuse.
 */
function expectedOrigins(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (!host) return [];
  return ['https://' + host, 'http://' + host];
}
function checkOrigin(req) {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none')
    return { ok: false, reason: 'sec-fetch-site:' + sfs };

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    if (!expectedOrigins(req).includes(origin))
      return { ok: false, reason: 'origin-mismatch' };
  }
  return { ok: true };
}

/* ── CSRF validation (P2.1) ────────────────────────────────────────
 * Applies to every POST/PUT/PATCH/DELETE.
 *
 *  • Cookie-authenticated request → the presented X-CSRF-Token must equal the
 *    secret stored server-side on THAT session row (repo.verifyCsrfToken).
 *  • No session yet (i.e. /api/login) → double-submit: the header must equal the
 *    kd_csrf cookie. An attacker's page can make the browser send the cookie but
 *    cannot read it, so it cannot populate the header.
 *  • Authorization: Bearer → exempt. CSRF is an ambient-credential attack; a
 *    Bearer token is not ambient (no browser attaches it automatically), so
 *    there is nothing to forge. Exempting it keeps curl/scripts working.
 */
function isStateChanging(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}
function usesBearer(req) {
  return /^Bearer\s+\S+/i.test(req.headers['authorization'] || '');
}
function checkCsrf(req) {
  if (usesBearer(req)) return { ok: true, skipped: 'bearer' };

  const presented = req.headers[CSRF_HEADER];
  if (!presented) return { ok: false, reason: 'csrf-token-missing' };

  const sid = parseCookies(req)[SID];
  if (sid) {
    return repo.verifyCsrfToken(sid, presented)
      ? { ok: true }
      : { ok: false, reason: 'csrf-token-invalid' };
  }
  // Pre-session (login): double-submit cookie.
  const cookieVal = parseCookies(req)[CSRF_COOKIE];
  if (!cookieVal) return { ok: false, reason: 'csrf-cookie-missing' };
  const a = Buffer.from(String(cookieVal)), b = Buffer.from(String(presented));
  if (a.length !== b.length) return { ok: false, reason: 'csrf-token-invalid' };
  return require('node:crypto').timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'csrf-token-invalid' };
}

/* ── Client IP resolution (P0.3) ────────────────────────────────────
 * Root cause of the previous bug: _clientIp() read X-Forwarded-For from ANY
 * request. That header is just a request header — a client can set it freely.
 * Since it was also the rate-limiter's key, an attacker rotating
 * `X-Forwarded-For: 1.2.3.<n>` got a brand-new failure counter on every single
 * guess, so the throttle never engaged. Worse, every IP written to the audit log
 * was attacker-chosen, making the trail useless for incident response.
 *
 * Rule now: a forwarding header is believed ONLY when the socket peer is a proxy
 * we placed there ourselves. Otherwise the TCP source address wins, and that
 * cannot be spoofed on an established connection.
 *
 * Configure with TRUSTED_PROXIES (comma-separated IPs/CIDRs). Loopback is
 * trusted by default because `cloudflared` runs on this machine and connects
 * over 127.0.0.1 — that is exactly the named-tunnel topology in use.
 */
const TRUSTED_PROXY_CIDRS = (process.env.TRUSTED_PROXIES ||
  '127.0.0.1/32,::1/128'
).split(',').map(s => s.trim()).filter(Boolean);

// Normalise ::ffff:127.0.0.1 → 127.0.0.1 so v4-mapped peers match v4 rules.
function _normIp(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}
function _ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const v = Number(part);
    if (!/^\d{1,3}$/.test(part) || v > 255) return null;
    n = (n * 256) + v;
  }
  return n;
}
function _ipInCidr(ip, cidr) {
  const [range, bitsRaw] = cidr.split('/');
  const nIp = _ipv4ToInt(_normIp(ip)), nRange = _ipv4ToInt(_normIp(range));
  if (nIp === null || nRange === null) {
    // Not IPv4 on both sides — fall back to an exact match (covers ::1).
    return _normIp(ip) === _normIp(range);
  }
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;
  return ((nIp & mask) >>> 0) === ((nRange & mask) >>> 0);
}
function _isTrustedProxy(ip) {
  if (!ip) return false;
  return TRUSTED_PROXY_CIDRS.some(c => _ipInCidr(ip, c));
}

function _clientIp(req) {
  const peer = _normIp(req.socket && req.socket.remoteAddress);
  if (!_isTrustedProxy(peer)) return peer;          // direct client — trust the socket only

  // Behind our own proxy. CF-Connecting-IP is written by Cloudflare itself and
  // (unlike XFF) is overwritten rather than appended, so it cannot be padded by
  // the client. Prefer it; fall back to the left-most XFF entry.
  const cf = _normIp(req.headers['cf-connecting-ip']);
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return _normIp(xff) || peer;
}

function _userAgent(req) { return String(req.headers['user-agent'] || '').slice(0, 256); }

/* ── Login throttling (P0.2) ────────────────────────────────────────
 * Root cause of the previous bug: the map was bounded with
 * `if (_loginFails.size > 5000) _loginFails.clear()` — a global wipe. Any
 * unauthenticated client could POST 5 000 junk usernames and erase the failure
 * counters of EVERY account and every IP at once, then resume guessing from
 * zero. The bound meant to protect memory was itself the bypass.
 *
 * Now: entries carry their own expiry and are swept individually. Nothing is
 * ever cleared wholesale, so one client's traffic can never reset another's
 * counter. Under pressure the sweep runs first and only genuinely-expired rows
 * go; if the map is still oversized we evict the entries closest to expiry,
 * which are the least valuable, rather than all of them.
 *
 * Two independent counters, both of which must stay under their limit:
 *   • per account  — stops one account being ground down from a botnet
 *   • per IP       — stops one host spraying many accounts
 */
const LOGIN_WINDOW_MS   = 15 * 60 * 1000;
const LOGIN_MAX_PER_ACCT = 10;   // failures per username per window
const LOGIN_MAX_PER_IP   = 30;   // failures per source IP per window (many accounts share an office NAT)
const LOGIN_MAP_MAX      = 20000;

const _loginFails = new Map();   // key → { n, first, expiresAt }

function _sweepExpired(now) {
  for (const [k, rec] of _loginFails) {
    if (rec.expiresAt <= now) _loginFails.delete(k);
  }
}
function _bump(key, now) {
  const rec = _loginFails.get(key);
  if (!rec || rec.expiresAt <= now) {
    _loginFails.set(key, { n: 1, first: now, expiresAt: now + LOGIN_WINDOW_MS });
    return;
  }
  rec.n++;
  // NB: expiresAt is NOT extended on each failure. The window is anchored to the
  // first failure so a locked-out attacker cannot hold the lock open forever by
  // continuing to hammer — and, more importantly, so a third party spoofing an
  // account name cannot keep a legitimate user locked out indefinitely.
}
function _count(key, now) {
  const rec = _loginFails.get(key);
  if (!rec || rec.expiresAt <= now) return null;
  return rec;
}
function _retryAfter(rec, now) { return Math.max(1, Math.ceil((rec.expiresAt - now) / 1000)); }

const _acctKey = (username) => 'a|' + String(username || '').toLowerCase();
const _ipKey   = (ip)       => 'i|' + String(ip || '');

/** @returns {number} seconds to wait, or 0 when not throttled. */
function loginLockedFor(ip, username) {
  const now = Date.now();
  const a = _count(_acctKey(username), now);
  if (a && a.n >= LOGIN_MAX_PER_ACCT) return _retryAfter(a, now);
  const i = _count(_ipKey(ip), now);
  if (i && i.n >= LOGIN_MAX_PER_IP) return _retryAfter(i, now);
  return 0;
}

function noteLoginFail(ip, username) {
  const now = Date.now();
  _bump(_acctKey(username), now);
  _bump(_ipKey(ip), now);
  if (_loginFails.size > LOGIN_MAP_MAX) {
    _sweepExpired(now);
    if (_loginFails.size > LOGIN_MAP_MAX) {
      // Still oversized after the sweep: drop the soonest-to-expire entries only.
      // Never a blanket clear() — that was the original vulnerability.
      const victims = [..._loginFails.entries()]
        .sort((x, y) => x[1].expiresAt - y[1].expiresAt)
        .slice(0, Math.ceil(LOGIN_MAP_MAX * 0.1));
      victims.forEach(([k]) => _loginFails.delete(k));
    }
  }
}

/** A successful sign-in clears that account's counter, but NOT the IP counter —
 *  otherwise one valid account on a compromised host would reset the spray limit. */
function clearLoginFails(username) { _loginFails.delete(_acctKey(username)); }

/**
 * How many ACCOUNTS the throttle is currently holding shut (P4 — the "Locked
 * Accounts" card in Security Overview).
 *
 * Counted, never listed. The map's keys are account names that have been TYPED,
 * which includes every name an attacker guessed — publishing that list would
 * turn a defensive counter into a directory of attempted usernames. IP entries
 * are excluded for the same reason: this number answers "is somebody locked
 * out right now?", not "who".
 */
function lockedAccountCount() {
  const now = Date.now();
  let n = 0;
  for (const [k, rec] of _loginFails) {
    if (k[0] !== 'a') continue;                     // account keys only
    if (rec.expiresAt > now && rec.n >= LOGIN_MAX_PER_ACCT) n++;
  }
  return n;
}

// Periodic sweep so idle entries don't linger for a whole window after traffic stops.
const _sweepTimer = setInterval(() => _sweepExpired(Date.now()), 60 * 1000);
if (_sweepTimer.unref) _sweepTimer.unref();

/**
 * Issue the session once every required factor has been satisfied.
 * Single place so the password+TOTP, recovery-code and passkey paths cannot
 * drift apart — a divergence here would be an authentication bypass.
 */
function finishLogin(req, res, username, remember, ctx, trustThisDevice) {
  const u = repo.getUserPublic(username);
  const sess = repo.createSession(username, remember, ctx);
  setSessionCookie(res, req, sess.token, sess.maxAge);
  setCsrfCookie(res, req, sess.csrfToken, sess.maxAge);

  if (trustThisDevice) {
    const t = repo.trustDevice(username, ctx);
    if (t) setTrustCookie(res, req, t.token, t.maxAge);
  }
  const st = repo.getMfaStatus(username);
  return json(res, 200, {
    ok: true, user: u, expiresAt: sess.expiresAt,
    mustChangePassword: !!(u && u.mustChangePassword),
    mfaSetupRequired: !!(st && st.setupRequired),
    csrfToken: sess.csrfToken,
  });
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj)); }

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 60 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}

/* ══════════════════════════════════════════════════════════════════
 * Route → permission map (RBAC)
 * ══════════════════════════════════════════════════════════════════
 * The single declaration of what each endpoint requires. Keeping it in one
 * table rather than scattering checks through the handlers means the complete
 * authorisation surface can be read — and audited — in one place.
 *
 * Return values:
 *   'x.y'      the permission required
 *   null       authenticated, but no specific permission (identity/self-service)
 *   undefined  NOT DECLARED → denied by the gate
 *
 * `undefined` being a denial is deliberate: a new route that nobody remembered
 * to classify must fail closed.
 */
function requiredPermission(method, seg, body) {
  const r = seg[0];
  const isGet = method === 'GET';

  switch (r) {
    /* Identity and self-service. Available to every authenticated account
     * regardless of role — these are how a user manages their OWN security,
     * and gating them behind a permission could lock somebody out of their own
     * account recovery. */
    case 'me':
    case 'logout':
    case 'logout-all':
    case 'password':
    case 'csrf':
    case 'health':
    case 'sessions':
    case 'mfa':
    case 'passkeys':
    case 'webauthn':
      return null;

    case 'bootstrap':  return 'employee.view';
    case 'trash':
      if (isGet) return 'trash.view';
      if (seg[1] === 'restore') return 'trash.restore';
      return 'trash.purge';                       // purge + empty

    case 'groups': {
      if (isGet) return 'group.view';
      if (method === 'POST' && seg[2] === 'employees') return 'employee.create';
      if (method === 'POST') return 'group.create';
      if (method === 'PATCH') return 'group.update';
      if (method === 'DELETE') return 'group.delete';
      return undefined;
    }

    case 'employees': {
      if (seg[2] === 'documents') {
        if (isGet) return 'document.view';
        if (method === 'POST') return 'document.upload';
        return undefined;
      }
      if (isGet) return 'employee.view';
      if (method === 'PATCH') {
        // Approving is a distinct authority from editing: a Data Entry user may
        // amend their own record but may never move it past review.
        if (body && body.status && body.status !== 'draft') return 'employee.approve';
        return 'employee.update';
      }
      if (method === 'DELETE') return 'employee.delete';
      return undefined;
    }

    case 'documents':  return method === 'DELETE' ? 'document.delete' : 'document.view';
    case 'cities':     return isGet ? 'settings.view' : 'settings.update';
    case 'settings':   return isGet ? 'settings.view' : 'settings.update';
    case 'import':     return 'import.execute';

    /* POST /api/export — authorise and record an export (P4.5).
     *
     * The permission depends on the FORMAT, because a CSV of the current view
     * and a .kdb bundle containing every record and photograph are not the same
     * act. See rbac.exportPermissionFor.
     *
     * Note what this route does NOT claim: the records are already in the
     * browser (the app loads them at sign-in), so an authorised reader who is
     * determined to copy data can always do so. What this adds is real — the
     * normal export path is refused for a role without the grant, and every
     * export that does happen is named in the trail. */
    /* The per-worker package is its own grant, checked BEFORE the format table
     * so an account holding only export.pdf cannot reach it — and so the GET
     * routes (status, download), which carry no body and therefore no format,
     * resolve to something stricter than the default. */
    case 'export':
      if (seg[1] === 'package') return 'export.package';
      return rbac.exportPermissionFor(body && body.format);
    case 'ai':         return 'ocr.process';
    case 'auth-log':   return 'audit.view';

    case 'users': {
      if (isGet) return 'user.view';
      if (method === 'POST') return 'user.create';
      if (method === 'PATCH') return body && body.role ? 'role.assign' : 'user.update';
      if (method === 'DELETE') return 'user.delete';
      return undefined;
    }

    case 'roles':      return isGet ? 'user.view' : 'role.manage';
    case 'permissions':return 'user.view';

    /* ── P4: the administration centre ──
     * Reading a policy needs only settings.view (a Manager may see the rules
     * they are held to); CHANGING one needs security.manage, which only Admin
     * holds. Enrolment actions are separated onto mfa.enforce so the authority
     * to reset somebody's second factor can be delegated without handing over
     * the rest of the security settings. */
    case 'security': {
      if (seg[1] === 'overview')        return 'audit.view';
      if (seg[1] === 'policies')        return isGet ? 'settings.view' : 'security.manage';
      if (seg[1] === 'mfa-overview')    return 'mfa.enforce';
      if (seg[1] === 'mfa-enforce')     return 'mfa.enforce';
      if (seg[1] === 'mfa-reset')       return 'mfa.enforce';
      if (seg[1] === 'revoke-trusted')  return 'mfa.enforce';
      if (seg[1] === 'sessions')        return 'security.manage';
      if (seg[1] === 'revoke-sessions') return 'security.manage';
      /* P4.6 — audit integrity. Reading the verdict is an auditor's job, so it
       * sits on audit.view alongside the trail itself. Rebuilding the chain is
       * not: it rewrites every hash, so it needs security.manage. */
      if (seg[1] === 'audit-integrity') return 'audit.view';
      if (seg[1] === 'audit-reanchor')  return 'security.manage';
      return undefined;
    }

    case 'admin': {
      // Database-level operations. Restore is separated from backup because
      // "Cannot restore database" is an explicit Manager restriction, while
      // taking a backup is comparatively harmless.
      if (seg[1] === 'restore')  return 'backup.restore';
      if (seg[1] === 'backup')   return 'backup.create';
      /* P5.1 — restoring from a package is the same authority as any other
       * restore, and it is checked BEFORE the generic backups rule below so a
       * `backup.create` holder cannot reach it. */
      if (seg[1] === 'backups' && seg[3] === 'restore') return 'backup.restore';
      if (seg[1] === 'backups')  return 'backup.create';
      if (seg[1] === 'backup-health') return 'backup.create';
      // Retention deletes recovery artefacts, so it sits with the other
      // destructive maintenance operations rather than with taking a backup.
      if (seg[1] === 'retention') return 'database.manage';
      /* Health and database status are diagnostics — they read counters and
       * pragmas and change nothing — but they stay on database.manage with the
       * rest of /api/admin rather than being widened to settings.view. Adding a
       * screen is not a reason to hand a new audience a new read surface; if
       * Monitoring is ever wanted for Managers, that is a deliberate grant, not
       * a side effect of this release. */
      if (seg[1] === 'health')   return 'database.manage';
      return 'database.manage';                   // storage, cleanup, offload, …
    }

    default:
      return undefined;                           // default deny
  }
}

/**
 * Narrow a scoped grant against one concrete record.
 *
 * Call from a handler AFTER the gate has confirmed the permission is held. The
 * gate answers "may this role do X at all?"; this answers "may they do it to
 * THIS record?" — which is where 'own' and 'team' actually bite.
 *
 * @returns {{allowed:boolean, reason?:string}}
 */
function authorizeRecord(me, permission, record) {
  const scope = me.permissions ? me.permissions[permission] : undefined;
  if (!scope) return { allowed: false, reason: 'not-granted' };
  if (scope === 'all') return { allowed: true };
  if (!record) return { allowed: false, reason: 'record-not-found' };

  return rbac.check(me.permissions, permission, {
    actor: me.username,
    ownerId: record.ownerId,
    teamIds: repo.getTeamGroupIds(me.username),
    recordTeamId: record.teamId,
  });
}

/** Standard 403 for a record-scope refusal, with the audit entry. */
function denyScope(req, res, me, permission, verdict) {
  repo.logAuth('PERMISSION_DENIED', 'FAILURE', {
    username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
    reason: permission + ' denied by scope: ' + (verdict && verdict.reason || 'scope'),
  });
  return json(res, 403, {
    ok: false, error: 'forbidden', reason: 'out-of-scope',
    permission: permission, scope: me.permissions[permission],
  });
}

/* ── Static files ── */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' ) rel = '/index.html';
  // Uploaded files live under <data>/uploads/ but are referenced as /uploads/… in the DB.
  const isUpload = rel.startsWith('/uploads/');
  // Each root is checked against its OWN base. Checking both against ROOT was
  // only correct while the data directory happened to sit inside the repo, and
  // path.resolve + path.sep makes the prefix test exact — `startsWith(ROOT)`
  // alone would also accept a sibling directory such as `<ROOT>-evil`.
  const base = isUpload ? path.resolve(dbmod.DATA_DIR) : path.resolve(ROOT);
  const full = path.resolve(path.join(base, isUpload ? rel : rel));
  if (full !== base && !full.startsWith(base + path.sep))
    return send(res, 403, 'Forbidden', 'text/plain');
  // Worker photos, passports and documents are personal data — they need the
  // same sign-in as the API. (The app shell itself stays public: it only ever
  // shows the login screen without a session.)
  if (isUpload && !currentUser(req)) return send(res, 401, 'Sign in required', 'text/plain');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // Offloaded upload: the local copy was freed after mirroring to R2 — proxy it.
      if (isUpload && r2.isEnabled()) return serveFromR2(req, res, rel);
      return send(res, 404, 'Not found', 'text/plain');
    }
    /* ── Caching ──────────────────────────────────────────────────
     * Uploaded files have content-unique names, so they are immutable and
     * cached for a year.
     *
     * The app shell used to get `no-cache` and NO ETag, which is the worst of
     * both: `no-cache` means "revalidate", but with nothing to revalidate
     * against the browser had to download the whole file every time. Measured
     * over the tunnel that was 1.52 MB per page load — main.css alone took 25
     * seconds. Every shell file now carries an ETag, so a revalidation costs a
     * 304 instead of the body.
     *
     * A request that names a version (`?v=…`) is answered as immutable: the
     * loader in index.html stamps the running app version onto every asset URL,
     * so the URL changes when the code does and the browser can keep the old
     * answer forever without ever going stale. */
    const versioned = /[?&]v=/.test(req.url || '');
    const etag = '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) +
                 (isUpload ? '' : '-' + APP_VERSION) + '"';
    const cacheControl = (isUpload || versioned)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cacheControl });
      return res.end();
    }

    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    const head = { 'Content-Type': type, 'Cache-Control': cacheControl, 'ETag': etag };

    /* ── The one file that is rewritten on the way out ──
     * The page has to know the app version before it can request anything, so
     * it cannot fetch it — the version is substituted into the loader here
     * instead. HTML is small enough to buffer (index.html is ~186 KB) and is
     * never cached hard anyway, so this costs one read per page load and
     * nothing on the assets it then requests. */
    if (type.startsWith('text/html')) {
      fs.readFile(full, 'utf8', (e, html) => {
        if (e) return send(res, 500, 'Read failed', 'text/plain');
        const body = Buffer.from(html.split('__KD_V__').join(APP_VERSION), 'utf8');
        head['Vary'] = 'Accept-Encoding';
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
          const gz = zlib.gzipSync(body, { level: 6 });
          head['Content-Encoding'] = 'gzip';
          head['Content-Length'] = gz.length;
          res.writeHead(200, head);
          return res.end(gz);
        }
        head['Content-Length'] = body.length;
        res.writeHead(200, head);
        res.end(body);
      });
      return;
    }

    /* ── Compression ──
     * Text compresses by roughly 4× and the shell is 1.5 MB of it. Images, PDFs
     * and fonts are already compressed, so deflating them burns CPU for
     * nothing — hence the type test rather than a blanket rule.
     *
     * `Vary: Accept-Encoding` is not optional: without it a shared cache can
     * hand a gzipped body to a client that cannot read it. */
    const compressible = /^(text\/|application\/(javascript|json|xml)|image\/svg)/.test(type);
    const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (compressible) head['Vary'] = 'Accept-Encoding';

    if (compressible && accepts) {
      head['Content-Encoding'] = 'gzip';
      res.writeHead(200, head);
      return fs.createReadStream(full)
        .on('error', () => { try { res.destroy(); } catch (e) {} })
        .pipe(zlib.createGzip({ level: 6 }))
        .pipe(res);
    }
    head['Content-Length'] = st.size;
    res.writeHead(200, head);
    fs.createReadStream(full)
      .on('error', () => { try { res.destroy(); } catch (e) {} })
      .pipe(res);
  });
}

/* ── Proxy an offloaded upload from R2 (bucket stays private) ── */
async function serveFromR2(req, res, rel) {
  const key = rel.replace(/^\/uploads\//, '');
  try {
    const obj = await r2.get(key);
    if (!obj.ok || !obj.hasBody) return send(res, obj.status === 404 ? 404 : 502, 'Not found', 'text/plain');
    // Offloaded files are content-addressed / versioned → cache hard, like local ones.
    const etag = obj.etag || (obj.contentLength ? '"' + obj.contentLength + '"' : null);
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': obj.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...(obj.contentLength ? { 'Content-Length': obj.contentLength } : {}),
      ...(etag ? { 'ETag': etag } : {}),
    });
    const stream = obj.stream();
    stream.on('error', () => { try { res.destroy(); } catch (e) {} });
    stream.pipe(res);
  } catch (e) {
    console.error('[R2 proxy]', key, e && e.message || e);
    return send(res, 502, 'Upstream error', 'text/plain');
  }
}

/* ── API ── */
async function handleApi(req, res, pathname) {
  const seg = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const method = req.method;
  /* One route carries raw bytes rather than JSON — the report files the browser
   * generated, on their way into an export package. Its body is deliberately
   * NOT read here: it is read in the handler, AFTER the session and the
   * permission have been checked, so an unauthorised caller cannot make the
   * server swallow sixty megabytes before being told no. */
  const isRawUpload = method === 'POST' &&
    seg[0] === 'export' && seg[1] === 'package' && seg[2] === 'attach';
  const body = (!isRawUpload && (method === 'POST' || method === 'PATCH' || method === 'PUT'))
    ? await readBody(req) : {};

  try {
    // GET /api/health  (used by Render health check — tests DB is alive)
    /* GET /api/health — unauthenticated liveness probe.
     *
     * `version` is included so no screen has to hard-code it. Three places used
     * to print a literal "v2.1" while the running build was 2.2.0, which meant
     * the About pane and the System Health pane disagreed inside the same
     * dialog. A version number is a fact about the server; it now comes from
     * the server. Nothing else is exposed here — this route is reachable
     * without a session. */
    if (method === 'GET' && seg[0] === 'health')
      return json(res, 200, { ok: true, db: !!dbmod.db, ts: Date.now(), version: APP_VERSION });

    /* GET /api/csrf — hand the page a CSRF token before it can post anything.
     * With a session: returns that session's server-side secret. Without one:
     * mints a double-submit value for the login POST. Safe to be unauthenticated
     * — the token authorises nothing on its own. */
    if (method === 'GET' && seg[0] === 'csrf') {
      const sid = parseCookies(req)[SID];
      let tok = sid ? repo.ensureCsrfToken(sid) : null;
      if (!tok) tok = require('node:crypto').randomBytes(32).toString('hex');
      setCsrfCookie(res, req, tok);
      return json(res, 200, { ok: true, csrfToken: tok });
    }

    /* ── CSRF + origin gate (P2.1 / P2.2) ──
     * Ahead of EVERY route, including /api/login, so a state-changing endpoint
     * cannot be reached cross-site no matter where it sits below. Placed here
     * rather than per-route deliberately: a route added later is protected by
     * default instead of being forgotten. */
    if (isStateChanging(method)) {
      const org = checkOrigin(req);
      if (!org.ok) {
        repo.logAuth('LOGIN', 'FAILURE', {
          username: (body && body.username) || null, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'cross-site request rejected (' + org.reason + ') ' + method + ' ' + pathname,
        });
        return json(res, 403, { ok: false, error: 'cross-site-request-blocked', reason: org.reason });
      }
      const csrf = checkCsrf(req);
      if (!csrf.ok) {
        repo.logAuth('LOGIN', 'FAILURE', {
          username: (body && body.username) || null, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'CSRF check failed (' + csrf.reason + ') ' + method + ' ' + pathname,
        });
        return json(res, 403, { ok: false, error: 'csrf-failed', reason: csrf.reason });
      }
    }

    /* POST /api/login — step one: username + password.
     * seg.length === 1 is load-bearing: without it this route also matches
     * /api/login/mfa, swallowing the second-factor request and answering it as
     * a login with an empty username — which fails closed, but breaks MFA
     * sign-in completely. */
    if (method === 'POST' && seg[0] === 'login' && seg.length === 1) {
      const uname = (body.username || '').trim();
      const ctx   = { ip: _clientIp(req), userAgent: _userAgent(req) };

      const wait = loginLockedFor(ctx.ip, uname);
      if (wait) {
        // Logged as LOCKED, not FAILURE: a burst of these is the signal an
        // analyst actually wants, and it must not be lost among bad-password rows.
        repo.logAuth('LOGIN', 'LOCKED', {
          username: uname, ip: ctx.ip, userAgent: ctx.userAgent,
          reason: 'rate-limited; retryAfter=' + wait + 's',
        });
        return json(res, 429, { ok: false, error: 'too-many-attempts', retryAfter: wait });
      }

      // repo.login writes its own SUCCESS/FAILURE audit row (it is the only
      // layer that can tell no-such-user from bad-password).
      const u = repo.login(uname, body.password || '', ctx);
      if (!u) {
        noteLoginFail(ctx.ip, uname);
        // One generic response for every failure mode — no user enumeration.
        return json(res, 401, { ok: false });
      }
      clearLoginFails(u.username);

      /* ── Second factor (P3) ──
       * The password is correct, but that is not yet a sign-in. No session
       * cookie is issued here unless the account has no second factor to
       * present — everything else goes through /api/login/mfa.
       *
       * A forced password change is handled AFTER MFA, not before: proving the
       * second factor is what establishes it is really this user. */
      const st = repo.getMfaStatus(u.username);
      const trusted = st && st.hasFactor &&
                      repo.isDeviceTrusted(u.username, parseCookies(req)[TRUST_COOKIE]);

      if (st && st.hasFactor && !trusted) {
        const ticket = issueMfaTicket(u.username, !!body.remember, ctx.ip);
        repo.logAuth('LOGIN', 'SUCCESS', {
          username: u.username, ip: ctx.ip, userAgent: ctx.userAgent,
          reason: 'password accepted; awaiting second factor',
        });
        return json(res, 200, {
          ok: true, mfaRequired: true, mfaTicket: ticket,
          methods: {
            totp: st.totpEnabled,
            passkey: st.passkeyCount > 0,
            recoveryCodes: st.recoveryCodesRemaining > 0,
          },
        });
      }

      // Policy says this role must have a factor, but none is enrolled. Let them
      // in far enough to enrol and no further — the gate below blocks the rest.
      const sess = repo.createSession(u.username, !!body.remember, ctx);
      setSessionCookie(res, req, sess.token, sess.maxAge);
      // Rotate the CSRF cookie to this session's secret. The pre-session
      // double-submit value used for the login POST is now dead — a new session
      // never inherits the old token.
      setCsrfCookie(res, req, sess.csrfToken, sess.maxAge);
      if (trusted) repo.logAuth('MFA_SUCCESS', 'SUCCESS', {
        username: u.username, ip: ctx.ip, userAgent: ctx.userAgent,
        reason: 'skipped — trusted device',
      });
      return json(res, 200, {
        ok: true, user: u, expiresAt: sess.expiresAt,
        mustChangePassword: !!u.mustChangePassword,
        mfaSetupRequired: !!(st && st.setupRequired),
        csrfToken: sess.csrfToken,
      });
    }

    /* POST /api/login/mfa — complete a sign-in with the second factor.
     * Body: { mfaTicket, method: 'totp'|'recovery', code, trustDevice }
     *
     * The ticket is the ONLY thing that carries the "password already verified"
     * fact. It is server-side, single-use and expires in 5 minutes, so this
     * endpoint cannot be used to skip the password step. */
    if (method === 'POST' && seg[0] === 'login' && seg[1] === 'mfa') {
      const ctx = { ip: _clientIp(req), userAgent: _userAgent(req) };

      // Peeked, not consumed: a mistyped code should not force the user back to
      // the password screen. The rate limiter below bounds the retries.
      const pending = peekMfaTicket(body.mfaTicket);
      if (!pending) return json(res, 401, { ok: false, error: 'mfa-ticket-invalid' });

      // MFA guessing is throttled on the same counters as password guessing —
      // otherwise a 6-digit code would be brute-forceable in ~500k attempts.
      const wait = loginLockedFor(ctx.ip, pending.username);
      if (wait) {
        repo.logAuth('MFA_FAILURE', 'LOCKED', {
          username: pending.username, ip: ctx.ip, userAgent: ctx.userAgent,
          reason: 'rate-limited; retryAfter=' + wait + 's',
        });
        return json(res, 429, { ok: false, error: 'too-many-attempts', retryAfter: wait });
      }

      let verified = false;
      if (body.method === 'recovery') {
        verified = repo.useRecoveryCode(pending.username, body.code, ctx).ok;
      } else {
        verified = repo.verifyTotp(pending.username, body.code, ctx).ok;
      }

      if (!verified) {
        noteLoginFail(ctx.ip, pending.username);
        return json(res, 401, { ok: false, error: 'invalid-code' });
      }

      takeMfaTicket(body.mfaTicket);            // spent
      clearLoginFails(pending.username);
      return finishLogin(req, res, pending.username, pending.remember, ctx, !!body.trustDevice);
    }

    /* ── Passwordless sign-in with a passkey (P3 Task 4) ──
     * Username + passkey, no password at all. Phishing-resistant: the signature
     * is bound to the origin by the browser, so a lookalike domain cannot
     * produce a valid assertion even with a fully convincing page. */

    // POST /api/webauthn/login/options { username } → challenge + allowCredentials
    if (method === 'POST' && seg[0] === 'webauthn' && seg[1] === 'login' && seg[2] === 'options') {
      const uname = String(body.username || '').trim();
      const creds = uname ? repo.listPasskeyCredentialIds(uname) : [];
      const challenge = webauthn.generateChallenge();
      // Keyed by challenge, not by username: an attacker must not be able to
      // overwrite a victim's in-flight challenge by starting their own.
      putChallenge('login:' + challenge, challenge, uname);
      // Always answer with a well-formed challenge even for an unknown user, so
      // this endpoint cannot be used to enumerate who has a passkey.
      return json(res, 200, {
        ok: true,
        challenge,
        rpId: webauthnRpId(req),
        timeout: 60000,
        userVerification: 'preferred',
        allowCredentials: creds.map(c => ({
          type: 'public-key', id: c.credential_id,
          transports: c.transports ? JSON.parse(c.transports) : undefined,
        })),
      });
    }

    // POST /api/webauthn/login/verify → session
    if (method === 'POST' && seg[0] === 'webauthn' && seg[1] === 'login' && seg[2] === 'verify') {
      const ctx = { ip: _clientIp(req), userAgent: _userAgent(req) };
      const rec = takeChallenge('login:' + String(body.challenge || ''));
      if (!rec) return json(res, 401, { ok: false, error: 'challenge-invalid' });

      const wait = loginLockedFor(ctx.ip, rec.username);
      if (wait) return json(res, 429, { ok: false, error: 'too-many-attempts', retryAfter: wait });

      const stored = repo.getPasskeyByCredentialId(String(body.credentialId || ''));
      if (!stored) {
        noteLoginFail(ctx.ip, rec.username);
        repo.logAuth('PASSKEY_LOGIN', 'FAILURE', {
          username: rec.username, ip: ctx.ip, userAgent: ctx.userAgent, reason: 'unknown credential',
        });
        return json(res, 401, { ok: false, error: 'unknown-credential' });
      }
      // The credential must belong to the account the ceremony was started for,
      // or one user's passkey could sign another user in.
      if (rec.username && stored.username !== rec.username) {
        noteLoginFail(ctx.ip, rec.username);
        repo.logAuth('PASSKEY_LOGIN', 'FAILURE', {
          username: rec.username, ip: ctx.ip, userAgent: ctx.userAgent,
          reason: 'credential belongs to a different account',
        });
        return json(res, 401, { ok: false, error: 'unknown-credential' });
      }

      const v = webauthn.verifyAssertion({
        authenticatorData: body.authenticatorData,
        clientDataJSON:    body.clientDataJSON,
        signature:         body.signature,
        expectedChallenge: rec.challenge,
        expectedOrigins:   webauthnOrigins(req),
        rpId:              webauthnRpId(req),
        storedPublicKey:   stored.public_key,
        prevCounter:       stored.counter,
      });
      if (!v.ok) {
        noteLoginFail(ctx.ip, stored.username);
        repo.logAuth('PASSKEY_LOGIN', 'FAILURE', {
          username: stored.username, ip: ctx.ip, userAgent: ctx.userAgent, reason: v.reason,
        });
        return json(res, 401, { ok: false, error: 'assertion-failed' });
      }

      repo.touchPasskey(stored.id, v.counter);
      clearLoginFails(stored.username);
      repo.logAuth('PASSKEY_LOGIN', 'SUCCESS', {
        username: stored.username, ip: ctx.ip, userAgent: ctx.userAgent,
        reason: 'passwordless; uv=' + v.userVerified,
      });
      // A passkey is a strong factor on its own — no TOTP challenge follows.
      return finishLogin(req, res, stored.username, !!body.remember, ctx, !!body.trustDevice);
    }

    // POST /api/logout — end this session. Deliberately OUTSIDE the gate: a
    // browser holding an expired//unknown token must still be able to get rid
    // of it, otherwise it keeps sending a dead cookie until it expires.
    if (method === 'POST' && seg[0] === 'logout') {
      const tok  = sessionToken(req);
      const who  = tok ? currentUser(req) : null;
      repo.deleteSession(tok);
      clearSessionCookie(res, req);
      // P2.5 — tell the browser to drop everything it holds for this origin, not
      // just the cookie we happen to know about. On a shared office machine the
      // cached bootstrap in localStorage is as sensitive as the session itself.
      // "executionContexts" is deliberately omitted: it forces a reload that
      // would cancel this very response in some browsers.
      res.setHeader('Clear-Site-Data', '"cookies", "storage", "cache"');
      if (who) repo.logAuth('LOGOUT', 'SUCCESS', {
        username: who.username, ip: _clientIp(req), userAgent: _userAgent(req),
      });
      return json(res, 200, { ok: true });
    }

    /* ── Gate ── everything past this line needs a real sign-in. */
    const sess = sessionOf(req);
    const me   = sess.ok ? sess.user : null;
    if (!me) {
      // The token we were handed is dead — tell the browser to drop it so it
      // stops being sent (and so the next sign-in starts from a clean slate).
      if (sessionToken(req)) clearSessionCookie(res, req);
      // `reason` distinguishes idle-timeout / absolute-lifetime / session-expired
      // from "never signed in", so the login page can say what happened. It
      // reveals nothing an attacker doesn't already know: they hold the token.
      return json(res, 401, { ok: false, error: 'auth-required', reason: sess.reason || 'no-token' });
    }

    // GET /api/me — who the server says you are (role included).
    if (method === 'GET' && seg[0] === 'me')
      return json(res, 200, { ok: true, user: me, mustChangePassword: !!me.mustChangePassword });

    /* POST /api/password — self-service change: { current, next }.
     * Sits ABOVE the must-change gate on purpose: it is the one action an
     * account with an expired/temporary password has to be able to perform. */
    if (method === 'POST' && seg[0] === 'password') {
      const ctx    = { ip: _clientIp(req), userAgent: _userAgent(req), actor: me.username };
      const status = repo.changeOwnPassword(me.username, body.current || '', body.next || '', ctx);
      if (status !== 'ok') {
        // 'missing' can only happen if the account vanished mid-session; report
        // it as a bad current password rather than confirming account state.
        const code = status === 'missing' ? 'bad-current' : status;
        return json(res, 400, { ok: false, error: code });
      }
      // changeOwnPassword revokes every session for the account, including this
      // one. Issue a fresh session so the user stays signed in — the old cookie
      // is already dead, so this is a rotation, not an extra grant.
      const sess = repo.createSession(me.username, false, ctx);
      setSessionCookie(res, req, sess.token, sess.maxAge);
      return json(res, 200, { ok: true, expiresAt: sess.expiresAt });
    }

    /* POST /api/logout-all — sign out every device for this account.
     * Body: { keepCurrent: true } to spare the device making the request.
     * Above the must-change gate on purpose: a user who suspects their account
     * is compromised must be able to evict everyone immediately, and that is
     * exactly the state a forced-password-change account can be in. */
    if (method === 'POST' && seg[0] === 'logout-all') {
      const ctx  = { ip: _clientIp(req), userAgent: _userAgent(req) };
      const tok  = sessionToken(req);
      const keep = body.keepCurrent !== false;          // default: stay signed in here
      const n    = repo.logoutAllSessions(me.username, keep ? tok : null, ctx);
      if (!keep) clearSessionCookie(res, req);
      return json(res, 200, { ok: true, revoked: n, keptCurrent: keep });
    }

    /* GET /api/sessions — this account's active devices.
     * DELETE /api/sessions/<id> — revoke one of them.
     * Scoped to the caller's OWN sessions. An admin deliberately does not get
     * to enumerate other people's devices here: that is a surveillance surface
     * with no operational need, and `deleteUserSessions` already exists for the
     * legitimate "revoke this account" case. */
    if (seg[0] === 'sessions') {
      const ctx = { ip: _clientIp(req), userAgent: _userAgent(req) };
      if (method === 'GET' && seg.length === 1)
        return json(res, 200, { ok: true, sessions: repo.listSessions(me.username, sessionToken(req)) });
      if (method === 'DELETE' && seg[1]) {
        const status = repo.revokeSession(me.username, parseInt(seg[1], 10), ctx);
        return json(res, status === 'ok' ? 200 : 404, { ok: status === 'ok', status: status });
      }
    }

    /* ── MFA management (P3) ───────────────────────────────────────
     * Above BOTH the must-change-password gate and the MFA-setup gate: these
     * are the routes an account in either of those states has to be able to
     * reach in order to get out of them. Everything here is scoped to
     * `me.username`, taken from the session — never from the body. */
    if (seg[0] === 'mfa') {
      const ctx = { ip: _clientIp(req), userAgent: _userAgent(req), actor: me.username };

      // GET /api/mfa/status — what factors this account has.
      if (method === 'GET' && seg[1] === 'status')
        return json(res, 200, { ok: true, status: repo.getMfaStatus(me.username) });

      // POST /api/mfa/totp/begin — secret + QR. Does NOT enable anything yet.
      if (method === 'POST' && seg[1] === 'totp' && seg[2] === 'begin') {
        const e = repo.beginTotpEnrolment(me.username);
        if (!e) return json(res, 404, { ok: false, error: 'missing' });
        return json(res, 200, {
          ok: true, secret: e.secret, otpauthUrl: e.otpauthUrl,
          qrSvg: qr.svg(e.otpauthUrl, { scale: 5 }),
        });
      }

      // POST /api/mfa/totp/confirm { code } — prove possession, then enable.
      if (method === 'POST' && seg[1] === 'totp' && seg[2] === 'confirm') {
        const r = repo.confirmTotpEnrolment(me.username, body.code, ctx);
        if (!r.ok) return json(res, 400, { ok: false, error: r.error });
        // Shown exactly once — they are not recoverable afterwards.
        return json(res, 200, { ok: true, recoveryCodes: r.recoveryCodes });
      }

      /* POST /api/mfa/disable { password } — re-authenticate first.
       * Turning off a second factor is exactly what a hijacked session would
       * want to do, so possession of the session is not enough. */
      if (method === 'POST' && seg[1] === 'disable') {
        if (!repo.login(me.username, body.password || '', ctx))
          return json(res, 403, { ok: false, error: 'password-required' });
        if (repo.mfaPolicyFor(me.role).required && repo.getMfaStatus(me.username).passkeyCount === 0)
          return json(res, 400, { ok: false, error: 'mfa-required-for-role' });
        repo.disableMfa(me.username, ctx);
        return json(res, 200, { ok: true });
      }

      // POST /api/mfa/recovery-codes { password } — regenerate, revoking the old set.
      if (method === 'POST' && seg[1] === 'recovery-codes') {
        if (!repo.login(me.username, body.password || '', ctx))
          return json(res, 403, { ok: false, error: 'password-required' });
        return json(res, 200, { ok: true, recoveryCodes: repo.regenerateRecoveryCodes(me.username, ctx) });
      }

      // Trusted devices
      if (method === 'GET' && seg[1] === 'trusted-devices')
        return json(res, 200, { ok: true, devices: repo.listTrustedDevices(me.username, parseCookies(req)[TRUST_COOKIE]) });
      if (method === 'DELETE' && seg[1] === 'trusted-devices' && seg[2]) {
        const s = repo.revokeTrustedDevice(me.username, parseInt(seg[2], 10), ctx);
        return json(res, s === 'ok' ? 200 : 404, { ok: s === 'ok', status: s });
      }
      if (method === 'POST' && seg[1] === 'trusted-devices' && seg[2] === 'revoke-all')
        return json(res, 200, { ok: true, revoked: repo.revokeAllTrustedDevices(me.username, ctx) });
    }

    /* ── Passkey management (authenticated) ── */
    if (seg[0] === 'webauthn' && seg[1] === 'register') {
      const ctx = { ip: _clientIp(req), userAgent: _userAgent(req) };

      // POST /api/webauthn/register/options → creation options
      if (method === 'POST' && seg[2] === 'options') {
        const challenge = webauthn.generateChallenge();
        putChallenge('reg:' + me.username, challenge, me.username);
        return json(res, 200, {
          ok: true,
          challenge,
          rp: { id: webauthnRpId(req), name: 'KD Database' },
          user: {
            // A random, stable-per-account handle rather than the username:
            // the user handle is stored on the authenticator and may be shown
            // on other devices, so it should not leak more than necessary.
            id: webauthn.b64u.encode(require('node:crypto')
                  .createHash('sha256').update('kd-user:' + me.username).digest()),
            name: me.username,
            displayName: me.name || me.username,
          },
          pubKeyCredParams: webauthn.SUPPORTED_ALGS.map(alg => ({ type: 'public-key', alg })),
          timeout: 60000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          excludeCredentials: repo.listPasskeyCredentialIds(me.username)
            .map(c => ({ type: 'public-key', id: c.credential_id })),
        });
      }

      // POST /api/webauthn/register/verify → store the credential
      if (method === 'POST' && seg[2] === 'verify') {
        const rec = takeChallenge('reg:' + me.username);
        if (!rec) return json(res, 400, { ok: false, error: 'challenge-invalid' });

        const v = webauthn.verifyRegistration({
          attestationObject: body.attestationObject,
          clientDataJSON:    body.clientDataJSON,
          expectedChallenge: rec.challenge,
          expectedOrigins:   webauthnOrigins(req),
          rpId:              webauthnRpId(req),
        });
        if (!v.ok) {
          repo.logAuth('PASSKEY_REGISTER', 'FAILURE', {
            username: me.username, ip: ctx.ip, userAgent: ctx.userAgent, reason: v.reason,
          });
          return json(res, 400, { ok: false, error: 'registration-failed', reason: v.reason });
        }
        const status = repo.addPasskey(me.username, {
          credentialId: v.credentialId, publicKey: v.publicKey, counter: v.counter,
          alg: v.alg, aaguid: v.aaguid, name: body.name, transports: body.transports,
        }, ctx);
        if (status !== 'ok') return json(res, 409, { ok: false, error: status });
        return json(res, 200, { ok: true, passkeys: repo.listPasskeys(me.username) });
      }
    }
    if (seg[0] === 'passkeys') {
      const ctx = { ip: _clientIp(req), userAgent: _userAgent(req) };
      if (method === 'GET' && seg.length === 1)
        return json(res, 200, { ok: true, passkeys: repo.listPasskeys(me.username) });
      if (method === 'DELETE' && seg[1]) {
        const s = repo.deletePasskey(me.username, parseInt(seg[1], 10), ctx);
        if (s === 'last-factor')
          return json(res, 400, { ok: false, error: 'last-factor',
            message: 'Your role requires MFA. Enrol another factor before removing this one.' });
        return json(res, s === 'ok' ? 200 : 404, { ok: s === 'ok', status: s });
      }
    }

    /* ── Forced password change ──
     * An account flagged must_change_password holds a credential somebody else
     * chose (the first-run seed, or an admin reset). Until it is replaced the
     * session may do nothing but identify itself, change the password, or sign
     * out. Enforced server-side so it cannot be skipped by calling the API
     * directly or by editing the front-end. */
    if (me.mustChangePassword)
      return json(res, 403, { ok: false, error: 'password-change-required' });

    /* ── MFA enrolment enforcement (P3 Task 5) ──
     * admin and manager MUST hold a second factor. Until one exists the session
     * can identify itself, sign out, and use the /api/mfa + /api/webauthn/register
     * routes above — nothing else. Enforced server-side so it cannot be skipped
     * by calling the API directly or editing the front-end.
     *
     * Recovery if this ever locks out the last administrator:
     *     npm run mfa-reset -- <username>
     * which requires filesystem access to the server, so it grants nothing to a
     * remote attacker. */
    if (repo.getMfaStatus(me.username)?.setupRequired)
      return json(res, 403, { ok: false, error: 'mfa-setup-required', role: me.role });

    /* ══════════════════════════════════════════════════════════════
     * RBAC authorisation gate
     * ══════════════════════════════════════════════════════════════
     * Replaces the previous binary rule ("any write requires role === admin").
     * Every API route below is matched against ROUTE_PERMISSIONS and refused
     * unless the account's role grants the required permission.
     *
     * DEFAULT DENY. A route with no entry in the table is refused outright
     * rather than allowed through — so adding a handler without declaring its
     * permission fails safe and loudly, instead of quietly shipping an
     * unprotected endpoint.
     *
     * Scope ('own' / 'team') is resolved per record inside the handlers via
     * authorizeRecord(); this gate settles the coarse question of whether the
     * role holds the permission at all. */
    const perms = repo.getPermissions(me.username);
    const roleRow = repo.getRole(me.username);
    me.permissions = perms;
    me.rank = roleRow ? roleRow.rank : null;

    const required = requiredPermission(method, seg, body);
    if (required === undefined) {
      console.error('[RBAC] no permission declared for', method, pathname, '— denied');
      return json(res, 403, { ok: false, error: 'forbidden', reason: 'route-not-declared' });
    }
    if (required !== null) {
      const verdict = rbac.check(perms, required, { actor: me.username });
      // A scoped grant reaches the handler, which then narrows per record. The
      // gate only rejects when the permission is absent altogether.
      const held = verdict.allowed || (perms && perms[required]);
      if (!held) {
        repo.logAuth('PERMISSION_DENIED', 'FAILURE', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'missing ' + required + ' for ' + method + ' ' + pathname + ' (role=' + me.role + ')',
        });
        return json(res, 403, {
          ok: false, error: 'forbidden', reason: 'missing-permission',
          permission: required, role: me.role,
        });
      }
      // Requirement 13: successful use of an authorisation-sensitive permission
      // is itself audit evidence, not just the failures.
      if (rbac.isSensitive(required) && method !== 'GET') {
        repo.logAuth('PERMISSION_USED', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: required + ' via ' + method + ' ' + pathname,
        });
      }
      me.grantedScope = perms[required];
      me.requiredPermission = required;
    }

    // GET /api/auth-log — the authentication audit trail. Admin-only: it lists
    // every account name that has ever been tried, which is itself a target.
    if (method === 'GET' && seg[0] === 'auth-log') {
      // Authorisation is handled by the RBAC gate above (audit.view); no role
      // name is tested here any more.
      const q = new url.URL(req.url, 'http://localhost').searchParams;
      const page = repo.queryAuthLog({
        limit: q.get('limit'), offset: q.get('offset'), username: q.get('username'),
        action: q.get('action'), result: q.get('result'),
        since: q.get('since'), until: q.get('until'), q: q.get('q'),
      });
      /* `log` is the pre-P4 field name and still carries the rows, so any older
       * client keeps working; the pagination envelope is additive. */
      return json(res, 200, {
        ok: true, log: page.rows, rows: page.rows,
        total: page.total, limit: page.limit, offset: page.offset,
        actions: repo.authLogActions(),
      });
    }

    // Identity is taken from the session, never from the request body, so the
    // activity log / uploaded-by can't be spoofed by editing the payload.
    if (body && typeof body === 'object') {
      body._by = me.username;
      if (seg[0] === 'employees' && seg[2] === 'documents') body.uploadedBy = me.username;
    }

    // GET /api/bootstrap
    if (method === 'GET' && seg[0] === 'bootstrap') {
      const data = repo.getBootstrap();
      // The account directory needs user.view; without it a caller sees only
      // themselves. Permission-based, not "is this an admin".
      if (!perms['user.view']) data.users = data.users.filter(u => u.username === me.username);
      return json(res, 200, {
        ok: true, empty: repo.countEmployees() === 0,
        // The client needs the permission set to render the UI honestly —
        // hiding buttons the account cannot use. This is presentation only:
        // the server has already decided, and re-decides on every request.
        me: Object.assign({}, me, { permissions: perms, rank: me.rank }),
        /* Which permission each export format needs. Sent rather than copied
         * into the client: the browser used to carry its own transcription of
         * this table, which meant a format could be offered in the UI and then
         * refused by the server — or worse, quietly hidden from somebody who
         * was entitled to it. There is one table, and this is it. */
        exportPermissions: rbac.EXPORT_FORMAT_PERMISSION,
        data,
      });
    }

    // POST /api/import
    if (method === 'POST' && seg[0] === 'import') {
      const payload = body || {};
      const groups = Array.isArray(payload.groups) ? payload.groups.length : 0;
      const workers = Array.isArray(payload.groups)
        ? payload.groups.reduce((n, g) => n + ((g && g.workers) ? g.workers.length : 0), 0) : 0;
      repo.importAll(payload);
      /* Named event with the shape of what arrived. A bulk import is one of the
       * few operations that can change thousands of records at once, so "how
       * many, into how many groups" belongs in the trail — not just the fact
       * that import.execute was exercised. */
      repo.logAuth('DATA_IMPORT', 'SUCCESS', {
        username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
        reason: 'groups=' + groups + '; workers=' + workers +
                '; users=' + (Array.isArray(payload.users) ? payload.users.length : 0),
      });
      return json(res, 200, { ok: true, data: repo.getBootstrap() });
    }

    // Groups
    if (seg[0] === 'groups') {
      if (method === 'GET' && seg[2] === 'activity')
        return json(res, 200, { ok: true, log: repo.getGroupActivity(seg[1]) });
      if (method === 'POST' && seg.length === 1) return json(res, 200, { ok: true, id: repo.createGroup(body) });
      if (method === 'POST' && seg[2] === 'employees') return json(res, 200, { ok: true, uid: repo.addEmployee(seg[1], body) });
      if (method === 'PATCH'  && seg[1]) {
        // 'team' scope: a Manager may only edit groups they supervise.
        const v = authorizeRecord(me, 'group.update', repo.getGroupOwner(seg[1]));
        if (!v.allowed) return denyScope(req, res, me, 'group.update', v);
        repo.updateGroup(seg[1], body); return json(res, 200, { ok: true });
      }
      // DELETE moves the group to the trash (soft-delete) — restorable.
      if (method === 'DELETE' && seg[1]) {
        const v = authorizeRecord(me, 'group.delete', repo.getGroupOwner(seg[1]));
        if (!v.allowed) return denyScope(req, res, me, 'group.delete', v);
        repo.softDeleteGroup(seg[1]); return json(res, 200, { ok: true });
      }
    }

    // Employees
    if (seg[0] === 'employees' && seg[1]) {
      // Activity log sub-resource
      if (method === 'GET' && seg[2] === 'activity')
        return json(res, 200, { ok: true, log: repo.getActivity(seg[1]) });

      // Documents sub-resource
      if (seg[2] === 'documents') {
        if (method === 'GET')
          return json(res, 200, { ok: true, docs: repo.listDocuments(seg[1]) });
        if (method === 'POST') {
          const r = repo.addDocument(seg[1], body.groupId, body.category, body.data, body.name, body.uploadedBy);
          return json(res, 200, { ok: true, ...r });
        }
      }
      if (method === 'PATCH')  {
        /* Record-level scope. This is where "Data Entry may edit OWN records"
         * and "Manager may edit TEAM records" are actually enforced — the gate
         * above only established that the role holds the permission at all. */
        const permKey = me.requiredPermission || 'employee.update';
        const v = authorizeRecord(me, permKey, repo.getEmployeeOwner(seg[1]));
        if (!v.allowed) return denyScope(req, res, me, permKey, v);
        repo.updateEmployee(seg[1], body); return json(res, 200, { ok: true });
      }
      // DELETE moves the worker to the trash (soft-delete) — restorable.
      if (method === 'DELETE') {
        const v = authorizeRecord(me, 'employee.delete', repo.getEmployeeOwner(seg[1]));
        if (!v.allowed) return denyScope(req, res, me, 'employee.delete', v);
        repo.softDeleteEmployee(seg[1]); return json(res, 200, { ok: true });
      }
    }

    // Trash (soft-delete bin)
    if (seg[0] === 'trash') {
      if (method === 'GET'  && seg.length === 1)     return json(res, 200, { ok: true, trash: repo.listTrash() });
      if (method === 'POST' && seg[1] === 'restore') {
        if (body.type === 'group') repo.restoreGroup(body.id); else repo.restoreEmployee(body.id);
        return json(res, 200, { ok: true, data: repo.getBootstrap() });
      }
      if (method === 'POST' && seg[1] === 'purge') {
        if (body.type === 'group') repo.deleteGroup(body.id); else repo.deleteEmployee(body.id);
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && seg[1] === 'empty')   { repo.emptyTrash(); return json(res, 200, { ok: true }); }
    }

    // Documents (delete by id)
    if (seg[0] === 'documents' && seg[1]) {
      if (method === 'DELETE') {
        const status = repo.deleteDocument(parseInt(seg[1], 10));
        return json(res, status === 'ok' ? 200 : 404, { ok: status === 'ok' });
      }
    }

    // Cities
    if (seg[0] === 'cities') {
      if (method === 'POST')   return json(res, 200, { ok: true, status: repo.addCity(body.country, body) });
      if (method === 'DELETE' && seg[1] && seg[2]) { repo.deleteCity(seg[1], seg[2]); return json(res, 200, { ok: true }); }
    }

    // Users. Every mutation is attributed to the signed-in admin in auth_log —
    // `actor` comes from the session, never from the body, so it can't be forged.
    if (seg[0] === 'users') {
      /* actorRank carries the rank invariant into the repository: no account may
       * create or promote another to a role at or above its own. Enforced in
       * repo.addUser / repo.setUserRole so it holds even if a future route
       * forgets to check. */
      const uctx = { ip: _clientIp(req), userAgent: _userAgent(req), actor: me.username, actorRank: me.rank };
      // A weak password is a client error, not a silent no-op: surface 400 so the
      // UI can show which rule failed instead of appearing to succeed.
      const userReply = (status) => {
        if (String(status).startsWith('weak-password'))
          return json(res, 400, { ok: false, error: status, policy: policy.passwordPolicy() });
        // P4: the new password matched one this account has used recently.
        if (status === 'password-reused')
          return json(res, 400, { ok: false, error: 'password-reused',
            historyDepth: policy.passwordPolicy().historyDepth });
        // A rank violation is an attempted privilege escalation, not a typo —
        // it is refused with 403 and recorded as such.
        if (status === 'rank-violation') {
          repo.logAuth('PERMISSION_DENIED', 'FAILURE', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'rank violation: attempted to assign a role at or above own rank (' + me.rank + ')',
          });
          return json(res, 403, { ok: false, error: 'rank-violation',
            message: 'You cannot create or promote an account to a role at or above your own.' });
        }
        if (status === 'unknown-role') return json(res, 400, { ok: false, error: 'unknown-role' });
        return json(res, 200, { ok: true, status: status });
      };

      /* GET /api/users — the account list for Administration → Users.
       * Never includes a password hash; see repo.listUsersAdmin. Gated on
       * user.view, which is a sensitive permission, so the read is itself
       * written to the audit trail by the gate above. */
      if (method === 'GET' && !seg[1])
        return json(res, 200, {
          ok: true,
          users: repo.listUsersAdmin(),
          roles: repo.listRoles(),
          // The caller's own rank, so the UI can grey out roles it may not
          // assign instead of offering them and collecting a 403.
          actorRank: me.rank,
        });

      if (method === 'POST')   return userReply(repo.addUser(body, uctx));
      if (method === 'PATCH'  && seg[1]) return userReply(repo.updateUser(seg[1], body, uctx));
      if (method === 'DELETE' && seg[1]) {
        // Deleting your own account would revoke the session mid-request and
        // could remove the last usable administrator by a different route.
        if (seg[1] === me.username) return json(res, 400, { ok: false, error: 'cannot-delete-self' });
        return json(res, 200, { ok: true, status: repo.deleteUser(seg[1], uctx) });
      }
    }

    /* GET /api/roles        — roles with grant + user counts
     * GET /api/permissions  — the permission catalogue
     * GET /api/roles/matrix — the full role × permission matrix
     *
     * P4 adds the write half (role.manage). System roles stay read-only for
     * their GRANTS — db.seedRbac() rewrites those from rbac.js on every boot, so
     * an edit would be silently reverted at the next restart and the screen
     * would be lying. Their MFA requirement IS editable, because that setting is
     * persisted outside the seed's reach (infra/policy.js). */
    if (seg[0] === 'roles') {
      const rctx = { ip: _clientIp(req), userAgent: _userAgent(req), actor: me.username, actorRank: me.rank };
      if (method === 'GET') {
        if (seg[1] === 'matrix') return json(res, 200, { ok: true, ...repo.getPermissionMatrix() });
        return json(res, 200, { ok: true, roles: repo.listRoles() });
      }
      const roleReply = (status) => {
        const map = {
          'ok': 200, 'dup': 409, 'missing': 404, 'invalid-key': 400,
          'system-role': 403, 'role-in-use': 409, 'rank-violation': 403, 'mfa-locked': 403,
        };
        const code = map[status] || 400;
        return json(res, code, code === 200 ? { ok: true, status } : { ok: false, error: status });
      };
      if (method === 'POST'  && !seg[1]) return roleReply(repo.createRole(body || {}, rctx));
      if (method === 'PATCH' && seg[1] && seg[2] === 'permissions')
        return roleReply(repo.setRolePermissions(seg[1], (body && body.grants) || [], rctx));
      if (method === 'PATCH'  && seg[1]) return roleReply(repo.updateRole(seg[1], body || {}, rctx));
      if (method === 'DELETE' && seg[1]) return roleReply(repo.deleteRole(seg[1], rctx));
    }
    if (method === 'GET' && seg[0] === 'permissions')
      return json(res, 200, { ok: true, permissions: repo.listPermissions(), groups: rbac.RESOURCE_GROUPS });

    /* ══════════════════════════════════════════════════════════════
     * P4 — Security centre
     * ══════════════════════════════════════════════════════════════
     * Every route here reuses an existing repo/policy function. Nothing
     * re-implements authentication, enrolment or session logic; these are views
     * onto it plus the four administrative actions the screens need.
     */
    if (seg[0] === 'security') {
      const sctx = { ip: _clientIp(req), userAgent: _userAgent(req), actor: me.username };

      // GET /api/security/overview — the summary cards + risk assessment.
      if (method === 'GET' && seg[1] === 'overview') {
        const overview = repo.securityOverview();
        /* Two facts the database cannot know, supplied by the layer that owns
         * them: the throttle lives in this process's memory, and the newest
         * backup is a file on disk. */
        let lastBackupAgeDays = null;
        try {
          const newest = admin.listBackupsDetailed()[0];
          if (newest && newest.createdAt)
            lastBackupAgeDays = Math.floor((Date.now() - Date.parse(newest.createdAt)) / 86400000);
        } catch (e) {}
        const locked = lockedAccountCount();
        /* P4.6: whether the newest backup has ever been verified. `false` only
         * when a backup exists and carries no recorded checksum — an unverifiable
         * artefact is a real gap; simply having no backups is already covered by
         * its own finding. */
        let backupVerified = null;
        try {
          const newest = admin.listBackupsDetailed()[0];
          if (newest) backupVerified = !!newest.sha256 && newest.sizeMatches !== false;
        } catch (e) {}
        const risk = repo.assessRisk(overview,
          { lockedAccounts: locked, lastBackupAgeDays, backupVerified,
            integrity: overview.integrity, passwordPolicy: policy.passwordPolicy() });
        return json(res, 200, {
          ok: true,
          overview: Object.assign({}, overview, { lockedAccounts: locked, lastBackupAgeDays }),
          risk,
          generatedAt: new Date().toISOString(),
        });
      }

      // GET/PATCH /api/security/policies — password, MFA and session policy.
      if (seg[1] === 'policies') {
        if (method === 'GET') return json(res, 200, { ok: true, policies: policy.all() });
        if (method === 'PATCH') {
          const kind = seg[2];
          const before = policy.all();
          let after;
          if (kind === 'password')      after = policy.setPasswordPolicy(body || {});
          else if (kind === 'mfa')      after = policy.setMfaPolicy(body || {});
          else if (kind === 'session')  after = policy.setSessionPolicy(body || {});
          else return json(res, 400, { ok: false, error: 'unknown-policy' });
          /* A policy change is an authorisation-relevant event in its own right:
           * it is how somebody would weaken the system before attacking it, so
           * the before/after pair is written to the trail, not just the fact of
           * a change. */
          /* POLICY_CHANGE, not ROLE_PERMISSION_CHANGE: a password-length change
           * and a role's grants changing are different events, and filtering the
           * trail for one used to return both. */
          repo.logAuth('POLICY_CHANGE', 'SUCCESS', {
            username: me.username, ip: sctx.ip, userAgent: sctx.userAgent,
            reason: kind + ' policy changed: ' + JSON.stringify(after).slice(0, 200),
          });
          return json(res, 200, { ok: true, policies: policy.all(), previous: before[kind] });
        }
      }

      // GET /api/security/mfa-overview — enrolled vs unenrolled accounts.
      if (method === 'GET' && seg[1] === 'mfa-overview')
        return json(res, 200, { ok: true, ...repo.mfaOverview() });

      // POST /api/security/mfa-enforce { username, required }
      if (method === 'POST' && seg[1] === 'mfa-enforce') {
        const target = String(body.username || '');
        if (!target) return json(res, 400, { ok: false, error: 'username-required' });
        const s = repo.setUserMfaRequired(target, body.required !== false, sctx);
        return json(res, s === 'ok' ? 200 : 404, { ok: s === 'ok', status: s });
      }

      // POST /api/security/mfa-reset { username } — clear factors, force re-enrolment.
      if (method === 'POST' && seg[1] === 'mfa-reset') {
        const target = String(body.username || '');
        if (!target) return json(res, 400, { ok: false, error: 'username-required' });
        /* Resetting your OWN factors through the administration screen would be
         * a one-click way to strip MFA from an admin account using nothing but a
         * hijacked session. Self-service disable already exists and asks for the
         * password; this route is for other people. */
        if (target === me.username) return json(res, 400, { ok: false, error: 'cannot-reset-self' });
        const s = repo.resetUserMfa(target, sctx);
        return json(res, s === 'ok' ? 200 : 404, { ok: s === 'ok', status: s });
      }

      // GET /api/security/sessions — per-account session COUNTS (never devices).
      if (method === 'GET' && seg[1] === 'sessions')
        return json(res, 200, { ok: true, summary: repo.sessionsSummary() });

      /* GET /api/security/audit-integrity — verify the hash chain (P4.6).
       *
       * The verification itself is recorded. That is not ceremony: knowing WHO
       * last checked the trail, and what they were told, is part of the evidence
       * an auditor needs — and it means a failed check cannot be quietly
       * observed and left unreported. */
      if (method === 'GET' && seg[1] === 'audit-integrity') {
        const report = repo.verifyAuditChain();
        repo.logAuth('AUDIT_VERIFY', report.ok ? 'SUCCESS' : 'FAILURE', {
          username: me.username, ip: sctx.ip, userAgent: sctx.userAgent,
          reason: report.available
            ? 'rows=' + report.rows + '; verified=' + report.verified +
              (report.ok ? '; chain intact'
                         : '; BROKEN at id ' + report.brokenAtId + ': ' + report.brokenReason)
            : 'chain unavailable: ' + (report.error || 'unknown'),
        });
        return json(res, 200, { ok: true, integrity: report });
      }

      /* POST /api/security/audit-reanchor — rebuild the chain deliberately.
       *
       * Exists for the legitimate case where the chain is broken and the operator
       * has established why (a restored file from a build without chaining, a
       * recovered key). It is the one operation that can make a broken chain read
       * as intact, so it demands a written reason, records the pre-rebuild head,
       * and is itself audited. */
      if (method === 'POST' && seg[1] === 'audit-reanchor') {
        const why = String((body && body.reason) || '').trim();
        if (why.length < 8)
          return json(res, 400, { ok: false, error: 'reason-required',
            message: 'Rebuilding the audit chain requires a written reason of at least 8 characters.' });
        const before = repo.verifyAuditChain();
        const r = repo.reanchorAuditChain('manual: ' + why.slice(0, 160), me.username);
        repo.logAuth('AUDIT_REANCHOR', r.ok ? 'SUCCESS' : 'FAILURE', {
          username: me.username, ip: sctx.ip, userAgent: sctx.userAgent,
          reason: 'reason=' + why.slice(0, 100) +
                  '; was ' + (before.ok ? 'intact' : 'broken at ' + before.brokenAtId) +
                  '; rows=' + (r.rows || 0) + '; prevHead=' + String(r.prevHead || '').slice(0, 16),
        });
        return json(res, r.ok ? 200 : 500, { ok: r.ok, result: r, before });
      }

      // POST /api/security/revoke-sessions { username }
      if (method === 'POST' && seg[1] === 'revoke-sessions') {
        const target = String(body.username || '');
        if (!target) return json(res, 400, { ok: false, error: 'username-required' });
        const r = repo.adminRevokeUserSessions(target, sctx);
        return json(res, r.status === 'ok' ? 200 : 404, { ok: r.status === 'ok', ...r });
      }

      // POST /api/security/revoke-trusted { username }
      if (method === 'POST' && seg[1] === 'revoke-trusted') {
        const target = String(body.username || '');
        if (!target) return json(res, 400, { ok: false, error: 'username-required' });
        const r = repo.adminRevokeUserTrusted(target, sctx);
        return json(res, r.status === 'ok' ? 200 : 404, { ok: r.status === 'ok', ...r });
      }
    }

    // App settings (server-persisted key-value) — POST /api/settings { key, value }
    if (seg[0] === 'settings' && method === 'POST') {
      return json(res, 200, { ok: true, status: repo.setSetting(body.key, body.value) });
    }

    /* ── /api/export/package — the per-worker package (photos + documents) ──
     *
     * Three routes, because the build cannot fit inside one request: the site is
     * served through a Cloudflare tunnel that cuts the origin at ~100s, and a
     * package of any size takes longer than that.
     *
     *   POST /api/export/package               start a build   → { jobId }
     *   GET  /api/export/package/<id>          progress
     *   GET  /api/export/package/<id>/download stream the ZIP
     *
     * All three sit on export.package (Admin only) via requiredPermission, and
     * the module additionally refuses a job that belongs to another account.
     */
    if (seg[0] === 'export' && seg[1] === 'package') {
      /* POST /api/export/package/attach — one browser-generated report file.
       * Raw body, streamed straight to a staging file; the id it returns is
       * handed back with the build request. */
      if (method === 'POST' && seg[2] === 'attach') {
        const name = (() => {
          try { return decodeURIComponent(String(req.headers['x-kd-filename'] || '')); }
          catch (e) { return ''; }
        })() || 'report.bin';
        const r = await exportPackage.stage(req, name, me.username);
        if (r.refused) return json(res, r.reason === 'attachment-too-large' ? 413 : 400,
                                   { ok: false, error: r.reason });
        return json(res, 200, { ok: true, ...r });
      }

      if (method === 'POST' && !seg[2]) {
        const uids = Array.isArray(body && body.uids) ? body.uids : [];
        const job = exportPackage.start({
          uids, by: me.username, options: (body && body.options) || {},
          attachments: Array.isArray(body && body.attachments) ? body.attachments : [],
        });
        if (job.refused) {
          repo.logAuth('DATA_EXPORT', 'FAILURE', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'format=package; refused=' + job.reason +
                    (job.asked ? '; asked=' + job.asked + '; limit=' + job.limit : ''),
          });
          return json(res, job.reason === 'busy' ? 429 : 400, { ok: false, error: job.reason, ...job });
        }
        /* Recorded when the build STARTS, not when it finishes: the selection
         * has been made and the data is already being assembled, so that is the
         * moment the export happened as far as the trail is concerned. */
        repo.logAuth('DATA_EXPORT', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'format=package; scope=' + String((body && body.scope) || 'picked').slice(0, 24) +
                  '; records=' + job.total + '; job=' + job.id.slice(0, 8) +
                  '; permission=export.package',
        });
        return json(res, 200, { ok: true, job });
      }

      if (method === 'GET' && seg[2] && !seg[3]) {
        const job = exportPackage.status(seg[2], me.username);
        if (!job) return json(res, 404, { ok: false, error: 'not-found' });
        return json(res, 200, { ok: true, job });
      }

      if (method === 'GET' && seg[2] && seg[3] === 'download') {
        const f = exportPackage.fileFor(seg[2], me.username);
        if (!f) return json(res, 404, { ok: false, error: 'not-found' });
        repo.logAuth('EXPORT_PACKAGE_DOWNLOAD', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + f.diskFile + '; bytes=' + f.bytes + '; workers=' + f.workers +
                  '; documents=' + f.documents + '; photos=' + f.photos +
                  (f.skipped ? '; skipped=' + f.skipped : ''),
        });
        /* A group name may be Lao or Thai, and a bare filename="…" carrying
         * those bytes is not valid in a header — browsers guess, and the saved
         * file comes out mangled. RFC 5987's filename* carries the real name;
         * the ASCII filename= stays as the fallback for anything that ignores it. */
        const asciiName = f.file.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': f.bytes,
          // Attachment + no-store: this is passport scans in the clear, and it
          // must never be rendered inline or held by an intermediary.
          'Content-Disposition': 'attachment; filename="' + asciiName + '"' +
                                 "; filename*=UTF-8''" + encodeURIComponent(f.file),
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(f.path).pipe(res);
      }
      return json(res, 404, { ok: false, error: 'not-found' });
    }

    /* POST /api/export — the authorisation + audit step every export goes
     * through before the browser writes a file. The gate above has already
     * refused the call if the account lacks the grant for this format, so
     * reaching here means the export is permitted; all that is left is to name
     * it in the trail. Body: { format, scope, records } */
    if (seg[0] === 'export' && method === 'POST') {
      const fmt   = String((body && body.format) || 'unknown').slice(0, 24);
      const scope = String((body && body.scope) || 'unknown').slice(0, 24);
      const count = Number.isFinite(+(body && body.records)) ? Math.max(0, +body.records) : null;

      /* ── Export receipt (P4.6) ──
       * A short id the client stamps into the exported file, so a leaked
       * document can be traced back to the export that produced it. The tag is
       * an HMAC over the receipt's own fields using the audit-chain key, which
       * means a plausible-looking id cannot be invented by hand — only the
       * server can mint one, and only the server can confirm one is genuine.
       *
       * What this is: attribution and provenance. What it is NOT: DRM. A visible
       * line in a CSV can be deleted by whoever received the file, and nothing
       * client-side can prevent that. It raises the effort and, more usefully,
       * makes the ordinary case — a file forwarded as-is — traceable. */
      const stamp = new Date();
      const rand = require('node:crypto').randomBytes(4).toString('hex');
      const exportId = 'EXP-' + stamp.toISOString().slice(0, 10).replace(/-/g, '') + '-' + rand;
      let tag = null;
      try {
        const key = require('../infra/audit-chain').loadKey(dbmod.DB_DIR);
        tag = require('node:crypto').createHmac('sha256', key)
          .update([exportId, me.username, fmt, scope, count == null ? '' : count].join('|'))
          .digest('hex').slice(0, 16);
      } catch (e) { /* no key ⇒ untagged receipt; the audit row still records it */ }

      repo.logAuth('DATA_EXPORT', 'SUCCESS', {
        username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
        reason: 'id=' + exportId + '; format=' + fmt + '; scope=' + scope +
                (count == null ? '' : '; records=' + count) +
                '; permission=' + rbac.exportPermissionFor(fmt) +
                (tag ? '; tag=' + tag : '; tag=unavailable'),
      });
      return json(res, 200, {
        ok: true, format: fmt, recorded: true,
        exportId, tag,
        issuedAt: stamp.toISOString(),
        issuedTo: me.username,
        /* A single line the client embeds verbatim. Assembled here so every
         * export format carries identical wording, and so the watermark cannot
         * drift out of step with what the audit row says. */
        watermark: 'KD Database confidential — ' + exportId +
                   ' — exported by ' + me.username +
                   ' on ' + stamp.toISOString() +
                   (tag ? ' — ' + tag : ''),
      });
    }

    // AI document extraction (Gemini) — POST /api/ai/extract { image, docType }
    if (seg[0] === 'ai' && seg[1] === 'extract' && method === 'POST') {
      const r = await ai.extract(body.image, body.docType);
      return json(res, 200, r);
    }

    // Admin
    if (seg[0] === 'admin') {
      if (method === 'POST' && seg[1] === 'backup') {
        const file = admin.backup({ by: me.username, reason: 'manual' });
        const entry = admin.listBackupsDetailed().find(e => e.file === file);
        repo.logAuth('BACKUP_CREATE', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + file + (entry ? '; bytes=' + entry.size : ''),
        });
        return json(res, 200, { ok: true, file });
      }

      /* GET /api/admin/backups — the inventory.
       *
       * `files` and `entries` keep their pre-P5.1 meaning: DATABASE SNAPSHOTS
       * only. Older clients and the P4/P4.6 suites depend on that, and quietly
       * mixing packages into `files` would have them treat a .zip as a .db.
       * `inventory` and `packages` are the new, additive views. */
      if (method === 'GET'  && seg[1] === 'backups' && !seg[2]) {
        const entries = admin.listBackupsDetailed();
        const inventory = admin.listAll();
        return json(res, 200, {
          ok: true,
          files: entries.map(e => e.file),
          entries,
          inventory,
          packages: inventory.filter(b => b.kind === admin.KIND_FULL),
          health: admin.backupHealth(),
        });
      }

      /* POST /api/admin/backups/full — create a COMPLETE system package.
       *
       * Database + every upload + the audit-chain key + a manifest. This is the
       * artefact that actually recovers the business; the .db route above
       * remains for fast database-only snapshots. */
      if (method === 'POST' && seg[1] === 'backups' && seg[2] === 'full') {
        const t0 = Date.now();
        try {
          const r = backupPackage.createPackage({
            dir: admin.BACKUP_DIR, by: me.username,
            reason: String((body && body.reason) || 'manual'),
          });
          admin.recordPackage(r.file, {
            by: me.username, reason: String((body && body.reason) || 'manual'),
            sha256: r.sha256, size: r.bytes, manifest: r.manifest, at: r.manifest.created_at,
          });
          repo.logAuth('BACKUP_PACKAGE_CREATE', 'SUCCESS', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'file=' + r.file + '; bytes=' + r.bytes +
                    '; uploads=' + r.manifest.uploads.file_count +
                    '; db=' + r.manifest.database_size +
                    '; key=' + (r.manifest.audit_chain.key_present ? 'included' : 'absent') +
                    '; sha256=' + r.sha256.slice(0, 16),
          });
          return json(res, 200, { ok: true, file: r.file, bytes: r.bytes,
            sha256: r.sha256, manifest: r.manifest, durationMs: r.durationMs });
        } catch (e) {
          repo.logAuth('BACKUP_PACKAGE_CREATE', 'FAILURE', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'failed after ' + (Date.now() - t0) + 'ms: ' + String(e && e.message || e).slice(0, 160),
          });
          return json(res, 500, { ok: false, error: String(e && e.message || e) });
        }
      }

      /* GET /api/admin/backup-health — the dashboard (Phase 7). */
      if (method === 'GET' && seg[1] === 'backup-health')
        return json(res, 200, { ok: true, health: admin.backupHealth() });

      /* POST /api/admin/retention — apply the retention policy (Phase 8).
       * `dryRun` is what the UI calls first, so an operator always sees what
       * would be deleted before anything is. */
      if (method === 'POST' && seg[1] === 'retention') {
        const r = admin.applyRetention({
          keepFull: body && body.keepFull, keepDb: body && body.keepDb,
          dryRun: !!(body && body.dryRun),
        });
        if (!r.dryRun) {
          repo.logAuth('BACKUP_RETENTION', 'SUCCESS', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'keepFull=' + r.keepFull + '; keepDb=' + r.keepDb +
                    '; deleted=' + r.deleted.length + '; freed=' + r.freedBytes +
                    '; protected=' + r.protected.join(',').slice(0, 120),
          });
        }
        return json(res, 200, { ok: true, result: r });
      }

      /* POST /api/admin/backups/<file>/offsite — copy to R2 and verify it (Phase 6). */
      if (method === 'POST' && seg[1] === 'backups' && seg[2] && seg[3] === 'offsite') {
        const file = decodeURIComponent(seg[2]);
        if (!admin.backupPath(file)) return json(res, 404, { ok: false, error: 'not-found' });
        const r = await admin.uploadOffsite(file, { by: me.username });
        repo.logAuth('BACKUP_OFFSITE_UPLOAD', r.ok ? 'SUCCESS' : 'FAILURE', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + file +
                  (r.offsite ? '; key=' + r.offsite.key + '; bytes=' + r.offsite.bytes +
                               '; status=' + r.offsite.status +
                               '; sizeMatch=' + r.offsite.sizeMatches +
                               '; checksumMatch=' + r.offsite.checksumMatches
                             : '; error=' + String(r.error || 'unknown')),
        });
        return json(res, r.ok ? 200 : 400, { ok: r.ok, offsite: r.offsite, error: r.error });
      }

      /* POST /api/admin/backups/<file>/restore — restore a FULL package.
       *
       * Three audit events by design (Phase 5): STARTED before anything is
       * touched, then COMPLETED or FAILED. A restore that starts and never
       * finishes leaves the STARTED event as the only evidence, which is exactly
       * what an investigator needs to find. */
      if (method === 'POST' && seg[1] === 'backups' && seg[2] && seg[3] === 'restore') {
        const file = decodeURIComponent(seg[2]);
        const abs = admin.backupPath(file);
        if (!abs) return json(res, 404, { ok: false, error: 'not-found' });
        if (!/\.zip$/i.test(file))
          return json(res, 400, { ok: false, error: 'not-a-package',
            message: 'Use /api/admin/restore for database-only snapshots.' });

        const meta = admin.listAll().find(b => b.file === file) || {};
        repo.logAuth('BACKUP_RESTORE_STARTED', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + file + '; allowPartial=' + !!(body && body.allowPartial),
        });

        let r;
        try {
          r = backupPackage.restorePackage(abs, {
            by: me.username, backupDir: admin.BACKUP_DIR,
            expectSha256: meta.sha256 || undefined,
            allowPartial: !!(body && body.allowPartial),
            dryRun: !!(body && body.dryRun),
          });
        } catch (e) {
          repo.logAuth('BACKUP_RESTORE_FAILED', 'FAILURE', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'file=' + file + '; threw: ' + String(e && e.message || e).slice(0, 180),
          });
          return json(res, 500, { ok: false, error: String(e && e.message || e) });
        }

        if (!r.ok) {
          repo.logAuth('BACKUP_RESTORE_FAILED', 'FAILURE', {
            username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
            reason: 'file=' + file + '; reason=' + r.reason +
                    (r.error ? '; ' + String(r.error).slice(0, 120) : '') +
                    '; status=' + (r.verification ? r.verification.status : '?'),
          });
          return json(res, r.refused ? 400 : 500, {
            ok: false, refused: !!r.refused, reason: r.reason, error: r.error,
            verification: r.verification, stages: r.stages,
          });
        }

        repo.logAuth('BACKUP_RESTORE_COMPLETED', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + file + '; uploads=' + r.restored.uploadFiles +
                  '; auditCarried=' + r.preservedAuditRows +
                  '; key=' + r.keyAction +
                  '; preRestore=' + (r.safetyCopy || 'FAILED') +
                  '; took=' + r.durationMs + 'ms',
        });
        return json(res, 200, { ok: true, result: r, data: repo.getBootstrap() });
      }

      /* GET /api/admin/backups/<file>/download — stream one backup.
       *
       * The response is a whole copy of the database, so it is treated as such:
       * gated on backup.create, attributed in the audit trail, and served with
       * Content-Disposition: attachment and no-store so it cannot be rendered
       * inline or cached by an intermediary. admin.backupPath() reduces the
       * argument to a basename, so no path can escape the backups directory. */
      if (method === 'GET' && seg[1] === 'backups' && seg[2] && seg[3] === 'download') {
        const p = admin.backupPath(decodeURIComponent(seg[2]));
        if (!p) return json(res, 404, { ok: false, error: 'not-found' });
        repo.logAuth('BACKUP_DOWNLOAD', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + path.basename(p) + '; bytes=' + fs.statSync(p).size,
        });
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fs.statSync(p).size,
          'Content-Disposition': 'attachment; filename="' + path.basename(p) + '"',
          'Cache-Control': 'no-store',
        });
        return fs.createReadStream(p).pipe(res);
      }

      /* POST /api/admin/backups/<file>/verify — is this backup restorable?
       * GET  /api/admin/backups/<file>/preview — what would restoring it change?
       *
       * Both open the file READ-ONLY, so neither can damage the artefact being
       * examined. Verify is a POST because it is a deliberate, recorded act, not
       * an idempotent read — the operator is asserting they checked. */
      /* P5.1: verify and preview dispatch on the artefact's KIND. A package needs
       * the four-part check (database, audit chain, uploads, manifest); a database
       * snapshot keeps the P4.6 check it already had. */
      if (seg[1] === 'backups' && seg[2] && seg[3] === 'verify' && method === 'POST' &&
          /\.zip$/i.test(decodeURIComponent(seg[2]))) {
        const file = decodeURIComponent(seg[2]);
        const abs = admin.backupPath(file);
        if (!abs) return json(res, 404, { ok: false, error: 'not-found' });
        const meta = admin.listAll().find(b => b.file === file) || {};
        const report = backupPackage.verifyPackage(abs, {
          deep: !!(body && body.deep), expectSha256: meta.sha256 || undefined,
        });
        admin.recordVerification(file, report);
        repo.logAuth('BACKUP_VERIFY', report.status !== 'corrupted' ? 'SUCCESS' : 'FAILURE', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'package=' + file + '; status=' + report.status +
                  '; db=' + report.databaseValid + '; audit=' + report.auditValid +
                  '; uploads=' + report.uploadsValid + '; manifest=' + report.manifestValid +
                  '; checked=' + report.uploads.checked + '/' + report.uploads.expected +
                  (report.uploads.missing.length ? '; missing=' + report.uploads.missing.length : '') +
                  (report.uploads.corrupt.length ? '; corrupt=' + report.uploads.corrupt.length : '') +
                  '; deep=' + !!(body && body.deep),
        });
        return json(res, 200, { ok: true, report });
      }
      if (seg[1] === 'backups' && seg[2] && seg[3] === 'preview' && method === 'GET' &&
          /\.zip$/i.test(decodeURIComponent(seg[2]))) {
        const file = decodeURIComponent(seg[2]);
        const abs = admin.backupPath(file);
        if (!abs) return json(res, 404, { ok: false, error: 'not-found' });
        const meta = admin.listAll().find(b => b.file === file) || {};
        return json(res, 200, { ok: true,
          preview: backupPackage.previewPackage(abs, { expectSha256: meta.sha256 || undefined }) });
      }

      if (seg[1] === 'backups' && seg[2] && seg[3] === 'verify' && method === 'POST') {
        const report = admin.verifyBackup(decodeURIComponent(seg[2]));
        admin.recordVerification(decodeURIComponent(seg[2]), report);
        repo.logAuth('BACKUP_VERIFY', report.ok ? 'SUCCESS' : 'FAILURE', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + report.file +
                  '; integrity=' + (report.integrity || 'n/a') +
                  '; checksum=' + (report.checksumOk === null ? 'not-recorded' : report.checksumOk ? 'match' : 'MISMATCH') +
                  (report.missingTables.length ? '; missing tables=' + report.missingTables.join(',') : '') +
                  (report.errors.length ? '; errors=' + report.errors.join(',').slice(0, 80) : ''),
        });
        return json(res, 200, { ok: true, report });
      }
      if (seg[1] === 'backups' && seg[2] && seg[3] === 'preview' && method === 'GET') {
        return json(res, 200, { ok: true, preview: admin.previewRestore(decodeURIComponent(seg[2])) });
      }

      /* GET /api/admin/health — the Monitoring section in one call.
       * Three cheap reads (row counts, pragmas, a directory walk) plus this
       * process's own figures. Deliberately one endpoint rather than three: the
       * screen shows them together, and three round trips would only make the
       * numbers disagree with each other. */
      if (method === 'GET' && seg[1] === 'health') {
        const mem = process.memoryUsage();
        let storage = null, r2info = null;
        try {
          storage = admin.storageStats();
          r2info = { enabled: r2.isEnabled(), pending: r2.isEnabled() ? offload.pendingCount() : null };
        } catch (e) {}
        const backups = admin.listBackupsDetailed();
        return json(res, 200, {
          ok: true,
          app: {
            name: 'KD Database',
            version: APP_VERSION,
            node: process.version,
            platform: process.platform,
            pid: process.pid,
            uptimeSeconds: Math.floor(process.uptime()),
            startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            serverTime: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
          },
          database: Object.assign({ path: dbmod.DB_PATH }, repo.databaseStatus()),
          stats: repo.systemStats(),
          storage,
          r2: r2info,
          memory: {
            rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external,
          },
          backups: {
            count: backups.length,
            newest: backups[0] || null,
            totalBytes: backups.reduce((a, b) => a + (b.size || 0), 0),
          },
        });
      }
      // Read-only disk-usage breakdown (db / uploads / backups + orphan + VACUUM estimate)
      if (method === 'GET'  && seg[1] === 'storage') {
        const stats = admin.storageStats();
        return json(res, 200, { ok: true, stats, r2: { enabled: r2.isEnabled(), pending: r2.isEnabled() ? offload.pendingCount() : null } });
      }
      // Reclaim space (all non-destructive to live data). Body: { orphans, vacuum, pruneKeep }
      if (method === 'POST' && seg[1] === 'cleanup') {
        const before = admin.storageStats();
        const result = {};
        if (body.orphans !== false)              result.orphans = admin.cleanOrphans();
        if (typeof body.pruneKeep === 'number')  result.backups = admin.pruneBackups(body.pruneKeep);
        if (body.vacuum !== false)               result.db = admin.vacuum();
        return json(res, 200, { ok: true, result, before, after: admin.storageStats() });
      }
      // Push the local upload backlog to R2 now (rather than waiting for the timer).
      if (method === 'POST' && seg[1] === 'offload') {
        if (!r2.isEnabled()) return json(res, 400, { ok: false, error: 'R2 not configured' });
        const summary = await offload.sweepReferenced({ limit: body.limit || 0 });
        return json(res, 200, { ok: true, summary, pending: offload.pendingCount() });
      }
      if (method === 'POST' && seg[1] === 'restore') {
        const r = admin.restore(body.file, { by: me.username });
        /* Logged AFTER the swap, so the entry lands in the restored database and
         * survives. admin.restore() carries the pre-restore trail across, and
         * the count is recorded here because "how much evidence was preserved"
         * is the first thing an auditor asks about a restore. */
        repo.logAuth('BACKUP_RESTORE', 'SUCCESS', {
          username: me.username, ip: _clientIp(req), userAgent: _userAgent(req),
          reason: 'file=' + String(body.file || '').slice(0, 100) +
                  '; audit rows carried forward=' + (r && r.preservedAuditRows != null ? r.preservedAuditRows : '?') +
                  // Recorded either way: an operator reading the trail later needs
                  // to know whether the overwritten state can still be recovered.
                  (r && r.safetyError ? '; PRE-RESTORE BACKUP FAILED: ' + String(r.safetyError).slice(0, 80)
                                      : '; pre-restore copy=' + (r && r.safetyCopy || 'none')),
        });
        return json(res, 200, { ok: true, data: repo.getBootstrap(),
          preservedAuditRows: r && r.preservedAuditRows,
          safetyCopy: r && r.safetyCopy, safetyError: r && r.safetyError });
      }
      if (method === 'POST' && seg[1] === 'reset')   { admin.reset(); return json(res, 200, { ok: true, data: repo.getBootstrap() }); }
    }

    return json(res, 404, { ok: false, error: 'Unknown endpoint' });
  } catch (e) {
    console.error('[API]', method, pathname, e);
    return json(res, 500, { ok: false, error: String(e && e.message || e) });
  }
}

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname;
  applySecurityHeaders(res, pathname);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  // Bind to 0.0.0.0 (all interfaces — needed by Render), but tell the user to
  // open localhost: browsers can't connect to 0.0.0.0 (ERR_ADDRESS_INVALID on Windows).
  console.log('KD Database server  →  http://localhost:' + PORT);
  console.log('SQLite file         →  ' + dbmod.DB_PATH);
  if (r2.isEnabled()) {
    const t = r2.selfTestSigner();
    console.log('R2 offload          →  ENABLED (bucket "' + r2.cfg().bucket + '")' + (t.ok ? '' : '  ⚠ SIGNER SELF-TEST FAILED'));
  } else {
    console.log('R2 offload          →  disabled (serving uploads from local disk). Set R2_* env vars to enable.');
  }
});

// ── Background offload to R2 ───────────────────────────────────────
// Mirror referenced upload files to R2 and free the local copy so the volume
// stops filling. Runs in small batches; only deletes local after verifying the
// remote copy. No-op when R2 is disabled. (One-time backlog can be pushed faster
// with: node infra/scripts/migrate-uploads-to-r2.js)
let _sweeping = false;
async function offloadTick() {
  if (_sweeping || !r2.isEnabled()) return;
  _sweeping = true;
  try {
    const s = await offload.sweepReferenced({ limit: 40 });
    if (s && (s.uploaded || s.already)) {
      console.log(`Offload → R2: ${s.uploaded} uploaded, ${s.already} verified, freed ${(s.freedBytes/1048576).toFixed(1)}MB` + (s.errors ? `, ${s.errors} errors` : ''));
    }
  } catch (e) { console.error('[offload] tick failed:', e && e.message || e); }
  finally { _sweeping = false; }
}
if (r2.isEnabled()) {
  setTimeout(offloadTick, 20 * 1000).unref();            // shortly after boot
  const _off = setInterval(offloadTick, 5 * 60 * 1000);  // then every 5 min
  if (_off.unref) _off.unref();
}

// Periodically fold the WAL back into kd.db so the main file never lags far
// behind and the WAL can't grow without bound during a long-running session.
const _ckpt = setInterval(() => dbmod.checkpoint('PASSIVE'), 60 * 1000);
if (_ckpt.unref) _ckpt.unref();

// ── Automatic backup every 3 days ─────────────────────────────────
// Keeps a clean SQLite snapshot under data/backups/. The "last backup" time is
// read from the newest backup file's mtime, so the 3-day cadence survives server
// restarts (no extra state to persist) and never double-backs-up on a reboot.
// Old backups are kept indefinitely (no auto-pruning) — by user preference.
const BACKUP_EVERY_MS = 3 * 24 * 60 * 60 * 1000;
function _lastBackupMs() {
  try {
    const files = admin.listBackups();            // newest first
    if (!files.length) return 0;
    return fs.statSync(path.join(admin.BACKUP_DIR, files[0])).mtimeMs;
  } catch (e) { return 0; }
}
function maybeAutoBackup() {
  try {
    if (Date.now() - _lastBackupMs() >= BACKUP_EVERY_MS) {
      console.log('Auto-backup (3-day) →', admin.backup());
    }
  } catch (e) { console.error('[auto-backup] failed:', e && e.message || e); }
}
setTimeout(maybeAutoBackup, 15 * 1000).unref();          // catch up shortly after boot
const _bk = setInterval(maybeAutoBackup, 6 * 60 * 60 * 1000);   // re-check every 6h
if (_bk.unref) _bk.unref();

/* ── Export-package retention ──
 * Built packages expire 24 hours after they are made. The build path sweeps
 * before it starts, but that only helps if somebody exports again: a restart
 * loses the in-memory job records, and without this a crash at the wrong moment
 * would leave a ZIP of everyone's passport scans on disk with nothing left that
 * knows to delete it. Swept on boot and every six hours regardless of use. */
setTimeout(() => { try { exportPackage.sweep(); } catch (e) {} }, 5 * 1000).unref();
const _xp = setInterval(() => {
  try { exportPackage.sweep(); } catch (e) { console.error('[export-package] sweep failed:', e && e.message || e); }
}, 6 * 60 * 60 * 1000);
if (_xp.unref) _xp.unref();

// Flush everything to disk and close cleanly on shutdown (Ctrl+C / host stop),
// so a restart never appears to lose the most recent writes.
let _closing = false;
function shutdown() {
  if (_closing) return; _closing = true;
  clearInterval(_ckpt);
  clearInterval(_bk);
  clearInterval(_xp);
  try { dbmod.close(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();   // hard stop if sockets linger
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, shutdown));

/* ── Test seam ──────────────────────────────────────────────────────
 * The security of the login throttle depends on _clientIp() refusing to believe
 * a forwarding header from an untrusted peer, and that cannot be exercised over
 * a loopback HTTP request (the test client is always 127.0.0.1, which IS a
 * trusted proxy). Exporting the helper lets the suite call it with a synthetic
 * socket. Underscore-prefixed: internal, not API surface. */
module.exports = {
  _clientIp, _isTrustedProxy, _normIp, _ipInCidr,
  loginLockedFor, noteLoginFail, clearLoginFails,
  // Test-only. Not reachable over HTTP, and nothing in the request path calls
  // it — the wholesale clear that this performs is exactly the bypass that P0.2
  // removed, so it must never gain a caller outside the suite.
  _resetThrottle: () => _loginFails.clear(),
  server,
};
