'use strict';
/**
 * infra/scripts/test-couple.js — married couples as a real 1:1 link (P4).
 *
 *   node infra/scripts/test-couple.js
 *
 * `couple` was a yes/no label that printed 부부 on the KD card and said nothing
 * about who. `spouse_uid` says who, and once two records point at each other
 * three things can go wrong quietly:
 *
 *   1. HALF A PAIR. Someone writes one side and not the other, and the app
 *      shows a marriage from one direction only. Every route into the column
 *      goes through setSpouse for this reason — spouse_uid is deliberately not
 *      in EMP_COLS, so an ordinary PATCH cannot reach it.
 *
 *   2. A SHARED PHOTO DELETED OUT FROM UNDER THE SURVIVOR. Couples are
 *      photographed together and the same file is filed under both. The old
 *      code unlinked a photo the moment ANY record stopped pointing at it, so
 *      removing one half left the other showing a broken image. Nothing errors;
 *      you find out when the card is exported.
 *
 *   3. A DOCUMENT SHARED BETWEEN TWO PEOPLE. A passport belongs to exactly one
 *      person. This suite pins that a document file can never end up attached
 *      to two employees, no matter what the payload asks for.
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 */
const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-couple-test-'));
process.env.KD_DATA_DIR = TMP;

const dbmod = require('../db');
const repo  = require('../repo');

dbmod.init();
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};
const section = t => { console.log('\n' + t); console.log('-'.repeat(t.length)); };

const row    = u => dbmod.db.prepare('SELECT * FROM employees WHERE uid=?').get(u);
const spouse = u => { const r = row(u); return r ? (r.spouse_uid || '') : '(gone)'; };
const flag   = u => { const r = row(u); return r ? (r.couple || '') : '(gone)'; };
/** Is the pair symmetric — A→B and B→A, or both empty? */
const paired = (a, b) => spouse(a) === b && spouse(b) === a;

