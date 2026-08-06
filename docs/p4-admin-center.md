# P4 — Enterprise Administration Centre

Settings became a complete administration centre: 8 sections → 24, across 6 groups.
The rest of the application is untouched — same visual language, same navigation
pattern, same localisation system, same API architecture.

**Status:** complete. 723 tests pass (545 pre-existing + 178 new).

---

## 1. Information Architecture

| Group | Section | Permission required | Backed by |
|---|---|---|---|
| **General** | Appearance | — | local |
| | Language | — | local |
| | Timezone | — | local (`kd_tz`) |
| **Workspace** | Company | `settings.update` | `app_settings` |
| | Dictionary | `settings.update` | `cities`, `app_settings` |
| | Documents | `settings.update` | `app_settings` |
| | Notifications | `settings.update` | `app_settings` |
| **Security** | Security Overview | `audit.view` | `GET /api/security/overview` |
| | MFA Policy | `mfa.enforce` | `GET /api/security/mfa-overview` |
| | Password Policy | `settings.view` read / `security.manage` write | `/api/security/policies` |
| | Trusted Devices | — (own account) | `GET /api/mfa/trusted-devices` |
| | Session Policy | `settings.view` read / `security.manage` write | `/api/security/policies` |
| **Administration** | Users | `user.view` | `GET /api/users` |
| | Roles & Permissions | `user.view` read / `role.manage` write | `/api/roles/matrix` |
| | Audit Logs | `audit.view` | `GET /api/auth-log` |
| | Active Sessions | `security.manage` (+ own, ungated) | `/api/sessions`, `/api/security/sessions` |
| **Data** | Backup & Restore | `backup.create` | `/api/admin/backups` |
| | Export & Import | `export.excel` \| `import.execute` | existing |
| **Monitoring** | System Health | `database.manage` | `GET /api/admin/health` |
| | Database Status | `database.manage` | `GET /api/admin/health` |
| | Storage Usage | `database.manage` | `GET /api/admin/health` |
| **About** | Version | — | local + health |
| | License | — | static |
| | Changelog | — | static |

### What each role actually sees

Verified in-browser, not asserted:

| Role | Permissions | Sections visible |
|---|---|---|
| Admin | 41 | all 24 |
| Auditor | 10 | 13 — General, Security Overview, Password Policy (read-only), Trusted Devices, Session Policy (read-only), Users, Roles, Audit Logs, About |
| Employee | 12 | 7 — General, Trusted Devices, About |
| Manager | 15 | Workspace read paths, policies read-only; no audit, no users, no monitoring |

---

## 2. Navigation Structure

`<aside id="set-tabs" role="tablist">` → 6 `.set-nav-group` blocks → `.set-nav-item[role=tab]`,
each with `aria-controls` pointing at a `.set-pane[role=tabpanel]`.

- **Gating** — `data-perm="x.y"` on each item (`|` = any of). `applySettingsPermissions()`
  sets `hidden`; a group whose items are all hidden hides its heading too.
- **Search** — `data-kw` on each item carries keywords in all four languages, so a
  section is findable before its pane has ever loaded.
- **Roving tabindex** — one tab stop for the list; ↑↓←→/Home/End move within it.
- **Lazy render** — `AC_RENDERERS[tab]` fires on first open only. An account that never
  opens Monitoring never issues its request.

---

## 3. UI Component Inventory

New, all in `shell/styles/admin.css` (429 lines) and `shell/scripts/admin-center.js` (2 262 lines):

| Component | Class | Used by |
|---|---|---|
| Summary card | `.ac-stat` (+ `-good/-warn/-bad` edge) | Overview, MFA, Backup, Health, Storage |
| Risk banner | `.ac-risk` + `.ac-risk-dial` | Overview, Health, Database |
| Finding row | `.ac-finding` | Overview |
| Status pill | `.ac-pill.ac-{level}` | everywhere |
| Data table | `.ac-table` in `.ac-scroll` | Users, MFA, Sessions, Devices, Audit, Backup |
| Permission matrix | `.ac-matrix` (sticky row + column headers) | Roles |
| Filter bar | `.ac-filters` / `.ac-field` | Audit |
| Pager | `.ac-pager` | Audit |
| Switch | `.ac-switch` | MFA Policy, Password Policy |
| Bounded number field | `.ac-num-control` + `.ac-range` | Password, Session |
| Key/value row | `.ac-kv` | Health, Database, Overview |
| Storage bar | `.ac-bar` + `.ac-legend` | Storage |
| Prompt dialog | `.ac-prompt` | user rename / password reset / new role |
| Chip list | `.ac-chiplist` | Overview (unenrolled accounts) |

