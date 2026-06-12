'use strict';
/**
 * backend/scripts/selftest.js — upload-integrity / CRUD regression test.
 *
 *   node backend/scripts/selftest.js
 *
 * Exercises the real persistence layer (repo.js + files.js + kd.db) for every
 * document type and asserts Create / Read / Update / Delete behave correctly.
 * It is NON-DESTRUCTIVE: all work happens inside a throwaway group that is
 * deleted (cascade) at the end, so production data is untouched.
 *
 * Specifically guards the two Phase-2 fixes:
 *   • Bug #1 — adding/removing one document must NOT delete other files.
 *   • Photo replacement must remove only the old file, never a referenced one.
 */
const fs    = require('node:fs');
const path  = require('node:path');
const dbmod = require('./../db');
const repo  = require('./../repo');

dbmod.init();
const UPLOADS = dbmod.UPLOADS_DIR;
const abs = pub => path.join(UPLOADS, pub.replace(/^\/uploads\//, ''));
const onDisk = pub => typeof pub === 'string' && pub.startsWith('/uploads/') && fs.existsSync(abs(pub));

// tiny valid 1x1 PNG + minimal PDF as data: URLs
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJWV4dAo='; // header-only, enough to store/serve

let pass = 0, fail = 0; const fails = [];
function check(name, cond) { if (cond) { pass++; console.log('  [PASS] ' + name); } else { fail++; fails.push(name); console.log('  [FAIL] ' + name); } }

function workerOf(uid) {
  for (const g of repo.getBootstrap().groups) {
    const w = g.workers.find(x => x.uid === uid);
    if (w) return w;
  }
  return null;
}
function docsOf(uid) { const w = workerOf(uid); return w ? (w.documents || {}) : {}; }

const GID = 'TEST-SELFTEST-' + Date.now().toString(36);
console.log('── upload-integrity self-test (temp group ' + GID + ') ──');

try {
  repo.createGroup({ id: GID, name: 'SELFTEST (auto-delete)' });

  // ── CREATE: employee with photo + passport doc ──
  const uid = repo.addEmployee(GID, {
    en_name: 'TEST WORKER', passport_no: 'TEST123',
    photo: PNG,
    documents: { passport: [{ name: 'pp.png', type: 'image', data: PNG }] },
  });
  let w = workerOf(uid);
  check('CREATE worker row exists', !!w);
  check('CREATE photo stored on disk', onDisk(w.photo));
  let d = docsOf(uid);
  check('CREATE passport doc stored on disk', d.passport && d.passport.length === 1 && onDisk(d.passport[0].data));
  const passportPath = d.passport[0].data;

  // ── UPDATE (Bug #1 regression): add ID card while KEEPING passport ──
  repo.updateEmployee(uid, { documents: {
    passport: [{ name: 'pp.png', type: 'image', data: passportPath }], // existing → stored path
    id_card:  [{ name: 'id.png', type: 'image', data: PNG }],          // new upload
  }});
  d = docsOf(uid);
  check('UPDATE original passport file SURVIVES', onDisk(passportPath));
  check('UPDATE new id_card file stored', d.id_card && onDisk(d.id_card[0].data));
  const idPath = d.id_card[0].data;

  // ── UPDATE: multiple "application pages" + supporting docs in one category ──
  repo.updateEmployee(uid, { documents: {
    passport: [{ name: 'pp.png', type: 'image', data: passportPath }],
    id_card:  [{ name: 'id.png', type: 'image', data: idPath }],
    land:     [ // application forms (multi-page) + a PDF supporting doc
      { name: 'app1.png', type: 'image', data: PNG },
      { name: 'app2.png', type: 'image', data: PNG },
      { name: 'app3.png', type: 'image', data: PNG },
    ],
    other:    [{ name: 'support.pdf', type: 'pdf', data: PDF }],
  }});
  d = docsOf(uid);
  check('UPDATE 3 application pages all stored', d.land && d.land.length === 3 && d.land.every(f => onDisk(f.data)));
  check('UPDATE supporting PDF stored', d.other && d.other.length === 1 && onDisk(d.other[0].data));
  check('UPDATE earlier files (passport,id) still survive', onDisk(passportPath) && onDisk(idPath));

  // ── UPDATE: photo replacement removes only the OLD file ──
  const oldPhoto = workerOf(uid).photo;
  repo.updateEmployee(uid, { photo: PNG });
  const newPhoto = workerOf(uid).photo;
  check('REPLACE photo → new file exists', onDisk(newPhoto));
  check('REPLACE photo → old file removed', oldPhoto !== newPhoto && !onDisk(oldPhoto));

  // ── DELETE one document (remove id_card from the set) ──
  repo.updateEmployee(uid, { documents: {
    passport: [{ name: 'pp.png', type: 'image', data: passportPath }],
    land: d.land.map(f => ({ name: f.name, type: f.type, data: f.data })),
    other: [{ name: 'support.pdf', type: 'pdf', data: d.other[0].data }],
  }});
  check('DELETE id_card → its file removed', !onDisk(idPath));
  check('DELETE id_card → passport + land untouched', onDisk(passportPath) && d.land.every(f => onDisk(f.data)));

  // ── DELETE employee → all remaining files gone ──
  const before = [passportPath, ...d.land.map(f => f.data), d.other[0].data, newPhoto];
  repo.deleteEmployee(uid);
  check('DELETE worker removes row', !workerOf(uid));
  check('DELETE worker removes ALL its files', before.every(p => !onDisk(p)));
} finally {
  try { repo.deleteGroup(GID); } catch (e) {}
}

console.log('── result: ' + pass + ' passed, ' + fail + ' failed ──');
if (fail) { console.log('   failed: ' + fails.join('; ')); process.exit(1); }
