'use strict';
/**
 * One-time migration: copy LOCAL data → a REMOTE KD server (e.g. Render).
 *
 *   node infra/scripts/migrate-to-remote.js https://kd-database-xxxx.onrender.com
 *
 * - Reads the local data through the LOCAL running server (default :3000).
 * - Reads photo/document files from data/uploads on disk and re-uploads them as
 *   data: URLs, so the remote recreates the files on its own persistent disk.
 * - Posts everything (groups + workers + photos + documents + cities) to
 *   <remote>/api/import in a single call.
 *
 * The local server must be running. Safe to re-run (import skips existing rows).
 */
const fs   = require('node:fs');
const path = require('node:path');

const REMOTE = (process.argv[2] || '').replace(/\/+$/, '');
const LOCAL  = (process.env.LOCAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const DATA_ROOT = path.resolve(__dirname, '..', '..', 'data'); // /uploads/... lives under data/

if (!REMOTE) {
  console.error('Usage: node infra/scripts/migrate-to-remote.js <remote-url>');
  process.exit(1);
}

const MIME = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', pdf:'application/pdf' };

function fileToDataUrl(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return '';
  const full = path.join(DATA_ROOT, publicPath.replace(/^\//, '')); // data/uploads/...
  if (!fs.existsSync(full)) { console.warn('  ! missing file, skipped:', publicPath); return ''; }
  const ext  = path.extname(full).slice(1).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  return 'data:' + mime + ';base64,' + fs.readFileSync(full).toString('base64');
}

(async () => {
  console.log('Reading local data from ' + LOCAL + ' ...');
  const boot = await fetch(LOCAL + '/api/bootstrap').then(r => r.json()).catch(e => { throw new Error('Cannot read local server — is it running? ' + e.message); });
  const data = boot.data || boot;

  let nWorkers = 0, nPhotos = 0, nDocs = 0;
  (data.groups || []).forEach(g => (g.workers || []).forEach(w => {
    nWorkers++;
    if (w.photo) { const d = fileToDataUrl(w.photo); w.photo = d || ''; if (d) nPhotos++; }
    const map = {};
    (w.documents || []).forEach(doc => {
      const d = fileToDataUrl(doc.file_path);
      if (!d) return;
      (map[doc.category] = map[doc.category] || []).push({ data: d, type: doc.type, name: doc.name });
      nDocs++;
    });
    w.documents = map;
  }));

  const payload = { groups: data.groups || [], cities: data.cities || { kr: [], la: [] } };
  console.log(`Uploading → ${REMOTE}\n  groups: ${(payload.groups || []).length}  workers: ${nWorkers}  photos: ${nPhotos}  documents: ${nDocs}`);

  const res = await fetch(REMOTE + '/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!res.ok) { console.error('Import failed: HTTP ' + res.status + '\n' + await res.text()); process.exit(1); }
  const out = await res.json();
  const rg = (out.data && out.data.groups) || [];
  const rw = rg.reduce((n, g) => n + (g.workers || []).length, 0);
  console.log(`\n✔ Done. Remote now has ${rg.length} groups, ${rw} workers.`);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
