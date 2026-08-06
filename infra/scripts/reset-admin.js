'use strict';
/**
 * infra/scripts/reset-admin.js — recover a locked-out administrator.
 *
 *   npm run reset-admin            → reset the 'admin' account
 *   npm run reset-admin -- alice   → reset a named account
 *
 * Removing the shared default credential means there is no longer a way back in
 * if the only admin password is lost, and this system has no self-service reset.
 * This script is that way back: it requires filesystem access to the server, so
 * it grants nothing to a remote attacker who did not already own the machine.
 *
 * Issues a fresh random password, flags must_change_password, and revokes every
 * existing session for the account (a lost password is assumed compromised).
 * The reset is written to auth_log like any other.
 */
const path  = require('node:path');
const dbmod = require('../db');
const repo  = require('../repo');
const pw    = require('../password');

const username = (process.argv[2] || 'admin').trim();

dbmod.init();
const db = dbmod.db;

const row = db.prepare('SELECT id, username, role FROM users WHERE username=?').get(username);
if (!row) {
  console.error('\n  No such account: ' + username);
  const all = db.prepare('SELECT username, role FROM users ORDER BY username').all();
  if (all.length) {
    console.error('  Existing accounts:');
    all.forEach(u => console.error('    - ' + u.username + '  (' + u.role + ')'));
  } else {
    console.error('  The users table is empty. Delete data/db/kd.db and restart to re-seed.');
  }
  console.error('');
  process.exit(1);
}

const plain = pw.generate(20);
db.prepare(
  "UPDATE users SET password=?, must_change_password=1, password_changed_at=datetime('now') WHERE username=?"
).run(pw.hash(plain), username);
repo.deleteUserSessions(username);
repo.logAuth('PASSWORD_CHANGE', 'SUCCESS', {
  username: username, userId: row.id, ip: 'local-console', userAgent: 'reset-admin.js',
  reason: 'operator reset via CLI; sessions revoked; must_change_password set',
});

// If this is the seeded admin, the first-run note on disk is now stale.
try { require('node:fs').unlinkSync(dbmod.INITIAL_PW_PATH); } catch (e) {}

const line = '='.repeat(64);
console.log('\n' + line);
console.log('  PASSWORD RESET — ' + username + '  (' + row.role + ')');
console.log(line);
console.log('    password:  ' + plain);
console.log(line);
console.log('  Shown ONCE. All existing sessions for this account were revoked.');
console.log('  You will be required to change it at next sign-in.');
console.log(line + '\n');

dbmod.close();
