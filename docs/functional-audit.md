# KD Database — Functional Audit

**Date:** 2026-07-31 · **Build:** v2.2.0 · **Scope:** does every visible action actually work?
**Method:** static cross-reference (handlers ↔ functions ↔ API ↔ routes) + live execution against an
isolated instance (`data/_verify`, port 3100), driving the real UI as **admin** and as **employee**.
**No source files were changed.** The throwaway database was deleted afterwards.

---

## 1. Headline

The application is substantially complete and genuinely wired. 241 inline handlers resolve to 96
real functions with **zero unbound names**; all 24 Settings panes render; every export format
produces a real file with a real audit row; backup/restore/verify/retention, the trash lifecycle,
the MFA enrolment flow and the whole administration centre work end to end. The backend suite
passes 155/155 with 32/32 audit coverage and no gaps.

Two defects matter:

- **F-01 (Critical)** — group IDs collide, causing silent data loss. Reproduced live.
- **F-02 (High)** — for non-admin roles, 8 visible buttons do nothing, silently, because the
  visibility gate and the click gate use *different* rules. Reproduced live.

Everything else is minor or informational.

---

## 2. Dead Function Report

### F-01 · Group ID collision → silent data loss · **CRITICAL**

| Field | Detail |
|---|---|
| **Page** | Any group creation (Dashboard "+ Add Group", Create menu, sidebar "+", PPTX/KDB import) |
| **Expected** | Each new group gets a unique id and is persisted |
| **Actual** | Two groups created within the **same millisecond** get the *same* id. Server returns 500 `UNIQUE constraint failed: groups.id`. The write queue retries 10× (~60 s of backoff) then drops the job. The client cache keeps the phantom group, so the UI shows a group that does not exist server-side — it vanishes on reload, taking its workers with it. |
| **Root cause** | `_newGroupId = () => 'g-' + Date.now().toString(36)` — millisecond resolution, **no random component**. The two generators immediately below it (`_newUid`, `_newLocId`) both append `Math.random().toString(36).slice(2,5)`. The same flawed generator is mirrored server-side. |
| **File / function** | `shell/scripts/db.js:208` `_newGroupId` · mirrored at `infra/repo.js:337` `createGroup` |
| **Evidence** | Browser: `[DB] retry 1..5 POST /groups API 500`. Server: `UNIQUE constraint failed: groups.id at repo.js:341`. After reload only 1 of 2 groups survived. Re-run with explicit distinct ids → `pending:0, failed:0`, both groups persisted. |
| **Fix required** | 1. Append randomness in `db.js:208` **and** `repo.js:337`, matching `_newUid`. 2. Have the server answer a duplicate id with **409**, not 500 — `_push()` retries 5xx but must not retry a permanent conflict. |

### F-02 · Visible buttons that do nothing for non-admin roles · **HIGH**

Two gates disagree about who may write:

| Gate | Rule | Location |
|---|---|---|
| CSS visibility | `DB.can('employee.update') \|\| DB.can('employee.create')` → `body[data-can-write]` → `.admin-only` shown | `app.js:184`, `main.css:1111` |
| Click handler | `if (!isAdmin()) return;` — i.e. `role === 'admin'` | ~28 sites in `app.js` |

The **Employee** role holds `employee.create` at scope `all`, so `data-can-write="yes"` and the
controls stay visible — but every handler refuses on role, and returns **silently with no message**.
Verified: a direct `POST /api/groups/:id/employees` from that same session returns **200 OK**, so the
server would have accepted the write the UI refuses.

Measured live as `emp1` (role `employee`) — 8 dead controls:

