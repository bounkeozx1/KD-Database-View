# KD Database — Code Map

> **Code map คืออะไร?**
> เอกสารนี้ตอบคำถาม _"ถ้าจะแก้ X ต้องไปไฟล์ไหน?"_
> ต่างจาก `ARCHITECTURE.md` ที่อธิบาย _ทำไม_ และ _อนาคต_ —
> codemap เน้น _ตอนนี้มีอะไร · อยู่ที่ไหน · เรียกหากันยังไง_

---

## โครงสร้างโฟลเดอร์ (one-line ต่อไฟล์)

```
kd-database/
│
├── index.html                          redirect → shell/pages/login.html
├── package.json                        npm scripts (start / init-db / backup / selftest …)
│
├── shell/                              ทางเข้าทั้งหมด (server + UI หลัก)
│   ├── server.js                       HTTP server + REST API + static file serving
│   ├── pages/
│   │   ├── login.html                  หน้าล็อกอิน
│   │   └── index.html                  แดชบอร์ดหลัก (ตาราง + modals + sidebar)
│   ├── scripts/
│   │   ├── db.js                       Data layer — dual-mode (API ↔ localStorage)
│   │   ├── app.js                      UI logic ทั้งหมด (render / events / modals)
│   │   └── i18n.js                     ข้อความ 4 ภาษา: en / th / lo / ko
│   └── styles/
│       ├── main.css                    สไตล์หลัก (sidebar, cards, modals)
│       └── sidebar.css                 sidebar layout
│
├── domains/                            โดเมนที่แยกอิสระแล้ว
│   └── recruitment/
│       ├── passport-scan/
│       │   └── passport-scan.js        กล้อง + OCR (Tesseract) + MRZ parser + auto-fill
│       └── intake-import/
│           └── pptx-import.js          นำเข้ารายชื่อจาก PowerPoint (JSZip)
│
├── infra/                              persistence/IO — ไม่มี business logic
│   ├── db.js                           SQLite connection + schema + seed data
│   ├── repo.js                         Repository (SQL ทั้งหมดอยู่ที่นี่)
│   ├── files.js                        บันทึก/ลบไฟล์อัปโหลด (data/uploads/)
│   ├── admin.js                        backup / restore / reset
│   └── scripts/
│       ├── init-db.js                  สร้าง schema + seed (ไม่ทำลายข้อมูลเดิม)
│       ├── backup.js                   สำเนา DB → data/backups/kd-<ts>.db
│       ├── restore.js                  คืนค่าจาก backup file
│       ├── reconcile.js                ตรวจ orphan/missing/invalid files
│       └── selftest.js                 CRUD + upload integrity tests (14 เคส)
│
├── vendor/                             ไลบรารี offline (ไม่พึ่ง CDN)
│   ├── tesseract/                      Tesseract.js + worker + core.wasm + eng.traineddata.gz
│   ├── jszip/                          jszip.min.js
│   ├── pdf-lib/                        pdf-lib.min.js + fontkit.umd.min.js (โหลด lazy ตอน export PDF)
│   └── fonts/                          Inter · Noto Sans Lao · Noto Sans KR (woff2) + fonts.css
│       └── ttf/                        Noto Sans / Thai / Lao (Regular+Bold TTF — ฝังใน PDF export)
│
└── data/                               ข้อมูลจริง — git-ignored
    ├── db/kd.db                        SQLite database (+ kd.db-wal + kd.db-shm ตอน server รัน)
    ├── uploads/                        ไฟล์ที่อัปโหลด (photos / passports / id-cards / documents)
    ├── backups/                        kd-<timestamp>.db
    └── reports/                        reconcile-<timestamp>.json
```

---

## "ถ้าจะแก้ X ต้องไปไฟล์ไหน?"

