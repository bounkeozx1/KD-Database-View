# P8 — Liquid Glass

An Apple-style material applied to the app's chrome, on one rule that decides
everything else:

> **Glass is for chrome. Content stays opaque.**

Sidebars, toolbars, tab bars, popups and floating controls are glass. Tables,
worker cards, forms, documents and the KD card are not, and never will be.

**1,299 tests pass.** Zero npm dependencies — still.

---

## Why the rule is not a matter of taste

Four constraints in *this* codebase, each of which independently rules out glass
on content:

1. **The KD card IS the exported document.** It is locked to be pixel-identical
   on every device and account. Changing its surface changes the artefact that
   gets sent to an employer.

2. **`html2canvas` does not implement `backdrop-filter`.** It rasterises the DOM
   for the KD PNG and the PPTX. Glass reaching a captured surface produces a
   *wrong file while the screen still looks right* — the worst failure mode
   available, because nothing errors and nobody notices until the file is
   already sent.

3. **369 workers are 369 real rows in the DOM.** No virtualisation. A grid of
   glass cards re-samples its backdrop every frame, on the phones this is
   actually used on.

4. **Lao and Thai at 0.78rem over a translucent panel** loses contrast a
   passport-management system has no business losing.

---

## The material

```css
--glass-blur-thin: 14px    --glass-tint-thin:   rgba(255,255,255,0.50)
--glass-blur:      26px    --glass-tint:        rgba(255,255,255,0.62)
--glass-blur-thick:40px    --glass-tint-thick:  rgba(255,255,255,0.74)
--glass-sat:       1.7     --glass-tint-invert: rgba(17,24,39,0.78)
--glass-border / --glass-edge / --glass-shadow
--ctl-lit / --ctl-lit-strong / --ctl-raise      (controls, not glass)
```

Every value has a dark-theme counterpart. **No blur radius is hard-coded
anywhere** — a test enforces it.

### Glass needs something behind it

A blur over a flat colour is a tint, not a material. `body::before` lays a wide,
very soft aurora behind the whole app — fixed, pointer-transparent, one
composited layer — so every glass surface has colour to bend.

This was not theoretical. The toolbar and the sidebar both sit over regions
where no page content passes beneath them; without the ambient layer they would
have been flat tints wearing a `backdrop-filter`.

---

## What is glass (7 surfaces)

| Surface | What is behind it |
|---|---|
| `.overlay` | the page, for every dialog |
| `.toolbar` | the worker rows — **made sticky so they travel under it** |
| `.sidebar` | the ambient layer |
| `.bottom-nav` | the scrolling list (mobile) |
| `.mobile-fab-menu` | the scrolling list (mobile) |
| `.vm-menubar` | the blurred page — the drawer container is transparent |
| `.row-menu` · `.toast` · `.pm-lang-list` · `.sb-submenu` | the page |

### What is deliberately NOT glass

| | Why |
|---|---|
| Tables, worker cards, KD cards, documents | content — see the four constraints |
| `.form-modal` `.settings-modal` `.export-modal` `.progress-modal` | **measured**: a glass sheet over the already-blurred scrim shifts the plate by 4/255 (light) and 12/255 (dark). Invisible, for a compositor layer per open dialog. They take the material's *edge* instead. |
| Buttons, chips, tiles | a translucent control on a translucent bar is two layers of haze over the thing you are trying to hit. They take the material's *light* (`--ctl-lit`). |
| `.fab` | primary action; its colour is the signal |
| `.save-bar` | a 3px status stripe, not a pane |
| `.pick-bar` | no backdrop — it sits on the opaque panel. Would need to be sticky first. **Open decision.** |

---

## The five switches that turn glass off

Declared together so the whole safety surface reads at once.

| Switch | Why |
|---|---|
| `@supports not (backdrop-filter)` | a tint with no blur is worse than a solid panel |
| `prefers-reduced-transparency` | an accessibility setting, not a preference |
| `@media print` | paper has no backdrop |
| **`body.exporting`** | **`html2canvas` cannot render the material** |
| `prefers-reduced-motion` | the material stops animating |