| # | Control | Handler | Result |
|---|---|---|---|
| 1 | Sidebar → Projects "+" | `openGroupForm(null)` | nothing happens |
| 2 | Dashboard → "Import Data" | `openImport()` | nothing happens |
| 3 | Dashboard → "+ Add Group" | `openGroupForm(null)` | nothing happens |
| 4 | Dashboard → Projects "+ New" | `openGroupForm(null)` | nothing happens |
| 5 | Dashboard → Team "+ Add Member" | `openWorkerForm(null)` | nothing happens |
| 6 | Create menu → "New group" | `createNewGroup()` | nothing happens |
| 7 | Create menu → "Add worker" | `createAddWorker()` | nothing happens |
| 8 | Create menu → "Import" | `createImport()` | nothing happens |

(The Create menu itself opens; only "Export" inside it works.) **Manager** is affected identically —
it holds `employee.update` at `team`, so `data-can-write="yes"` there too.

**Fix required:** replace `isAdmin()` with `can('<permission>')` at these call sites (`app.js` lines
978, 1164, 4082, 4471, 4479, 4490, 4526, 4782, 5112, 5287, 5425, 5455, 5480, 5493 …), and make a
refusal emit a toast rather than `return`. `admin-center.js` already does this correctly via
`acCan()`; only the worker-record UI in `app.js` still tests the role name.

### F-04 · `openImport()` gated on role, not on `import.execute` · **MEDIUM**

`domains/recruitment/intake-import/pptx-import.js:318` — `if (!isAdmin()) return;`. The Settings →
"Export & Import" tab is shown to holders of `export.excel|import.execute`, and `/api/import` is
server-gated on `import.execute`, but the dialog can only be opened by the `admin` role. A Manager
granted `import.execute` gets a visible tab whose Import action is inert.

---

## 3. Mockup Report

| Item | Status | Notes |
|---|---|---|
| AI document extraction | **Labelled mockup** | `infra/ai.js` returns canned data when `GEMINI_API_KEY` is unset; `app.js:4691` toasts *"AI extraction: mockup — set GEMINI_API_KEY to enable"*. Honest and self-declaring — not a defect. |
| "Forgot?" / "Request Access" (login) | **Informational only** | Both share `showReset()` (`login.js:283`), which only prints guidance. No reset workflow exists. The hardcoded fallback string still says *"Front-end demo"* — stale wording. |
| `doImport()` stub in `app.js:5546` | **Superseded** | Toasts *"PPTX import not implemented yet"*, but `pptx-import.js:615` redefines it and loads later, so the real implementation wins. Works today; load-order-dependent (see F-08). |

**No other placeholder or fake functionality was found.** Everything else that looks functional is.

---

## 4. Broken Navigation Report

**None.** All navigation verified working:

- 4 sidebar nav items, 4 bottom-nav items, More submenu, profile menu, language flyout
- 24 Settings tabs — all render content, no errors, no stuck `aria-busy`
- 3 detail-drawer tabs (Details / Documents / Activity), 4 dashboard view tabs
- Every overlay close button, the back-to-groups button, breadcrumbs
- Settings keyboard navigation (↓↑, Home/End, Enter, Escape-clears-search)

Settings **permission** gating is correct and is the model the rest of the app should follow: as
`employee`, 7 tabs visible / 17 correctly hidden via `data-perm`.

---

## 5. Broken Export Report

**None — all 10 export paths verified live**, each producing a real file and a real audit row.

| Format | File produced | MIME / size | Audit row |
|---|---|---|---|
| CSV | `<group>.csv` | `text/csv` (BOM) | `format=csv permission=export.excel` |
| Excel | `<group>.xlsx` | `…spreadsheetml.sheet` 11.8 KB | `format=xlsx permission=export.excel` |
| KD Card PDF | `<group>_kd_cards.pdf` | `application/pdf` 567 KB | `format=kd-pdf permission=export.pdf` |
| KD Card PNG | 6 × `<name>_kd_card.png` | `image/png` 149 KB ea. | `format=kd-png permission=export.pdf` |
| PowerPoint | `<group>.pptx` | `…presentationml` 208 KB | `format=pptx permission=export.pdf` |
| Documents | `audit-test.png` (≤3 → direct; >3 → ZIP) | served from `/uploads/` | `format=docs permission=export.pdf` |
| Database bundle | `<group>.kdb` | `application/zip` | `format=kdb permission=export.bundle` |
| Worker detail PDF | `<name>_detail.pdf` | `application/pdf` 543 KB | `format=detail-pdf permission=export.pdf` |
| Export all (JSON) | `kd-database-<date>.json` | `application/json` | `format=json permission=export.bundle` |
| Audit log CSV | `kd-audit-log-<date>.csv` | `text/csv` 14.9 KB | `format=audit permission=audit.view` |
| Backup download | `kd-<ts>.db` | 200, `attachment`, 240 KB | `BACKUP_DOWNLOAD` |

