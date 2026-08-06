'use strict';
/**
 * infra/scripts/migrate-auth-p0.js — apply the P0 authentication hardening to an
 * EXISTING database, and report what it found.
 *
 *   npm run migrate-auth          → dry run: report only, no writes
 *   npm run migrate-auth -- --fix → apply remediation
 *
 * dbmod.init() already performs the schema migration (auth_log,
 * users.must_change_password, users.password_changed_at) on every server start,
 * so the schema half of this is idempotent and safe to run repeatedly.
 *
 * What --fix adds on top of that:
 *   • flags every account still holding a plaintext or default-strength
 *     password so its owner is forced onto a compliant one at next sign-in;
 *   • revokes sessions belonging to those accounts, because a session opened
 *     with 'admin1234' is exactly as compromised as the password was.
 */
const dbmod = require('../db');
const repo  = require('../repo');
const pw    = require('../password');

const FIX = process.argv.includes('--fix');

dbmod.init();               // creates auth_log + the new users columns if absent
const db = dbmod.db;

const users    = db.prepare('SELECT id, username, role, password, must_change_password FROM users').all();
const sessions = db.prepare('SELECT COUNT(*) AS c FROM sessions').get().c;

const plaintext = users.filter(u => !pw.isHashed(u.password));
const legacy    = users.filter(u => pw.isHashed(u.password) && pw.needsRehash(u.password));
// The credential that shipped in the repo. Detected by verification, not by
// comparing strings, so it is caught whether the row was hashed or not.
const knownDefault = users.filter(u => { try { return pw.verify('admin1234', u.password); } catch (e) { return false; } });
const flagged   = users.filter(u => u.must_change_password);

const bar = '─'.repeat(66);
console.log('\n' + bar);
console.log('  KD DATABASE — P0 AUTHENTICATION MIGRATION ' + (FIX ? '(APPLYING)' : '(DRY RUN)'));
console.log(bar);
console.log('  DB                            : ' + dbmod.DB_PATH);
console.log('  Accounts                      : ' + users.length);
console.log('  Active sessions               : ' + sessions);
console.log(bar);
console.log('  auth_log table                : present');
console.log('  users.must_change_password    : present');
console.log('  users.password_changed_at     : present');
console.log(bar);
console.log('  Plaintext passwords           : ' + plaintext.length + (plaintext.length ? '  ← CRITICAL' : ''));
plaintext.forEach(u => console.log('      - ' + u.username + ' (' + u.role + ')'));
console.log('  Below current scrypt cost     : ' + legacy.length);
legacy.forEach(u => console.log('      - ' + u.username + ' (' + u.role + ')  → rehashed on next sign-in'));
console.log('  Still using "admin1234"       : ' + knownDefault.length + (knownDefault.length ? '  ← CRITICAL' : ''));
knownDefault.forEach(u => console.log('      - ' + u.username + ' (' + u.role + ')'));
console.log('  Already flagged for change    : ' + flagged.length);
console.log(bar);

// Anything the owner must be forced off. Legacy-cost hashes are NOT included:
// they are upgraded transparently at next sign-in and the password itself may
// be perfectly strong, so forcing a change would be user-hostile for no gain.
const mustFix = [...new Set([...plaintext, ...knownDefault].map(u => u.username))];

if (!mustFix.length) {
  console.log('  No accounts require forced remediation.');
  console.log(bar + '\n');
  dbmod.close();
  process.exit(0);
}

if (!FIX) {
  console.log('  ' + mustFix.length + ' account(s) need remediation:');
  mustFix.forEach(u => console.log('      - ' + u));
  console.log('');
  console.log('  Re-run with --fix to force a password change and revoke their');
  console.log('  sessions. Use `npm run reset-admin -- <user>` to issue a new');
  console.log('  temporary password for any account whose owner is locked out.');
  console.log(bar + '\n');
  dbmod.close();
  process.exit(0);
}

let revoked = 0;
mustFix.forEach(username => {
  db.prepare('UPDATE users SET must_change_password=1 WHERE username=?').run(username);
  const n = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE username=?').get(username).c;
  repo.deleteUserSessions(username);
  revoked += n;
  repo.logAuth('PASSWORD_CHANGE', 'SUCCESS', {
    username: username, ip: 'local-console', userAgent: 'migrate-auth-p0.js',
    reason: 'P0 migration: forced change flagged; ' + n + ' session(s) revoked',
  });
  console.log('  ✓ ' + username + ' — flagged, ' + n + ' session(s) revoked');
});

console.log(bar);
console.log('  Done. ' + mustFix.length + ' account(s) flagged, ' + revoked + ' session(s) revoked.');
console.log('  Those users must set a compliant password at their next sign-in.');
console.log(bar + '\n');

dbmod.close();
