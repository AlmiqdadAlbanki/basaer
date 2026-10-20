// ===================================================================
// قائمة البريد المرتد: تفحص صندوق وارد حساب السكربت بحثًا عن إشعارات "تعذّر التسليم"
// (Delivery Status Notification) التي يرسلها جوجل تلقائيًا حين يرفض خادم المستلم رسالة، وتبني
// منها قائمة بعناوين يجب التوقف عن الإرسال إليها — بدل اكتشاف ذلك كل مرة من شكوى طالب "ما وصلني
// شي" بعد استهلاك حصة إرسال حقيقية على عنوان ميت أصلًا.
// راجع مناقشات هذا الملف مع المستخدم: نتج عن اكتشاف أن حصة البريد اليومية تنفد أسرع من المتوقع.
// ===================================================================

const BOUNCED_EMAILS_SHEET_NAME_ = 'bouncedEmails';
const BOUNCED_EMAILS_HEADERS_ = ['email', 'firstSeen', 'lastSeen', 'occurrences', 'lastSubject', 'severity', 'reviewed', 'note'];

function ensureBouncedEmailsSheet_() {
  const ss = SpreadsheetApp.openById(mainData);
  let sh = ss.getSheetByName(BOUNCED_EMAILS_SHEET_NAME_);
  if (!sh) {
    sh = ss.insertSheet(BOUNCED_EMAILS_SHEET_NAME_);
    sh.appendRow(BOUNCED_EMAILS_HEADERS_);
  }
  return sh;
}

// يحاول استخراج العنوان الذي تعذّر التسليم إليه وشدّة الفشل (دائم/مؤقت) من رسالة إشعار واحدة.
// يرجع null لو لم تكن هذه فعليًا رسالة إشعار تسليم (حارس إضافي فوق استعلام البحث)، أو لو كانت
// إشعار "تأخير" مؤقتًا (صندوق ممتلئ، خادم بطيء، ...) — لا نحظر على أساس ذلك إطلاقًا.
function parseBounceMessage_(message) {
  const from = String(message.getFrom() || '').toLowerCase();
  if (!/mailer-daemon|postmaster|mail delivery subsystem/i.test(from)) return null;

  const subject = String(message.getSubject() || '');
  const body = String(message.getPlainBody() || '');

  // "تأخير" مؤقت فقط (صندوق ممتلئ، الخادم غير متاح مؤقتًا...) — قد يصل لاحقًا، لا يُحظر أبدًا.
  if (/delay/i.test(subject) || /Action:\s*delayed/i.test(body) || /Status:\s*4\.\d/.test(body)) {
    return null;
  }

  const isPermanent = /Action:\s*failed/i.test(body) || /Status:\s*5\.\d/.test(body) ||
    /Undelivered Mail Returned to Sender|Delivery Status Notification \(Failure\)|couldn.?t be found|couldn.?t be delivered/i.test(subject + ' ' + body);

  // محاولات استخراج مرتَّبة من الأكثر دقة للأقل: تنسيق DSN الرسمي، ثم صياغة جوجل النصية
  // المعتادة، ثم أخيرًا أي عنوان بالجسم بعد استبعاد عناويننا/عناوين النظام.
  let email = '';
  let m = body.match(/Final-Recipient:\s*rfc822;\s*([^\s]+@[^\s]+)/i);
  if (m) email = m[1];
  if (!email) {
    m = body.match(/wasn.?t delivered to\s+([^\s<>,]+@[^\s<>,]+)/i) || body.match(/was not delivered to\s+([^\s<>,]+@[^\s<>,]+)/i);
    if (m) email = m[1];
  }
  if (!email) {
    const candidates = (body.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
      .map(function (e) { return e.toLowerCase().replace(/[.,;:]+$/, ''); })
      .filter(function (e) { return !/mailer-daemon|postmaster|@basaerbh\.com$|@googlemail\.com$|@google\.com$/i.test(e); });
    const unique = Array.from(new Set(candidates));
    if (unique.length === 1) email = unique[0];
  }

  email = String(email || '').toLowerCase().replace(/[.,;:]+$/, '');
  return {
    email: email,
    severity: email ? (isPermanent ? 'permanent' : 'unknown') : 'unresolved',
    subject: subject,
    snippet: body.slice(0, 300)
  };
}

// نقطة الدخول: تُشغَّل يدويًا من محرر Apps Script (بنفس نمط logRemainingQuota الموجود أصلًا)،
// تفحص آخر daysBack يومًا من صندوق الوارد وتُحدِّث شيت bouncedEmails. آمنة للتشغيل المتكرر —
// تُحدِّث نفس السطر (lastSeen/occurrences) بدل تكرار العنوان لو ظهر أكثر من مرة.
function scanBouncedEmails(daysBack) {
  daysBack = daysBack || 90;
  const threads = GmailApp.search(
    '(from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification" OR subject:"Undelivered Mail" OR subject:"Delivery incomplete" OR subject:"failure notice") newer_than:' + daysBack + 'd',
    0, 300
  );

  const found = {}; // email -> { firstSeen, lastSeen, occurrences, lastSubject, severity }
  let unresolvedCount = 0;
  let messagesScanned = 0;

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (message) {
      messagesScanned++;
      const parsed = parseBounceMessage_(message);
      if (!parsed) return; // ليست إشعار فشل دائم (أو ليست إشعار تسليم أصلًا)
      if (parsed.severity === 'unresolved') { unresolvedCount++; return; }

      const date = message.getDate();
      const existing = found[parsed.email];
      if (!existing) {
        found[parsed.email] = { firstSeen: date, lastSeen: date, occurrences: 1, lastSubject: parsed.subject, severity: parsed.severity };
      } else {
        existing.occurrences++;
        if (date > existing.lastSeen) { existing.lastSeen = date; existing.lastSubject = parsed.subject; }
        if (date < existing.firstSeen) existing.firstSeen = date;
        if (parsed.severity === 'permanent') existing.severity = 'permanent'; // الدوام يطغى لو تضاربت الرسائل
      }
    });
  });

  const sh = ensureBouncedEmailsSheet_();
  const lastRow = sh.getLastRow();
  const existingRows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, BOUNCED_EMAILS_HEADERS_.length).getValues() : [];
  const rowIndexByEmail = {};
  existingRows.forEach(function (row, i) { rowIndexByEmail[String(row[0]).toLowerCase()] = i + 2; });

  const newlyBlocked = [];
  const updatedBlocked = [];

  Object.keys(found).forEach(function (email) {
    const info = found[email];
    const rowNumber = rowIndexByEmail[email];
    if (!rowNumber) {
      sh.appendRow([email, info.firstSeen, info.lastSeen, info.occurrences, info.lastSubject, info.severity, false, '']);
      newlyBlocked.push(email);
    } else {
      const row = existingRows[rowNumber - 2];
      const combinedOccurrences = Number(row[3] || 0) + info.occurrences;
      const combinedSeverity = (row[5] === 'permanent' || info.severity === 'permanent') ? 'permanent' : info.severity;
      sh.getRange(rowNumber, 3, 1, 4).setValues([[info.lastSeen, combinedOccurrences, info.lastSubject, combinedSeverity]]);
      updatedBlocked.push(email);
    }
  });

  const summary = 'فُحص ' + messagesScanned + ' رسالة من آخر ' + daysBack + ' يومًا. ' +
    'عناوين جديدة أُضيفت: ' + newlyBlocked.length + '. عناوين سبق رصدها وتحدَّثت: ' + updatedBlocked.length + '. ' +
    'إشعارات تعذّر تحديد عنوانها تلقائيًا (تحتاج مراجعة يدوية إن كثرت): ' + unresolvedCount + '.';
  Logger.log(summary);

  return {
    messagesScanned: messagesScanned,
    newlyBlocked: newlyBlocked,
    updatedBlocked: updatedBlocked,
    unresolvedCount: unresolvedCount,
    summary: summary
  };
}

