# P6 — Export Package

Export changed from *"here is a file of the data"* to *"here is a folder per
worker, with their photograph and their papers in it"* — for a chosen subset of
people, not a whole group.

**1210/1210 tests pass**, of which 98 are the two suites added here. Zero npm
dependencies — still.

---

## The problem

Every export the product had produced one flat artefact: a spreadsheet, a card
PDF, a deck, or a ZIP of documents named by category. None of them answered the
question the office actually asks, which is *"give me everything we hold on
these seven people"*.

Three specific gaps:

| | Before | Consequence |
|---|---|---|
| **Choosing people** | Whole group, or the current filter, or one worker from their drawer | "workers 1, 2 and 7" was not expressible. The filter had to be bent until it happened to show the right rows. |
| **Photographs** | Never exported except rasterised into a card | The original scan — the file the embassy wants — could only be got by opening each worker and saving the image by hand. |
| **Document history** | `docs` exported the CURRENT version only, in a flat `<name>/<category>_v<n>.<ext>` layout | Superseded passports and earlier forms were unreachable. |

And a fourth, structural: everything was built in the browser. A group of fifty
is several hundred megabytes of scans, which meant downloading every file
through the page, holding the archive in memory, and losing all of it if the tab
was closed.

---

## The spec

Agreed with the operator before any code, as twenty questions. The answers that
shaped the design:

| | Decision |
|---|---|
| Selecting people | Checkboxes directly in the list, remembered while the page is open, one group at a time |
| The same selection drives | Export, Move to group, Trash |
| Contents | Full-resolution profile photo **+ every version of every document** |
| Version layout | One folder per version |
| Folder name | `EnglishName_workerId_YYYY-MM-DD` — worker ID, and the date of the export |
| Missing files | Skipped silently during the build, **summarised at the end** |
| Where it runs | On the server, one download link |
| Who may run it | Admin only |
| Other formats | In the same archive |

---

## Phase 1 — Selecting people

A checkbox in all three views (table, KD cards, photo cards), and a bar that
appears once anything is ticked.

```
┌──────────────────────────────────────────────────────────────────┐
│  3  selected   [1,2,7-10] Add  Results  All  Starred             │
│                              ⤓ Export   Move   Trash        ✕    │
└──────────────────────────────────────────────────────────────────┘
```

Two details worth recording:

**The unticked checkbox shows the row's number.** The operator asked for a way
to type "1, 2, 7-10". A box that counts row positions is useless if the rows are
not numbered, so the control does both jobs: position when off, tick when on.

**It is NOT the star.** The product already had a per-worker selection — the
amber star, `selected_uids` in `app_settings`, meaning *"this person is going"*.
That is a lasting business decision that travels with a backup. Reusing it would
have meant every export selection silently rewrote the shortlist. The new set is
separate, held in `sessionStorage`, and **pruned against the current list**
whenever the group changes — a uid carried over from another group would act on
a record the user can no longer see.

### Moving between groups did not exist

`repo.updateEmployee` writes `EMP_COLS`, and `group_id` is not one of them — it
was only ever written by `addEmployee`. A worker could be created into a group
and never leave it. Bulk Move made that gap load-bearing, so `updateEmployee`
now accepts a move, and only to a group that exists and is not in the trash. It
is logged on the worker **and on both groups**, because "where did this person
go" is asked from either side.

---

## Phase 2 — The archive

**One download, one folder.** The archive holds a single top-level folder and
everything sits inside it, so "extract here" produces one thing to move rather
than a dozen worker folders and two loose files spilled into whatever directory
the operator was standing in.

```
KD-Export_DAM-2026_2026-08-03.zip       ← what the browser saves
└── KD-Export_DAM-2026_2026-08-03/      ← the ONE folder you get
    ├── data/                            everything ABOUT the export
    │   ├── manifest.txt                 who, when, and what was skipped
    │   ├── summary.csv                  one row per worker — first column is the folder
    │   ├── DAM-2026.xlsx                the reports the browser made (Phase 4)
    │   └── DAM-2026.pdf
    ├── Somchai-Keo_KD-2026-001_2026-08-03/     one folder per PERSON
    │   ├── photos/
    │   │   └── profile_Somchai-Keo.jpg  photo_orig — the original, not the thumbnail
    │   └── documents/
    │       └── passport/
    │           ├── v3-current/  passport_Somchai-Keo_v3.jpg
    │           ├── v2/          passport_Somchai-Keo_v2.jpg
    │           └── v1/          passport_Somchai-Keo_v1.jpg
    └── ນາງ-ວິໄລ-ພົມມະ_KD-2026-002_2026-08-03/
        └── documents/id_card/v1-current/id_card_ນາງ-ວິໄລ-ພົມມະ_v1.png
```