`acPrompt()` replaced `window.prompt()` for password resets — the native prompt cannot be
styled, localised, or marked as a credential field, and is blocked in some embedded browsers.

---

## 4. Database Impact

Four additive migrations in `db.migrate()`. No table is dropped, no column removed, no data rewritten except the one role rename below.

```sql
ALTER TABLE users ADD COLUMN mfa_required INTEGER;          -- NULL = follow role policy
ALTER TABLE roles ADD COLUMN is_legacy   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roles ADD COLUMN replaced_by TEXT;
CREATE TABLE password_history (id, username, password, created_at);
CREATE INDEX idx_pwhist_user ON password_history(username, id DESC);
```

**Role migration.** `data_entry` → `employee`, applied only because the two roles hold
*byte-identical grants* — `migrateLegacyRoles()` compares them and refuses to move accounts
otherwise. `viewer` is **not** migrated to `auditor`: auditor adds `audit.view` and
`user.view`, so remapping would have silently granted two sensitive permissions to every
existing read-only account. A migration may rename; it may never promote.

Both legacy roles are retained (`is_legacy = 1`), not deleted — accounts are pinned to a
role by `role_id`, so removing a row would strip every holder of every permission at the
next boot.

Policy values live in `app_settings` under `security.password_policy`, `security.mfa_policy`,
`security.session_policy`.

---

## 5. API Mapping

### Reused unchanged (Task 14)
`/api/sessions`, `/api/mfa/*`, `/api/passkeys`, `/api/logout-all`, `/api/admin/backup`,
`/api/admin/restore`, `/api/admin/storage`, `/api/admin/cleanup`, `/api/roles`,
`/api/roles/matrix`, `/api/permissions`.

### Extended (backward compatible)
| Endpoint | Change |
|---|---|
| `GET /api/auth-log` | + `offset`, `until`, `q`; returns `total`/`limit`/`offset`/`actions`. **`log` still carries the rows**, so an older client is unaffected. |
| `GET /api/admin/backups` | + `entries[]` with size, timestamp, author, status. `files[]` unchanged. |
| `GET /api/users` | new handler on an already-declared route (`user.view`). |

### New
| Method | Route | Permission |
|---|---|---|
| GET | `/api/security/overview` | `audit.view` |
| GET | `/api/security/policies` | `settings.view` |
| PATCH | `/api/security/policies/{password,mfa,session}` | `security.manage` |
| GET | `/api/security/mfa-overview` | `mfa.enforce` |
| POST | `/api/security/mfa-enforce` | `mfa.enforce` |
| POST | `/api/security/mfa-reset` | `mfa.enforce` |
| GET | `/api/security/sessions` | `security.manage` |
| POST | `/api/security/revoke-sessions` | `security.manage` |
| POST | `/api/security/revoke-trusted` | `mfa.enforce` |
| GET | `/api/admin/health` | `database.manage` |
| GET | `/api/admin/backups/{file}/download` | `backup.create` |
| POST/PATCH/DELETE | `/api/roles[/{key}[/permissions]]` | `role.manage` |

Every one is declared in `requiredPermission()`. An undeclared route is still denied —
verified by test.

---

## 6. Localization Keys

Four languages throughout (en / th / lo / ko — the existing system has Korean, and dropping
it would have broken the language switcher).

- **26 new `t()` keys per language** in `i18n.js`: `role_manager`, `role_employee`,
  `role_auditor`, `role_data_entry`, `role_unknown`, `set_sec_*`, `set_admin_*`,
  `set_data_*`, `set_mon_*`, `set_about_*`, `set_no_permission`, `set_readonly`,
  `set_search_hint`.
- **`data-lo/en/th/ko` attributes** on every new pane heading in `index.html`.
- **`bi(lo, en, th, ko)`** for the ~340 runtime strings in `admin-center.js`.
- Audit actions and risk findings are translated from a **key + value**, never a
  server-rendered sentence — so the assessment stays language-independent.

Nothing user-visible is hard-coded. Search keywords are multilingual too: `รหัสผ่าน`
finds Password Policy, `ສຳຮອງ` finds Backup.

