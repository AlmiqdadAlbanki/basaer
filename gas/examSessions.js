/* ========================================================================== 
   جلسات الاختبارات الدائمة واعتماد النماذج والتنبيهات التشغيلية

   - هوية المحاولة: cpr + exam_id + level، مع attempt_id مستقل.
   - استكمال الجلسة النشطة متاح دائمًا قبل endTime؛ allowReentry عمود قديم متجاهَل.
   - أسئلة/ترتيب/إجابات الجلسة تحفظ في answersData/examSessions بدل CacheService.
   - اختبار الفقه يأخذ المذهب من صف الطالب خادميًا ويحفظه في matn بالنتيجة.
   ========================================================================== */

var EXAM_SESSION_HEADERS_ = [
  'session_id', 'attempt_id', 'cpr', 'exam_id', 'exam', 'level', 'matn', 'model',
  'startTime', 'endTime', 'status', 'questionsJson', 'answersJson', 'lastHeartbeat',
  'disconnectNotifiedAt', 'submittedAt', 'createdAt', 'updatedAt'
];

var EXAM_MODEL_HEADERS_ = [
  'exam_id', 'branch', 'level', 'form', 'status', 'approved_by', 'approved_at', 'updated_at'
];

function ensureSheetColumns_(spreadsheetId, sheetName, wantedHeaders) {
  var ss = SpreadsheetApp.openById(spreadsheetId);
  var sh = ss.getSheetByName(sheetName);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.getRange(1, 1, 1, wantedHeaders.length).setValues([wantedHeaders]);
    return sh;
  }
  var lastCol = Math.max(1, sh.getLastColumn());
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var missing = wantedHeaders.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  return sh;
}

function ensureExamSessionsSheet_() {
  return ensureSheetColumns_(answersData, 'examSessions', EXAM_SESSION_HEADERS_);
}

function ensureExamModelsSheet_() {
  return ensureSheetColumns_(refID, 'examModels', EXAM_MODEL_HEADERS_);
}

// mazhab: عمود جديد (2026-09-12) مخصَّص حصرًا لمذهب اختبار الفقه — بديل استخدام matn لهذا
// الغرض (قرار سابق، راجع مناقشات.md "مراجعة منطق اختبار الفقه" §3)، الذي كان يتصادم مع
// استخدام matn الأصلي (اسم متن حفظه الطالب) بدالة الشهادات exportCert_، فتُدرَج جملة "كما
// اجتاز تسميع المتن..." بشهادات الفقه خطأً بقيمة المذهب. يُضاف بآخر الشيت دائمًا (لا يُدرَج
// بموضع معيّن وسط الأعمدة) — writeExamResult_ بهذا الملف تحتوي حلقة تكتب إجابات الاختبار
// التفصيلية بموضع ثابت مبرمَج صراحةً ("من العمود 13 فصاعدًا")، فإدراج عمود جديد وسط الشيت
// يزيح هذا الموضع ويُفسد كتابة الإجابات لكل الاختبارات لا الفقه فقط.
function ensureAnswersTrackingColumns_() {
  var sh = ensureSheetColumns_(answersData, 'answers', ['exam_id', 'attempt_id', 'session_id', 'mazhab']);
  migrateFiqhMazhabFromMatnColumn_(sh);
  return sh;
}

// هجرة تلقائية ذاتية الشفاء لمرة واحدة لكل صف: تنقل مذهب أي نتيجة فقه سابقة من matn (حيث كانت
// تُخزَّن قبل هذا الإصلاح) إلى عمود mazhab الجديد، وتُفرغ matn لهذا الصف — يمنع تكرار خلل
// الشهادة أعلاه على النتائج المسجَّلة سابقًا، ويصحّح عرضها بلوحة الإدارة أيضًا. آمنة التكرار:
// تتجاوز أي صف بعمود mazhab غير فارغ أصلًا أو matn فارغ أصلًا.
function migrateFiqhMazhabFromMatnColumn_(sh) {
  try {
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var examCol = headers.indexOf('exam'), matnCol = headers.indexOf('matn'), mazhabCol = headers.indexOf('mazhab');
    if (examCol === -1 || matnCol === -1 || mazhabCol === -1) return;
    var lastRow = sh.getLastRow();
    if (lastRow < 2) return;
    var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
    var changed = false;
    rows.forEach(function (r) {
      if (r[examCol] === 'الفقه' && r[matnCol] && !r[mazhabCol]) {
        r[mazhabCol] = r[matnCol];
        r[matnCol] = '';
        changed = true;
      }
    });
    if (changed) sh.getRange(2, 1, rows.length, sh.getLastColumn()).setValues(rows);
  } catch (err) {
    Logger.log('تعذّرت هجرة مذهب الفقه من matn إلى mazhab: ' + err);
  }
}

function headerMap_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { map[h] = i; });
  return { headers: headers, map: map };
}

function examRuleById_(examId) {
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
  var headers = ensureExamManagementColumns_();
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][idx.exam_id]) !== String(examId)) continue;
    var r = rows[i];
    return {
      rowNumber: i + 2,
      id: String(r[idx.exam_id] || ''),
      exam: String(r[idx.exam] || '').trim(),
      level: r[idx.level],
      duration: Number(r[idx.duration]) || 0,
      check: r[idx.check] === true,
      archived: r[idx.archived] === true,
      retakeOpen: r[idx.retakeOpen] === true,
      showAnswerReview: r[idx.showAnswerReview] !== false,
      startDate: normalizeExamDateCell_(r[idx.start]),
      startTime: normalizeExamTimeCell_(r[idx.startTime]),
      endDate: normalizeExamDateCell_(r[idx.end]),
      endTime: normalizeExamTimeCell_(r[idx.endTime])
    };
  }
  return null;
}

