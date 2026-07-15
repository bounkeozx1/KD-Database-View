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

const dbmod   = require('../infra/db');
const repo    = require('../infra/repo');
const admin   = require('../infra/admin');
const ai      = require('../infra/ai');
const r2      = require('../infra/r2');
const offload = require('../infra/offload');

dbmod.init();   // auto-create DB + tables + default master data on first launch

const ROOT = dbmod.ROOT;
const PORT = process.env.PORT || 3000;

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

function applySecurityHeaders(res) {
  // HSTS is ignored by browsers over plain HTTP (localhost dev) and enforced over
  // HTTPS (behind the Cloudflare tunnel / any TLS front) — safe to always send.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', CSP);
  // SAMEORIGIN (not DENY): the document viewer frames same-origin PDFs from /uploads.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // camera=(self): needed by the passport scanner (getUserMedia); the rest off.
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
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

/* ── Static files ── */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' ) rel = '/index.html';
  // Uploaded files live under data/uploads/ but are referenced as /uploads/… in the DB.
  const full = rel.startsWith('/uploads/')
    ? path.join(ROOT, 'data', rel)
    : path.join(ROOT, rel);
  if (!full.startsWith(ROOT)) return send(res, 403, 'Forbidden', 'text/plain');
  const isUpload = rel.startsWith('/uploads/');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      // Offloaded upload: the local copy was freed after mirroring to R2 — proxy it.
      if (isUpload && r2.isEnabled()) return serveFromR2(req, res, rel);
      return send(res, 404, 'Not found', 'text/plain');
    }
    // Uploaded files have content-unique / versioned names (UUID or _v{n}), so they
    // never change once written → cache them hard. This is the single biggest win
    // for slow document/photo loading: the browser stops re-downloading every view.
    // The app shell (HTML/JS/CSS) stays no-cache so code updates take effect at once.
    const etag = isUpload ? '"' + st.size.toString(16) + '-' + st.mtimeMs.toString(16) + '"' : null;
    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': isUpload ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(etag ? { 'ETag': etag } : {}),
    });
    fs.createReadStream(full).pipe(res);
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
  const body = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? await readBody(req) : {};

  try {
    // GET /api/health  (used by Render health check — tests DB is alive)
    if (method === 'GET' && seg[0] === 'health')
      return json(res, 200, { ok: true, db: !!dbmod.db, ts: Date.now() });

    // GET /api/bootstrap
    if (method === 'GET' && seg[0] === 'bootstrap')
      return json(res, 200, { ok: true, empty: repo.countEmployees() === 0, data: repo.getBootstrap() });

    // POST /api/login
    if (method === 'POST' && seg[0] === 'login') {
      const u = repo.login((body.username || '').trim(), body.password || '');
      return json(res, u ? 200 : 401, u ? { ok: true, user: u } : { ok: false });
    }

    // POST /api/import
    if (method === 'POST' && seg[0] === 'import') { repo.importAll(body || {}); return json(res, 200, { ok: true, data: repo.getBootstrap() }); }

    // Groups
    if (seg[0] === 'groups') {
      if (method === 'POST' && seg.length === 1) return json(res, 200, { ok: true, id: repo.createGroup(body) });
      if (method === 'POST' && seg[2] === 'employees') return json(res, 200, { ok: true, uid: repo.addEmployee(seg[1], body) });
      if (method === 'PATCH'  && seg[1]) { repo.updateGroup(seg[1], body); return json(res, 200, { ok: true }); }
      // DELETE moves the group to the trash (soft-delete) — restorable.
      if (method === 'DELETE' && seg[1]) { repo.softDeleteGroup(seg[1]); return json(res, 200, { ok: true }); }
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
      if (method === 'PATCH')  { repo.updateEmployee(seg[1], body); return json(res, 200, { ok: true }); }
      // DELETE moves the worker to the trash (soft-delete) — restorable.
      if (method === 'DELETE') { repo.softDeleteEmployee(seg[1]); return json(res, 200, { ok: true }); }
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

    // Users
    if (seg[0] === 'users') {
      if (method === 'POST')   return json(res, 200, { ok: true, status: repo.addUser(body) });
      if (method === 'PATCH'  && seg[1]) return json(res, 200, { ok: true, status: repo.updateUser(seg[1], body) });
      if (method === 'DELETE' && seg[1]) return json(res, 200, { ok: true, status: repo.deleteUser(seg[1]) });
    }

    // App settings (server-persisted key-value) — POST /api/settings { key, value }
    if (seg[0] === 'settings' && method === 'POST') {
      return json(res, 200, { ok: true, status: repo.setSetting(body.key, body.value) });
    }

    // AI document extraction (Gemini) — POST /api/ai/extract { image, docType }
    if (seg[0] === 'ai' && seg[1] === 'extract' && method === 'POST') {
      const r = await ai.extract(body.image, body.docType);
      return json(res, 200, r);
    }

    // Admin
    if (seg[0] === 'admin') {
      if (method === 'POST' && seg[1] === 'backup')  return json(res, 200, { ok: true, file: admin.backup() });
      if (method === 'GET'  && seg[1] === 'backups') return json(res, 200, { ok: true, files: admin.listBackups() });
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
      if (method === 'POST' && seg[1] === 'restore') { admin.restore(body.file); return json(res, 200, { ok: true, data: repo.getBootstrap() }); }
      if (method === 'POST' && seg[1] === 'reset')   { admin.reset(); return json(res, 200, { ok: true, data: repo.getBootstrap() }); }
    }

    return json(res, 404, { ok: false, error: 'Unknown endpoint' });
  } catch (e) {
    console.error('[API]', method, pathname, e);
    return json(res, 500, { ok: false, error: String(e && e.message || e) });
  }
}

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  const pathname = url.parse(req.url).pathname;
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

// Flush everything to disk and close cleanly on shutdown (Ctrl+C / host stop),
// so a restart never appears to lose the most recent writes.
let _closing = false;
function shutdown() {
  if (_closing) return; _closing = true;
  clearInterval(_ckpt);
  clearInterval(_bk);
  try { dbmod.close(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();   // hard stop if sockets linger
}
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, shutdown));