/* A 1×1 PNG, so the file that gets written is a real one. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const onDisk = p => fs.existsSync(path.join(TMP, 'uploads', String(p).replace(/^\/uploads\//, '')));

const G  = repo.createGroup({ id: '_cpl_g1', name: 'Couple Test' });
const G2 = repo.createGroup({ id: '_cpl_g2', name: 'Couple Test 2' });
const add = (name, extra) => repo.addEmployee(G, Object.assign({ en_name: name, _by: 'tester' }, extra || {}));

try {
  /* ══════════════════════════════════════════════════════════════
   * The link itself
   * ══════════════════════════════════════════════════════════════ */
  section('pairing — 1:1, and symmetric from the first write');
  const a = add('Anousone A'), b = add('Bounmy B'), c = add('Chan C');

  ok('nobody starts married', spouse(a) === '' && spouse(b) === '');

  ok('pairing reports success', repo.setSpouse(a, b, 'tester') === '');
  ok('both sides point at each other', paired(a, b), spouse(a) + ' / ' + spouse(b));
  ok("the printed 부부 flag follows on both", flag(a) === 'yes' && flag(b) === 'yes',
     flag(a) + ' / ' + flag(b));

  ok('pairing the same two again is a no-op, not a corruption',
     repo.setSpouse(a, b, 'tester') === '' && paired(a, b));

  /* Re-pairing is where a half-link is easiest to create: B must be released. */
  repo.setSpouse(a, c, 'tester');
  ok('re-pairing links the new partner', paired(a, c), spouse(a) + ' / ' + spouse(c));
  ok('and releases the old one — no one is left pointing at a taken partner',
     spouse(b) === '', spouse(b));
  ok('the released partner loses the 부부 flag too', flag(b) === 'no', flag(b));

  /* Taking a partner who is already married releases THEIR old partner too. */
  const d1 = add('Daovy D'), d2 = add('Duang E');
  repo.setSpouse(d1, d2, 'tester');
  repo.setSpouse(a, d2, 'tester');           // a was with c, d2 was with d1
  ok('taking an already-married partner releases both former halves',
     paired(a, d2) && spouse(c) === '' && spouse(d1) === '',
     'c=' + spouse(c) + ' d1=' + spouse(d1));

  section('what pairing refuses');
  ok('nobody marries themselves', repo.setSpouse(a, a, 'tester') === 'cannot-pair-with-self');
  ok('and the attempt changed nothing', paired(a, d2));
  ok('an unknown partner is refused', repo.setSpouse(a, 'no-such-uid', 'tester') === 'no-such-spouse');
  ok('an unknown employee is refused', repo.setSpouse('no-such-uid', a, 'tester') === 'no-such-employee');

  const t1 = add('Trashed T');
  repo.softDeleteEmployee(t1);
  ok('somebody in the trash cannot be married', repo.setSpouse(a, t1, 'tester') === 'spouse-in-trash');

  section('unpairing');
  repo.setSpouse(a, '', 'tester');
  ok('clears both halves', spouse(a) === '' && spouse(d2) === '', spouse(a) + ' / ' + spouse(d2));
  ok('and both 부부 flags', flag(a) === 'no' && flag(d2) === 'no');
  ok('unpairing somebody single is harmless', repo.setSpouse(a, '', 'tester') === '' && spouse(a) === '');

  /* ══════════════════════════════════════════════════════════════
   * The column cannot be written any other way
   * ══════════════════════════════════════════════════════════════ */
  section('the only door in');
  const e1 = add('Ekalath E'), e2 = add('Fongchan F');
  repo.updateEmployee(e1, { spouse_uid: e2, _by: 'tester' });
  ok('a PATCH carrying spouse_uid pairs BOTH records', paired(e1, e2),
     spouse(e1) + ' / ' + spouse(e2));
  repo.updateEmployee(e1, { spouse_uid: '', _by: 'tester' });
  ok('and clearing it releases both', spouse(e1) === '' && spouse(e2) === '');

  /* EMP_COLS is the allowlist updateEmployee writes directly. spouse_uid must
     NOT be in it, or a patch would write one side and leave the other stale. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'repo.js'), 'utf8');
  const empCols = (src.match(/const EMP_COLS = \[([\s\S]*?)\];/) || [, ''])[1];
  ok('spouse_uid is not in EMP_COLS', !/'spouse_uid'/.test(empCols),
     'a direct column write would half-link the pair');

  /* ══════════════════════════════════════════════════════════════
   * A shared photo survives its owner
   * ══════════════════════════════════════════════════════════════ */
  section('a shared photo belongs to whoever is left');
  const h = add('Husband H', { photo: PNG });
  const shared = row(h).photo_path;
  ok('the photo was stored', !!shared && onDisk(shared), String(shared));

  const w = add('Wife W');
  repo.updateEmployee(w, { photo: shared, _by: 'tester' });   // the same file, both records
  repo.setSpouse(h, w, 'tester');
  ok('both records point at one file', row(w).photo_path === shared);

  repo.deleteEmployee(h);
  ok('deleting one half leaves the file on disk', onDisk(shared),
     'the survivor would be showing a broken image');
  ok('the survivor still points at it', row(w).photo_path === shared);
  ok('and is no longer married to a record that does not exist', spouse(w) === '', spouse(w));
  ok('the widow loses the 부부 flag', flag(w) === 'no', flag(w));

  repo.deleteEmployee(w);
  ok('deleting the last holder DOES remove the file', !onDisk(shared),
     'otherwise every shared photo leaks once both records are gone');

  /* One worker can point at the same file from photo_path AND photo_orig; a
     naive "does anyone ELSE use it" check deletes a file still in use. */
  section('one worker, two columns, one file');
  const s = add('Selfie S', { photo: PNG });
  const p1 = row(s).photo_path;
  repo.updateEmployee(s, { photo_orig: p1, _by: 'tester' });
  ok('photo and photo_orig share the file', row(s).photo_orig === p1);
  repo.updateEmployee(s, { photo: PNG, _by: 'tester' });      // replaces photo only
  ok('replacing one column keeps the file the other still uses', onDisk(p1),
     'photo_orig was left pointing at a deleted file');

  /* A whole group going: both rows disappear at once, so each would see the
     other still holding the file and neither would ever release it. */
  section('deleting a group that contains a couple');
  const g1 = repo.addEmployee(G2, { en_name: 'Pair One', photo: PNG, _by: 'tester' });
  const gShared = row(g1).photo_path;
  const g2 = repo.addEmployee(G2, { en_name: 'Pair Two', _by: 'tester' });
  repo.updateEmployee(g2, { photo: gShared, _by: 'tester' });
  repo.setSpouse(g1, g2, 'tester');
  ok('the couple shares a photo', row(g2).photo_path === gShared && onDisk(gShared));
  repo.deleteGroup(G2);
  ok('the shared file is released, not orphaned', !onDisk(gShared),
     'both rows saw the other holding it and neither let go');

  /* ══════════════════════════════════════════════════════════════
   * Documents are never shared — not even between spouses
   * ══════════════════════════════════════════════════════════════ */
  section('documents stay with exactly one person');
  const m = add('Mister M'), n = add('Missus N');
  repo.setSpouse(m, n, 'tester');
  repo.updateEmployee(m, { documents: { passport: [{ name: 'p.png', type: 'image', data: PNG }] }, _by: 'tester' });
  const mDoc = dbmod.db.prepare('SELECT file_path FROM documents WHERE employee_uid=?').get(m);
  ok('the document was stored', !!mDoc && onDisk(mDoc.file_path), String(mDoc && mDoc.file_path));

  // Hand the spouse's stored path over deliberately — the payload a UI bug (or
  // a hand-written request) would send to "copy" a passport across.
  repo.updateEmployee(n, { documents: { passport: [{ name: 'p.png', type: 'image', data: mDoc.file_path }] }, _by: 'tester' });
  const shares = dbmod.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE file_path=?').get(mDoc.file_path);
  ok('it is not linked to the spouse as well', shares.n === 1, shares.n + ' employees hold it');
  ok("and the owner's document is untouched", onDisk(mDoc.file_path));

  /* No file in the whole database may be held by two different employees. */
  const dupes = dbmod.db.prepare(
    'SELECT file_path, COUNT(DISTINCT employee_uid) AS holders FROM documents GROUP BY file_path HAVING holders > 1'
  ).all();
  ok('no document file has two holders anywhere', dupes.length === 0,
     dupes.map(x => x.file_path).join(', '));

  /* ══════════════════════════════════════════════════════════════
   * Backups and .kdb bundles put the pair back
   * ══════════════════════════════════════════════════════════════ */
  section('a restored pair is still a pair');
  /* The halves arrive one at a time: the first has a partner that does not
     exist yet, so it links nothing; the second completes both sides. */
  const rA = repo.addEmployee(G, { uid: '_rest_a', en_name: 'Restored A', spouse_uid: '_rest_b', _by: 'tester' });
  ok('the first half links nothing yet', spouse(rA) === '', spouse(rA));
  const rB = repo.addEmployee(G, { uid: '_rest_b', en_name: 'Restored B', spouse_uid: '_rest_a', _by: 'tester' });
  ok('the second half completes the pair, both ways', paired(rA, rB),
     spouse(rA) + ' / ' + spouse(rB));

  /* ══════════════════════════════════════════════════════════════
   * What the browser is handed
   * ══════════════════════════════════════════════════════════════ */
  section('reads');
  const boot = repo.getBootstrap();
  const all = boot.groups.reduce((acc, g) => acc.concat(g.workers), []);
  const rowA = all.find(x => x.uid === rA);
  ok('spouse_uid reaches the client', rowA && rowA.spouse_uid === rB, rowA && rowA.spouse_uid);
  ok('every live pair in the bootstrap is symmetric', (() => {
    const by = {}; all.forEach(x => { by[x.uid] = x; });
    const broken = all.filter(x => x.spouse_uid && by[x.spouse_uid] && by[x.spouse_uid].spouse_uid !== x.uid);
    return broken.length === 0 || broken.map(x => x.uid).join(',');
  })() === true, 'half-linked records');

  /* ══════════════════════════════════════════════════════════════
   * The importer, checked statically
   * ══════════════════════════════════════════════════════════════ */
  section('importing a bundle — uids are translated, never trusted');
  /* This code runs in the browser, so it is read rather than executed. It is
     checked at all because the failure is silent in both directions: drop the
     remap and every couple in a restored bundle comes back single; send the
     bundle's spouse_uid as-is and re-importing a bundle into the server that
     produced it marries the new copies to the original people. */
  const imp = fs.readFileSync(
    path.join(__dirname, '..', '..', 'domains', 'recruitment', 'intake-import', 'pptx-import.js'), 'utf8');
  ok('the bundle parser keeps the source uid', /_src_uid\s*=\s*rec\.uid/.test(imp));
  ok('and the source spouse', /_src_spouse\s*=\s*rec\.spouse_uid/.test(imp));
  ok('the incoming spouse_uid is NOT sent on create', /delete w\.spouse_uid/.test(imp),
     'it would point at a uid from another server — or worse, a real one on this one');
  ok('the JSON path is treated the same way', /delete c\.spouse_uid/.test(imp));
  ok('a remap pass translates old ids to new',
     /newUidOf\[r\.srcUid\] = r\.uid/.test(imp) && /newUidOf\[r\.srcSpouse\]/.test(imp));
  ok('and pairs through the ordinary write path', /spouse_uid: partner/.test(imp));
  ok('the private fields never reach the server',
     /delete copy\._src_uid/.test(imp) && /delete copy\._src_spouse/.test(imp));

  /* The other half of the round trip: the bundle has to carry spouse_uid OUT.
     It does so by spreading the whole worker and deleting only the media
     fields, which is why a new column needs no export change — and why this
     checks the mechanism rather than the field. */
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'shell', 'scripts', 'app.js'), 'utf8');
  const bundle = (app.match(/const rec = \{ \.\.\.w \};[\s\S]{0,200}/) || [''])[0];
  ok('the bundle record is the whole worker, minus media', !!bundle, 'the export builds records field by field now');
  ok('and spouse_uid is not one of the fields it drops', !!bundle && !/delete rec\.spouse_uid/.test(bundle));

  /* Trash is reversible, so the link must survive it rather than be cleared. */
  section('trash keeps the marriage, hard delete does not');
  repo.softDeleteEmployee(rB);
  ok('trashing one half leaves the link intact for a restore', spouse(rA) === rB, spouse(rA));
  repo.restoreEmployee(rB);
  ok('and restoring brings the pair back whole', paired(rA, rB));

} finally {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
