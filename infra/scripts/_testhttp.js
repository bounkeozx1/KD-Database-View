'use strict';
/**
 * infra/scripts/_testhttp.js — CSRF-aware HTTP client for the test suites.
 *
 * Once P2 landed, every POST/PUT/PATCH/DELETE needs an X-CSRF-Token, so the raw
 * clients in test-auth.js and test-session.js started getting 403s across the
 * board. Rather than sprinkle token plumbing through ~160 assertions, those
 * suites use this client: it behaves like a browser, fetching and attaching the
 * token automatically.
 *
 * NOTE: test-security.js deliberately does NOT use this. Its whole job is to
 * prove that requests WITHOUT a valid token are refused, so it keeps a raw
 * client. If this helper were used there, the suite would silently test nothing.
 */
const http = require('node:http');

function makeClient(port) {
  function raw(method, p, body, headers) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: port, path: p, method,
        headers: Object.assign({},
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
          headers || {}),
      }, (res) => {
        let out = '';
        res.on('data', c => out += c);
        res.on('end', () => {
          let parsed = null; try { parsed = JSON.parse(out); } catch (e) {}
          resolve({ status: res.statusCode, body: parsed, raw: out, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  const STATE_CHANGING = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  const cookieOf = (res, name) => {
    for (const c of (res.headers['set-cookie'] || [])) {
      const m = new RegExp('^' + name + '=([^;]*)').exec(c);
      if (m) return m[1];
    }
    return null;
  };

  /**
   * Same signature as the raw client, but for state-changing methods it first
   * obtains a CSRF token scoped to whatever session the caller's Cookie header
   * carries, then attaches both the token header and the kd_csrf cookie —
   * exactly what a real browser would send.
   *
   * An explicit X-CSRF-Token in `headers` is never overwritten, so a suite can
   * still hand-craft a bad token to test rejection.
   */
  async function request(method, p, body, headers) {
    const h = Object.assign({}, headers || {});
    if (!STATE_CHANGING[method] || h['X-CSRF-Token'] || h['Authorization']) {
      return raw(method, p, body, h);
    }
    // Ask with the caller's cookies so an authenticated request gets that
    // session's server-side secret rather than a fresh pre-session one.
    const pre = await raw('GET', '/api/csrf', undefined, h.Cookie ? { Cookie: h.Cookie } : undefined);
    const token = (pre.body && pre.body.csrfToken) || cookieOf(pre, 'kd_csrf');
    if (token) {
      h['X-CSRF-Token'] = token;
      h.Cookie = h.Cookie ? (h.Cookie.replace(/;?\s*kd_csrf=[^;]*/, '') + '; kd_csrf=' + token)
                          : ('kd_csrf=' + token);
    }
    return raw(method, p, body, h);
  }

  return { request, raw, cookieOf };
}

module.exports = { makeClient };
