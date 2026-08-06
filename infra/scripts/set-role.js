'use strict';
/**
 * infra/scripts/set-role.js — restore an account's role from the console.
 *
 *   npm run set-role                       → list every account and its role (changes nothing)
 *   npm run set-role -- admin admin        → set account 'admin' to the 'admin' role
 *   npm run set-role -- alice manager      → set account 'alice' to 'manager'
 *
 * ══════════════════════════════════════════════════════════════════
 * Why this exists
 * ══════════════════════════════════════════════════════════════════
 * Roles are assigned in the app, and the app deliberately refuses to let an
 * account change its OWN role — so if the last administrator is demoted (by a
 * second admin, or by an account that briefly outranked them), there is no route
 * back through the UI: the Users screen needs user.view, which the demoted
 * account no longer holds. That is the hole this fills.
 *
 * Same trust boundary as reset-admin.js: it requires filesystem access to the
 * server, so it grants nothing to a remote attacker who did not already own the
 * machine. It deliberately does NOT take a password — it is a recovery tool, not
 * an authentication bypass.
 *
 * It delegates to repo.setUserRole() rather than writing SQL, so it inherits
 * every invariant that function enforces — role must exist, account must exist,
 * the last administrator cannot be demoted — and writes the same ROLE_CHANGE row
 * to auth_log that a change made through the UI would.
 *
 * The rank check is the one rule skipped, and only because there is no actor:
 * `actorRank` is left undefined, which is what makes promotion back to Admin
 * possible at all. That is the entire purpose of the script.
 */
const dbmod = require('../db');
const repo  = require('../repo');

const username = (process.argv[2] || '').trim();
const roleKey  = (process.argv[3] || '').trim().toLowerCase();

dbmod.init();
const db = dbmod.db;

const line = '='.repeat(64);

/** Every account with the role that actually drives authorisation (role_id). */
function listAccounts() {
  return db.prepare(
    'SELECT u.username, u.name, u.role AS role_text, r.key AS role_key, r.rank ' +
    'FROM users u LEFT JOIN roles r ON r.id = u.role_id ORDER BY r.rank, u.username'
  ).all();
}

function printAccounts(title) {
  const rows = listAccounts();
  console.log('\n' + line);
  console.log('  ' + title);
  console.log(line);
  if (!rows.length) {
    console.log('  (no accounts — delete data/db/kd.db and restart to re-seed)');
  } else {
    rows.forEach(u => {
      /* role_id is authoritative; the text column is only for display. When they
       * disagree the account is mid-migration or was edited by hand, and the
       * difference is the most useful thing on the screen. */
      const drift = u.role_key && u.role_text !== u.role_key
        ? '   ⚠ text column says "' + u.role_text + '"' : '';
      console.log('    ' + (u.username + '                    ').slice(0, 20) +
                  (u.role_key || '(no role_id!)') + drift);
    });
  }
  const admins = rows.filter(u => u.role_key === 'admin').length;
  console.log(line);
  console.log('  administrators: ' + admins + (admins ? '' : '   ← nobody can manage this system'));
  console.log(line + '\n');
  return rows;
}

/* ── No arguments: report and stop. ──────────────────────────────── */
if (!username || !roleKey) {
  printAccounts('ACCOUNTS');
  const roles = db.prepare('SELECT key, name, rank FROM roles ORDER BY rank').all();
  console.log('  Assignable roles:');
  roles.forEach(r => console.log('    - ' + (r.key + '            ').slice(0, 14) + r.name + '  (rank ' + r.rank + ')'));
  console.log('\n  To change one:');
  console.log('    npm run set-role -- <username> <role>');
  console.log('  e.g.');
  console.log('    npm run set-role -- admin admin\n');
  dbmod.close();
  process.exit(0);
}

/* ── Apply the change. ───────────────────────────────────────────── */
const before = db.prepare(
  'SELECT u.username, r.key AS role_key FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.username=?'
).get(username);

if (!before) {
  console.error('\n  No such account: ' + username);
  printAccounts('EXISTING ACCOUNTS');
  dbmod.close();
  process.exit(1);
}

const status = repo.setUserRole(username, roleKey, {
  ip: 'local-console', userAgent: 'set-role.js', actor: 'operator',
  // actorRank intentionally omitted — see the header note.
});

const EXPLAIN = {
  'unknown-role': 'No role with that key. Run without arguments to list them.',
  'missing':      'No such account.',
  'last-admin':   'That would demote the only administrator, leaving nobody able to manage the system.',
};

if (status !== 'ok') {
  console.error('\n  REFUSED (' + status + ') — ' + (EXPLAIN[status] || 'see repo.setUserRole'));
  console.error('  Nothing was changed.\n');
  dbmod.close();
  process.exit(1);
}

/* A role change alters what every live session for this account may do. Cutting
 * them forces a clean sign-in on the new role rather than leaving a browser
 * holding a permission set the server no longer agrees with. */
const revoked = repo.deleteUserSessions(username);

console.log('\n' + line);
console.log('  ROLE CHANGED — ' + username);
console.log(line);
console.log('    ' + (before.role_key || '(none)') + '  →  ' + roleKey);
console.log(line);
console.log('  Sessions revoked' + (typeof revoked === 'number' ? ': ' + revoked : '') +
            ' — sign in again for it to take effect.');
console.log('  Recorded in the audit trail as ROLE_CHANGE.');
console.log(line);

printAccounts('ACCOUNTS NOW');
dbmod.close();