// كانت الإزاحة "+03:00" مكتوبة صراحة بافتراض "Asia/Bahrain" — لكن منطقة شيت rules الزمنية
// الفعلية "Asia/Muscat" (+04:00، تشخيص حي 2026-09-14)، فكان أي وقت قريب من منتصف الليل يُزاح
// ليوم كامل عند مقارنته بـDate.now() الفعلي، فيُحظَر الاختبار بسبب exam-closed رغم أن تواريخه
// المُدخَلة بالشيت صحيحة تمامًا. استخدام examSheetTimeZone_/utcOffsetString_ (dataGet.js)
// ديناميكيًا يجعل الحساب صحيحًا بصرف النظر عن أي منطقة زمنية فعلية. راجع مناقشات.md.
function examRuleBoundaryMs_(rule, which) {
  var dateText = which === 'start' ? rule.startDate : rule.endDate;
  var timeText = which === 'start' ? rule.startTime : rule.endTime;
  if (!dateText) return null;
  var fallback = which === 'start' ? '00:00' : '23:59';
  var offset = utcOffsetString_(examSheetTimeZone_());
  var ms = new Date(dateText + 'T' + (timeText || fallback) + ':00' + offset).getTime();
  return isNaN(ms) ? null : ms;
}

function examCanStartNow_(rule) {
  if (!rule || !rule.exam || rule.archived || !rule.check || !rule.duration) return false;
  var now = Date.now();
  var startMs = examRuleBoundaryMs_(rule, 'start');
  var endMs = examRuleBoundaryMs_(rule, 'end');
  if (startMs !== null && now < startMs) return false;
  if (endMs !== null && now > endMs) return false;
  return true;
}

function studentExamContext_(cpr) {
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  if (!sh || sh.getLastRow() < 2) return null;
  var hm = headerMap_(sh), h = hm.map;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var row = rows.find(function (r) { return normalizeCpr_(r[h.cpr]) === normalizeCpr_(cpr); });
  if (!row) return null;
  var activeLevel = null;
  for (var i = 0; i < 4; i++) {
    if (row[h['class' + i]] === 'active') { activeLevel = i; break; }
  }
  return {
    cpr: normalizeCpr_(row[h.cpr]),
    name: h.name !== undefined ? row[h.name] : '',
    gender: h.gender !== undefined ? row[h.gender] : '',
    phone: h.phone !== undefined ? row[h.phone] : '',
    email: h.email !== undefined ? row[h.email] : '',
    emailVerified: h.emailVerified !== undefined ? row[h.emailVerified] === true : false,
    contactPreference: h.contactPreference !== undefined ? String(row[h.contactPreference] || '') : '',
    mazhab: h.mazhab !== undefined ? String(row[h.mazhab] || '').trim() : '',
    activeLevel: activeLevel
  };
}

function activeMadhabNames_() {
  return (getMadhabsList() || []).filter(function (m) { return m.archived !== true; })
    .map(function (m) { return String(m.name || '').trim(); })
    .filter(function (name) { return !!name; });
}

function examModelKey_(examId, branch, level, form) {
  return [String(examId), String(branch), String(level), String(form)].join('|');
}

function examModelStatusMap_() {
  var sh = ensureExamModelsSheet_();
  var hm = headerMap_(sh), h = hm.map, out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r) {
    out[examModelKey_(r[h.exam_id], r[h.branch], r[h.level], r[h.form])] = String(r[h.status] || 'draft');
  });
  return out;
}

function upsertExamModelState_(examId, branch, level, form, status, userCpr) {
  var sh = ensureExamModelsSheet_(), hm = headerMap_(sh), h = hm.map;
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues() : [];
  var key = examModelKey_(examId, branch, level, form), rowNum = -1;
  for (var i = 0; i < rows.length; i++) {
    if (examModelKey_(rows[i][h.exam_id], rows[i][h.branch], rows[i][h.level], rows[i][h.form]) === key) { rowNum = i + 2; break; }
  }
  var now = new Date(), row = rowNum > -1 ? sh.getRange(rowNum, 1, 1, sh.getLastColumn()).getValues()[0] : new Array(sh.getLastColumn()).fill('');
  row[h.exam_id] = examId;
  row[h.branch] = branch;
  row[h.level] = level;
  row[h.form] = form;
  row[h.status] = status;
  row[h.updated_at] = now;
  if (status === 'approved') {
    row[h.approved_by] = userCpr;
    row[h.approved_at] = now;
  } else {
    row[h.approved_by] = '';
    row[h.approved_at] = '';
  }
  if (rowNum > -1) sh.getRange(rowNum, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
}

function markExamModelDraft_(examId, branch, level, form, userCpr) {
  upsertExamModelState_(examId, branch, level, form, 'draft', userCpr || 'system');
}

function approvedExamForms_(examId, branch, level) {
  var sh = ensureExamModelsSheet_(), hm = headerMap_(sh), h = hm.map;
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .filter(function (r) {
      return String(r[h.exam_id]) === String(examId) && String(r[h.branch]) === String(branch) &&
        String(r[h.level]) === String(level) && r[h.status] === 'approved';
    }).map(function (r) { return String(r[h.form]); });
}

// يحوّل القيمة المخزَّنة في "الجواب الصحيح" إلى الصيغة المعيارية 1..5. الكتابة
// الجديدة تستخدم رقمًا دائمًا، لكن بعض الصفوف القديمة/المستوردة قد تحتوي رقمًا عربيًا،
// حرف الاختيار، نص الإجابة نفسه، أو 0 للخيار الأول من النسخة القديمة ذات الفهرسة الصفرية.
function resolveStoredCorrectAnswerNumber_(raw, answers) {
  answers = (answers || []).slice(0, 5);
  if (raw === null || raw === undefined || String(raw).trim() === '') return NaN;

  var value = String(raw).trim().replace(/ـ/g, '');
  value = value.replace(/[٠-٩]/g, function (d) { return String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)); });
  value = value.replace(/[۰-۹]/g, function (d) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)); });

  if (/^\d+$/.test(value)) {
    var number = parseInt(value, 10);
    if (number >= 1 && number <= 5) return number;
    if (number === 0 && String(answers[0] || '').trim()) return 1;
  }

  var key = value.replace(/\s+/g, '').replace(/^ال/, '').toLowerCase();
  var words = {
    a: 1, b: 2, c: 3, d: 4, e: 5,
    'أ': 1, 'إ': 1, 'ا': 1, 'آ': 1, 'ب': 2, 'ج': 3, 'د': 4, 'ه': 5, 'و': 5,
    'اول': 1, 'ثاني': 2, 'ثالث': 3, 'رابع': 4, 'خامس': 5,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5
  };
  if (Object.prototype.hasOwnProperty.call(words, key)) return words[key];

  var exactMatches = [];
  answers.forEach(function (answer, index) {
    if (String(answer || '').trim() === String(raw).trim()) exactMatches.push(index + 1);
  });
  return exactMatches.length === 1 ? exactMatches[0] : NaN;
}

