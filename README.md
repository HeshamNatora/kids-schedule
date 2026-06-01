# 🌟 جدول أولادي

## تشغيل محلياً

```bash
npm install
node server.js
```
افتح المتصفح على: http://localhost:3000

---

## رفع على GitHub

```bash
git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/kids-schedule.git
git push -u origin main
```

> ملاحظة: ملف `.env` لن يُرفع تلقائياً بسبب `.gitignore`

---

## Deploy على Render (مجاني)

1. روح على [render.com](https://render.com) وسجّل دخول
2. New → **Web Service**
3. اربط الـ GitHub repo
4. الإعدادات:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Environment:** Node
5. في **Environment Variables** أضف:
   - Key: `DATABASE_URL`
   - Value: (الـ connection string بتاعة Neon)
6. اضغط **Deploy**

بعد الـ Deploy، التطبيق يشتغل على رابط مثل:
`https://kids-schedule-xxxx.onrender.com`

---

## المتغيرات المطلوبة

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `PORT` | Port number (اختياري، Render بيحدده تلقائياً) |