17 `DATA_EXPORT` rows recorded, each with format, scope, record count, permission and a traceable
watermark tag. Empty-result case handled: "docs" with no documents toasts *"No uploaded documents"*
rather than failing silently.

---

## 6. Broken Import Report

| Import | Status | Notes |
|---|---|---|
| CSV → employees | **Works** | Parsed 2 rows → preview table → target group → imported. Group went 3 → 5 workers. |
| Target selection | **Works** | Existing group / "create new group" both offered and functional. |
| Validation | **Works** | Unmapped headers ignored; empty rows skipped; unrecognised file toasts *"no data in this file"*. |
| PPTX / JSON / KDB / PDF / image | Implemented in `pptx-import.js` | Parsers present and reached by `handleImportFile()`. |
| **F-03 · Thai-only strings** | **MEDIUM defect** | Every user-facing string in the import module is hardcoded Thai — status (`'พบข้อมูล N รายการ'`), loading (`'กำลังอ่านไฟล์…'`), errors (`'ไม่พบข้อมูลในไฟล์นี้'`), dropdown options (`'(ปัจจุบัน)'`, `'➕ สร้างกลุ่มใหม่...'`) and the completion toast. Confirmed live: the English UI displayed Thai. Everywhere else uses `bi()`/`t()` for en/th/lo/ko. **File:** `pptx-import.js:462, 469, 483, 488, 496, 500, 512, 515, 731–736`. |

---

## 7. Broken Settings Report

**None.** Every field loads, changes, saves and **persists across a full page reload** (verified):

| Field | Set to | After reload |
|---|---|---|
| Company name | `AUDIT CO., LTD` | persisted (value + input) |
| Urgent threshold | 7 months | persisted |
| Upcoming threshold | 19 months | persisted |
| Default export format | CSV | persisted |
| Theme | Dark | persisted (`data-theme` + `kd_theme`) |
| Timezone | Asia/Seoul | persisted (`kd_tz`) |
| Korean city dictionary | +`AUD` | persisted |
| Document categories | +`Audit Cert` | persisted |
| Password policy min length | 14 | persisted **server-side** |
| Password history depth | 4 | persisted **server-side** |

Save / Reset / Cancel / Apply behave correctly; the password-policy Save re-renders from the
server's clamped answer rather than from what was typed.

**Note on scope:** the audit brief lists Company **Address**, **Phone** and **Email** fields. These
do not exist in the product — the Company pane has Logo and Name only. That is a missing feature,
not a broken one, so it is out of this audit's scope; flagging it so the gap is explicit.

---

## 8. Permission Mapping Report

| Area | Mapping | Verdict |
|---|---|---|
| Server route table | `requiredPermission()` — single table, **default-deny** on undeclared routes | **Correct** |
| Record-level scope | `authorizeRecord()` → `rbac.check()` for `own`/`team` | **Correct** |
| Settings nav | `data-perm` / `data-group-perm` → `DB.can()` | **Correct** (7 visible / 17 hidden as employee) |
| Admin centre | `acCan(permission)` throughout | **Correct** |
| Export formats | `_EXPORT_PERM` mirrors `rbac.exportPermissionFor`; server refuses independently | **Correct** |
| **Worker-record UI** | **`isAdmin()` (role name) instead of `can()`** | **F-02 — broken** |
| **Import dialog** | **`isAdmin()` instead of `import.execute`** | **F-04 — broken** |
| `body[data-can-write]` | permission-based, but disagrees with the handlers it unhides | **F-02 — inconsistent** |

