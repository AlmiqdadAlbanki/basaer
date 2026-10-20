/* ==========================================================================
   إشعار آلي: "اختبار متاح" للطلاب المعنيين الذين لم يؤدّوه بعد

   - يعمل بمشغّل زمني كل 15 دقيقة (monitorExamAvailabilityNotifications، يُضمَن وجوده في
     ensureExamAutomationTriggers_ بـexamSessions.js).
   - الاختبار "متاح" بنفس شرط بدء الطالب الفعلي: examCanStartNow_ (check + duration + ضمن
     الموعد + غير مؤرشف) وله نموذج معتمد لفرع الطالب.
   - الطالب "معنيّ" حين: مرحلته النشطة = مرحلة الاختبار، وفرعه جاهز (مذهبه للفقه)، ومادة
     الاختبار لا تخص مذهبًا غير مذهبه (نفس تصفية getExams).
   - "لم يؤدِّه": لا نتيجة له بشيت answers لهذا الاختبار+المرحلة، ولا جلسة بشيت examSessions
     (أي لا تُرسَل لمن بدأه ولو لم يُسلّمه بعد).
   - مرة واحدة لكل (اختبار، طالب): سجل examAvailableNotified بـanswersData. لا يُسجَّل الطالب إلا
     بعد نجاح الإرسال فعليًا، فمن تعذّر وصوله يُعاد معه المحاولة بالتشغيلة التالية.
   - القنوات: إشعار المنصة (FCM) ثم البريد الموثَّق عند تعذّره (أو البريد أولًا لمن يفضّله).
     واتساب الجماعي للأفراد غير مستخدم عمدًا: معطَّل مع Fonnte (isIndividualBroadcastAllowed...)،
     وقالب Meta غير جاهز بعد.
   ========================================================================== */

var EXAM_AVAILABLE_LOG_HEADERS_ = ['exam_id', 'cpr', 'channel', 'notifiedAt'];
var EXAM_AVAILABLE_RUN_BUDGET_MS_ = 4.5 * 60 * 1000;
var EXAM_AVAILABLE_GUARD_PROP_ = 'examAvailNotifyRunningSince';
// حصة بريد يومية مشتركة مع رموز التحقق وبقية الرسائل الحرجة؛ لا يُستنزف منها شيء دون هذا الاحتياطي.
var EXAM_AVAILABLE_EMAIL_RESERVE_ = 50;

function ensureExamAvailableLogSheet_() {
  return ensureSheetColumns_(answersData, 'examAvailableNotified', EXAM_AVAILABLE_LOG_HEADERS_);
}

// الاختبارات المتاحة للبدء الآن. قراءة واحدة للشيت، وتصفية رخيصة قبل أي تحويل للتواريخ (كل تحويل
// يفتح الشيت ليعرف منطقته الزمنية)، فتبقى التشغيلة الفارغة — أغلب الوقت — سريعة.
function openExamRulesForNotification_() {
  var headers = ensureExamManagementColumns_(), idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
  if (sh.getLastRow() < 2) return [];
  var out = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r, i) {
    if (!r[idx.exam] || r[idx.archived] === true || r[idx.check] !== true || !(Number(r[idx.duration]) > 0)) return;
    var rule = examRuleFromRow_(r, idx, i + 2);
    if (rule.id && examCanStartNow_(rule)) out.push(rule);
  });
  return out;
}

function approvedExamBranchSet_() {
  var set = {};
  var statusMap = examModelStatusMap_();
  Object.keys(statusMap).forEach(function (key) {
    if (statusMap[key] !== 'approved') return;
    var p = key.split('|'); // examId | branch | level | form
    set[p[0] + '|' + p.slice(1, p.length - 2).join('|') + '|' + p[p.length - 2]] = true;
  });
  return set;
}

// كل الطلاب ذوي المرحلة النشطة، بصف واحد لكل طالب (قراءة واحدة للشيت).
function activeStudentsForExamNotify_() {
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  if (!sh || sh.getLastRow() < 2) return [];
  var h = headerMap_(sh).map, out = [];
  function cell(r, col) { return h[col] !== undefined ? r[h[col]] : ''; }
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r) {
    var activeLevel = null;
    for (var i = 0; i < 4; i++) { if (cell(r, 'class' + i) === 'active') { activeLevel = i; break; } }
    var cpr = normalizeCpr_(cell(r, 'cpr'));
    if (activeLevel === null || !cpr) return;
    out.push({
      cpr: cpr,
      name: String(cell(r, 'name') || ''),
      email: String(cell(r, 'email') || '').trim(),
      emailVerified: cell(r, 'emailVerified') === true,
      contactPreference: String(cell(r, 'contactPreference') || ''),
      mazhab: String(cell(r, 'mazhab') || '').trim(),
      activeLevel: activeLevel
    });
  });
  return out;
}

