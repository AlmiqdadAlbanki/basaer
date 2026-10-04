// دالة اختبار مؤقتة — تبعث إشعارًا تجريبيًا للتأكد من عمل السلسلة كاملة (التوكن + المصادقة +
// الإرسال الفعلي). ضع رقمك الشخصي (نفس الرقم اللي فعّلت بيه الإشعارات من platform.html) مكان
// النص البديل تحت، ادفع بـ clasp push، وشغّل الدالة مرة واحدة من محرر الأكواد.
// بعد التأكد من نجاح الاختبار، احذف هذا الملف بالكامل.

function testSendFcmNotificationOnce() {
  var cpr = 'REPLACE_WITH_YOUR_CPR';
  var result = sendFcmNotificationToStudent_(cpr, 'إشعار تجريبي من بصائر', 'هذا اختبار للتأكد من وصول إشعارات المتابعة بنجاح 🎉');
  Logger.log(JSON.stringify(result));
}
