# P5.1 — Disaster Recovery Foundation

Backup changed from *"the database is backed up"* to *"the system can be
recovered"*, with no reduction in any existing security guarantee.

**1101/1101 tests pass** (was 946). Audit coverage 32/32 writes, 0 gaps.
Zero npm dependencies — still.

---

## Phase 1 — Recovery coverage BEFORE any changes

Measured against the live database, not estimated:

| | Value | Backed up before P5.1 |
|---|---|---|
| Database | 4,486,672 B (4.28 MB) | **yes** |
| Uploads | 719,324,204 B (686.0 MB), 3,212 files | **no** |
| — referenced by a DB row | 2,939 paths, 661.2 MB | no |
| — orphaned | 286 files, 24.8 MB | no |
| — **referenced but already missing** | **13** | n/a |
| `audit-chain.key` | 64 B | **no** |
| Records | 881 employees · 2,445 documents · 796 passports · 44 audit rows | yes |

### Recovery coverage: **0.62 %**

`4,486,672 / 723,810,940 bytes`

| Dimension | Before |
|---|---|
| Database recovery | 100 % |
| **Document recovery** | **0 %** — 2,445 document rows restored, 0 images |
| Audit-chain verifiability after bare-metal restore | **0 %** — key absent |
| Byte coverage | 0.62 % |

Restoring returned every record and not one passport scan. And P4.6's
verification reported **"Restorable"** — true of the database file, and
misleading about the system.

The **13 already-missing referenced images** are a second finding: database rows
pointing at files that no longer exist. Nothing in the product had ever detected
them.

---

## Phase 2 — Full system backup

`backup-YYYYMMDD-HHMMSS.zip`, built by a new zero-dependency ZIP writer:

```
backup-2026-07-30_08-39-20.zip     687.0 MB, 3 215 entries, 32.6 s
├── kd.db                          1.2 MB  (deflated from 4.3 MB)
├── uploads/…                      686.0 MB, 3 212 files (stored — already compressed)
├── audit-chain.key                64 B
└── manifest.json
```

Manifest carries everything the spec asked for — `created_at`, `app_version`,
`database_size`, `uploads_size`, `file_count`, `sha256`, `audit_chain_head` —
plus a **per-file SHA-256** and the list of referenced-but-missing images.

### Why ZIP, and why hand-rolled

The central directory sits at the end and indexes every entry by offset, so
verification can read `manifest.json` and check one file out of a 687 MB archive
without streaming all of it. With tar, every verify and preview would read 687 MB.

**The rule the container follows: a backup only this code can open is not a
backup.** No custom framing, no data descriptors, Zip64 only when required.
Verified, not assumed — the suite extracts with the OS's own tools:

| Tool | Result |
|---|---|
| PowerShell `Expand-Archive` | all entries extracted, SHA-256 identical to originals |
| Windows `bsdtar` | lists all entries, including 70,000 in the Zip64 case |
| Own reader | byte-identical round-trip, CRC-checked |

Two tiers are kept, **both labelled**: full packages (`.zip`) are the recovery
artefact; database snapshots (`.db`) remain because they take a second and are the
right pre-restore net for a database-only rollback. Health scoring treats a
`.db`-only estate as **critical**, so the UI can never again imply otherwise.

Orphans are backed up too: a file that looks orphaned because of a bug nobody has
found yet is not a file to discard while building a recovery.

---

## Phase 3 — Verification

Four independent checks, reported separately, on a **read-only** handle:

| Check | What it does |
|---|---|
| Database | extract → `PRAGMA integrity_check` → required tables → digest vs manifest |
| Audit chain | verifies the chain **inside the package, with the packaged key** |
| Uploads | presence of every manifest entry + CRC (sampled, or all in deep mode) |
| Manifest | required fields, and refusal of a **newer** `package_version` |

Three-valued status, and the middle value is the point:

| Status | Meaning |
|---|---|
| `fully-recoverable` | all four pass |
| `partially-recoverable` | database sound, but images or the chain incomplete |
| `corrupted` | database unusable, manifest unreadable, or checksum mismatch |

A package missing 40 images is not "corrupt" — it would still recover the
business, and collapsing that into one word would make an operator discard it.

**Real 687 MB package, deep-verified:** `fully-recoverable`, integrity `ok`,
3212/3212 present, **3212 CRC-checked**, 0 corrupt, chain 44/44 verified,
checksum matched — **9.6 s**. Verification leaves the file byte-identical (asserted).

---

## Phase 4 — Restore preview

Shown before committing: backup date, author, app version, database and upload
sizes, and per-entity **WILL GAIN / WILL LOSE** including image files.

Live example from the drill:

