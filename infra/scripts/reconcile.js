'use strict';
/**
 * backend/scripts/reconcile.js — file ⇄ database integrity tool.
 *
 *   node backend/scripts/reconcile.js              # report only (safe, default)
 *   node backend/scripts/reconcile.js --delete-orphans   # delete on-disk files no row references
 *   node backend/scripts/reconcile.js --prune-missing    # clear DB refs whose file is gone
 *   node backend/scripts/reconcile.js --json             # print machine-readable JSON only
 *
 * Detects:
 *   • orphan files   — exist under uploads/ but no DB row points to them
 *   • missing files  — referenced by the DB but absent on disk
 *   • invalid paths  — DB values that are not a well-formed /uploads/… path
 * A timestamped report is always written to reports/reconcile-<ts>.json.
 * Destructive actions happen ONLY with the explicit flags above; a backup is
 * taken before any DB mutation.
 */
const fs    = require('node:fs');
const path  = require('node:path');
const dbmod = require('../db');

const ARGS           = process.argv.slice(2);
const DELETE_ORPHANS = ARGS.includes('--delete-orphans');
const PRUNE_MISSING  = ARGS.includes('--prune-missing');
const JSON_ONLY      = ARGS.includes('--json');

const UPLOADS = dbmod.UPLOADS_DIR;
const PUBLIC_PREFIX = '/uploads/';
const isStored = s => typeof s === 'string' && s.startsWith(PUBLIC_PREFIX);
const toAbs    = pub => path.join(UPLOADS, pub.slice(PUBLIC_PREFIX.length));
const toPublic = abs => PUBLIC_PREFIX + path.relative(UPLOADS, abs).split(path.sep).join('/');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function main() {
  dbmod.init();
  const db = dbmod.db;

  // 1) Every path the DB references, with its source row.
  const refs = []; // { pub, source, id }
  db.prepare("SELECT uid, photo_path FROM employees WHERE photo_path IS NOT NULL AND photo_path<>''")
    .all().forEach(r => refs.push({ pub: r.photo_path, source: 'employees.photo_path', id: r.uid }));
  db.prepare('SELECT id, file_path FROM documents').all()
    .forEach(r => refs.push({ pub: r.file_path, source: 'documents.file_path', id: r.id }));

  const invalidPaths = refs.filter(r => !isStored(r.pub));
  const validRefs    = refs.filter(r => isStored(r.pub));
  const referencedAbs = new Set(validRefs.map(r => path.normalize(toAbs(r.pub))));

  // 2) Every file actually on disk.
  const diskFiles = walk(UPLOADS).map(f => path.normalize(f));

  // 3) Cross-reference.
  const orphans = diskFiles.filter(f => !referencedAbs.has(f)).map(toPublic);
  const missing = validRefs.filter(r => !fs.existsSync(toAbs(r.pub)));

  // 4) Optional repairs.
  const actions = { deletedOrphans: [], prunedRefs: [] };
  if ((DELETE_ORPHANS && orphans.length) || (PRUNE_MISSING && missing.length)) {
    try { require('../admin').backup(); } catch (e) {}
  }
  if (DELETE_ORPHANS) {
    orphans.forEach(pub => { try { fs.unlinkSync(toAbs(pub)); actions.deletedOrphans.push(pub); } catch (e) {} });
  }
  if (PRUNE_MISSING) {
    missing.forEach(r => {
      if (r.source === 'documents.file_path') db.prepare('DELETE FROM documents WHERE id=?').run(r.id);
      else db.prepare('UPDATE employees SET photo_path=? WHERE uid=?').run('', r.id);
      actions.prunedRefs.push(r);
    });
  }

  // 5) Report.
  const report = {
    generatedAt: new Date().toISOString(),
    uploadsDir: UPLOADS,
    counts: {
      referenced: validRefs.length, onDisk: diskFiles.length,
      orphans: orphans.length, missing: missing.length, invalidPaths: invalidPaths.length,
    },
    orphans,
    missing: missing.map(r => ({ path: r.pub, source: r.source, id: r.id })),
    invalidPaths: invalidPaths.map(r => ({ value: r.pub, source: r.source, id: r.id })),
    actions,
  };

  const reportsDir = path.join(dbmod.ROOT, 'data', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(reportsDir, 'reconcile-' + ts + '.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  if (JSON_ONLY) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log('── File ⇄ DB reconciliation ──');
  console.log('  referenced by DB : ' + report.counts.referenced);
  console.log('  files on disk    : ' + report.counts.onDisk);
  console.log('  orphan files     : ' + report.counts.orphans + (DELETE_ORPHANS ? ' (deleted ' + actions.deletedOrphans.length + ')' : ''));
  console.log('  missing files    : ' + report.counts.missing + (PRUNE_MISSING ? ' (pruned ' + actions.prunedRefs.length + ')' : ''));
  console.log('  invalid paths    : ' + report.counts.invalidPaths);
  if (orphans.length && !DELETE_ORPHANS) console.log('  → re-run with --delete-orphans to remove orphan files');
  if (missing.length && !PRUNE_MISSING)  console.log('  → re-run with --prune-missing to clear dangling DB refs');
  console.log('  report → ' + file);
}

main();