function modelQuestionRows_(examId, branch, level, form) {
  var sh = SpreadsheetApp.openById(refID).getSheetByName('questions');
  var headers = ensureQuestionManagementColumns_(), h = {};
  headers.forEach(function (name, i) { h[name] = i; });
  if (sh.getLastRow() < 2) return { sheet: sh, headers: headers, map: h, rows: [], rowNumbers: [] };
  var rows = [], rowNumbers = [];
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r, index) {
    var sameIdentity = String(r[h.exam_id] || '') === String(examId) || !r[h.exam_id];
    if (sameIdentity && String(r[h['الكتاب / المتن']]) === String(branch) &&
      String(r[h['المرحلة']]) === String(level) && String(r[h['نموذج']]) === String(form)) {
      rows.push(r);
      rowNumbers.push(index + 2);
    }
  });
  return { sheet: sh, headers: headers, map: h, rows: rows, rowNumbers: rowNumbers };
}

function validateModelForApproval_(examId, branch, level, form) {
  var data = modelQuestionRows_(examId, branch, level, form), h = data.map;
  if (!data.rows.length) return { ok: false, message: 'لا يمكن اعتماد نموذج بلا أسئلة' };
  var repaired = 0;
  for (var i = 0; i < data.rows.length; i++) {
    var r = data.rows[i], filled = 0, answers = [];
    for (var a = 1; a <= 5; a++) {
      answers.push(r[h['answer-' + a]]);
      if (String(r[h['answer-' + a]] || '').trim()) filled++;
    }
    var rawCorrect = r[h['الجواب الصحيح']];
    var correct = resolveStoredCorrectAnswerNumber_(rawCorrect, answers);
    if (!String(r[h['السؤال']] || '').trim()) return { ok: false, message: 'السؤال رقم ' + (i + 1) + ' بلا نص' };
    if (filled < 2) return { ok: false, message: 'السؤال رقم ' + (i + 1) + ' يحتاج اختيارين مكتوبين على الأقل' };
    if (!(correct >= 1 && correct <= 5) || !String(r[h['answer-' + correct]] || '').trim()) {
      return { ok: false, message: 'السؤال رقم ' + (i + 1) + ' لا يحتوي إجابة صحيحة واحدة صالحة' };
    }
    // إصلاح ذاتي للسجل القديم حتى يقرأه مسار أداء الاختبار لاحقًا بنفس الصيغة المعيارية.
    if (typeof rawCorrect !== 'number' || rawCorrect !== correct) {
      data.sheet.getRange(data.rowNumbers[i], h['الجواب الصحيح'] + 1).setValue(correct);
      r[h['الجواب الصحيح']] = correct;
      repaired++;
    }
  }
  return { ok: true, repaired: repaired };
}