| อยากแก้อะไร | ไฟล์ |
|---|---|
| เพิ่ม/แก้ column ในตาราง | `infra/db.js` → `SCHEMA` |
| เพิ่ม employer / city / user เริ่มต้น | `infra/db.js` → `DEFAULT_*` |
| แก้ SQL query หรือ business rule บน server | `infra/repo.js` |
| แก้วิธีบันทึก/ลบไฟล์อัปโหลด | `infra/files.js` |
| เพิ่ม REST endpoint ใหม่ | `shell/server.js` → `handleApi()` |
| แก้ UI render / modal / event handler | `shell/scripts/app.js` |
| แก้วิธีเรียก API หรือ localStorage | `shell/scripts/db.js` |
| เพิ่มข้อความ / แปลภาษา | `shell/scripts/i18n.js` |
| แก้สีหรือ layout | `shell/styles/main.css` / `sidebar.css` |
| แก้ OCR / passport scan | `domains/recruitment/passport-scan/passport-scan.js` |
| แก้การนำเข้า PPTX | `domains/recruitment/intake-import/pptx-import.js` |
| แก้ export (XLSX/PPTX/PDF/CSV/.kdb) | `shell/scripts/app.js` → `_doExportXlsx` / `_kdCardSlideXml`+`_buildPptx` / `_doKdCardPdfFile`+`_doWorkerDetailPdf` — ทุกฟอร์แมตเป็น native แก้ไขได้ (PPTX = text box + ตารางจริง, PDF = ฝังฟอนต์ไทย/ลาว), geometry การ์ดใช้ `_KD_GEO` ร่วมกัน · ทุกไฟล์ออกทาง `_emitExport()` ที่เดียว |
| แก้ Export Package (โฟลเดอร์ต่อคน + รูป + เอกสารทุกเวอร์ชัน) | `infra/export-package.js` (สร้าง zip ฝั่ง server) · `shell/server.js` → `/api/export/package/*` · `shell/scripts/app.js` → `_doExportPackage` — ดู `docs/p6-export-package.md` |
| แก้การเลือกคนทีละหลายคน (checkbox + แถบ Export/ย้าย/ถังขยะ) | `shell/scripts/app.js` → `_pick` / `_pickBox` / `renderPickBar` — คนละอย่างกับดาว `selected_uids` |
| ⚠ แก้กฎที่ **เบราว์เซอร์กับเซิร์ฟเวอร์ต้องตรงกัน** | `infra/age.js` (อายุ) · `infra/csv.js` (quote + BOM + กัน formula injection) · `infra/safe-name.js` (ชื่อไฟล์) · `infra/doc-cats.js` (หมวดเอกสารตั้งต้น) — ไฟล์เดียวกัน เบราว์เซอร์โหลดเป็น `<script>`, Node ใช้ `require()` · **ห้ามก็อปไปเขียนซ้ำ** `npm run test-shared` จะ fail |
| เพิ่มไลบรารี offline | `vendor/` + แก้ path ใน JS ที่ใช้ |
| แก้ backup / restore | `infra/admin.js` |
| แก้ npm script | `package.json` |

---

## Data Flow: UI → API → Database

```
Browser (shell/pages/index.html)
  │
  └─ shell/scripts/app.js          ← UI events, render, modal
        │  calls DB.*()
        ▼
     shell/scripts/db.js           ← in-memory cache + write queue + retry
        │
        ├─ mode = "local"          → localStorage  (ไม่มี server)
        │
        └─ mode = "api"            → fetch /api/*
              │
              ▼
           shell/server.js         ← HTTP routing
              │
              ├─ /api/bootstrap → repo.getBootstrap()
              ├─ /api/login     → repo.login()
              ├─ /api/groups/*  → repo.createGroup / updateGroup / deleteGroup
              ├─ /api/…/employees/* → repo.addEmployee / updateEmployee / deleteEmployee
              ├─ /api/cities/*  → repo.addCity / deleteCity
              ├─ /api/users/*   → repo.addUser / deleteUser
              └─ /api/admin/*   → admin.backup / restore / reset
                    │
                    ▼
                 infra/repo.js     ← SQL ทั้งหมด
                    │
                    ├─ infra/db.js        ← SQLite connection (data/db/kd.db)
                    └─ infra/files.js     ← data:URL → data/uploads/<uuid>.ext
```

---

## Data Flow: อัปโหลดไฟล์/รูป

```
Browser: user เลือกรูป / สแกน OCR
  → app.js: เก็บเป็น data:image/jpeg;base64,…
  → DB.updateWorker(…, { photo: "data:…" })
  → db.js _push() → PATCH /api/employees/:uid  { photo: "data:…" }
  → server.js → repo.updateEmployee()
  → repo.js: saveDataUrl(data, 'photo')
  → files.js: base64 decode → data/uploads/employee-photos/<uuid>.jpg
             return "/uploads/employee-photos/<uuid>.jpg"   ← เก็บใน DB
  → server.js serveStatic: URL /uploads/… → data/uploads/… บนดิสก์
```

---

## Schema ฐานข้อมูล (infra/db.js)

