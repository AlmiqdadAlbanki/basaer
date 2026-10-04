/////////////////////////////////////////////////////////////////////////////////////////////////
// يبحث عن اسم المنطقة برقم المجمع عبر خدمة Apps Script خارجية منفصلة، لكن من الخادم
// (UrlFetchApp) لا من متصفح المستخدم، لتفادي مشاكل الإطار المعزول لصفحات Apps Script
// (إعادة توجيه/كوكيز قد تفشل من داخل المتصفح مباشرة، خصوصًا في التصفح الخاص).
/////////////////////////////////////////////////////////////////////////////////////////////////
function lookupBlockArea(blockNumber) {
  try {
    var url = 'https://script.google.com/macros/s/AKfycbypzyoaKyXAToQOANfR8DLvpVvtcc3ThaXUrDOwFVJxtQtzmC5Ek7Q_9uvz1WSspcSS/exec?block=' + encodeURIComponent(blockNumber);
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    return JSON.parse(response.getContentText());
  } catch (err) {
    return { error: true, message: String(err) };
  }
}

function test(){
  thing = 0;

  for(var i = 0 ; i<5 ; i++){
    thing += 1;
  }

  //Logger.log(thing)

}

/////////////////////////////////////////////////////////////////////////////////////////////////

function loginData(user) {

  //user = 850839092;
  ensureEmpManagementColumns_();
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('emp');

  var headers = sh.getRange('1:1').getValues();

  var cprCol = headers[0].indexOf('cpr');
  var nameCol = headers[0].indexOf('name');
  var phoneCol = headers[0].indexOf('phone');
  var mailCol = headers[0].indexOf('email');
  var jobCol = headers[0].indexOf('job');
  var codeCol = headers[0].indexOf('code');
  var genderCol = headers[0].indexOf('gender');
  var registrationCol = headers[0].indexOf('تسجيل');
  var dictationCol = headers[0].indexOf('تسميع');
  var examCol = headers[0].indexOf('اختبار');
  var manageCol = headers[0].indexOf('إدارة');
  var followUpCol = headers[0].indexOf('متابعة');
  var superAdminCol = headers[0].indexOf('superAdmin');
  var avatarCol = headers[0].indexOf('avatarUrl');
  if(user !== 'all'){
  var data = sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues().filter(e=> +e[cprCol] == +user);
  }else{
    var data = sh.getRange(1,1,sh.getLastRow(),sh.getLastColumn()).getValues().filter(e=> +e[cprCol] != '');
  }
  Logger.log(data)
  if(data.length > 0){
    var rData = data.map(function(e){
      return {
        cpr: e[cprCol],
        name: e[nameCol],
        phone: e[phoneCol],
        mail: e[mailCol],
        job: e[jobCol],
        code: e[codeCol],
        gender: e[genderCol],
        registration: e[registrationCol],
        dictation: e[dictationCol],
        exam: e[examCol],
        manage: e[manageCol],
        followUp: e[followUpCol],
        superAdmin: superAdminCol > -1 && e[superAdminCol] === true,
        avatarUrl: genderSafeAvatarUrl_(e[genderCol], avatarCol > -1 ? e[avatarCol] : ''),
      }
    })
  }else{
    var rData = 0;
  }
  Logger.log(data.length);
  return rData;

}
//////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////
function getPersons() {

  //user = 850839092;
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('students');

  var headers = sh.getRange('1:1').getValues();

  var timeCol = headers[0].indexOf('Timestamp');
  var cprCol = headers[0].indexOf('cpr');
  var nameCol = headers[0].indexOf('name');
  var phoneCol = headers[0].indexOf('phone');
  var mailCol = headers[0].indexOf('email');
  var dobCol = headers[0].indexOf('dob');
  var natCol = headers[0].indexOf('nationality');
  var codeCol = headers[0].indexOf('code');
  var genderCol = headers[0].indexOf('gender');
  var areaCol = headers[0].indexOf('area');
  var blockCol = headers[0].indexOf('block');
  var pastStudiesCol = headers[0].indexOf('pastStudies');
  var folderCol = headers[0].indexOf('folder');
  var cardCol = headers[0].indexOf('card');
  var mazhabCol = headers[0].indexOf('mazhab');
  var class0Col = headers[0].indexOf('class0');
  var class1Col = headers[0].indexOf('class1');
  var class2Col = headers[0].indexOf('class2');
  var class3Col = headers[0].indexOf('class3');
  var levelCol = headers[0].indexOf('level');
  var pastCol = headers[0].indexOf('past');
  var congratesCol = headers[0].indexOf('congrates');
  var emailVerifiedCol = headers[0].indexOf('emailVerified');
  var outsideBahrainCol = headers[0].indexOf('outsideBahrain');
  var studyTypeCol = headers[0].indexOf('studyType');
  var avatarCol = headers[0].indexOf('avatarUrl');

  var data = sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues().filter(e=> e[folderCol] != 'no');
  if(data.length > 0){
    var rData = data.map(function(e){
      return {
        time: e[timeCol].toString(),
        cpr: normalizeCpr_(e[cprCol]),
        name: e[nameCol],
        phone: e[phoneCol],
        mail: e[mailCol],
        dob: e[dobCol].toString(),
        nationality: e[natCol],
        code: e[codeCol],
        gender: e[genderCol],
        block: e[blockCol],
        area: e[areaCol],
        pastStudies: e[pastStudiesCol],
        folderUrl: e[folderCol],
        cardUrl: e[cardCol],
        mazhab: e[mazhabCol],
        class0: e[class0Col],
        class1: e[class1Col],
        class2: e[class2Col],
        class3: e[class3Col],
        level: e[levelCol],
        past: e[pastCol],
        congrates: e[congratesCol],
        emailVerified: emailVerifiedCol > -1 ? !!e[emailVerifiedCol] : false,
        isRemote: outsideBahrainCol > -1 ? !!e[outsideBahrainCol] : false,
        studyType: studyTypeCol > -1 ? e[studyTypeCol] : '',
        avatarUrl: genderSafeAvatarUrl_(e[genderCol], avatarCol > -1 ? e[avatarCol] : ''),
      }
    })
  }else{
    var rData = 0;
  }
  Logger.log(data.length);
  return rData;
  
}
//////////////////////////////////////////////////////////////////////////////////////////////
// بيانات تبويب "الملف الشخصي" — تُقرأ دائمًا مباشرة من الشيت (وليس من studentData/userData
// المحمَّلة أصلًا بالصفحة) لأنهما لا تحملان كل الحقول اللازمة هنا (hasPassword/dob/nationality
// غير موجودة إطلاقًا في loginData() الخاصة بالموظفين مثلًا)، ولضمان أحدث نسخة من البيانات عند
// فتح التبويب. تعمل لكلا النوعين (طالب/موظف) عبر findPersonByCpr_ نفسها المستخدَمة في auth.js.
//////////////////////////////////////////////////////////////////////////////////////////////
function getMyProfileData(cpr) {
  cpr = normalizeCpr_(cpr);
  var person = findPersonByCpr_(cpr);
  if (!person) return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };

  ensureProfileColumns_();
  var headers = person.sheet.getRange(1, 1, 1, person.sheet.getLastColumn()).getValues()[0];
  var row = person.sheet.getRange(person.rowNumber, 1, 1, person.sheet.getLastColumn()).getValues()[0];
  function get(col) {
    var i = headers.indexOf(col);
    return i > -1 ? row[i] : '';
  }
  function getDate(col) {
    var v = get(col);
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bahrain', 'yyyy-MM-dd');
    return String(v);
  }

  var isEmployee = person.sheetName === 'emp';
  var data = {
    ok: true,
    isEmployee: isEmployee,
    name: get('name') || '',
    cpr: cpr,
    phone: String(get('phone') || ''),
    email: get('email') || '',
    emailVerified: !!person.emailVerified,
    hasPassword: !!person.hasPassword,
    gender: get('gender') || '',
    dob: getDate('dob'),
    nationality: get('nationality') || '',
    avatarUrl: get('avatarUrl') || ''
  };

  if (isEmployee) {
    data.job = get('job') || '';
    data.manage = !!get('إدارة');
    data.registration = !!get('تسجيل');
    data.dictation = !!get('تسميع');
    data.exam = !!get('اختبار');
    data.followUp = !!get('متابعة');
  } else {
    data.phone2 = String(get('phone2') || '');
    data.block = get('block') || '';
    data.area = get('area') || '';
    data.mazhab = get('mazhab') || '';
    data.contactPreference = get('contactPreference') || 'email';
    var stageKeys = ['class0', 'class1', 'class2', 'class3'];
    data.stageIndex = stageKeys.findIndex(function (k) { return get(k) === 'active'; });
  }

  return data;
}
//////////////////////////////////////////////////////////////////////////////////////////////
function getLecAttend(cpr) {
  // cpr = '050503936'; // لو حابب تثبت CPR مؤقتًا

  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('lecAttend');

  var headers = sh.getRange('1:1').getValues()[0];

  var timeCol = headers.indexOf('Timestamp');
  var cprCol = headers.indexOf('cpr');
  var nameCol = headers.indexOf('name');
  var genderCol = headers.indexOf('gender');
  var lecNameCol = headers.indexOf('study');

  var lastRow = sh.getLastRow();

  if (lastRow <= 1) {
    Logger.log("الشيت فارغ أو لا يحتوي على بيانات.");
    return false;
  }

  var data = sh.getRange(2, 1, lastRow-1, sh.getLastColumn()).getValues()
               .filter(row => row[cprCol] == cpr);

  if (data.length === 0) {
    Logger.log("لا توجد بيانات مطابقة للـ CPR: " + cpr);
    return false;
  }

  var rData = data.map(row => ({
    time: row[timeCol].toString(),
    cpr: normalizeCpr_(row[cprCol]),
    name: row[nameCol],
    gender: row[genderCol],
    lecName: row[lecNameCol],
  }));

  Logger.log("تم العثور على بيانات:", rData);
  return rData;
}



//////////////////////////////////////////////////////////////////////////////////////////////
function testFunc(){
  const certIdTemp = getCertIdTemp_('تفسير الفاتحة وقصار المفصل');
  Logger.log(getAttendance('620726296', certIdTemp.date))
}
//////////////////////////////////////////////////////////////////////////////////////////////
function getAttendance(cpr, fDate) {

  var ss = SpreadsheetApp.openById(attendanceData);
  var sh = ss.getSheetByName('attendance');

  var headers = sh.getRange('1:1').getValues();

  var dateCol = headers[0].indexOf('date/time');
  var codeCol = headers[0].indexOf('id');
  var cprCol = headers[0].indexOf('cpr');
  var nameCol = headers[0].indexOf('name');
  // كل عمود يُحدَّد باسمه في رأس الشيت حصرًا، بلا أي احتياط بموضع ثابت — الاعتماد على موضع
  // افتراضي (كان هنا سابقًا: العمود 6 لـ"resp") انكسر فعليًا حين أُعيد ترتيب/تسمية أعمدة شيت
  // الحضور يدويًا (resp صار by)، فقرأ بيانات عمود "level" باعتبارها resp بصمت. راجع
  // buildAttendanceRow_ (dataPost.js) لنفس المبدأ في الكتابة.
  var respCol = headers[0].indexOf('by');
  var levelCol = headers[0].indexOf('level');

  // نجيب كل الداتا مرة واحدة
  var allData = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();

  // فلتر CPR (لو موجود)
  var data = cpr 
    ? allData.filter(e => +e[cprCol] == +cpr)
    : allData;
   Logger.log(fDate);
  // فلتر التاريخ بعد فلتر CPR
  if (fDate) {
    // تحويل fDate لصيغة يوم/شهر/سنة فقط لو تاريخ
    var targetDate = Utilities.formatDate(new Date(fDate),ss.getSpreadsheetTimeZone(),'dd-MM-yyyy');
    //var tStr = targetDate.toISOString().split("T")[0]; // 2025-10-11
    //Logger.log(targetDate)
    data = data.filter(function(e) {
      //var rowDate = new Date(e[dateCol]);
      var rowDate = Utilities.formatDate(new Date(e[dateCol]),ss.getSpreadsheetTimeZone(),'dd-MM-yyyy');
      //var rStr = rowDate.toISOString().split("T")[0];
      //Logger.log(rowDate)
      return rowDate == targetDate;
    });
  }

  // تجهيز الريترن
  if (data.length > 0) {
    var rData = data.map(function(e) {
      return {
        date: e[dateCol].toString(),
        code: e[codeCol],
        cpr: normalizeCpr_(e[cprCol]),
        name: e[nameCol],
        resp: respCol > -1 ? e[respCol] : '',
        level: levelCol > -1 && e[levelCol] !== '' && e[levelCol] !== undefined ? e[levelCol] : null
      };
    });
  } else {
    var rData = 0;
  }

  return rData;
}

//////////////////////////////////////////////////////////////////////////////////////////////
// طلبات الحضور المعلَّقة (resp='request') من كل الطلاب — لمودال "طلبات الحضور" بلوحة الإدارة.
// انظر requestAttendance/ensureAttendanceReasonHeader_ في dataPost.js لكيفية إنشائها.
//////////////////////////////////////////////////////////////////////////////////////////////
function getAttendanceRequests(){
  var ss = SpreadsheetApp.openById(attendanceData);
  var sh = ss.getSheetByName('attendance');
  ensureAttendanceLevelHeader(sh);
  ensureAttendanceReasonHeader_(sh);

  var headers = sh.getRange('1:1').getValues()[0];
  var dateCol = headers.indexOf('date/time');
  var cprCol = headers.indexOf('cpr');
  var nameCol = headers.indexOf('name');
  var byCol = headers.indexOf('by');
  var levelCol = headers.indexOf('level');
  var reasonCol = headers.indexOf('reason');

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var result = [];
  rows.forEach(function(r){
    if (byCol === -1 || r[byCol] !== 'request' || !r[dateCol]) return;
    result.push({
      date: r[dateCol].toString(),
      cpr: normalizeCpr_(r[cprCol]),
      name: r[nameCol],
      level: levelCol > -1 && r[levelCol] !== '' && r[levelCol] !== undefined ? r[levelCol] : null,
      reason: reasonCol > -1 ? r[reasonCol] : ''
    });
  });
  return result;
}


///////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function getAnswersData(cpr){
  //cpr = '001001590';
  var ss = SpreadsheetApp.openById(answersData);
  var sh = ensureAnswersTrackingColumns_();
  var headers = sh.getRange("1:1").getValues()[0];

  // عمود التاريخ بشيت answers اسمه الفعلي "time" لا "Timestamp" — الاسم الخطأ كان يجعل timeCol
  // دائمًا -1، فيرجع date فارغًا لكل نتيجة اختبار بلا استثناء (نفس الاكتشاف الذي أدى لإصلاح
  // مواز بـwriteExamResult_، examSessions.js — راجع مناقشات.md).
  var timeCol = headers.indexOf('time');
  var cprCol = headers.indexOf('cpr');
  var examCol = headers.indexOf('exam');
  var matnCol = headers.indexOf('matn');
  var levelCol = headers.indexOf('level');
  var resultCol = headers.indexOf('result');
  var rateCol = headers.indexOf('rate');
  var certificateCol = headers.indexOf('certificate');
  var examIdCol = headers.indexOf('exam_id');
  var attemptIdCol = headers.indexOf('attempt_id');
  var sessionIdCol = headers.indexOf('session_id');
  var mazhabCol = headers.indexOf('mazhab');

  Logger.log(cpr)

  var allRows = sh.getLastRow() > 1 ? sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues() : [];
  var data = cpr == null ? allRows : allRows.filter(e=> normalizeCpr_(e[cprCol]) === normalizeCpr_(cpr));

  // إعادة المحاولة بعد الرسوب باتت بتحكم إداري صريح لكل اختبار (retakeOpen بشيت rules)، لا مهلة
  // زمنية ثابتة — تُستخدَم بالواجهة لإخفاء زر "ابدأ" ما دامت الإعادة مغلقة، بدل ترك الطالب يخوض
  // الاختبار كاملًا ثم يُرفَض تسليمه في اللحظة الأخيرة (submitAnswerData يفرض نفس القيد خادميًا).
  var retakeMap = getExamRetakeMap_();

  if(data.length > 0){
    var rData = data.map(function(e){
      var ts = timeCol >= 0 ? e[timeCol] : null;
      var retakeBlocked = false;
      if (e[rateCol] === 'راسب') {
        var examKey = e[examCol] + '|' + (levelCol >= 0 ? e[levelCol] : '');
        retakeBlocked = retakeMap[examKey] !== true;
      }
      return {
        date: ts ? ts.toString() : '',
        cpr: normalizeCpr_(e[cprCol]),
        examId: examIdCol >= 0 ? e[examIdCol] : '',
        attemptId: attemptIdCol >= 0 ? e[attemptIdCol] : '',
        sessionId: sessionIdCol >= 0 ? e[sessionIdCol] : '',
        exam: e[examCol],
        matn: e[matnCol],
        mazhab: mazhabCol >= 0 ? e[mazhabCol] : '',
        level: levelCol >= 0 ? e[levelCol] : '',
        result: e[resultCol],
        rate: e[rateCol],
        certificate: e[certificateCol],
        failedRecently: retakeBlocked,
      }
    })
  }else{
    var rData = 0;
  }
  Logger.log(rData);
  return rData;

}
//////////////////////////////////////////////////////////////////////////////////////////////
// عدد الاختبارات الناجحة (rate != 'راسب') في كل مرحلة من المراحل الأربع — تُستخدم في
// بطاقات "نتائج الاختبارات حسب المرحلة" بلوحة الإدارة (كل محاولة ناجحة تُحسب، وليس عدد
// الطلاب المميَّزين).
//////////////////////////////////////////////////////////////////////////////////////////////
function getExamPassCountsByLevel() {
  var answers = getAnswersData(null);
  var counts = { 0: 0, 1: 0, 2: 0, 3: 0 };

  (Array.isArray(answers) ? answers : []).forEach(function (e) {
    var level = +e.level;
    if (!counts.hasOwnProperty(level)) return;
    if (e.rate === 'راسب') return;
    counts[level]++;
  });

  return counts;
}