function fcmTokenMapForExamNotify_() {
  var sh = ensureFcmTokensSheet_(), map = {};
  if (sh.getLastRow() < 2) return map;
  var h = headerMap_(sh).map;
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r) {
    var cpr = normalizeCpr_(r[h.cpr]);
    if (cpr && r[h.token]) map[cpr] = String(r[h.token]);
  });
  return map;
}

// مجموعتان: من لديه نتيجة (بالمعرّف أو، للصفوف القديمة بلا exam_id، بالاسم) ومن بدأ جلسة.
function examTakenSets_() {
  var answered = {}, started = {};

  var aSh = SpreadsheetApp.openById(answersData).getSheetByName('answers');
  if (aSh && aSh.getLastRow() > 1) {
    var ah = headerMap_(aSh).map;
    aSh.getRange(2, 1, aSh.getLastRow() - 1, aSh.getLastColumn()).getValues().forEach(function (r) {
      var cpr = normalizeCpr_(r[ah.cpr]);
      if (!cpr) return;
      var examId = ah.exam_id !== undefined ? String(r[ah.exam_id] || '') : '';
      var key = examId ? examId : 'name:' + String(r[ah.exam] || '');
      answered[cpr + '|' + key + '|' + String(r[ah.level])] = true;
    });
  }

  var sSh = ensureExamSessionsSheet_();
  if (sSh.getLastRow() > 1) {
    var sh = headerMap_(sSh).map;
    sSh.getRange(2, 1, sSh.getLastRow() - 1, sSh.getLastColumn()).getValues().forEach(function (r) {
      var cpr = normalizeCpr_(r[sh.cpr]);
      if (cpr) started[cpr + '|' + String(r[sh.exam_id]) + '|' + String(r[sh.level])] = true;
    });
  }
  return { answered: answered, started: started };
}

function examAvailableNotifiedSet_() {
  var sh = ensureExamAvailableLogSheet_(), set = {};
  if (sh.getLastRow() < 2) return set;
  var h = headerMap_(sh).map;
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r) {
    set[String(r[h.exam_id]) + '|' + normalizeCpr_(r[h.cpr])] = true;
  });
  return set;
}

// يحسب القائمة الكاملة للمستهدفين الآن، دون إرسال أي شيء ودون كتابة بأي شيت: [{rule, student}].
function collectExamAvailabilityTargets_() {
  var rules = openExamRulesForNotification_();
  if (!rules.length) return [];

  var approved = approvedExamBranchSet_();
  var activeMadhabs = activeMadhabNames_();
  var students = activeStudentsForExamNotify_();
  var taken = examTakenSets_();
  var notified = examAvailableNotifiedSet_();

  var subjectById = {};
  getSubjectsList().forEach(function (s) { subjectById[s.id] = s; });
  var curricula = getCurriculaList();

  var targets = [];
  rules.forEach(function (rule) {
    var subjectRoot = fiqhRootIn_(findSubjectNameForExam_(rule.exam, rule.level, curricula, subjectById));
    students.forEach(function (stu) {
      if (String(stu.activeLevel) !== String(rule.level)) return;
      if (notified[rule.id + '|' + stu.cpr]) return;
      if (subjectRoot && fiqhRootIn_(stu.mazhab) !== subjectRoot) return;

      var branch = rule.exam;
      if (rule.exam === 'الفقه') {
        branch = stu.mazhab;
        if (!branch || activeMadhabs.indexOf(branch) === -1) return;
      }
      if (!approved[rule.id + '|' + branch + '|' + rule.level]) return;

      if (taken.started[stu.cpr + '|' + rule.id + '|' + rule.level]) return;
      if (taken.answered[stu.cpr + '|' + rule.id + '|' + rule.level]) return;
      if (taken.answered[stu.cpr + '|name:' + rule.exam + '|' + rule.level]) return;

      targets.push({ rule: rule, student: stu });
    });
  });
  return targets;
}

function examAvailableDeadlineText_(rule) {
  if (!rule.endDate) return '';
  return 'آخر موعد لأدائه: ' + rule.endDate + (rule.endTime ? ' ' + rule.endTime : '');
}

function prefersEmailContact_(stu) {
  var pref = String(stu.contactPreference || '').toLowerCase();
  return pref.indexOf('mail') !== -1 || pref.indexOf('بريد') !== -1;
}

function canEmailStudent_(stu) {
  return !!(stu.email && stu.emailVerified && !isEmailBlocked_(stu.email));
}

