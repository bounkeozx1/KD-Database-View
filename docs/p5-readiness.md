# P5 Readiness Assessment

Planning only. No code changed.

All figures below were measured against the live database on 2026-07-30, not
estimated.

```
employees 881 · documents 2 445 · passports 796 · groups 4 · users 2
audit rows 44 (all baseline) · roles 6 · permissions 41
db 4.3 MB · uploads 686.0 MB (3 212 files, 286 orphaned) · backups 8.7 MB (13 files)
audit chain verifies in 2 ms · 946/946 tests pass · 0 npm dependencies
```

---

## The finding that should drive P5

**Backups do not contain the document images.**

`admin.backup()` is `VACUUM INTO` — it copies `kd.db` (4.3 MB) and nothing else.
The 2 445 documents are rows holding a `file_path`; the actual passport scans, ID
cards and photographs are 3 212 files totalling **686 MB under `data/uploads/`**.
R2 offload is **disabled** on this installation, so those files exist in exactly
one place, on one disk.

Restoring any backup therefore recovers every record and **zero images**. 881
workers' passport scans have no second copy at all.

This is made worse by something I built in P4.6. Backup verification checks the
file thoroughly — checksum, `integrity_check`, schema, and the audit chain inside
it — and then reports **"Restorable"**. That verdict is true of the database and
misleading about the system: an operator reading it will reasonably conclude they
can recover, and they cannot recover a single document image. A confident green
tick over a partial backup is worse than no tick.

Ranked against everything else in this assessment, this is the largest
unmitigated risk in the product, and it is the reason I recommend the P5 scope
below over the alternatives.

---

## 1. Current Architecture

Zero npm dependencies, single Node process, `node:sqlite` (experimental,
Node ≥ 22.5), WAL mode, ~22 900 lines.

```
shell/server.js  2 096   HTTP, sessions, CSRF, RBAC gate, 1 route table
infra/repo.js    2 526   all SQL
infra/db.js        881   schema + idempotent migrations
infra/{rbac,policy,password,audit-chain,admin}.js   1 578   security primitives, no SQL
shell/scripts/*  13 700  front end (app 8 235, admin-centre 2 510, i18n 1 638)
```

**Sound:** one place owns SQL; security primitives are pure and unit-testable;
one route→permission table is the whole authorisation surface; graceful shutdown
checkpoints WAL and closes cleanly; migrations are introspection-based and
idempotent, so re-running is safe.

**Constraints, all real:**

| Constraint | Consequence |
|---|---|
| Three process-local `Map`s — MFA tickets, WebAuthn challenges, login-failure counters | A second instance breaks MFA continuation, passkey ceremonies, and the sign-in throttle. Blocks HA and rolling deploys. |
| Four `setInterval` timers (checkpoint, auto-backup, offload, sweep) | Two instances double every scheduled job. |
| `scryptSync` at N=32768 (~100 ms) on a single thread | A login burst is a self-inflicted DoS. Documented in `password.js` as a deliberate trade; still a ceiling. |
| `/api/bootstrap` returns every group, worker and document row | 881 workers today. No pagination; grows linearly. |
| No `schema_version` table | Fine for SQLite introspection; a blocker for any Postgres move. |

---

## 2. Audit Chain Architecture

**Complete and verified.** HMAC-SHA256 per row over `(prev_hash ‖ id, timestamp,
account, user_id, ip, ua, action, result, reason)`, key in `data/db/audit-chain.key`
— outside the database. Eleven tamper classes tested; forgery with the wrong key
fails; verification names the first broken row; the CLI `npm run verify-audit`
exits non-zero so it can gate a deploy.

Two things worth stating plainly:

- **`baselineThrough = 44`** — every audit row on this installation was hashed
  retroactively by the P4.6 migration. Their content is attested only from the
  migration forward. There are no genuinely-attested rows yet; the first will be
  row 45. The reports say so, and nobody should read the current green tick as
  covering the existing 44.
- **Verification is O(n) full-table.** 2 ms at 44 rows. At 100 k rows this is a
  multi-second synchronous scan on the request thread.

Open by design (from P4.6): an attacker with filesystem access obtains the key;
an administrator with `security.manage` can rebuild the chain — loudly, with a
recorded reason and the replaced head, but they can.

---

## 3. Backup Architecture

| Element | State |
|---|---|
| Database snapshot | Complete — `VACUUM INTO`, checksum at creation, verified on demand |
| Verification | Complete — checksum + `integrity_check` + schema + inner audit chain, read-only |
| Restore preview | Complete — diff vs live before committing |
| Restore safety | Complete — pre-restore copy, audit trail carried forward, chain re-anchored |
| **Document images** | **Not backed up at all** — 686 MB, 3 212 files, one copy |
| **Offsite copy** | **None** — `data/db`, `data/uploads`, `data/backups` and the chain key are all one volume |
| Retention | `pruneBackups()` exists but is only reachable through the manual cleanup call. 13 backups accumulating with no policy. |
| Orphans | 286 unreferenced upload files identified but never swept automatically |