**Two kinds of thing, two places.** The top level holds one folder per person
and `data/`, and nothing else. Everything that describes the export rather than
a worker — the manifest, the summary spreadsheet, whatever reports were ticked —
lives in `data/`, so somebody opening the package sees the people first instead
of hunting for a name among loose files. `data/` owns the names `manifest.txt`
and `summary.csv`: an uploaded report called `summary.csv` is renamed rather
than allowed to take their place.

The name the user sees carries no machine noise. On the server the file keeps a
short id (`…_9f07cf45.zip`) so two exports of the same group on the same day
cannot overwrite each other while both are still live, but the download is
renamed to the clean form on the way out — and, because a group name can be Lao
or Thai, it is sent as RFC 5987 `filename*` so it arrives unmangled.

Built with `infra/zip.js`, the writer P5.1 introduced for backups. Images and
PDFs are **stored, not deflated** — they are already compressed, and deflating
686 MB of JPEGs burns minutes of CPU to save nothing. The CSV and the manifest
are deflated.

### Decisions

**R2 is not optional.** Once a file has been offloaded its local copy is freed,
so a package built from disk alone would quietly omit exactly the older
documents most likely to be wanted — and would look complete. `readUpload()`
tries disk, then R2, then records a gap.

**Unicode names are kept.** Only the characters Windows genuinely refuses are
replaced, and `zip.js` already flags entry names as UTF-8. Verified by extracting
with Windows' own `Expand-Archive`, not only with our reader:

```
KD-Export_Unzip-Test_2026-08-03\ນາງ-ວິໄລ-ພົມມະ_KD-U-002_2026-08-03\documents\id_card\v1-current\id_card_ນາງ-ວິໄລ-ພົມມະ_v1.png
```

**A worker with nothing on file still gets a folder.** An empty directory entry,
noted in the manifest. A missing folder reads as *"I forgot to tick them"*; an
empty one says *"there is nothing on file for them"*.

**`summary.csv` leads with the folder name.** Without it the spreadsheet and the
folders are two unrelated lists.

### Why a job, not a request

The site is served through a Cloudflare tunnel, which cuts an origin request at
about 100 seconds. So `POST` starts the build and returns an id; the browser
polls, then downloads.

```
POST /api/export/package                 { uids, options, attachments } → { job }
GET  /api/export/package/<id>            progress
POST /api/export/package/attach          one browser-made report (raw bytes)
GET  /api/export/package/<id>/download   the archive
```

The attach route is the only one in the product whose body is **not** JSON, and
its body is deliberately read *after* the session and permission are checked —
an unauthorised caller must not be able to make the server swallow sixty
megabytes before being told no.

---

## Phase 3 — Authorisation and the trail

A new permission, `export.package`, granted to Admin only.

It is separate from `export.bundle` and that is not bureaucracy. A `.kdb` bundle
is a restorable archive of the app's own making; this produces **loose, readable
passport scans in named folders** — the form in which a leak is immediately
usable. A Manager holds `export.pdf` and `export.excel` and can already extract a
spreadsheet of every worker; what they must not be able to do is ask the server
to assemble everybody's papers.

| Check | Where |
|---|---|
| All four routes require `export.package` | `requiredPermission()`, checked before the format table |
| A job may only be polled or downloaded by the account that started it | `status()` / `fileFor()` |
| A staged upload may only be claimed by its uploader | `claimAttachments()` |
| Served `attachment` + `no-store`, never inline | download route |
| Building recorded as `DATA_EXPORT` (`format=package`) | on start, not on finish |
| Downloading recorded as `EXPORT_PACKAGE_DOWNLOAD` | its own event |