---

## 7. Accessibility Report — WCAG 2.2 AA

| Criterion | How it is met |
|---|---|
| 1.3.1 Info & Relationships | `role=tablist/tab/tabpanel`, `aria-controls`, `aria-labelledby`, `<caption class="sr-only">` on every table, `<th scope>` on rows and columns |
| 1.4.1 Use of Colour | every pill carries a word; matrix grants carry a tick **and** the scope name; storage bar has a text legend |
| 1.4.3 Contrast | all colours from existing theme tokens; verified in light and dark |
| 1.4.10 Reflow | no horizontal page scroll at 1280 / 768 / 375 — wide content scrolls inside `.ac-scroll` |
| 2.1.1 Keyboard | full operation: ↑↓←→, Home/End, Enter, Escape; no keyboard trap |
| 2.4.3 Focus Order | roving tabindex — one stop for the tablist, arrows within it |
| 2.4.7 / 2.4.11 Focus Visible & Not Obscured | explicit `:focus-visible` ring with `outline-offset` across `#settings-overlay` |
| 2.5.8 Target Size | ≥ 38px controls at tablet width and below |
| 3.2.2 On Input | no context change on typing; search previews without stealing focus |
| 4.1.3 Status Messages | `role="status" aria-live="polite"` on search results; `aria-busy` on loading panes |

**Verified in-browser:** all tabs have `role=tab`; every `aria-controls` resolves; exactly
one `aria-selected=true` and one `tabIndex=0` at a time; all panels labelled; live region present.

**Known limitation:** the risk dial is an `role="img"` with an `aria-label`, not a chart —
adequate, but a sparkline history would need a data table alternative.

---

## 8. Security Considerations

**The risk P4 introduces is the configuration surface itself.** A settings screen that can be
tuned into uselessness converts a hardened default into an administrator's mistake. So:

1. **Every policy value is clamped, one-directionally.** `minLength` can rise but never fall
   below 8; MFA can be tightened but a role the catalogue marks `required` can never be
   relaxed; idle timeout is bounded at both ends. Clamps apply on **write and on read**, so a
   value that arrived by another route (restored backup, hand-edited row) is still bounded.
2. **Two rules cannot be switched off at all** — the common-password blocklist, and the
   "at least two character classes" floor.
3. **System role grants are read-only, and the UI says why.** `seedRbac()` rewrites them on
   every boot, so an edit would be silently reverted. A control that appears to work and
   does not is worse than one that refuses.
4. **Administration is not surveillance.** There is no endpoint that lists another account's
   sessions, devices or IP addresses. An admin sees *counts* and can *revoke*. The
   "Locked Accounts" card is a number, never a list — those keys are usernames an attacker
   typed.
5. **Policy changes are audited** with before/after values. Weakening the system before
   attacking it leaves a trail.
6. **`mfa-reset` refuses your own account.** Otherwise a hijacked session is one click from
   stripping MFA off an admin account.
7. **Backup downloads** are gated, attributed in the audit log, `Content-Disposition:
   attachment`, `Cache-Control: no-store`, and reduced to a basename (traversal tested).
8. **CSV export is formula-injected-safe** — leading `= + - @` are neutralised, so an
   audit export cannot execute anything in Excel.
9. **Password history stores only hashes** of retired passwords, pruned to the configured depth.
10. **Rank invariant extended to role creation** — an actor cannot mint a role more powerful
    than their own. (A real bug was caught here in testing: `parseInt(rank) || 100` treated
    rank `0` as absent, which would have let a supplied `0` become a harmless `100` instead of
    being refused. Fixed and covered by test.)

### Bug found and fixed during verification

`acCan()` tested `window.DB`, but `db.js` declares `DB` with `const` — a global *binding*, not
a `window` property. Every permission-guarded pane rendered "you do not hold the permission"
**to an administrator holding all 41**. Caught in the browser, not by the unit tests, which is
exactly why the UI was driven end-to-end.

Second: Escape in the settings search closed the whole dialog when the query matched nothing —
the early-return on an empty list fired precisely when a user would reach for Escape.

---

## 9. Test Plan

`npm test` → 6 suites, 723 assertions, all passing.