One disk failure, one ransomware event, or one stolen laptop loses the database,
every backup of it, every document image, **and** the key needed to prove the
audit trail was not altered. The backups meant to survive that failure are on the
disk that fails.

---

## 4. Security Architecture

Complete, and I would not add to it in P5:

- scrypt (N=32768), configurable policy with one-directional clamps, history, expiry
- MFA: TOTP, WebAuthn passkeys, recovery codes, trusted devices; enforced per role and per account
- Sessions: idle + absolute + concurrent-device limits, per-role, server-issued, HttpOnly
- CSRF per session, security headers, CSP, login throttle (per account and per IP)
- RBAC: 41 permissions, 6 roles, `all`/`team`/`own` scopes, rank invariant, custom roles
- Audit: 32/32 writes covered, named lifecycle events, hash-chained, export receipts

Score 99/100 at P4.6. The missing point is T13/T14 — no external log shipping —
which is a deployment decision, below.

---

## 5. Deployment Architecture

This is where the product is weakest, and most of it is not code.

Production is a **named Cloudflare tunnel (`kd-database` → kdb.kdemployment.com)
pointing at this laptop**. The server binds plain HTTP on `0.0.0.0:3000`; the
tunnel terminates TLS; `_isHttps()` trusts `x-forwarded-proto`.

| Gap | Owner |
|---|---|
| Single volume for db + uploads + backups + chain key | Deployment (offsite target) + code (transport) |
| No offsite/offline backup copy | Deployment |
| Runs on a workstation; no service supervision or auto-start after reboot | Deployment |
| No uptime/health monitoring or alerting (`/api/health` exists; nothing calls it) | Deployment |
| No external log shipping (leaves P4.6 T13/T14 open) | Deployment (target) + code (adapter) |
| `audit-chain.key` backup, custody and rotation | Deployment (runbook) |
| Node version pinning — `node:sqlite` is experimental and may change | Deployment |
| Secrets (`R2_*`, `GEMINI_API_KEY`) in environment variables | Deployment |
| No restore rehearsal — verification exists, drills do not | Deployment |
| No staging environment | Deployment |

---

## 6. Compliance Readiness

Evidence the system can already produce: permission matrix, audit trail with
integrity proof, MFA coverage, session policy, backup provenance, export receipts.
That covers a large part of ISO 27001 A.9 (access control) and A.12.4 (logging).

Gaps, all code:

| Requirement | State |
|---|---|
| A.12.3 backup — *"information shall be backed up and tested regularly"* | Database yes; **images no**; testing manual |
| A.12.4.2 protection of log information | Chain yes; off-host copy no |
| PDPA / GDPR-equivalent **retention** | No retention period, no automatic deletion. Passport data is kept indefinitely by default. |
| PDPA **right to erasure** | Soft-delete + trash only. No verifiable erasure of a worker's images and audit references. |
| PDPA **subject access request** | Export exists but is group-scoped; nothing produces "everything held about one person". |
| Data-processing records / DPIA | Not produced |
| Breach-notification runbook | Not produced |

For a system holding 796 passport records and 686 MB of identity scans, retention
and erasure are the two most exposed obligations.

---

## Complete / Deployment / Code

**Already complete (no P5 work):** authentication, MFA, sessions, CSRF, headers,
RBAC, administration centre, configurable policy, audit coverage, hash-chained
trail, backup verification, restore preview/safety, export traceability,
security scoring, 946 tests.

**Deployment responsibility (P5 documents, does not build):** offsite backup
target, service supervision and auto-start, monitoring and alerting, log-shipping
destination, key custody and rotation, Node pinning, secret storage, restore
drills, staging.

**Code responsibility (candidate P5 work):** upload backup coverage, offsite
backup transport, retention and erasure, subject-access export, log-shipping
adapter, automatic backup retention, orphan sweeping, incremental chain
verification, bootstrap pagination, async password hashing, approval-workflow UI
(already modelled in `employee.status`/`approve`/`draft`, no screens).

---

## P5 Scope — *Durable Recovery & Data Lifecycle*

Recommended over the alternatives (HA/multi-instance; Postgres migration;
business features) because the two things actually at risk today are **recovery**
and **retention**, and neither is addressed by any of those.

### In scope

1. **Complete backup coverage** — bring `data/uploads` into the backup set;
   verification reports database *and* image coverage, so "Restorable" stops
   overstating. Fix the misleading verdict I introduced in P4.6.
2. **Offsite backup transport** — reuse the existing zero-dependency SigV4 R2
   client (currently uploads-only) to push verified backups off the volume.
   Verify after transfer, record in the trail.
3. **Retention & erasure** — configurable retention for worker records, documents
   and audit rows; verifiable erasure of one worker (rows, images, R2 objects)
   that leaves an audit record of the erasure without re-identifying the subject.
   Chain-safe: erasure must not look like tampering.
4. **Subject-access export** — everything held about one person, as one file,
   receipted like any other export.
5. **Log shipping adapter** — append-only file/syslog sink for `auth_log`, closing
   the code half of T13/T14.
6. **Scale hygiene** — bootstrap pagination, incremental chain verification,
   automatic backup retention, orphan sweep.
7. **Operations runbook** — restore drill, key custody, monitoring, service
   supervision; the deployment half, written down rather than built.

