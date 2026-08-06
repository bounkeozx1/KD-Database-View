# P4.5 — Settings Production Audit

Audit of all 24 Settings sections against the seven classifications, followed by
remediation of everything that was not production ready.

**Result: 831/831 tests pass (was 723). Audit coverage 32/32 writes, 0 gaps.**

Six findings. Two were serious, and neither was visible from the UI — both were
found by measuring behaviour rather than reading code.

---

## 1. Audit Report

Method: every card, table, action and metric traced to the function that supplies
it, then to the route and table behind that. Audit coverage was **measured** by
driving all 32 write endpoints and checking both log tables
(`npm run audit-coverage`), not by reading `logAuth` call sites.

### General

| Feature | Status | API | Database | Permission | Audit | Prod ready |
|---|---|---|---|---|---|---|
| Appearance (theme) | Production Ready | — | `localStorage` by design | personal | n/a | ✅ |
| Language | Production Ready | — | `localStorage` by design | personal | n/a | ✅ |
| Timezone | Production Ready | — | `localStorage` by design | personal | n/a | ✅ |
| Keyboard shortcuts | Production Ready | — | — | personal | n/a | ✅ |

Local storage is correct here: these are per-person, per-device display
preferences. Sending them to the server would create a second source of truth for
what "today" means and would not survive the user's next browser anyway.

### Workspace

| Feature | Status | API | Database | Permission | Audit | Prod ready |
|---|---|---|---|---|---|---|
| Company name | Production Ready | `POST /api/settings` | `app_settings` | `settings.update` | PERMISSION_USED | ✅ |
| **Company logo** | **Missing Backend** → fixed | `POST /api/settings` | `app_settings` | `settings.update` | PERMISSION_USED | ✅ after F3 |
| Dictionary (KR/LA cities) | Production Ready | `/api/cities` | `cities` | `settings.update` | PERMISSION_USED | ✅ |
| Location dictionary | Production Ready | `POST /api/settings` | `app_settings` | `settings.update` | PERMISSION_USED | ✅ |
| Document categories | Production Ready | `POST /api/settings` | `app_settings` | `settings.update` (was `isAdmin()`) | PERMISSION_USED | ✅ after F5 |
| Completeness fields | Production Ready | `POST /api/settings` | `app_settings` | `settings.update` (was `isAdmin()`) | PERMISSION_USED | ✅ after F5 |
| Notification thresholds | Production Ready | `POST /api/settings` | `app_settings` | `settings.update` | PERMISSION_USED | ✅ |

### Security

| Feature | Status | API | Database | Permission | Audit | Prod ready |
|---|---|---|---|---|---|---|
| 6 overview metric cards | Production Ready | `GET /api/security/overview` | live aggregates | `audit.view` | read | ✅ |
| Risk score + findings | Production Ready | same | pure function of them | `audit.view` | read | ✅ |
| Unenrolled-account list | Production Ready | same | `users`⋈`roles`⋈`passkeys` | `audit.view` | read | ✅ |
| Locked-account count | Production Ready | same | in-process throttle | `audit.view` | read | ✅ |
| Password policy form | Production Ready | `PATCH /api/security/policies/password` | `app_settings` | `security.manage` | **POLICY_CHANGE** (was ROLE_PERMISSION_CHANGE) | ✅ after F4 |
| MFA policy switches | Production Ready | `PATCH …/mfa` | `app_settings`+`roles` | `security.manage` | **POLICY_CHANGE** | ✅ after F4 |
| Force / release enrolment | Production Ready | `POST …/mfa-enforce` | `users.mfa_required` | `mfa.enforce` | MFA_ENABLED / MFA_DISABLED | ✅ |
| Reset a user's MFA | Production Ready | `POST …/mfa-reset` | 4 tables | `mfa.enforce` | MFA_DISABLED | ✅ |
| Trusted devices table | Production Ready | `GET /api/mfa/trusted-devices` | `trusted_devices` | own account | DEVICE_REVOKED on write | ✅ |
| Session policy form | Production Ready | `PATCH …/session` | `app_settings` | `security.manage` | **POLICY_CHANGE** | ✅ after F4 |

### Administration