---

## 9. Event Binding Report

**Clean.** Programmatic sweep of the live DOM: **241** inline handler attributes referencing
**96** distinct functions — **every one resolves to a defined function**. (The only "unresolved"
names were `document.getElementById`, `event.stopPropagation` and `.click` — method calls, i.e.
false positives of the matcher.) Login and MFA pages use `addEventListener` wiring with no inline
handlers, consistent with their stricter CSP.

Minor hygiene (no user impact):

- **F-11** No-op functions still called: `applyThemeIcon()` (`app.js:66`), `updateIdPreview()` (4872), `closeSetLangDD()` (7571).
- **F-11** Defined but never referenced: `profileAddAccount`, `profileShow`, `profileSwitchAccount`, `toggleLangMenu`, `toggleGroupsSection`, `syncSearch`, `regenerateId`, `scanForDoc`, `openDocView`, `toggleTheme`.
- **F-08** `openImport` / `doImport` are each defined twice (`app.js` and `pptx-import.js`); the later script wins. Correct today, but load-order-dependent and the `app.js` stub's "not implemented" text is misleading.

---

## 10. Route Mapping Report

Every client call in `db.js` maps to a live server handler. Two mismatches, both harmless:

| Route | Issue | Severity |
|---|---|---|
| `POST /api/import` | **F-05** Implemented (`server.js:1445`), permission-declared, exercised by the test suite — but **no front-end code calls it**. UI import runs client-side via `DB.addWorker`/`createGroup`, so imports are audited as ordinary `employee.created` rows instead of `DATA_IMPORT`. | Low |
| `GET /api/settings`, `GET /api/cities` | **F-06** Declared in `requiredPermission()` (`settings.view`) but no handler exists → fall through to 404. No client calls them. Misleading entries in the authorisation table. | Low |
| `POST /api/admin/offload` | Implemented and permission-covered; no UI trigger (R2 offload is server-scheduled). | Info |

**F-07 (Low)** — `renderBackupPane()` (`admin-center.js:1934`) does `if (!acCan('backup.create')) return;`,
leaving the pane **blank with no explanation**, unlike every other pane which renders
`acError({status:403})`. Only reachable via search/deep-link since the nav item is also hidden.

---

## 11. UI ↔ Backend Coverage

