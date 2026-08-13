'use strict';
/**
 * pptx-images.js — every picture in a deck, counted and named.
 *
 * ══════════════════════════════════════════════════════════════════
 * The contract
 * ══════════════════════════════════════════════════════════════════
 * DETECTED === ACCOUNTED, or the import is not a success.
 *
 * The first version of this code classified pictures and quietly dropped
 * whatever it could not place. That is how an import reports "done" while a
 * worker's photograph is sitting unused inside the file — nothing errors,
 * nothing is logged, and the gap is found weeks later by someone printing
 * cards. So detection and classification are now two separate passes:
 *
 *   DETECTION finds every picture and gives it an id. It never judges and
 *   never discards. A picture whose bytes cannot be read is still detected.
 *
 *   CLASSIFICATION labels each one PERSON, FACEBOOK, LOGO, OTHER or UNKNOWN.
 *   UNKNOWN is a real answer — "this was seen and not identified" — not a
 *   failure, and it counts as accounted.
 *
 * Every detected usage carries exactly one label, so the two totals cannot
 * drift apart by construction; `verifyManifest` proves it rather than assuming
 * it, because the value of the guarantee is that it is checked.
 *
 * ══════════════════════════════════════════════════════════════════
 * What counts, and why
 * ══════════════════════════════════════════════════════════════════
 * A USAGE, not a file. One photograph used on two slides is two usages — that
 * is how married couples appear in these decks, and collapsing them would lose
 * the fact that a picture belongs to two people. Measured across six real
 * decks: 564 usages drawn from 399 files.
 *
 * Slides only. slideLayout and slideMaster are template furniture, not worker
 * data — and are empty in every deck measured.
 *
 * Files in ppt/media/ that no slide references are counted SEPARATELY as
 * orphans. They are real (six of them across the decks) and worth reporting,
 * but they are not image usages and must not inflate the total.
 *
 * ══════════════════════════════════════════════════════════════════
 * How a picture is identified
 * ══════════════════════════════════════════════════════════════════
 * By the image FILE's own pixel ratio. Not by where it sits, and not by the
 * shape of its box — the same 1200×1600 photograph is dragged into a 0.43 box
 * on one slide and a 0.82 box on another, and two earlier versions of this
 * code believed the box and got it wrong in both directions.
 *
 *     PERSON     0.750 (1200×1600) · 0.563 (900×1600)
 *     FACEBOOK   0.461 (738×1600) — every screenshot, in every deck
 *     LOGO       1.000 (384×384), and repeated across the deck
 *
 * Confidence is the distance from the nearest decision boundary, normalised.
 * It is for triage and for audit — it is never a substitute for a human
 * looking at the picture, which is what the review queue is for.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KDPptxImages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const CLASSES = ['PERSON', 'FACEBOOK', 'LOGO', 'OTHER', 'UNKNOWN'];

  /* The boundary between a screenshot and a person, and the one above which a
     picture is too wide to be either. Both sit in measured empty space. */
  const PHONE_MAX  = 0.52;   // 0.461 below it, 0.563 above it
  const PORTRAIT_MAX = 1.15; // wider than this is a banner or a form
  const SQUARE_TOL = 0.06;   // 1.000 ± this is a badge or a logo

  /** rel id → part path, from any _rels file. */
  function relMap(relsXml) {
    const map = {};
    if (!relsXml) return map;
    const re = /Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
    let m;
    while ((m = re.exec(relsXml)) !== null) {
      map[m[1]] = m[2].replace(/^\.\.\//, 'ppt/').replace(/^\//, '');
    }
    return map;
  }

  /**
   * DETECTION. Every picture on every slide, in order, with an id.
   *
   * @param slides [{ index, xml, rels }] — index is the 1-based slide number
   * @returns usages, each { id, slide, media, boxW, boxH, boxRatio, source }
   *
   * `source` records HOW it was found: 'pic' for a <p:pic>, 'blip' for an
   * image reference outside one (a background or a table-cell fill). Both are
   * detected; they are classified differently.
   */
  function detectUsages(slides) {
    const usages = [];
    (slides || []).forEach(s => {
      const rels = relMap(s.rels);
      const xml = s.xml || '';
      const picBlocks = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || [];

      picBlocks.forEach(b => {
        const rid = (b.match(/r:embed="(rId\d+)"/) || [])[1] || '';
        const ext = b.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
        const w = ext ? +ext[1] : 0, h = ext ? +ext[2] : 0;
        usages.push({
          id: 'u' + (usages.length + 1),
          slide: s.index,
          rid,
          media: rels[rid] || '',
          boxW: w, boxH: h,
          boxRatio: (w && h) ? w / h : 0,
          source: 'pic',
        });
      });

      /* Image references that are not <p:pic> — a slide background, a fill.
         Counted so the total is the whole truth about the file, and labelled
         OTHER because they are decoration rather than worker data. */
      const picRids = picBlocks.join('').match(/r:embed="(rId\d+)"/g) || [];
      const seen = {};
      picRids.forEach(r => { seen[r] = (seen[r] || 0) + 1; });
      const allRids = xml.match(/<a:blip[^>]*r:embed="rId\d+"/g) || [];
      allRids.forEach(tag => {
        const rid = (tag.match(/r:embed="(rId\d+)"/) || [])[1];
        const key = 'r:embed="' + rid + '"';
        if (seen[key]) { seen[key]--; return; }        // already counted as a pic
        usages.push({
          id: 'u' + (usages.length + 1),
          slide: s.index,
          rid,
          media: rels[rid] || '',
          boxW: 0, boxH: 0, boxRatio: 0,
          source: 'blip',
        });
      });
    });
    return usages;
  }

  /**
   * CLASSIFICATION. Exactly one label per usage — never a discard.
   *
   * @param usages    from detectUsages, ideally with fileW/fileH filled in
   * @param opts.slideCount   for the "repeated across the deck" test
   * @param opts.mediaUse     media path → number of usages of that file
   */
  function classifyUsages(usages, opts) {
    const o = opts || {};
    const slideCount = o.slideCount || 0;
    const mediaUse = o.mediaUse || {};

    // How many usages does the largest photo group on a slide get? Needed to
    // pick ONE portrait per slide as the profile photo; the rest stay PERSON.
    const bySlide = {};
    usages.forEach(u => { (bySlide[u.slide] = bySlide[u.slide] || []).push(u); });

    usages.forEach(u => {
      const r = u.fileRatio || 0;
      const uses = mediaUse[u.media] || 0;

      // No media at all: the reference is broken. Detected, and honestly named.
      if (!u.media) { label(u, 'UNKNOWN', 0, 'no media reference'); return; }

      // Not a <p:pic>: a background or a fill. Decoration, and known to be so.
      if (u.source === 'blip') { label(u, 'OTHER', 0.9, 'image fill, not a picture'); return; }

      // Repeated across most of the deck: furniture, whatever its shape.
      if (slideCount >= 5 && uses >= Math.max(3, slideCount * 0.4)) {
        label(u, 'LOGO', 0.95, 'used on ' + uses + ' of ' + slideCount + ' slides');
        return;
      }

      // Nothing measurable about the file: an SVG, or a header we cannot read.
      // Deliberately UNKNOWN and not guessed at — this is what review is for.
      if (!r) { label(u, 'UNKNOWN', 0, 'no readable pixel size'); return; }

      if (Math.abs(r - 1) <= SQUARE_TOL) {
        label(u, 'LOGO', 0.75, 'square (' + r.toFixed(3) + ')');
        return;
      }
      if (r > PORTRAIT_MAX) {
        label(u, 'OTHER', 0.8, 'landscape (' + r.toFixed(3) + ')');
        return;
      }
      if (r < PHONE_MAX) {
        label(u, 'FACEBOOK', conf(r, PHONE_MAX, 0.461), 'phone-shaped (' + r.toFixed(3) + ')');
        return;
      }
      label(u, 'PERSON', conf(r, PHONE_MAX, 0.750), 'portrait (' + r.toFixed(3) + ')');
    });

    /* One profile photo per slide: the PERSON given the most room. The others
       stay PERSON — they are people, and what to do with a second photograph
       is a decision for review, not for a parser. */
    Object.keys(bySlide).forEach(k => {
      const people = bySlide[k].filter(u => u.class === 'PERSON');
      people.sort((a, b) => (b.boxW * b.boxH) - (a.boxW * a.boxH));
      people.forEach((u, i) => { u.primary = (i === 0); });
      const phones = bySlide[k].filter(u => u.class === 'FACEBOOK');
      phones.sort((a, b) => (b.boxW * b.boxH) - (a.boxW * a.boxH));
      phones.forEach((u, i) => { u.primary = (i === 0); });
    });

    return usages;
  }

  function label(u, cls, confidence, why) {
    u.class = cls;
    u.confidence = Math.round(confidence * 100) / 100;
    u.why = why;
  }

  /** How far from the boundary, as a 0–1 score. Distance, not certainty. */
  function conf(value, boundary, typical) {
    const span = Math.abs(typical - boundary) || 1;
    const d = Math.abs(value - boundary) / span;
    return Math.max(0.3, Math.min(0.99, 0.5 + d * 0.45));
  }

  /**
   * The manifest: every usage, every orphan, and the totals that must agree.
   *
   * @param usages     classified
   * @param mediaFiles every path under ppt/media/ in the file
   */
  function buildManifest(usages, mediaFiles) {
    const referenced = {};
    usages.forEach(u => { if (u.media) referenced[u.media] = true; });

    const orphans = (mediaFiles || [])
      .filter(m => !referenced[m])
      .map(m => ({ media: m, why: 'in the file, referenced by no slide' }));

    const counts = {};
    CLASSES.forEach(c => { counts[c] = 0; });
    usages.forEach(u => { counts[u.class] = (counts[u.class] || 0) + 1; });

    const accounted = CLASSES.reduce((n, c) => n + counts[c], 0);
    return {
      detected: usages.length,
      accounted,
      complete: accounted === usages.length,
      counts,
      usages,
      orphans,
      mediaFiles: (mediaFiles || []).length,
    };
  }

  /**
   * Prove the contract rather than trust it.
   * @returns [] when the manifest is sound, otherwise the reasons it is not.
   */
  function verifyManifest(man) {
    const problems = [];
    if (!man) return ['no manifest'];

    const unlabelled = man.usages.filter(u => CLASSES.indexOf(u.class) === -1);
    if (unlabelled.length) {
      problems.push(unlabelled.length + ' usage(s) carry no valid class: ' +
        unlabelled.slice(0, 5).map(u => u.id + ' (slide ' + u.slide + ')').join(', '));
    }
    if (man.accounted !== man.detected) {
      problems.push('detected ' + man.detected + ' but accounted ' + man.accounted);
    }
    const ids = {};
    man.usages.forEach(u => { ids[u.id] = (ids[u.id] || 0) + 1; });
    const dupIds = Object.keys(ids).filter(k => ids[k] > 1);
    if (dupIds.length) problems.push('duplicate usage ids: ' + dupIds.slice(0, 5).join(', '));
    return problems;
  }

  /** A line per class, plus the verdict. For the summary screen and the log. */
  function summarise(man) {
    const lines = CLASSES.map(c => c + ': ' + (man.counts[c] || 0));
    return {
      detected: man.detected,
      accounted: man.accounted,
      complete: man.complete,
      lines,
      orphans: man.orphans.length,
    };
  }

  return { CLASSES, relMap, detectUsages, classifyUsages, buildManifest, verifyManifest, summarise,
           PHONE_MAX, PORTRAIT_MAX, SQUARE_TOL };
});