| Feature | Status | API | Database | Permission | Audit | Prod ready |
|---|---|---|---|---|---|---|
| Users table | Production Ready | `GET /api/users` | `users`⋈`roles` | `user.view` | PERMISSION_USED | ✅ |
| Create / rename / delete | Production Ready | `/api/users` | `users` | `user.create/update/delete` | USER_CREATE / USER_DELETE | ✅ |
| Role change | Production Ready | `PATCH /api/users/:u` | `users.role_id` | `role.assign` | ROLE_CHANGE | ✅ |
| Password reset | Production Ready | same | `users`+`password_history` | `user.update` | PASSWORD_CHANGE | ✅ |
| Permission matrix | Production Ready | `GET /api/roles/matrix` | `role_permissions` | `user.view` | read | ✅ |
| Custom role CRUD | Production Ready | `/api/roles*` | `roles` | `role.manage` | ROLE_PERMISSION_CHANGE | ✅ |
| Audit log viewer | Production Ready | `GET /api/auth-log` | `auth_log` | `audit.view` | read | ✅ |
| **Audit CSV export** | **Missing Audit** → fixed | `POST /api/export` | — | `audit.view` | **DATA_EXPORT** | ✅ after F2 |
| Own sessions | Production Ready | `GET /api/sessions` | `sessions` | own account | LOGOUT on revoke | ✅ |
| Per-account session counts | Production Ready | `GET /api/security/sessions` | `sessions` | `security.manage` | LOGOUT_ALL on revoke | ✅ |

### Data

| Feature | Status | API | Database | Permission | Audit | Prod ready |
|---|---|---|---|---|---|---|
| DB size / last backup / count | Production Ready | `GET /api/admin/health` + `/backups` | `PRAGMA` + filesystem | `backup.create` | read | ✅ |
| Create backup | Production Ready | `POST /api/admin/backup` | real `VACUUM INTO` | `backup.create` | **BACKUP_CREATE** | ✅ after F4 |
| Download backup | Production Ready | `GET …/:file/download` | streams the file | `backup.create` | **BACKUP_DOWNLOAD** | ✅ after F4 |
| **Restore backup** | **Missing Audit (destructive)** → fixed | `POST /api/admin/restore` | file swap + reopen | `backup.restore` | **BACKUP_RESTORE** | ✅ after F1 |
| Backup history table | Production Ready | `GET /api/admin/backups` | manifest + `stat()` | `backup.create` | read | ✅ |
| **Pre-restore safety copy** | **Partially Functional** → fixed | internal | `backups/` | `backup.restore` | in restore reason | ✅ after F6 |
| Default export format | Production Ready | `POST /api/settings` | `app_settings` | `settings.update` | PERMISSION_USED | ✅ |
| **CSV / XLSX / PDF / PPTX export** | **Missing Permissions + Missing Audit** → fixed | `POST /api/export` | — | `export.excel` / `export.pdf` | **DATA_EXPORT** | ✅ after F2 |
| **JSON full dump** | **Missing Permissions + Missing Audit** → fixed | `POST /api/export` | — | `export.bundle` | **DATA_EXPORT** | ✅ after F2 |
| **.kdb bundle export** | **Missing Permissions + Missing Audit** → fixed | `POST /api/export` | — | `export.bundle` | **DATA_EXPORT** | ✅ after F2 |
| Import (PPTX/CSV/JSON) | Production Ready | `POST /api/import` | real writes | `import.execute` | **DATA_IMPORT** | ✅ after F4 |
| Trash | Production Ready | `/api/trash/*` | `deleted_at` | `trash.view/restore/purge` | PERMISSION_USED + activity_log | ✅ |
| Reformat records | Production Ready | `PATCH /api/employees/*` | `employees` | `employee.update` | activity_log | ✅ |
| Generate thumbnails | Production Ready | `PATCH /api/employees/*` | `employees.photo_thumb` | `employee.update` | activity_log | ✅ |
| Reset all data | Production Ready | `POST /api/admin/reset` | real deletes | `database.manage` | PERMISSION_USED | ✅ |

### Monitoring

Every value read live from `PRAGMA`, `COUNT(*)`, `process.memoryUsage()` or a
directory walk. No cached, seeded or synthesised numbers anywhere.

| Feature | Status | Source | Permission | Prod ready |
|---|---|---|---|---|
| DB status / journal / pages | Production Ready | `PRAGMA quick_check`, `page_count`, `page_size` | `database.manage` | ✅ |
| Record counts (6) | Production Ready | `COUNT(*)` per table | `database.manage` | ✅ |
| Memory (heap / RSS) | Production Ready | `process.memoryUsage()` | `database.manage` | ✅ |
| Uptime / server time / TZ | Production Ready | `process.uptime()`, `Intl` | `database.manage` | ✅ |
| Storage breakdown + orphans | Production Ready | recursive `statSync` vs referenced paths | `database.manage` | ✅ |
| Cleanup (orphans + VACUUM) | Production Ready | real `unlink` + `VACUUM` | `database.manage` | PERMISSION_USED ✅ |
| R2 offload status | Production Ready | `r2.isEnabled()`, `offload.pendingCount()` | `database.manage` | ✅ |

