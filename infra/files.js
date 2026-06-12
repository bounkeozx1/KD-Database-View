'use strict';
/**
 * backend/files.js — store uploaded files on disk, keep only the path in the DB.
 * Accepts data: URLs (what the front-end produces) and writes them under uploads/.
 */
const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');
const { UPLOADS_DIR } = require('./db');

const CATEGORY_DIR = {
  photo:    'employee-photos',
  passport: 'passports',
  id_card:  'id-cards',
  form_1:   'documents',
  form_2:   'documents',
  form_3:   'documents',
  land_doc: 'documents',
  land:     'documents',
  other:    'documents',
};
const EXT = { 'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/png':'png', 'image/webp':'webp', 'application/pdf':'pdf' };

function isDataUrl(s) { return typeof s === 'string' && s.startsWith('data:'); }
function isStoredPath(s) { return typeof s === 'string' && s.startsWith('/uploads/'); }

/**
 * Save a data: URL into uploads/<category-dir>/ and return its public path
 * (e.g. "/uploads/employee-photos/ab12.jpg"). If `value` is already a stored
 * path or empty, it is returned unchanged.
 */
function saveDataUrl(value, category) {
  if (!value || isStoredPath(value)) return value || '';
  if (!isDataUrl(value)) return value; // unknown — store as-is

  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!m) return value;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const isB64 = !!m[2];
  const data = m[3];
  const buf = isB64 ? Buffer.from(data, 'base64') : Buffer.from(decodeURIComponent(data), 'utf8');

  const dir = CATEGORY_DIR[category] || 'documents';
  const ext = EXT[mime] || 'bin';
  const fname = crypto.randomUUID() + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, dir, fname), buf);
  return '/uploads/' + dir + '/' + fname;
}

/** Best-effort delete of a stored file given its public path. */
function deleteStored(publicPath) {
  if (!isStoredPath(publicPath)) return;
  const rel = publicPath.replace(/^\/uploads\//, '');
  const full = path.join(UPLOADS_DIR, rel);
  if (full.startsWith(UPLOADS_DIR)) { try { fs.unlinkSync(full); } catch (e) {} }
}

/**
 * Save a versioned document file into data/uploads/{groupId}/{uid}_{cat}_v{n}.{ext}
 * Returns the public path, e.g. "/uploads/group-dam-2026/w001_passport_v2.jpg"
 */
function saveDocFile(value, groupId, workerUid, category, version) {
  if (!value || isStoredPath(value)) return value || '';
  if (!isDataUrl(value)) return value;

  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!m) return value;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  const isB64 = !!m[2];
  const buf = isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');

  const ext  = EXT[mime] || 'bin';
  const safe = (groupId || 'misc').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
  const dir  = path.join(UPLOADS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });

  const fname = (workerUid || 'x') + '_' + (category || 'doc') + '_v' + (version || 1) + '.' + ext;
  fs.writeFileSync(path.join(dir, fname), buf);
  return '/uploads/' + safe + '/' + fname;
}

module.exports = { saveDataUrl, saveDocFile, deleteStored, isDataUrl, isStoredPath };
