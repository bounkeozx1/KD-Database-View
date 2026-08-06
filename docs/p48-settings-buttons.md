# P4.8 — Settings Button Activation Pass

**Scope:** the Settings dialog only. Roles, permissions, security, export and backend
completeness explicitly out of scope. **Goal:** no dead clicks — every button must open,
show or execute something.

**Method:** live click-sweep of every control in every Settings pane, signed in as `admin`
against an isolated instance. Each click was instrumented for DOM mutation, overlay open,
toast, network request and download; anything registering none of these was flagged DEAD
and then inspected in source.

---

## 1. Settings Button Inventory

**155 controls: 24 nav tabs + 131 in-pane.**

| Pane | Controls | Notes |
|---|---|---|
| Appearance | 4 | 3 theme tiles + "View shortcuts" |
| Language | 4 | EN/TH/LO/KO tiles (listener-wired, not inline) |
| Timezone | 0 | select only |
| Company | 2 | Upload logo (file label) + Remove |
| Dictionary | 38 | KR/LA city add + per-row delete, location-dictionary levels/items, ID config |
| Documents | 15 | per-category edit/save/delete + Add, completeness checkboxes |
| Notifications | 0 | number inputs only |
| Security Overview | 1 | Refresh |
| MFA Policy | 2–6 | Refresh + per-role switches + per-user force/reset/clear |
| Password Policy | 11 | Save, Cancel, 9 rule fields |
| Trusted Devices | 1+ | Refresh (+ per-device Revoke, Revoke all — when devices exist) |
| Session Policy | 5 | Save, Cancel, per-role numbers |
| Users | 8 | Refresh, Add, per-user reset/rename/delete, role select |
| Roles | 2+ | Refresh, Create role (+ per-role edit/delete, scope selects) |
| Audit Logs | 12 | Search, Clear, Export CSV, prev/next, Check integrity, filters |
| Sessions | 3 | Refresh, Logout all, per-account sign-out |
| Backup & Restore | 19 | Full backup, snapshot ×2, per-file verify/deep/download/offsite/restore, retention preview/apply, hard reset |
| Export & Import | 9 | 4 format tiles, Export all, Reformat, Thumbnails, Import, Trash |
| System Health | 1 | Refresh |
| Database Status | 0 | read-only |
| Storage Usage | 1 | Clean orphans + VACUUM |
| About / License / Changelog | 0 | read-only |

---

## 2. Dead Button List — **5 found, 5 fixed**

Every one had the same shape: a guard that `return`ed with no output, so an empty field
made the button indistinguishable from a broken one.

| # | Pane | Section | Button | File | Function | Root cause |
|---|---|---|---|---|---|---|
| 1 | Documents | Document types | **Add** | `shell/scripts/app.js` | `addDocCat()` | `if (!label) return;` — silent |
| 2 | Documents | Document types | **✓** (save edit) | `shell/scripts/app.js` | `saveDocCat(i)` | `if (!label) return;` — silent |
| 3 | Dictionary | Location dictionary | **Add** (level) | `shell/scripts/app.js` | `locAddLevel()` | `if (!name) return;` — silent. Also returned silently from *inside* `_locMutate` at the 3-level ceiling |
| 4 | Dictionary | Location dictionary | **Add** (item) | `shell/scripts/app.js` | `locAddItem()` | `if (!en && !lo) return;` — silent. Also returned from inside `_locMutate` when no level exists |
| 5 | Dictionary | KR / LA cities | **Add** | `shell/scripts/app.js` | `addCity(country)` | Used native `alert()` — the one control in Settings still using a browser dialog |

Additionally, five permission guards (`addCity`, `addDocCat`, `saveDocCat`, `delDocCat`,
`delCity`) returned silently for accounts without `settings.update`. Not reachable in
normal use (the whole Workspace nav group is hidden), but the same dead-click shape, so
they now report too.

### False positives ruled out

| Control | Looked dead | Verdict |
|---|---|---|
| Audit Logs **←** / **→** | no effect on click | **Correct** — properly `disabled` (21 rows, page size 50) |
| Language tiles | no inline `onclick` | **Correct** — wired via `bcGroup()` listeners |
| Company **Remove logo** | no visible change | **Correct** — hidden until a logo exists |
| Trusted Devices **Revoke all** | absent | **Correct** — only rendered when devices exist |

---

## 3. Mockup Popup List

