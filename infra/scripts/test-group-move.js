'use strict';
/**
 * infra/scripts/test-group-move.js — moving a worker between groups.
 *
 *   node infra/scripts/test-group-move.js
 *
 * Added with the bulk "Move to group" action: before it, `group_id` was written
 * only by addEmployee, so a worker could be created into a group but never
 * leave it. updateEmployee now accepts a move, and this pins down the rules
 * that make that safe to expose as a bulk operation:
 *
 *   • the destination must be a real, untrashed group — a typo must not strand
 *     a worker in a group no view lists;
 *   • an ordinary field edit in the same patch must still apply;
 *   • the move is recorded on the worker AND on both groups, because "where did
 *     this person go" is asked from either side.
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 */
const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-move-test-'));
process.env.KD_DATA_DIR = TMP;

const dbmod = require('../db');
const repo  = require('../repo');

dbmod.init();
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

const A = repo.createGroup({ id: '_movetest_a', name: 'Move Test A' });
const B = repo.createGroup({ id: '_movetest_b', name: 'Move Test B' });
const uid = repo.addEmployee(A, { en_name: 'Move Me', worker_id: 'MT-001', _by: 'tester' });

const groupOf = u => dbmod.db.prepare('SELECT group_id FROM employees WHERE uid=?').get(u).group_id;

try {
  ok('starts in A', groupOf(uid) === A);

  repo.updateEmployee(uid, { group_id: B, _by: 'tester' });
  ok('moves to B', groupOf(uid) === B, groupOf(uid));

  repo.updateEmployee(uid, { group_id: 'no-such-group', _by: 'tester' });
  ok('refuses an unknown destination', groupOf(uid) === B, groupOf(uid));

  repo.updateEmployee(uid, { group_id: B, _by: 'tester' });
  ok('a move to the same group is a no-op', groupOf(uid) === B);

  repo.softDeleteGroup(A);
  repo.updateEmployee(uid, { group_id: A, _by: 'tester' });
  ok('refuses a trashed destination', groupOf(uid) === B, groupOf(uid));
  repo.restoreGroup(A);

  repo.updateEmployee(uid, { group_id: A, en_name: 'Moved Back', _by: 'tester' });
  const row = dbmod.db.prepare('SELECT group_id, en_name FROM employees WHERE uid=?').get(uid);
  ok('a move and a field edit in one patch both apply',
     row.group_id === A && row.en_name === 'Moved Back', JSON.stringify(row));

  const empLog = repo.getActivity(uid);
  ok('the worker records the move', empLog.some(r => r.action === 'moved'),
     empLog.map(r => r.action).join(','));
  ok('the source group records it',
     repo.getGroupActivity(A).some(r => r.action === 'worker_moved_out'));
  ok('the destination group records it',
     repo.getGroupActivity(B).some(r => r.action === 'worker_moved_in'));
  ok('no raw "group_id" entry in the change log',
     !empLog.some(r => /group_id/.test(r.detail || '')));
} finally {
  repo.deleteGroup(A);
  repo.deleteGroup(B);
}
ok('cleanup removed the test groups',
   !dbmod.db.prepare('SELECT id FROM groups WHERE id IN (?,?)').get('_movetest_a', '_movetest_b'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