### Explicitly out of scope, with reasons

- **HA / multi-instance.** Requires moving three `Map`s and four timers to shared
  state. Real work, no current benefit: one office, one instance, 2 users.
  Premature.
- **Postgres migration.** All SQL is already isolated in `repo.js` so the option
  stays open. 4.3 MB of data does not justify it.
- **Argon2id.** Would add a dependency to a zero-dependency server for a
  documented, accepted trade-off.
- **New business features** (reporting, notifications delivery) — not readiness.
- **Approval-workflow UI.** Genuinely missing, but a feature, not hardening.
  Flagged for P6.

---

## P5 Roadmap

Sequenced so the largest risk closes first, and so nothing depends on
infrastructure that does not exist yet.

| Stage | Work | Why here |
|---|---|---|
| **5.1** | Upload backup coverage + honest verification verdict | Closes the single biggest gap. Independent of everything else. |
| **5.2** | Offsite transport (R2), verify-after-transfer, audited | Depends on 5.1 — no point shipping an incomplete backup offsite. |
| **5.3** | Automatic retention (backups, orphans) | Needs 5.2 first: pruning local copies is only safe once an offsite copy exists. |
| **5.4** | Retention policy + verifiable erasure + chain-safe deletion | The hardest design. Needs the chain semantics settled and recovery already trustworthy. |
| **5.5** | Subject-access export | Reuses 5.4's "everything about one person" query. |
| **5.6** | Log-shipping adapter | Independent; deliberately after recovery work. |
| **5.7** | Scale hygiene (pagination, incremental verification) | Lowest urgency at current volume. |
| **5.8** | Operations runbook + restore drill + compliance evidence pack | Last, because it documents what 5.1–5.7 produced. |

---

## P5 Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Erasure vs. the audit chain.** Deleting rows to satisfy a PDPA request breaks the hash chain — the exact signature of tampering. | **High** | Design first: erase *subject data*, never audit rows. Redact `auth_log` payloads in place with a chain-aware rewrite that produces a recorded anchor, or keep pseudonymised references. Must not become a laundering route (see the P4.6 flaw). |
| **686 MB backups**, growing. Naïve full copies will exhaust disk and bandwidth. | High | Content-addressed incremental upload; the R2 offload path already tracks what has been mirrored. |
| **Restoring images and database consistently.** Two artefacts can disagree. | High | Manifest binding a DB snapshot to an image set; verification checks the pair, not each half. |
| **Erasure is irreversible.** A bug deletes worker data permanently. | High | Two-stage: mark, cool-off, then erase; dry-run report; erasure itself receipted and reversible until committed. |
| **Offsite credentials** become a new attack surface — and R2 write access could delete backups. | Medium | Scoped write-only credentials, object-lock/versioning on the bucket, credentials never in the DB. |
| Chain-key rotation is unimplemented; rotation invalidates prior verification. | Medium | Multi-key verification (fingerprint per anchor already recorded), rotation recorded as an anchor. |
| Retention deletes records somebody still needs. | Medium | Policy is opt-in, clamped like every other P4 policy, dry-run first, per-category. |
| Scope creep into HA/Postgres. | Medium | Out-of-scope list above is part of the deliverable. |
| Deployment items stay unaddressed because they are "not code". | Medium | 5.8 makes them explicit, owned and dated rather than implied. |
| `node:sqlite` API changes under a Node upgrade. | Low–Medium | Pin Node; the SQL is already isolated in `repo.js`. |

---

## P5 Deliverables

1. Backup architecture spec — database + images, manifest binding, verification semantics
2. Offsite transport implementation (R2), verify-after-transfer, audited
3. Retention & erasure design document — including chain-safe deletion, reviewed before any code
4. Retention & erasure implementation, with dry-run and two-stage commit
5. Subject-access export
6. Log-shipping adapter + configuration
7. Scale hygiene changes (pagination, incremental verification, automatic retention, orphan sweep)
8. `test-p5.js` — recovery drills including image restore, erasure verification, chain integrity across erasure, retention clamps
9. Operations runbook — restore drill, key custody, monitoring, service supervision, breach notification
10. Compliance evidence pack — A.9 / A.12.3 / A.12.4 and PDPA retention/erasure/DSAR mapped to the features that satisfy them
11. Final P5 report with a recovery-objective statement (RPO/RTO) that is measured, not asserted

### Definition of done

- A restore drill on a clean machine reproduces records **and** images, verified.
- A verified backup exists off the volume, and pruning cannot remove the last one.
- One worker can be erased, and the audit chain still verifies afterwards.
- Every deployment item has a named owner and a date, or is accepted in writing as a risk.

---

## Recommendation

P5 = stages 5.1–5.3 as one block, treated as urgent: today's 686 MB of passport
scans have no second copy, and the verification screen tells an operator that
recovery is fine. Then 5.4–5.5 as a designed piece with the erasure/chain
interaction settled on paper before code. 5.6–5.8 follow.

If P5 has to be smaller than that, do 5.1 and 5.2 only. Everything else in this
document can wait; those two are the difference between having backups and
believing you have backups.
