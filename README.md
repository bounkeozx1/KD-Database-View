# KD Database

ระบบจัดการข้อมูลพนักงาน (Korea–Laos worker management) — front-end app.

## รัน
- **Server:** `python -m http.server 3000` → เปิด `http://localhost:3000`
- **Double-click:** เปิด `frontend/pages/login.html`
- เข้าระบบ: `admin / admin1234` (Admin) · `viewer / viewer1234` (Viewer)

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