**None.** No Settings button opens a mock, fake or placeholder dialog.

## 4. Empty Modal List

**One, now fixed.**

| Pane | Problem | Fix |
|---|---|---|
| Backup & Restore | `renderBackupPane()` began `if (!acCan('backup.create')) return;`, leaving the whole section **blank** — reads as broken rather than withheld | Now renders the standard 403 notice like every other pane (`admin-center.js`) |

All six Settings-launched popups verified to **open, load content and close correctly**:

| Popup | Opens | Content | Closes |
|---|---|---|---|
| Keyboard shortcuts | ✓ | 154 chars | ✓ |
| Trash | ✓ | "Trash is empty" | ✓ |
| Import | ✓ | 76 chars | ✓ |
| Reset-all-data confirm | ✓ | 42 chars | ✓ |
| Create role prompt | ✓ | 47 chars | ✓ |
| Rename user prompt | ✓ | 6 chars | ✓ |

## 5. Missing Handler List

**None.** Every Settings control resolves to a real function. No unbound `onclick`, no
missing listener, no TODO or stub code anywhere in the Settings surface.

---

## 6. Fix Order — all applied

| # | Fix | File |
|---|---|---|
| 1 | Added `_setNeedInput(inputId, msg)` and `_setNoPermission()` — toast + focus + 1.2 s field highlight | `app.js` |
| 2 | `addDocCat()` — empty name now explains and focuses the field; success toast on add | `app.js` |
| 3 | `saveDocCat(i)` — empty name now explains and focuses; success toast on save | `app.js` |
| 4 | `locAddLevel()` — empty name explains; 3-level ceiling gets its own message; input cleared + success toast | `app.js` |
| 5 | `locAddItem()` — empty name explains; "create a category first" when no level; inputs cleared + success toast | `app.js` |
| 6 | `addCity()` — native `alert()` replaced by toast (same `t()` keys); duplicate code highlights the **code** field, missing name highlights the **name** field; success toast | `app.js` |
| 7 | Five `settings.update` guards now report instead of returning silently | `app.js` |
| 8 | `renderBackupPane()` renders the 403 notice instead of a blank pane | `admin-center.js` |
| 9 | `.set-input-error` style — red border, red glow, 0.32 s nudge, honours `prefers-reduced-motion` | `main.css` |

---

## 7. Verification

Every fixed control re-tested live, empty **and** populated:

| Case | Result |
|---|---|
| Documents → Add (empty) | toast *"Enter a document type name first"* + `set-doccat-name` highlighted |
| Documents → Save edit (empty) | toast *"The name cannot be empty"* + field highlighted |
| Dictionary → Add level (empty) | toast *"Enter a category name first"* + field highlighted + focused |
| Dictionary → Add item (empty) | toast *"Enter a name (English or Lao) first"* + field highlighted |
| Dictionary → Add city (empty) | toast *"Enter both a name and a code"* + **name** field highlighted |
| Dictionary → Add city (name only) | same toast + **code** field highlighted — correct field targeting |
| Dictionary → Add city (duplicate code) | toast *"That code already exists"* + code highlighted, not added |
| Documents → Add "P48 Test Cert" | added, input cleared, *"Saved"* |
| Dictionary → Add city "Daegu/DG" | added, inputs cleared, *"Saved"* |
| Dictionary → Add level "Hamlet" | added as `Hamlet/village` (claimed the free column), *"Saved"*, row correctly disappears at the 3-level ceiling |
| Dictionary → Add item "P48 Province" | added, inputs cleared, *"Saved"* |

**Regression:** all 24 Settings panes still render with content and **zero console errors**;
backend suite **1,101 assertions passed, 0 failed**; audit coverage **32/32, 0 gaps**.

**Note on the field highlight:** in the in-app browser pane the red border reads as
unchanged because that pane does not advance CSS transitions and `.set-add-row input`
carries `transition: border-color .15s`. Verified correct by disabling the transition:
`rgb(220, 38, 38)` border and `rgba(220,38,38,.16) 0 0 0 3px` glow both apply. Real
browsers show it normally. The toast and focus move are unaffected either way.

**Untouched:** no other module was modified. Scratch database deleted.

---

## Success criterion

> A user can click every button in Settings and something meaningful happens.

**Met.** 131 in-pane controls plus 24 nav tabs; 5 dead clicks and 1 blank pane found and
fixed; no button in Settings now fails silently.
