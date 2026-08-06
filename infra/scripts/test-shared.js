'use strict';
/**
 * infra/scripts/test-shared.js — the rules both runtimes must apply identically.
 *
 *   node infra/scripts/test-shared.js
 *
 * There is no bundler here, so "shared" means a file the browser loads with a
 * <script> tag and Node loads with require(). That works, but only as long as
 * nobody quietly reintroduces a second copy — which is exactly what happened to
 * every one of these before they were extracted:
 *
 *   age        two formulas; they disagreed on birthdays (17 vs 18)
 *   csv        three hand-rolled quoters, two of them without a BOM
 *   safe-name  three character sets, so one worker could be filed two ways
 *   doc-cats   two copies of the default category list
 *
 * So this suite does two things: it exercises the modules, and it checks
 * STATICALLY that each side still calls into them rather than around them.
 *
 * Opens no database and starts no server.
 */
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};
const section = t => { console.log('\n' + t); console.log('-'.repeat(t.length)); };

const age      = require('../age');
const csv      = require('../csv');
const safeName = require('../safe-name');
const docCats  = require('../doc-cats');

/* ══════════════════════════════════════════════════════════════════
 * age
 * ══════════════════════════════════════════════════════════════════ */
section('age — whole years, by the calendar');
{
  const on = new Date('2026-08-03T12:00:00');
  const cases = [
    ['2008-08-02', 18, 'turned 18 yesterday'],
    ['2008-08-03', 18, 'turns 18 TODAY — the boundary the old formula got wrong'],
    ['2008-08-04', 17, 'turns 18 tomorrow'],
    ['2026-08-03',  0, 'born today'],
    ['1996-02-29', 30, 'leap-day birthday'],
  ];
  cases.forEach(([dob, want, label]) =>
    ok(label, age.age(dob, on) === want, 'got ' + age.age(dob, on) + ', want ' + want));

  [['', 'empty string'], [null, 'null'], [undefined, 'undefined'],
   ['not-a-date', 'garbage'], ['2030-01-01', 'a date in the future']].forEach(([v, label]) =>
    ok(label + " → '' (never 0)", age.age(v, on) === '', JSON.stringify(age.age(v, on))));

  /* The formula the browser used to carry, kept here as the thing that must not
   * come back: elapsed milliseconds over an average year. It reads a year low
   * on anniversaries because leap days do not arrive evenly. */
  const averaged = (dob, now) => Math.floor((now - new Date(dob)) / (365.25 * 864e5));
  let drift = 0;
  for (let y = 18; y <= 70; y++) {
    const d = new Date(on); d.setFullYear(on.getFullYear() - y);
    const s = d.toISOString().slice(0, 10);
    if (averaged(s, on) !== age.age(s, on)) drift++;
  }
  ok('the old averaged formula really did disagree (' + drift + ' exact birthdays)', drift > 0,
     'If this is 0 the regression it guards against is not being reproduced.');
}

/* ══════════════════════════════════════════════════════════════════
 * csv
 * ══════════════════════════════════════════════════════════════════ */
section('csv — quoting Excel and a spreadsheet both accept');
{
  ok('every cell is quoted', csv.cell('plain') === '"plain"');
  ok('inner quotes are doubled', csv.cell('say "hi"') === '"say ""hi"""');
  ok('a comma cannot split a cell', csv.cell('Keo, Somchai') === '"Keo, Somchai"');
  ok('a newline cannot split a row', csv.cell('line1\nline2') === '"line1\nline2"');
  ok('null → empty, not the text "null"', csv.cell(null) === '""');
  ok('undefined → empty', csv.cell(undefined) === '""');
  ok('0 survives as 0', csv.cell(0) === '"0"');
  ok('Lao text passes through', csv.cell('ນາງ ວິໄລ') === '"ນາງ ວິໄລ"');

  /* CSV injection: a field that arrived from a passport scan must not execute
   * when the export is opened. Only the audit log defended against this before. */
  ['=', '+', '-', '@'].forEach(ch =>
    ok('a cell starting ' + JSON.stringify(ch) + ' is neutralised',
       csv.cell(ch + 'cmd|calc') === '"\'' + ch + 'cmd|calc"', csv.cell(ch + 'cmd|calc')));
  ok('an ordinary value is left alone', csv.cell('Somchai') === '"Somchai"');
  ok('a negative number is neutralised too (correctness beats tidiness here)',
     csv.cell('-5').startsWith('"\''), csv.cell('-5'));

  const out = csv.build(['A', 'B'], [[1, 'x'], [2, 'y,z']]);
  ok('the file starts with a BOM (Excel reads UTF-8)', out.charCodeAt(0) === 0xFEFF);
  ok('rows are CRLF-separated', out.includes('"A","B"\r\n"1","x"\r\n"2","y,z"'), JSON.stringify(out));
  ok('the file ends with a newline', out.endsWith('\r\n'));
  ok('a trailer is appended verbatim', csv.build(['A'], [['1']], '# note').endsWith('# note'));
}

/* ══════════════════════════════════════════════════════════════════
 * safe-name
 * ══════════════════════════════════════════════════════════════════ */