function setExamModelApproval(userCpr, examId, form, mazhab, approved) {
  var perm = hasExamPermission(userCpr);
  if (!perm.allowed) return { error: true, message: 'لا تملك صلاحية اعتماد نماذج الاختبارات' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var rule = examRuleById_(examId);
    if (!rule) return { error: true, message: 'الاختبار غير موجود' };
    var branch = rule.exam === 'الفقه' ? String(mazhab || '').trim() : rule.exam;
    if (!branch || (rule.exam === 'الفقه' && activeMadhabNames_().indexOf(branch) === -1)) {
      return { error: true, message: 'يلزم تحديد مذهب صالح' };
    }
    var validation = { repaired: 0 };
    if (approved) {
      validation = validateModelForApproval_(examId, branch, rule.level, form);
      if (!validation.ok) return { error: true, message: validation.message };
    }
    upsertExamModelState_(examId, branch, rule.level, form, approved ? 'approved' : 'draft', userCpr);
    logExamOperation_(userCpr, approved ? 'approve_model' : 'unapprove_model', branch + ' — نموذج ' + form);
    return { ok: true, status: approved ? 'approved' : 'draft', repaired: validation.repaired || 0 };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function deleteSheetRowsInRuns_(sheet, rowNumbers) {
  if (!rowNumbers || !rowNumbers.length) return;
  var sorted = rowNumbers.slice().sort(function (a, b) { return b - a; });
  var runTop = sorted[0], runBottom = sorted[0];
  for (var i = 1; i < sorted.length; i++) {
    var rowNumber = sorted[i];
    if (rowNumber === runBottom - 1) {
      runBottom = rowNumber;
      continue;
    }
    sheet.deleteRows(runBottom, runTop - runBottom + 1);
    runTop = rowNumber;
    runBottom = rowNumber;
  }
  sheet.deleteRows(runBottom, runTop - runBottom + 1);
}

// حذف نموذج واحد حذفًا فعليًا: كل أسئلته + سجل اعتماده. جلسات الطلاب الجارية آمنة
// لأنها تحفظ نسخة مستقلة من الأسئلة عند بدء المحاولة.
function deleteExamModel(userCpr, examId, form, mazhab) {
  var perm = hasExamPermission(userCpr);
  if (!perm.allowed) return { error: true, message: 'لا تملك صلاحية حذف نماذج الاختبارات' };
  if (form === null || form === undefined || String(form).trim() === '') {
    return { error: true, message: 'رقم النموذج غير صالح' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var rule = examRuleById_(examId);
    if (!rule) return { error: true, message: 'الاختبار غير موجود' };
    var branch = rule.exam === 'الفقه' ? String(mazhab || '').trim() : rule.exam;
    if (!branch || (rule.exam === 'الفقه' && activeMadhabNames_().indexOf(branch) === -1)) {
      return { error: true, message: 'يلزم تحديد مذهب صالح' };
    }

    var questionData = modelQuestionRows_(examId, branch, rule.level, form);
    var deletedQuestions = questionData.rowNumbers.length;
    deleteSheetRowsInRuns_(questionData.sheet, questionData.rowNumbers);

    var modelsSheet = ensureExamModelsSheet_(), hm = headerMap_(modelsSheet), h = hm.map;
    var modelRows = modelsSheet.getLastRow() > 1
      ? modelsSheet.getRange(2, 1, modelsSheet.getLastRow() - 1, modelsSheet.getLastColumn()).getValues()
      : [];
    var key = examModelKey_(examId, branch, rule.level, form), stateRows = [];
    modelRows.forEach(function (row, index) {
      if (examModelKey_(row[h.exam_id], row[h.branch], row[h.level], row[h.form]) === key) stateRows.push(index + 2);
    });
    deleteSheetRowsInRuns_(modelsSheet, stateRows);

    logExamOperation_(userCpr, 'delete_model', branch + ' — نموذج ' + form + ' (' + deletedQuestions + ' سؤالًا)');
    return { ok: true, deletedQuestions: deletedQuestions };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function examReadinessForRule_(rule) {
  var branches = rule.exam === 'الفقه' ? activeMadhabNames_() : [rule.exam];
  if (!branches.length) branches = ['لا توجد مذاهب نشطة'];
  var details = branches.map(function (branch) {
    var count = branch === 'لا توجد مذاهب نشطة' ? 0 : approvedExamForms_(rule.id, branch, rule.level).length;
    return { branch: branch, approvedModels: count, ready: count > 0 };
  });
  return { ready: details.every(function (d) { return d.ready; }), branches: details };
}

function examSessionRecordFromRow_(headers, row, rowNumber) {
  var h = {};
  headers.forEach(function (name, i) { h[name] = i; });
  return {
    rowNumber: rowNumber,
    sessionId: String(row[h.session_id] || ''), attemptId: String(row[h.attempt_id] || ''),
    cpr: normalizeCpr_(row[h.cpr]), examId: String(row[h.exam_id] || ''), exam: String(row[h.exam] || ''),
    level: row[h.level], matn: String(row[h.matn] || ''), model: String(row[h.model] || ''),
    startTime: Number(row[h.startTime]) || 0, endTime: Number(row[h.endTime]) || 0,
    status: String(row[h.status] || ''), questionsJson: String(row[h.questionsJson] || '[]'),
    answersJson: String(row[h.answersJson] || '[]'), lastHeartbeat: Number(row[h.lastHeartbeat]) || 0,
    disconnectNotifiedAt: row[h.disconnectNotifiedAt], headers: headers, map: h, values: row
  };
}

function findExamSession_(cpr, examId, level, onlyActive, sessionId) {
  var sh = ensureExamSessionsSheet_(), headers = headerMap_(sh).headers;
  if (sh.getLastRow() < 2) return null;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    var s = examSessionRecordFromRow_(headers, rows[i], i + 2);
    if (sessionId && s.sessionId !== String(sessionId)) continue;
    if (normalizeCpr_(s.cpr) !== normalizeCpr_(cpr)) continue;
    if (examId && s.examId !== String(examId)) continue;
    if (level !== null && level !== undefined && String(s.level) !== String(level)) continue;
    if (onlyActive && s.status !== 'active') continue;
    return s;
  }
  return null;
}

function parseSessionJson_(raw, fallback) {
  try { return JSON.parse(raw || ''); } catch (err) { return fallback; }
}

function sessionClientPayload_(s, resumed) {
  var questions = parseSessionJson_(s.questionsJson, []);
  return {
    resumed: !!resumed,
    sessionId: s.sessionId,
    attemptId: s.attemptId,
    examId: s.examId,
    exam: s.exam,
    branch: s.matn || s.exam,
    level: s.level,
    model: s.model,
    startTime: s.startTime,
    endTime: s.endTime,
    savedAnswers: parseSessionJson_(s.answersJson, []),
    questions: questions.map(function (q) {
      return { row: q.row, questionId: q.questionId, branch: q.branch, form: q.form, level: q.level, question: q.question, answers: q.answers };
    })
  };
}

function existingExamResult_(cpr, rule) {
  var sh = ensureAnswersTrackingColumns_(), hm = headerMap_(sh), h = hm.map;
  if (sh.getLastRow() < 2) return null;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (normalizeCpr_(rows[i][h.cpr]) !== normalizeCpr_(cpr)) continue;
    var idMatches = rows[i][h.exam_id] ? String(rows[i][h.exam_id]) === String(rule.id) : (rows[i][h.exam] === rule.exam);
    if (idMatches && String(rows[i][h.level]) === String(rule.level)) return { rowNumber: i + 2, row: rows[i], rate: rows[i][h.rate] };
  }
  return null;
}

function startOrResumeExam_(cpr, examId) {
  cpr = normalizeCpr_(cpr);
  var rule = examRuleById_(examId);
  if (!rule) return { blocked: true, reason: 'exam-not-found' };

  var active = findExamSession_(cpr, rule.id, rule.level, true, null);
  if (active) {
    if (Date.now() <= active.endTime + 30000) return sessionClientPayload_(active, true);
    var expiredResult = finalizeExamSession_(active, true);
    return { blocked: true, reason: 'time-expired', result: expiredResult };
  }

  if (!examCanStartNow_(rule)) return { blocked: true, reason: 'exam-closed' };
  var student = studentExamContext_(cpr);
  if (!student) return { blocked: true, reason: 'student-not-found' };
  if (String(student.activeLevel) !== String(rule.level)) return { blocked: true, reason: 'wrong-level' };

  var existing = existingExamResult_(cpr, rule);
  if (existing && existing.rate !== 'راسب') return { blocked: true, reason: 'already-recorded' };
  if (existing && existing.rate === 'راسب' && !rule.retakeOpen) return { blocked: true, reason: 'retake-closed' };

  var branch = rule.exam;
  if (rule.exam === 'الفقه') {
    branch = student.mazhab;
    if (!branch || activeMadhabNames_().indexOf(branch) === -1) return { blocked: true, reason: 'missing-madhab' };
  }

  var approvedForms = approvedExamForms_(rule.id, branch, rule.level);
  if (!approvedForms.length) return { blocked: true, reason: 'no-approved-model' };
  var chosenForm = approvedForms[Math.floor(Math.random() * approvedForms.length)];
  var qData = modelQuestionRows_(rule.id, branch, rule.level, chosenForm), h = qData.map;
  var snapshots = qData.rows.map(function (r) {
    var answers = [r[h['answer-1']], r[h['answer-2']], r[h['answer-3']], r[h['answer-4']], r[h['answer-5']]];
    return {
      row: r[h['#']], questionId: r[h.question_id] || '', branch: branch, form: chosenForm, level: rule.level,
      question: r[h['السؤال']],
      answers: answers,
      trueAnswer: resolveStoredCorrectAnswerNumber_(r[h['الجواب الصحيح']], answers)
    };
  }).filter(function (q) {
    return q.question && q.answers.filter(function (a) { return String(a || '').trim(); }).length >= 2 && q.trueAnswer >= 1 && q.trueAnswer <= 5;
  });
  if (!snapshots.length) {
    markExamModelDraft_(rule.id, branch, rule.level, chosenForm, 'system');
    return { blocked: true, reason: 'no-approved-model' };
  }
  snapshots = shuffle_(snapshots);

  var sh = ensureExamSessionsSheet_(), hm = headerMap_(sh), mh = hm.map;
  var now = Date.now(), sessionId = Utilities.getUuid(), attemptId = Utilities.getUuid();
  var row = new Array(sh.getLastColumn()).fill('');
  row[mh.session_id] = sessionId; row[mh.attempt_id] = attemptId; row[mh.cpr] = cpr;
  row[mh.exam_id] = rule.id; row[mh.exam] = rule.exam; row[mh.level] = rule.level;
  row[mh.matn] = rule.exam === 'الفقه' ? branch : ''; row[mh.model] = chosenForm;
  row[mh.startTime] = now; row[mh.endTime] = now + rule.duration * 60 * 1000; row[mh.status] = 'active';
  row[mh.questionsJson] = JSON.stringify(snapshots); row[mh.answersJson] = '[]';
  row[mh.lastHeartbeat] = now; row[mh.createdAt] = new Date(); row[mh.updatedAt] = new Date();
  sh.appendRow(row);
  ensureExamAutomationTriggers_();
  var created = findExamSession_(cpr, rule.id, rule.level, true, sessionId);
  return sessionClientPayload_(created, false);
}

function checkExamSessionState(cpr, examId) {
  var rule = examRuleById_(examId);
  if (!rule) return { active: false };
  var s = findExamSession_(cpr, rule.id, rule.level, true, null);
  if (!s || Date.now() > s.endTime + 30000) return { active: false };
  return { active: true, examId: s.examId, exam: s.exam, branch: s.matn || s.exam, level: s.level, endTime: s.endTime, message: 'لديك جلسة اختبار غير مكتملة ويمكنك استكمالها قبل انتهاء الوقت.' };
}

function sanitizeExamAnswers_(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.slice(0, 500).map(function (v) { return String(v == null ? '' : v).substring(0, 2000); });
}

function saveExamSessionProgress(cpr, sessionId, answers) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, reason: 'busy' };
  try {
    var s = findExamSession_(cpr, null, null, true, sessionId);
    if (!s) return { ok: false, reason: 'no-session' };
    if (Date.now() > s.endTime + 30000) {
      var result = finalizeExamSession_(s, true);
      return { ok: false, reason: 'time-expired', result: result };
    }
    var sh = ensureExamSessionsSheet_(), h = s.map;
    sh.getRange(s.rowNumber, h.answersJson + 1).setValue(JSON.stringify(sanitizeExamAnswers_(answers)));
    sh.getRange(s.rowNumber, h.lastHeartbeat + 1).setValue(Date.now());
    sh.getRange(s.rowNumber, h.updatedAt + 1).setValue(new Date());
    return { ok: true, endTime: s.endTime };
  } finally {
    lock.releaseLock();
  }
}

function gradeExamSession_(s, answerEntries) {
  var questions = parseSessionJson_(s.questionsJson, []), byQuestion = {};
  sanitizeExamAnswers_(answerEntries).forEach(function (entry) {
    var sep = entry.indexOf('%');
    if (sep < 0) return;
    byQuestion[entry.substring(0, sep)] = entry.substring(sep + 1);
  });
  var correctCount = 0;
  var results = questions.map(function (q) {
    var userAnswer = byQuestion.hasOwnProperty(q.question) ? byQuestion[q.question] : '';
    var trueAnswer = q.answers[q.trueAnswer - 1];
    var correct = String(trueAnswer) === String(userAnswer);
    if (correct) correctCount++;
    return { question: q.question, trueAnswer: trueAnswer, userAnswer: userAnswer, correct: correct };
  });
  var totalCount = questions.length;
  var degree = totalCount ? Number(((correctCount / totalCount) * 100).toFixed(2)) : 0;
  var rate = degree >= 90 ? 'ممتاز' : degree >= 80 ? 'جيّد جدًا' : degree >= 70 ? 'جيّد' : degree >= 50 ? 'مقبول' : 'راسب';
  return { degree: degree, rate: rate, results: results, correctCount: correctCount, totalCount: totalCount };
}

function setAnswerRowValue_(row, h, name, value) {
  if (h[name] !== undefined && h[name] > -1) row[h[name]] = value;
}

function writeExamResult_(s, answerEntries, grade) {
  var sh = ensureAnswersTrackingColumns_(), hm = headerMap_(sh), headers = hm.headers, h = hm.map;
  var rows = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues() : [];
  var target = -1;
  for (var i = 0; i < rows.length; i++) {
    if (normalizeCpr_(rows[i][h.cpr]) !== normalizeCpr_(s.cpr) || String(rows[i][h.level]) !== String(s.level)) continue;
    var same = rows[i][h.exam_id] ? String(rows[i][h.exam_id]) === String(s.examId) : rows[i][h.exam] === s.exam;
    if (same) { target = i; break; }
  }
  if (target > -1 && rows[target][h.rate] !== 'راسب') return { ok: false, reason: 'already-recorded' };

  var student = studentExamContext_(s.cpr) || {};
  var row = new Array(headers.length).fill('');
  // اسم العمود الفعلي بشيت answers هو "time" لا "Timestamp" — الاسم الخطأ كان يجعل
  // setAnswerRowValue_ تتجاهل الكتابة بصمت (h['Timestamp'] غير معرَّف)، فيُترَك العمود فارغًا
  // لكل نتيجة اختبار تُكتَب عبر هذا المسار منذ إدخاله، لا اختبارات الفقه فقط — اكتُشف بتشخيص
  // مباشر لعناوين الشيت بعد بلاغ المستخدم عن إجابات بلا وقت مسجَّل. راجع مناقشات.md.
  setAnswerRowValue_(row, h, 'time', new Date());
  setAnswerRowValue_(row, h, 'cpr', s.cpr);
  setAnswerRowValue_(row, h, 'name', student.name || '');
  setAnswerRowValue_(row, h, 'gender', student.gender || '');
  setAnswerRowValue_(row, h, 'phone', student.phone || '');
  setAnswerRowValue_(row, h, 'exam', s.exam);
  // مذهب اختبار الفقه (s.matn هو اسم حقل جلسة الاختبار الداخلي، فارغ دائمًا لغير الفقه) يُكتب
  // بعمود mazhab المخصَّص له حصرًا، لا matn — matn يبقى بلا أي كتابة من هذا المسار إطلاقًا،
  // محجوزًا فقط لاستخدامه الأصلي (اسم متن حفظه الطالب لاختبارات أخرى). راجع
  // ensureAnswersTrackingColumns_ أعلاه لسبب هذا الفصل (تضارب كان يُفسد نص شهادة الفقه).
  setAnswerRowValue_(row, h, 'mazhab', s.matn || '');
  setAnswerRowValue_(row, h, 'level', s.level);
  setAnswerRowValue_(row, h, 'result', grade.degree);
  setAnswerRowValue_(row, h, 'rate', grade.rate);
  setAnswerRowValue_(row, h, 'exam_id', s.examId);
  setAnswerRowValue_(row, h, 'attempt_id', s.attemptId);
  setAnswerRowValue_(row, h, 'session_id', s.sessionId);

  // الإبقاء على تنسيق الإجابات التفصيلي القديم في الأعمدة من العمود 13 فصاعدًا؛ إعادة تصميمه
  // بمعرّفات question_id/option_id مؤجلة بقرار المستخدم.
  var tracking = { exam_id: true, attempt_id: true, session_id: true };
  var answerIndex = 0;
  for (var col = 12; col < headers.length && answerIndex < answerEntries.length; col++) {
    if (tracking[headers[col]]) continue;
    row[col] = answerEntries[answerIndex++];
  }

  if (target > -1) sh.getRange(target + 2, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
  return { ok: true };
}

function finalizeExamSession_(s, expired) {
  if (!s || s.status !== 'active') return { ok: false, reason: 'no-session' };
  var answers = parseSessionJson_(s.answersJson, []);
  var grade = gradeExamSession_(s, answers);
  var write = writeExamResult_(s, answers, grade);
  if (!write.ok) return write;
  var sh = ensureExamSessionsSheet_(), h = s.map;
  sh.getRange(s.rowNumber, h.status + 1).setValue(expired ? 'expired-submitted' : 'submitted');
  sh.getRange(s.rowNumber, h.submittedAt + 1).setValue(new Date());
  sh.getRange(s.rowNumber, h.updatedAt + 1).setValue(new Date());
  var rule = examRuleById_(s.examId), showReview = !rule || rule.showAnswerReview !== false;
  return { ok: true, degree: grade.degree, rate: grade.rate, results: showReview ? grade.results : [], showReview: showReview, correctCount: grade.correctCount, totalCount: grade.totalCount, expired: !!expired };
}

function submitExamSessionAnswers_(cpr, sessionId, answers) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: false, reason: 'busy' };
  try {
    var s = findExamSession_(cpr, null, null, true, sessionId);
    if (!s) return { ok: false, reason: 'no-session' };
    answers = sanitizeExamAnswers_(answers);
    var sh = ensureExamSessionsSheet_(), h = s.map;
    sh.getRange(s.rowNumber, h.answersJson + 1).setValue(JSON.stringify(answers));
    sh.getRange(s.rowNumber, h.lastHeartbeat + 1).setValue(Date.now());
    s.answersJson = JSON.stringify(answers);
    return finalizeExamSession_(s, Date.now() > s.endTime + 30000);
  } finally {
    lock.releaseLock();
  }
}