//////////////////////////////////////////////////////////////////////////////////////////////
// تفاصيل نتائج اختبارات مرحلة معيّنة: قائمة أسماء الاختبارات في هذه المرحلة، وقائمة الطلاب
// (بالاسم) مع تقدير (rate) ودرجة (result) كل طالب في كل اختبار من اختبارات هذه المرحلة —
// تُستخدم في مودال التفاصيل عند الضغط على بطاقة المرحلة، بنفس فكرة مودال "تفاصيل التسميع".
//////////////////////////////////////////////////////////////////////////////////////////////
function getExamResultsByLevel(level) {
  var answers = getAnswersData(null);
  var students = getPersons();
  var nameByCpr = {};
  (Array.isArray(students) ? students : []).forEach(function (s) { nameByCpr[s.cpr] = s.name; });

  var exams = [];
  var byCpr = {};

  (Array.isArray(answers) ? answers : []).forEach(function (e) {
    if (+e.level !== +level) return;
    if (exams.indexOf(e.exam) === -1) exams.push(e.exam);
    if (!byCpr[e.cpr]) byCpr[e.cpr] = { cpr: e.cpr, name: nameByCpr[e.cpr] || e.cpr, scores: {} };
    byCpr[e.cpr].scores[e.exam] = { rate: e.rate, result: e.result };
  });

  var rows = Object.keys(byCpr).map(function (k) { return byCpr[k]; })
    .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'ar'); });

  return { exams: exams, students: rows };
}
///////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function getAllStWrks(cpr){
  //cpr = '001001590';
  var ss = SpreadsheetApp.openById(answersData);
  var sh = ss.getSheetByName('stWorks');
  var headers = sh.getRange("1:1").getValues()[0];

  var cprCol = headers.indexOf('cpr');
  var nameCol = headers.indexOf('name');
  var genderCol = headers.indexOf('gender');
  var stWorksCol = headers.indexOf('stWorks');
  var urlCol = headers.indexOf('url');
  var notesCol = headers.indexOf('notes');
  var certificateCol = headers.indexOf('certificate');

  Logger.log(cpr)

  var data = cpr == null ? 
  sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues() : 
  sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues().filter(e=> +e[cprCol] == +cpr);

  if(data.length > 0){
    var rData = data.map(function(e){
      return {
        cpr: normalizeCpr_(e[cprCol]),
        name: e[nameCol],
        gender: e[genderCol],
        stWorks: e[stWorksCol],
        url: e[urlCol],
        notes: e[notesCol],
        certificate: e[certificateCol],
      }
    })
  }else{
    var rData = 0;
  }
  Logger.log(rData[0]);
  return JSON.stringify(rData);
    
}
//////////////////////////////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////////////
// مفتاح جلسة الاختبار (CacheService) — لطالب+اختبار+مرحلة واحد فقط في كل لحظة، تُبنى من جديد
// بالكامل مع كل استدعاء getQuestions (بلا أي "تذكّر" لجلسة سابقة، راجع التعليق أعلى getQuestions
// لسبب هذا القرار). الغرض الوحيد المتبقي لهذه الجلسة المؤقتة: يحتاجها submitAnswerData لحظيًا
// بعدها بدقائق للتصحيح الخادمي (الإجابة الصحيحة لا تُرسَل للعميل إطلاقًا) ولإنفاذ الموعد
// النهائي الفعلي، لا أكثر.
function examSessionKey_(cpr, branch, level) {
  return 'examSes_' + normalizeCpr_(cpr) + '_' + branch + '_' + level;
}

// هل يسمح هذا الاختبار (بالاسم المطبَّع+المرحلة) بتكرار الدخول؟ افتراضيًا false (ممنوع) ما لم
// يُفعِّله الإداري صراحةً (allowReentry بشيت rules، مفتاح "السماح بتكرار دخول الاختبار" بمودال
// إنشاء/تعديل اختبار — admin-js.html).
function examAllowsReentry(examName, level) {
  var headers = ensureExamManagementColumns_();
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
  var examCol = headers.indexOf('exam'), levelCol = headers.indexOf('level'), allowCol = headers.indexOf('allowReentry');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var match = rows.find(function (r) { return r[examCol] === examName && r[levelCol] === level; });
  return !!(match && match[allowCol] === true);
}

// هل يظهر للطالب مراجعة إجاباته سؤالًا سؤالًا (مع الإجابة الصحيحة) بعد التسليم، أم درجته
// فقط؟ **افتراضيًا true (يظهر)** خلافًا لبقية مفاتيح هذا القسم — أي اختبار موجود مسبقًا (خانة
// showAnswerReview فارغة لديه، أُنشئ قبل هذه الميزة) يجب أن يستمر بنفس سلوكه الحالي دون تغيير
// صامت، فالفراغ يُفسَّر "إظهار" لا "إخفاء" (عكس allowReentry/retakeOpen المتحفِّظتين افتراضيًا).
// يُستدعى من submitAnswerData فقط، لا من الواجهة — الإجابة الصحيحة أصلًا لا تصل للعميل إطلاقًا
// إن كانت هذه false (تُحذَف من body الاستجابة خادميًا، لا يُكتفى بإخفاء الزر بالواجهة).
function examShowsAnswerReview_(examName, level) {
  var headers = ensureExamManagementColumns_();
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
  var examCol = headers.indexOf('exam'), levelCol = headers.indexOf('level'), reviewCol = headers.indexOf('showAnswerReview');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return true;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var match = rows.find(function (r) { return r[examCol] === examName && r[levelCol] === level; });
  return !(match && match[reviewCol] === false);
}

// شيت "دخول اختبار" (examEntries بـanswersData) — سجل خفيف لكل مرة يفتح فيها طالب صفحة أسئلة
// اختبار (طابع دخول فقط، لا وقت ولا إجابات) — الغرض الوحيد منه إنفاذ منع إعادة الدخول عندما
// allowReentry=false (getQuestions). لا علاقة له بجلسة CacheService المؤقتة أعلاه.
function ensureExamEntriesSheet_() {
  var ss = SpreadsheetApp.openById(answersData);
  var sh = ss.getSheetByName('examEntries');
  if (!sh) {
    sh = ss.insertSheet('examEntries');
    sh.appendRow(['cpr', 'exam', 'level', 'enteredAt']);
  }
  return sh;
}

function hasStudentEnteredExam(cpr, examName, level) {
  var sh = ensureExamEntriesSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr'), examCol = headers.indexOf('exam'), levelCol = headers.indexOf('level');
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return rows.some(function (r) {
    return normalizeCpr_(r[cprCol]) === normalizeCpr_(cpr) && r[examCol] === examName && r[levelCol] === level;
  });
}

function recordExamEntry(cpr, examName, level) {
  ensureExamEntriesSheet_().appendRow([normalizeCpr_(cpr), examName, level, new Date()]);
}

// يبدأ جلسة جديدة أو يعيد نفس الجلسة الدائمة النشطة. لا يثق باسم الاختبار/المذهب/المرحلة/
// المدة القادمة من المتصفح؛ واجهة الطالب ترسل cpr + exam_id فقط، وبقية القواعد تُشتق خادميًا.
function getQuestions(cpr, examId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { blocked: true, reason: 'busy' };
  try {
    return startOrResumeExam_(cpr, examId);
  } finally {
    lock.releaseLock();
  }
}
///////////////////////////////////////////////////////////////////////////////////

// يبحث عن اسم "المادة" المرتبطة باسم اختبار عادي (غير "الفقه" — لا يوجد له مقرر مطابق أصلًا،
// راجع مناقشات.md) ليُعرَض للطالب كـ"اسم الاختبار - المادة" بدل الاسم وحده. نفس منطق
// findCurriculumMatchForExam_ (admin-js.html) بالضبط لكن هنا خادميًا: مقرر بنفس اسم الاختبار
// حرفيًا، يُفضَّل مقررًا يخص هو نفسه (لا مادته فقط) نفس مرحلة الاختبار — قيد ثانٍ فوق قيد المادة،
// راجع مناقشات.md — ويسقط لأول مطابقة بالاسم بصرف النظر عن مرحلته لو لم توجد. يُعيد null بلا
// خطأ لو لا يوجد أي مقرر بنفس الاسم إطلاقًا.
function findSubjectNameForExam_(examName, examLevel, curriculaList, subjectById) {
  var matches = curriculaList.filter(function (c) { return c.name === examName; });
  if (!matches.length) return null;
  var stageName = STAGE_NAMES_[examLevel] || null;
  for (var i = 0; i < matches.length; i++) {
    var curriculumLevels = String(matches[i].level || '').split(',').map(function (x) { return x.trim(); });
    if (stageName && curriculumLevels.indexOf(stageName) !== -1) {
      var subject = subjectById[matches[i].subjectId];
      if (subject) return subject.name;
    }
  }
  var fallbackSubject = subjectById[matches[0].subjectId];
  return fallbackSubject ? fallbackSubject.name : null;
}

// جذور أسماء المذاهب الثلاثة — تُستخدَم لمطابقة اسم "مادة" (مثل "الفقه الحنبلي") باسم مذهب
// الطالب المختار (مثل "المذهب الحنبلي") رغم اختلاف الصياغة بينهما (فقه/مذهب)، عبر البحث عن
// جذر مشترك (حنبلي/مالكي/شافعي) داخل كلا النصّين بدل مطابقة حرفية كاملة.
var FIQH_SUBJECT_ROOTS_ = ['حنبلي', 'مالكي', 'شافعي'];
function fiqhRootIn_(text) {
  var t = String(text || '');
  for (var i = 0; i < FIQH_SUBJECT_ROOTS_.length; i++) {
    if (t.indexOf(FIQH_SUBJECT_ROOTS_[i]) !== -1) return FIQH_SUBJECT_ROOTS_[i];
  }
  return null;
}

///////////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////////
function getExams(exam, level, cpr){

  //exam = 'لامية ابن الوردي';
  //level = 1;

  var ss = SpreadsheetApp.openById(refID);
  var sheet = ss.getSheetByName('rules');
  var headers = ensureExamManagementColumns_();

  var levelCol = headers.indexOf('level');
  var examCol = headers.indexOf('exam');
  var examStartCol = headers.indexOf('start');
  var examEndCol = headers.indexOf('end');
  var checkCol = headers.indexOf('check');
  var durationCol = headers.indexOf('duration');
  var archivedCol = headers.indexOf('archived');
  var examIdCol = headers.indexOf('exam_id');

  Logger.log([exam , level]);

  if(sheet.getLastRow() < 2) return;

  // كان getRange بيقرأ صفًا زيادة عن اللازم (ارتفاع النطاق = getLastRow() بدل getLastRow()-1)،
  // فيرجع صف فارغ وهمي بلا اسم اختبار في آخر النتائج دائمًا — سبب ظهور بطاقة اختبار فارغة
  // بالواجهة (بلا اسم، "غير متاح") لاحظها المستخدم فعليًا.
  var data;
  data = sheet.getRange(2,1,sheet.getLastRow()-1,sheet.getLastColumn()).getValues();
  data = data.filter(e=> e[examCol] !== ''); // استبعاد أي صف بلا اسم اختبار (فارغ/غير مكتمل)
  // استبعاد الاختبارات المؤرشفة (تُحذَف من منظور الطالب فعليًا، وإن ظلّت محفوظة بالشيت
  // لتظهر للإدارة فقط تحت تبويب "مؤرشفة" — كانت تظهر هنا رغم الحذف قبل هذا الإصلاح).
  archivedCol !== -1 ? data = data.filter(e=> e[archivedCol] !== true) : null;
  level !== null && level !== undefined && level !== '' ? data = data.filter(e=> e[levelCol] === level) : null;
  exam ? data = data.filter(e=> e[examCol] === exam) : null;

  if(data.length < 1) return;

    var sessionStates = cpr ? studentExamSessionStateMap_(cpr) : {};
    var student = cpr ? studentExamContext_(cpr) : null;
    var subjectsList = getSubjectsList();
    var curriculaList = getCurriculaList();
    var subjectById_ = {};
    subjectsList.forEach(function (s) { subjectById_[s.id] = s; });
    var rData = data.map(function(e){
      var examId = String(e[examIdCol] || '');
      var branch = e[examCol] === 'الفقه' ? (student && student.mazhab ? student.mazhab : '') : e[examCol];
      var ready = !!branch && approvedExamForms_(examId, branch, e[levelCol]).length > 0;
      var active = sessionStates[examId + '|' + e[levelCol]] || null;
      var subjectName = findSubjectNameForExam_(e[examCol], e[levelCol], curriculaList, subjectById_);

      // اختبارات فقه منفصلة تحت المواد الثلاث (الفقه الحنبلي/المالكي/الشافعي — بخلاف اختبار
      // "الفقه" الموحّد أعلاه): تُستبعَد كليًا من قائمة الطالب لو مادتها تخص مذهبًا
      // غير مذهبه المختار (بطلب المستخدم 2026-09-13). يُطبَّق فقط لو cpr ممرَّرة فعليًا (طلب طالب
      // حقيقي)، لا باستدعاءات الإدارة العامة (getExams(null,null) بلا cpr).
      var subjectFiqhRoot = fiqhRootIn_(subjectName);
      if (cpr && subjectFiqhRoot && fiqhRootIn_(student && student.mazhab) !== subjectFiqhRoot) return null;

      return {
        id: examId,
        level: e[levelCol],
        exam: e[examCol],
        subject: subjectName,
        check: !!active || (e[checkCol] === true && (!cpr || ready)),
        duration: e[durationCol],
        ready: ready,
        readinessReason: cpr && !ready ? (e[examCol] === 'الفقه' && !branch ? 'missing-madhab' : 'no-approved-model') : '',
        sessionActive: !!active,
        sessionEndTime: active ? active.endTime : null
      }
    }).filter(Boolean)
  Logger.log(rData);

  return rData;

}

//////////////////////////////////////////////////////////////////////////////////////////////
// قائمة الاختبارات الحقيقية لصفحة "إدارة الاختبارات" بلوحة الإدارة (قراءة فقط حاليًا — الإنشاء/
// التعديل/النسخ/الأرشفة/الصلاحيات لسه معلّقة لدفعة لاحقة منفصلة). المواصفات الكاملة المتفق
// عليها في مناقشات.md § "قسم إدارة الاختبارات".
//
// تنبيه مهم: عمود/معادلة check في شيت rules غرضه التحكم بظهور زر بدء الاختبار للطالب
// (funcs-js.html) فقط، منفصل تمامًا عن أي تاريخ — ممنوع قراءته هنا لحساب الحالة أو الكتابة
// عليه إطلاقًا. الحالة تُحسب فقط من أعمدة start/startTime/end/endTime الأصلية الموجودة
// بالفعل بالشيت (start = تاريخ البداية، end = تاريخ النهاية)، بتوقيت Asia/Bahrain.
//////////////////////////////////////////////////////////////////////////////////////////////

// يضمن وجود أعمدة تعريف/تتبّع إدارة الاختبارات في شيت rules (تُضاف بالنهاية فقط، بلا لمس
// لأي عمود موجود ولا لترتيبها)، وينظّف startDate/endDate اللي اتضافوا بالغلط في نسخة سابقة
// (التواريخ فعليًا في start/end الأصليين)، ويُنشئ exam_id ثابتًا لأي صف قديم ينقصه — بنفس
// نمط ensureClass3Column أعلاه. تُستدعى تلقائيًا أول كل قراءة، فلا حاجة لتشغيلها يدويًا.
function ensureExamManagementColumns_() {
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');

  ['startDate', 'endDate'].forEach(function (col) {
    var h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idx = h.indexOf(col);
    if (idx !== -1) sh.deleteColumn(idx + 1);
  });

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var newCols = ['exam_id', 'updated_by', 'updated_at', 'archived', 'retakeOpen', 'allowReentry', 'showAnswerReview'];
  newCols.forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });

  var examCol = headers.indexOf('exam');
  var examIdCol = headers.indexOf('exam_id');
  var lastRow = sh.getLastRow();
  if (lastRow > 1) {
    var range = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
    var values = range.getValues();
    var changed = false;
    values.forEach(function (row) {
      if (row[examCol] !== '' && !row[examIdCol]) { row[examIdCol] = Utilities.getUuid(); changed = true; }
    });
    if (changed) range.setValues(values);
  }

  return headers;
}

// خريطة "الإعادة مفتوحة؟" لكل (اختبار+مرحلة) من شيت rules — تحل محل مهلة الـ24 ساعة القديمة
// الثابتة بتحكم إداري صريح لكل اختبار (retakeOpen)، مغلقة افتراضيًا ما لم يفتحها الإداري.
// المفتاح exam+'|'+level يطابق حرفيًا القيم المخزَّنة بشيت answers (بعد تطبيع "المذهب..."
// إلى "الفقه" — انظر التعليق أعلى submitAnswerData بـdataPost.js). يُستخدَم من هنا
// (getAnswersData/getQuestions) ومن dataPost.js (submitAnswerData/setExamRetakeOpen).
function getExamRetakeMap_() {
  var headers = ensureExamManagementColumns_();
  var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
  var examCol = headers.indexOf('exam'), levelCol = headers.indexOf('level'), retakeCol = headers.indexOf('retakeOpen');
  var lastRow = sh.getLastRow();
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
  var map = {};
  rows.forEach(function (r) {
    if (r[examCol] === '') return;
    map[r[examCol] + '|' + r[levelCol]] = r[retakeCol] === true;
  });
  return map;
}

// هل سبق لهذا الطالب الرسوب في هذا الاختبار (بالاسم المطبَّع، بعد "المذهب"→"الفقه")؟
function studentFailedExam(cpr, examName, level) {
  var sh = SpreadsheetApp.openById(answersData).getSheetByName('answers');
  var headers = sh.getRange('1:1').getValues()[0];
  var cprCol = headers.indexOf('cpr'), examCol = headers.indexOf('exam'), levelCol = headers.indexOf('level'), rateCol = headers.indexOf('rate');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return rows.some(function (r) {
    return normalizeCpr_(r[cprCol]) === normalizeCpr_(cpr) && r[examCol] === examName && r[levelCol] === level && r[rateCol] === 'راسب';
  });
}

// المنطقة الزمنية الفعلية لشيت "rules" — لا تُفترَض "Asia/Bahrain" بعد الآن. اكتُشف (تشخيص حي
// 2026-09-14) أن الشيت الفعلي مضبوط على "Asia/Muscat" (+4)، بفارق ساعة كاملة عن "Asia/Bahrain"
// (+3) المفترضة يدويًا بكل هذه الدوال — وهذا الفارق كان يُزيح أي تاريخ/وقت قريب من منتصف الليل
// ليوم تقويمي كامل عند قراءة/مقارنة تواريخ الاختبارات، فيظهر اختبار "غير متاح" رغم صحة تواريخه
// المُدخَلة فعليًا بالشيت. استخدام منطقة الشيت الحقيقية ديناميكيًا يجعل الكود صحيحًا بصرف النظر
// عن أي منطقة زمنية مضبوطة فعليًا، لا "Asia/Bahrain" تحديدًا. راجع مناقشات.md.
function examSheetTimeZone_() {
  return SpreadsheetApp.openById(refID).getSpreadsheetTimeZone();
}

// إزاحة UTC الفعلية الآن (نصًا مثل "+04:00") لمنطقة زمنية معيّنة — بديل كتابة إزاحة ثابتة يدويًا
// بالكود (كانت "+03:00" مكتوبة صراحة بـexamRuleBoundaryMs_ رغم أن منطقة الشيت الفعلية +04:00).
function utcOffsetString_(timeZone) {
  var raw = Utilities.formatDate(new Date(), timeZone, 'Z'); // مثل "+0400"
  return raw.slice(0, 3) + ':' + raw.slice(3);
}

