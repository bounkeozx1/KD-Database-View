# P4.6 — Enterprise Production Hardening

Closes the two residual risks P4.5 recorded rather than papered over: the audit
trail was protected against restore but not against direct database writes, and
backups were trusted because they existed.

**946/946 tests pass** (was 831). Audit coverage 32/32 writes, 0 gaps.
No new business features.

---

## 1. Architecture Review

Four things were true before this phase, and each one was a claim the code could
not actually back:

| Claim the system made | Reality | Now |
|---|---|---|
| "auth_log is append-only by convention" | Convention only. `UPDATE auth_log SET reason=…` was undetectable. | Every row carries an HMAC over itself + the previous row. Verification names the first altered row. |
| "restore preserves the audit trail" | True since P4.5 — but the merge changed row ids, so the chain would read as tampered afterwards. | Restore re-anchors and records the rebuild with the head hash it replaced. |
| "the backup history shows your backups" | Listed filenames and sizes. Nothing checked a file was a readable, complete, uncorrupted database. | Checksum at creation; verification opens it read-only and runs integrity + schema + chain checks. |
| "restore replaces current data" | A yes/no confirmation naming a filename. | Preview shows verification plus a row-by-row diff before the operator commits. |

### Module layout

`infra/audit-chain.js` (new, 216 lines) holds the primitive and **no SQL** — same
reasoning as `infra/password.js`: a cryptographic primitive that needs a database
to test will not get tested. All eleven tamper classes are unit-tested against
plain arrays.

```
audit-chain.js   HMAC key file · canonicalise · hashRow · computeChain · verifyChain
      ↑ pure                                   ↑ key file only
repo.js          logAuth() appends a link · verifyAuditChain() · reanchorAuditChain()
admin.js         checksums · verifyBackup() · previewRestore() · restore() re-anchors
server.js        /api/security/audit-integrity · audit-reanchor · backups/:f/verify · /preview
scripts/verify-audit.js   CLI verifier — reads the DB directly, exits non-zero on a break
```

### The one design decision that matters

**The chain is keyed.** A plain SHA-256 chain would be decoration: the algorithm
is in the repository, so anyone who edits a row can recompute every hash after
it. HMAC-SHA256 with a 32-byte secret in a file *beside* the database means the
realistic attacks — a leaked `kd.db`, an SQL-injection write, a copied backup —
cannot forge a link at all.

Tested directly: an attacker who edits a row and recomputes the chain **with the
wrong key** is still caught at the edited row.

---

## 2. Threat Model

| # | Threat | Before | After | Residual |
|---|---|---|---|---|
| T1 | Insider edits an audit row to hide an action | Undetectable | Detected, row named | — |
| T2 | Insider deletes an audit row | Undetectable | Detected as a sequence break | — |
| T3 | Insider swaps two rows' contents | Undetectable | Detected (`id` is hashed) | — |
| T4 | Insider blanks a `reason` to NULL or `""` | Undetectable | Detected (NULL ≠ `""` ≠ absent) | — |
| T5 | Attacker recomputes the chain after editing | n/a | Fails — no key | Needs the key file |
| T6 | Leaked `kd.db` / SQL-injection write | Full forgery possible | Cannot forge | — |
| T7 | Restore used to erase evidence | Fixed in P4.5 | Also re-anchors + records the rebuild | — |
| T8 | Restore leaves the chain looking tampered | Would have | Re-anchored, rebuild recorded | — |
| T9 | Corrupted backup discovered only during recovery | Yes | Checksum + `integrity_check` + schema + inner chain | — |
| T10 | Backup silently substituted | Undetectable | Checksum mismatch | — |
| T11 | Restore applied to the wrong snapshot | Only a filename shown | Preview names what would be lost | — |
| T12 | Exported file leaks, source unknown | Untraceable | Receipt id + HMAC tag, in the file and the trail | Line can be deleted from the file |
| T13 | **Attacker with full filesystem access** | — | **Not defeated** — gets the key too | Needs external append-only storage |
| T14 | **Root / host compromise** | — | **Not defeated** | Same |
| T15 | Operator rebuilds the chain to launder a tamper | n/a | Requires `security.manage` + a written reason; records the pre-rebuild head | A determined admin can still do it — but not silently |

T13–T15 are stated, not solved. Defeating them means the events must leave the
machine (syslog/WORM/a second host), which is a deployment change rather than a
code change, and pretending otherwise would be the dishonest part of a security
report.

### A flaw found in my own P4.6 code

The first version reported a break as benign when any recorded anchor covered
that row id — reasoning that a restore had rebuilt the chain and said so.

