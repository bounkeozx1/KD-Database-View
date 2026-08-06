'use strict';
/**
 * infra/scripts/test-glass.js — the Liquid Glass material layer.
 *
 *   node infra/scripts/test-glass.js
 *
 * Static checks, no browser needed. They exist because the failure mode of this
 * design language is silent: a glass surface that reaches an exported file
 * still LOOKS right on screen, and the wrong file has already been sent by the
 * time anybody notices.
 *
 * The invariants, in the order they matter:
 *
 *   1. every capture goes through _rasterise(), which sets `body.exporting`;
 *   2. `body.exporting` switches the material off;
 *   3. glass never appears on the worker list or the KD card — the card IS the
 *      exported document, and a grid of glass cards is a scroll-jank generator;
 *   4. the accessibility and print escapes are present.
 */
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } };
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS_FILES = ['shell/styles/main.css', 'shell/styles/sidebar.css',
                   'shell/styles/admin.css', 'shell/styles/login.css'];

/* ── 1. Every rasterising call goes through the guard ──────────────
 * html2canvas ignores backdrop-filter rather than failing on it, so a direct
 * call is a file that comes out wrong with nothing to warn anyone. */
{
  const js = read('shell/scripts/app.js');
  ok('_rasterise() exists', /async function _rasterise\s*\(/.test(js));
  ok('_rasterise sets body.exporting',
     /function _rasterise[\s\S]{0,300}classList\.add\('exporting'\)/.test(js));
  ok('_rasterise clears it in a finally',
     /function _rasterise[\s\S]{0,500}finally\s*\{[\s\S]{0,120}classList\.remove\('exporting'\)/.test(js));

  const direct = [];
  ['shell/scripts/app.js', 'shell/scripts/admin-center.js'].forEach(rel => {
    const src = read(rel);
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      /* `html2canvas(` with no space — a call. The licence text in the About
       * pane says "html2canvas (MIT)", which is prose, not a capture. */
      if (!/html2canvas\(/.test(line)) return;
      // The one legitimate call is the one inside _rasterise itself.
      const before = lines.slice(Math.max(0, i - 6), i).join('\n');
      if (/async function _rasterise/.test(before)) return;
      direct.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 70));
    });
  });
  ok('no capture bypasses _rasterise()', direct.length === 0, direct.join('\n         '));
}

/* ── 2. body.exporting switches the material off ───────────────────── */
{
  const css = stripComments(read('shell/styles/main.css'));
  ok('body.exporting turns off backdrop-filter',
     /body\.exporting[^{}]*\{[^}]*backdrop-filter\s*:\s*none/.test(css));
  ok('body.exporting hides the ambient layer',
     /body\.exporting::before\s*\{[^}]*display\s*:\s*none/.test(css));
  ok('the export guard covers the overlay backdrop too',
     /body\.exporting[^{]*\.overlay/.test(css));
}

/* ── 3. Glass stays off content ─────────────────────────────────────
 * The selectors that must NEVER carry the material: the rows of the worker
 * list, the card grids, and every part of the KD card. */
{
  const FORBIDDEN = [
    ['#tbl-body',   'the worker table body'],
    ['.cards-grid', 'the card grid'],
    ['.idc-cell',   'a worker card cell'],
    ['.kd-card',    'the KD card surface'],
    ['.kd-fit',     'the KD card fit box'],
    ['.id-badge-card', 'the ID badge card'],
    ['.pcard',      'a photo card'],
  ];
  const offenders = [];
  CSS_FILES.forEach(rel => {
    const css = stripComments(read(rel));
    // Every rule that declares backdrop-filter with a real value.
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].split(/[{}]/).pop().trim();
      const body = m[2];
      if (!/backdrop-filter\s*:\s*(?!none)/.test(body)) continue;
      FORBIDDEN.forEach(([needle, what]) => {
        if (sel.includes(needle)) offenders.push(rel + '  ' + sel.slice(0, 60) + '   (' + what + ')');
      });
    }
  });
  ok('no glass on the worker list or the KD card', offenders.length === 0,
     offenders.join('\n         ') +
     (offenders.length ? '\n         The KD card is the exported document and html2canvas cannot render glass.' : ''));
}

