'use strict';
/**
 * infra/scripts/test-pptx-pics.js — telling a worker's photo from the furniture.
 *
 *   node infra/scripts/test-pptx-pics.js [folder-of-pptx]
 *
 * The PPTX importer read ppt/slides/slideN.xml and nothing else, so every
 * photograph in every deck was dropped — 150 images in one real file. Pulling
 * them in is easy. Knowing WHICH image is the person is the whole problem: a
 * worker slide carries the person, a screenshot of their Facebook page, and a
 * company logo, and they arrive in no particular order.
 *
 * Measured across the real decks:
 *
 *   the worker        aspect 0.78–0.81   one slide
 *   a Facebook shot   aspect 0.54–0.57   one slide
 *   the company logo  aspect 1.03        EVERY slide, same file
 *
 * The classifier keys on aspect ratio and on repetition, never on position,
 * because the slide layout is expected to change and the shape of a phone
 * screenshot is not. This suite pins that down against fixed cases, and then —
 * if the real decks are on this machine — against every slide in them.
 *
 * The decks are not in the repository (they are live worker records), so the
 * corpus half is skipped wherever they are absent rather than failing the run.
 * Nothing here opens the database or starts a server, and no image is written
 * to disk.
 */
const fs   = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { _relMap, _slidePics, classifySlidePics, imageDims } =
  require('../../domains/recruitment/intake-import/pptx-import.js');

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, detail) => {
  if (cond === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};
const section = t => { console.log('\n' + t); console.log('-'.repeat(t.length)); };

/* ══════════════════════════════════════════════════════════════════
 * A minimal zip reader — enough to pull one entry out of a .pptx
 * ══════════════════════════════════════════════════════════════════
 * Zero dependencies here as everywhere else, and the browser's JSZip is not
 * available in Node. Only stored (0) and deflated (8) entries exist in a pptx.
 */
function readZip(buf) {
  const files = {};
  // End of central directory, scanning back from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method  = buf.readUInt16LE(p + 10);
    const csize   = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen= buf.readUInt16LE(p + 30);
    const cmtLen  = buf.readUInt16LE(p + 32);
    const lho     = buf.readUInt32LE(p + 42);
    const name    = buf.toString('utf8', p + 46, p + 46 + nameLen);
    files[name] = { method, csize, lho };
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return {
    names: Object.keys(files),
    has: n => !!files[n],
    read(n) {
      const f = files[n];
      if (!f) return null;
      const ln = buf.readUInt16LE(f.lho + 26), le = buf.readUInt16LE(f.lho + 28);
      const start = f.lho + 30 + ln + le;
      const raw = buf.slice(start, start + f.csize);
      return f.method === 0 ? raw : zlib.inflateRawSync(raw);
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 1 — the rules, on fixed cases
 * ══════════════════════════════════════════════════════════════════ */
section('classification rules');
{
  const EMU = 914400;
  /* box inches + the FILE pixel size, because the file is what decides. */
  const pic = (media, bw, bh, iw, ih) => ({
    media, w: bw * EMU, h: bh * EMU, ratio: bw / bh,
    iw, ih, iratio: iw && ih ? iw / ih : undefined,
  });
  const WORKER = [1200, 1600];   // 0.750
  const PHONE  = [738, 1600];    // 0.461
  const LOGO   = [384, 384];     // 1.000

  // Slide 9, verbatim: the screenshot comes FIRST in the XML.
  const logo  = pic('ppt/media/image3.png', 1.91, 1.85, ...LOGO);
  const slide = [
    pic('ppt/media/fb.jpeg', 1.24, 2.33, ...PHONE),
    pic('ppt/media/me.jpeg', 3.59, 4.42, ...WORKER),
    logo,
  ];
  const use = { 'ppt/media/image3.png': 40 };

  const r = classifySlidePics(slide, use, 40);
  ok('the worker is found, though the screenshot came first', r.photo === 'ppt/media/me.jpeg', String(r.photo));
  ok('the phone-shaped file is the Facebook shot', r.facebook === 'ppt/media/fb.jpeg', String(r.facebook));
  ok('the repeated file is dropped as furniture',
     r.skipped.some(s => s.media === 'ppt/media/image3.png'), JSON.stringify(r.skipped));

  const r2 = classifySlidePics(slide.slice().reverse(), use, 40);
  ok('reversing the order changes nothing', r2.photo === r.photo && r2.facebook === r.facebook);

  const r3 = classifySlidePics([pic('ppt/media/me2.jpeg', 3.47, 4.44, ...WORKER), logo], use, 40);
  ok('a slide with no screenshot still finds the worker', r3.photo === 'ppt/media/me2.jpeg');
  ok('and reports none rather than inventing one', r3.facebook === null, String(r3.facebook));

  const tiny = classifySlidePics([pic('ppt/media/me3.jpeg', 3.5, 4.4, ...WORKER)], { 'ppt/media/me3.jpeg': 2 }, 3);
  ok('a tiny deck does not lose its photo to the repetition rule', tiny.photo === 'ppt/media/me3.jpeg');

  const odd = classifySlidePics([pic('ppt/media/wide.jpeg', 6, 2, 1800, 600)], {}, 40);
  ok('a landscape image is nobody\'s portrait', odd.photo === null && odd.facebook === null);
  ok('and it is reported, not silently dropped', odd.skipped.length >= 1, JSON.stringify(odd.skipped));

  /* DAMYANG slide 58 verbatim — the case that broke both earlier attempts.
     Two photographs squeezed into 0.43 and 0.40 boxes, which is the shape of
     a phone screenshot; the FILES are 1200x1600 and say otherwise. */
  const twoUp = classifySlidePics([
    pic('ppt/media/image93.jpeg', 1.91, 4.42, ...WORKER),
    pic('ppt/media/image94.jpeg', 1.77, 4.44, ...WORKER),
    pic('ppt/media/image95.jpeg', 1.29, 2.28, ...PHONE),
  ], {}, 97);
  ok('a photograph in a screenshot-shaped box is still a photograph',
     twoUp.photo === 'ppt/media/image93.jpeg', String(twoUp.photo));
  ok('and the real screenshot is still found',
     twoUp.facebook === 'ppt/media/image95.jpeg', String(twoUp.facebook));
  ok('the second photograph is reported, not silently used',
     twoUp.skipped.some(s => s.media === 'ppt/media/image94.jpeg'), JSON.stringify(twoUp.skipped));

  /* GANGHWA slide 7: two photographs (900x1600 = 0.563) and no screenshot.
     0.563 sits close to the 0.52 line, which is exactly why the line is drawn
     from the files rather than from the boxes. */
  const noFb = classifySlidePics([
    pic('ppt/media/image7.jpeg', 2.57, 4.59, 900, 1600),
    pic('ppt/media/image8.jpeg', 2.08, 4.47, 900, 1600),
    logo,
  ], use, 42);
  ok('two photographs and no screenshot yields a photo and no facebook',
     noFb.photo === 'ppt/media/image7.jpeg' && noFb.facebook === null,
     noFb.photo + ' / ' + noFb.facebook);
}

section('rels parsing');
{
  const rels = '<?xml version="1.0"?><Relationships>' +
    '<Relationship Id="rId2" Type="…/image" Target="../media/image13.jpeg"/>' +
    '<Relationship Id="rId3" Type="…/slideLayout" Target="../slideLayouts/slideLayout2.xml"/>' +
    '</Relationships>';
  const m = _relMap(rels);
  ok('a media target resolves to a zip path', m.rId2 === 'ppt/media/image13.jpeg', m.rId2);
  ok('every relationship is mapped, not only images', !!m.rId3);
  ok('an absent rels file is not a crash', Object.keys(_relMap('')).length === 0);
}

section('geometry from slide XML');
{
  const xml = '<p:sld><p:pic><p:nvPicPr><p:cNvPr name="Picture 5"/></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rId2"/></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="7509164" y="243840"/><a:ext cx="3291840" cy="4014788"/></a:xfrm></p:spPr>' +
    '</p:pic></p:sld>';
  const rels = '<Relationship Id="rId2" Target="../media/image13.jpeg"/>';
  const pics = _slidePics(xml, rels);
  ok('one picture is found', pics.length === 1, String(pics.length));
  ok('its media path is resolved', pics[0] && pics[0].media === 'ppt/media/image13.jpeg');
  ok('its aspect ratio is computed', pics[0] && Math.abs(pics[0].ratio - 0.82) < 0.01, pics[0] && pics[0].ratio);
  ok('a picture with no size is ignored, not half-read',
     _slidePics('<p:pic><a:blip r:embed="rId2"/></p:pic>', rels).length === 0);
}

/* ══════════════════════════════════════════════════════════════════
 * 2 — the real decks, if they are on this machine
 * ══════════════════════════════════════════════════════════════════ */
section('the real decks');
const DECKS = process.argv[2] ||
  path.join(process.env.USERPROFILE || process.env.HOME || '',
            'Downloads', 'KD EMPLOYMENT CO., LTD', 'Data KD', '02 PRESENTATIONS');

let files = [];
// `~$name.pptx` is PowerPoint's lock file for a deck someone has open. It is
// not a zip and never was — reading it as one is a false alarm, not a finding.
try {
  files = fs.readdirSync(DECKS).filter(f => /\.pptx$/i.test(f) && !/^~\$/.test(f));
} catch (e) { files = []; }

if (!files.length) {
  skip++;
  console.log('  skip  no decks at ' + DECKS);
  console.log('        (they are live worker records and are not in the repo)');
} else {
  let totalSlides = 0, withPhoto = 0, withFb = 0, unmatched = 0, logosDropped = 0;
  files.forEach(f => {
    const buf = fs.readFileSync(path.join(DECKS, f));
    let zip; try { zip = readZip(buf); } catch (e) { ok(f + ' — readable', false, e.message); return; }
    const slideNames = zip.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));

    const per = [], use = {}, fingerprint = [], dimCache = {};
    slideNames.forEach(n => {
      const xml = zip.read(n).toString('utf8');
      const rn = n.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
      const rels = zip.has(rn) ? zip.read(rn).toString('utf8') : '';
      const pics = _slidePics(xml, rels);
      /* Same measurement the importer makes: the image file's own pixel
         ratio, which is what separates a person from a screenshot. */
      pics.forEach(p => {
        use[p.media] = (use[p.media] || 0) + 1;
        if (dimCache[p.media] === undefined) {
          dimCache[p.media] = zip.has(p.media) ? imageDims(zip.read(p.media)) : null;
        }
        const d = dimCache[p.media];
        if (d && d.w && d.h) { p.iw = d.w; p.ih = d.h; p.iratio = d.w / d.h; }
      });
      per.push(pics);
      /* Identity is the PERSON, not the slide. These decks are edited by hand
         and the same worker often appears twice — sometimes byte-identical,
         sometimes re-typed with a correction — so comparing whole slides was
         not enough: SACHEON has KEOTHONGDY SENGDAO on two slides that differ.
         The name is what makes them one record. */
      const texts = (xml.match(/<a:t>[^<]*<\/a:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '').trim());
      const id   = texts.find(t => /[A-Z]{1,5}\/\s*DY\d{4}/i.test(t));
      const name = texts.find(t => /^[A-Z][A-Z\s]{4,}$/.test(t));
      fingerprint.push((id || name || texts.join('')).replace(/\s+/g, ' ').trim());
    });

    let photos = 0, fbs = 0, none = 0, logos = 0;
    per.forEach(pics => {
      if (!pics.length) return;
      const r = classifySlidePics(pics, use, per.length);
      if (r.photo) photos++;
      if (r.facebook) fbs++;
      if (!r.photo) none++;
      logos += r.skipped.filter(s => /repeated/.test(s.why)).length;
    });
    totalSlides += per.length; withPhoto += photos; withFb += fbs; unmatched += none; logosDropped += logos;

    console.log('  ' + f.slice(0, 44).padEnd(46) +
      per.length + ' slides · ' + photos + ' photos · ' + fbs + ' fb · ' + logos + ' logos dropped');

    // Every photo it picks must be a real entry in the zip.
    let bad = 0;
    const asPhoto = {};
    per.forEach((pics, i) => {
      if (!pics.length) return;
      const r = classifySlidePics(pics, use, per.length);
      [r.photo, r.facebook].forEach(m => { if (m && !zip.has(m)) bad++; });
      if (r.photo) (asPhoto[r.photo] = asPhoto[r.photo] || new Set()).add(fingerprint[i]);
    });
    ok(f.slice(0, 40) + ' — every chosen image exists in the file', bad === 0, bad + ' missing');

    /* The failure this classifier exists to prevent: one image — a logo, a
       letterhead — becoming the face on many records. Silent, survives the
       import, and only noticed once somebody exports the cards.

       The threshold is THREE, not two, and that was learned from the data
       rather than chosen. Four images in the 97-slide DAMYANG deck are each
       the photo for two workers; every one of them turned out to be legitimate:

         image2  slides 2, 3   PONGKANYA KEO OUDOME and VIMARA BANDITH —
                               a married couple, photographed together, both
                               badges legible in the frame
         image7  slides 4, 5   the same pattern
         image11 slides 7, 30  one worker whose slide appears twice
         image41 slides 22, 31 likewise

       So a pair sharing one photograph is not a bug to be fixed — it is the
       case the photo reference-counting in repo._releasePhoto was written for,
       arriving from the source deck instead of from the UI. Three or more
       records sharing a face is the shape a logo makes. */
    const shared = Object.entries(asPhoto).filter(([, set]) => set.size > 2);
    ok(f.slice(0, 40) + ' — no image became the face of three workers',
       shared.length === 0, shared.map(([m, set]) => m + ' ×' + set.size).join(', '));
  });

  ok('photos were found across the corpus', withPhoto > 0, String(withPhoto));
  ok('the logo never became a worker photo', logosDropped > 0,
     'no repeated media was dropped — the furniture test did not fire');
  ok('most slides with pictures yielded a photo',
     withPhoto > 0 && unmatched / (withPhoto + unmatched) < 0.25,
     unmatched + ' of ' + (withPhoto + unmatched) + ' had none');
  console.log('\n  corpus: ' + totalSlides + ' slides · ' + withPhoto + ' photos · ' +
              withFb + ' facebook · ' + unmatched + ' without a photo');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
process.exit(fail ? 1 : 0);