```
Package: backup-2026-07-30_08-40-55.zip
Taken:   30 Jul 2026, 15:40 · setup
Contents: 216 KB database + 100 KB images (4 files)
✓ Verified: fully recoverable
Record counts are identical
11 audit events are newer than this package — they are kept
A full backup of the current state is taken first
Everyone is signed out, including you — sign in again afterwards
```

Audit rows newer than the package are counted **separately** from losses: P4.5
carries them across and P4.6 re-anchors the chain, so calling them a loss would
train the operator to ignore the real warning.

That last line was added because of what the first UI-driven restore actually did
— see *Findings during implementation*.

---

## Phase 5 — Safe restore

| Guard | Why |
|---|---|
| Verify first | a corrupt package is refused, untouched system |
| Partial needs `allowPartial` | silently restoring a package with missing images rebuilds the false confidence P5.1 removed |
| **FULL pre-restore package** | you are overwriting 686 MB of images; a database snapshot cannot undo that |
| Stage outside live paths | database and uploads extracted and CRC-checked before anything live moves |
| Uploads swapped by rename | a crash mid-extraction leaves the live set untouched |
| Rollback on failure | uploads are renamed back if a later stage fails |
| Audit trail preserved | read out before the swap, merged after (P4.5 logic, reused not duplicated) |
| Chain re-anchored | ids change on merge; the rebuild is recorded (P4.6) |
| **Local key kept** | replacing a working key would orphan every integrity report already issued. The packaged key is installed **only** when the installation has none — bare-metal recovery |

Eleven reported stages; three audit events: `BACKUP_RESTORE_STARTED`,
`BACKUP_RESTORE_COMPLETED`, `BACKUP_RESTORE_FAILED`. Three, because a restore that
started and never completed is the thing an investigator most needs to find.

### Disaster recovery drill — total loss

Database rows deleted, entire upload tree removed, then restored:

```
ok verify · ok pre-restore-package · ok extract-database · ok extract-uploads
ok preserve-audit · ok swap-uploads · ok replace-database · ok audit-key
ok merge-audit · ok reanchor-chain · ok cleanup
```

- every record back
- every image file back, **byte-count exact**
- **every image's SHA-256 identical to the packaged original** (asserted per file)
- post-backup audit evidence survived
- chain verifies; rebuild recorded as an anchor
- working key kept; a keyless installation installs the packaged one (asserted)

---

## Phase 6 — Offsite (R2)

Infrastructure only, no scheduler, as instructed.

`r2.putFile()` **streams** from disk — `put()` takes a Buffer, which is right for a
photograph and wrong for a 687 MB package. SigV4 needs the payload digest up
front, and the backup writer already computed it, so the signature doubles as an
end-to-end integrity check: if the bytes on disk no longer match what was signed,
R2 rejects the upload rather than storing something we would later call verified.

Then it **reads the object back** (HEAD) and compares remote size and the
`x-amz-meta-sha256` we sent. Without that, "verified offsite" would mean "the PUT
returned 200".

Tracked per backup: upload time, key, bytes, remote size, remote checksum, status,
duration, actor. Audited as `BACKUP_OFFSITE_UPLOAD`.

Tested against a local endpoint standing in for R2, so the real path runs —
signing, streamed body, Content-Length, metadata, HEAD verification. Mocking the
fetch layer would only have proved the mock works.

---

## Phase 7 — Backup health dashboard

Score is **additive from zero**, not deductive from 100: this states what
protection *exists*, and starting at 100 would imply protection until proven
otherwise.

`full backup 40 · fresh ≤1d 15 · verified 20 · offsite verified 25`

The level is **capped, not merely reduced**: no full backup ⇒ `critical`, however
many snapshots exist.

Live reading on the real system:

```
level: critical   recoverability score: 75/100
counts: 1 full, 14 db-only
last full: 687 MB, 0 d old      verified: yes      offsite: none
findings: critical — no offsite copy
```

And with packages hidden — the exact state the product shipped in before P5.1:

```
level: critical   score: 0
findings: critical — no_full_backup  (only database snapshots exist,
                                      no document image is protected)
```

---

## Phase 8 — Retention

Configurable keep-N per kind, with protections that are structural rather than
remembered:

- the newest of each kind is never deleted
- the newest **verified** package is never deleted, even outside the keep window
- the newest package with a **verified offsite copy** is never deleted
- dry run first, and that is what the UI calls
- `BACKUP_RETENTION` audited with what it protected; a dry run logs nothing

The third rule matters most: without it, "keep the last 5" could delete the only
backup that exists in two places.

---

## Phase 9 — Testing

```
test-auth        80    test-p4       178    test-p51      155  ← new
test-session     81    test-p45      108    audit-coverage 32/32, 0 gaps
test-security    78    test-p46      115
test-mfa        127    test-rbac     179
                                            ────────────────────
                                            1101 passed, 0 failed
```

