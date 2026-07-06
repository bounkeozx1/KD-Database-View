'use strict';
/**
 * infra/offload.js — mirror local upload files to Cloudflare R2, then free the
 * local copy so the server volume stops filling up.
 *
 * DESIGN — "local-first, then offload" (chosen for maximum safety):
 *   1. New uploads are still written to local disk by files.js (unchanged path,
 *      so the whole save/transaction flow is untouched and 100% synchronous).
 *   2. This module runs in the background: for each file the DB references, it
 *      uploads the bytes to R2, VERIFIES the remote size matches, and only THEN
 *      deletes the local copy. A referenced file is never removed locally until
 *      it is provably safe in R2.
 *   3. Reads fall back to R2 when the local file is gone (see server.js).
 * If R2 is unset or unreachable, nothing is deleted — the app behaves exactly as
 * it did before (files served straight from disk). No data can be lost.
 *
 * The one-time backlog (the existing ~200MB) and the steady-state trickle of new
 * uploads use the SAME code path (sweepReferenced), so there is one thing to trust.
 */
const fs   = require('node:fs');
const path = require('node:path');
const dbmod = require('./db');
const r2    = require('./r2');
const admin = require('./admin');

const UPLOADS_DIR = dbmod.UPLOADS_DIR;

const CONTENT_TYPE = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.pdf': 'application/pdf',
};
function ctypeFor(p) { return CONTENT_TYPE[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

// Local absolute path → R2 object key (posix slashes, relative to uploads/).
function keyFor(absLocalPath) {
  return path.relative(UPLOADS_DIR, absLocalPath).split(path.sep).join('/');
}

/**
 * Mirror one local file to R2 and free it locally once verified.
 * Returns 'uploaded' | 'already' (was already in R2) | 'missing' | 'error'.
 * Never throws; never deletes local unless the remote copy is confirmed.
 */
async function mirrorOne(absLocalPath) {
  let size;
  try { size = fs.statSync(absLocalPath).size; }
  catch (e) { return { status: 'missing', bytes: 0 }; }

  const key = keyFor(absLocalPath);
  try {
    // Skip re-upload if an identical-size object already exists remotely.
    const h = await r2.head(key);
    if (h.exists && h.size === size) {
      fs.unlinkSync(absLocalPath);
      return { status: 'already', bytes: size, key };
    }
    const buf = fs.readFileSync(absLocalPath);
    await r2.put(key, buf, ctypeFor(absLocalPath));
    // Verify before deleting the only local copy.
    const check = await r2.head(key);
    if (!check.exists || check.size !== buf.length) {
      return { status: 'error', bytes: 0, key, error: 'verify-failed' };
    }
    fs.unlinkSync(absLocalPath);
    return { status: 'uploaded', bytes: size, key };
  } catch (e) {
    return { status: 'error', bytes: 0, key, error: String(e && e.message || e) };
  }
}

/**
 * Sweep files the DB references that still exist locally → R2.
 * `limit` caps work per call (0 = no cap). `onProgress` gets each result.
 * Returns a summary. Safe to call repeatedly (idempotent).
 */
async function sweepReferenced({ limit = 0, onProgress } = {}) {
  if (!r2.isEnabled()) return { skipped: 'r2-disabled' };
  const referenced = admin.referencedUploadPaths();     // Set<absLocalPath>
  const summary = { uploaded: 0, already: 0, missing: 0, errors: 0, freedBytes: 0, total: 0 };
  for (const abs of referenced) {
    if (!fs.existsSync(abs)) continue;                  // already offloaded / never existed
    summary.total++;
    const r = await mirrorOne(abs);
    if (r.status === 'uploaded') { summary.uploaded++; summary.freedBytes += r.bytes; }
    else if (r.status === 'already') { summary.already++; summary.freedBytes += r.bytes; }
    else if (r.status === 'missing') { summary.missing++; }
    else { summary.errors++; }
    if (onProgress) onProgress(abs, r, summary);
    if (limit && (summary.uploaded + summary.already + summary.errors) >= limit) break;
  }
  return summary;
}

/** How many referenced files are still sitting on local disk (i.e. not yet offloaded). */
function pendingCount() {
  const referenced = admin.referencedUploadPaths();
  let n = 0, bytes = 0;
  for (const abs of referenced) { try { const st = fs.statSync(abs); n++; bytes += st.size; } catch (e) {} }
  return { count: n, bytes };
}

module.exports = { mirrorOne, sweepReferenced, pendingCount, keyFor, ctypeFor };