### About

| Feature | Status | Source | Prod ready |
|---|---|---|---|
| **Version** | **Fake Data** → fixed | `GET /api/health` → `package.json` | ✅ after F3 |
| Data summary counts | Production Ready | bootstrap cache (server-filtered) | ✅ |
| License | Production Ready | static text — correct for a licence | ✅ |
| Changelog | Production Ready | static release notes — correct for a changelog | ✅ |

On the last two: Phase 2 asks for hard-coded arrays to be removed. A licence and
a changelog are *documentation*, not metrics — there is no backend that could
supply them more truthfully, and a fabricated release history would be the fake
data. They are declared static deliberately.

---

## 2. Missing Features Report — the six findings

### F1 · Restore silently destroyed the audit trail — **serious**

`auth_log` is documented as append-only, and ISO 27001 A.12.4.2 expects log
information to be protected. Restoring an older snapshot replaced the whole
database file, discarding every security event recorded since that snapshot.

Measured, before the fix:

```
auth_log before backup: 1
auth_log after 6 more events: 7      (5 × PERMISSION_DENIED + 1 × USER_CREATE)
auth_log AFTER restore: 1            ← 6 security events gone
```

Anyone holding `backup.restore` therefore had a one-click way to erase the record
of what they had just done — the exact audience the trail exists to catch.

**Fix.** `admin.restore()` reads the trail out before the file swap and re-inserts
what the restored database lacks, matching on row content (the restored file has
its own id sequence, so comparing ids would either duplicate every row or skip
real ones). Idempotent: restoring the same backup twice adds nothing. The count
carried forward is returned and recorded in the `BACKUP_RESTORE` entry, because
"how much evidence survived" is the first thing an auditor asks.

### F2 · Three export permissions existed but nothing enforced them — **serious**

`export.excel`, `export.pdf` and `export.bundle` shipped in P2, are granted to
Manager, and are marked audit-sensitive. But **no route mapped onto them**: every
export ran entirely in the browser from already-loaded data. Consequences:

- A Viewer — explicitly denied all three — could export anyway.
- No export of any kind ever reached the audit trail. "Who took a copy of the
  worker database?" was unanswerable.
- The full-dataset JSON dump had no check at all.

**Fix.** `POST /api/export` with the permission resolved from the format
(`rbac.exportPermissionFor`), called *before* the file is produced and abandoning
the export if refused. An unknown format falls back to `export.bundle`, the
narrowest grant, so a new format fails closed.

Measured after the fix:

```
DATA_EXPORT   mgr1  format=kd-pdf; scope=group; records=7; permission=export.pdf
DATA_EXPORT   mgr1  format=csv;    scope=group; records=7; permission=export.excel
DENIED        mgr1  missing export.bundle for POST /api/export (role=manager)
DENIED        view1 missing export.excel  for POST /api/export (role=viewer)
```

**Stated limitation, not hidden:** the records are already in the browser (the app
loads them at sign-in), so this cannot stop a determined *authorised* reader from
copying data by other means. What it does is real — the ordinary path is refused
for a role without the grant, and every export that happens is named in the trail.
Closing it completely would mean server-side rendering of every export, which is a
larger change than P4.5.

### F3 · Two pieces of displayed data were not real

