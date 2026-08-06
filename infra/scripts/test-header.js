'use strict';
/**
 * infra/scripts/test-header.js — the group route header (P3).
 *
 *   node infra/scripts/test-header.js
 *
 * The header answers "which flight is this?" — `VTE → ICN · date` — and the
 * whole point of it is that the answer comes from the GROUP. Two workers in one
 * group can carry different kr_city values, so a header built from a worker
 * would say something different depending on which row happened to be first.
 *
 * Two kinds of check here, and they exist for different reasons:
 *
 *   1. routeParts is EXTRACTED FROM app.js AND RUN. The route is free text —
 *      "VTE → ICN", "VTE -> ICN", "VTE to ICN", "VTE/ICN" are all in the live
 *      data — so the splitter is the one piece of real logic in this phase, and
 *      a copy of it here would be a second implementation to drift against
 *      (see infra/age.js for what that costs). The block between the
 *      `route-parse` markers in app.js is lifted verbatim and evaluated.
 *
 *   2. Static checks for the failures a browser cannot show you: markup wiped by
 *      the next language switch, the header leaking into the exported KD card,
 *      an edit field whose column the server does not persist.
 *
 * Opens no database and starts no server.
 */
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return ''; } };

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond === true) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : (cond === false ? '' : ' — ' + cond))); }
};
const section = t => { console.log('\n' + t); console.log('-'.repeat(t.length)); };

const APP = read('shell/scripts/app.js');
const CSS = read('shell/styles/main.css');
const REPO = read('infra/repo.js');

/** The source of `function name(...) { … }`, brace-matched. '' when absent. */
function fnSource(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at === -1) return '';
  let depth = 0, started = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return src.slice(at, i + 1); }
  }
  return '';
}

/* ══════════════════════════════════════════════════════════════════
 * 1 — routeParts, running
 * ══════════════════════════════════════════════════════════════════ */
section('routeParts — the shipped splitter, lifted from app.js and run');

const MARK_A = '/* ── route-parse:start ── */';
const MARK_B = '/* ── route-parse:end ── */';
const a = APP.indexOf(MARK_A), b = APP.indexOf(MARK_B);
ok('the route-parse markers are still in app.js', a !== -1 && b > a,
   'without them this suite tests nothing — do not remove them');

if (a !== -1 && b > a) {
  const block = APP.slice(a + MARK_A.length, b);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.routeParts = routeParts;', ctx);
  const routeParts = ctx.routeParts;

  const eq = (got, want) =>
    (got === null || want === null) ? got === want : (got.from === want.from && got.to === want.to);
  const show = v => v === null ? 'null' : v.from + ' → ' + v.to;

  const splits = [
    ['VTE → ICN',            { from: 'VTE', to: 'ICN' }, 'the arrow people actually type'],
    ['VTE -> ICN',           { from: 'VTE', to: 'ICN' }, 'ASCII arrow'],
    ['VTE --> ICN',          { from: 'VTE', to: 'ICN' }, 'long ASCII arrow'],
    ['VTE to ICN',           { from: 'VTE', to: 'ICN' }, 'the English word'],
    ['VTE/ICN',              { from: 'VTE', to: 'ICN' }, 'slash, no spaces'],
    ['VTE - ICN',            { from: 'VTE', to: 'ICN' }, 'a spaced hyphen'],
    ['VTE — ICN',            { from: 'VTE', to: 'ICN' }, 'em dash'],
    ['VTE – ICN',            { from: 'VTE', to: 'ICN' }, 'en dash'],
    ['  VTE→ICN  ',          { from: 'VTE', to: 'ICN' }, 'no spaces, padded'],
    ['Vientiane → Incheon',  { from: 'Vientiane', to: 'Incheon' }, 'full city names'],
  ];
  splits.forEach(([input, want, label]) =>
    ok(label + '  "' + input + '"', eq(routeParts(input), want), 'got ' + show(routeParts(input))));

  /* Anything that is not exactly two halves is shown VERBATIM by the caller.
     Guessing at a three-leg route would put a city on screen that nobody typed. */
  const verbatim = [
    ['',                  'empty'],
    ['   ',               'whitespace only'],
    [null,                'null'],
    [undefined,           'undefined'],
    ['VTE',               'one city — not a route'],
    ['VTE → ICN → PUS',   'three legs — shown as typed, not truncated'],
    ['TBC',               'a placeholder somebody typed'],
  ];
  verbatim.forEach(([input, label]) =>
    ok(label + ' → null (shown verbatim)', routeParts(input) === null, 'got ' + show(routeParts(input))));

  /* The "to" alternative is the one that can bite: it must be a word, not a
     substring, or TORONTO becomes TORON → NTO. */
  ok('TORONTO does not split on its own letters', routeParts('TORONTO') === null,
     'got ' + show(routeParts('TORONTO')));
  ok('Toronto → Incheon still splits on the arrow',
     eq(routeParts('Toronto → Incheon'), { from: 'Toronto', to: 'Incheon' }),
     'got ' + show(routeParts('Toronto → Incheon')));
}