The download is a separate event on purpose: it happens later, often in a
different session, and it is the download — not the build — that puts loose
scans on somebody's laptop.

**Packages are deleted after 24 hours.** They are a delivery mechanism, not
storage. Swept on boot, every six hours, and before each new build, so a crash
at the wrong moment cannot leave an archive of everyone's documents on disk with
nothing left that knows to remove it. Unclaimed uploads age out after an hour.

---

## Phase 4 — The browser's own files

The spreadsheet, the card PDF and the deck are generated in the page by
`pdf-lib` and a hand-rolled OOXML writer. Reimplementing either on the server
would mean two copies of the same layout drifting apart, so the split follows the
bytes: **the megabytes stay on the server, the kilobytes travel.** The browser
builds its reports, uploads them, and they land in `data/` beside the manifest
and the summary.

This replaced six copies of the same four lines — `createObjectURL`, anchor,
click, revoke — with one exit point:

```js
function _emitExport(data, filename, mime) {
  if (_exportCapture) { _exportCapture.push({ name: filename, blob }); return; }
  …download…
}
```

Capture is per-format and reset in a `finally`. Left on, every later export in
the session would silently produce no file at all — so that path is tested
explicitly, by making a generator throw mid-capture.

Two formats are deliberately left out of the archive: `docs`, because the
package already contains every document by category and version, and `kdb`,
because a restorable bundle of the whole group is a different artefact with a
different audience and would dwarf the package.

---

## Findings during implementation

Five real defects, every one caught by driving the code rather than reading it:

1. **The `NOID-` fallback never fired.** `safeSegment(worker_id, '')` returns its
   *fallback* for an empty id, and the fallback was `''` — falsy, so the
   `|| 'NOID-…'` after it was dead. Every worker without an ID would have been
   filed as `Name_item_date`.

2. **A worker with no files got no folder**, because nothing was ever written
   under it.

3. **`expiresAt` was not exactly 24 hours after `createdAt`** — two clock reads a
   millisecond apart.

4. **Ticking "Age", "Visa", "Couple" or "Hand" produced no column.** The field
   picker and the builder's column list were written separately and disagreed. A
   test now asserts every key the picker offers has a column, so they cannot
   drift again.

5. **`sweep()` tried to `unlink` the staging directory**, silently failing every
   pass once attachments existed.

---

## Testing

```bash
npm run test-export-package    # 87 assertions
npm run test-group-move        # 11 assertions
npm test                       # 1210 total, 0 failed
```

`test-export-package.js` builds real archives from real records and reopens them
to check what actually landed inside — layout, version folders, Lao names,
Windows-reserved names, path traversal in an upload filename, per-entry CRC — and
then drives all four routes over HTTP as three different roles. The HTTP section
is the part that matters most: it is what keeps a Manager refused if the route
table is ever edited.

---

## Known limits

| | Severity | Status |
|---|---|---|
| Jobs live in memory — a restart loses progress and orphans the file until the next sweep | Low | The sweep covers the file; the operator re-runs the export |
| No pause/resume or cancel | Low | A build of a realistic selection is seconds to a minute |
| 500 workers per package | Low | Deliberate ceiling; the largest group on the live system is under 900 in total |
| The archive is unencrypted | Medium | Same trade P5.1 recorded: a key usable in the field would have to travel with the file |
| Attachments cap at 64 MB each | Low | A 500-card PDF is the realistic worst case and sits well under it |
| `summary.csv` and a ticked CSV export are both in the archive | Low | They differ — only `summary.csv` carries the folder column |

---

## Files

**New:** `infra/export-package.js` (712), `infra/scripts/test-export-package.js`
(476), `infra/scripts/test-group-move.js` (83), `docs/p6-export-package.md`

**Modified:** `shell/scripts/app.js` (selection, capture, the job driver),
`shell/scripts/db.js` (4 wrappers), `shell/scripts/i18n.js` (46 keys × 4
languages), `shell/server.js` (4 routes, raw-body handling, retention sweep),
`infra/repo.js` (group moves, 1 audit action), `infra/rbac.js`
(`export.package`), `shell/styles/main.css`, `shell/pages/index.html`,
`package.json`