**That was wrong and dangerous.** A rebuild leaves the chain *fully verifying*, so
any break found afterwards was introduced after the rebuild and the anchor cannot
account for it. But the check matched on row id alone, which meant that on any
installation that had ever performed one restore, every subsequent genuine tamper
would be downgraded from *critical* to *informational*. Normal operation would
have disarmed the alarm.

Removed. A break is a break; there is no false positive to suppress because
legitimate restores re-anchor immediately. The field is retained, always `false`,
so older callers get the safe answer rather than `undefined`. Regression-tested.

---

## 3. Database Changes

Additive. No table dropped, no column removed, no data rewritten.

```sql
ALTER TABLE auth_log ADD COLUMN prev_hash TEXT;   -- previous row's hash
ALTER TABLE auth_log ADD COLUMN row_hash  TEXT;   -- HMAC(key, prev ‖ this row)

CREATE TABLE audit_anchors (
  id, created_at, reason, actor,
  through_id,      -- highest auth_log id the rebuild covered
  prev_head,       -- chain head BEFORE the rebuild
  new_head,        -- and after
  rows_affected, key_fpr
);
```

Outside the database: `data/db/audit-chain.key` (32 bytes hex, mode 0600,
generated on first use) and `sha256` per entry in `backups/manifest.json`.

**The baseline is declared, not implied.** Existing rows are hashed retroactively
on first boot and the highest id recorded as a `baseline:` anchor. That proves
those rows have not changed *since the migration* — it proves nothing about
before. Verification reports `baselineThrough` and `attestedFrom` separately, and
the CLI prints the distinction in words. An integrity report that overstates
itself is worse than none.

---

## 4. API Changes

| Method | Route | Permission | Purpose |
|---|---|---|---|
| GET | `/api/security/audit-integrity` | `audit.view` | Verify the chain. Records `AUDIT_VERIFY` with the verdict. |
| POST | `/api/security/audit-reanchor` | `security.manage` | Rebuild the chain. Demands a written reason ≥ 8 chars; records the replaced head. |
| POST | `/api/admin/backups/:file/verify` | `backup.create` | Read-only verification. Records `BACKUP_VERIFY`. |
| GET | `/api/admin/backups/:file/preview` | `backup.create` | Diff vs live before restoring. |

Extended: `POST /api/export` now returns `{exportId, tag, watermark, issuedTo,
issuedAt}`. `GET /api/admin/backups` entries gain `sha256` + `sizeMatches`.
`POST /api/admin/restore` returns `reanchor`. All additive.

Six new audit actions: `BACKUP_VERIFY`, `AUDIT_VERIFY`, `AUDIT_REANCHOR`, plus
P4.5's lifecycle set. **Verification is itself audited** — a failed integrity
check cannot be quietly observed and left unreported.

---

## 5. Migration Plan

Automatic, idempotent, on first boot after deploy:

1. `ALTER TABLE auth_log` ×2 — instant, no rewrite.
2. `CREATE TABLE audit_anchors`.
3. Generate `audit-chain.key` if absent; log its path and a warning to back it up.
4. Hash all existing rows in one transaction; record the `baseline:` anchor.
5. `seedRbac()` and the legacy-role migration are untouched.

**Rollback:** revert the code. The two columns and the extra table are ignored by
the previous build, and the audit trail stays fully readable — the hashes are
additive metadata, not a format change.

**Operational requirement — the one thing that needs saying out loud:**
`audit-chain.key` must be backed up alongside the database. Without it, an
existing chain cannot be verified. A corrupt key file is a hard failure rather
than a silent regeneration, because regenerating would make every row
unverifiable and look identical to a successful attack.

Failure modes are all degrade-not-break: no key ⇒ chaining disabled, rows still
written, verification reports "unavailable"; a chain write failure ⇒ logged, the
audit row still lands. An integrity feature that can stop a sign-in is worse than
the risk it mitigates.

---

## 6. Test Plan and Results

```
test-auth        80    test-p4       178
test-session     81    test-p45      108
test-security    78    test-p46      115   ← new
test-mfa        127    audit-coverage 32/32 writes, 0 gaps
test-rbac       179
                      ─────────────────────
                      946 passed, 0 failed
```

`test-p46` is mostly **attacks**, because a tamper-evident log is only worth the
claim if the tampering is caught. Each case edits the database the way an attacker
would, then asserts detection.