```
users          id · username · password(scrypt) · role(admin|viewer) · name
sessions       token(PK) · username · created_at · last_seen · expires_at
               (ออกตอน login สำเร็จ; 12 ชม. หรือ 30 วันถ้าติ๊ก "keep me logged in")
employers      code · name
cities         id · country(kr/la) · code · name
groups         id · name · departure · route · pinned · archived · sort_order
employees      uid · group_id(FK) · worker_id · employer_code · en_name · lo_name
               dob · village · nationality · sex · blood · hand · weight · height
               size · couple · tel · emg_tel · kr_city · la_city
               photo_path · sort_order
passports      id · employee_uid(FK,UNIQUE) · passport_no · issue_date · expiry_date
documents      id · employee_uid(FK) · category · file_path · type · name

FK CASCADE: groups→employees→passports, groups→employees→documents
```

---

## API Endpoints (shell/server.js)

**สิทธิ์ (ทุก endpoint):** เปิดสาธารณะเฉพาะ `/api/health` กับ `/api/login` —
ที่เหลือต้องมี session cookie ที่ได้จากการ login จริงเท่านั้น
(ไม่มี → 401) และทุก **write** (POST/PATCH/DELETE) ต้องเป็น `role=admin`
(ไม่ใช่ → 403). ไฟล์ใน `/uploads/…` ก็ต้อง login เช่นกัน

```
GET    /api/bootstrap               โหลดข้อมูลทั้งหมด + me (ผู้ใช้ที่ login อยู่)
POST   /api/login                   { username, password, remember } → { ok, user } + Set-Cookie
POST   /api/logout                  ลบ session ปัจจุบัน
GET    /api/me                      → { ok, user } (role ล่าสุดจากฐานข้อมูล)
POST   /api/import                  migrate localStorage → SQLite (first-run)

POST   /api/groups                  สร้าง group ใหม่
PATCH  /api/groups/:id              แก้ชื่อ/departure/route/pin/archive
DELETE /api/groups/:id              ลบ group + employees ทั้งหมด (cascade)
POST   /api/groups/:id/employees    เพิ่ม employee ใหม่

PATCH  /api/employees/:uid          แก้ข้อมูล employee (รวม photo + documents)
DELETE /api/employees/:uid          ลบ employee + ไฟล์บนดิสก์ + passport + documents

POST   /api/cities                  { country, code, name }
DELETE /api/cities/:country/:code

POST   /api/users                   { username, password, role, name }
DELETE /api/users/:username

POST   /api/admin/backup
GET    /api/admin/backups
POST   /api/admin/restore           { file: "kd-…db" }
POST   /api/admin/reset
```

---

## Public API ของ shell/scripts/db.js

```js
await DB.init()                   // boot: ลอง API → fallback localStorage; คืน "api"|"local"
DB.mode()                         // "api" | "local"

// กลุ่ม
DB.getGroups()                    // [] ของ group object (sync, จาก cache)
DB.getGroup(id)
DB.createGroup(group)             // return id
DB.updateGroup(id, patch)
DB.deleteGroup(id)

// พนักงาน
DB.getWorkers(groupId)
DB.addWorker(groupId, worker)     // return uid
DB.updateWorker(groupId, uid, patch)
DB.deleteWorker(groupId, uid)

// เมือง
DB.getCities()                    // { kr: [], la: [] }
DB.addCity(country, { name, code })
DB.deleteCity(country, code)

// Auth — สิทธิ์ทั้งหมดมาจากการ login (username + password) เท่านั้น
await DB.login(username, password, remember)  // ตั้ง session cookie (HttpOnly) ฝั่ง server
                                              // return user | null, throw code
                                              // 'too-many-attempts' เมื่อโดนล็อก
await DB.logout()                 // ลบ session ทั้งฝั่ง server + cookie
DB.getCurrentUser()               // { username, role, name } ตามที่ "server" บอก (จาก /bootstrap)
await DB.refreshCurrentUser()     // ถาม /api/me ใหม่ (เช่น role เพิ่งถูกเปลี่ยน)
DB.isAdmin()
DB.onAuthLost(cb)                 // session หมดอายุ/ถูกเพิกถอนกลางคัน
DB.getUsers()                     // admin เท่านั้นที่เห็นทั้งหมด (viewer เห็นแค่ตัวเอง)

// Admin
await DB.backup()
await DB.listBackups()
await DB.restore(file)
DB.hardReset()

// Save status (UI feedback)
DB.onSaveStatus(cb)               // cb({ event, pending, failed, mode })
DB.hasUnsaved()                   // true ถ้ายังมี write ค้างอยู่
DB.pendingCount() / failedCount()
await DB.flush()                  // รอ write queue ว่าง
```

---

## npm Scripts

```
npm start                    node shell/server.js → http://localhost:3000
npm run init-db              สร้าง/ตรวจสอบ schema + seed (ปลอดภัย ทำซ้ำได้)
npm run backup               → data/backups/kd-<ts>.db
npm run restore -- <file>    คืนค่า backup
npm run reconcile            ตรวจไฟล์ ⇄ DB (ดูด้านล่าง)
npm run selftest             ทดสอบ 14 เคส CRUD + upload (ไม่กระทบข้อมูลจริง)
```

