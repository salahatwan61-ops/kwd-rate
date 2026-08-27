# تقرير المراجعة والإصلاحات — KWD Rate

تمت مراجعة المشروع كاملًا (Backend + Frontend + DB migrations + Docker)، وتشغيله فعليًا على
PostgreSQL 16 + Node 22 لاختبار كل endpoint رئيسي، وليس مجرد قراءة كود.

## أخطاء حرجة (كانت تمنع تشغيل المشروع بالكامل)

### 1. السيرفر ينهار فورًا عند الإقلاع — `server.js`
```js
app.get('*', (req,res)=>res.sendFile(...))   // ❌ يكسر Express 5
app.get('/*splat', (req,res)=>res.sendFile(...))  // ✅ الصيغة الصحيحة
```
`package.json` يستخدم Express 5، وفيه تغيّرت صياغة الـ wildcard route
(`path-to-regexp` v7/v8 لم يعد يقبل `'*'` مجردة). كان `node server.js` يرمي
`PathError` ويتوقف فورًا — يعني المشروع لا يشتغل نهائيًا كما هو.

### 2. أهم endpoint بالمنصة (`/api/compare`) كان يرجع خطأ 500 دائمًا
داخل حلقة حساب الثقة (trust engine) كان في استخدام لمتغيرين غير معرّفين:
```js
if(sourceReliability>=90) ...   // ❌ غير معرّف
if(completeness>=95) ...        // ❌ غير معرّف
```
الصحيح:
```js
if(x._source_reliability>=90) ...
if(x._completeness>=95) ...
```
بما إن هذا الـ endpoint هو جوهر فكرة الموقع (مقارنة الأسعار)، فكان كل طلب
مقارنة يفشل بـ `{"error":"sourceReliability is not defined"}`.

### 3. تثبيت قاعدة البيانات من الصفر (`docker compose up`) كان يفشل
ترتيب ملفات `docker-entrypoint-initdb.d` في `docker-compose.yml` كان يشغّل
`seed.sql` **قبل** `003_comparison_engine.sql`، رغم إن `seed.sql` بآخر سطر
فيه يحدّث أعمدة `quote_type` و`rate_basis` غير موجودة بعد في تلك اللحظة:
```
ERROR: column "quote_type" does not exist
```
تم تأكيد هذا الخطأ فعليًا بتشغيل الترتيب القديم على قاعدة تجريبية. الحل:
إعادة ترتيب التركيب بحيث تُطبَّق كل الـ migrations أولًا، و`seed.sql` أخيرًا.

## أخطاء SQL (كانت تكسر endpoints كاملة)

### 4. `day` و`hour` كلمات محجوزة في PostgreSQL
```sql
SELECT DATE_TRUNC('day', r.captured_at) day, ...   -- ❌ syntax error
SELECT DATE_TRUNC('day', r.captured_at) AS day, ... -- ✅
```
كان هذا يكسر 3 endpoints بالكامل:
- `/api/history/:code` (سجل الأسعار — يستخدمه index.html مباشرة)
- `/api/admin/intelligence/overview`
- `/api/admin/intelligence/company/:id`

## أخطاء منطقية / عدم تطابق بين الواجهة والسيرفر

### 5. المبلغ المحوَّل كان يظهر دائمًا فارغًا/NaN في الصفحة الرئيسية
`index.html` يتوقع `x.final_amount`، لكن `/api/compare` كان يرجع الحقل باسم
`output_after_fee` فقط. تم إضافة `final_amount` كحقل متوافق. هذا أيضًا كان
يكسر منطق الترتيب النهائي (tie-breaking) في السيرفر نفسه لأنه يقارن
`a.final_amount - b.final_amount` وهي `undefined`.

### 6. مؤشر "الانحراف عن مرجع البنك المركزي" (▲/▼) لا يظهر أبدًا
الواجهة تتوقع `x.spread_from_reference`، والسيرفر كان يرجع `reference_deviation_pct`
فقط. تم إضافة الحقل المتوافق `spread_from_reference`.

### 7. رسائل تنبيهات الأسعار دائمًا تقول "المصدر: غير محدد"
`alert-engine.js` كان ينسى `s.name AS source_name` في الاستعلام رغم استخدامه
لاحقًا في الرسالة. تمت إضافته.

### 8. خريطة الفروع القريبة بدون أي تنسيق (CSS مكسور)
هاش SRI (`integrity=`) لملف `leaflet.css` في `index.html` كان خاطئًا،
فيرفض المتصفح تحميل الملف لعدم تطابق البصمة، فتظهر الخريطة بدون أي تنسيق
(markers فوق بعض، بدون تدرّج، إلخ). تم تصحيح الهاش للقيمة الرسمية.

## تم اختباره فعليًا وليس فقط قراءته
تم تثبيت PostgreSQL 16 محليًا، تطبيق كل الـ migrations بالترتيب الجديد
(نجح بدون أي خطأ)، تشغيل `server.js`، واختبار:
`/api/health` · `/api/compare` · `/api/currencies` · `/api/history/:code` ·
`/api/market-summary/:code` · `/api/trust/:code` · `/api/sources` ·
`/api/exchanges` · `/api/branches` · `/api/nearby-best` · `/api/auth/register`
· `/api/auth/me` · `/api/account` · `/api/account/alerts` ·
`/api/admin/stats` · `/api/admin/intelligence/overview` ·
`/api/admin/intelligence/company/:id` · دورة تنبيه سعر كاملة
(`alert-engine.js --once` → إنشاء إشعار → `notification-worker.js --once`
→ تسليمه IN_APP) — كل هذا اشتغل بنجاح بعد الإصلاحات.

## ملاحظات مهمة (ليست أخطاء برمجية، لكن يجب الانتباه لها قبل الإنتاج)

- **`collector.js`** يعتمد على تحليل HTML بـ regex من مواقع CBK/KBE/BEC
  الحقيقية. أي تغيير بسيط بتصميم تلك الصفحات سيكسر السحب التلقائي للأسعار.
  هذا متوقع وموثّق في `README.md` الأصلي، لكن يُنصح لاحقًا باستبداله بـ API
  رسمي إن توفر، أو مراقبة السحب التلقائي بتنبيهات فشل.
- بيئة العمل التي أستخدمها لا تملك وصول شبكة عام أو استضافة، فلم أستطع
  اختبار السحب الفعلي من هذه المواقع الثلاثة (فقط اختبرت المنطق الداخلي
  بأسعار تجريبية من seed.sql).
- `ADMIN_KEY` و`DATABASE_URL` الافتراضيين في `.env.example` للتطوير فقط —
  غيّرها إلزاميًا قبل أي نشر حقيقي.
- `docker-compose.yml` ما فيه healthcheck لخدمة postgres قبل ما يشتغل الـ
  app، فممكن أول طلب أو طلبين يفشلوا لحظة الإقلاع لحد ما تجهز القاعدة. غير
  خطير لأن `ENABLE_AUTO_SYNC` يبدأ بعد 5 ثوانٍ، لكن يُستحسن إضافة
  `condition: service_healthy` لاحقًا.