function normalizeExamDateCell_(val) {
  if (!val) return '';
  if (val instanceof Date) return Utilities.formatDate(val, examSheetTimeZone_(), 'yyyy-MM-dd');
  return String(val);
}
function normalizeExamTimeCell_(val) {
  if (!val) return '';
  if (val instanceof Date) return Utilities.formatDate(val, examSheetTimeZone_(), 'HH:mm');
  return String(val);
}
// draft: بلا تاريخ بداية/نهاية صالح. scheduled: لسه ماوصلش وقت البداية. closed: عدّى وقت
// النهاية. open: خلاف ذلك. المقارنة كلها بمنطقة شيت rules الزمنية الفعلية (examSheetTimeZone_)
// بغضّ النظر عن توقيت جهاز القارئ.
function computeExamStatusFromDates_(startDate, startTime, endDate, endTime) {
  if (!startDate || !endDate) return 'draft';
  var offset = utcOffsetString_(examSheetTimeZone_());
  var start = new Date(startDate + 'T' + (startTime || '00:00') + ':00' + offset);
  var end = new Date(endDate + 'T' + (endTime || '23:59') + ':00' + offset);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 'draft';
  var now = Date.now();
  if (now < start.getTime()) return 'scheduled';
  if (now > end.getTime()) return 'closed';
  return 'open';
}

function getExamManagementData() {
  ensureExamAutomationTriggers_();
  var ss = SpreadsheetApp.openById(refID);
  var rulesSh = ss.getSheetByName('rules');
  var headers = ensureExamManagementColumns_();

  var levelCol = headers.indexOf('level');
  var examCol = headers.indexOf('exam');
  var durationCol = headers.indexOf('duration');
  var startDateCol = headers.indexOf('start');
  var startTimeCol = headers.indexOf('startTime');
  var endDateCol = headers.indexOf('end');
  var endTimeCol = headers.indexOf('endTime');
  var examIdCol = headers.indexOf('exam_id');
  var updatedByCol = headers.indexOf('updated_by');
  var archivedCol = headers.indexOf('archived');
  var retakeOpenCol = headers.indexOf('retakeOpen');
  var showAnswerReviewCol = headers.indexOf('showAnswerReview');

  var lastRow = rulesSh.getLastRow();
  var rulesData = lastRow > 1 ? rulesSh.getRange(2, 1, lastRow - 1, rulesSh.getLastColumn()).getValues() : [];

  var qSh = ss.getSheetByName('questions');
  var qHeaders = qSh.getRange('1:1').getValues()[0];
  var qBranchCol = qHeaders.indexOf('الكتاب / المتن');
  var qLevelCol = qHeaders.indexOf('المرحلة');
  var qFormCol = qHeaders.indexOf('نموذج');
  var qQuestionCol = qHeaders.indexOf('السؤال');
  var qAnswer1Col = qHeaders.indexOf('answer-1');
  var qAnswer2Col = qHeaders.indexOf('answer-2');
  var qTrueAnswerCol = qHeaders.indexOf('الجواب الصحيح');

  var qLastRow = qSh.getLastRow();
  var qData = qLastRow > 1 ? qSh.getRange(2, 1, qLastRow - 1, qSh.getLastColumn()).getValues() : [];

  // اختبار "الفقه" حالة خاصة: مالوش أسئلة مخزّنة باسمه الحرفي في شيت questions، لأنه بيتفرّع
  // فعليًا لثلاثة مذاهب (FIQH_MAZHAB_NAMES_ — code.js) — كل طالب ياخد وقت بدء الاختبار أسئلة
  // مذهبه المختار (studentData[0].mazhab) بدل "الفقه" مباشرة (funcs-js.html، عند إعداد branch
  // لاستدعاء getQuestions)، والنتيجة بترجع تُسجَّل تحت اسم "الفقه" الموحّد عند الحفظ
  // (dataPost.js: submitAnswerData). فنجمع هنا أسئلة المذاهب الثلاثة مع بعض لتمثيل جاهزية
  // اختبار "الفقه" ككل.

  return rulesData
    .filter(function (r) { return r[examCol] !== ''; })
    .map(function (r) {
      var exam = r[examCol];
      var level = r[levelCol];
      var examNames = exam === 'الفقه' ? activeMadhabNames_() : [exam];

      // السؤال "جاهز" = نص + اختياران على الأقل + تحديد الجواب الصحيح (مناقشات.md)
      var qRows = qData.filter(function (q) { return examNames.indexOf(q[qBranchCol]) !== -1 && q[qLevelCol] === level && q[qQuestionCol] !== ''; });
      var forms = {};
      var completeCount = 0;
      qRows.forEach(function (q) {
        forms[q[qBranchCol] + '|' + q[qFormCol]] = true;
        if (q[qQuestionCol] !== '' && q[qAnswer1Col] !== '' && q[qAnswer2Col] !== '' && q[qTrueAnswerCol] !== '') completeCount++;
      });
      var questionCount = qRows.length;
      var readinessInfo = examReadinessForRule_({ id: String(r[examIdCol] || ''), exam: exam, level: level });
      var readyBranchCount = readinessInfo.branches.filter(function (b) { return b.ready; }).length;
      var approvedModelCount = readinessInfo.branches.reduce(function (sum, b) { return sum + b.approvedModels; }, 0);

      var startDate = normalizeExamDateCell_(r[startDateCol]);
      var startTime = normalizeExamTimeCell_(r[startTimeCol]);
      var endDate = normalizeExamDateCell_(r[endDateCol]);
      var endTime = normalizeExamTimeCell_(r[endTimeCol]);

      return {
        id: r[examIdCol] || (exam + '_' + level),
        name: exam,
        level: level,
        startDate: startDate,
        startTime: startTime,
        endDate: endDate,
        endTime: endTime,
        duration: r[durationCol],
        modelCount: Object.keys(forms).length,
        approvedModelCount: approvedModelCount,
        questionCount: questionCount,
        readiness: readinessInfo.branches.length ? Math.round((readyBranchCount / readinessInfo.branches.length) * 100) : 0,
        readinessDetails: readinessInfo.branches,
        hasApprovedModel: readinessInfo.ready,
        // المؤرشف يطغى على الحالة المحسوبة من التواريخ — تظهر هذه الاختبارات للإدارة فقط
        // تحت تبويب "مؤرشفة" (renderExamsTable بadmin-js.html)، ولا تُحتسَب ضمن مقاييس
        // متاح الآن/مجدول/مسودة (updateExamsMetrics تعتمد على نفس هذا الحقل).
        status: r[archivedCol] === true ? 'archived' : computeExamStatusFromDates_(startDate, startTime, endDate, endTime),
        archived: r[archivedCol] === true,
        updatedBy: r[updatedByCol] || '',
        retakeOpen: r[retakeOpenCol] === true,
        // showAnswerReview الفارغة تعني true (إظهار) لا false — راجع تعليق examShowsAnswerReview_
        showAnswerReview: r[showAnswerReviewCol] !== false
      };
    });
}

// إحصائية استبانتَي "قبل الاختبار"/"بعده" (شيت surveys بـanswersData، submitExamSurvey
// بdataPost.js) الخاصتين باختبار ومرحلة معيّنين — لزر "الاستبانات" الجديد بصفحة إدارة
// الاختبارات (admin-js.html). "الفقه" حالة خاصة كبقية دوال إدارة الاختبارات: تُجمَع استبانات
// مذاهبه الثلاثة معًا (نفس منطق FIQH_MAZHAB_NAMES_ أعلى getExamManagementData) لأن الطالب
// يسجّل استبيانه باسم مذهبه الفعلي وقت أداء الاختبار، لا "الفقه" مباشرة.
// pre: مجموعتان (المادة المقررة/المحاضر) + سؤال مستقل (تقييم عام لإدارة الأكاديمية).
// post: أربعة أسئلة مستقلة عن الاختبار نفسه. البنية والمفاتيح من SURVEY_PRE_GROUPS_/
// SURVEY_PRE_STANDALONE_/SURVEY_POST_STANDALONE_ (code.js) — مصدر واحد يشترك فيه submitExamSurvey.
function getExamSurveyStats(examName, level) {
  var empty = { pre: { count: 0, groups: [], standalone: [], comments: [] }, post: { count: 0, standalone: [], comments: [] } };
  var sh = SpreadsheetApp.openById(answersData).getSheetByName('surveys');
  if (!sh || sh.getLastRow() < 2) return empty;

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var examCol = headers.indexOf('exam'), levelCol = headers.indexOf('level'), typeCol = headers.indexOf('type'), commentCol = headers.indexOf('comment');

  var examNames = examName === 'الفقه' ? FIQH_MAZHAB_NAMES_ : [examName];
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .filter(function (r) { return examNames.indexOf(r[examCol]) !== -1 && +r[levelCol] === +level; });

  function buildFieldStat(def, typeRows) {
    var dist = [0, 0, 0, 0, 0];
    var dataCol = headers.indexOf('rating_' + def.key);
    if (dataCol !== -1) {
      typeRows.forEach(function (r) {
        var v = +r[dataCol];
        if (v >= 1 && v <= 5) dist[v - 1]++;
      });
    }
    var sum = 0, n = 0;
    dist.forEach(function (c, idx) { sum += c * (idx + 1); n += c; });
    return { key: def.key, label: def.label, options: def.options || ['1', '2', '3', '4', '5'], count: n, dist: dist, avg: n ? (sum / n) : 0 };
  }

  function commentsFrom(typeRows) {
    return typeRows.map(function (r) { return String(r[commentCol] || '').trim(); }).filter(function (c) { return c; }).slice(-10).reverse();
  }

  var preRows = rows.filter(function (r) { return r[typeCol] === 'pre'; });
  var postRows = rows.filter(function (r) { return r[typeCol] === 'post'; });

  var preGroups = SURVEY_PRE_GROUPS_.map(function (g) {
    return { title: g.title, fields: g.fields.map(function (f) { return buildFieldStat(f, preRows); }) };
  });
  var preStandalone = SURVEY_PRE_STANDALONE_.map(function (f) { return buildFieldStat(f, preRows); });
  var postStandalone = SURVEY_POST_STANDALONE_.map(function (f) { return buildFieldStat(f, postRows); });

  return {
    pre: { count: preRows.length, groups: preGroups, standalone: preStandalone, comments: commentsFrom(preRows) },
    post: { count: postRows.length, standalone: postStandalone, comments: commentsFrom(postRows) }
  };
}

// يضمن وجود أعمدة تعريف/تتبّع الأسئلة في شيت questions (تُضاف بالنهاية فقط)، بنفس نمط
// ensureExamManagementColumns_ أعلاه. تُستدعى تلقائيًا أول كل قراءة/كتابة لأسئلة الاختبارات.
function ensureQuestionManagementColumns_() {
  var sh = SpreadsheetApp.openById(refID).getSheetByName('questions');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var requiredCore = ['#', 'الكتاب / المتن', 'نموذج', 'المرحلة', 'السؤال', 'answer-1', 'answer-2', 'answer-3', 'answer-4', 'answer-5', 'الجواب الصحيح'];
  var missingCore = requiredCore.filter(function (col) { return headers.indexOf(col) === -1; });
  if (missingCore.length) throw new Error('بنية شيت questions غير مكتملة. الأعمدة المفقودة: ' + missingCore.join('، '));
  var newCols = ['question_id', 'exam_id', 'status', 'updated_by', 'updated_at'];
  newCols.forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });
  return headers;
}

//////////////////////////////////////////////////////////////////////////////////////////////
// بيانات محرر النماذج/الأسئلة لاختبار معيّن — مجمّعة حسب عمود "نموذج" (بلا ورقة مستقلة
// للنماذج، حسب مناقشات.md). الشكل المُعاد مطابق تمامًا لبنية examsData_[].models المستخدمة
// أصلًا بواجهة المحرر التجريبية بـ admin-js.html، حتى يعمل عليها نفس كود العرض/التفاعل
// المحلي (كتابة النص، إضافة/حذف اختيار، تحديد الإجابة الصحيحة...) بلا أي تعديل، ولا يتغيّر
// إلا عند نقاط الحفظ الفعلية (saveQuestion/deleteQuestion).
//
// اختبار "الفقه" حالة خاصة (انظر التعليق أعلى getExamManagementData) — بيانات الأسئلة الفعلية
// مخزَّنة تحت اسم أحد المذاهب الثلاثة (FIQH_MAZHAB_NAMES_) لا "الفقه" نفسه. لو استُدعيت هذه
// الدالة لاختبار "الفقه" بلا `mazhab` صالح، تُعاد إشارة `needsMazhab` بدل بيانات مضلِّلة —
// العميل (examImportExcelModal/openExamEditor بـadmin-js.html) يعرض حينها مُخيِّر مذهب أولًا،
// ثم يعيد نفس النداء مع المذهب المختار كـ`branchName` الفعلي المستخدَم بكل القراءة/الكتابة.
//////////////////////////////////////////////////////////////////////////////////////////////
function getExamEditorData(examId, userCpr, mazhab) {
  var perm = hasExamPermission(userCpr);
  if (!perm.allowed) return { error: true, message: 'لا تملك صلاحية الوصول لهذا القسم' };

  var ss = SpreadsheetApp.openById(refID);
  var rulesSh = ss.getSheetByName('rules');
  var rHeaders = ensureExamManagementColumns_();
  var rExamCol = rHeaders.indexOf('exam'), rLevelCol = rHeaders.indexOf('level'), rIdCol = rHeaders.indexOf('exam_id'),
    rStartCol = rHeaders.indexOf('start'), rStartTimeCol = rHeaders.indexOf('startTime'),
    rEndCol = rHeaders.indexOf('end'), rEndTimeCol = rHeaders.indexOf('endTime'), rDurationCol = rHeaders.indexOf('duration');
  var rLastRow = rulesSh.getLastRow();
  var rRows = rLastRow > 1 ? rulesSh.getRange(2, 1, rLastRow - 1, rulesSh.getLastColumn()).getValues() : [];
  var examRow = rRows.find(function (r) { return String(r[rIdCol]) === String(examId); });
  if (!examRow) return { error: true, message: 'الاختبار غير موجود' };
  var examName = examRow[rExamCol];
  var level = examRow[rLevelCol];

  var isFiqh = examName === 'الفقه';
  var mazhabOptions = isFiqh ? activeMadhabNames_() : [];
  if (isFiqh && mazhabOptions.indexOf(mazhab) === -1) {
    return { needsMazhab: true, id: examId, name: examName, stage: level, mazhabOptions: mazhabOptions };
  }
  var branchName = isFiqh ? mazhab : examName;

  var qSh = ss.getSheetByName('questions');
  var qHeaders = ensureQuestionManagementColumns_();
  var qBranchCol = qHeaders.indexOf('الكتاب / المتن'), qLevelCol = qHeaders.indexOf('المرحلة'),
    qFormCol = qHeaders.indexOf('نموذج'), qQuestionCol = qHeaders.indexOf('السؤال'),
    qTrueAnswerCol = qHeaders.indexOf('الجواب الصحيح'),
    qIdCol = qHeaders.indexOf('question_id'), qExamIdCol = qHeaders.indexOf('exam_id');
  var qAnswerCols = [1, 2, 3, 4, 5].map(function (number) { return qHeaders.indexOf('answer-' + number); });

  var lastRow = qSh.getLastRow();
  var data = lastRow > 1 ? qSh.getRange(2, 1, lastRow - 1, qSh.getLastColumn()).getValues() : [];

  var modelsMap = {};
  var modelStatuses = examModelStatusMap_();
  data.forEach(function (row) {
    var sameIdentity = String(row[qExamIdCol] || '') === String(examId) || !row[qExamIdCol];
    if (!sameIdentity || row[qBranchCol] !== branchName || row[qLevelCol] !== level || row[qQuestionCol] === '') return;

    var formKey = String(row[qFormCol] || 1);
    if (!modelsMap[formKey]) modelsMap[formKey] = {
      id: formKey,
      name: 'نموذج ' + formKey,
      status: modelStatuses[examModelKey_(examId, branchName, level, formKey)] || 'draft',
      questions: []
    };

    var answerValues = [];
    for (var answerIndex = 0; answerIndex < 5; answerIndex++) answerValues.push(row[qAnswerCols[answerIndex]]);
    var correctNumber = resolveStoredCorrectAnswerNumber_(row[qTrueAnswerCol], answerValues);
    var options = [];
    for (var a = 0; a < 5; a++) {
      var val = row[qAnswerCols[a]];
      if (val !== '') options.push({ id: a + 1, text: val, correct: (correctNumber === a + 1) });
    }
    if (options.length === 0) options = [{ id: 1, text: '', correct: true }, { id: 2, text: '', correct: false }];

    modelsMap[formKey].questions.push({ id: row[qIdCol] || Utilities.getUuid(), text: row[qQuestionCol], options: options });
  });

  var models = Object.keys(modelsMap).sort(function (a, b) { return (+a) - (+b); }).map(function (k) { return modelsMap[k]; });

  return {
    id: examId,
    name: examName,
    mazhab: isFiqh ? mazhab : null,
    mazhabOptions: isFiqh ? mazhabOptions : null,
    stage: level,
    level: level,
    startDate: normalizeExamDateCell_(examRow[rStartCol]),
    startTime: normalizeExamTimeCell_(examRow[rStartTimeCol]),
    endDate: normalizeExamDateCell_(examRow[rEndCol]),
    endTime: normalizeExamTimeCell_(examRow[rEndTimeCol]),
    duration: examRow[rDurationCol],
    canEditSchedule: perm.isAdmin,
    models: models
  };
}

///////////////////////////////////////////////////////////////////////////////////  'yyyy-MM-dd\'T\'HH:mm:ss\'Z\''

function getBahrainTime() {
  var timeZone = "Asia/Bahrain";
  var now = new Date();
  var localTime = Utilities.formatDate(now, timeZone, "yyyy-MM-dd HH:mm:ss");
  
  Logger.log(localTime);
  return localTime;
}

//////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////
function getMatns() {

  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('matns');

  // subjectId (ربط المقرر بمادة من تبويب "المواد" الجديد) — راجع ensureMatnsSubjectColumn_/
  // saveMatnsItem بdataPost.js ومناقشات.md "دمج إدارة المقررات". إضافة فقط، بلا أثر على
  // أي عمود أو مستهلك قديم آخر لهذه الدالة (التسميع وغيره).
  ensureMatnsSubjectColumn_(sh);
  var headers = sh.getRange('1:1').getValues();

  var idCol = headers[0].indexOf('id');
  var lvlCol = headers[0].indexOf('المستوى');
  var werdCol = headers[0].indexOf('الورد');
  var matnCol = headers[0].indexOf('الكتاب / المتن');
  var startCol = headers[0].indexOf('من');
  var endCol = headers[0].indexOf('إلى');
  var awradCol = headers[0].indexOf('عدد الأوراد');
  var pagesCol = headers[0].indexOf('عدد الصفحات');
  var baytsCol = headers[0].indexOf('عدد الأبيات');
  var subjectCol = headers[0].indexOf('subjectId');

  var data = sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues();
  if(data.length > 0){
    var rData = data.map(function(e){
      return {
        id: e[idCol],
        level: e[lvlCol],
        matn: e[matnCol],
        werd: e[werdCol],
        start: e[startCol],
        end: e[endCol],
        awrad: e[awradCol],
        pages: pagesCol > -1 ? e[pagesCol] : '',
        bayts: baytsCol > -1 ? e[baytsCol] : '',
        subjectId: subjectCol > -1 ? e[subjectCol] : '',
      }
    })
  }else{
    var rData = 0;
  }
  Logger.log(data.length);
  return rData;

}
//////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////
// كانت تقرأ صفوف كل مرحلة (#/name/logo/bag) من شيت main مباشرة — نُقلت هذه البيانات لشيت
// stages الموحَّد (بطلب المستخدم صراحةً "يكون كله في مكان واحد"، راجع migrateStageLogoBagFromMainSheet_
// أعلاه للهجرة التلقائية لمرة واحدة). الدالة هنا تحافظ على نفس الشكل المُرجَع تمامًا
// (lvlNum/lvlName/lvlLogo/lvlBag) فلا حاجة لأي تعديل بالطرف المستهلك (filterLevel بـ
// funcs-js.html) رغم تغيير المصدر بالكامل خلف الكواليس.
function getMainData() {
  return getStagesList().map(function (s) {
    return { lvlNum: s.stageIndex, lvlName: s.name, lvlLogo: s.logo, lvlBag: s.bagLink };
  });
}