| Feature | UI Exists | Backend Exists | Connected | Working |
|---|---|---|---|---|
| Sign in (password) | Yes | Yes | Yes | **Yes** |
| Forced password change at first sign-in | Yes | Yes | Yes | **Yes** |
| MFA enrolment (TOTP + QR) | Yes | Yes | Yes | **Yes** |
| MFA challenge / recovery code | Yes | Yes | Yes | **Yes** |
| Recovery codes issue + copy | Yes | Yes | Yes | **Yes** |
| Passkey (WebAuthn) register / login | Yes | Yes | Yes | Yes (not exercised — no authenticator) |
| Forgot password | Yes | No | n/a | **Informational only** |
| Request access | Yes | No | n/a | **Informational only** |
| Log out / log out everywhere | Yes | Yes | Yes | **Yes** |
| Dashboard stats + bento tiles | Yes | Yes | Yes | **Yes** |
| Dashboard customise / view switcher | Yes | Yes (settings) | Yes | **Yes** |
| Group create | Yes | Yes | Yes | **No — F-01 collision; F-02 for non-admin** |
| Group edit / archive / pin / reorder | Yes | Yes | Yes | **Yes** |
| Group delete → trash | Yes | Yes | Yes | **Yes** |
| Group history | Yes | Yes | Yes | **Yes** |
| Worker create | Yes | Yes | Yes | **Admin only — F-02** |
| Worker edit (form + inline detail) | Yes | Yes | Yes | **Admin only — F-02** |
| Worker delete → trash | Yes | Yes | Yes | **Admin only — F-02** |
| Worker detail drawer (3 tabs) | Yes | Yes | Yes | **Yes** |
| Table / KD card / photo views | Yes | Yes | Yes | **Yes** |
| Sort, filter, search | Yes | Yes (client) | Yes | **Yes** |
| Selected / starred workers | Yes | Yes (settings) | Yes | **Yes** |
| Passport alerts | Yes | Yes | Yes | **Yes** |
| Present / card zoom / grading | Yes | Yes | Yes | **Yes** |
| Photo upload + editor (crop/rotate) | Yes | Yes | Yes | **Admin only — F-02** |
| Photo thumbnail backfill | Yes | Yes | Yes | **Yes** |
| Document upload / versioning | Yes | Yes | Yes | **Admin only — F-02** |
| Document preview / edit / delete | Yes | Yes | Yes | **Admin only — F-02** |
| Document categories (configurable) | Yes | Yes | Yes | **Yes** |
| Passport MRZ scan (camera OCR) | Yes | Yes | Yes | Yes (not exercised — no camera) |
| AI extraction | Yes | Yes | Yes | **Mockup without API key (labelled)** |
| Export CSV / Excel | Yes | Yes | Yes | **Yes** |
| Export KD PDF / PNG / PPTX | Yes | Yes | Yes | **Yes** |
| Export detail PDF | Yes | Yes | Yes | **Yes** |
| Export documents | Yes | Yes | Yes | **Yes** |
| Export .kdb bundle | Yes | Yes | Yes | **Yes** |
| Export all (JSON) | Yes | Yes | Yes | **Yes** |
| Export audit log CSV | Yes | Yes | Yes | **Yes** |
| Export field picker + default format | Yes | Yes | Yes | **Yes** |
| Export watermark + audit receipt | Yes | Yes | Yes | **Yes** |
| Import CSV | Yes | Yes (client-side) | Yes | **Yes — Thai-only UI (F-03)** |
| Import PPTX / JSON / KDB / PDF / image | Yes | Yes (client-side) | Yes | **Yes — Thai-only UI (F-03)** |
| Import via `/api/import` | **No** | Yes | **No** | **F-05 dead endpoint** |
| Trash view / restore / purge / empty | Yes | Yes | Yes | **Yes** |
| Backup — DB snapshot | Yes | Yes | Yes | **Yes** |
| Backup — full system package | Yes | Yes | Yes | **Yes** |
| Backup verify (standard + deep) | Yes | Yes | Yes | **Yes** (4/4 checks pass) |
| Backup download | Yes | Yes | Yes | **Yes** |
| Backup restore + preview | Yes | Yes | Yes | **Yes** |
| Backup health score | Yes | Yes | Yes | **Yes** |
| Retention preview / apply | Yes | Yes | Yes | **Yes** |
| Offsite (R2) upload | Yes | Yes | Yes | Yes (fails cleanly when R2 unconfigured) |
| Hard reset (danger zone) | Yes | Yes | Yes | **Yes** |
| Users — list / create / rename / delete | Yes | Yes | Yes | **Yes** |
| Users — role change, password reset | Yes | Yes | Yes | **Yes** |
| Roles — matrix / create / grants / delete | Yes | Yes | Yes | **Yes** |
| Permission catalogue | Yes | Yes | Yes | **Yes** |
| Audit log — view / filter / page | Yes | Yes | Yes | **Yes** |
| Audit chain integrity check | Yes | Yes | Yes | **Yes** (61/61 verified) |
| Sessions — own + per-account revoke | Yes | Yes | Yes | **Yes** |
| Trusted devices — list / revoke | Yes | Yes | Yes | **Yes** |
| Password policy | Yes | Yes | Yes | **Yes** |
| MFA policy + force / reset per account | Yes | Yes | Yes | **Yes** |
| Session policy | Yes | Yes | Yes | **Yes** |
| Security overview + risk score | Yes | Yes | Yes | **Yes** |
| System health / database / storage | Yes | Yes | Yes | **Yes** |
| Storage cleanup + VACUUM | Yes | Yes | Yes | **Yes** |
| Settings — company, dictionaries, docs, notifications | Yes | Yes | Yes | **Yes** |
| Location dictionary (3-level, drag-reorder) | Yes | Yes | Yes | **Yes** |
| Appearance / language / timezone | Yes | Yes | Yes | **Yes** |
| About / License / Changelog | Yes | Yes | Yes | **Yes** |
| Keyboard shortcuts | Yes | n/a | Yes | **Yes** |
| Company address / phone / email | **No** | No | n/a | **Not implemented (out of scope)** |