**Company logo** lived only in `localStorage`, making its own description ("used
in sidebar and exports") untrue — nobody but the uploader, on that one machine,
ever saw it, and it vanished whenever the app was opened from a different origin.
Now an `app_settings` value, capped at 512 KB, with the old key still read as a
migration fallback. Verified: a logo set by an admin appears for a *different*
account whose browser has nothing in that key.

**Version** was the literal `v2.1` in three places while the build was `2.2.0` —
including one line in the same dialog as System Health, which read the real
version and therefore contradicted it. Now served by `GET /api/health` (no session
needed, so the sign-in page uses it too).

### F4 · Data-lifecycle events had no name

Backup, restore, download, import and policy changes were recorded only as the
generic `PERMISSION_USED` the RBAC gate writes for any sensitive permission. That
proves a permission was exercised but not *what happened*, so "was a backup
restored last month?" required reading the reason string of every
`database.manage` row. Six named actions added: `BACKUP_CREATE`,
`BACKUP_RESTORE`, `BACKUP_DOWNLOAD`, `DATA_EXPORT`, `DATA_IMPORT`,
`POLICY_CHANGE` — the last replacing a misuse of `ROLE_PERMISSION_CHANGE` that
made filtering for role changes also return policy changes.

### F5 · Seven Workspace editors gated on `isAdmin()` instead of the permission

Document categories, completeness fields and city add/delete all write through
routes requiring `settings.update`, but the client guard tested for the *admin
role*. A custom role granted `settings.update` — which P4's role manager makes
possible — would see the pane and find every button silently doing nothing. All
seven now test `DB.can('settings.update')`, matching the server.

### F6 · The pre-restore safety copy silently did not exist

Found while fixing F1. `backup()` names files to one-second resolution, and
`VACUUM INTO` refuses to overwrite — so two backups in the same second collided
and the second threw. `restore()` takes a pre-restore copy inside an **empty
catch**, so when an operator restored immediately after a manual backup, the copy
of the state they were about to overwrite was never written and nothing said so.

Fixed three ways: millisecond timestamps, a uniquifying suffix as a fallback, and
the failure is now logged loudly, returned to the caller, and written into the
`BACKUP_RESTORE` audit reason — so "there is no way back from this restore" is on
the record. Refusing to restore was rejected as the remedy: that would make
recovery impossible exactly when the disk is full.

---

## 3. Production Readiness Report

| Module | Items | Completion | Prod ready | Missing API | Missing DB | Missing audit | Missing perms |
|---|---|---|---|---|---|---|---|
| General | 4 | 100% | 4 | 0 | 0 | 0 | 0 |
| Workspace | 7 | 100% | 7 | 0 | 0 | 0 | 0 (2 fixed) |
| Security | 11 | 100% | 11 | 0 | 0 | 0 (3 renamed) | 0 |
| Administration | 10 | 100% | 10 | 0 | 0 | 0 (1 fixed) | 0 |
| Data | 15 | 100% | 15 | 0 (1 added) | 0 | 0 (7 fixed) | 0 (4 fixed) |
| Monitoring | 7 | 100% | 7 | 0 | 0 | 0 | 0 |
| About | 4 | 100% | 4 | 0 | 0 | 0 | 0 (1 fixed) |
| **Total** | **58** | **100%** | **58** | **0** | **0** | **0** | **0** |

Before remediation: 49 of 58 production ready (84%) — 4 Missing Permissions,
5 Missing Audit, 2 Missing Backend, 1 Fake Data, 1 Partially Functional
(some items carried more than one defect).

---

## 4–6. Code, Database and API Changes

**No schema change.** P4.5 is entirely behavioural — everything it needed already
had a table. `company_logo` is a new `app_settings` key, which needs no migration.

| File | Change |
|---|---|
| `infra/admin.js` | audit-trail preservation across restore; ms timestamps + collision guard; pre-restore failure surfaced |
| `infra/rbac.js` | `EXPORT_FORMAT_PERMISSION` + `exportPermissionFor()` |
| `infra/repo.js` | 6 new audit action names |
| `shell/server.js` | `POST /api/export`; named events for backup/restore/download/import/policy; `version` on `/api/health` |
| `shell/scripts/db.js` | `recordExport()` |
| `shell/scripts/app.js` | export authorisation on 3 paths; logo server-side; version from server; 7 `isAdmin()` → `settings.update` |
| `shell/scripts/admin-center.js` | audit CSV export recorded |
| `shell/scripts/login.js` | footer version from server |
| `shell/pages/index.html`, `login.html` | 3 hard-coded version strings removed |
| `infra/scripts/audit-coverage.js` | **new** — measures coverage of all 32 writes |
| `infra/scripts/test-p45.js` | **new** — 108 assertions |

New API: `POST /api/export { format, scope, records }` — permission by format.
Extended: `GET /api/health` gains `version`; `POST /api/admin/restore` returns
`preservedAuditRows`, `safetyCopy`, `safetyError`. Both additive.

---

## 7. Permission Matrix

41 permissions × 6 roles. Grants per role: Admin 41, Manager 15, Employee 12,
Data Entry 12 (identical to Employee — it is the pre-P4 name), Auditor 10,
Viewer 6.

| Capability | Admin | Manager | Employee | Data Entry | Auditor | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| View records | all | all | all | all | all | all |
| Create records | ✓ | — | ✓ | ✓ | — | — |
| Edit records | all | team | own | own | — | — |
| Approve records | ✓ | ✓ | — | — | — | — |
| Delete records | ✓ | — | — | — | — | — |
| Export CSV / Excel | ✓ | ✓ | — | — | — | — |
| Export PDF / PNG | ✓ | ✓ | — | — | — | — |
| Export full bundle / JSON | ✓ | — | — | — | — | — |
| Change settings | ✓ | — | — | — | — | — |
| View settings | ✓ | ✓ | — | — | ✓ | — |
| Manage users | ✓ | — | — | — | — | — |
| View users | ✓ | — | — | — | ✓ | — |
| Assign roles / manage roles | ✓ | — | — | — | — | — |
| Read audit trail | ✓ | — | — | — | ✓ | — |
| Manage security policy | ✓ | — | — | — | — | — |
| Enforce MFA | ✓ | — | — | — | — | — |
| Create / download backup | ✓ | — | — | — | — | — |
| Restore backup | ✓ | — | — | — | — | — |
| Database maintenance | ✓ | — | — | — | — | — |
| Import data | ✓ | — | — | — | — | — |
| MFA required | yes | yes | no | no | yes | no |

Verified over HTTP for all six roles: 34 assertions confirming each role is
allowed what it should be and refused what it should not, including the five
non-admin roles being refused settings writes, backup creation, restore and import.

---

## 8. Audit Coverage Matrix — measured

`npm run audit-coverage` drives all 32 write endpoints and reports what landed in
each log table. It exits non-zero on any gap, so it gates the release.

```
probed: 32   covered: 32   (auth_log: 29, activity_log only: 3)   gaps: 0
```

Both tables are measured because the system deliberately has two:

- **`auth_log`** — accounts and security posture: sign-ins, roles, policy,
  backups, exports, imports. 29 operations.
- **`activity_log`** — worker records: created, edited, trashed. 3 operations.

The split is load-bearing, not incidental: it stops a retention policy on worker
data from quietly deleting security evidence. A first version of this probe
watched only `auth_log` and reported three false gaps — record writes *are*
audited, in the table meant to hold them.

Every Phase 5 example is covered by a named event: Password Policy Changed
(`POLICY_CHANGE`), MFA Policy Changed (`POLICY_CHANGE`), Role Changed
(`ROLE_CHANGE`), Session Revoked (`LOGOUT_ALL`), Backup Created
(`BACKUP_CREATE`), Backup Restored (`BACKUP_RESTORE`), Export Generated
(`DATA_EXPORT`), Import Executed (`DATA_IMPORT`).

---

## 9. Test Results

```
test-auth        80 passed, 0 failed
test-session     81 passed, 0 failed
test-security    78 passed, 0 failed
test-mfa        127 passed, 0 failed
test-rbac       179 passed, 0 failed
test-p4         178 passed, 0 failed
test-p45        108 passed, 0 failed      ← new
audit-coverage   32/32 writes, 0 gaps     ← new
                ─────────────────────
                831 passed, 0 failed
```

`test-p45` is written so every assertion **fails on the pre-P4.5 code** — a
regression test that would have passed before the fix proves nothing. It covers:
trail survival across restore (7), export permission mapping (10), audit action
vocabulary (6), all six roles' grants (16), server-enforced export authorisation
(12), export audit content (6), named lifecycle events (9), API restore
preservation (5), six-role settings gating (21), backup collision regression (3),
server-supplied version (4), plus account and branding checks.

Browser-verified: Viewer refused export by the server (not just a hidden button);
Manager allowed CSV/PDF and refused bundle/JSON with client and server agreeing
exactly; sidebar reading `Management v2.2.0` from the server; an admin's logo
appearing for a different account with an empty local key; no console errors.

---

## 10. Final Score

| Score | P4 | P4.5 | Basis |
|---|---|---|---|
| **Settings completion** | 94 | **99** | 58/58 items production ready; no fake data, no placeholder metric, no mock row |
| **Administration completion** | 92 | **98** | every admin action backed by a real operation, a permission and a named audit event |
| **Production readiness** | 93 | **97** | 0 missing APIs, 0 missing DB, 0 missing audit, 0 missing permissions; coverage gated by a test |
| **Security** | 95 | **97** | +audit trail survives restore, +export authorisation enforced, +pre-restore copy no longer silently absent, +2 UI/server gating mismatches closed |

The withheld points are specific, not padding:

- **Settings −1** — the licence and changelog are static text; a deployment that
  wants them per-instance would need a content source.
- **Administration −2** — no alerting: a critical risk finding waits for someone
  to open the page. No scheduled restore-test to prove backups are usable.
- **Production readiness −3** — exports are still generated client-side, so
  authorisation is enforced at the request and not at the data (F2's stated
  limitation). Server-rendered exports would close it.
- **Security −3** — same client-side export boundary; `auth_log` is protected
  across restore but not cryptographically (no hash chain), so a party with
  direct filesystem access to `kd.db` can still edit it.

P5 has not been started.
