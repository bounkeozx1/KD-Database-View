'use strict';
/**
 * infra/scripts/test-hidden-css.js — the `hidden` attribute must actually hide.
 *
 * ══════════════════════════════════════════════════════════════════
 * The bug this exists to prevent
 * ══════════════════════════════════════════════════════════════════
 * The browser's own stylesheet says `[hidden] { display: none }` at specificity
 * (0,1,0). An AUTHOR rule of the same specificity beats it, because author
 * styles outrank the UA stylesheet regardless of order. So a single innocuous
 * line —
 *
 *     .set-nav-item { display: flex; }
 *
 * — silently disabled `el.hidden` for every element carrying that class. In P4.8
 * that left 17 permission-gated Settings tabs fully visible while
 * switchSettingsTab() refused them with a bare `return`: seventeen buttons that
 * looked normal and did nothing at all, for every non-admin account. It survived
 * two audit passes because the auditing was done as an administrator, where
 * nothing is ever hidden.
 *
 * Two checks, both static — no browser needed:
 *   1. every stylesheet that styles app chrome carries the `[hidden]` safety net;
 *   2. no class that JS marks `hidden` sets `display` without that net present.
 *
 * Run: node infra/scripts/test-hidden-css.js
 */
const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
let passed = 0, failed = 0;

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch (e) { return null; }
}

/** Strip comments so a rule quoted inside one is never counted as real. */
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

console.log('\n\`hidden\` must actually hide');
console.log('---------------------------');

/* ── 1. The safety net is present ──────────────────────────────────
 * Both entry points need it independently: index.html loads main.css and never
 * login.css, and login.html the reverse. */
const SHEETS = ['shell/styles/main.css', 'shell/styles/login.css'];
for (const rel of SHEETS) {
  const css = read(rel);
  if (css === null) { ok(rel + ' exists', false, 'file not found'); continue; }
  const net = /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(stripComments(css));
  ok(rel + ' carries `[hidden] { display: none !important }`', net,
     'Without it, any class rule that sets `display` re-shows elements the JS marked hidden.');
}

/* ── 2. Classes that JS hides, and what CSS does to them ───────────
 * Collect the selectors JS marks hidden, then confirm each is covered. With the
 * global net in place this is belt-and-braces; if somebody ever removes the net,
 * this check names the exact class that breaks first. */
const JS_FILES = [
  'shell/scripts/app.js', 'shell/scripts/admin-center.js',
  'shell/scripts/login.js', 'shell/scripts/login-mfa.js',
];

// Class names the app is known to toggle `hidden` on, paired with the sheet that
// styles them. Kept explicit rather than inferred: a wrong guess here would make
// the suite pass for the wrong reason.
const HIDDEN_TARGETS = [
  { cls: 'set-nav-item',  sheet: 'shell/styles/main.css'  },
  { cls: 'set-nav-group', sheet: 'shell/styles/main.css'  },
  { cls: 'ac-verify-row', sheet: 'shell/styles/admin.css' },
  { cls: 'card',          sheet: 'shell/styles/login.css' },
];

const netIn = {};
for (const rel of ['shell/styles/main.css', 'shell/styles/login.css', 'shell/styles/admin.css']) {
  const css = read(rel);
  netIn[rel] = css !== null && /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(stripComments(css));
}
// admin.css is only ever loaded alongside main.css, so main's net covers it.
netIn['shell/styles/admin.css'] = netIn['shell/styles/admin.css'] || netIn['shell/styles/main.css'];

for (const { cls, sheet } of HIDDEN_TARGETS) {
  const css = stripComments(read(sheet) || '');
  // A rule whose selector list contains .cls and whose body sets `display`.
  const rx = new RegExp('(^|[,}])\\s*([^{}]*\\.' + cls + '[^{}]*)\\{([^}]*)\\}', 'g');
  let m, setsDisplay = null;
  while ((m = rx.exec(css))) {
    if (/(^|;)\s*display\s*:/.test(m[3]) && !/\[hidden\]/.test(m[2])) { setsDisplay = m[2].trim(); break; }
  }
  const safe = !setsDisplay || netIn[sheet];
  ok('.' + cls + ' — hidden works' + (setsDisplay ? ' (class sets display; relies on the net)' : ''),
     safe, setsDisplay ? 'Rule "' + setsDisplay + '" sets display and ' + sheet + ' has no [hidden] net.' : '');
}

