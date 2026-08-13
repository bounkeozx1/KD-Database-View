'use strict';
/**
 * infra/scripts/test-pptx-account.js — detected must equal accounted.
 *
 *   node infra/scripts/test-pptx-account.js [folder-of-pptx]
 *
 * The rule this suite exists to enforce: an import may not report success
 * while a picture in the file is unaccounted for. The earlier importer
 * classified what it recognised and dropped the rest, which is how a deck can
 * come in "successfully" with a worker's photograph still sitting unused
 * inside it — silent, and found weeks later by someone printing cards.
 *
 * So the four things checked here are the four ways that guarantee breaks:
 *
 *   a picture is DROPPED           detection discards something it cannot read
 *   a picture is DOUBLE-COUNTED    one file on two slides collapses into one
 *   two pictures are CONFUSED      0.461 and 0.563 are close and mean opposites
 *   a picture is UNREADABLE        an SVG has no pixel size to measure
 *
 * Fixed cases first, then — when the real decks are on this machine — every
 * picture in all of them. The decks are live worker records and are not in the
 * repository, so that half skips rather than fails when they are absent.
 */
const fs   = require('node:fs');
const path = require('node:path');

const IMG = require('../../domains/recruitment/intake-import/pptx-images.js');
const { openZip, readSlides, mediaFiles } = require('./_testzip.js');
const { imageDims } = require('../../domains/recruitment/intake-import/pptx-import.js');

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail) => {
  if (cond === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};
const section = t => { console.log('\n' + t); console.log('-'.repeat(t.length)); };

/* Build a slide's XML the way PowerPoint does, so detection is exercised
   against the real shape rather than a convenient one. */
const EMU = 914400;
function picXml(rid, wIn, hIn) {
  return '<p:pic><p:nvPicPr><p:cNvPr id="1" name="Picture"/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + rid + '"/></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="0" y="0"/>' +
    '<a:ext cx="' + Math.round(wIn * EMU) + '" cy="' + Math.round(hIn * EMU) + '"/>' +
    '</a:xfrm></p:spPr></p:pic>';
}
function relsXml(pairs) {
  return '<Relationships>' + pairs.map(([id, t]) =>
    '<Relationship Id="' + id + '" Target="' + t + '"/>').join('') + '</Relationships>';
}

/* ══════════════════════════════════════════════════════════════════
 * 1 — detection never discards
 * ══════════════════════════════════════════════════════════════════ */
section('detection');
{
  const slides = [{
    index: 1,
    xml: picXml('rId2', 3.6, 4.4) + picXml('rId3', 1.3, 2.3) + picXml('rId9', 1.9, 1.9),
    rels: relsXml([['rId2', '../media/a.jpeg'], ['rId3', '../media/b.jpeg']]),   // rId9 missing
  }];
  const u = IMG.detectUsages(slides);
  ok('every <p:pic> is detected, including the one with a broken link',
     u.length === 3, String(u.length));
  ok('each gets a unique id', new Set(u.map(x => x.id)).size === 3);
  ok('each records its slide', u.every(x => x.slide === 1));
  ok('the broken one is detected with no media rather than skipped',
     u[2].media === '' && u[2].rid === 'rId9', JSON.stringify(u[2]));
  ok('box geometry is recorded', Math.abs(u[0].boxRatio - (3.6 / 4.4)) < 0.001);

  /* An image used as a background or a table fill is a real reference and is
     counted — otherwise the file's total and the app's total disagree. */
  const withFill = IMG.detectUsages([{
    index: 1,
    xml: picXml('rId2', 3.6, 4.4) + '<p:bg><a:blip r:embed="rId7"/></p:bg>',
    rels: relsXml([['rId2', '../media/a.jpeg'], ['rId7', '../media/bg.png']]),
  }]);
  ok('an image fill outside <p:pic> is detected too', withFill.length === 2, String(withFill.length));
  ok('and is marked as a fill, not a picture',
     withFill[1].source === 'blip', withFill[1].source);
  ok('a <p:pic> is not double-counted by its own blip',
     withFill.filter(x => x.source === 'pic').length === 1);
}

/* ══════════════════════════════════════════════════════════════════
 * 2 — one file, two slides, two usages
 * ══════════════════════════════════════════════════════════════════ */
section('duplicates');
{
  const shared = '../media/couple.jpeg';
  const slides = [1, 2].map(i => ({
    index: i, xml: picXml('rId2', 3.6, 4.4), rels: relsXml([['rId2', shared]]),
  }));
  const u = IMG.detectUsages(slides);
  ok('the same file on two slides is two usages', u.length === 2, String(u.length));
  ok('both point at one file',
     u[0].media === 'ppt/media/couple.jpeg' && u[1].media === u[0].media);
  ok('their slides are kept apart', u[0].slide === 1 && u[1].slide === 2);

  u.forEach(x => { x.fileRatio = 0.75; });
  IMG.classifyUsages(u, { slideCount: 2, mediaUse: { 'ppt/media/couple.jpeg': 2 } });
  const man = IMG.buildManifest(u, ['ppt/media/couple.jpeg']);
  ok('both usages are accounted', man.accounted === 2 && man.detected === 2);
  ok('the shared file is not an orphan', man.orphans.length === 0);
  ok('a marriage is not mistaken for furniture — 2 of 2 slides stays PERSON',
     u.every(x => x.class === 'PERSON'), u.map(x => x.class).join(','));
}

/* ══════════════════════════════════════════════════════════════════
 * 3 — ratios that sit close together and mean opposite things
 * ══════════════════════════════════════════════════════════════════ */
section('classification');
{
  const mk = (media, ratio, bw, bh) => ({
    id: media, slide: 1, media, source: 'pic',
    boxW: (bw || 3) * EMU, boxH: (bh || 4) * EMU, boxRatio: (bw || 3) / (bh || 4),
    fileRatio: ratio,
  });

  const set = [
    mk('ppt/media/fb.jpeg', 738 / 1600),      // 0.461
    mk('ppt/media/thin.jpeg', 900 / 1600),    // 0.563 — 0.10 away, and a person
    mk('ppt/media/me.jpeg', 1200 / 1600),     // 0.750
    mk('ppt/media/logo.png', 1),              // 1.000
    mk('ppt/media/banner.jpeg', 3),           // landscape
  ];
  IMG.classifyUsages(set, { slideCount: 40, mediaUse: {} });
  const cls = {}; set.forEach(u => { cls[u.media] = u.class; });
  ok('0.461 is a Facebook screenshot', cls['ppt/media/fb.jpeg'] === 'FACEBOOK', cls['ppt/media/fb.jpeg']);
  ok('0.563 is a person, not a screenshot', cls['ppt/media/thin.jpeg'] === 'PERSON', cls['ppt/media/thin.jpeg']);
  ok('0.750 is a person', cls['ppt/media/me.jpeg'] === 'PERSON');
  ok('square is a logo', cls['ppt/media/logo.png'] === 'LOGO');
  ok('landscape is OTHER, not a person', cls['ppt/media/banner.jpeg'] === 'OTHER');
  ok('confidence is recorded for audit', set.every(u => typeof u.confidence === 'number'));

  /* Confidence is distance from the decision boundary, so a file sitting on
     the line must score lower than one at the centre of its class. This is
     what makes the review queue orderable — the doubtful ones first. */
  const edge = [mk('ppt/media/edge.jpeg', 0.515)];   // 0.005 from the 0.52 line
  IMG.classifyUsages(edge, { slideCount: 40, mediaUse: {} });
  ok('a file on the boundary is classified anyway', edge[0].class === 'FACEBOOK', edge[0].class);
  ok('but with markedly less confidence than a typical one',
     edge[0].confidence < set[0].confidence,
     edge[0].confidence + ' vs ' + set[0].confidence);

  // Repetition beats shape: a photograph-shaped file on most slides is furniture.
  const rep = [mk('ppt/media/frame.jpeg', 0.75)];
  IMG.classifyUsages(rep, { slideCount: 40, mediaUse: { 'ppt/media/frame.jpeg': 38 } });
  ok('a file used on 38 of 40 slides is a logo whatever its shape',
     rep[0].class === 'LOGO', rep[0].class);

  // Two people on one slide: both PERSON, one flagged as the profile photo.
  const pair = [mk('ppt/media/big.jpeg', 0.75, 3.6, 4.4), mk('ppt/media/small.jpeg', 0.75, 1.9, 4.4)];
  IMG.classifyUsages(pair, { slideCount: 40, mediaUse: {} });
  ok('two photographs on a slide are both PERSON',
     pair.every(u => u.class === 'PERSON'));
  ok('and exactly one is marked the profile photo',
     pair.filter(u => u.primary).length === 1);
  ok('the one with the most room wins', pair.find(u => u.primary).media === 'ppt/media/big.jpeg');
}

/* ══════════════════════════════════════════════════════════════════
 * 4 — unreadable is a label, not a loss
 * ══════════════════════════════════════════════════════════════════ */
section('unreadable files');
{
  const u = [
    { id: 'u1', slide: 1, media: 'ppt/media/icon.svg', source: 'pic', boxW: 1, boxH: 1, boxRatio: 1 },
    { id: 'u2', slide: 1, media: '', source: 'pic', boxW: 1, boxH: 1, boxRatio: 1 },
  ];
  IMG.classifyUsages(u, { slideCount: 40, mediaUse: {} });
  ok('an SVG with no pixel size is UNKNOWN', u[0].class === 'UNKNOWN', u[0].class);
  ok('and says why', /pixel size/.test(u[0].why || ''), u[0].why);
  ok('a broken reference is UNKNOWN', u[1].class === 'UNKNOWN', u[1].class);
  const man = IMG.buildManifest(u, []);
  ok('UNKNOWN still counts as accounted', man.accounted === 2 && man.complete === true);
  ok('nothing is silently dropped', man.detected === 2);
  ok('imageDims returns null rather than guessing on an SVG',
     imageDims(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) === null);
}

/* ══════════════════════════════════════════════════════════════════
 * 5 — orphans are counted, and counted separately
 * ══════════════════════════════════════════════════════════════════ */
section('orphans and the invariant');
{
  const u = [{ id: 'u1', slide: 1, media: 'ppt/media/a.jpeg', source: 'pic', boxW: 3, boxH: 4, boxRatio: 0.75, fileRatio: 0.75 }];
  IMG.classifyUsages(u, { slideCount: 40, mediaUse: {} });
  const man = IMG.buildManifest(u, ['ppt/media/a.jpeg', 'ppt/media/never-used.png']);
  ok('a file no slide references is an orphan', man.orphans.length === 1, JSON.stringify(man.orphans));
  ok('and does NOT inflate the usage total', man.detected === 1 && man.accounted === 1);
  ok('the manifest still reports how many files the deck holds', man.mediaFiles === 2);

  ok('a sound manifest verifies clean', IMG.verifyManifest(man).length === 0);

  // Corrupt it the way a future edit might, and the check must notice.
  const bad = JSON.parse(JSON.stringify(man));
  delete bad.usages[0].class;
  ok('an unlabelled usage is caught', IMG.verifyManifest(bad).length > 0,
     JSON.stringify(IMG.verifyManifest(bad)));
  const miscount = JSON.parse(JSON.stringify(man));
  miscount.accounted = 0;
  ok('a total that does not add up is caught',
     IMG.verifyManifest(miscount).some(p => /detected/.test(p)));
  const dup = JSON.parse(JSON.stringify(man));
  dup.usages.push(JSON.parse(JSON.stringify(dup.usages[0])));
  dup.detected = dup.accounted = 2;
  ok('a repeated usage id is caught', IMG.verifyManifest(dup).some(p => /duplicate/.test(p)));
}

/* ══════════════════════════════════════════════════════════════════
 * 6 — the real decks
 * ══════════════════════════════════════════════════════════════════ */
section('the real decks');
const DECKS = process.argv[2] ||
  path.join(process.env.USERPROFILE || process.env.HOME || '',
            'Downloads', 'KD EMPLOYMENT CO., LTD', 'Data KD', '02 PRESENTATIONS');

let files = [];
try {
  files = fs.readdirSync(DECKS).filter(f => /\.pptx$/i.test(f) && !/^~\$/.test(f));
} catch (e) { files = []; }

if (!files.length) {
  skip++;
  console.log('  skip  no decks at ' + DECKS);
} else {
  const total = { detected: 0, accounted: 0, orphans: 0 };
  const classTotal = {};
  IMG.CLASSES.forEach(c => { classTotal[c] = 0; });

  files.forEach(f => {
    let zip;
    try { zip = openZip(fs.readFileSync(path.join(DECKS, f))); }
    catch (e) { ok(f + ' — opens', false, e.message); return; }

    const slides = readSlides(zip);
    const media = mediaFiles(zip);
    const usages = IMG.detectUsages(slides);

    const mediaUse = {}, dims = {};
    usages.forEach(u => { if (u.media) mediaUse[u.media] = (mediaUse[u.media] || 0) + 1; });
    Object.keys(mediaUse).forEach(m => {
      if (dims[m] === undefined) dims[m] = zip.has(m) ? imageDims(zip.read(m)) : null;
    });
    usages.forEach(u => {
      const d = dims[u.media];
      if (d && d.w && d.h) { u.fileW = d.w; u.fileH = d.h; u.fileRatio = d.w / d.h; }
    });

    IMG.classifyUsages(usages, { slideCount: slides.length, mediaUse });
    const man = IMG.buildManifest(usages, media);
    const problems = IMG.verifyManifest(man);

    total.detected += man.detected; total.accounted += man.accounted; total.orphans += man.orphans.length;
    IMG.CLASSES.forEach(c => { classTotal[c] += man.counts[c]; });

    console.log('  ' + f.slice(0, 34).padEnd(36) +
      man.detected + ' detected · ' + man.accounted + ' accounted · ' +
      IMG.CLASSES.map(c => c[0] + man.counts[c]).join(' ') +
      ' · orphan ' + man.orphans.length);
    ok(f.slice(0, 30) + ' — detected === accounted', man.complete === true,
       man.detected + ' vs ' + man.accounted);
    ok(f.slice(0, 30) + ' — manifest verifies', problems.length === 0, problems.join('; '));
  });

  ok('every picture in every deck is accounted for',
     total.detected === total.accounted && total.detected > 0,
     total.detected + ' vs ' + total.accounted);
  ok('nothing landed outside the five classes',
     IMG.CLASSES.reduce((n, c) => n + classTotal[c], 0) === total.detected);

  console.log('\n  Detected: ' + total.detected);
  IMG.CLASSES.forEach(c => console.log('  ' + c + ': ' + classTotal[c]));
  console.log('  Accounted: ' + total.accounted + '/' + total.detected +
              (total.detected === total.accounted ? '  OK' : '  INCOMPLETE'));
  console.log('  orphan files (counted separately): ' + total.orphans);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);