`body.exporting` is the one that matters most. Every rasterising call goes
through `_rasterise()`, which sets the class, captures, and clears it in a
`finally`. A test fails if any call bypasses it.

---

## Two layout blockers that had to go first

Glass on a toolbar only reads as glass if content travels under it, which needs
`position: sticky`. Two things silently disabled sticky for every descendant:

```css
.main-content { overflow: hidden }   /* a scroll container that never scrolls */
.view-enter   { animation: … both }  /* holds a transform → containing block */
```

Neither announces itself — the toolbar simply scrolls away. Fixed with
`overflow-x: clip` and `animation-fill-mode: backwards`.

**Layout after the change was byte-identical to before**, verified by comparing
every rect at 375px and 1280px with 369 rows loaded.

---

## Accessibility

Every glass surface was measured by compositing the text colour down through
each translucent layer to the page. **Worst ratio: 4.5:1** — AA for normal text,
in both themes.

One **pre-existing** failure was found and fixed while certifying the sidebar:
`--sb-faint` measured **2.45:1** (section headings — "PINNED", "PROJECTS"). The
glass had moved it by 0.02; it had simply never been measured. Darkened to the
lightest value that clears AA in each theme: **4.52:1** light, **4.51:1** dark.

---

## Tests — `npm run test-glass` (22 assertions)

Static, no browser needed. Each one exists because of a failure that is
invisible in a browser:

- every rasterising call goes through `_rasterise()`
- `body.exporting` kills the material, the ambient layer, and the scrim
- no glass on `#tbl-body`, `.cards-grid`, `.kd-*`, `.idc-cell`, `.pcard`
- every file using the material carries all three fallbacks
- no hard-coded blur radius
- **the nav is hidden only in the phone detail state, and the way back exists**
- **`.main-content` never regains a sticky-blocking `overflow`**
- **the view entrance leaves no transform behind**
- **every glass class is one the app actually renders**

That last one exists because the material was twice applied to a selector that
is never rendered — `.vm-topbar` (the drawer's header is `.vm-menubar`) and
`.lang-menu` (the picker is `.pm-lang-list`). Both looked live: their names
still appear in `app.js`, as ids of surviving *children*. **Styling a class
nothing renders looks exactly like styling something you cannot see**, so only a
static check catches it.

---

## Known limits

| | |
|---|---|
| **FPS is not measured** | the verification browser does not composite, so any frame rate reported from it would be fiction. What is measured instead is the number of glass surfaces the compositor must maintain — **7, fixed, independent of row count**. Real FPS needs DevTools on the actual device. |
| `.pick-bar` is not glass | it has no backdrop; making it sticky first is an open decision |
| Dead CSS remains | see below |

### Dead CSS

Removed this phase (~58 lines): `.lang-switcher`, `.lang-btn`, `.lang-row`,
`.vm-topbar`, `.vm-close`, `.vm-close-new`.

**Still present**, found while removing the above and left deliberately rather
than expanding an unrelated cleanup mid-phase: a second dead language dropdown
(`.lang-dd`, `.lang-globe`, `.lang-menu` at main.css:435, and `.lang-dd-*` at
~1904, reached only through `getElementById('set-lang-dd')` which is absent from
the markup). Worth its own pass.

---

## Files

**Modified:** `shell/styles/main.css` (material, 5 switches, 7 surfaces, control
tokens), `shell/styles/sidebar.css` (glass + the contrast fix),
`shell/styles/login.css`, `shell/scripts/app.js` (`_rasterise`),
`infra/scripts/test-glass.js`, `infra/scripts/test-hidden-css.js`

**Untouched, on purpose:** every file under `infra/` that is not a test,
`server.js`, `repo.js`, all business logic, and the 40 `.kd-*` rules that make
the KD card.