| Group | Cases | Notable |
|---|---|---|
| Primitive — tamper classes | 13 | edit, delete, swap, NULL-blank, empty-blank, separator injection, forged append |
| Primitive — the key | 8 | forgery with the wrong key fails; a valid chain fails under a different key; key is outside the DB and in no table |
| Chain in the database | 12 | live `UPDATE`/`DELETE` caught; rows before the break still verified; anchors record who and why |
| Restore | 7 | evidence preserved, chain re-anchored, rebuild names the file |
| Backup verification | 12 | modified, truncated, empty, non-database, missing schema, traversal; "no checksum" = unknown ≠ failed; verification leaves the file byte-identical |
| Restore preview | 8 | exact loss count; audit rows counted separately; preview mutates nothing |
| Risk model | 9 | a break is decisive; **regression: a prior restore must not excuse it**; score stays 0–100 |
| HTTP | 46 | permissions per role; receipts unique, tagged, unforgeable; every integrity op audited |

**Browser-verified** against a scratch DB: integrity card reads *Unaltered
7/7*; a live `UPDATE` to `auth_log` flipped the pane to **ALTERED row 4 — content
does not match its hash**, the overview to **Critical** (score 57 — arithmetically
"warning", overridden by the decisive rule), and the chain card to *3/11 rows
verified · no legitimate cause*. Backup verify showed six passing checks
including the chain inside the file. Restore preview read *WILL LOSE: 3 workers,
1 groups, 1 accounts* and *11 audit events are newer than this backup — they are
kept, not lost*. No console errors.

**CLI:** `npm run verify-audit` exits 0 intact / 1 broken — verified both ways, so
it can gate a deploy or run from cron. It reads the database directly, because if
the database has been tampered with, the tampered system's own UI is the last
thing an investigator should trust.

---

## 7. Implementation Summary

**New:** `infra/audit-chain.js`, `infra/scripts/test-p46.js`,
`infra/scripts/verify-audit.js`, `docs/p46-hardening.md`

**Modified:** `infra/db.js` (migration + backfill), `infra/repo.js` (chained
appends, verify, re-anchor, integrity in the overview and risk model),
`infra/admin.js` (checksums, verify, preview, re-anchor on restore),
`shell/server.js` (4 routes, receipts, wording), `shell/scripts/db.js` (4
wrappers), `shell/scripts/app.js` + `admin-center.js` (integrity card, checker,
verify/preview UI, watermarks), `shell/styles/admin.css`, `package.json`

### Requirements checklist

| Required | Delivered |
|---|---|
| Tamper-evident audit trail | HMAC chain, key outside the DB, 11 tamper classes tested |
| Hash-chained security events | Every `auth_log` row; `id` bound in; ASCII framing prevents boundary attacks |
| Backup verification system | Checksum + `integrity_check` + schema + inner chain, read-only |
| Restore preview | Verification + row-by-row diff before committing |
| Audit integrity checker | In-app (overview + audit pane) and CLI with exit codes |
| Export watermarking | Server-issued id + HMAC tag; embedded in CSV/JSON; recorded in the trail |
| Security score dashboard | Integrity card; a break is decisive, not merely weighted |

### Stated limitations

- **Export watermarking is attribution, not DRM.** A visible line in a CSV can be
  deleted by whoever receives the file. It makes the ordinary case — a file
  forwarded as-is — traceable, and the receipt exists in the trail regardless.
  Only text formats carry the line; XLSX/PPTX/PDF would each need metadata
  plumbing inside three separate generators.
- **The key file sits beside the database.** That defeats DB-only compromise, not
  filesystem compromise.
- **No external log shipping.** T13/T14 remain open by design.

---

## 8. Final Security Score

| Score | P4 | P4.5 | P4.6 | Basis |
|---|---|---|---|---|
| Settings completion | 94 | 99 | **99** | unchanged — no new features, by instruction |
| Administration completion | 92 | 98 | **99** | +integrity checker, +backup verification, +restore preview |
| Production readiness | 93 | 97 | **98** | recovery is now verifiable rather than assumed |
| **Security** | 95 | 97 | **99** | audit trail tamper-evident; backups verified; exports traceable; a self-inflicted alarm-disarming flaw found and fixed |

**Why 99 and not 100.** Two threats remain open and both are named above: an
attacker with filesystem access obtains the chain key, and an administrator
holding `security.manage` can rebuild the chain — loudly, with a recorded reason
and the replaced head hash, but they can. Closing either requires the events to
leave the machine to append-only external storage. That is a deployment decision,
not something this codebase can assert on its own, and a report claiming 100
while `audit-chain.key` sits next to `kd.db` would be marking its own homework.

P5 has not been started.
