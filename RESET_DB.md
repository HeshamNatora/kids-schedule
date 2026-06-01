# إعادة ضبط قاعدة البيانات

افتح psql وشغّل الأوامر دي:

```sql
-- امسح كل البيانات القديمة
TRUNCATE activities, weeks, kids, rewards, app_settings RESTART IDENTITY CASCADE;
```

بعدين أعد تشغيل السيرفر وهيعمل seed جديد نظيف.