//////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////
function getMainStatus() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('main');

  // قراءة رؤوس الأعمدة
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // تحديد رقم عمود "registration"
  var registrationCol = headers.indexOf('registration') + 1;
  if (registrationCol === 0) {
    throw new Error('لم يتم العثور على عمود باسم registration');
  }

  // قراءة قيمة الصف الثاني في هذا العمود
  var registration = sh.getRange(2, registrationCol).getValue();

  var reqCol = ensureAttendanceRequestsColumn_(sh);
  var attendanceRequestsOpen = !!sh.getRange(2, reqCol).getValue();

  var certCol = ensureSelfIssueCertColumn_(sh);
  var selfIssueCertEnabled = !!sh.getRange(2, certCol).getValue();

  var mazhabChangeCol = ensureAllowMazhabChangeColumn_(sh);
  var allowMazhabChange = !!sh.getRange(2, mazhabChangeCol).getValue();

  // إنشاء كائن البيانات
  var data = {
    registration: registration,
    attendanceRequestsOpen: attendanceRequestsOpen,
    selfIssueCertEnabled: selfIssueCertEnabled,
    allowMazhabChange: allowMazhabChange
  };

  Logger.log(data);
  return data;
}

//////////////////////////////////////////////////////////////////////////////////////////////
// شيت "stages" — صف ثابت واحد لكل مرحلة من الأربع (0-3)، لا قائمة CRUD حرة (المراحل لا تُضاف
// ولا تُحذف). registrationOpen: مفتاح خاص بكل مرحلة، يُضاف لشرط المفتاح العام "تسجيل" بشيت main
// (كلاهما لازم مفتوحان معًا — راجع requestStageJoin بdataPost.js). courseStartDate/
// courseEndDate: يُستخدَمان لحساب نسبة حضور الطالب بمرحلته الحالية (راجع getStageAttendanceStats
// أدناه). راجع مناقشات.md "نظام إدارة المراحل" للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////
var STAGE_NAMES_ = ['التأهيلية', 'التأسيسية', 'التأصيلية', 'التحصيلية'];

function ensureStagesSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('stages');
  // hoursPerAttendance ("ساعات الحضور لليوم"): رقم ساعات كل جلسة حضور لهذه المرحلة تحديدًا —
  // يُستخدَم لحساب {hrs} بشهادة اجتياز المرحلة (عدد جلسات الحضور × هذا الرقم). البند الوحيد
  // المُخصَّص فعليًا لكل مرحلة على حدة من بين حقول الشهادة الأربعة؛ الباقي (rate/moton/date)
  // معادلة واحدة موحَّدة لكل المراحل بطلب المستخدم صراحةً (2026-09-17). راجع
  // buildStageCertFields_ (dataPost.js) ومناقشات.md "شهادات الاجتياز" للسياق الكامل.
  var wantedCols = ['stageIndex', 'name', 'registrationOpen', 'courseStartDate', 'courseEndDate', 'cardTemplateId', 'certTemplateId', 'logo', 'bagLink', 'hoursPerAttendance', 'createdAt', 'updatedBy', 'updatedAt'];
  if (!sh) {
    sh = ss.insertSheet('stages');
    sh.appendRow(wantedCols);
    var now = new Date();
    STAGE_NAMES_.forEach(function (name, i) {
      sh.appendRow([i, name, false, '', '', '', '', '', '', '', now, '', '']);
    });
  } else {
    var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wantedCols.filter(function (c) { return headers0.indexOf(c) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  migrateStageLogoBagFromMainSheet_(sh);
  migrateStage0HoursPerAttendance_(sh);
  return sh;
}

// هجرة لمرة واحدة: المرحلة 0 (التأهيلية) وحدها كان لها رقم ثابت مكتوب بالكود (×3) قبل إضافة
// هذا العمود — نهاجره صراحةً لـ3 بحقل hoursPerAttendance حتى لا تتغيّر شهادتها الحالية بصمت
// لمجرد إضافة العمود (نفس فلسفة هجرة considerAllExams بشيت stageCriteria). مراحل أخرى تُترَك
// فارغة عمدًا — لم يكن لها رقم افتراضي من الأساس، الإداري يُدخله بنفسه من "إدارة المراحل".
function migrateStage0HoursPerAttendance_(stagesSheet) {
  var headers = stagesSheet.getRange(1, 1, 1, stagesSheet.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex'), hoursCol = headers.indexOf('hoursPerAttendance');
  var lastRow = stagesSheet.getLastRow();
  if (lastRow < 2) return;
  var rows = stagesSheet.getRange(2, 1, lastRow - 1, stagesSheet.getLastColumn()).getValues();
  rows.forEach(function (r, i) {
    if (+r[stageCol] === 0 && r[hoursCol] === '') {
      stagesSheet.getRange(i + 2, hoursCol + 1).setValue(3);
    }
  });
}

// هجرة تلقائية لمرة واحدة لكل مرحلة: تنسخ logo/bag من الصفوف القديمة بشيت main (كانت المصدر
// الوحيد لبيانات كل مرحلة قبل شيت stages، ولا تزال تحمل بيانات حقيقية) إلى شيت stages، بطلب
// المستخدم صراحةً ("يكون كله في مكان واحد"). لا تحذف أي شيء من main (رجعة آمنة لو احتجنا).
// آمنة التكرار: تتجاوز أي صف بقيمة موجودة بالفعل بـstages، ولا تُشغَّل إلا لو العمودان فاضيان.
function migrateStageLogoBagFromMainSheet_(stagesSheet) {
  var headers = stagesSheet.getRange(1, 1, 1, stagesSheet.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex'), logoCol = headers.indexOf('logo'), bagCol = headers.indexOf('bagLink');
  var lastRow = stagesSheet.getLastRow();
  if (lastRow < 2) return;
  var rows = stagesSheet.getRange(2, 1, lastRow - 1, stagesSheet.getLastColumn()).getValues();
  var needsMigration = rows.some(function (r) { return r[logoCol] === '' || r[bagCol] === ''; });
  if (!needsMigration) return;

  var mainSh = SpreadsheetApp.openById(refID).getSheetByName('main');
  var mainHeaders = mainSh.getRange(1, 1, 1, mainSh.getLastColumn()).getValues()[0];
  var mainLvlCol = mainHeaders.indexOf('#'), mainLogoCol = mainHeaders.indexOf('logo'), mainBagCol = mainHeaders.indexOf('bag');
  if (mainLvlCol === -1) return;
  var mainLastRow = mainSh.getLastRow();
  if (mainLastRow < 2) return;
  var mainRows = mainSh.getRange(2, 1, mainLastRow - 1, mainSh.getLastColumn()).getValues();
  var byLevel = {};
  mainRows.forEach(function (r) { byLevel[+r[mainLvlCol]] = r; });

  var changed = false;
  rows.forEach(function (r) {
    var src = byLevel[+r[stageCol]];
    if (!src) return;
    if (r[logoCol] === '' && mainLogoCol > -1 && src[mainLogoCol]) { r[logoCol] = src[mainLogoCol]; changed = true; }
    if (r[bagCol] === '' && mainBagCol > -1 && src[mainBagCol]) { r[bagCol] = src[mainBagCol]; changed = true; }
  });
  if (changed) stagesSheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function getStagesList() {
  var sh = ensureStagesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return data.map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) {
      var v = r[i];
      obj[h] = (v instanceof Date) ? v.toISOString() : v;
    });
    return obj;
  }).sort(function (a, b) { return (+a.stageIndex) - (+b.stageIndex); });
}

//////////////////////////////////////////////////////////////////////////////////////////////
// "الازدواجية" (طالب + صلاحية إدارية معًا لنفس الرقم الشخصي) — شيتا students وemp مستقلّان
// تمامًا، ولا شيء يمنع أن يكون لنفس cpr صف بكل واحد منهما. راجع مناقشات.md "طالب بصلاحية
// إدارية" للنقاش الكامل. الدالتان أدناه للقراءة فقط، ولا تمسّان آلية الدخول (auth.js) إطلاقًا —
// findPersonByCpr_ هناك تبقى بلا أي تغيير (تحلّ الهوية بالأولوية لـemp كما كانت دائمًا، بلا أي
// خطر على تسجيل الدخول القائم لكل المستخدمين الحاليين، أحاديّي الحساب أو مزدوجيه).
//////////////////////////////////////////////////////////////////////////////////////////////

// هل لهذا الرقم الشخصي (موظف/إداري مسجَّل دخوله حاليًا) صف طالب أيضًا؟ تُستخدَم لإظهار زر
// "حسابي كطالب" بلوحة الإدارة (يُعيد استخدام adminPreviewStudentPage القائمة أصلًا بدل بناء
// آلية دخول موازية).
function checkIsAlsoStudent(cpr) {
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr'), nameCol = headers.indexOf('name');
  var classCols = [0, 1, 2, 3].map(function (i) { return headers.indexOf('class' + i); });
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { isStudent: false };
  var row = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues()
    .find(function (r) { return cprEquals_(r[cprCol], cpr); });
  if (!row) return { isStudent: false };
  var stageIndex = classCols.findIndex(function (col) { return row[col] === 'active'; });
  return { isStudent: true, active: stageIndex !== -1, stageIndex: stageIndex, name: row[nameCol] };
}

// قائمة الأرقام الشخصية الموجودة بشيتَي emp وstudents معًا (تقاطع، لا اتحاد) — قراءة عمود cpr
// فقط من كل شيت (خفيفة، بلا بقية الأعمدة)، تُستخدَم لعرض شارات "طالب أيضًا"/"له صلاحية إدارية"
// بجدولَي "قوائم الطلاب"/"إدارة المتعاونين" بلوحة الإدارة — عرض فقط، بلا أي تأثير على الصلاحيات
// أو تدفّق العمل الفعلي.
function getDualRoleCprList() {
  function readCprColumn(sheetName) {
    var sh = SpreadsheetApp.openById(mainData).getSheetByName(sheetName);
    if (!sh) return [];
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var cprCol = headers.indexOf('cpr');
    var lastRow = sh.getLastRow();
    if (cprCol === -1 || lastRow < 2) return [];
    return sh.getRange(2, cprCol + 1, lastRow - 1, 1).getValues()
      .map(function (r) { return normalizeCpr_(r[0]); })
      .filter(function (c) { return c; });
  }
  var empSet = {};
  readCprColumn('emp').forEach(function (c) { empSet[c] = true; });
  var dual = {};
  readCprColumn('students').forEach(function (c) { if (empSet[c]) dual[c] = true; });
  return Object.keys(dual);
}

// المرحلة النشطة حاليًا لطالب (class0..class3 === 'active') — راجع نفس المنطق بـcurrentLevel
// (funcs-js.html) للعميل؛ هذه نسخة الخادم المشتركة بين كل دوال إحصاءات المرحلة أدناه.
function getStudentActiveStageIndex_(cpr) {
  var stSh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var stHeaders = stSh.getRange(1, 1, 1, stSh.getLastColumn()).getValues()[0];
  var stCprCol = stHeaders.indexOf('cpr');
  var classCols = [0, 1, 2, 3].map(function (i) { return stHeaders.indexOf('class' + i); });
  var stRow = stSh.getRange(2, 1, stSh.getLastRow() - 1, stSh.getLastColumn()).getValues()
    .find(function (r) { return cprEquals_(r[stCprCol], cpr); });
  return stRow ? classCols.findIndex(function (col) { return stRow[col] === 'active'; }) : -1;
}

//////////////////////////////////////////////////////////////////////////////////////////////
// إحصائية حضور الطالب بمرحلته الحالية منذ "بداية الدورة" — النسبة = عدد تواريخ محاضرات
// مرحلته الفعلية (من "إدارة المحاضرات") التي له فيها سجل حضور، ÷ إجمالي تواريخ محاضرات
// مرحلته المسجَّلة خلال [courseStartDate, courseEndDate أو اليوم]. لا نسبة لو المرحلة بلا
// courseStartDate بعد، أو الطالب بلا مرحلة نشطة حاليًا.
//////////////////////////////////////////////////////////////////////////////////////////////
function getStageAttendanceStats(cpr) {
  var stageIndex = getStudentActiveStageIndex_(cpr);
  if (stageIndex === -1) return { stageIndex: null, attended: 0, total: 0, percent: null };

  var stage = getStagesList().find(function (s) { return +s.stageIndex === stageIndex; });
  if (!stage || !stage.courseStartDate) return { stageIndex: stageIndex, attended: 0, total: 0, percent: null };

  var tz = SpreadsheetApp.openById(mainData).getSpreadsheetTimeZone();
  var startDate = Utilities.formatDate(new Date(stage.courseStartDate), tz, 'yyyy-MM-dd');
  var endDate = stage.courseEndDate ? Utilities.formatDate(new Date(stage.courseEndDate), tz, 'yyyy-MM-dd') : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var stageName = STAGE_NAMES_[stageIndex];

  var lectureDates = getLecturesRef()
    .filter(function (l) { return l.level.indexOf(stageName) !== -1 && l.date && l.date >= startDate && l.date <= endDate; })
    .map(function (l) { return l.date; });
  var uniqueLectureDates = lectureDates.filter(function (d, i) { return lectureDates.indexOf(d) === i; });
  if (uniqueLectureDates.length === 0) return { stageIndex: stageIndex, attended: 0, total: 0, percent: null };

  // resp==='request' يعني طلب حضور يدوي لسه معلَّق (لم يُقبَل بعد) — لا يُحتسَب حضورًا فعليًا،
  // بنفس استثناء countAttendDays بجانب الطالب (js.html).
  var attendRows = (getAttendance(cpr) || []).filter(function (a) { return a.resp !== 'request'; });
  var attendedDates = {};
  attendRows.forEach(function (a) {
    if (!a.date) return;
    var d = Utilities.formatDate(new Date(a.date), tz, 'yyyy-MM-dd');
    if (d >= startDate && d <= endDate) attendedDates[d] = true;
  });
  var attended = uniqueLectureDates.filter(function (d) { return attendedDates[d]; }).length;

  return { stageIndex: stageIndex, attended: attended, total: uniqueLectureDates.length, percent: Math.round((attended / uniqueLectureDates.length) * 100) };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// نسبة نجاح الطالب باختبارات مرحلته الحالية = عدد الاختبارات التي اجتازها (محاولة واحدة ناجحة
// على الأقل، rate!=='راسب') ÷ إجمالي اختبارات هذه المرحلة المُعَدَّة فعليًا (شيت rules، غير
// المؤرشفة) — لا التي خاض بعضها فقط. راجع getExams (أعلاه) وgetAnswersData.
//////////////////////////////////////////////////////////////////////////////////////////////
function getStageExamPassRate_(cpr) {
  var stageIndex = getStudentActiveStageIndex_(cpr);
  if (stageIndex === -1) return { stageIndex: null, passed: 0, total: 0, percent: null };

  var stageExams = getExams(null, stageIndex) || [];
  if (stageExams.length === 0) return { stageIndex: stageIndex, passed: 0, total: 0, percent: null };

  var passedExamNames = {};
  (getAnswersData(cpr) || []).forEach(function (a) {
    if (+a.level === stageIndex && a.rate !== 'راسب') passedExamNames[a.exam] = true;
  });
  var passed = stageExams.filter(function (e) { return passedExamNames[e.exam]; }).length;

  return { stageIndex: stageIndex, passed: passed, total: stageExams.length, percent: Math.round((passed / stageExams.length) * 100) };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// نسبة تسميع الطالب لأوراد مرحلته الحالية = عدد الأوراد (كتاب/متن + رقم وِرد) التي له سجل
// تسميع عنها ÷ إجمالي أوراد هذه المرحلة (تبويب "الأوراد" بصفحة "إدارة المواد"، شيت matns).
// المطابقة بالاسم النصي (matn+werd) — نفس أسلوب المطابقة القائم أصلًا بميزة التسميع بالكامل.
//////////////////////////////////////////////////////////////////////////////////////////////
function getStageRecitationRate_(cpr) {
  var stageIndex = getStudentActiveStageIndex_(cpr);
  if (stageIndex === -1) return { stageIndex: null, recited: 0, total: 0, percent: null };

  var stageAwrad = getMatns().filter(function (m) { return +m.level === stageIndex; });
  if (!Array.isArray(stageAwrad) || stageAwrad.length === 0) return { stageIndex: stageIndex, recited: 0, total: 0, percent: null };

  var recitedKeys = {};
  (getDectationData() || []).forEach(function (d) {
    if (cprEquals_(d.stuCpr, cpr) && +d.level === stageIndex) recitedKeys[d.matn + '|' + d.werd] = true;
  });
  var recited = stageAwrad.filter(function (m) { return recitedKeys[m.matn + '|' + m.werd]; }).length;

  // مؤقتًا بطلب المستخدم: تثبيت المقام عند 30 وردًا مقررًا لحين مراجعة الحساب التلقائي
  var totalAwrad = 30;
  return { stageIndex: stageIndex, recited: recited, total: totalAwrad, percent: Math.min(100, Math.round((recited / totalAwrad) * 100)) };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// شروط الاجتياز — صف ثابت لكل تركيبة (مرحلة × نوع معيار)، لا CRUD حر. STAGE_CRITERIA_TYPES_
// قائمة معروفة بالكود (لا يُضاف نوع معيار جديد من الواجهة، بل بإضافة مفتاحه هنا + دالة حسابه —
// "إمكانية زيادة عناصر مستقبلًا" تعني توسيع الكود لا تخصيصًا حرًّا بالواجهة). راجع مناقشات.md
// "نظام إدارة المراحل" (قسم شروط الاجتياز) للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////
var STAGE_CRITERIA_TYPES_ = ['attendance', 'examPassRate', 'recitationRate'];
var STAGE_CRITERIA_LABELS_ = { attendance: 'نسبة الحضور', examPassRate: 'نسبة النجاح', recitationRate: 'نسبة تسميع الأوراد' };

function ensureStageCriteriaSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('stageCriteria');
  // considerAllExams (لمعيار examPassRate فقط)/considerMadhab (لمعيار recitationRate فقط) —
  // مفاتيح حساب إضافية اختيارية بطلب المستخدم صراحةً (2026-09-16)، راجع getStageCompletionStatusBatch_
  // (أعلاه) لمنطق استخدامها الفعلي، ومناقشات.md "شهادات الاجتياز" للسياق الكامل.
  var wantedCols = ['stageIndex', 'criterionKey', 'threshold', 'isMandatory', 'considerAllExams', 'considerMadhab', 'createdAt', 'updatedBy', 'updatedAt'];
  if (!sh) {
    sh = ss.insertSheet('stageCriteria');
    sh.appendRow(wantedCols);
  } else {
    var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wantedCols.filter(function (c) { return headers0.indexOf(c) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex'), keyCol = headers.indexOf('criterionKey');
  var considerAllExamsCol = headers.indexOf('considerAllExams');
  var lastRow = sh.getLastRow();
  var existing = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
  var existingKeys = {};
  existing.forEach(function (r) { existingKeys[r[stageCol] + '|' + r[keyCol]] = true; });

  // هجرة لمرة واحدة: أي صف examPassRate قائم بالفعل لم يُلمَس عمود considerAllExams إطلاقًا بعد
  // (فارغ حرفيًا، لا false مكتوبة صراحةً — الفرق بينهما محفوظ بـSheets ومُتحقَّق منه هنا بدقة)
  // يُهاجَر لـtrue صراحةً — يحافظ على سلوك الحساب التاريخي (المقام = كل اختبارات المرحلة) لكل
  // مرحلة مُعَدَّة بالفعل، فلا يتغيّر من يظهر "مجتازًا" بصفحة "مرشّحو الاجتياز" بصمت لمجرد إضافة
  // هذا العمود. إداري يريد التبديل الصريح للسلوك الجديد يعطّله يدويًا لاحقًا من الواجهة.
  var migrated = false;
  existing.forEach(function (r, i) {
    if (r[keyCol] === 'examPassRate' && r[considerAllExamsCol] === '') {
      r[considerAllExamsCol] = true;
      sh.getRange(i + 2, considerAllExamsCol + 1).setValue(true);
      migrated = true;
    }
  });

  var now = new Date();
  [0, 1, 2, 3].forEach(function (stageIndex) {
    STAGE_CRITERIA_TYPES_.forEach(function (key) {
      if (existingKeys[stageIndex + '|' + key]) return;
      var row = new Array(headers.length).fill('');
      row[stageCol] = stageIndex;
      row[keyCol] = key;
      row[headers.indexOf('threshold')] = 0;
      row[headers.indexOf('isMandatory')] = false;
      if (key === 'examPassRate') row[considerAllExamsCol] = true;
      row[headers.indexOf('createdAt')] = now;
      sh.appendRow(row);
    });
  });
  return sh;
}

function getStageCriteriaList() {
  var sh = ensureStageCriteriaSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return data.map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) {
      var v = r[i];
      obj[h] = (v instanceof Date) ? v.toISOString() : v;
    });
    obj.label = STAGE_CRITERIA_LABELS_[obj.criterionKey] || obj.criterionKey;
    return obj;
  }).sort(function (a, b) { return (+a.stageIndex - +b.stageIndex) || String(a.criterionKey).localeCompare(String(b.criterionKey)); });
}

//////////////////////////////////////////////////////////////////////////////////////////////
// حالة اجتياز طالب لمرحلته الحالية — يجمع الحسابات الثلاثة أعلاه ويقارنها بشروط مرحلته، ويحدد
// هل حقّق كل الشروط الإلزامية (meetsAllMandatory) أم لا. تُستخدَم بصفحة "مرشّحو الاجتياز"
// الإدارية وبأي عرض طالب مستقبلي لتقدّمه. لا تُصدر شهادة ولا تُغيّر أي بيانات — قراءة فقط.
//////////////////////////////////////////////////////////////////////////////////////////////
function getStageCompletionStatus(cpr) {
  var stageIndex = getStudentActiveStageIndex_(cpr);
  if (stageIndex === -1) return { stageIndex: null, criteria: [], meetsAllMandatory: false };

  var statsByKey = {
    attendance: getStageAttendanceStats(cpr),
    examPassRate: getStageExamPassRate_(cpr),
    recitationRate: getStageRecitationRate_(cpr)
  };
  var stageCriteria = getStageCriteriaList().filter(function (c) { return +c.stageIndex === stageIndex; });

  var meetsAllMandatory = true;
  var criteria = stageCriteria.map(function (c) {
    var stat = statsByKey[c.criterionKey];
    var percent = stat ? stat.percent : null;
    var met = percent !== null && percent >= (+c.threshold || 0);
    if (c.isMandatory && !met) meetsAllMandatory = false;
    return { criterionKey: c.criterionKey, label: c.label, threshold: +c.threshold || 0, isMandatory: !!c.isMandatory, percent: percent, met: met };
  });

  return { stageIndex: stageIndex, criteria: criteria, meetsAllMandatory: meetsAllMandatory };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// نسخة دفعة واحدة من getStageCompletionStatus لكل الطلاب معًا — نفس منطق الحساب بالضبط
// (attendance/examPassRate/recitationRate) لكن بقراءة كل شيت مصدر (المحاضرات/الحضور/الإجابات/
// الأوراد/التسميع) مرة واحدة فقط بدل مرة لكل طالب. getStageCompletionStatus الأصلية كانت
// تُستدعى مرة لكل طالب نشط بصفحة "مرشّحو الاجتياز" (getGraduationCandidates)، وكل استدعاء يعيد
// قراءة شيتات كاملة من الصفر (بما فيها إعادة قراءة شيت الطلاب نفسه لتحديد المرحلة النشطة) — مع
// عشرات/مئات الطلاب هذا يعني آلاف طلبات Sheets API المتكررة، وهو سبب بطء تحميل الصفحة الفعلي
// الذي لاحظه المستخدم. تُستخدَم فقط من getGraduationCandidates (dataPost.js) حاليًا؛
// getStageCompletionStatus الأصلية بقيت بلا تغيير لأي استخدام مستقبلي بمفردها لطالب واحد.
//////////////////////////////////////////////////////////////////////////////////////////////
function getStageCompletionStatusBatch_(students) {
  var tz = SpreadsheetApp.openById(mainData).getSpreadsheetTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var stagesByIndex = {};
  getStagesList().forEach(function (s) { stagesByIndex[+s.stageIndex] = s; });

  var criteriaByStage = {};
  getStageCriteriaList().forEach(function (c) {
    (criteriaByStage[+c.stageIndex] = criteriaByStage[+c.stageIndex] || []).push(c);
  });

  var lecturesByStageName = {};
  getLecturesRef().forEach(function (l) {
    if (!l.date) return;
    l.level.forEach(function (name) {
      (lecturesByStageName[name] = lecturesByStageName[name] || []).push(l.date);
    });
  });

  var examsByLevel = {};
  (getExams(null, null) || []).forEach(function (e) {
    (examsByLevel[+e.level] = examsByLevel[+e.level] || []).push(e);
  });

  var attendanceByCpr = {};
  (getAttendance(null) || []).forEach(function (a) {
    if (a.resp === 'request') return;
    var key = normalizeCpr_(a.cpr);
    (attendanceByCpr[key] = attendanceByCpr[key] || []).push(a.date);
  });

  // درجة (0-100) آخر محاولة لكل (طالب × مرحلة × اختبار) — أساس "نسبة النجاح" الآن (بطلب المستخدم
  // صراحةً 2026-09-16): متوسط درجات فعلي لا عدّ نجح/رسب. تُحتسَب الدرجة بصرف النظر عن نجاح
  // الاختبار أو رسوبه (طالب رسب بدرجة 40 يظل يُحمَّل بـ40 لا صفرًا ولا يُستبعَد — "خاضه" فعلًا).
  var attemptedExamsByCpr = {};
  var degreeByCprExam = {};
  (getAnswersData(null) || []).forEach(function (a) {
    var key = normalizeCpr_(a.cpr) + '|' + (+a.level);
    (attemptedExamsByCpr[key] = attemptedExamsByCpr[key] || {})[a.exam] = true;
    var degree = Number(a.result);
    if (isFinite(degree)) degreeByCprExam[key + '|' + a.exam] = degree;
  });

  var awradByStage = {};
  getMatns().forEach(function (m) {
    (awradByStage[+m.level] = awradByStage[+m.level] || []).push(m);
  });

  var recitedByCpr = {};
  (getDectationData() || []).forEach(function (d) {
    var key = normalizeCpr_(d.stuCpr) + '|' + (+d.level);
    (recitedByCpr[key] = recitedByCpr[key] || {})[d.matn + '|' + d.werd] = true;
  });

  // كل مرحلة "active" (الحالية) أو "done" (أُنهيت/انتُقل منها) للطالب تُقيَّم هنا كمرشَّحة، لا
  // "active" فقط كما كانت سابقًا — لأن acceptedStu_ (oldJS.js) تُحوّل تلقائيًا أي مرحلة "active"
  // أخرى إلى "done" فور قبول الطالب بمرحلة جديدة، بصرف النظر عن صدور شهادة اجتيازها من عدمه.
  // طالب أنهى شروط مرحلته فعليًا لكن انتقل لمرحلة أخرى قبل أن تُصدَر له شهادته كان يختفي نهائيًا
  // من صفحة "مرشّحو الاجتياز" دون أي وسيلة لاسترجاعه. getGraduationCandidates (dataPost.js) هي
  // من تستبعد لاحقًا أي مرحلة "done" صدرت شهادتها بالفعل (عبر sourceStatus)، فلا تمتلئ القائمة
  // بسجلات تاريخية مُنجَزة — المرحلة "active" الحالية تبقى تُعرَض دومًا كالسابق.
  var results = [];
  students.forEach(function (s) {
    var stageEntries = [0, 1, 2, 3]
      .filter(function (i) { return s['class' + i] === 'active' || s['class' + i] === 'done'; })
      .map(function (i) { return { stageIndex: i, sourceStatus: s['class' + i] }; });

    stageEntries.forEach(function (entry) {
    var stageIndex = entry.stageIndex;
    var cpr = normalizeCpr_(s.cpr);
    var stage = stagesByIndex[stageIndex];
    var stageName = STAGE_NAMES_[stageIndex];

    var attendancePercent = null;
    if (stage && stage.courseStartDate) {
      var startDate = Utilities.formatDate(new Date(stage.courseStartDate), tz, 'yyyy-MM-dd');
      var endDate = stage.courseEndDate ? Utilities.formatDate(new Date(stage.courseEndDate), tz, 'yyyy-MM-dd') : today;
      var stageLectureDates = (lecturesByStageName[stageName] || []).filter(function (d) { return d >= startDate && d <= endDate; });
      var uniqueLectureDates = stageLectureDates.filter(function (d, i) { return stageLectureDates.indexOf(d) === i; });
      if (uniqueLectureDates.length) {
        var attendedDates = {};
        (attendanceByCpr[cpr] || []).forEach(function (d) {
          var ds = Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd');
          if (ds >= startDate && ds <= endDate) attendedDates[ds] = true;
        });
        var attended = uniqueLectureDates.filter(function (d) { return attendedDates[d]; }).length;
        attendancePercent = Math.round((attended / uniqueLectureDates.length) * 100);
      }
    }

    var stageCriteria = criteriaByStage[stageIndex] || [];
    var examCriterion = stageCriteria.find(function (c) { return c.criterionKey === 'examPassRate'; });
    var recitationCriterion = stageCriteria.find(function (c) { return c.criterionKey === 'recitationRate'; });

    var examPassPercent = null;
    // اختبارات فقه منفصلة تحت المواد الثلاث (الفقه الحنبلي/المالكي/الشافعي) تُستبعَد هنا من
    // إجمالي اختبارات هذا الطالب لو مادتها تخص مذهبًا غير مذهبه (نفس منطق getExams أعلاه، لا قراءة
    // شيت إضافية — s.mazhab متوفر أصلًا بكل صف طالب) — وإلا احتُسِب على كل طالب اجتياز اختبارات
    // فقه الثلاثة معًا رغم أنه لا يستطيع (ولا يُفترَض به) أداء غير واحد منها فقط.
    var studentFiqhRoot = fiqhRootIn_(s.mazhab);
    var stageExams = (examsByLevel[stageIndex] || []).filter(function (e) {
      var examFiqhRoot = fiqhRootIn_(e.subject);
      return !examFiqhRoot || examFiqhRoot === studentFiqhRoot;
    });
    if (stageExams.length) {
      var attemptedMap = attemptedExamsByCpr[cpr + '|' + stageIndex] || {};
      // نسبة النجاح = متوسط درجات فعلي لا عدّ اختبارات ناجحة/راسبة (بطلب المستخدم صراحةً
      // 2026-09-16، تغيير جذري مقصود — تُقرَأ الأرقام الظاهرة بصفحة "مرشّحو الاجتياز" مختلفة
      // عمّا قبل هذا التاريخ بالضرورة). البسط: مجموع درجة آخر محاولة لكل اختبار خاضه الطالب
      // (يشمل درجات الاختبارات الراسب فيها أيضًا — "خاضه" لا "نجح فيه"). المقام: نفس منطق
      // considerAllExams القائم أصلًا، لكن بوحدة الدرجة (100 لكل اختبار) لا عدّ الاختبارات:
      // مفعَّل (الافتراضي، مُهاجَر صراحةً لكل صف قائم كي لا يتغيّر سلوك أي مرحلة مُعَدَّة بصمت
      // لمجرد إضافة العمود) — المقام 100×كل اختبارات المرحلة المُعَدَّة. معطَّل — المقام
      // 100×الاختبارات التي خاضها فقط (يعادل متوسط درجاته فيما خاضه فقط).
      var scoreSum = stageExams.reduce(function (sum, e) {
        var degree = attemptedMap[e.exam] ? degreeByCprExam[cpr + '|' + stageIndex + '|' + e.exam] : undefined;
        return sum + (typeof degree === 'number' ? degree : 0);
      }, 0);
      var considerAllExams = !examCriterion || examCriterion.considerAllExams !== false;
      if (considerAllExams) {
        examPassPercent = Math.round(scoreSum / stageExams.length);
      } else {
        var attemptedCount = stageExams.filter(function (e) { return attemptedMap[e.exam]; }).length;
        examPassPercent = attemptedCount ? Math.round(scoreSum / attemptedCount) : null;
      }
    }

    var recitationPercent = null;
    // considerMadhab (شيت stageCriteria، بطلب المستخدم صراحةً 2026-09-16): مفعَّل — تُستبعَد أوراد
    // مذاهب الفقه الأخرى (نفس مطابقة fiqhRootIn_ المستخدَمة أصلًا لتصفية اختبارات الفقه أعلاه)
    // فيصبح المقام أوراد مذهب الطالب فقط. معطَّل (الافتراضي — نفس السلوك التاريخي بلا تصفية):
    // كل أوراد المرحلة بصرف النظر عن المذهب.
    var considerMadhab = !!(recitationCriterion && recitationCriterion.considerMadhab);
    var stageAwrad = (awradByStage[stageIndex] || []).filter(function (m) {
      if (!considerMadhab) return true;
      var matnFiqhRoot = fiqhRootIn_(m.matn);
      return !matnFiqhRoot || matnFiqhRoot === studentFiqhRoot;
    });
    if (stageAwrad.length) {
      var recitedMap = recitedByCpr[cpr + '|' + stageIndex] || {};
      var recited = stageAwrad.filter(function (m) { return recitedMap[m.matn + '|' + m.werd]; }).length;
      // مؤقتًا بطلب المستخدم: تثبيت المقام عند 30 وردًا مقررًا لحين مراجعة الحساب التلقائي
      var totalAwrad = 30;
      recitationPercent = Math.min(100, Math.round((recited / totalAwrad) * 100));
    }

    var percentByKey = { attendance: attendancePercent, examPassRate: examPassPercent, recitationRate: recitationPercent };
    var meetsAllMandatory = true;
    var criteria = stageCriteria.map(function (c) {
      // احتياط صارم: أي شيء غير رقم منتهٍ فعليًا (undefined/NaN/Infinity، مهما كان مصدره)
      // يتحوّل صراحةً لـnull هنا — قناة google.script.run أسقطت حقل percent بصمت (بلا أي خطأ
      // ظاهر) حين كانت قيمته NaN عمليًا بدل تحويله لnull كما يفعل JSON.stringify عادة، فظهر
      // "undefined%" بالواجهة بدل شرطة "—" لعمودَي الحضور والتسميع تحديدًا.
      var raw = percentByKey[c.criterionKey];
      var percent = (typeof raw === 'number' && isFinite(raw)) ? raw : null;
      var met = percent !== null && percent >= (+c.threshold || 0);
      if (c.isMandatory && !met) meetsAllMandatory = false;
      return { criterionKey: c.criterionKey, label: c.label, threshold: +c.threshold || 0, isMandatory: !!c.isMandatory, percent: percent, met: met };
    });

    results.push({ cpr: s.cpr, stageIndex: stageIndex, sourceStatus: entry.sourceStatus, criteria: criteria, meetsAllMandatory: meetsAllMandatory });
    });
  });
  return results;
}

//////////////////////////////////////////////////////////////////////////////////////////////
// "إدارة الرسائل" — نظام موحَّد لكل رسائل واتساب (تلقائية وجماعية): قوالب، مجموعات، سجل دائم.
// راجع مناقشات.md "إدارة الرسائل" للتصميم الكامل المتفَق عليه مع المستخدم عبر نقاش مطوَّل.
//////////////////////////////////////////////////////////////////////////////////////////////

// مزوّد حملات واتساب في صفحة "الرسائل". يبقى Fonnte هو الافتراضي حتى يختار Super Admin
// استخدام Meta صراحةً. رمز Meta لا يخرج من Script Properties أبدًا؛ دالة القراءة العامة
// تعيد فقط هل الرمز محفوظ أم لا، مع الإعدادات غير السرية اللازمة لعرض حالة الربط.
var WHATSAPP_PROVIDER_PROP_ = 'WHATSAPP_ACTIVE_PROVIDER';
var META_WA_ACCESS_TOKEN_PROP_ = 'WHATSAPP_META_ACCESS_TOKEN';
var META_WA_API_VERSION_PROP_ = 'WHATSAPP_META_API_VERSION';
var META_WA_PHONE_NUMBER_ID_PROP_ = 'WHATSAPP_META_PHONE_NUMBER_ID';
var META_WA_BUSINESS_ACCOUNT_ID_PROP_ = 'WHATSAPP_META_BUSINESS_ACCOUNT_ID';
var META_WA_DEFAULT_API_VERSION_ = 'v25.0';
var META_WA_DEFAULT_PHONE_NUMBER_ID_ = '1363870846806698';
var META_WA_DEFAULT_BUSINESS_ACCOUNT_ID_ = '2496994204078442';

function getMetaWhatsAppConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    apiVersion: props.getProperty(META_WA_API_VERSION_PROP_) || META_WA_DEFAULT_API_VERSION_,
    phoneNumberId: props.getProperty(META_WA_PHONE_NUMBER_ID_PROP_) || META_WA_DEFAULT_PHONE_NUMBER_ID_,
    businessAccountId: props.getProperty(META_WA_BUSINESS_ACCOUNT_ID_PROP_) || META_WA_DEFAULT_BUSINESS_ACCOUNT_ID_,
    accessToken: props.getProperty(META_WA_ACCESS_TOKEN_PROP_) || ''
  };
}

function getActiveWhatsAppProvider_() {
  return PropertiesService.getScriptProperties().getProperty(WHATSAPP_PROVIDER_PROP_) === 'meta' ? 'meta' : 'fonnte';
}

// الإرسال الجماعي إلى الأفراد (طلاب/موظفين) معطَّل ما دام Fonnte هو المزوّد المختار، ويُتاح مع Meta
// فقط؛ أما الإرسال إلى مجموعات واتساب فيبقى متاحًا مع Fonnte (بطلب صريح من المستخدم). يُفرَض هنا على
// الخادم لأن تعطيل الواجهة وحده لا يمنع استدعاء الدالة مباشرة عبر google.script.run. لا يمسّ الحملات
// الجارية أو المجدولة أو المنتظرة بالطابور؛ فهي تكمل بمزوّدها، وهذا الفحص يخصّ إنشاء حملات جديدة فقط.
var BROADCAST_INDIVIDUALS_DISABLED_FONNTE_MESSAGE_ = 'الإرسال الجماعي إلى الأفراد (الطلاب والموظفين) معطَّل عند اختيار Fonnte؛ المتاح معه الإرسال إلى مجموعات واتساب فقط. بدّل المزوّد إلى Meta للإرسال إلى الأفراد.';
function isIndividualBroadcastAllowedForActiveProvider_() {
  return getActiveWhatsAppProvider_() === 'meta';
}

// تُستدعى من صفحة الرسائل لكل إداري. لا تُعيد رمز الوصول، ولا تسمح بتعديل شيء؛ صلاحية التغيير
// التي تُعرض هنا إرشادية للواجهة فقط، والتحقق الحاسم يُعاد في دوال الحفظ على الخادم.
function getWhatsAppProviderSettings(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var meta = getMetaWhatsAppConfig_();
  return {
    ok: true,
    provider: getActiveWhatsAppProvider_(),
    canChange: perm.isSuperAdmin === true,
    metaConfigured: !!(meta.accessToken && meta.phoneNumberId && meta.businessAccountId),
    meta: {
      apiVersion: meta.apiVersion,
      phoneNumberId: meta.phoneNumberId,
      businessAccountId: meta.businessAccountId,
      hasAccessToken: !!meta.accessToken
    }
  };
}

// القوالب المعتمدة القابلة للاستخدام فعليًا في حملة Meta الحالية. لا نعيد رمز الوصول أو أي
// إعداد سري، ونستبعد القوالب التي تحتاج وسائط/متغيّرات إضافية لأن مرسِل الحملات يدعم حاليًا
// متغيّر BODY واحدًا فقط: {{1}} = اسم المستلم. هذا يمنع عرض قالب يمكن اختياره ثم يفشل عند الإرسال.
function getApprovedMetaWhatsAppTemplates(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  var config = getMetaWhatsAppConfig_();
  if (!config.accessToken || !config.businessAccountId) {
    return { error: true, code: 'META_NOT_CONFIGURED', message: 'إعداد Meta غير مكتمل؛ احفظ بيانات الربط أولًا' };
  }

  var allTemplates = [];
  var after = '';
  try {
    // حد أعلى خمس صفحات يحمي زمن تنفيذ Apps Script، ويغطي حتى 500 قالب في الحساب الواحد.
    for (var page = 0; page < 5; page++) {
      var url = 'https://graph.facebook.com/' + encodeURIComponent(config.apiVersion) + '/' + config.businessAccountId +
        '/message_templates?fields=id,name,status,language,category,components&limit=100' +
        (after ? ('&after=' + encodeURIComponent(after)) : '');
      var response = UrlFetchApp.fetch(url, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + config.accessToken },
        muteHttpExceptions: true
      });
      var httpCode = response.getResponseCode();
      var data;
      try { data = JSON.parse(response.getContentText()); } catch (parseErr) { data = {}; }
      if (httpCode < 200 || httpCode >= 300) {
        return { error: true, message: metaWhatsAppErrorReason_(httpCode, data), httpCode: httpCode };
      }
      allTemplates = allTemplates.concat(Array.isArray(data.data) ? data.data : []);
      after = data.paging && data.paging.cursors ? String(data.paging.cursors.after || '') : '';
      if (!after || !(data.paging && data.paging.next)) break;
    }
  } catch (err) {
    return { error: true, message: 'تعذّر تحميل قوالب Meta: ' + err.message };
  }

  var approved = allTemplates.filter(function (item) {
    return item && String(item.status || '').toUpperCase() === 'APPROVED';
  });
  var templates = [];

  approved.forEach(function (item) {
    var components = Array.isArray(item.components) ? item.components : [];
    var bodyComponent = components.find(function (component) {
      return String(component.type || '').toUpperCase() === 'BODY';
    });
    var body = bodyComponent ? String(bodyComponent.text || '') : '';
    if (!body) return;

    var bodyVars = [];
    var match;
    var varPattern = /\{\{\s*(\d+)\s*\}\}/g;
    while ((match = varPattern.exec(body)) !== null) {
      if (bodyVars.indexOf(match[1]) === -1) bodyVars.push(match[1]);
    }
    var unsupportedOutsideBody = components.some(function (component) {
      if (String(component.type || '').toUpperCase() === 'BODY') return false;
      var format = String(component.format || '').toUpperCase();
      if (String(component.type || '').toUpperCase() === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].indexOf(format) !== -1) return true;
      return /\{\{\s*\d+\s*\}\}/.test(JSON.stringify(component || {}));
    });

    if (bodyVars.length !== 1 || bodyVars[0] !== '1' || unsupportedOutsideBody) return;
    templates.push({
      id: item.id || '',
      name: item.name || '',
      language: item.language || 'ar',
      category: item.category || '',
      body: body.replace(/\{\{\s*1\s*\}\}/g, '{name}')
    });
  });

  templates.sort(function (a, b) {
    return (a.name + '|' + a.language).localeCompare(b.name + '|' + b.language);
  });
  return {
    ok: true,
    templates: templates,
    approvedCount: approved.length,
    unsupportedCount: Math.max(0, approved.length - templates.length)
  };
}