// نافذة قصيرة (3 أيام، هامش أمان يوم واحد فوق يوم واحد فعلي) للتشغيل التلقائي اليومي — أخف
// بكثير من فحص 90 يومًا كل ليلة، وآمنة التكرار تمامًا (scanBouncedEmails تُحدِّث نفس السطر
// لو تداخلت النوافذ، لا تكرّره). scanBouncedEmails() بلا وسيط يبقى للفحص اليدوي الأوسع.
function scanBouncedEmailsDaily() {
  return scanBouncedEmails(3);
}

// يُنشئ مشغّلًا زمنيًا يوميًا الساعة 1 صباحًا (بتوقيت السكربت Asia/Qatar، أي نفس توقيت البحرين
// عمليًا) لتشغيل scanBouncedEmailsDaily تلقائيًا. آمنة التشغيل المتكرر — لا تُنشئ مشغّلًا مكررًا
// لو كان موجودًا بالفعل (نفس نمط ensureWPQueueHealthTrigger_ بwpQueue.js). تُشغَّل يدويًا مرة
// واحدة فقط من محرر Apps Script لتفعيل الجدولة؛ لا تُستدعى من أي كود آخر بعد ذلك.
// ملاحظة: Apps Script لا يضمن الدقيقة بالضبط لمشغّلات atHour — التنفيذ الفعلي يقع عادة خلال
// نافذة قريبة من الساعة 1 (قد تصل لعدة دقائق تأخيرًا)، وليس اللحظة 01:00:00 حرفيًا.
function ensureBouncedEmailsDailyTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'scanBouncedEmailsDaily';
  });
  if (exists) return 'المشغّل اليومي موجود بالفعل، لم يُنشأ شيء جديد.';
  ScriptApp.newTrigger('scanBouncedEmailsDaily').timeBased().atHour(1).everyDays(1).create();
  return 'تم إنشاء مشغّل يومي لتشغيل scanBouncedEmailsDaily الساعة 1 صباحًا تقريبًا.';
}

// حارس يُستدعى قبل أي إرسال بريد فعلي — يرجع true لعنوان مسجَّل بشدة "دائم" ولم يُعلَّمه أحد
// كـ"تمت المراجعة" (reviewed=true، تعليم يدوي على الشيت بعد التأكد أن المشكلة حُلَّت). يُخزَّن
// في ذاكرة التخزين المؤقت 5 دقائق لتفادي قراءة الشيت مرارًا أثناء إرسال حملة بريدية كبيرة.
function isEmailBlocked_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return false;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'blockedEmailsSet';
  let blockedSet;
  const cached = cache.get(cacheKey);
  if (cached) {
    blockedSet = JSON.parse(cached);
  } else {
    const sh = ensureBouncedEmailsSheet_();
    const lastRow = sh.getLastRow();
    const rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, BOUNCED_EMAILS_HEADERS_.length).getValues() : [];
    blockedSet = rows.filter(function (row) { return row[5] === 'permanent' && row[6] !== true; })
      .map(function (row) { return String(row[0]).toLowerCase(); });
    cache.put(cacheKey, JSON.stringify(blockedSet), 300);
  }
  return blockedSet.indexOf(email) > -1;
}