### reconcile flags

```
npm run reconcile                          รายงานอย่างเดียว (ปลอดภัย)
npm run reconcile -- --delete-orphans      ลบไฟล์ที่ไม่มี DB row อ้างถึง
npm run reconcile -- --prune-missing       ล้าง DB row ที่ไฟล์หายไปแล้ว
npm run reconcile -- --json                output เป็น JSON (machine-readable)
```

---

## Domains ที่แยกออกมาแล้ว

### passport-scan.js
- โหลด Tesseract จาก `vendor/tesseract/` (offline)
- `SCAN.startCamera()` → `SCAN.capture()` → `SCAN.readMrz()` → return parsed MRZ fields
- app.js เรียก `SCAN.*` โดยตรง; ผลลัพธ์ auto-fill ลงฟอร์ม

### pptx-import.js
- โหลด JSZip จาก `vendor/jszip/` (offline)
- `PPTX.importFile(file)` → return `[{ en_name, lo_name, … }]`
- app.js เรียก `PPTX.importFile()` แล้ว bulk-addWorker

---

## Path สำคัญที่ต้องระวัง

| สิ่ง | Path |
|---|---|
| URL `/uploads/…` บน browser | จริงๆ อยู่ที่ `data/uploads/…` บนดิสก์ (server rewrite ใน `shell/server.js:49`) |
| HTML pages อยู่ depth-2 | `shell/pages/*.html` → `../../vendor/…` ชี้ถูกต้อง → **อย่าย้ายไป depth อื่น** |
| `infra/db.js` ROOT | `__dirname/..` = root ของ project |
| DB path | `data/db/kd.db` (สร้างเองอัตโนมัติ) |
| Uploads path | `data/uploads/{employee-photos,passports,id-cards,documents}/` |
| Backups path | `data/backups/` |
| Reports path | `data/reports/` |

---

## Bento Choice — ตัวเลือก (choice) ทั้งแอปใช้อันเดียวกัน

ทุกที่ที่ผู้ใช้ "เลือก" ต้องเป็น **tile เดียวกัน** (ยืมเปลือกจากหน้ารายละเอียดแรงงาน:
`var(--card)` + `--hairline` + `--shadow-sm` + ยกตัวตอน hover) ตัวที่เลือกอยู่ =
**ขอบ accent + วงในสี accent + เครื่องหมายถูกมุมขวา** — ห้ามคิดสถานะใหม่ขึ้นมาอีก

```html
<div class="bento-choice bc-lang" data-cols="4">      <!-- bc-chip / bc-center / bc-tight / bc-inline -->
  <button class="bc-tile selected">
    <span class="bc-glyph">ກ</span>                   <!-- ตัวอักษร หรือ SVG -->
    <span class="bc-name">ລາວ</span>
    <span class="bc-code">LO</span>
    <svg class="bc-check">…</svg>
  </button>
</div>
```

```js
bcGroup(el, items, current, onPick)   // สร้าง tile จาก list  (items: {v,glyph,name,code})
bcMark(el, current)                   // ย้ายตัวที่เลือก โดยไม่สร้างใหม่
bentoizeSelect(id, {chip, cols})      // อัพเกรด <select> เดิม → tile
bcSync(id) / bcSyncAll()              // วาดใหม่หลังโค้ดเปลี่ยน value/options หรือเปลี่ยนภาษา
BC_LANGS                              // ภาษาทั้ง 4 — flyout / Settings / login ใช้ตัวนี้ร่วมกัน
```

**กฎเลือกรูปแบบ:** รายการสั้นและคงที่ (≤8 ตัว, เพศ/มือ/ไซส์/เกรด/เลือด/สิทธิ์) → tile;
รายการยาวหรือเติมตอน runtime (เมือง, กลุ่ม, นายจ้าง, หมวดเอกสาร) → `<select class="bento-field">`
คือ select จริงแต่ใส่เปลือก bento เดียวกัน

⚠ `bentoizeSelect` **ไม่ลบ** `<select>` เดิม — ซ่อนไว้ (`.bc-source`) เป็นตัวเก็บค่า ดังนั้น
`getElementById('f-sex').value`, การบันทึก, ตัวกรอง และ export ทำงานเหมือนเดิมทุกจุด
ถ้าโค้ดตั้ง `.value` เองแบบไม่ยิง event ต้องเรียก `bcSyncAll()` ตามหลัง (เช่นท้าย `openWorkerForm`)
