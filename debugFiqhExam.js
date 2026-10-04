// دالة تشخيص مؤقتة — تطبع بحالة كل اختبار "فقه" (منفصل تحت مادة الفقه الحنبلي/المالكي/الشافعي،
// أو الموحّد القديم) القيم الخام من شيت rules، ونتيجة examCanStartNow_ الفعلية، وعناوين شيت
// answers — لتشخيص بلاغ "الاختبار غير متاح" + الإجابات بلا وقت. ادفع بـ clasp push، شغّلها
// مرة واحدة من محرر الأكواد (Run > debugFiqhExamAvailability)، وابعت محتوى Logger.log (أو
// View > Executions). بعد التشخيص احذف هذا الملف بالكامل.

function debugFiqhExamAvailability() {
  var refSs = SpreadsheetApp.openById(refID);
  Logger.log('rules spreadsheet timezone: ' + refSs.getSpreadsheetTimeZone() + ' | script timezone: ' + Session.getScriptTimeZone());

  var rulesSh = refSs.getSheetByName('rules');
  var headers = ensureExamManagementColumns_();
  Logger.log('rules sheet headers (بالترتيب الفعلي): ' + JSON.stringify(headers));
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = i; });
  var lastRow = rulesSh.getLastRow();
  var rows = lastRow > 1 ? rulesSh.getRange(2, 1, lastRow - 1, rulesSh.getLastColumn()).getValues() : [];

  // القيم الخام تمامًا (قبل أي تطبيع/تحويل) لعمودي start/end وend/startTime لأول اختبار فقه
  // نجده — لمعرفة هل الفرق بين المعروض بالشيت والمقروء بالكود مصدره القيمة الخام نفسها (Date
  // object بتوقيت غير متوقَّع) أو خطوة التطبيع (normalizeExamDateCell_/normalizeExamTimeCell_).
  var rawDumped = false;
  rows.forEach(function (r) {
    if (rawDumped || !r[idx.exam] || r[idx.exam] === 'الفقه') return;
    rawDumped = true;
    ['start', 'startTime', 'end', 'endTime'].forEach(function (col) {
      var raw = r[idx[col]];
      Logger.log('rules RAW[' + col + '] لاختبار "' + r[idx.exam] + '": typeof=' + (typeof raw) +
        ' | instanceof Date=' + (raw instanceof Date) +
        ' | raw.toString()=' + (raw && raw.toString ? raw.toString() : String(raw)) +
        ' | raw.toISOString()=' + (raw instanceof Date ? raw.toISOString() : 'n/a'));
    });
  });

  var subjectsList = getSubjectsList();
  var curriculaList = getCurriculaList();
  var subjectById = {};
  subjectsList.forEach(function (s) { subjectById[s.id] = s; });

  var found = 0;
  rows.forEach(function (r) {
    var examName = r[idx.exam];
    if (!examName) return;
    var subjectName = findSubjectNameForExam_(examName, r[idx.level], curriculaList, subjectById);
    var isFiqhRelated = examName === 'الفقه' || !!fiqhRootIn_(subjectName);
    if (!isFiqhRelated) return;
    found++;

    var rule = examRuleById_(String(r[idx.exam_id]));
    var startMs = examRuleBoundaryMs_(rule, 'start');
    var endMs = examRuleBoundaryMs_(rule, 'end');
    Logger.log(JSON.stringify({
      exam: rule.exam,
      examId: rule.id,
      subject: subjectName,
      level: rule.level,
      check: rule.check,
      archived: rule.archived,
      duration: rule.duration,
      startDate: rule.startDate, startTime: rule.startTime,
      endDate: rule.endDate, endTime: rule.endTime,
      startMs: startMs, startLocal: startMs ? new Date(startMs).toString() : null,
      endMs: endMs, endLocal: endMs ? new Date(endMs).toString() : null,
      nowMs: Date.now(), nowLocal: new Date().toString(),
      canStartNow: examCanStartNow_(rule)
    }, null, 2));
  });

  if (!found) Logger.log('لم يُعثر على أي اختبار مرتبط بمادة فقه أو باسم "الفقه" بشيت rules.');

  var answersSh = ensureAnswersTrackingColumns_();
  var answersHeaders = answersSh.getRange(1, 1, 1, answersSh.getLastColumn()).getValues()[0];
  Logger.log('answers sheet headers: ' + JSON.stringify(answersHeaders));

  // آخر 5 صفوف خامًا (بلا أي معالجة) — لمعرفة القيمة الفعلية بعمود "time" لآخر النتائج المسجَّلة
  // بالضبط، بدل الاعتماد على وصف الطالب فقط، ولاستبعاد أي التباس بترتيب/تسمية الأعمدة.
  var timeColIdx = answersHeaders.indexOf('time');
  var lastRow2 = answersSh.getLastRow();
  if (lastRow2 > 1) {
    var fromRow = Math.max(2, lastRow2 - 4);
    var lastRows = answersSh.getRange(fromRow, 1, lastRow2 - fromRow + 1, answersSh.getLastColumn()).getValues();
    lastRows.forEach(function (r, i) {
      Logger.log('answers row ' + (fromRow + i) + ': time=' + JSON.stringify(r[timeColIdx]) +
        ' | cpr=' + r[answersHeaders.indexOf('cpr')] + ' | exam=' + r[answersHeaders.indexOf('exam')] +
        ' | level=' + r[answersHeaders.indexOf('level')] + ' | rate=' + r[answersHeaders.indexOf('rate')] +
        ' | exam_id=' + r[answersHeaders.indexOf('exam_id')]);
    });
  }
}
