'use strict';
/**
 * infra/scripts/asset-stamp.js — record which app version the shipped assets belong to.
 *
 *   node infra/scripts/asset-stamp.js          print the current state
 *   node infra/scripts/asset-stamp.js --write  stamp the manifest with today's files
 *
 * ══════════════════════════════════════════════════════════════════
 * Why this exists
 * ══════════════════════════════════════════════════════════════════
 * P2 made every asset URL immutable: `main.css?v=2.2.0` is served with
 * `Cache-Control: immutable`, so a browser that has it NEVER asks again. That
 * is the whole point — it is what turned a 25-second page load into 0.34s.
 *
 * It also means the version in package.json is not decoration. Ship a CSS
 * change without bumping it and returning browsers keep the old stylesheet
 * forever, while index.html — which is never cached hard — arrives new. New
 * markup, old CSS.
 *
 * That is not a hypothetical. The tab bar was given a second, filled icon per
 * tab, shown by a CSS rule that says the line icon is hidden while the tab is
 * selected. Without the bump, phones got the new markup and none of the rule:
 * every tab drew BOTH icons, side by side. Nothing errored. It looked like a
 * broken layout, and the cause was three files away.
 *
 * So: this hashes the files the browser caches by version, and remembers which
 * version they were stamped at. test-glass fails when they no longer match,
 * which is the reminder — bump package.json, then run `npm run stamp-assets`.
 */
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'infra', 'asset-version.json');

/* Everything the loader in index.html requests with `?v=`. index.html itself is
   deliberately absent: the server rewrites and re-sends it on every page view,
   so it can never be the stale half of a mismatch. */
const ASSETS = [
  'shell/styles/main.css',
  'shell/styles/sidebar.css',
  'shell/styles/admin.css',
  'shell/styles/login.css',
  'shell/scripts/app.js',
  'shell/scripts/db.js',
  'shell/scripts/i18n.js',
  'shell/scripts/admin-center.js',
  'shell/scripts/login.js',
  'shell/scripts/login-mfa.js',
  'infra/age.js',
  'infra/csv.js',
  'infra/safe-name.js',
  'infra/doc-cats.js',
  'domains/recruitment/intake-import/pptx-import.js',
  'domains/recruitment/passport-scan/passport-scan.js',
];

/** One hash over every cached asset. Missing files hash as empty, so deleting
 *  one is a change like any other rather than a crash. */
function hashAssets() {
  const h = crypto.createHash('sha256');
  for (const rel of ASSETS) {
    h.update(rel);
    try { h.update(fs.readFileSync(path.join(ROOT, rel))); }
    catch (e) { h.update('<missing>'); }
  }
  return h.digest('hex').slice(0, 16);
}

function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch (e) { return null; }
}

function appVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/**
 * @returns {{state:string, version:string, stamped:object|null, hash:string}}
 *   'ok'         assets match the stamp
 *   'unstamped'  no manifest yet
 *   'stale'      assets changed AND the version did not — the failure case
 *   'needs-stamp' assets changed and the version did too; just re-stamp
 */
function check() {
  const hash = hashAssets();
  const version = appVersion();
  const stamped = readManifest();
  if (!stamped) return { state: 'unstamped', version, stamped, hash };
  if (stamped.hash === hash) return { state: 'ok', version, stamped, hash };
  return { state: stamped.version === version ? 'stale' : 'needs-stamp', version, stamped, hash };
}

function write() {
  const body = { version: appVersion(), hash: hashAssets(), stamped_at: new Date().toISOString() };
  fs.writeFileSync(MANIFEST, JSON.stringify(body, null, 2) + '\n');
  return body;
}

if (require.main === module) {
  if (process.argv.includes('--write')) {
    const b = write();
    console.log('stamped ' + b.version + '  ' + b.hash);
  } else {
    const r = check();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.state === 'stale' ? 1 : 0);
  }
}

module.exports = { check, write, hashAssets, ASSETS };