**Coverage: 74 user-facing features audited.**

- Fully working: **62 (84%)**
- Working but admin-gated when the permission model says otherwise (F-02): **7 (9%)**
- Defective: **1 (1%)** — group create (F-01)
- Dead / not implemented: **4 (6%)** — `/api/import` endpoint, Forgot, Request Access, company contact fields

**UI ↔ backend connection rate: 97%** (72 of 74 features that exist in the UI reach a real backend
path; the 2 exceptions are the two informational login links).

---

## 12. Prioritised Fix List

| # | Priority | Fix | Files | Effort |
|---|---|---|---|---|
| 1 | **P0** | Add a random suffix to group IDs, matching `_newUid`. Return **409** (not 500) on duplicate id so the write queue stops retry-storming. | `shell/scripts/db.js:208`, `infra/repo.js:337`, `shell/server.js:1467` | S |
| 2 | **P0** | Replace `isAdmin()` with `can('<permission>')` at the ~28 worker-record call sites; emit a toast on refusal instead of a silent `return`. | `shell/scripts/app.js` | M |
| 3 | **P1** | Gate `openImport()` on `import.execute`, not `isAdmin()`. | `pptx-import.js:318` | S |
| 4 | **P1** | Align `data-can-write` with whatever rule the handlers use, so visibility and behaviour cannot disagree again. | `app.js:184`, `main.css:1111` | S |
| 5 | **P2** | Route the import module's strings through `bi()`/`t()` for en/th/lo/ko. | `pptx-import.js` (11 sites) | S |
| 6 | **P2** | Either wire the UI import to `POST /api/import` (so imports audit as `DATA_IMPORT`) or remove the endpoint. | `pptx-import.js` / `server.js:1445` | M |
| 7 | **P3** | `renderBackupPane()` should render `acError({status:403})` instead of returning blank. | `admin-center.js:1934` | S |
| 8 | **P3** | Remove the superseded `openImport`/`doImport` stubs from `app.js` so behaviour no longer depends on script order. | `app.js:5545–5546` | S |
| 9 | **P3** | Drop the declared-but-unimplemented `GET /api/settings` and `GET /api/cities` entries, or implement them. | `server.js:666–667` | S |
| 10 | **P4** | Update the stale *"Front-end demo"* fallback string on the login page. | `login.js:288` | S |
| 11 | **P4** | Delete the no-op and orphaned functions (F-11). | `app.js` | S |

---

## 13. Verification Evidence

- **Backend suite:** `npm test` → **155 passed, 0 failed**; audit coverage **32/32 probed, 0 gaps, 0 non-2xx**.
- **Live UI (admin):** full sign-in → forced password change → TOTP enrolment (code computed from the
  displayed secret) → recovery codes → app. All 24 Settings panes, 10 export paths, CSV import,
  trash lifecycle, backup suite and admin actions exercised.
- **Live UI (employee):** second account created and signed in to prove the permission mismatch,
  including a direct API probe returning **200 OK** for an action the UI refuses.
- **Cleanup:** `data/_verify` deleted; no tracked file modified by this audit.
