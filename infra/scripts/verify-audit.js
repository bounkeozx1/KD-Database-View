'use strict';
/**
 * infra/scripts/verify-audit.js — verify the audit trail from the command line.
 *
 *   npm run verify-audit
 *   npm run verify-audit -- --backup kd-2026-07-30_10-00-00-000.db
 *
 * Why a CLI as well as the Settings screen
 * ────────────────────────────────────────
 * The in-app check runs inside the application whose log it is checking. That is
 * fine for routine use and wrong for the case that matters: if somebody has
 * tampered with the database, the last thing an investigator should rely on is
 * the tampered system's own UI reporting on itself.
 *
 * This reads the database directly, needs no session, and exits non-zero on any
 * break — so it can run from cron, from a recovery shell, or over SSH against a
 * copy of the file, and can gate a deployment.
 *
 * Exit codes:  0 intact   1 broken or unverifiable   2 usage error
 */
const path = require('node:path');

const args = process.argv.slice(2);
const backupIdx = args.indexOf('--backup');
const backupFile = backupIdx >= 0 ? args[backupIdx + 1] : null;
if (backupIdx >= 0 && !backupFile) {
  console.error('usage: verify-audit [--backup <file.db>]');
  process.exit(2);
}

const dbmod = require('../db');
const chain = require('../audit-chain');

function line(k, v) { console.log('  ' + k.padEnd(28) + v); }

/* ── A backup file, examined read-only ── */
if (backupFile) {
  const admin = require('../admin');
  const report = admin.verifyBackup(backupFile);
  console.log('\nBACKUP VERIFICATION — ' + report.file);
  console.log('='.repeat(64));
  line('readable', report.readable ? 'yes' : 'NO');
  line('size', report.size + ' bytes');
  line('sqlite integrity', report.integrity || 'n/a');
  line('checksum', report.checksumOk === null ? 'not recorded'
                 : report.checksumOk ? 'matches creation' : 'MISMATCH');
  line('missing tables', report.missingTables.length ? report.missingTables.join(', ') : 'none');
  const ch = report.auditChain || {};
  line('audit chain', ch.available === false ? ('n/a — ' + ch.reason)
       : (ch.ok ? 'intact (' + ch.verified + '/' + ch.rows + ')'
                : 'BROKEN at id ' + ch.brokenAtId));
  Object.keys(report.counts).forEach(t => line('rows: ' + t, report.counts[t]));
  if (report.errors.length) line('errors', report.errors.join('; '));
  console.log('='.repeat(64));
  console.log((report.ok ? '  RESULT: backup is sound' : '  RESULT: BACKUP IS NOT USABLE') + '\n');
  process.exit(report.ok ? 0 : 1);
}

/* ── The live database ── */
dbmod.init();
const repo = require('../repo');
const r = repo.verifyAuditChain();

console.log('\nAUDIT TRAIL INTEGRITY');
console.log('='.repeat(64));
line('database', dbmod.DB_PATH);
if (r.available === false) {
  line('status', 'CANNOT VERIFY');
  line('reason', r.error || 'unknown');
  console.log('='.repeat(64) + '\n');
  process.exit(1);
}
line('rows', r.rows);
line('verified', r.verified);
line('unhashed', r.unhashed);
line('signing key', r.keyFingerprint + '  (held outside the database)');
line('chain version', r.chainVersion);
if (r.baselineThrough != null) {
  line('baseline through id', r.baselineThrough);
  line('', 'rows at or below this were hashed retroactively;');
  line('', 'their content before the migration is not attested.');
}
if (r.attestedFrom != null) line('fully attested from id', r.attestedFrom);
line('head', r.head ? r.head.slice(0, 32) + '…' : 'none');
line('check took', r.durationMs + ' ms');

if (r.anchors && r.anchors.length) {
  console.log('\n  Recorded chain rebuilds (newest first):');
  r.anchors.slice(0, 5).forEach(a => {
    console.log('   · ' + (a.created_at || '?') + '  by ' + (a.actor || '?') +
                '  rows=' + a.rows_affected);
    console.log('     ' + String(a.reason || '').slice(0, 90));
  });
}

console.log('='.repeat(64));
if (r.ok) {
  console.log('  RESULT: intact — no row has been edited, removed or reordered\n');
  process.exit(0);
}
console.log('  RESULT: BROKEN at row ' + r.brokenAtId);
console.log('  ' + r.brokenReason);
console.log('\n  Rows before ' + r.brokenAtId + ' verified cleanly, so the trail is');
console.log('  trustworthy up to that point. A rebuild leaves a verifying chain,');
console.log('  so a break here has no legitimate cause — investigate rather than');
console.log('  re-anchoring, which would overwrite the evidence.\n');
process.exit(1);
