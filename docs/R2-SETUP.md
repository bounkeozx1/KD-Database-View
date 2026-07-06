# ย้ายไฟล์รูป/เอกสารไป Cloudflare R2 (แก้ volume เต็ม)

เป้าหมาย: ย้ายไฟล์ใน `uploads/` (รูปพนักงาน, พาสปอร์ต, บัตร, เอกสาร) ออกจาก volume
ของเซิร์ฟเวอร์ไปเก็บบน Cloudflare R2 เพื่อให้ volume ไม่เต็มอีก **โดยไม่มีข้อมูลหาย
และไม่บีบอัด (เก็บไฟล์ต้นฉบับ byte-for-byte)**

หลักการทำงาน (โหมด "local-first แล้วค่อย offload"):
- ตอนอัปโหลด ไฟล์ยังลงดิสก์ในเครื่องปกติ (โค้ดบันทึกเดิมไม่เปลี่ยน — ปลอดภัยสุด)
- เบื้องหลัง ระบบจะ **อัปไฟล์ขึ้น R2 → ตรวจสอบขนาดให้ตรง → แล้วค่อยลบไฟล์ในเครื่อง**
  (ไม่มีวันลบไฟล์ในเครื่องจนกว่าจะยืนยันว่าอยู่บน R2 ครบ)
- ตอนเปิดดูรูป ถ้าไฟล์ในเครื่องถูกย้ายไปแล้ว เซิร์ฟเวอร์จะดึงจาก R2 มาให้ (proxy)
  → **bucket เป็น private เสมอ พาสปอร์ต/เอกสารไม่หลุดสาธารณะ**
- ถ้ายังไม่ตั้งค่า R2 หรือ R2 ล่ม → ทุกอย่างทำงานเหมือนเดิม (เสิร์ฟจากดิสก์) ไม่พัง

---

## ขั้นตอน

### 0) สำรองข้อมูลก่อน (ตาข่ายกันพลาด)
เปิดแอป → Settings → Export `.kdb` (มีรูปครบทุกไฟล์) เก็บไว้ 1 ชุด

### 1) สร้าง Bucket บน Cloudflare
1. Cloudflare Dashboard → **R2** → **Create bucket**
2. ตั้งชื่อ เช่น `kd-uploads` — **เก็บเป็น private (อย่าเปิด public access)**
3. จด **Account ID** (อยู่หน้า R2 Overview / มุมขวา)

### 2) สร้าง R2 API Token
1. R2 → **Manage R2 API Tokens** → **Create API Token**
2. Permission: **Object Read & Write**  (จำกัดเฉพาะ bucket `kd-uploads` ได้ยิ่งดี)
3. Create แล้วจะได้ **Access Key ID** และ **Secret Access Key** (คัดลอกเก็บทันที เห็นครั้งเดียว)

### 3) ตั้ง Environment Variables บน Railway
Railway → โปรเจกต์ → service → **Variables** → เพิ่ม:

| ชื่อ | ค่า |
|------|-----|
| `R2_ACCOUNT_ID`        | Account ID จากข้อ 1 |
| `R2_ACCESS_KEY_ID`     | Access Key ID จากข้อ 2 |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key จากข้อ 2 |
| `R2_BUCKET`            | `kd-uploads` |

(ไม่ต้องตั้ง `R2_ENDPOINT` — ระบบจะใช้ `https://<account>.r2.cloudflarestorage.com` เอง)

Railway จะ redeploy อัตโนมัติ

### 4) ตรวจว่าเปิดใช้แล้ว
- ดู Deploy Logs ต้องเห็น: `R2 offload → ENABLED (bucket "kd-uploads")`
- หรือเรียก `GET /api/admin/storage` → ต้องได้ `"r2": { "enabled": true, ... }`

หลังจากนี้ **ไฟล์เก่าจะทยอยย้ายขึ้น R2 เองอัตโนมัติ** (ทีละชุดทุก 5 นาที) แต่จะช้า
ถ้าอยากย้ายก้อนเก่า (~200MB) ให้จบเร็ว ทำข้อ 5

### 5) ย้ายไฟล์ก้อนเก่าให้จบทีเดียว (เลือกทำอย่างใดอย่างหนึ่ง)
- **ผ่าน Railway shell:**
  ```
  node --experimental-sqlite infra/scripts/migrate-uploads-to-r2.js
  ```
  (resumable — รันซ้ำได้ ถ้ามี error จะข้ามไฟล์ที่สำเร็จแล้ว)
- **หรือเรียก API เป็นชุดๆ:** `POST /api/admin/offload` (body ว่าง = ย้ายทั้งหมด,
  หรือ `{"limit": 100}` = ย้าย 100 ไฟล์ต่อครั้ง)

### 6) เก็บกวาดพื้นที่คืน (ปลอดภัย ไม่แตะข้อมูลจริง)
`POST /api/admin/cleanup` body:
```json
{ "orphans": true, "vacuum": true, "pruneKeep": 20 }
```
- `orphans`  = ลบไฟล์ในเครื่องที่ไม่มี row ใน DB อ้างถึง (~26MB) — ตรวจกับ DB ก่อนลบ
- `vacuum`   = บีบ `kd.db` คืนพื้นที่จาก trash/เวอร์ชันเอกสารที่ลบ
- `pruneKeep`= เก็บ backup ล่าสุดกี่ชุด (ที่เก่ากว่านั้นลบ — backup ซ้ำซ้อน ปลอดภัย)

### 7) ยืนยันผล
`GET /api/admin/storage` → `stats.uploads.bytes` ควรลดลงมาก, `r2.pending.count` ควรเป็น 0

---

## หมายเหตุ
- **ไม่มีข้อมูลหาย:** ไฟล์ถูกอัปขึ้น R2 และตรวจขนาดตรงก่อนลบในเครื่องเสมอ; DB
  (ชื่อ/เอกสาร/ข้อมูลจัดการ) ไม่ถูกแตะ; ไฟล์เก็บแบบต้นฉบับไม่บีบอัด
- **ค่าใช้จ่าย R2:** ฟรี 10GB + operation/egress ฟรีในโควตาที่กว้างมาก
- **ความปลอดภัย (แนะนำเพิ่มภายหลัง):** ตอนนี้ endpoint `/api/admin/*` ยังไม่มีการ
  ยืนยันตัวตน (เป็นของเดิม) — ควรใส่ token ป้องกัน `reset`/`cleanup` ในอนาคต