/* ── 3. Permission gating must not use `hidden` ────────────────────
 * The Settings nav now marks restricted sections with .set-nav-locked and
 * explains the refusal. If someone reintroduces `nav.hidden = !allowed`, the
 * section silently vanishes again and the toast never fires. */
const app = read('shell/scripts/app.js') || '';
ok('applySettingsPermissions() does not gate on `hidden`',
   !/nav\.hidden\s*=\s*!\s*allowed/.test(app),
   'Use the .set-nav-locked class so the refusal can be explained.');
ok('switchSettingsTab() refuses a locked tab out loud',
   /set-nav-locked'\)\)\s*\{[\s\S]{0,400}?toast\(/.test(app),
   'A silent `return` is what made these look like dead buttons.');

/* ── 4b. Responsive CSS must not enumerate Settings panes ──────────
 * The ≤768px block used to hide the nav and stack the panes instead — but the
 * panes it un-hid were a hand-written list of the eight sections that existed
 * when it was written. P4 added sixteen more and none reached the list, so on
 * iPad portrait (exactly 768px) Settings rendered 8 of 24 sections with no
 * navigation at all and no route to the other 16.
 *
 * Any per-pane whitelist inside a media query is that bug waiting to recur: it
 * has to be edited every time a section is added, and nothing fails when it
 * isn't. The layout is now the same two-pane shape at every width, so no media
 * query should name a pane at all. */
{
  const css = stripComments(read('shell/styles/main.css') || '');
  const named = new Set();
  const mqRx = /@media[^{]*\{/g;
  let m;
  while ((m = mqRx.exec(css))) {
    // Walk to the matching close brace so we only look inside this block.
    let depth = 1, i = mqRx.lastIndex;
    for (; i < css.length && depth; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    const block = css.slice(mqRx.lastIndex, i);
    for (const p of block.matchAll(/#set-pane-([a-z-]+)/g)) named.add(p[1]);
  }
  ok('no media query hardcodes a Settings pane (' + named.size + ' found)', named.size === 0,
     named.size ? 'Named: ' + [...named].join(', ') +
       '\n      A per-pane list in CSS goes stale the moment a section is added.' : '');
}

/* ── 4c. Every Settings section stays reachable ────────────────────
 * The nav is the only route to a pane, so hiding it strands every section
 * behind it. This check used to forbid hiding it at all.
 *
 * The phone layout changed what "reachable" means. There, the nav is a full
 * SCREEN rather than a sidebar: opening a section replaces the list, and a back
 * control brings it back. Hiding the nav is correct in that one state and only
 * that one — so the rule is no longer "never hide it" but:
 *
 *   • a rule that hides the nav must be scoped to the explicit detail state
 *     (`.set-m-detail`) — a blanket hide is still the old bug;
 *   • and if any such rule exists, the way back must exist too: the control in
 *     the markup, and the handler behind it.
 *
 * Which is the property that actually matters — a section you cannot get back
 * out of is as lost as one you cannot get to.
 */
{
  const css = stripComments(read('shell/styles/main.css') || '');
  const hideRx = /([^{}]*?)(\.set-nav-group|\.set-nav-item|\.settings-nav)([^{}]*)\{[^}]*display\s*:\s*none/g;
  const blanket = [];
  let h;
  while ((h = hideRx.exec(css))) {
    const selector = (h[1] + h[2] + h[3]).split(/[{}]/).pop().trim();
    if (!/\.set-m-detail/.test(selector)) blanket.push(selector.slice(-70));
  }
  ok('the Settings nav is hidden only in the phone detail state', blanket.length === 0,
     blanket.length ? 'Unscoped: ' + blanket.join(' | ') +
       '\n      Hiding the nav outright removes the only way to reach a section.' : '');

  const scoped = /\.set-m-detail[^{}]*\.settings-nav[^{}]*\{[^}]*display\s*:\s*none/.test(css);
  if (scoped) {
    const html = read('shell/pages/index.html') || '';
    const js = read('shell/scripts/app.js') || '';
    ok('the phone detail state has a back control', /id="set-mback"/.test(html),
       'The nav is hidden with no button to bring it back.');
    ok('the back control has a handler', /function setMobileBack\s*\(/.test(js),
       'setMobileBack() is missing — the back button would do nothing.');
    ok('the list state is restored by that handler',
       /function setMobileBack[\s\S]{0,400}_setMobileShowList\s*\(/.test(js),
       'setMobileBack() does not return to the list.');
  }
}

/* ── 5. Every JS `hidden` write is on a known target ───────────────
 * A new one that nobody added to HIDDEN_TARGETS is unreviewed, not proven safe. */
let writes = 0;
for (const rel of JS_FILES) {
  const src = read(rel); if (!src) continue;
  writes += (src.match(/\.hidden\s*=/g) || []).length;
}
ok('`.hidden =` write sites counted (' + writes + ')', writes > 0,
   'Expected at least one; the scan may be looking at the wrong files.');

/* ── 6. Every id in the markup is unique ───────────────────────────
 * getElementById returns the FIRST match and says nothing about the rest, so a
 * duplicated id is not a validation nicety — it silently points half the code
 * at the wrong element.
 *
 * This has now cost real data twice, both times in the same way. The worker
 * form and the toolbar filters both used the `f-` prefix:
 *
 *   f-blood       — the form wrote blood group into the FILTER dropdown, and
 *                   read it back from there on save. Blood was wiped on every
 *                   save until it was found.
 *   f-supervisor  — the same, undetected for longer: the form's field was
 *                   unreachable, so whatever the filter happened to show was
 *                   written onto the record. Filter by one supervisor, open
 *                   anybody, save — and that worker changed supervisor.
 *
 * Both were found by hand, months apart. This check is what makes the third one
 * impossible: the form owns `w-`/`fm-`, the filters own `f-`, and any collision
 * at all fails the build.
 */
{
  for (const rel of ['shell/pages/index.html', 'shell/pages/login.html']) {
    const html = read(rel);
    if (!html) continue;
    const seen = new Map();
    for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, n]) => n > 1);
    ok(rel.split('/').pop() + ': every id is unique (' + seen.size + ' ids)', dup.length === 0,
       dup.length ? 'Duplicated: ' + dup.map(([id, n]) => id + ' ×' + n).join(', ') +
         '\n      getElementById() returns only the first — the rest are unreachable.' : '');
  }
}

/* ── 7. One age calculation, not two ───────────────────────────────
 * The browser and the server both print ages, into files that travel together
 * inside one export package. Two implementations disagreed on birthdays (17 vs
 * 18), which for a labour recruiter is a legal boundary rather than a rounding
 * detail. There is now one implementation and both sides call it. */
{
  const shared = read('infra/age.js') || '';
  ok('the shared age module exists', /function age\s*\(/.test(shared),
     'infra/age.js is missing or no longer exports age().');
  const app = read('shell/scripts/app.js') || '';
  ok('the browser calls the shared age module',
     /function calcAge\s*\([^)]*\)\s*\{\s*return\s+KDAge\.age\(/.test(app),
     'calcAge() has its own arithmetic again — it will drift from the server.');
  ok('the browser loads the shared module',
     /infra\/age\.js/.test(read('shell/pages/index.html') || ''),
     'KDAge would be undefined at runtime.');
  const pkg = read('infra/export-package.js') || '';
  ok('the server calls the shared age module',
     /require\(['"]\.\/age['"]\)/.test(pkg),
     'export-package.js has its own age arithmetic again.');
}

console.log('\n====================================================');
console.log('  RESULT: ' + passed + ' passed, ' + failed + ' failed');
console.log('====================================================\n');
process.exit(failed ? 1 : 0);
