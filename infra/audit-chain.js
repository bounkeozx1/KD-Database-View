'use strict';
/**
 * infra/audit-chain.js — tamper-evident hash chaining for auth_log (P4.6).
 *
 * ══════════════════════════════════════════════════════════════════
 * What problem this solves, and what it does NOT
 * ══════════════════════════════════════════════════════════════════
 * P4.5 closed the hole where restoring a backup erased security events. It left
 * a stated residual risk: anybody who could write to kd.db could still edit or
 * delete an audit row directly, and nothing would reveal it.
 *
 * Each row now carries an HMAC over its own content AND the previous row's hash,
 * so the log is a chain. Editing a row, deleting one, or swapping two rows'
 * contents breaks every hash from that point on, and verification names the first
 * broken row.
 *
 * ── The security boundary is the KEY, not the algorithm ───────────
 * A plain SHA-256 chain would be worthless here: the algorithm is in this file,
 * so an attacker who edits a row can simply recompute every hash after it. The
 * chain is therefore keyed — HMAC-SHA256 with a 32-byte secret held in a FILE
 * BESIDE the database, never in it.
 *
 * That makes the realistic attacks fail:
 *   • a stolen or leaked kd.db                  → cannot forge (no key)
 *   • an SQL-injection or read-only DB exposure → cannot forge (no key)
 *   • a restored/copied backup file             → cannot forge (no key)
 *   • a DB-level account on a future Postgres   → cannot forge (no key)
 *
 * And it does NOT defeat:
 *   • an attacker with full filesystem access, who gets the key file too;
 *   • root on the host.
 * For those, the events have to leave the machine — append-only external
 * storage (syslog/WORM/a second host). That is deliberately NOT implemented
 * here, and is recorded as residual risk rather than papered over. Claiming
 * otherwise would be the dishonest part.
 *
 * ── Why this module owns no SQL ────────────────────────────────────
 * Every function here is pure or touches only the key file. The database work
 * lives in repo.js. Same reasoning as infra/password.js: a primitive that cannot
 * be unit-tested without a database will not be unit-tested.
 */
const crypto = require('node:crypto');
const fs     = require('node:fs');
const path   = require('node:path');

/* The first link. A fixed, non-secret string: the chain's security comes from
 * the key, so the starting value only needs to be unambiguous. */
const GENESIS = 'kd-audit-genesis-v1';

/* Field order is part of the format. It must never be reordered — doing so
 * would invalidate every stored hash. Adding a field means a new chain version.
 *
 * `id` is included deliberately: without it, two rows' contents could be swapped
 * and the chain would still verify, because the pair would hash to the same
 * sequence. With it, position is bound into the hash. */
const CHAINED_FIELDS = [
  'id', 'timestamp', 'username_attempted', 'user_id',
  'ip_address', 'user_agent', 'action', 'result', 'reason',
];

const VERSION = 1;

/* ── Framing bytes ────────────────────────────────────────────────
 * Built from char codes on purpose, so the source stays printable ASCII. They
 * were literal control characters
 * at first, which is a trap: an editor, a linter or a copy-paste through a tool
 * that normalises whitespace could silently drop one, and every stored hash
 * would stop verifying — a change indistinguishable from a successful attack.
 *
 * ASCII's own separators, none of which can appear in the stored values:
 *   0x1F unit      — between fields
 *   0x1E record    — end of the row
 *   0x1D group     — between the previous hash and this row
 *   0x00 NUL       — the "this field was NULL" marker
 *
 * Framing matters. Joining on '|' would let a crafted `reason` containing '|'
 * shift the field boundaries and hash to the same bytes as a different row.
 */
const SEP_FIELD  = String.fromCharCode(0x1F);   // between fields
const SEP_RECORD = String.fromCharCode(0x1E);   // end of row
const SEP_LINK   = String.fromCharCode(0x1D);   // between prev hash and row
const NULL_MARK  = String.fromCharCode(0x00);   // 'this field was NULL'

/* ══════════════════════════════════════════════════════════════════
 * Key management
 * ══════════════════════════════════════════════════════════════════ */

let _key = null;
let _keyPath = null;

/**
 * Load (or create) the chain key.
 *
 * Created on first use with owner-only permissions. The mode is best-effort:
 * chmod is close to meaningless on Windows, which is where this system runs, so
 * the key file's real protection is that it sits outside the database — the
 * artefact that actually gets copied, backed up and emailed around.
 */
function loadKey(dir) {
  const file = path.join(dir, 'audit-chain.key');
  if (_key && _keyPath === file) return _key;

  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) {
      _key = Buffer.from(hex, 'hex');
      _keyPath = file;
      return _key;
    }
    // A corrupt key file must NOT be silently replaced: generating a new key
    // would make every existing row unverifiable and look identical to a
    // successful attack. Fail loudly instead.
    throw new Error('audit-chain.key exists but is not a 32-byte hex key');
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e2) {}
  console.log('[audit] created a new audit-chain key at ' + file);
  console.log('[audit] back this file up with the database — without it the ' +
              'existing chain cannot be verified.');
  _key = key;
  _keyPath = file;
  return _key;
}