/* ── 4. The escapes are present ─────────────────────────────────────
 * Each stylesheet that introduces glass must also say when to stop. */
{
  CSS_FILES.forEach(rel => {
    const css = stripComments(read(rel));
    const usesGlass = /backdrop-filter\s*:\s*blur/.test(css);
    if (!usesGlass) return;
    ok(rel + ' — falls back where backdrop-filter is unsupported',
       /@supports\s+not\s*\(\(?backdrop-filter/.test(css));
    ok(rel + ' — honours prefers-reduced-transparency',
       /@media\s*\(prefers-reduced-transparency\s*:\s*reduce\)/.test(css));
    ok(rel + ' — drops the material for print',
       /@media\s+print[\s\S]{0,4000}backdrop-filter\s*:\s*none/.test(css));
  });
}

/* ── 5. Sticky chrome stays possible ───────────────────────────────
 * Glass on a toolbar only reads as glass when content travels under it, which
 * needs `position: sticky` to work. Two things silently disable sticky for
 * every descendant, and both were in this stylesheet before Phase 2:
 *
 *   overflow: hidden        makes an element a scroll container; one that never
 *                           scrolls leaves sticky inert
 *   animation-fill-mode     `both`/`forwards` holds the final keyframe, and if
 *                           that keyframe names `transform` the element becomes
 *                           a containing block — so `top: 0` no longer means
 *                           the viewport
 *
 * Neither failure announces itself: the toolbar simply scrolls away, and the
 * glass quietly degrades to a flat tint. Hence the checks. */
{
  const raw = stripComments(read('shell/styles/main.css'));
  /* The @supports fallback legitimately restores `hidden` for engines without
   * `overflow: clip`; containment matters more than sticky there. */
  const css = raw.replace(/@supports\s+not\s*\(overflow:\s*clip\)[^{]*\{[\s\S]*?\}\s*\}/g, '');

  const layoutAncestors = ['.main-content', '.data-panel'];
  const blocked = [];
  layoutAncestors.forEach(sel => {
    const rx = new RegExp('\\' + sel + '\\s*\\{([^}]*)\\}', 'g');
    let m;
    while ((m = rx.exec(css))) {
      if (/overflow\s*:\s*hidden/.test(m[1])) blocked.push(sel + ' { overflow: hidden }');
    }
  });
  ok('no sticky-blocking overflow on the layout ancestors', blocked.length === 0,
     blocked.join(', ') + '  → use `overflow-x: clip` so sticky keeps working');

  const held = [];
  for (const m of css.matchAll(/animation:\s*viewEnter[^;]*;/g)) {
    if (/\b(both|forwards)\b/.test(m[0])) held.push(m[0].trim().slice(0, 64));
  }
  ok('the view entrance leaves no transform behind', held.length === 0,
     held.join('\n         ') + '  → use `backwards`, not `both`');

  ok('the toolbar is sticky', /\.toolbar\s*\{[^}]*position\s*:\s*sticky/.test(css),
     'Without it the filters scroll away and the glass has nothing moving behind it.');
}

/* ── 5b. Glass is only applied to classes that exist ───────────────
 * Twice during this work the material was applied to a selector that is never
 * rendered — `.vm-topbar` (the drawer's header is `.vm-menubar`) and
 * `.lang-menu` (the picker is `.pm-lang-list`). Both looked live: their names
 * still appear in app.js, as ids of surviving CHILDREN. Neither mistake shows
 * up in the browser, because styling nothing looks exactly like styling
 * something you cannot see.
 *
 * So: every class that carries a backdrop-filter must appear somewhere the app
 * can actually produce it. */
{
  const rendered =
    read('shell/pages/index.html') + read('shell/pages/login.html') +
    ['shell/scripts/app.js', 'shell/scripts/db.js', 'shell/scripts/admin-center.js',
     'shell/scripts/login.js', 'shell/scripts/login-mfa.js'].map(read).join('\n');

  const missing = [];
  CSS_FILES.forEach(rel => {
    const css = stripComments(read(rel) || '');
    for (const m of css.matchAll(/([^{}]+)\{[^}]*backdrop-filter\s*:\s*blur/g)) {
      const selector = m[1].split(/[{}]/).pop();
      for (const cls of new Set(selector.match(/\.[a-zA-Z][\w-]*/g) || [])) {
        const name = cls.slice(1);
        // `glass*` are the utility classes; they are applied from CSS itself.
        if (/^glass/.test(name)) continue;
        if (!new RegExp('[\\s"\'`.]' + name + '[\\s"\'`.:]').test(rendered)) {
          missing.push(rel.split('/').pop() + ' → .' + name);
        }
      }
    }
  });
  ok('every glass class is one the app actually renders',
     missing.length === 0,
     [...new Set(missing)].join('\n         ') +
       '\n         Styling a class nothing renders looks identical to styling nothing.');
}

/* ── 6. The material is defined once ───────────────────────────────
 * Blur values belong to the token layer. A hard-coded blur somewhere else is
 * a surface that will not follow when the material is retuned. */
{
  /* Feature queries are exempt: `@supports (backdrop-filter: blur(1px))` is a
   * capability test, not a surface, and its 1px is meant to be literal. */
  const css = stripComments(read('shell/styles/main.css'))
    .replace(/@supports[^{]*\{/g, '{');
  const hard = [];
  for (const m of css.matchAll(/backdrop-filter\s*:\s*blur\((\d+)px\)/g)) hard.push(m[1] + 'px');
  ok('main.css declares no hard-coded blur radius (' + hard.length + ' found)',
     hard.length === 0, hard.length ? 'Use var(--glass-blur*) instead of: ' + hard.join(', ') : '');
}


/* ── 7. Performance regressions that are invisible until measured ───
 * Each of these was a real, measured cost on the live tunnel: 1.52 MB of
 * uncompressed assets re-downloaded on every page view, main.css alone taking
 * 25 seconds. None of them announce themselves in a browser on localhost. */
{
  const html = read('shell/pages/index.html') || '';
  const server = stripComments(read('shell/server.js') || '');

  ok('assets are versioned, not clock-busted', !/\?t=['"]?\s*\+\s*Date\.now\(\)/.test(html) &&
     !/'\?t='\s*\+/.test(html),
     'A timestamp makes every URL unique, so the cache can never be used.');
  ok('the loader stamps the app version', /__KD_V__/.test(html),
     'Without a version in the URL, a release cannot bust the cache.');
  ok('the server substitutes it', /__KD_V__/.test(server),
     'The placeholder would be served to the browser verbatim.');
  ok('static responses carry an ETag', /'ETag':\s*etag/.test(server),
     'Without one, `no-cache` re-downloads the whole body every time.');
  /* `.` already excludes newlines, so this matches the header being set in one
     statement — object literal or `head['Vary'] = …` — but not two unrelated
     mentions on separate lines. */

  const heavy = ['vendor/jszip', 'vendor/html2canvas'];
  const eager = heavy.filter(v => new RegExp("'[^']*" + v).test(html));
  ok('heavy vendor libraries are not eager (' + heavy.length + ' checked)', eager.length === 0,
     eager.join(', ') + ' — 75 KB gzipped that only export/import ever uses');

  const app = read('shell/scripts/app.js') || '';
  ok('html2canvas has a loader', /function _loadHtml2Canvas/.test(app));
  ok('no stale presence check for html2canvas', !/if\s*\(!window\.html2canvas\)/.test(app),
     'A presence test before the lazy loader aborts every export.');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
