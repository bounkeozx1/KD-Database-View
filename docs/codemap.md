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
│   └── fonts/                          Inter · Noto Sans Lao · Noto Sans KR (woff2) + fonts.css
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
users          id · username · password · role · name
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

```
GET    /api/bootstrap               โหลดข้อมูลทั้งหมด (groups + workers + cities + users)
POST   /api/login                   { username, password } → { ok, user }
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

// Auth
await DB.login(username, password)  // return user object | null
DB.logout()
DB.getCurrentUser()               // อ่าน sessionStorage
DB.getUsers()

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