/** Short, non-secret identifier for the key in use, safe to display and log. */
function keyFingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** Test hook: forget the cached key so a different data directory can be used. */
function _resetKeyCache() { _key = null; _keyPath = null; }

/* ══════════════════════════════════════════════════════════════════
 * Hashing
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Canonical byte form of one row.
 *
 * Fields are joined with a unit separator (0x1F) and the whole record ends with a
 * record separator (0x1E). Neither can appear in the stored values, which is the
 * point: a naive join on '|' would let a crafted `reason` containing '|' shift
 * the field boundaries and produce a colliding record.
 *
 * NULL is distinguished from empty string — otherwise a row with reason=NULL and
 * one with reason='' would hash identically, and an attacker could blank a
 * reason without breaking the chain.
 */
function canonicalise(row) {
  const parts = CHAINED_FIELDS.map(f => {
    const v = row[f];
    if (v === null || v === undefined) return NULL_MARK;   // distinct from ''
    return String(v);
  });
  return Buffer.from(parts.join(SEP_FIELD) + SEP_RECORD, 'utf8');
}

/** HMAC of (previous hash ‖ this row). Returns lowercase hex. */
function hashRow(key, prevHash, row) {
  return crypto.createHmac('sha256', key)
    .update(Buffer.from(String(prevHash == null ? GENESIS : prevHash) + SEP_LINK, 'utf8'))
    .update(canonicalise(row))
    .digest('hex');
}

/**
 * Recompute the chain over `rows` (ascending id).
 * @returns {Array<{id, prev_hash, row_hash}>}
 */
function computeChain(key, rows, startHash) {
  let prev = startHash == null ? GENESIS : startHash;
  return rows.map(r => {
    const h = hashRow(key, prev, r);
    const link = { id: r.id, prev_hash: prev, row_hash: h };
    prev = h;
    return link;
  });
}

/* ══════════════════════════════════════════════════════════════════
 * Verification
 * ══════════════════════════════════════════════════════════════════ */

/**
 * Walk the chain and report the first inconsistency.
 *
 * Pure: takes rows, returns a verdict. No database, no clock, no key lookup
 * beyond the one passed in — so the tamper cases can all be unit-tested.
 *
 * `baselineThrough` is the highest id that was hashed RETROACTIVELY when the
 * chain was introduced. Those rows are attested from the migration onward only:
 * their hashes prove nothing about whether they were already tampered with
 * before P4.6. The report says so rather than implying full coverage, because an
 * integrity report that overstates itself is worse than none.
 *
 * @returns {{ok, rows, verified, brokenAtId, brokenReason, unhashed, head,
 *            baselineThrough, attestedFrom}}
 */
function verifyChain(key, rows, opts) {
  const o = opts || {};
  const report = {
    ok: true, rows: rows.length, verified: 0,
    brokenAtId: null, brokenReason: null,
    unhashed: 0, head: null,
    baselineThrough: o.baselineThrough == null ? null : o.baselineThrough,
    attestedFrom: null,
  };
  if (!rows.length) return report;

  let prev = GENESIS;
  for (const r of rows) {
    if (r.row_hash == null || r.row_hash === '') {
      /* An unhashed row is not automatically an attack: rows written by a build
       * older than P4.6, or while the key file was unreadable, legitimately have
       * none. They are counted and reported, and they break the chain's
       * continuity, so the walk stops treating later rows as attested. */
      report.unhashed++;
      report.ok = false;
      if (report.brokenAtId == null) {
        report.brokenAtId = r.id;
        report.brokenReason = 'row has no hash';
      }
      break;
    }
    if (String(r.prev_hash) !== String(prev)) {
      report.ok = false;
      report.brokenAtId = r.id;
      report.brokenReason = 'previous-hash mismatch — a row was removed, ' +
                            'reordered, or inserted out of sequence';
      break;
    }
    const expect = hashRow(key, prev, r);
    if (expect !== String(r.row_hash)) {
      report.ok = false;
      report.brokenAtId = r.id;
      report.brokenReason = 'content does not match its hash — this row was edited';
      break;
    }
    prev = r.row_hash;
    report.verified++;
  }

  report.head = prev === GENESIS ? null : prev;
  if (report.baselineThrough != null) {
    const first = rows.find(r => r.id > report.baselineThrough);
    report.attestedFrom = first ? first.id : null;
  } else {
    report.attestedFrom = rows.length ? rows[0].id : null;
  }
  return report;
}

module.exports = {
  GENESIS, VERSION, CHAINED_FIELDS,
  loadKey, keyFingerprint, _resetKeyCache,
  canonicalise, hashRow, computeChain, verifyChain,
};
