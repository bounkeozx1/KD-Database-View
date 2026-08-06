'use strict';
/**
 * infra/scripts/mfa-reset.js — clear a user's second factor from the console.
 *
 *   npm run mfa-reset -- <username>            disable TOTP + recovery codes
 *   npm run mfa-reset -- <username> --all      also delete every passkey
 *   npm run mfa-reset -- --list                show MFA state for all accounts
 *
 * Why this exists: P3 makes MFA mandatory for admin and manager roles. A lost
 * phone with no recovery codes left, or a passkey on a device that died, would
 * otherwise lock the last administrator out of a database holding hundreds of
 * employees' passport records — with no way back in.
 *
 * This is the way back in. It requires filesystem access to the server, so it
 * grants nothing to a remote attacker who did not already own the machine, and
 * every reset is written to auth_log like any other MFA change.
 *
 * After a reset the account signs in with its password alone and is sent
 * straight to enrolment (its role still requires a factor).
 */
const dbmod = require('../db');
const repo  = require('../repo');

const args     = process.argv.slice(2).filter(a => a !== '--');
const listOnly = args.includes('--list');
const alsoPasskeys = args.includes('--all');
const username = args.find(a => !a.startsWith('--'));

dbmod.init();
const db = dbmod.db;

function stateOf(u) {
  const st = repo.getMfaStatus(u.username);
  return {
    username: u.username, role: u.role,
    totp: st.totpEnabled ? 'on' : 'off',
    passkeys: st.passkeyCount,
    codes: st.recoveryCodesRemaining,
    required: st.policy.required ? 'yes' : 'no',
    setupNeeded: st.setupRequired ? 'YES' : '-',
  };
}

const bar = '─'.repeat(74);

if (listOnly || !username) {
  const users = db.prepare('SELECT username, role FROM users ORDER BY username').all();
  console.log('\n' + bar);
  console.log('  MFA STATE');
  console.log(bar);
  console.log('  ' + 'account'.padEnd(18) + 'role'.padEnd(10) + 'totp'.padEnd(7) +
              'passkeys'.padEnd(10) + 'codes'.padEnd(8) + 'required'.padEnd(10) + 'needs setup');
  console.log('  ' + '-'.repeat(70));
  users.forEach(u => {
    const s = stateOf(u);
    console.log('  ' + s.username.padEnd(18) + s.role.padEnd(10) + s.totp.padEnd(7) +
                String(s.passkeys).padEnd(10) + String(s.codes).padEnd(8) +
                s.required.padEnd(10) + s.setupNeeded);
  });
  console.log(bar);
  if (!username) {
    console.log('  Reset one:  npm run mfa-reset -- <username> [--all]');
    console.log(bar);
  }
  console.log('');
  if (!username) { dbmod.close(); process.exit(0); }
}

const u = db.prepare('SELECT id, username, role FROM users WHERE username=?').get(username);
if (!u) {
  console.error('\n  No such account: ' + username);
  console.error('  Run `npm run mfa-reset -- --list` to see the accounts.\n');
  dbmod.close();
  process.exit(1);
}

const before = repo.getMfaStatus(username);
repo.disableMfa(username, { ip: 'local-console', userAgent: 'mfa-reset.js', actor: 'operator' });

let removedPasskeys = 0;
if (alsoPasskeys) {
  removedPasskeys = db.prepare('SELECT COUNT(*) AS c FROM passkeys WHERE username=?').get(username).c;
  db.prepare('DELETE FROM passkeys WHERE username=?').run(username);
  repo.logAuth('PASSKEY_DELETE', 'SUCCESS', {
    username, userId: u.id, ip: 'local-console', userAgent: 'mfa-reset.js',
    reason: 'operator reset removed ' + removedPasskeys + ' passkey(s)',
  });
}

// A second factor is what stops a stolen password being enough; if it has just
// been cleared, every existing session for the account is suspect.
repo.deleteUserSessions(username);

const after = repo.getMfaStatus(username);
console.log('\n' + bar);
console.log('  MFA RESET — ' + username + '  (' + u.role + ')');
console.log(bar);
console.log('  TOTP            : ' + (before.totpEnabled ? 'enabled' : 'off') + '  →  off');
console.log('  Recovery codes  : ' + before.recoveryCodesRemaining + '  →  0');
console.log('  Passkeys        : ' + before.passkeyCount + '  →  ' + after.passkeyCount +
            (alsoPasskeys ? '  (' + removedPasskeys + ' deleted)' : '  (kept — pass --all to delete)'));
console.log('  Trusted devices : cleared');
console.log('  Sessions        : revoked');
console.log(bar);
if (after.setupRequired) {
  console.log('  This role REQUIRES MFA. On next sign-in the account will reach');
  console.log('  the enrolment screen and nothing else until a factor is added.');
} else {
  console.log('  This role does not require MFA; the account can sign in with a');
  console.log('  password alone.');
}
console.log(bar + '\n');

dbmod.close();