`test-p51` (155) covers: ZIP container incl. Zip64 and 4 corruption classes ·
package contents and manifest · four-part verification and all three statuses ·
preview gains/losses · restore refusals, staging, dry run · **the disaster drill
with per-file digest comparison** · R2 streamed upload with remote verification ·
retention protections · health scoring incl. the db-only trap · HTTP permissions
and the three restore lifecycle events.

No regressions: the 946 pre-existing assertions all still pass.

---

## Phase 10 — Final report

### Recovery architecture

```
zip.js              container (writer + random-access reader, Zip64, CRC32)
backup-package.js   create · verify · preview · restore        ← the recovery logic
admin.js            inventory · checksums · offsite · retention · health
r2.js               putFile (streamed, signed) · head (metadata)
server.js           7 routes, permission-mapped, all audited
admin-center.js     health dashboard, four-part report, preview dialog
```

### Coverage reports

| Report | Before | After |
|---|---|---|
| **Backup coverage** | database only, 0.62 % of bytes | database + 3,212 images + chain key = **100 %** |
| **Restore coverage** | records only; images unrecoverable | records + every image byte-identical; trail preserved; chain re-anchored |
| **Verification coverage** | file opens + integrity + checksum | + audit chain inside the package + per-file digests + manifest + 3-valued status |
| **Offsite** | none | streamed, signed, read back and verified, tracked, audited |

### Scores

| Score | Before | After | Basis |
|---|---|---|---|
| **Database recovery** | 100 | **100** | unchanged — it always worked |
| **Document recovery** | **0** | **100** | 3,212 files, per-file digests asserted in a live drill |
| **Business recovery** | 35 | **95** | records + images + settings + chain key recover together |
| **Production readiness** | 98 | **99** | recovery is now demonstrated rather than assumed |

Business recovery is 95, not 100: recovery has been proven on this machine, from a
backup on the same disk. The remaining 5 is the offsite gap below.

### Remaining risks

| Risk | Severity | Status |
|---|---|---|
| **No offsite copy on this installation** — R2 is not configured, so all 697 MB of backups sit on the disk they protect against | **Critical** | Code complete and tested; needs `R2_*` env vars. This is the one thing still standing between "backups exist" and "backups survive". |
| 13 database rows reference images that were already gone | Low | Now detected, recorded in every manifest, surfaced in verification |
| Backups are unencrypted | Medium | Deliberate: a key usable in a disaster must live where the backup lives. Stated, not implemented badly. |
| A restore signs everyone out | Low | Correct behaviour; now stated in the confirmation dialog |
| 697 MB per package, no incremental mode | Medium | Retention bounds local growth; incremental/dedup is P5.2 |
| Single volume for db + uploads + backups + key | **Critical** | Unchanged by code — the offsite copy is the mitigation |

---

## Findings during implementation

Three real bugs, all caught by driving the thing rather than reading it:

1. **`backup()` erased every package's metadata.** The manifest was pruned to
   `.db` files, so taking a database snapshot deleted each `.zip`'s author,
   checksum, verification result and offsite state.

2. **`putFile` ignored `R2_ENDPOINT`'s protocol.** Hardcoded `https`, making it
   the one operation that could not follow a configured endpoint.

3. **`applyRetention({keepFull: 0})` became 5.** `parseInt(v) || 5` swallows `0` —
   the same class of bug as the role-rank one in P4.6, and here `0` is precisely
   the value meaning "delete everything". Parsed explicitly, then clamped.

Plus two UI faults found only in the browser: verifying a package re-rendered the
pane and **destroyed the report** that had just been requested; and a restore
signed the operator out with no warning, which looks exactly like a failure.

---

## Files

**New:** `infra/zip.js` (400), `infra/backup-package.js` (760),
`infra/scripts/test-p51.js` (600), `docs/p51-disaster-recovery.md`

**Modified:** `infra/admin.js` (inventory, offsite, retention, health),
`infra/r2.js` (`putFile`, `head` metadata), `infra/repo.js` (6 audit actions),
`shell/server.js` (7 routes), `shell/scripts/db.js` (9 wrappers),
`shell/scripts/admin-center.js` (dashboard, report, preview),
`shell/styles/admin.css`, `package.json`

### One action for the operator

```bash
# Configure offsite storage — the last critical gap
setx R2_ACCOUNT_ID "…"; setx R2_ACCESS_KEY_ID "…"
setx R2_SECRET_ACCESS_KEY "…"; setx R2_BUCKET "kd-backups"
```

Then **Settings → Backup & Restore → Send offsite**. The dashboard moves from
*critical* to *healthy* once a verified copy exists off the volume.

`data/backups/` currently holds the first real full package (687 MB) plus 14
database snapshots — 697 MB total. Retention (keep 5 full / 10 db) will trim the
snapshots without touching the newest or verified packages.

P5.2 and compliance work have not been started.
