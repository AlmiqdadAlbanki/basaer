// أداة تشخيص مؤقتة — بلاغ حي 2026-09-14: حملة واتساب توقفت بخطأ "This script has too many
// triggers" (حد Apps Script: 20 Trigger لكل مستخدم بكل مشروع). تطبع كل الـTriggers الحالية
// بالمشروع (دالة المعالجة، النوع، المعرّف الفريد) لمعرفة أيها تراكم بالخطأ. ادفع بـclasp push،
// شغّل debugListTriggers من محرر الأكواد وابعت السجل. بعد التشخيص/التنظيف احذف هذا الملف بالكامل.

function debugListTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  Logger.log('إجمالي عدد الـTriggers الحالية: ' + triggers.length + ' (الحد الأقصى المسموح 20 لكل مستخدم بكل مشروع)');
  var byHandler = {};
  triggers.forEach(function (t) {
    var fn = t.getHandlerFunction();
    byHandler[fn] = (byHandler[fn] || 0) + 1;
    Logger.log('handler=' + fn + ' | eventType=' + t.getEventType() + ' | source=' + t.getTriggerSource() + ' | uniqueId=' + t.getUniqueId());
  });
  Logger.log('ملخص حسب الدالة: ' + JSON.stringify(byHandler, null, 2));
}

// حذف كل الـTriggers المطابقة لاسم دالة معالجة معيّنة بالضبط — استخدمها بعد مراجعة نتيجة
// debugListTriggers لتحديد الدالة المتراكمة (مثلًا 'processWPQueueTick' لو تراكمت نسخ منها خطأً).
// عدّل اسم الدالة أدناه ثم شغّل هذه الدالة مرة واحدة.
function debugDeleteTriggersByHandler() {
  // مُعبَّأة مسبقًا بـ'processWPQueueTick' — الدالة المتراكمة فعليًا بالتشخيص الحي (18 نسخة).
  // غيّرها لو أردت حذف دالة أخرى مستقبلًا.
  var HANDLER_TO_DELETE = 'processWPQueueTick';
  var deleted = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER_TO_DELETE) { ScriptApp.deleteTrigger(t); deleted++; }
  });
  Logger.log('تم حذف ' + deleted + ' trigger(s) بدالة المعالجة "' + HANDLER_TO_DELETE + '"');
}

// تشخيص بلاغ "توقفت الحملة أكثر من مرة ولم يصلني أي إشعار واتساب/إيميل" (2026-09-15) — يفحص
// الثلاثة أسباب المحتملة معًا بلا إرسال فعلي: هل يوجد Trigger مراقبة (monitorWPQueueHealth) أصلًا؟
// هل wpQueue_sentBy مضبوطة على رقم شخصي صالح؟ هل يُحلَّل لاسم/هاتف/إيميل حقيقي بشيت emp؟
function debugWPQueueNotifications() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('wpQueue status: ' + JSON.stringify(getWPQueueStatus(), null, 2));

  var sentBy = props.getProperty('wpQueue_sentBy');
  Logger.log('wpQueue_sentBy (الرقم الشخصي المخزَّن لصاحب الحملة): ' + JSON.stringify(sentBy));

  var contact = wpQueueOwnerContact_();
  Logger.log('بيانات التواصل المُستخرَجة من شيت emp لهذا الرقم: ' + JSON.stringify(contact));
  if (!contact) Logger.log('⚠️ لم يُعثر على صف بشيت emp بهذا الرقم الشخصي — الإشعار يُتجاهَل بصمت من wpQueueOwnerContact_.');
  else {
    if (!contact.phone) Logger.log('⚠️ عمود الهاتف فارغ لهذا المتعاون — لن يُرسَل إشعار واتساب.');
    if (!contact.email) Logger.log('⚠️ عمود الإيميل فارغ لهذا المتعاون — لن يُرسَل إشعار إيميل.');
  }

  var hasHealthTrigger = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'monitorWPQueueHealth'; });
  Logger.log('هل يوجد حاليًا Trigger مراقبة دورية (monitorWPQueueHealth)؟ ' + hasHealthTrigger +
    (hasHealthTrigger ? '' : ' — ⚠️ لو الحملة الحالية بدأت قبل هذا الإصلاح، لن يُضاف هذا الحارس تلقائيًا لحملة قائمة بالفعل، فلن يُكتشَف أي توقّف صامت لها أصلًا.'));
}

// إرسال إشعار تجريبي فوري لصاحب الحملة الحالية (نفس دالة الإشعار الحقيقية بالضبط) — للتأكد
// المباشر من وصول الرسالة فعليًا (واتساب/إيميل) بمعزل عن أي تشخيص آخر. شغّلها مرة واحدة فقط.
function debugSendWPQueueTestNotification() {
  notifyWPQueueOwner_('stopped', 'اختبار يدوي من debugSendWPQueueTestNotification — تجاهل هذه الرسالة');
  Logger.log('أُرسِل طلب إشعار تجريبي — راجع سجل Logger أعلاه (لو ظهرت رسائل ⚠️) وتحقّق من وصول واتساب/إيميل فعليًا.');
}

// تحقيق سبب حظر الرقم المحتمَل (2026-09-16) — يطبع كل ردود Fonnte الفعلية المسجَّلة بشيت
// messageLog لآخر رسائل واتساب (آخر 40 صف زمنيًا)، وتجميع أسباب الفشل المتكررة — للبحث عن
// نص خطأ حقيقي من Fonnte/واتساب يدل على الحظر (مثل "banned"/"logged out"/"device not
// connected") بدل التخمين. شغّلها من محرر الأكواد وابعت السجل كامل.
function debugInvestigateWPBanReason() {
  var sh = ensureMessageLogSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('سجل الرسائل (messageLog) فارغ بالكامل.'); return; }

  var data = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var wpRows = data.filter(function (r) { return !r[idx.channel] || r[idx.channel] === 'whatsapp'; });
  wpRows.sort(function (a, b) { return new Date(a[idx.sentAt]) - new Date(b[idx.sentAt]); });
  Logger.log('إجمالي رسائل واتساب المسجَّلة بالسجل: ' + wpRows.length);

  var tz = Session.getScriptTimeZone();
  var last40 = wpRows.slice(-40);
  Logger.log('=== آخر ' + last40.length + ' رسالة بالترتيب الزمني ===');
  last40.forEach(function (r) {
    var ts = r[idx.sentAt] ? Utilities.formatDate(new Date(r[idx.sentAt]), tz, 'yyyy-MM-dd HH:mm:ss') : '(بلا وقت)';
    Logger.log(ts + ' | status=' + r[idx.status] + ' | target=' + r[idx.recipientTarget] + ' | reason=' + (r[idx.reason] || ''));
  });

  var reasonCounts = {};
  wpRows.forEach(function (r) {
    if (r[idx.status] === 'failed') {
      var reason = String(r[idx.reason] || 'بلا سبب مسجَّل');
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
  });
  Logger.log('=== أسباب الفشل المسجَّلة وتكرارها (كل السجل) ===');
  Logger.log(JSON.stringify(reasonCounts, null, 2));
}
