# KD Database

ระบบจัดการข้อมูลพนักงาน (Korea–Laos worker management) — front-end app.

## รัน
- **Server:** `npm start` → เปิด `http://localhost:3000`

### เข้าระบบครั้งแรก
ตอนติดตั้งครั้งแรก ระบบจะสร้างบัญชี `admin` พร้อม**รหัสผ่านสุ่ม** แล้วพิมพ์ออก
console ครั้งเดียว (และบันทึกไว้ที่ `data/db/INITIAL-ADMIN-PASSWORD.txt`)

รหัสผ่านนี้เป็นรหัสชั่วคราว — ระบบจะ**บังคับให้เปลี่ยน**ตอน sign-in ครั้งแรก
และไฟล์ข้างต้นจะถูกลบอัตโนมัติเมื่อเปลี่ยนเสร็จ

ลืมรหัส admin? รีเซ็ตด้วย:
```bash
npm run reset-admin
```

## โครงสร้าง
ดูแผนผังเต็มที่ [ARCHITECTURE.md](ARCHITECTURE.md)

```
index.html              ตัวเปิด → frontend/pages/login.html
frontend/pages/         index.html, login.html
frontend/styles/        main.css, sidebar.css
frontend/scripts/       db.js, i18n.js, app.js
modules/passport-scan/  passport-scan.js   (กล้อง + OCR + MRZ)
modules/pptx-import/    pptx-import.js      (นำเข้า PPTX)
backend/ database/ storage/ reports/        🔮 เฟสต่อไป
```

## ฟีเจอร์
ลงทะเบียนพนักงาน · กลุ่ม/Departure · auto-gen Contact ID · สแกนพาสปอร์ต (MRZ) ·
นำเข้า PPTX · ส่งออก CSV · สิทธิ์ Admin/Viewer · 4 ภาษา (EN/TH/LO/KO)