// يرجع اسم القناة التي نجحت ('fcm' | 'email') أو '' إن لم تنجح أي قناة.
function sendExamAvailableNotification_(stu, rule, templateBody, token, ctx) {
  var msg = renderMessageTemplate_(templateBody || MESSAGE_TEMPLATE_DEFS_.examAvailable.defaultBody, {
    name: firstNameOnly_(stu.name), exam: rule.exam, deadline: examAvailableDeadlineText_(rule)
  }).replace(/\n{3,}/g, '\n\n').trim();
  var title = 'اختبار متاح الآن';

  function viaFcm() {
    if (!token) return false;
    try {
      var res = sendFcmNotification_(token, title, msg);
      return !!(res && res.ok);
    } catch (e) { Logger.log(e); return false; }
  }
  function viaEmail() {
    if (!canEmailStudent_(stu)) return false;
    if (ctx.emailsLeft <= EXAM_AVAILABLE_EMAIL_RESERVE_) return false;
    try {
      if (!ctx.logoBlob) ctx.logoBlob = getBasairLogoBlob_();
      GmailApp.sendEmail(stu.email, title, msg, {
        name: 'بصائر للعلوم الشرعية',
        htmlBody: buildBasairPlainMessageEmail_('تنبيه اختبار', title, msg),
        inlineImages: { basairLogo: ctx.logoBlob }
      });
      ctx.emailsLeft--;
      return true;
    } catch (e) { Logger.log(e); return false; }
  }

  var order = prefersEmailContact_(stu) ? [['email', viaEmail], ['fcm', viaFcm]] : [['fcm', viaFcm], ['email', viaEmail]];
  for (var i = 0; i < order.length; i++) {
    if (order[i][1]()) return order[i][0];
  }
  return '';
}

function monitorExamAvailabilityNotifications() {
  // لا نحتجز ScriptLock طوال التشغيلة: getQuestions يحتاجه لبدء اختبار الطالب ولا يجوز تأخيره.
  // الحارس بخاصية مؤقتة يمنع تداخل تشغيلتين فقط (مع تجاهل حارس عالق أقدم من 10 دقائق).
  var props = PropertiesService.getScriptProperties();
  var since = Number(props.getProperty(EXAM_AVAILABLE_GUARD_PROP_)) || 0;
  if (since && Date.now() - since < 10 * 60 * 1000) return;
  props.setProperty(EXAM_AVAILABLE_GUARD_PROP_, String(Date.now()));

  var pendingLog = [];
  function flushLog() {
    if (!pendingLog.length) return;
    var sh = ensureExamAvailableLogSheet_();
    sh.getRange(sh.getLastRow() + 1, 1, pendingLog.length, EXAM_AVAILABLE_LOG_HEADERS_.length).setValues(pendingLog);
    pendingLog = [];
  }

  try {
    var targets = collectExamAvailabilityTargets_();
    if (!targets.length) return;

    var startedAt = Date.now();
    var templateBody = getActiveMessageTemplateBody_('examAvailable');
    var tokens = fcmTokenMapForExamNotify_();
    var ctx = { emailsLeft: MailApp.getRemainingDailyQuota(), logoBlob: null };

    for (var i = 0; i < targets.length; i++) {
      if (Date.now() - startedAt > EXAM_AVAILABLE_RUN_BUDGET_MS_) break; // الباقي بالتشغيلة التالية
      var t = targets[i];
      var channel = sendExamAvailableNotification_(t.student, t.rule, templateBody, tokens[t.student.cpr] || '', ctx);
      if (!channel) continue; // لا قناة صالحة الآن: يُعاد المحاولة لاحقًا ما دام الاختبار متاحًا
      pendingLog.push([t.rule.id, t.student.cpr, channel, new Date()]);
      if (pendingLog.length >= 20) flushLog();
    }
  } catch (err) {
    Logger.log('تعذّر إشعار "اختبار متاح": ' + err);
  } finally {
    try { flushLog(); } catch (e2) { Logger.log(e2); }
    props.deleteProperty(EXAM_AVAILABLE_GUARD_PROP_);
  }
}

// معاينة بلا إرسال ولا كتابة: شغّلها يدويًا من محرر Apps Script قبل تفعيل المشغّل لترى كم طالبًا
// سيصلهم إشعار عن كل اختبار متاح الآن، وعبر أي قناة. تُحذَف بعد المراجعة.
function debugExamAvailabilityPreview() {
  var targets = collectExamAvailabilityTargets_();
  var tokens = fcmTokenMapForExamNotify_();
  var byExam = {};
  targets.forEach(function (t) {
    var key = t.rule.exam + ' (مرحلة ' + t.rule.level + ') [' + t.rule.id + ']';
    var o = byExam[key] = byExam[key] || { total: 0, fcm: 0, email: 0, none: 0 };
    o.total++;
    if (tokens[t.student.cpr]) o.fcm++;
    else if (canEmailStudent_(t.student)) o.email++;
    else o.none++;
  });
  Logger.log('إجمالي من سيُشعَرون: ' + targets.length);
  Object.keys(byExam).forEach(function (k) {
    var o = byExam[k];
    Logger.log(k + ' → الإجمالي ' + o.total + ' | إشعار منصة ' + o.fcm + ' | بريد فقط ' + o.email + ' | بلا قناة ' + o.none);
  });
}