function studentExamSessionStateMap_(cpr) {
  var out = {}, sh = ensureExamSessionsSheet_(), headers = headerMap_(sh).headers;
  if (!cpr || sh.getLastRow() < 2) return out;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  rows.forEach(function (r, i) {
    var s = examSessionRecordFromRow_(headers, r, i + 2);
    if (normalizeCpr_(s.cpr) === normalizeCpr_(cpr) && s.status === 'active' && Date.now() <= s.endTime + 30000) {
      out[s.examId + '|' + s.level] = { active: true, endTime: s.endTime };
    }
  });
  return out;
}

function ensureExamAutomationTriggers_() {
  try {
    var triggers = ScriptApp.getProjectTriggers(), names = {};
    triggers.forEach(function (t) { names[t.getHandlerFunction()] = true; });
    if (!names.monitorExamSessions) ScriptApp.newTrigger('monitorExamSessions').timeBased().everyMinutes(1).create();
    if (!names.monitorExamReadinessAlerts) ScriptApp.newTrigger('monitorExamReadinessAlerts').timeBased().everyHours(1).create();
  } catch (err) {
    Logger.log('تعذّر ضمان مشغلات متابعة الاختبارات: ' + err);
  }
}

// templateBody: نص قالب "انقطاع الاتصال أثناء اختبار" من messageTemplates، يُجلَب مرة واحدة
// بـmonitorExamSessions خارج حلقتها (لا لكل جلسة) — راجع مناقشات.md "إدارة الرسائل". فارغ يسقط
// للنص الاحتياطي القديم. التسجيل بـmessageLog لمسار واتساب فقط (لا مسار البريد الإلكتروني —
// السجل خاص برسائل واتساب حصرًا حسب التصميم المتفَق عليه).
function sendExamDisconnectNotification_(s, templateBody) {
  var stu = studentExamContext_(s.cpr);
  if (!stu) return false;
  var minutes = Math.max(1, Math.ceil((s.endTime - Date.now()) / 60000));
  // مصدر واحد للنص الاحتياطي (MESSAGE_TEMPLATE_DEFS_.examDisconnect.defaultBody، dataGet.js) —
  // راجع نفس التعليق بـsendWPCertificate_ (dataPost.js).
  var msg = renderMessageTemplate_(templateBody || MESSAGE_TEMPLATE_DEFS_.examDisconnect.defaultBody, { exam: s.exam, minutes: minutes });
  var preferEmail = String(stu.contactPreference || '').toLowerCase().indexOf('mail') !== -1 || String(stu.contactPreference || '').indexOf('بريد') !== -1;
  if (preferEmail && stu.email && stu.emailVerified) {
    try {
      GmailApp.sendEmail(stu.email, 'يمكنك استكمال جلسة الاختبار', msg, {
        name: 'بصائر للعلوم الشرعية',
        htmlBody: buildBasairPlainMessageEmail_('تنبيه اختبار', 'يمكنك استكمال جلسة الاختبار', msg),
        inlineImages: { basairLogo: getBasairLogoBlob_() }
      });
      return true;
    } catch (e1) { Logger.log(e1); }
  }
  if (stu.phone) {
    var wp = sendGeneralWPmsg_(stu.phone, msg);
    var wpOk = !!(wp && wp.status !== false);
    logWhatsAppMessage_({
      campaignId: '',
      templateKey: 'examDisconnect',
      recipientName: stu.name || '',
      recipientTarget: stu.phone,
      targetType: 'phone',
      messageText: msg,
      status: wpOk ? 'sent' : 'failed',
      reason: wpOk ? '' : ((wp && (wp.reason || wp.detail)) || 'خطأ غير معروف من خدمة واتساب'),
      sentBy: ''
    });
    if (wpOk) return true;
  }
  if (stu.email) {
    try {
      GmailApp.sendEmail(stu.email, 'يمكنك استكمال جلسة الاختبار', msg, {
        name: 'بصائر للعلوم الشرعية',
        htmlBody: buildBasairPlainMessageEmail_('تنبيه اختبار', 'يمكنك استكمال جلسة الاختبار', msg),
        inlineImages: { basairLogo: getBasairLogoBlob_() }
      });
      return true;
    } catch (e2) { Logger.log(e2); }
  }
  return false;
}