section('safe-name — filesystem-safe without becoming unreadable');
{
  ok('Lao names survive (download)', safeName.download('ນາງ ວິໄລ', 'x') === 'ນາງ ວິໄລ',
     safeName.download('ນາງ ວິໄລ', 'x'));
  ok('Lao names survive (segment)', safeName.segment('ນາງ ວິໄລ', 'x') === 'ນາງ-ວິໄລ',
     safeName.segment('ນາງ ວິໄລ', 'x'));
  ok('Thai names survive', safeName.segment('สมชาย แก้ว', 'x') === 'สมชาย-แก้ว',
     safeName.segment('สมชาย แก้ว', 'x'));
  ok('Korean names survive', safeName.segment('조재희', 'x') === '조재희');

  ['\\', '/', ':', '*', '?', '"', '<', '>', '|'].forEach(ch =>
    ok('Windows rejects ' + JSON.stringify(ch) + ', so it is replaced',
       !safeName.segment('a' + ch + 'b', 'x').includes(ch)));
  ok('control characters are replaced', !/[\x00-\x1f]/.test(safeName.segment('ab', 'x')));

  ok('a reserved device name is escaped (segment)', safeName.segment('CON', 'x') === '_CON');
  ok('a reserved device name is escaped (download)', safeName.download('nul', 'x') === '_nul');
  ok('a name that is only punctuation falls back', safeName.segment('///', 'fallback') === 'fallback');
  ok('an empty name falls back', safeName.download('', 'fallback') === 'fallback');
  ok('a segment is capped', safeName.segment('x'.repeat(200), 'y').length === 80);

  // The basename, not a re-spelled path: nothing an uploader sends can climb out.
  ok('an upload can never be a path', safeName.upload('../../etc/passwd') === 'passwd',
     safeName.upload('../../etc/passwd'));
  ok('a Windows path is reduced the same way',
     safeName.upload('C:\\Windows\\system32\\evil.xlsx') === 'evil.xlsx',
     safeName.upload('C:\\Windows\\system32\\evil.xlsx'));
  ok('an upload keeps its extension', safeName.upload('DAM 2026.xlsx') === 'DAM-2026.xlsx',
     safeName.upload('DAM 2026.xlsx'));
  ok('an upload with no extension still works', safeName.upload('report') === 'report');

  /* The two shapes may differ in spacing — they are for different places — but
   * they must never disagree about which characters are DANGEROUS. */
  const nasty = 'a/b\\c:d*e?f"g<h>i|j';
  ok('both shapes strip the same dangerous characters',
     !/[\\/:*?"<>|]/.test(safeName.download(nasty, 'x')) &&
     !/[\\/:*?"<>|]/.test(safeName.segment(nasty, 'x')));
}

/* ══════════════════════════════════════════════════════════════════
 * doc-cats
 * ══════════════════════════════════════════════════════════════════ */
section('doc-cats — one default list');
{
  const d = docCats.defaults();
  ok('there are defaults', Array.isArray(d) && d.length > 0);
  ok('every entry has a key and a label', d.every(c => c.key && c.label));
  ok('keys are unique', new Set(d.map(c => c.key)).size === d.length);
  ok('keys are filesystem-safe (they become folder names in an export)',
     d.every(c => safeName.segment(c.key, '') === c.key), d.map(c => c.key).join(','));
  d[0].label = 'MUTATED';
  ok('defaults() hands out a copy, not the original',
     docCats.defaults()[0].label !== 'MUTATED');
}

/* ══════════════════════════════════════════════════════════════════
 * Static — nobody has a private copy any more
 * ══════════════════════════════════════════════════════════════════ */
section('static — both sides call in, not around');
{
  const html = read('shell/pages/index.html');
  ['age', 'csv', 'safe-name', 'doc-cats'].forEach(m =>
    ok('the browser loads infra/' + m + '.js', html.includes('infra/' + m + '.js')));

  const app = read('shell/scripts/app.js');
  const admin = read('shell/scripts/admin-center.js');
  const pkg = read('infra/export-package.js');
  const repo = read('infra/repo.js');

  ok('the browser has no second document-category list',
     !/_DEFAULT_DOC_CATS\s*=\s*\[/.test(app), 'app.js declares its own list again');
  ok('the server takes the category defaults from the shared module',
     /require\(['"]\.\/doc-cats['"]\)/.test(repo));

  ok('the browser has no second filename sanitiser',
     /function _safeFile\([^)]*\)\s*\{\s*return\s+KDSafeName\./.test(app),
     '_safeFile has its own character set again');
  ok('the server takes the archive sanitiser from the shared module',
     /require\(['"]\.\/safe-name['"]\)/.test(pkg));

  ok('the browser has no second export-permission table',
     !/_EXPORT_PERM\s*=\s*\{/.test(app), 'app.js transcribes the permission table again');
  ok('the server sends the export-permission table',
     /exportPermissions:\s*rbac\.EXPORT_FORMAT_PERMISSION/.test(read('shell/server.js')));

  /* One exit for generated files. A hand-rolled anchor download bypasses the
   * capture that puts a file inside an export package instead of the downloads
   * folder — it would silently go missing from the archive. */
  const urls = (app.match(/URL\.createObjectURL/g) || []).length;
  ok('app.js creates object URLs in exactly one place (' + urls + ')', urls === 1,
     'Every download must go through _emitExport().');
  ok('admin-center.js creates none',
     !/URL\.createObjectURL/.test(admin), 'It should call _emitExport() too.');

  /* Hand-rolled `"' + … + '"` quoting is how the three CSV builders drifted. */
  [['app.js', app], ['admin-center.js', admin], ['export-package.js', pkg]].forEach(([name, src]) =>
    ok(name + ' does not hand-roll CSV quoting',
       !/replace\(\/"\/g,\s*'""'\)/.test(src), 'Use KDCsv.cell / csv.cell.'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
