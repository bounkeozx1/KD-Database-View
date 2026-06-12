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

const dbmod = require('../infra/db');
const repo  = require('../infra/repo');
const admin = require('../infra/admin');

dbmod.init();   // auto-create DB + tables + default master data on first launch

const ROOT = dbmod.ROOT;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.pdf':'application/pdf', '.ico':'image/x-icon',
};

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
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ── API ── */
async function handleApi(req, res, pathname) {
  const seg = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const method = req.method;
  const body = (method === 'POST' || method === 'PATCH' || method === 'PUT') ? await readBody(req) : {};

  try {
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
      if (method === 'DELETE' && seg[1]) { repo.deleteGroup(seg[1]); return json(res, 200, { ok: true }); }
    }

    // Employees
    if (seg[0] === 'employees' && seg[1]) {
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
      if (method === 'DELETE') { repo.deleteEmployee(seg[1]); return json(res, 200, { ok: true }); }
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
      if (method === 'DELETE' && seg[1]) return json(res, 200, { ok: true, status: repo.deleteUser(seg[1]) });
    }

    // Admin
    if (seg[0] === 'admin') {
      if (method === 'POST' && seg[1] === 'backup')  return json(res, 200, { ok: true, file: admin.backup() });
      if (method === 'GET'  && seg[1] === 'backups') return json(res, 200, { ok: true, files: admin.listBackups() });
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
  const pathname = url.parse(req.url).pathname;
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('KD Database server  →  http://localhost:' + PORT);
  console.log('SQLite file         →  ' + dbmod.DB_PATH);
});