// المفاتيح المعروفة لقوالب الرسائل التلقائية — لا CRUD حر لإضافة مفاتيح جديدة من الواجهة (نفس
// فلسفة STAGE_CRITERIA_TYPES_ أعلاه: توسعة بالكود لا تخصيصًا حرًّا). requiredVars تُعرَض كمرجع
// بالواجهة، وتُستخدَم للتحقّق عند الحفظ (منع حفظ قالب فقَد متغيّرًا إلزاميًا بالخطأ — راجع
// مناقشات.md "قالب مُعطَّل بصمت").
// defaultBody: النص الفعلي المُستخدَم حاليًا كسقوط احتياطي (نفس النصوص القديمة المكتوبة حرفيًا
// بدوال الإرسال قبل هذا النظام، مُحوَّلة لصيغة {متغيّر} موحَّدة) — مصدر واحد لا نسختان: يُستخدَم
// كلٌّ من (أ) تعبئة منطقة التعديل بالواجهة بالنص الفعلي الحالي بدل ترك مربّع فارغ (بطلب المستخدم
// صراحةً)، و(ب) السقوط الاحتياطي الفعلي بدوال الإرسال نفسها (بدل نص منفصل مكرَّر هناك، تفاديًا
// لتضارب مستقبلي لو عُدِّل أحدهما بلا الآخر). النص الأصلي لشهادة الاختبار كان له صياغتان (مذكَّر/
// مؤنَّث) عبر منطق جندري بالكود — بسّطناها هنا لصياغة محايدة واحدة، لأن القالب الموحَّد الجديد
// نص واحد للجميع بالتصميم (كبقية القوالب الثلاثة الأخرى، لا استثناء لهذا فقط).
var MESSAGE_TEMPLATE_DEFS_ = {
  stageCertificate: {
    label: 'قالب شهادة اجتياز مرحلة', requiredVars: ['{name}', '{stage}', '{link}'],
    defaultBody: 'مبارك يا {name}، تم اعتماد اجتيازك لمرحلة {stage} وإصدار شهادتك بنجاح.\n\nرابط الشهادة:\n{link}'
  },
  examCertificate: {
    label: 'شهادة اختبار', requiredVars: ['{name}', '{exam}', '{pdfUrl}'],
    defaultBody: '*📕 ﴿بصائر﴾ للعلوم الشرعية*\nأسعد الله أوقاتك بكل خير أخي/أختي طالب العلم .. 🌟\n\n*{name}*\n\nنبشّرك بحصولك على شهادة {exam}. 😊\n\n*يمكنكم الوصول إلى الشهادة من خلال الرابط أدناه.* 🎉\n\n{pdfUrl}\n\nكتب الله أجركم وتقبل منكم ..'
  },
  greetingCard: {
    label: 'كارت التهنئة', requiredVars: ['{name}', '{pdfUrl}'],
    defaultBody: '📕✨\nكل عام أنتم بخير {name}\n\nتقبل الله منّا ومنكم صالح الأعمال\n\n🔗 *كما يسعدنا أن نرفق لكم في الرابط أدناه تصميم تهنئة العيد باسمكم لإرسالها لمن تحبون* 😍\n\nأعاده الله علينا وعلى أمتنا بالخير والبركة والنصر والثبات على العلم النافع، والعمل الصالح.\n\n{pdfUrl}\n\n📕 *﴿بصائر﴾ للعلوم الشرعية* 📕'
  },
  examDisconnect: {
    label: 'انقطاع الاتصال أثناء اختبار', requiredVars: ['{exam}', '{minutes}'],
    defaultBody: 'يبدو أن اتصالك باختبار «{exam}» انقطع قبل التسليم. يمكنك استكمال نفس الجلسة بعد تسجيل الدخول، ويتبقى تقريبًا {minutes} دقيقة. العدّاد مستمر ولن يتوقف.'
  },
  examReadinessAlert: {
    label: 'تنبيه جاهزية اختبار (للإداريين)', requiredVars: ['{exam}', '{level}'],
    defaultBody: 'تنبيه: اختبار «{exam}» للمرحلة {level} لا يحتوي أي نموذج معتمد حتى الآن.'
  },
  wpQueueDone: {
    label: 'اكتمال حملة رسائل واتساب (لمن بدأ الحملة)', requiredVars: ['{total}', '{sent}', '{failed}'],
    defaultBody: '✅ اكتملت حملة رسائل الواتساب.\n\nالإجمالي: {total}\nأُرسلت بنجاح: {sent}\nتعذّر إرسالها: {failed}'
  },
  wpQueueStopped: {
    label: 'توقّف حملة رسائل واتساب (لمن بدأ الحملة)', requiredVars: ['{total}', '{sent}', '{failed}', '{remaining}', '{reason}'],
    defaultBody: '⚠️ توقّفت حملة رسائل الواتساب قبل اكتمالها.\n\nالسبب: {reason}\n\nالإجمالي: {total}\nأُرسلت بنجاح: {sent}\nتعذّر إرسالها: {failed}\nمتبقٍّ لم يُرسَل بعد: {remaining}\n\nيمكنك استئناف الحملة من تبويب "حالة" بصفحة "إدارة الرسائل".'
  }
};

function ensureMessageTemplatesSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('messageTemplates');
  var wantedCols = ['key', 'body', 'updatedBy', 'updatedAt'];
  if (!sh) {
    sh = ss.insertSheet('messageTemplates');
    sh.appendRow(wantedCols);
  } else {
    var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wantedCols.filter(function (c) { return headers0.indexOf(c) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function getMessageTemplatesList() {
  var sh = ensureMessageTemplatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  var byKey = {};
  if (lastRow >= 2) {
    sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues().forEach(function (r) {
      var obj = {};
      headers.forEach(function (h, i) { var v = r[i]; obj[h] = (v instanceof Date) ? v.toISOString() : v; });
      if (obj.key) byKey[obj.key] = obj;
    });
  }
  return Object.keys(MESSAGE_TEMPLATE_DEFS_).map(function (key) {
    var def = MESSAGE_TEMPLATE_DEFS_[key];
    var existing = byKey[key];
    return {
      key: key,
      label: def.label,
      requiredVars: def.requiredVars,
      defaultBody: def.defaultBody,
      body: existing ? existing.body : '',
      updatedBy: existing ? existing.updatedBy : '',
      updatedAt: existing ? existing.updatedAt : ''
    };
  });
}

// نص قالب فعّال لمفتاح معيّن — تُستدعى من دوال الإرسال الفعلية (dataPost.js/examSessions.js)
// **مرة واحدة خارج أي حلقة تكرار على طلاب متعددين** (تجنّبًا لمشكلة الأداء نفسها المُصلَحة
// سابقًا بصفحة "مرشّحو الاجتياز" — راجع مناقشات.md)، ثم يُمرَّر الناتج كوسيط لدالة الإرسال لكل
// طالب. تُرجع '' لو لم يُعَدّ القالب بعد، فتسقط الدالة المستدعية حينها لنصّها الاحتياطي القديم.
function getActiveMessageTemplateBody_(key) {
  var sh = ensureMessageTemplatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var keyCol = headers.indexOf('key'), bodyCol = headers.indexOf('body');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return '';
  var row = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues().find(function (r) { return r[keyCol] === key; });
  return row ? String(row[bodyCol] || '') : '';
}

// النص الذي يبدأ به مودال إصدار شهادات المراحل. يعيد القالب المحفوظ إن وُجد، وإلا نفس النص
// الافتراضي المعرّف أعلاه؛ وبذلك لا يبقى للمودال نص ثابت منفصل قد يختلف عن صفحة القوالب.
function getStageCertificateMessageTemplate(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var savedBody = getActiveMessageTemplateBody_('stageCertificate');
  return {
    ok: true,
    body: String(savedBody || '').trim() ? savedBody : MESSAGE_TEMPLATE_DEFS_.stageCertificate.defaultBody,
    isDefault: !String(savedBody || '').trim()
  };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// "مجموعات واتساب" — قائمة مُدارة يدويًا (لا توجد أي API من Fonnte لجلب المجموعات المتصلة
// تلقائيًا — تحقّقنا من توثيقهم الرسمي). كل صف: اسم ودّي + معرّف المجموعة الحقيقي بصيغة
// xxxxxxxxxxxxx@g.us. راجع مناقشات.md "إدارة الرسائل" § المجموعات.
//////////////////////////////////////////////////////////////////////////////////////////////
// شيت توكنات إشعارات FCM — مرتبط بالرقم الشخصي (cpr) في شيت students، وليس أي شيت آخر، حتى
// نستفيد من نفس التحقق الحالي (checkIsAlsoStudent/cprEquals_) بلا تكرار منطق.
function ensureFcmTokensSheet_() {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('fcmTokens');
  var wantedCols = ['cpr', 'token', 'createdAt', 'updatedAt'];
  if (!sh) {
    sh = ss.insertSheet('fcmTokens');
    sh.appendRow(wantedCols);
  } else {
    var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wantedCols.filter(function (c) { return headers0.indexOf(c) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function getFcmTokenForStudent_(cpr) {
  var sh = ensureFcmTokensSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr'), tokenCol = headers.indexOf('token');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var row = rows.find(function (r) { return cprEquals_(r[cprCol], cpr); });
  return row ? row[tokenCol] : null;
}

// طلاب students الذين فعّلوا إشعارات المتابعة فعليًا (لديهم توكن مسجَّل بشيت fcmTokens) —
// مصدر جدول المستلمين بتبويب "الإشعارات" (admin-js.html)، نظير getPersons() المستخدَمة بتبويب
// "بث" واتساب، لكن مُقتصِرة على المفعّلين فقط بدل كل الطلاب (لا معنى لعرض من ليس له جهاز).
function getFcmActivatedStudents() {
  var tokensSh = ensureFcmTokensSheet_();
  var tokensLastRow = tokensSh.getLastRow();
  if (tokensLastRow < 2) return [];
  var tokensHeaders = tokensSh.getRange(1, 1, 1, tokensSh.getLastColumn()).getValues()[0];
  var tCprCol = tokensHeaders.indexOf('cpr');
  var activatedCprs = tokensSh.getRange(2, 1, tokensLastRow - 1, tokensSh.getLastColumn()).getValues()
    .map(function (r) { return String(r[tCprCol]); });
  if (!activatedCprs.length) return [];

  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr'), nameCol = headers.indexOf('name'), genderCol = headers.indexOf('gender');
  var classCols = [0, 1, 2, 3].map(function (i) { return headers.indexOf('class' + i); });
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  return sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues()
    .filter(function (r) { return activatedCprs.some(function (c) { return cprEquals_(r[cprCol], c); }); })
    .map(function (r) {
      var stageIndex = classCols.findIndex(function (col) { return r[col] === 'active'; });
      return { name: r[nameCol], cpr: r[cprCol], gender: r[genderCol], stageIndex: stageIndex };
    });
}

function ensureWhatsappGroupsSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('whatsappGroups');
  var wantedCols = ['id', 'name', 'groupId', 'createdAt', 'updatedBy', 'updatedAt'];
  if (!sh) {
    sh = ss.insertSheet('whatsappGroups');
    sh.appendRow(wantedCols);
  } else {
    var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wantedCols.filter(function (c) { return headers0.indexOf(c) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function getWhatsappGroupsList() {
  var sh = ensureWhatsappGroupsSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues()
    .filter(function (r) { return r[headers.indexOf('id')] !== ''; })
    .map(function (r) {
      var obj = {};
      headers.forEach(function (h, i) { var v = r[i]; obj[h] = (v instanceof Date) ? v.toISOString() : v; });
      return obj;
    });
}

//////////////////////////////////////////////////////////////////////////////////////////////
// سجل دائم لكل رسالة واتساب يُرسلها النظام (تلقائية أو جماعية) — إضافة فقط، لا مسح أبدًا. راجع
// logWhatsAppMessage_ (dataPost.js) للكتابة. مناقشات.md "إدارة الرسائل" § السجل.
//////////////////////////////////////////////////////////////////////////////////////////////
function ensureMessageLogSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('messageLog');
  // channel: أُضيف لاحقًا (fcmQueue.js) — سجل موحَّد لكل القنوات معًا، وليس واتساب فقط رغم اسم
  // logWhatsAppMessage_ التاريخي (عامّة بالفعل، مبنية على headers ديناميكيًا). الصفوف القديمة
  // بلا هذا العمود تُقرأ فارغة، وتُعامَل كـ'whatsapp' افتراضيًا عند العرض (admin-js.html).
  var wantedCols = ['id', 'campaignId', 'templateKey', 'channel', 'provider', 'externalMessageId', 'recipientName', 'recipientTarget', 'targetType', 'messageText', 'status', 'reason', 'sentBy', 'sentAt'];
  if (!sh) {
    sh = ss.insertSheet('messageLog');
    sh.appendRow(wantedCols);
  } else {
    var headers0 = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var missing = wantedCols.filter(function (c) { return headers0.indexOf(c) === -1; });
    if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

// آخر limit سطر فقط (لا الشيت بالكامل) — نفس احتياط الأداء المُتَّبع بصفحة "مرشّحو الاجتياز"،
// مطبَّق هنا من البداية لا كإصلاح لاحق. الأحدث أولًا (الإضافة دائمًا بنهاية الشيت).
function getMessageLogList(limit) {
  limit = Math.min(Math.max(+limit || 200, 1), 1000);
  var sh = ensureMessageLogSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var startRow = Math.max(2, lastRow - limit + 1);
  var numRows = lastRow - startRow + 1;
  return sh.getRange(startRow, 1, numRows, sh.getLastColumn()).getValues().map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) { var v = r[i]; obj[h] = (v instanceof Date) ? v.toISOString() : v; });
    return obj;
  }).reverse();
}

//////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////
function getAnnounces() {

  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('announce');

  var headers = sh.getRange('1:1').getValues();

  var timeCol = headers[0].indexOf('time');
  var descriptionCol = headers[0].indexOf('description');
  var linkCol = headers[0].indexOf('link');

  var data = sh.getRange(2,1,sh.getLastRow()-1,sh.getLastColumn()).getValues();
  if(data.length > 0){
    var rData = data.map(function(e){
      return {
        time: e[timeCol].toString(),
        description: e[descriptionCol],
        link: e[linkCol],
      }
    })
  }else{
    var rData = 0;
  }
  Logger.log(data.length);
  return rData;
  
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
function getDectationData(){

  var ss =  SpreadsheetApp.openById(dectationData);
  var dataSh = ss.getSheetByName('motonRates');

  var headers = dataSh.getRange('1:1').getValues();
  var dateCol = headers[0].indexOf('طابع زمني');
  var nameCol = headers[0].indexOf('اسم الطالب');
  var matnCol = headers[0].indexOf('المتن');
  var werdCol = headers[0].indexOf('الورد');
  var rateCol = headers[0].indexOf('الدرجة');
  var stuCol = headers[0].indexOf('student_Cpr');
  var respCol = headers[0].indexOf('responsible');
  var codeCol = headers[0].indexOf('code');
  var levelCol = headers[0].indexOf('level');
  
  var data = dataSh.getRange(2,1,dataSh.getLastRow()-1,dataSh.getLastColumn()).getValues();
  if(data.length > 0){
    var rData = data.map(function(e){
      return {
        date: e[dateCol].toString(),
        name: e[nameCol],
        matn: e[matnCol],
        werd: e[werdCol],
        rate: e[rateCol],
        stuCpr: normalizeCpr_(e[stuCol]),
        resp: e[respCol],
        code: e[codeCol],
        level: e[levelCol],
      }
    })

      rData.sort(function(a, b) {
        // أولًا: المقارنة حسب "matn"
        var matnCompare = String(a.matn).localeCompare(String(b.matn));
        if (matnCompare !== 0) {
          return matnCompare;
        }

        // إذا كانت "matn" متساوية، ننتقل إلى مقارنة "werd"
        var valA = a.werd;
        var valB = b.werd;

        var numA = parseFloat(valA);
        var numB = parseFloat(valB);

        var isNumA = !isNaN(numA);
        var isNumB = !isNaN(numB);

        if (isNumA && isNumB) {
          return numA - numB; // ترتيب رقمي
        } else if (isNumA) {
          return -1; // الأرقام تأتي قبل النصوص
        } else if (isNumB) {
          return 1; // الأرقام تأتي قبل النصوص
        } else {
          return String(valA).localeCompare(String(valB)); // ترتيب نصي
        }
      });


  }else{
    var rData = 0;
  }
  Logger.log(rData.length);
  return rData;
  

}

///////////////////////////////////////////////////////////////////////////////
// تُرجع المحتوى المباشر (مستوى واحد فقط، بلا تعمّق) لمجلد Drive مُعطى — تُستخدم من متصفح
// ملفات تبويب "المقررات" في صفحة الطالب (كل من الشبكة الرئيسية وأي مستوى Accordion فرعي
// يُفتح لأول مرة، تحميل كسول بلا تحميل الشجرة كاملة مقدمًا). لكل عنصر مجلد ضمن النتيجة نحسب
// أيضًا عدد عناصره المباشرة (itemCount) لعرضه على الكرت دون فتحه.
///////////////////////////////////////////////////////////////////////////////
function getDriveFolderContents(folderId) {
  folderId = String(folderId || '').trim();
  if (!folderId) return [];

  try {
    var items = [];
    var pageToken = null;
    do {
      var response = Drive.Files.list({
        q: "'" + folderId + "' in parents and trashed = false",
        fields: "nextPageToken, files(id, name, mimeType, webViewLink, thumbnailLink, size)",
        pageSize: 200,
        pageToken: pageToken || undefined,
        orderBy: "folder,name_natural"
      });
      (response.files || []).forEach(function (f) {
        items.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          isFolder: f.mimeType === 'application/vnd.google-apps.folder',
          webViewLink: f.webViewLink || '',
          thumbnailLink: f.thumbnailLink || '',
          size: f.size ? +f.size : 0
        });
      });
      pageToken = response.nextPageToken;
    } while (pageToken);

    // عدد عناصر كل مجلد فرعي مباشرةً (استعلام إضافي خفيف لكل مجلد على هذا المستوى فقط،
    // وليس تعمّقًا في الشجرة) — يُستخدم لعرضه على الكرت/عنصر الـ Accordion دون فتحه.
    items.forEach(function (item) {
      if (!item.isFolder) return;
      var countRes = Drive.Files.list({
        q: "'" + item.id + "' in parents and trashed = false",
        fields: "files(id)",
        pageSize: 1000
      });
      item.itemCount = (countRes.files || []).length;
    });

    return items;
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}

///////////////////////////////////////////////////////////////////////////////
// بحث بالاسم يشمل مجلد الحقيبة الرئيسي وكل ما تحته من مجلدات فرعية مهما كان عمقها (وليس
// المجلدات الرئيسية الظاهرة فقط) — يُستخدم من صندوق بحث تبويب "المقررات". نجمع معرّفات كل
// المجلدات ضمن الشجرة أولًا (BFS)، ونُخزّنها مؤقتًا 15 دقيقة (CacheService) لتفادي إعادة نفس
// الجولة عند كل عملية بحث متتالية على نفس الحقيبة، ثم نبحث بالاسم ضمنها دفعة واحدة.
///////////////////////////////////////////////////////////////////////////////
function searchCourseFolder(rootFolderId, query) {
  rootFolderId = String(rootFolderId || '').trim();
  query = String(query || '').trim();
  if (!rootFolderId || !query) return [];

  try {
    var cache = CacheService.getScriptCache();
    var cacheKey = 'folderTree_' + rootFolderId;
    var folderIds;
    var cached = cache.get(cacheKey);
    if (cached) {
      folderIds = JSON.parse(cached);
    } else {
      folderIds = [rootFolderId];
      var queue = [rootFolderId];
      var guard = 0;
      while (queue.length > 0 && guard < 400) { // سقف أمان لعدد المجلدات المزارة بشجرة واحدة
        guard++;
        var current = queue.shift();
        var res = Drive.Files.list({
          q: "'" + current + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          fields: "files(id)",
          pageSize: 200
        });
        (res.files || []).forEach(function (f) {
          folderIds.push(f.id);
          queue.push(f.id);
        });
      }
      cache.put(cacheKey, JSON.stringify(folderIds), 900);
    }

    var results = [];
    var seen = {};
    var qEsc = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var BATCH = 40;
    for (var i = 0; i < folderIds.length; i += BATCH) {
      var batch = folderIds.slice(i, i + BATCH);
      var parentsClause = batch.map(function (id) { return "'" + id + "' in parents"; }).join(' or ');
      var res2 = Drive.Files.list({
        q: '(' + parentsClause + ") and name contains '" + qEsc + "' and trashed = false",
        fields: 'files(id, name, mimeType, webViewLink, size)',
        pageSize: 100
      });
      (res2.files || []).forEach(function (f) {
        if (seen[f.id]) return;
        seen[f.id] = true;
        results.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          isFolder: f.mimeType === 'application/vnd.google-apps.folder',
          webViewLink: f.webViewLink || '',
          size: f.size ? +f.size : 0
        });
      });
    }
    return results;
  } catch (err) {
    return { error: String(err && err.message || err) };
  }
}


///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

// نظير computeAgeInYears من js.html، لكن على الخادم — لا نستطيع استدعاء دالة العميل من هنا.
function computeAgeFromDob_(dobVal) {
  if (!dobVal) return null;
  var birth = (dobVal instanceof Date) ? dobVal : new Date(dobVal);
  if (isNaN(birth.getTime())) return null;
  var today = new Date();
  if (birth > today) return null;
  var age = today.getFullYear() - birth.getFullYear();
  var hasHadBirthdayThisYear = (today.getMonth() > birth.getMonth()) || (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hasHadBirthdayThisYear) age--;
  return age;
}

function getPublicDashboardStats() {
  const ssMain = SpreadsheetApp.openById(mainData); // استخدام المتغير العام mainData الموجود في الكود الأصلي
  const ssRef = SpreadsheetApp.openById(refID);     // استخدام المتغير العام refID
  
  // 1. إحصائيات الطلاب
  const stuSheet = ssMain.getSheetByName('students');
  // نتأكد أن الشيت فيه بيانات (أكثر من صف العناوين)
  let students = [];
  var activeCprs = {}; // الطلاب النشطون في مرحلة واحدة على الأقل، تُستخدم لحساب نسبة الحضور
  if (stuSheet.getLastRow() > 1) {
      const headers = stuSheet.getRange(1, 1, 1, stuSheet.getLastColumn()).getValues()[0];
      const genderCol = headers.indexOf('gender');
      const mazhabCol = headers.indexOf('mazhab');
      const areaCol = headers.indexOf('area');
      const dobCol = headers.indexOf('dob');
      const class0Col = headers.indexOf('class0'); // التأهيلية
      const class1Col = headers.indexOf('class1'); // التأسيسية
      const class2Col = headers.indexOf('class2'); // التأصيلية
      const class3Col = headers.indexOf('class3'); // التحصيلية
      const cardCol = headers.indexOf('card');
      const cprCol = headers.indexOf('cpr');

      // جلب البيانات (نتجاوز صف العنوان)
      students = stuSheet.getRange(2, 1, stuSheet.getLastRow() - 1, stuSheet.getLastColumn()).getValues();

      var males = students.filter(r => r[genderCol] == 'ذكر').length;
      var females = students.filter(r => r[genderCol] == 'أنثى').length;

      // توزيع الطلاب حسب المذاهب (Active)
      var hanbalMaz = students.filter(r => r[mazhabCol] == 'المذهب الحنبلي' ).length;
      var shafeaMaz = students.filter(r => r[mazhabCol] == 'المذهب الشافعي' ).length;
      var malekMaz = students.filter(r => r[mazhabCol] == 'المذهب المالكي' ).length;

      // توزيع الطلاب حسب المناطق السكنية (area مُعبَّأ آليًا من رقم المجمع عبر searchBlock عند
      // التسجيل، فقيمه أسماء مناطق حقيقية موحَّدة وليست نصًا حرًّا عشوائيًا). تُرسَل سجلات خام
      // (منطقة + جنس + المرحلة النشطة إن وُجدت) بدل تجميع جاهز، ليتفاعل الرسم في البطاقة مع
      // فلترَي المرحلة والجنس في الواجهة فورًا دون طلب خادم جديد لكل تركيبة فلاتر.
      var areaRecords = [];
      students.forEach(function (r) {
        var a = areaCol > -1 ? String(r[areaCol] || '').trim() : '';
        if (!a) return;
        var lvl = null;
        if (r[class0Col] == 'active') lvl = 0;
        else if (r[class1Col] == 'active') lvl = 1;
        else if (r[class2Col] == 'active') lvl = 2;
        else if (r[class3Col] == 'active') lvl = 3;
        var isPending = r[class0Col] === true || r[class1Col] === true || r[class2Col] === true || r[class3Col] === true;
        areaRecords.push({ area: a, gender: genderCol > -1 ? r[genderCol] : '', level: lvl, pending: isPending });
      });

      // توزيع الطلاب حسب الأعمار — نفس نمط areaRecords تمامًا (سجلات خام: عمر محسوب + جنس +
      // المرحلة النشطة إن وُجدت)، ليتفاعل الرسم في الواجهة مع فلترَي المرحلة والجنس فورًا بلا
      // طلب خادم جديد لكل تركيبة فلاتر. عمر null لمن لا تاريخ ميلاد مسجَّل له (فلا يُستبعَد من
      // العدّ الإجمالي، بل يُحتسب ضمن فئة "غير محدَّد" في الواجهة، مع بقائه قابلاً للفلترة).
      var ageRecords = [];
      students.forEach(function (r) {
        var lvl = null;
        if (r[class0Col] == 'active') lvl = 0;
        else if (r[class1Col] == 'active') lvl = 1;
        else if (r[class2Col] == 'active') lvl = 2;
        else if (r[class3Col] == 'active') lvl = 3;
        var isPending = r[class0Col] === true || r[class1Col] === true || r[class2Col] === true || r[class3Col] === true;
        var age = dobCol > -1 ? computeAgeFromDob_(r[dobCol]) : null;
        ageRecords.push({ age: age, gender: genderCol > -1 ? r[genderCol] : '', level: lvl, pending: isPending });
      });

      // توزيع الطلاب حسب المراحل (Active فقط — القيمة true تعني طلبًا معلّقًا لم يُقبل بعد، فلا
      // يُحسب هنا حتى لا يُضخِّم عدد الطلاب "النشطين" فعليًا في المرحلة)
      var lvl0 = students.filter(r => r[class0Col] == 'active').length;
      var lvl1 = students.filter(r => r[class1Col] == 'active').length;
      var lvl2 = students.filter(r => r[class2Col] == 'active').length;
      var lvl3 = students.filter(r => r[class3Col] == 'active').length;

      // طلبات الانضمام قيد الانتظار (classN === true تعني وحدها "معلّق لهذه المرحلة"، بصرف النظر
      // عن card، الذي قد يكون غير فارغ فعلاً لطالب منتسب حاليًا لمرحلة أخرى ويطلب الالتحاق بهذه)
      var pending = students.filter(r =>
        r[class0Col] === true || r[class1Col] === true || r[class2Col] === true || r[class3Col] === true
      ).length;

      // مجموعة الطلاب النشطين (بمرحلة واحدة على الأقل) لحساب نسبة الحضور
      students.forEach(function (r) {
        var isActive = r[class0Col] === 'active' || r[class1Col] === 'active' ||
                        r[class2Col] === 'active' || r[class3Col] === 'active';
        if (isActive) activeCprs[normalizeCpr_(r[cprCol])] = true;
      });
  } else {
      var males = 0, females = 0, lvl0 = 0, lvl1 = 0, lvl2 = 0, lvl3 = 0, hanbalMaz = 0, shafeaMaz = 0, malekMaz = 0, pending = 0, areaRecords = [];
  }

  // 2. إحصائيات المشايخ/الموظفين
  const empSheet = ssMain.getSheetByName('emp');
  const staffCount = empSheet.getLastRow() > 1 ? empSheet.getLastRow() - 1 : 0;

  // 3. إحصائيات الدروس/المقررات
  const matnsSheet = ssRef.getSheetByName('matns');
  const coursesCount = matnsSheet.getLastRow() > 1 ? matnsSheet.getLastRow() - 1 : 0;

  // 4. نسبة الحضور: متوسط نسبة الحضور اليومية عبر آخر 4 أيام تم تسجيل حضور فيها فعليًا (وليست
  //    بالضرورة آخر 4 أيام تقويمية متتالية)، على مستوى كل المراحل مجتمعة، بالنسبة لإجمالي
  //    الطلاب النشطين. مثال: لو كانت نسب آخر 4 أيام 80%، 70%، 90%، 75% فالنتيجة 78.75% ≈ 79%.
  var attendanceRate = 0;
  var activeCount = Object.keys(activeCprs).length;
  if (activeCount > 0) {
    try {
      var ssAtt = SpreadsheetApp.openById(attendanceData);
      var attSh = ssAtt.getSheetByName('attendance');
      if (attSh && attSh.getLastRow() > 1) {
        var attHeaders = attSh.getRange('1:1').getValues()[0];
        var attDateCol = attHeaders.indexOf('date/time');
        var attCprCol = attHeaders.indexOf('cpr');
        var attData = attSh.getRange(2, 1, attSh.getLastRow() - 1, attSh.getLastColumn()).getValues();
        var attTz = ssAtt.getSpreadsheetTimeZone();

        // تجميع الطلاب النشطين الحاضرين، لكل يوم فيه سجلات حضور فعلية
        var attendedByDay = {}; // { 'yyyy-MM-dd': { cpr1: true, cpr2: true, ... } }
        attData.forEach(function (row) {
          if (!row[attDateCol]) return;
          var rowCpr = normalizeCpr_(row[attCprCol]);
          if (!activeCprs[rowCpr]) return; // نحسب الطلاب النشطين فقط
          var rowDayStr = Utilities.formatDate(new Date(row[attDateCol]), attTz, 'yyyy-MM-dd');
          attendedByDay[rowDayStr] = attendedByDay[rowDayStr] || {};
          attendedByDay[rowDayStr][rowCpr] = true;
        });

        // آخر 4 أيام (الأحدث فالأقدم) من بين الأيام التي بها حضور فعلي
        var attendanceDays = Object.keys(attendedByDay).sort().reverse().slice(0, 4);

        if (attendanceDays.length > 0) {
          var dailyRates = attendanceDays.map(function (dayStr) {
            var attendedCount = Object.keys(attendedByDay[dayStr]).length;
            return (attendedCount / activeCount) * 100;
          });
          var sumRates = dailyRates.reduce(function (a, b) { return a + b; }, 0);
          attendanceRate = Math.round(sumRates / dailyRates.length);
        }
      }
    } catch (err) {
      attendanceRate = 0;
    }
  }

  return {
    totalStudents: lvl0+lvl1+lvl2+lvl3, //students.length,
    males: males,
    females: females,
    levels: [lvl0, lvl1, lvl2, lvl3],
    mazaheb: [hanbalMaz, shafeaMaz, malekMaz],
    areaRecords: areaRecords,
    ageRecords: ageRecords,
    staffCount: staffCount,
    coursesCount: coursesCount,
    pending: pending,
    attendanceRate: attendanceRate
  };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////

function getFullAdminData() {
  const stats = getPublicDashboardStats(); // الدالة الموجودة بالفعل
  
  // جلب آخر 5 طلاب مسجلين
  const ss = SpreadsheetApp.openById(mainData);
  const sh = ss.getSheetByName('students');
  const lastRow = sh.getLastRow();
  let recentStudents = [];
  
  if (lastRow > 1) {
    // جلب آخر 5 صفوف
    const startRow = Math.max(2, lastRow - 4);
    const data = sh.getRange(startRow, 1, lastRow - startRow + 1, sh.getLastColumn()).getValues();
    
    // هنا نفترض ترتيب الأعمدة كما في الكود الأصلي (يمكن تحسينه بربط العناوين)
    // ولكن للسرعة سنعتمد على المصفوفة المعكوسة
    recentStudents = data.reverse().map(r => ({
      name: r[2], // افتراض أن الاسم في العمود 3
      level: 'تأهيلية', // يحتاج منطق لتحديد المستوى
      status: 'نشط'
    }));
  }

  return {
    stats: stats,
    recentStudents: recentStudents
    // يمكن إضافة المزيد هنا مثل سجلات آخر دخول
  };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// قائمة "المتعاونون" (شيت emp) لصفحة إدارتها في لوحة الإدارة — راجع dataPost.js لدوال
// الإضافة/التعديل/الحذف المقابلة، و findEmpRowByCpr_ للبحث عن صف موظف بعينه.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
// يضيف عمود "محاضر" لشيت emp إن لم يكن موجودًا بعد (صلاحية جديدة تحدّد من يظهر ضمن قائمة
// "المحاضرين" المنسدلة بقسم "إدارة المحاضرات" — راجع مناقشات.md). نمط ensure* القائم بالمشروع
// (إضافة فقط، بلا حذف/إعادة ترتيب لأي عمود موجود). تُستدعى من getStaffList دومًا حتى يكون
// العمود جاهزًا قبل أي محاولة حفظ من مودال المتعاون (addStaff/updateStaff).
function ensureEmpManagementColumns_() {
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('emp');
  if (!sh) return;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  ['محاضر', 'superAdmin'].forEach(function (name) {
    if (headers.indexOf(name) === -1) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue(name);
      headers.push(name);
    }
  });
}

function ensureEmpLecturerColumn_() {
  ensureEmpManagementColumns_();
}

function getStaffList() {
  ensureEmpLecturerColumn_();
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('emp');
  if (!sh) return [];

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var nameCol = headers.indexOf('name');
  var phoneCol = headers.indexOf('phone');
  var mailCol = headers.indexOf('email');
  var jobCol = headers.indexOf('job');
  var codeCol = headers.indexOf('code');
  var genderCol = headers.indexOf('gender');
  var registrationCol = headers.indexOf('تسجيل');
  var dictationCol = headers.indexOf('تسميع');
  var examCol = headers.indexOf('اختبار');
  var manageCol = headers.indexOf('إدارة');
  var followUpCol = headers.indexOf('متابعة');
  var lecturerCol = headers.indexOf('محاضر');
  var superAdminCol = headers.indexOf('superAdmin');
  var avatarCol = headers.indexOf('avatarUrl');

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues()
    .filter(function (r) { return r[cprCol] !== '' && r[cprCol] !== null; });

  return data.map(function (e) {
    return {
      cpr: normalizeCpr_(e[cprCol]),
      name: e[nameCol],
      phone: e[phoneCol],
      mail: e[mailCol],
      job: e[jobCol],
      code: e[codeCol],
      gender: e[genderCol],
      registration: !!e[registrationCol],
      dictation: !!e[dictationCol],
      exam: !!e[examCol],
      manage: !!e[manageCol],
      followUp: !!e[followUpCol],
      lecturer: !!e[lecturerCol],
      superAdmin: superAdminCol > -1 && e[superAdminCol] === true,
      avatarUrl: genderSafeAvatarUrl_(e[genderCol], avatarCol > -1 ? e[avatarCol] : '')
    };
  });
}

// كل الموظفين الحاصلين على صلاحية "محاضر=true" (اسم + cpr فقط) — لتعبئة القائمة المنسدلة
// في نموذج إضافة/تعديل محاضرة بقسم "إدارة المحاضرات". لا تفتح أي وصول لواجهة الإدارة نفسها.
// بلا شرطة سفلية بآخر الاسم عمدًا (بخلاف نظيراتها الأخرى): google.script.run من العميل
// لا يستطيع استدعاء دالة خادم اسمها ينتهي بشرطة سفلية (خطأ "is not a function" رغم وجودها).
function getLecturersList() {
  ensureEmpLecturerColumn_();
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('emp');
  if (!sh) return [];

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var nameCol = headers.indexOf('name');
  var lecturerCol = headers.indexOf('محاضر');

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  return sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues()
    .filter(function (r) { return r[lecturerCol] === true && r[cprCol] !== '' && r[cprCol] !== null; })
    .map(function (r) { return { cpr: normalizeCpr_(r[cprCol]), name: r[nameCol] }; });
}

/* ==========================================================================
   قسم "إدارة المحاضرات" (لوحة الإدارة) — سجل/جدول محاضرات إداري بحت، منفصل تمامًا عن
   نظام lecAttend القديم المعطَّل. لا ملف Spreadsheet جديد: شيت "ref" جديد داخل نفس ملف
   attendanceData (code.js) الموجود أصلًا لسجلات الحضور. راجع مناقشات.md § "صفحة إدارة
   المحاضرات" للمواصفات الكاملة.
   ========================================================================== */
// أعمدة شيت "ref" الفعلية (موجود مسبقًا في attendanceData، تأكَّد من المستخدم) — إنجليزية
// وليست عربية كما افترضت مواصفات مناقشات.md الأولية، وid أول عمود لا آخره. لا يهم ترتيبها
// هنا فعليًا لأن كل قراءة/كتابة تعتمد على headers.indexOf، لكنها تبقى الترتيب الحقيقي
// للمرجعية لو احتاج الشيت إعادة إنشاء.
var LECTURES_REF_HEADERS_ = ['id', 'lesson no', 'date', 'lesson', 'subject', 'stage', 'lecturer'];

// الشيت موجود بالفعل عادةً — هذه فقط شبكة أمان لو حُذف/أُعيد إنشاؤه، بنفس نمط ensure*
// القائم بالمشروع.
function ensureLecturesRefSheet_() {
  var ss = SpreadsheetApp.openById(attendanceData);
  var sh = ss.getSheetByName('ref');
  if (!sh) {
    sh = ss.insertSheet('ref');
    sh.appendRow(LECTURES_REF_HEADERS_);
  }
  return sh;
}

// قراءة كل سجلات "ref" دفعة واحدة، بالاعتماد على أسماء الأعمدة (headers.indexOf) دومًا —
// نفس مبدأ setMoqarrarat/deleteMoqarrarat (dataPost.js) على شيت matns. بلا شرطة سفلية
// بآخر الاسم عمدًا — راجع تعليق getLecturersList أعلاه لسبب ذلك.
function getLecturesRef() {
  var sh = ensureLecturesRefSheet_();
  var ss = sh.getParent();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var numCol = headers.indexOf('lesson no');
  var dateCol = headers.indexOf('date');
  var lessonCol = headers.indexOf('lesson');
  var subjectCol = headers.indexOf('subject');
  var levelCol = headers.indexOf('stage');
  var lecturerCol = headers.indexOf('lecturer');
  var idCol = headers.indexOf('id');
  var tz = ss.getSpreadsheetTimeZone();

  var range = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
  var data = range.getValues();

  // تعبئة id تلقائيًا لأي صف قديم (سابق لبناء هذا القسم) بلا معرّف بعد — بنفس طريقة توليد
  // id لمحاضرة جديدة تمامًا (Utilities.getUuid())، فتُصبح كل الصفوف قابلة للتعديل/الحذف من
  // الواجهة. تعمل تلقائيًا أول قراءة، بلا أي إجراء يدوي. الصفوف الفارغة تمامًا تُتجاهَل ولا
  // تُمنَح id (لا تظهر كمحاضرة أصلًا).
  var idsChanged = false;
  data.forEach(function (r) {
    var hasContent = r[lessonCol] || r[subjectCol] || r[dateCol];
    if (hasContent && (r[idCol] === '' || r[idCol] === null)) {
      r[idCol] = Utilities.getUuid();
      idsChanged = true;
    }
  });
  if (idsChanged) range.setValues(data);

  return data
    .filter(function (r) { return r[idCol] !== '' && r[idCol] !== null; })
    .map(function (r) {
      var d = r[dateCol] ? new Date(r[dateCol]) : null;
      var levelRaw = r[levelCol] ? String(r[levelCol]) : '';
      return {
        id: r[idCol],
        lessonNumber: r[numCol],
        date: (d && !isNaN(d.getTime())) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : '',
        lesson: r[lessonCol],
        subject: r[subjectCol],
        // نص المراحل الحقيقي (التأهيلية/التأسيسية/...) كمصفوفة — درس واحد ممكن يخص أكثر من
        // مرحلة، مخزَّنة بفاصلة واحدة داخل نفس الخلية (راجع saveLectureRef في dataPost.js)
        level: levelRaw ? levelRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [],
        lecturer: r[lecturerCol]
      };
    });
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// صفحة "إدارة المواد" (مواد/مقررات/مذاهب) — تحضيرية حاليًا بلا أي ربط بمكان آخر بالمشروع بعد
// (مثال: قائمة "المذاهب المتاحة" ببوابة الطالب لسه ثابتة بـstudent.html، ستُربَط لاحقًا بشيت
// madhabs هنا في دفعة منفصلة، حسب طلب المستخدم صراحةً). ثلاث قوائم بسيطة مستقلة (لا علاقة
// هرمية ملزمة بينها إلا `subjectId` الاختياري بالمقررات)، كل واحدة بشيتها الخاصة بـrefID
// (بيانات إعداد/تحضير أكاديمي، لا نتائج أداء طلاب — نفس الحدّ الفاصل المعتمد أصلًا refID/
// answersData). id/name/description + createdAt/updatedBy/updatedAt بكل شيت، وعمود إضافي
// واحد subjectId للمقررات فقط. saveCurriculumItem_/deleteCurriculumItem_ (dataPost.js)
// عامّتان تخدمان الثلاث قوائم معًا لتفادي تكرار نفس منطق الحفظ/الحذف ثلاث مرات.
function ensureCurriculumSheet_(sheetName, extraCols) {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName(sheetName);
  var wantedCols = ['id', 'name', 'description'].concat(extraCols || []).concat(['createdAt', 'updatedBy', 'updatedAt']);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.appendRow(wantedCols);
    return sh;
  }
  // إضافة أي عمود جديد ينقص شيتًا موجودًا أصلًا (بلا حذف/إعادة ترتيب) — لازم لدعم extraCols
  // إضافية لاحقة على قوائم أُنشئت مسبقًا (مثال: عمود level أُضيف لـsubjects لاحقًا بعد إنشائها فارغة)
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var missing = wantedCols.filter(function (c) { return headers.indexOf(c) === -1; });
  if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  return sh;
}

function getCurriculumList_(sheetName, extraCols) {
  var sh = ensureCurriculumSheet_(sheetName, extraCols);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var range = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
  var data = range.getValues();

  // صفوف أُضيفت يدويًا مباشرة بالشيت (بلا المرور بواجهة الإدارة) يكون عمود id فيها فارغًا —
  // كانت تُستبعَد بصمت بالكامل من نتيجة القراءة. نُولِّد لها معرّفًا هنا عند أول قراءة ونكتبه فورًا
  // للشيت (خلاف عمود id بشيت matns — ذاك صيغة ArrayFormula حيّة، أما هنا id قيمة عادية). الفحص
  // "أي محتوى بالصف" (لا "name" تحديدًا) عمدًا — أعمّ وأكثر أمانًا لو اختلف اسم عمود الاسم قليلًا.
  var changed = false;
  if (idCol > -1) {
    data.forEach(function (r) {
      var hasContent = r.some(function (v, i) { return i !== idCol && v !== '' && v !== null && v !== undefined; });
      if ((r[idCol] === '' || r[idCol] === null) && hasContent) {
        r[idCol] = Utilities.getUuid();
        changed = true;
      }
    });
  }
  if (changed) range.setValues(data);

  // تحويل أي قيمة Date خام (مثل createdAt/updatedAt) لنص ISO قبل الإرجاع — إرجاع كائن Date خام
  // ضمن مصفوفة كائنات عبر google.script.run تسبَّب سابقًا بإرجاع null بالكامل بصمت للعميل
  // (بلا أي خطأ بالكونسول) بمجرد وجود صف بيانات واحد فيه تاريخ حقيقي — نفس ما اكتُشف بدالة
  // debugCurriculumSheet التشخيصية حين حُلَّت المشكلة هناك بتحويل كل القيم لنصوص أولًا.
  return data.filter(function (r) { return r[idCol] !== '' && r[idCol] !== null; }).map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) {
      var v = r[i];
      obj[h] = (v instanceof Date) ? v.toISOString() : v;
    });
    return obj;
  });
}

// المرحلة تُخزَّن كنص مفصول بفاصلة (نفس نمط "المرحلة" بشيت المحاضرات — راجع saveLectureRef/
// getLecturesRef بdataPost.js/dataGet.js) لأن المادة الواحدة قد تخص أكثر من مرحلة معًا.
function getSubjectsList() { return getCurriculumList_('subjects', ['level']); }

// "المقررات" (curricula) قائمة بسيطة مستقلة حقيقية (id/name/description/subjectId — كتاب أو
// متن كوحدة كاملة، مثل "الوسائل المفيدة للحياة السعيدة") — **مختلفة تمامًا** عن "الأوراد"
// (getMatns أدناه، شيت matns الحقيقي: كل صف وِرد واحد من مقرر، لا مقرر كامل). صُحِّح
// هذا الفهم بعد توضيح من المستخدم — أول محاولة كانت خلطت المفهومين معًا خطأً. راجع مناقشات.md
// "تصحيح مفهوم المقررات/الأوراد" للسياق الكامل.
function getCurriculaList() { return getCurriculumList_('curricula', ['subjectId', 'level']); }

// "المتون" (matnCatalog) — مفهوم منفصل تمامًا عن "المقررات" بطلب صريح من المستخدم: المادة
// الواحدة قد تضم عدة مقررات وعدة متون معًا (وبعض المواد ليس لها متون إطلاقًا) — لا علاقة تبعية
// بين مقرر ومتن، كلاهما تابع لمادة مباشرة فقط. id/name/description/subjectId/level، بنفس بنية
// المقررات حرفيًا. **شيت مختلف تمامًا عن شيت matns الحقيقي** (الأوراد، getMatns أسفل) — تسميته
// matnCatalog عمدًا لتفادي أي تصادم اسم شيت مع matns الموجود مسبقًا وحقيقي (تُقرأ منه بيانات
// التسميع الفعلية). هذا الشيت (matnCatalog) مجرد قائمة/كتالوج أسماء متون لتسهيل اختيارها
// كقائمة منسدلة عند إضافة وِرد (بدل الكتابة الحرة المتكرّرة اليدوية) — القيمة المخزَّنة بعمود
// "الكتاب / المتن" بشيت matns تبقى نصًّا حرًّا كما هي دائمًا (لا معرّفًا)، لأن أنظمة أخرى كثيرة
// (التسميع وغيره) تُطابِقها بالاسم النصي فقط لا بمعرّف — راجع التنبيه أعلى saveMatnsItem بdataPost.js.
function getMatnCatalogList() { return getCurriculumList_('matnCatalog', ['subjectId', 'level']); }

// المذاهب: تُزرَع المذاهب الثلاثة الافتراضية تلقائيًا أول قراءة لو كانت القائمة فارغة تمامًا
// (الشيت أُنشئ فارغًا بجلسة سابقة) — بنفس الأسماء/الأوصاف الثابتة أصلًا بتبويب "المذهب الفقهي"
// ببوابة الطالب (student.html). عمود level (المرحلة/المراحل التي يخص بها هذا المذهب — نص
// مفصول بفاصلة، نفس نمط subjects/curricula تمامًا) يُستخدَم الآن فعليًا: يُحدِّد بوابة الطالب
// (renderMazhabSelection بfuncs-js.html) هل تظهر صفحة "المذهب الفقهي" لهذا الطالب أصلًا (مرحلته
// الحالية تطابق مرحلة مذهب واحد على الأقل)، وأي مذاهب تحديدًا تُعرَض له كخيارات.
function getMadhabsList() {
  var list = getCurriculumList_('madhabs', ['level', 'archived']);
  if (list.length > 0) return list.filter(function (m) { return m.archived !== true; });

  var sh = ensureCurriculumSheet_('madhabs', ['level', 'archived']);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id'), nameCol = headers.indexOf('name'), descCol = headers.indexOf('description'), createdCol = headers.indexOf('createdAt');
  var now = new Date();
  [
    ['المذهب الحنبلي', 'مذهب الإمام أحمد بن حنبل رحمه الله'],
    ['المذهب الشافعي', 'مذهب الإمام محمد بن إدريس الشافعي رحمه الله'],
    ['المذهب المالكي', 'مذهب الإمام مالك بن أنس رحمه الله']
  ].forEach(function (d) {
    var row = new Array(headers.length).fill('');
    row[idCol] = Utilities.getUuid();
    row[nameCol] = d[0];
    row[descCol] = d[1];
    row[createdCol] = now;
    sh.appendRow(row);
  });
  return getCurriculumList_('madhabs', ['level', 'archived']).filter(function (m) { return m.archived !== true; });
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// إحصاءات المسمِّعين (المتعاونون بصلاحية "تسميع") — تُستخدم لمودال بطاقة "التسميع" في صفحة
// المتعاونون. تُجمَّع سجلات motonRates حسب اسم المسؤول (resp، وهو نفسه userData[0].name الذي
// يُكتب مباشرة عند تسجيل كل تسميعة — راجع submitDectation في funcs-js.html)، ثم حسب المتن.
// عمود لكل متن بدل كل ورد على حدة (قرار مقصود: الورد رقم مسلسل داخل كل متن، فقد يتضخّم عدد
// الأعمدة كثيرًا لو اعتُمد كوحدة تجميع مستقلة).
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function getDictationStats(startDate, endDate) {
  var ss = SpreadsheetApp.openById(dectationData);
  var sh = ss.getSheetByName('motonRates');
  if (!sh || sh.getLastRow() < 2) return { matns: [], byName: {} };

  var headers = sh.getRange('1:1').getValues()[0];
  var respCol = headers.indexOf('responsible');
  var matnCol = headers.indexOf('المتن');
  var dateCol = headers.indexOf('طابع زمني');

  var startTime = startDate ? new Date(startDate + 'T00:00:00').getTime() : null;
  var endTime = endDate ? new Date(endDate + 'T23:59:59').getTime() : null;

  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var matnSet = {};
  var byName = {};
  rows.forEach(function (r) {
    var resp = String(r[respCol] || '').trim();
    var matn = String(r[matnCol] || '').trim();
    if (!resp || !matn) return;
    if (startTime !== null || endTime !== null) {
      var d = dateCol > -1 ? new Date(r[dateCol]) : null;
      if (!d || isNaN(d.getTime())) return;
      var t = d.getTime();
      if (startTime !== null && t < startTime) return;
      if (endTime !== null && t > endTime) return;
    }
    matnSet[matn] = true;
    byName[resp] = byName[resp] || {};
    byName[resp][matn] = (byName[resp][matn] || 0) + 1;
  });

  var matns = Object.keys(matnSet).sort(function (a, b) { return a.localeCompare(b, 'ar'); });
  return { matns: matns, byName: byName };
}
