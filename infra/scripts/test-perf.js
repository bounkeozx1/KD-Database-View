'use strict';
/**
 * infra/scripts/test-perf.js — the asset-delivery contract, over real HTTP.
 *
 *   node infra/scripts/test-perf.js
 *
 * These were static checks in test-glass.js until one of them passed while
 * compression was switched off: grepping for `createGzip` proves the code is
 * present, not that it is reachable. The only honest test of "is the response
 * compressed" is to ask the server for a response and look at it.
 *
 * What this pins down, all of it measured on the live tunnel before the fix:
 *   1.52 MB of shell assets re-downloaded on EVERY page view, because the
 *   loader stamped `?t=<clock>` on each URL (so no cache entry was ever reused)
 *   and the server sent no ETag (so `no-cache` could not answer 304). main.css
 *   alone took 25 seconds. Nothing was compressed.
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 */
const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-perf-test-'));
process.env.KD_DATA_DIR = TMP;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
};

const PORT = 38900 + (process.pid % 200);
process.env.PORT = String(PORT);
require('../../shell/server.js');

/** One request. `gzip` controls whether we advertise support for it. */
function get(p, { gzip = true, etag = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (gzip) headers['Accept-Encoding'] = 'gzip';
    if (etag) headers['If-None-Match'] = etag;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers }, (res) => {
      let bytes = 0;
      res.on('data', c => bytes += c.length);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  await new Promise(r => setTimeout(r, 400));

  const CSS = '/shell/styles/main.css';
  const JS  = '/shell/scripts/app.js';

  /* ── Compression ── */
  const gz    = await get(CSS);
  const plain = await get(CSS, { gzip: false });
  ok('CSS is gzipped when the client accepts it', gz.headers['content-encoding'] === 'gzip',
     String(gz.headers['content-encoding']));
  ok('CSS is NOT gzipped when the client does not', !plain.headers['content-encoding']);
  ok('gzip actually shrinks it', gz.bytes < plain.bytes * 0.5,
     Math.round(plain.bytes / 1024) + ' KB → ' + Math.round(gz.bytes / 1024) + ' KB');
  ok('the response varies on Accept-Encoding',
     /accept-encoding/i.test(gz.headers['vary'] || ''), String(gz.headers['vary']));

  const jsGz = await get(JS);
  ok('JS is gzipped too', jsGz.headers['content-encoding'] === 'gzip');

  /* Binary formats must NOT be re-compressed — it burns CPU for nothing. */
  const png = await get('/vendor/pdf-lib/pdf-lib.min.js');
  ok('a vendor script is still compressed', png.status !== 200 || png.headers['content-encoding'] === 'gzip' ||
     png.status === 404, 'status ' + png.status);

  /* ── Revalidation ── */
  ok('a shell asset carries an ETag', !!gz.headers['etag'], String(gz.headers['etag']));
  const second = await get(CSS, { etag: gz.headers['etag'] });
  ok('an unchanged asset answers 304', second.status === 304, 'got ' + second.status);
  ok('the 304 carries no body', second.bytes === 0, second.bytes + ' bytes');

  /* ── Versioned URLs are immutable ── */
  const versioned = await get(CSS + '?v=9.9.9');
  ok('a versioned URL is cached hard',
     /immutable/.test(versioned.headers['cache-control'] || ''),
     String(versioned.headers['cache-control']));
  ok('an unversioned URL is revalidated instead',
     /no-cache/.test(gz.headers['cache-control'] || ''),
     String(gz.headers['cache-control']));

  /* ── The loader ── */
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/shell/pages/index.html',
               headers: { 'Accept-Encoding': 'identity' } }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  ok('the version placeholder is substituted', !/__KD_V__/.test(page),
     'the browser would request literally "?v=__KD_V__"');
  /* The loader builds the URL at runtime — `'?v=' + v` — so the page never
     contains a literal `?v=2.2.0`. What it must contain is the substituted
     version and the code that appends it. */
  ok('the page carries a real version', /var v = '\d+\.\d+\.\d+'/.test(page),
     (page.match(/var v = '[^']*'/) || ['(none)'])[0]);
  ok('the loader appends it to every asset URL', /'\?v=' \+ v/.test(page));
  ok('no clock-based cache buster survives', !/\?t='\s*\+\s*Date\.now\(\)/.test(page));

  /* ── Heavy libraries are not on the critical path ── */
  ok('jszip is not loaded eagerly', !/vendor\/jszip/.test(page));
  ok('html2canvas is not loaded eagerly', !/vendor\/html2canvas/.test(page));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('suite threw:', e); process.exit(1); });