function monitorExamSessions() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var sh = ensureExamSessionsSheet_(), headers = headerMap_(sh).headers;
    if (sh.getLastRow() < 2) return;
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    var now = Date.now();
    var disconnectTemplateBody = getActiveMessageTemplateBody_('examDisconnect');
    rows.forEach(function (r, i) {
      var s = examSessionRecordFromRow_(headers, r, i + 2);
      if (s.status !== 'active') return;
      if (now > s.endTime + 30000) { finalizeExamSession_(s, true); return; }
      if (!s.disconnectNotifiedAt && now - s.lastHeartbeat >= 120000 && s.endTime - now > 300000) {
        if (sendExamDisconnectNotification_(s, disconnectTemplateBody)) {
          sh.getRange(s.rowNumber, s.map.disconnectNotifiedAt + 1).setValue(new Date());
          sh.getRange(s.rowNumber, s.map.updatedAt + 1).setValue(new Date());
        }
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function getExamReadinessWarnings_() {
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules'), headers = ensureExamManagementColumns_(), h = {};
  headers.forEach(function (name, i) { h[name] = i; });
  if (sh.getLastRow() < 2) return [];
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues(), warnings = [];
  rows.forEach(function (r) {
    if (!r[h.exam] || r[h.archived] === true) return;
    var rule = examRuleById_(r[h.exam_id]);
    var startMs = examRuleBoundaryMs_(rule, 'start');
    var endMs = examRuleBoundaryMs_(rule, 'end');
    if (endMs !== null && Date.now() > endMs) return;
    var readiness = examReadinessForRule_(rule);
    readiness.branches.forEach(function (d) {
      if (!d.ready) warnings.push({ examId: rule.id, exam: rule.exam, level: rule.level, branch: d.branch, startMs: startMs, hoursToStart: startMs === null ? null : (startMs - Date.now()) / 3600000 });
    });
  });
  return warnings;
}

function examAlertRecipients_() {
  ensureEmpManagementColumns_();
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('emp'), hm = headerMap_(sh), h = hm.map;
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().filter(function (r) {
    return r[h['إدارة']] === true || r[h['اختبار']] === true;
  }).map(function (r) { return { email: String(r[h.email] || '').trim(), phone: String(r[h.phone] || '').trim() }; });
}

// templateBody: نص قالب "تنبيه جاهزية اختبار" من messageTemplates، يُجلَب مرة واحدة
// بـmonitorExamReadinessAlerts خارج حلقتها. فارغ يسقط للنص الاحتياطي القديم. الطلب لعدة أرقام
// معًا بنداء Fonnte واحد (كما كان) — لا حالة نجاح/فشل منفصلة لكل مستلم من Fonnte بهذه الحالة،
// فتُسجَّل نفس النتيجة الإجمالية لكل رقم بسجل الرسائل.
function sendExamAdminReadinessAlert_(warning, urgent, templateBody) {
  var stageNames = ['التأهيلية', 'التأسيسية', 'التأصيلية', 'التحصيلية'];
  var scope = warning.exam === 'الفقه' ? (' — ' + warning.branch) : '';
  var levelLabel = stageNames[+warning.level] || warning.level;
  // مصدر واحد للنص الاحتياطي (MESSAGE_TEMPLATE_DEFS_.examReadinessAlert.defaultBody، dataGet.js).
  var msg = renderMessageTemplate_(templateBody || MESSAGE_TEMPLATE_DEFS_.examReadinessAlert.defaultBody, { exam: warning.exam + scope, level: levelLabel });
  var recipients = examAlertRecipients_(), seenEmails = {}, phones = [];
  recipients.forEach(function (r) {
    if (r.email && !seenEmails[r.email]) {
      seenEmails[r.email] = true;
      var subject = urgent ? 'تنبيه عاجل: اختبار بلا نموذج معتمد' : 'تنبيه جاهزية اختبار';
      try {
        GmailApp.sendEmail(r.email, subject, msg, {
          name: 'بصائر للعلوم الشرعية',
          htmlBody: buildBasairPlainMessageEmail_('تنبيه إداري', subject, msg),
          inlineImages: { basairLogo: getBasairLogoBlob_() }
        });
      } catch (err) { Logger.log(err); }
    }
    if (urgent && r.phone) phones.push(r.phone);
  });
  if (urgent && phones.length) {
    var wp = sendGeneralWPmsg_(phones, msg);
    var wpOk = !!(wp && wp.status !== false);
    phones.forEach(function (phone) {
      logWhatsAppMessage_({
        campaignId: '',
        templateKey: 'examReadinessAlert',
        recipientName: '',
        recipientTarget: phone,
        targetType: 'phone',
        messageText: msg,
        status: wpOk ? 'sent' : 'failed',
        reason: wpOk ? '' : ((wp && (wp.reason || wp.detail)) || 'خطأ غير معروف من خدمة واتساب'),
        sentBy: ''
      });
    });
  }
}

function examAlertPropertyKey_(warning, threshold) {
  return 'examReady_' + Utilities.base64EncodeWebSafe(String(warning.examId) + '|' + String(warning.branch)) + '_' + threshold;
}

function monitorExamReadinessAlerts() {
  var warnings = getExamReadinessWarnings_(), props = PropertiesService.getScriptProperties(), missingKeys = {};
  var readinessTemplateBody = getActiveMessageTemplateBody_('examReadinessAlert');
  warnings.forEach(function (w) {
    var base = String(w.examId) + '|' + String(w.branch); missingKeys[base] = true;
    if (w.hoursToStart === null || w.hoursToStart > 168) return;
    var key7 = examAlertPropertyKey_(w, '7d'), key48 = examAlertPropertyKey_(w, '48h');
    if (w.hoursToStart <= 48) {
      if (!props.getProperty(key48)) sendExamAdminReadinessAlert_(w, true, readinessTemplateBody);
      props.setProperty(key48, new Date().toISOString());
      if (!props.getProperty(key7)) props.setProperty(key7, new Date().toISOString());
    } else if (!props.getProperty(key7)) {
      sendExamAdminReadinessAlert_(w, false, readinessTemplateBody);
      props.setProperty(key7, new Date().toISOString());
    }
  });

  // إعادة فتح دورة التنبيه تلقائيًا بعد إصلاح الجاهزية، حتى لو فُقد الاعتماد لاحقًا.
  var all = props.getProperties();
  Object.keys(all).filter(function (k) { return k.indexOf('examReady_') === 0; }).forEach(function (key) {
    var stillMissing = warnings.some(function (w) { return key.indexOf(Utilities.base64EncodeWebSafe(String(w.examId) + '|' + String(w.branch))) !== -1; });
    if (!stillMissing) props.deleteProperty(key);
  });
}