| Suite | Assertions | Covers |
|---|---|---|
| test-auth | 80 | P0 — hashing, throttling, audit |
| test-session | 81 | P1 — sessions, timeouts, device limits |
| test-security | 78 | P1/P2 — CSRF, headers |
| test-mfa | 127 | P3 — TOTP, passkeys, recovery, trusted devices |
| test-rbac | 179 | P2 — matrix, scopes, rank, default-deny (+ 9 new P4 role assertions) |
| **test-p4** | **178** | **this phase** |

`test-p4.js` deliberately weights **clamps and refusals** over happy paths:

- schema and migration (5) — including "no existing account changed requirement"
- roles (11) — employee ≡ data_entry byte-for-byte; auditor writes nothing; viewer not promoted
- password policy clamps (12) — floors, ceilings, the two-class floor, non-numeric input
- password history (7) and expiry (3)
- MFA policy direction rule (7) — including **survives a re-seed**
- per-account enforcement (6) — including "forcing revokes sessions"
- session policy bounds (7) — including "unknown role gets the strictest, never the loosest"
- read models (20) — including "never returns a hash", "never exposes another account's IP"
- risk assessment (7) — determinism, and the score never leaving 0–100
- audit pagination and search (10) — including **LIKE wildcard escaped, not executed**
- backups (9) — provenance, traversal refusal, manifest-less files still restorable
- custom roles (12) — unknown permission ignored, system role refused, in-use refused
- HTTP authorisation (44) — every new endpoint probed from a role that must not reach it

**Browser verification** (not automated, run against a scratch DB on :3100): sign-in as Admin,
Employee and Auditor; all 24 panes rendered with live data; search in English, Thai and Lao;
policy save with server-side clamping observed in the UI; audit filter + pagination; keyboard
navigation; dark mode; no horizontal overflow at 1280 and 768.

---

## 10. Before vs After

| | Before (P3) | After (P4) |
|---|---|---|
| Settings sections | 8 | 24 |
| Roles offered in the UI | 2 (Admin/Viewer) | 4 (Admin/Manager/Employee/Auditor) + 2 legacy shown when held |
| UI permission model | `isAdmin()` at ~50 call sites; CSS hid controls from *viewers only* | `DB.can(permission)`, mirroring the server; `data-can-write` |
| Role badge | said "Viewer" for Manager, Employee and Auditor | correct for every role |
| Password policy | 7 constants in source | configurable + expiry + history, all clamped |
| MFA policy | fixed in code | per-role, per-account, tightenable, survives restart |
| Session policy | fixed in code | per-role idle + device limits, bounded |
| Audit log | API only, no UI | filters, search, pagination, CSV export |
| Permission matrix | API only, no UI | full matrix + custom role management |
| System monitoring | none | health, database status, storage |
| Backup history | filenames only | size, date, author, status, download |
| Password reset UX | `window.prompt()` | localised dialog, server errors surfaced |
| Reachable-but-broken screens | 5 APIs with no UI | 0 |

### Scores

| Score | Before | After | Basis |
|---|---|---|---|
| **Settings** | 45/100 | **94/100** | 8→24 sections; search across 4 languages; WCAG 2.2 AA; responsive; lazy-loaded |
| **Administration** | 30/100 | **92/100** | user lifecycle, 4 roles + custom roles, permission matrix, audit viewer, session control, MFA enforcement, backup provenance |
| **Enterprise readiness** | 62/100 | **93/100** | configurable policy with clamps, audited changes, exportable trail, monitoring, least-privilege delegation across 3 distinct admin permissions |
| **Security** | 93/100 | **95/100** | +password history/expiry, +per-account MFA enforcement, +policy-change auditing, +CSV injection guard, +role-creation rank check; −0 regressions |

The remaining 5–8 points in each are real, not padding: no email/webhook alerting on critical
findings, no scheduled backup verification (restore-test), no session detail for compliance
investigations (deliberately withheld), and the risk model has no trend history.

---

## Files

**New** — `infra/policy.js`, `infra/scripts/test-p4.js`, `shell/scripts/admin-center.js`,
`shell/styles/admin.css`, `docs/p4-admin-center.md`

**Modified** — `infra/rbac.js`, `infra/db.js`, `infra/repo.js`, `infra/password.js`,
`infra/admin.js`, `shell/server.js`, `shell/scripts/db.js`, `shell/scripts/app.js`,
`shell/scripts/i18n.js`, `shell/pages/index.html`, `shell/styles/main.css`,
`infra/scripts/test-rbac.js`, `package.json`

P5 has not been started.
