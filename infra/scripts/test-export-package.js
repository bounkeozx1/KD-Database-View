'use strict';
/**
 * infra/scripts/test-export-package.js — the per-worker export package.
 *
 *   node infra/scripts/test-export-package.js
 *
 * Builds a real archive from real records and then opens it with the ZIP reader
 * to check what actually landed inside. The point is the layout the operator
 * asked for — a folder per worker named `Name_workerId_date`, `photos/`, and a
 * folder per document version — plus the two properties that make a package
 * trustworthy: a missing file is RECORDED rather than silently omitted, and a
 * failed build leaves no archive behind that looks finished.
 *
 * The HTTP section at the end is the part that matters most for a file of
 * passport scans: it proves the three routes are refused for a Manager, who
 * holds export.pdf and export.excel but must not reach this.
 *
 * Throwaway DB in the OS temp dir; the live kd.db is never opened.
 */
const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-pkg-test-'));
process.env.KD_DATA_DIR = TMP;

const dbmod = require('../db');
const repo  = require('../repo');
const zip   = require('../zip');
const pkg   = require('../export-package');
const totp  = require('../totp');

dbmod.init();
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

// A 1×1 PNG and a header-only PDF: enough to be stored, served and read back.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJWV4dAo=';

const wait = ms => new Promise(r => setTimeout(r, ms));
async function finish(job) {
  for (let i = 0; i < 600; i++) {                 // 60s ceiling
    const s = pkg.status(job.id, 'tester');
    if (!s || s.state !== 'running') return s;
    await wait(100);
  }
  throw new Error('the build did not finish within 60s');
}