/* ══════════════════════════════════════════════════════════════════
 * 2 — the header is the GROUP's, and survives a language switch
 * ══════════════════════════════════════════════════════════════════ */
section('the page header');

const headFn = fnSource(APP, '_routeHeadHtml');
ok('_routeHeadHtml exists', !!headFn);
ok('it reads the group route and departure', /g\.route/.test(headFn) && /g\.departure/.test(headFn));
ok('it never reads a worker field',
   !/\bkr_city\b|\bla_city\b|\bw\./.test(headFn),
   'a header built per worker disagrees with itself when two rows differ');
ok('it splits through routeParts rather than its own regex',
   /routeParts\(/.test(headFn) && !/split\(/.test(headFn));

const stats = fnSource(APP, 'renderStats');
ok('the page subtitle renders the route header', /_routeHeadHtml\(/.test(stats));
ok('the old "✈ date · route" string is gone', !/'✈ '/.test(stats));
/* applyTranslations() assigns textContent to every [data-i18n]. Leaving the
   attribute on while markup is in there flattens the route to the generic
   subtitle the next time somebody switches language — and nothing errors. */
ok('data-i18n is removed before the markup goes in',
   /removeAttribute\('data-i18n'\)/.test(stats),
   'a language switch would flatten the route to the generic subtitle');
ok('and restored when there is no route to show',
   /setAttribute\('data-i18n', 'app_sub'\)/.test(stats));

/* Answer 10: the page header, not the card. The KD card is the exported
   artefact and is locked pixel-identical — see docs/p8-liquid-glass.md. */
const kd = fnSource(APP, '_renderKdCard');
ok('the KD card exists to be checked', !!kd);
ok('the KD card does NOT take the route header',
   !/_routeHeadHtml|ph-route|ph-city/.test(kd),
   'the card is the exported document; it is locked');

/* ══════════════════════════════════════════════════════════════════
 * 3 — Laos and Korea are two blocks
 * ══════════════════════════════════════════════════════════════════ */
section('the detail view — two countries, two blocks');

const body = fnSource(APP, '_renderDetailBody');
ok('_renderDetailBody exists', !!body);
ok('there is a Laos block',  /'Laos'/.test(body));
ok('there is a Korea block', /'Korea'/.test(body));
ok('the merged "Address" block is gone', !/, 'Address',/.test(body),
   'one block for two countries was the thing being split');
ok('the Laos block holds the Lao address rows',
   /_evAddr\(w,'province'\)/.test(body) && /_evAddr\(w,'village'\)/.test(body));
ok('the Korea block holds the destination + assignment rows',
   /'kr_city'/.test(body) && /'employer_code'/.test(body) && /'group_supervisor'/.test(body));
ok("a worker without a kr_city borrows the group's, marked as borrowed",
   /_routeDest\(g\)/.test(body) && /vd-inherited/.test(body));
ok('the borrowed value is styled as borrowed', /\.vd-inherited\s*\{/.test(CSS));

/* Both new titles are four-language: a single-language section heading is the
   recurring regression in this file (see the i18n rule in CLAUDE memory). */
const biCalls = (body.match(/bi\((?:[^()]|\([^()]*\))*\)/g) || []);
const newTitles = biCalls.filter(c => /Laos|Korea|Origin city|Destination/.test(c));
ok('the new labels all carry four languages',
   newTitles.length >= 4 && newTitles.every(c => c.split(',').length >= 4),
   newTitles.length + ' four-language labels found');

/* An edit field whose column the server does not persist looks like it saved:
   the value sits on screen until the next reload, then it is gone. */
const empCols = (() => {
  const m = REPO.match(/const EMP_COLS = \[([\s\S]*?)\];/);
  return m ? (m[1].match(/'([a-z_]+)'/g) || []).map(s => s.replace(/'/g, '')) : [];
})();
ok('EMP_COLS was found in repo.js', empCols.length > 10, empCols.length + ' columns');
['kr_city', 'la_city', 'employer_code', 'group_supervisor'].forEach(col =>
  ok('the Korea/Laos block can save ' + col, empCols.includes(col),
     'not in EMP_COLS — the server would drop it silently'));

/* ══════════════════════════════════════════════════════════════════
 * 4 — the header is content, not chrome
 * ══════════════════════════════════════════════════════════════════ */
section('style');

const phBlock = (CSS.match(/\.ph-(?:route|city|arrow|dot|date)[^{]*\{[^}]*\}/g) || []).join('\n');
ok('the route header has styles', phBlock.length > 0);
ok('no glass on it', !/backdrop-filter/.test(phBlock),
   'glass is for chrome; this is content — docs/p8-liquid-glass.md');
ok('the city codes use --text, not a faint token',
   /\.ph-city[^{]*\{[^}]*var\(--text\)/.test(CSS),
   'they are the thing being read — --text-faint measured 2.45:1 in P1');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