(async () => {
  const gid = repo.createGroup({ id: '_pkgtest', name: 'Package Test' });

  // Two workers with the same name and no ID: the folder names must still differ.
  const a = repo.addEmployee(gid, { en_name: 'Somchai Keo', worker_id: 'KD-T-001',
                                    lo_name: 'ສົມໄຊ', photo_orig: PNG, _by: 'tester' });
  const b = repo.addEmployee(gid, { en_name: 'Somchai Keo', _by: 'tester' });
  const c = repo.addEmployee(gid, { en_name: 'ນາງ ວິໄລ', worker_id: 'KD-T-003', _by: 'tester' });

  repo.addDocument(a, gid, 'passport', PNG, 'p1.png', 'tester');   // v1
  repo.addDocument(a, gid, 'passport', PDF, 'p2.pdf', 'tester');   // v2 → current
  repo.addDocument(a, gid, 'id_card',  PNG, 'id.png', 'tester');   // v1 → current
  repo.addDocument(c, gid, 'passport', PNG, 'p.png',  'tester');

  // A row whose file is gone from disk — the "recorded, not hidden" case.
  const orphan = repo.addDocument(b, gid, 'land_doc', PNG, 'gone.png', 'tester');
  try { fs.unlinkSync(path.join(dbmod.UPLOADS_DIR, orphan.path.replace(/^\/uploads\//, ''))); } catch (e) {}

  let built = null;
  try {
    /* ── Refusals first: none of these may produce a file ── */
    ok('refuses an empty selection', pkg.start({ uids: [], by: 'tester' }).reason === 'no-workers');
    ok('refuses more workers than the limit',
       pkg.start({ uids: new Array(pkg.MAX_WORKERS + 1).fill(a), by: 'tester' }).reason === 'too-many');
    ok('refuses uids that do not exist',
       pkg.start({ uids: ['nope-1', 'nope-2'], by: 'tester' }).reason === 'no-workers');

    /* ── Names ── */
    ok('a name with no worker ID falls back to NOID',
       /_NOID-[a-z0-9]{4}_/.test(pkg.folderName({ en_name: 'X', uid: 'wabcd1234' }, '2026-08-03')),
       pkg.folderName({ en_name: 'X', uid: 'wabcd1234' }, '2026-08-03'));
    ok('Lao names survive sanitising', pkg.safeSegment('ນາງ ວິໄລ', 'x') === 'ນາງ-ວິໄລ',
       pkg.safeSegment('ນາງ ວິໄລ', 'x'));
    ok('characters Windows rejects are replaced',
       !/[\\/:*?"<>|]/.test(pkg.safeSegment('a/b:c*d?e"f<g>h|i', 'x')));
    ok('a reserved device name is escaped', pkg.safeSegment('CON', 'x') === '_CON');

    /* ── A real build ── */
    const job = pkg.start({ uids: [a, b, c], by: 'tester', options: {} });
    ok('the job starts', job && job.state === 'running' && job.total === 3,
       JSON.stringify(job && { state: job.state, total: job.total }));

    const done = await finish(job);
    built = pkg.fileFor(job.id, 'tester');
    ok('the build finishes', done && done.state === 'done', done && (done.error || done.state));
    ok('the archive exists', !!(built && fs.existsSync(built.path)));

    ok('another account cannot see the job', pkg.status(job.id, 'someone-else') === null);
    ok('another account cannot download it', pkg.fileFor(job.id, 'someone-else') === null);

    /* ── What is actually inside ── */
    const reader = new zip.ZipReader(built.path);
    const names = reader.entries.map(e => e.name);
    const has = re => names.some(n => re.test(n));

    /* ── Exactly one thing at the top ──
     * "Extract here" must produce a single folder, not a dozen worker folders
     * plus two loose files scattered into whatever directory the operator was
     * standing in. */
    const roots = new Set(names.map(n => n.split('/')[0]));
    ok('the archive has ONE top-level folder', roots.size === 1, [...roots].join(' | '));
    const ROOT = [...roots][0];
    ok('the root folder is named for the group and the date',
       /^KD-Export_Package-Test_\d{4}-\d{2}-\d{2}$/.test(ROOT), ROOT);
    ok('nothing sits loose at the top level', names.every(n => n.includes('/')),
       names.filter(n => !n.includes('/')).join(' | '));

    ok('manifest.txt is inside data/', names.includes(ROOT + '/data/manifest.txt'));
    ok('summary.csv is inside data/', names.includes(ROOT + '/data/summary.csv'));
    ok('the top level is worker folders plus data/ and nothing else',
       [...new Set(names.map(n => n.split('/')[1]))].every(f => f === 'data' || /_\d{4}-\d{2}-\d{2}(-\d+)?$/.test(f)),
       [...new Set(names.map(n => n.split('/')[1]))].join(' | '));
    ok('every entry uses forward slashes', names.every(n => !n.includes('\\')));

    ok('the worker folder is Name_workerId_date',
       has(/\/Somchai-Keo_KD-T-001_\d{4}-\d{2}-\d{2}\//), names.slice(0, 6).join(' | '));
    ok('the photo goes under photos/',
       has(/\/Somchai-Keo_KD-T-001_[\d-]+\/photos\/profile_Somchai-Keo\.png$/));
    ok('the current version is marked',
       has(/\/documents\/passport\/v2-current\/passport_Somchai-Keo_v2\.pdf$/));
    ok('older versions keep their own folder',
       has(/\/documents\/passport\/v1\/passport_Somchai-Keo_v1\.png$/));
    ok('a second category is separate',
       has(/\/documents\/id_card\/v1-current\//));

    // Two workers called "Somchai Keo", one without an ID → two distinct folders.
    const folders = new Set(names.map(n => n.split('/')[1]).filter(f => f && f !== 'data'));
    ok('one folder per worker, none shared', folders.size === 3, [...folders].join(' | '));
    // The one with nothing on file still gets a folder, so it does not read as
    // though it was left out of the selection.
    ok('a worker with no files still gets a folder',
       names.some(n => /\/Somchai-Keo_NOID-[a-z0-9]{4}_[\d-]+\/$/.test(n)),
       names.filter(n => n.endsWith('/')).join(' | '));

    const csv = reader.readFile(ROOT + '/data/summary.csv').toString('utf8');
    ok('the CSV starts with a BOM (Excel reads Lao correctly)', csv.charCodeAt(0) === 0xFEFF);
    ok('the CSV names each folder', csv.includes('Somchai-Keo_KD-T-001_'));
    ok('the CSV has a row per worker', csv.trim().split(/\r\n/).length === 4,
       String(csv.trim().split(/\r\n/).length));
    ok('the CSV carries the passport column', /Passport No/.test(csv));
    ok('every field the dialog can tick has a column',
       (() => {
         // The picker's keys, transcribed from _EXPORT_FIELDS in app.js. A key
         // the picker offers but the builder cannot produce means a user ticks
         // a box and silently gets nothing.
         const picker = ['worker_id','en_name','lo_name','sex','dob','age','blood','nationality',
           'passport_no','passport_issue','passport_expiry','visa_status','village','district',
           'province','employer_code','group_supervisor','grade','couple','group_name',
           'weight','height','size','hand','tel','emg_tel'];
         const cols = new Set(pkg.SUMMARY_COLUMNS.map(([k]) => k));
         const missing = picker.filter(k => !cols.has(k));
         return missing.length === 0 || missing.join(',');
       })() === true, 'missing columns');
    ok('a ticked subset produces exactly those columns', (() => {
      const only = pkg.buildSummaryCsv([{ folder: 'f', worker_id: 'w', en_name: 'n', age: 30, blood: 'O' }],
                                        ['age']);
      const head = only.split('\r\n')[0];
      return head === '﻿"Folder","Worker ID","EN Name","Age"' ? true : head;
    })() === true, 'header');
    ok('age is computed from the date of birth', (() => {
      // Someone born 30 years ago yesterday has had their birthday.
      const d = new Date(); d.setFullYear(d.getFullYear() - 30); d.setDate(d.getDate() - 1);
      const dob = d.toISOString().slice(0, 10);
      const withDob = repo.addEmployee(gid, { en_name: 'Aged', worker_id: 'KD-T-AGE', dob, _by: 'tester' });
      const rows = pkg.loadWorkers([withDob]).map(w => Object.assign({}, w, { folder: 'f' }));
      const csvAge = pkg.buildSummaryCsv(rows, ['age']).split('\r\n')[1];
      return /"30"$/.test(csvAge) ? true : csvAge;
    })() === true, 'age cell')

    const manifest = reader.readFile(ROOT + '/data/manifest.txt').toString('utf8');
    ok('the manifest records who exported', /Created by\s*: tester/.test(manifest));
    ok('the manifest lists the missing file', /land_doc/.test(manifest),
       manifest.split('\r\n').slice(-6).join(' / '));
    ok('the missing file is reported to the caller', done.skipped === 1, String(done.skipped));
    ok('the missing file is NOT in the archive', !has(/land_doc/));
    ok('the counts add up', done.documents === 4 && done.photos === 1,
       'documents=' + done.documents + ' photos=' + done.photos);

    // Every entry's CRC — the archive must be readable by any unzip, not just ours.
    const bad = reader.entries.filter(e => !reader.verifyEntry(e.name).ok).map(e => e.name);
    ok('every entry passes its CRC', bad.length === 0, bad.join(', '));
    reader.close();

    /* ── Options are honoured ── */
    const j2 = pkg.start({ uids: [a], by: 'tester',
      options: { allVersions: false, photos: false, categories: ['passport'] } });
    const d2 = await finish(j2);
    const f2 = pkg.fileFor(j2.id, 'tester');
    const r2 = new zip.ZipReader(f2.path);
    const n2 = r2.entries.map(e => e.name);
    ok('photos:false leaves the photo out', !n2.some(n => /\/photos\//.test(n)));
    ok('allVersions:false keeps only the current one',
       n2.some(n => /passport\/v2-current\//.test(n)) && !n2.some(n => /passport\/v1\//.test(n)));
    ok('a category filter excludes the rest', !n2.some(n => /id_card/.test(n)));
    ok('the summary is still written', n2.some(n => /\/data\/summary\.csv$/.test(n)));
    r2.close();
    try { fs.unlinkSync(f2.path); } catch (e) {}

    /* ── Retention ── */
    ok('a package is scheduled to expire',
       new Date(done.expiresAt).getTime() - new Date(done.createdAt).getTime() === pkg.TTL_MS);
  } finally {
    if (built) { try { fs.unlinkSync(built.path); } catch (e) {} }
    repo.deleteGroup(gid);
  }

  ok('cleanup removed the test group',
     !dbmod.db.prepare('SELECT id FROM groups WHERE id=?').get('_pkgtest'));

  await httpSection();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('\nthe suite itself threw:', e);
  process.exit(1);
});

/* ══════════════════════════════════════════════════════════════════
 * HTTP — the routes, and who is refused them
 * ══════════════════════════════════════════════════════════════════
 * The permission is the whole safety story for this feature. A Manager holds
 * export.pdf and export.excel and can already extract a spreadsheet of every
 * worker; what they must NOT be able to do is ask the server to assemble a
 * folder of everybody's passport scans. These assertions are what keeps that
 * true if the route table is ever edited.
 */
const PASS = 'PkgSuite!Pass7x';

/**
 * POST a raw body to the attach route. The shared _testhttp client serialises
 * JSON, which is exactly what this route must not receive — so this speaks to
 * it the way the browser does: raw bytes, the filename in a header, and a CSRF
 * token fetched for the caller's own session.
 */
function rawUpload(port, o) {
  const http = require('node:http');
  const get = (p, cookie) => new Promise((resolve) => {
    http.request({ host: '127.0.0.1', port, path: p, method: 'GET',
                   headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) {}
                            resolve({ body: j, headers: res.headers }); });
    }).end();
  });
  return get('/api/csrf', o.cookie).then(c => new Promise((resolve, reject) => {
    const token = (c.body && c.body.csrfToken) || '';
    const csrfCookie = (c.headers['set-cookie'] || [])
      .map(s => /^kd_csrf=([^;]*)/.exec(s)).filter(Boolean).map(m => 'kd_csrf=' + m[1])[0];
    const headers = Object.assign({
      'Content-Type': 'application/octet-stream',
      'Content-Length': o.payload.length,
      'X-CSRF-Token': token,
      'X-KD-Filename': encodeURIComponent(o.name),
      Cookie: [o.cookie, csrfCookie].filter(Boolean).join('; '),
    }, o.headers || {});
    const req = http.request({ host: '127.0.0.1', port,
      path: '/api/export/package/attach', method: 'POST', headers }, (res) => {
      let out = ''; res.on('data', c2 => out += c2);
      res.on('end', () => { let j = null; try { j = JSON.parse(out); } catch (e) {}
                            resolve({ status: res.statusCode, body: j, raw: out }); });
    });
    req.on('error', reject);
    if (o.payload.length) req.write(o.payload);
    req.end();
  }));
}

async function httpSection() {
  console.log('\nHTTP — authorisation on the package routes');
  console.log('-'.repeat(42));

  const U = {};
  ['admin', 'manager', 'viewer'].forEach(k => {
    U[k] = k + '_' + Date.now().toString(36);
    repo.addUser({ username: U[k], password: PASS, role: k, name: k },
                 { mustChange: false, actor: 'suite' });
  });

  const M = repo.getPermissionMatrix().matrix;
  ok('admin holds export.package', M.admin['export.package'] === 'all');
  ok('manager does NOT hold export.package', !M.manager['export.package']);
  ok('manager still holds the exports it should', M.manager['export.pdf'] === 'all');
  ok('viewer holds no export permission at all',
     !M.viewer['export.package'] && !M.viewer['export.pdf']);

  const PORT = 38600 + (process.pid % 200);
  process.env.PORT = String(PORT);
  require('../../shell/server.js');
  const { request } = require('./_testhttp').makeClient(PORT);
  await new Promise(r => setTimeout(r, 400));

  const cookieOf = (res) => {
    for (const c of (res.headers['set-cookie'] || [])) {
      const m = /^kd_sid=([^;]*)/.exec(c);
      if (m) return 'kd_sid=' + m[1];
    }
    return null;
  };
  async function signIn(roleKey) {
    const uname = U[roleKey];
    if (repo.mfaPolicyFor(roleKey).required && !repo.getMfaStatus(uname).totpEnabled) {
      const e = repo.beginTotpEnrolment(uname);
      repo.confirmTotpEnrolment(uname, totp.generate(e.secret), {});
      const s1 = await request('POST', '/api/login', { username: uname, password: PASS });
      if (s1.body && s1.body.mfaRequired) {
        dbmod.db.prepare('UPDATE users SET mfa_last_counter=NULL WHERE username=?').run(uname);
        const s2 = await request('POST', '/api/login/mfa',
          { mfaTicket: s1.body.mfaTicket, code: totp.generate(e.secret) });
        return cookieOf(s2);
      }
      return cookieOf(s1);
    }
    return cookieOf(await request('POST', '/api/login', { username: uname, password: PASS }));
  }

  const C = {};
  for (const k of ['admin', 'manager', 'viewer']) {
    C[k] = await signIn(k);
    ok(k + ' can sign in', !!C[k]);
  }
  const as = k => ({ Cookie: C[k] });

  const gid = repo.createGroup({ id: '_httppkg', name: 'HTTP Package Test' });
  const uid = repo.addEmployee(gid, { en_name: 'Http Tester', worker_id: 'KD-H-001', _by: 'suite' });

  const start = (role) => request('POST', '/api/export/package', { uids: [uid], scope: 'picked' }, as(role));

  const mgr = await start('manager');
  ok('manager is REFUSED a package (403)', mgr.status === 403, String(mgr.status));
  const vwr = await start('viewer');
  ok('viewer is REFUSED a package (403)', vwr.status === 403, String(vwr.status));

  const adm = await start('admin');
  ok('admin CAN start a package', adm.status === 200 && adm.body && adm.body.job,
     String(adm.status));
  const jobId = adm.body && adm.body.job && adm.body.job.id;

  // Poll to completion through the API, as the browser does.
  let last = null;
  for (let i = 0; i < 200; i++) {
    const r = await request('GET', '/api/export/package/' + jobId, undefined, as('admin'));
    last = r.body && r.body.job;
    if (!last || last.state !== 'running') break;
    await wait(100);
  }
  ok('the job reports done over HTTP', last && last.state === 'done',
     last && (last.error || last.state));

  const mgrPoll = await request('GET', '/api/export/package/' + jobId, undefined, as('manager'));
  ok('manager cannot poll the job (403)', mgrPoll.status === 403, String(mgrPoll.status));
  const mgrDl = await request('GET', '/api/export/package/' + jobId + '/download', undefined, as('manager'));
  ok('manager cannot download it (403)', mgrDl.status === 403, String(mgrDl.status));

  const anon = await request('GET', '/api/export/package/' + jobId + '/download');
  ok('an unauthenticated request is refused', anon.status === 401 || anon.status === 403,
     String(anon.status));

  const dl = await request('GET', '/api/export/package/' + jobId + '/download', undefined, as('admin'));
  ok('admin downloads the archive', dl.status === 200, String(dl.status));
  ok('it is served as an attachment',
     /attachment;/.test(dl.headers['content-disposition'] || ''), dl.headers['content-disposition']);
  ok('the filename is in the disposition',
     /KD-Export_/.test(dl.headers['content-disposition'] || ''));
  ok('it is not cacheable', /no-store/.test(dl.headers['cache-control'] || ''),
     dl.headers['cache-control']);
  ok('the content type is zip', /zip/.test(dl.headers['content-type'] || ''),
     dl.headers['content-type']);

  const unknown = await request('GET', '/api/export/package/does-not-exist', undefined, as('admin'));
  ok('an unknown job is 404, not 500', unknown.status === 404, String(unknown.status));

  /* ── Attachments: the files the browser generates ── */
  console.log('\nAttachments — the browser-made reports');
  console.log('-'.repeat(38));

  const attach = (role, name, payload, extraHeaders) => rawUpload(PORT, {
    cookie: C[role], name, payload, headers: extraHeaders,
  });

  const mgrAtt = await attach('manager', 'sneaky.xlsx', Buffer.from('nope'));
  ok('manager cannot upload an attachment', mgrAtt.status === 403, String(mgrAtt.status));

  const a1 = await attach('admin', 'DAM 2026.xlsx', Buffer.from('fake-xlsx-bytes'));
  const a2 = await attach('admin', 'DAM 2026.xlsx', Buffer.from('a-second-file'));
  const a3 = await attach('admin', '../../etc/passwd', Buffer.from('traversal'));
  ok('admin can upload an attachment', a1.status === 200 && a1.body.id, String(a1.status));
  ok('the stored name is sanitised', a3.body && a3.body.name === 'etc-passwd' ||
     (a3.body && !/[\\/]/.test(a3.body.name)), a3.body && a3.body.name);

  const empty = await attach('admin', 'nothing.txt', Buffer.alloc(0));
  ok('an empty upload is refused', empty.status === 400, String(empty.status));

  ok('another account cannot claim an upload',
     pkg.claimAttachments([a1.body.id], 'someone-else').length === 0);

  /* Uploading without ever building must not be a way to fill the disk before
   * the hourly sweep notices. */
  let capped = null;
  for (let i = 0; i < pkg.MAX_STAGED_PER_USER + 4 && !capped; i++) {
    const r = await attach('admin', 'filler' + i + '.bin', Buffer.from('x'));
    if (r.status !== 200) capped = r;
  }
  ok('unclaimed uploads are capped per account',
     capped && capped.body && capped.body.error === 'too-many-attachments',
     capped ? capped.status + ' ' + JSON.stringify(capped.body) : 'never refused');
  pkg.sweepStaging(Date.now() + pkg.STAGING_TTL_MS + 1000);   // clear the fillers
  // The two real attachments were swept with them, so re-upload for the build.
  const b1 = await attach('admin', 'DAM 2026.xlsx', Buffer.from('fake-xlsx-bytes'));
  const b2 = await attach('admin', 'DAM 2026.xlsx', Buffer.from('a-second-file'));
  // An upload named after one of data/'s own files must not displace it.
  const b3 = await attach('admin', 'summary.csv', Buffer.from('an-impostor'));
  a1.body.id = b1.body.id;
  a2.body.id = b2.body.id;
  const a4 = b3;

  const withAtt = await request('POST', '/api/export/package',
    { uids: [uid], scope: 'picked', attachments: [a1.body.id, a2.body.id, a4.body.id, 'not-a-real-id'] },
    as('admin'));
  ok('a build accepts attachments', withAtt.status === 200, String(withAtt.status));

  let j2 = withAtt.body.job;
  for (let i = 0; i < 200 && j2.state === 'running'; i++) {
    await wait(100);
    const r = await request('GET', '/api/export/package/' + j2.id, undefined, as('admin'));
    j2 = (r.body && r.body.job) || j2;
  }
  ok('the build with attachments finishes', j2.state === 'done', j2.error || j2.state);
  ok('every real attachment went in, the bogus id did not', j2.reports === 3, String(j2.reports));

  const built2 = pkg.fileFor(j2.id, U.admin) || pkg.fileFor(j2.id, null);
  const r3 = new zip.ZipReader(built2.path);
  const n3 = r3.entries.map(e => e.name);
  const ROOT2 = n3[0].split('/')[0];
  ok('the archive with reports also has ONE root',
     new Set(n3.map(n => n.split('/')[0])).size === 1,
     [...new Set(n3.map(n => n.split('/')[0]))].join(' | '));
  ok('the reports go into data/',
     n3.filter(n => /\/data\/DAM-2026/.test(n)).length === 2,
     n3.filter(n => /\/data\//.test(n)).join(' | '));
  ok('an upload cannot displace the real summary.csv',
     r3.readFile(ROOT2 + '/data/summary.csv').toString('utf8').includes('Worker ID') &&
     n3.some(n => n.endsWith('/data/summary-2.csv')),
     n3.filter(n => /summary/.test(n)).join(' | '));
  ok('a duplicate filename is renamed, not overwritten',
     n3.some(n => n.endsWith('/data/DAM-2026.xlsx')) &&
     n3.some(n => n.endsWith('/data/DAM-2026-2.xlsx')),
     n3.filter(n => /\/data\//.test(n)).join(' | '));
  ok('the attached bytes survived intact',
     r3.readFile(ROOT2 + '/data/DAM-2026.xlsx').toString() === 'fake-xlsx-bytes');
  ok('the manifest mentions the reports',
     /Reports\s*: 3 in data\//.test(r3.readFile(ROOT2 + '/data/manifest.txt').toString('utf8')));
  ok('the worker folders are still there', n3.some(n => /\/Http-Tester_KD-H-001_/.test(n)));
  r3.close();

  const staged = () => { try { return fs.readdirSync(pkg.STAGING_DIR); } catch (e) { return []; } };
  // Both uploads went into the archive, so neither should still be on disk —
  // otherwise every export would leave a second copy of its reports behind,
  // outside the 24-hour retention that covers the package itself.
  ok('consumed uploads are deleted once they are in the archive',
     staged().length === 0, staged().join(','));

  /* An upload nobody claims is still a copy of a report sitting on disk. It has
   * to age out on its own, or an export abandoned half-way would leave one
   * there indefinitely. */
  await attach('admin', 'abandoned.xlsx', Buffer.from('never-used'));
  const before = staged().length;
  pkg.sweepStaging(Date.now() + pkg.STAGING_TTL_MS + 1000);
  ok('abandoned uploads age out', before === 1 && staged().length === 0,
     'before=' + before + ' after=' + staged().join(','));

  try { fs.unlinkSync(built2.path); } catch (e) {}

  /* ── The trail ── */
  const log = repo.getAuthLog({ limit: 200 }).map(r => r.action + '|' + (r.reason || ''));
  ok('starting the build is recorded as DATA_EXPORT',
     log.some(l => /^DATA_EXPORT\|.*format=package/.test(l)),
     log.filter(l => l.startsWith('DATA_EXPORT')).slice(0, 2).join(' // '));
  ok('the record names how many workers',
     log.some(l => /^DATA_EXPORT\|.*format=package.*records=1/.test(l)));
  ok('the download is its own event',
     log.some(l => l.startsWith('EXPORT_PACKAGE_DOWNLOAD')),
     log.slice(0, 3).join(' // '));
  ok('the refusals are recorded',
     log.some(l => /^PERMISSION_DENIED\|.*export\.package/.test(l)),
     log.filter(l => l.startsWith('PERMISSION_DENIED')).slice(0, 2).join(' // '));

  repo.deleteGroup(gid);
}
