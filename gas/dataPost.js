//////////////////////////////////////////////////////////////////////////////////////////////////////////
// دالة تشخيص مؤقتة: شغّلها يدويًا من المحرر ثم افحص السجل (View > Logs) لمعرفة
// ترتيب أعمدة شيت students الفعلي — لإصلاح newStuReg() الذي يكتب بالموضع الثابت.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function logStudentsHeaders() {
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  headers.forEach(function (h, i) {
    Logger.log((i + 1) + ': ' + h);
  });
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
function setLecAttend(data, lecName) {
  var ss = SpreadsheetApp.openById(mainData);
  var dataSh = ss.getSheetByName('lecAttend');

  // نجيب كل البيانات الحالية
  var values = dataSh.getDataRange().getValues();
  lecName = lecName.replace('(','').replace(')','');

  // نتأكد إذا CPR موجود بالفعل
  var exists = values.some(function(row, i) {
    if (i === 0) return false;
    return cprEquals_(row[2], data.cpr) && row[5] === lecName;
  });

  if (exists) {
    Logger.log('⚠️ تم التسجيل مسبقاً لهذا الطالب: ' + data.name);
    return '⚠️ تم التسجيل مسبقاً';
  }

  // إضافة السجل الجديد
  dataSh.appendRow([
    '', new Date(),
    data.cpr, data.name, data.gender, lecName
  ]);

  Logger.log('✅ تم تسجيل الحضور بنجاح: ' + data.name);
  return 'added';
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// خريطة بحث سريعة cpr → {name, code, level} من شيت الطلاب، مخزَّنة مؤقتًا (CacheService، 30
// دقيقة) بدل قراءة الشيت بالكامل عند كل عملية تحضير — كانت هذه القراءة الكاملة المتكررة (مرة
// لكل مسح QR) هي سبب البطء الملحوظ وقت الزحام (عدة طلاب يُحضّرون تباعًا خلال دقائق). أول
// استدعاء بعد كل 30 دقيقة يبني الخريطة من جديد (قراءة واحدة فقط)، والباقي يقرأ من الكاش مباشرة.
function getStudentLookupMap_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('studentLookupMap_v1');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  var studentSh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = studentSh.getRange('1:1').getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var nameCol = headers.indexOf('name');
  var codeCol = headers.indexOf('code');
  var class0Col = headers.indexOf('class0');
  var class1Col = headers.indexOf('class1');
  var class2Col = headers.indexOf('class2');
  var class3Col = headers.indexOf('class3');

  var map = {};
  if (cprCol > -1 && studentSh.getLastRow() > 1) {
    var allRows = studentSh.getRange(2, 1, studentSh.getLastRow() - 1, studentSh.getLastColumn()).getValues();
    for (var i = 0; i < allRows.length; i++) {
      var row = allRows[i];
      var cpr = normalizeCpr_(row[cprCol]);
      if (!cpr) continue;
      var level = row[class0Col] === 'active' ? 0
        : row[class1Col] === 'active' ? 1
        : row[class2Col] === 'active' ? 2
        : row[class3Col] === 'active' ? 3
        : '';
      map[cpr] = { name: nameCol > -1 ? row[nameCol] : '', code: codeCol > -1 ? row[codeCol] : '', level: level };
    }
  }

  try { cache.put('studentLookupMap_v1', JSON.stringify(map), 1800); } catch (e) {
    // قد تتجاوز مدرسة كبيرة جدًا حد حجم CacheService (100 كيلوبايت) — نتجاهل فشل التخزين المؤقت
    // بأمان ونكتفي ببناء الخريطة من جديد بكل استدعاء بدل تعطّل تسجيل الحضور بالكامل.
  }
  return map;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// يبني مصفوفة صف حضور جاهزة لـappendRow بالاعتماد على اسم كل عمود في رأس الشيت (headers.indexOf)
// حصرًا، بدل مواضع ثابتة مفترَضة كما كانت setAttendQr/addManualAttendance تفعلان سابقًا —
// انكسر التسجيل فعليًا حين أُعيد ترتيب/تسمية أعمدة شيت الحضور يدويًا (resp صار by، وحُذف عمود
// فارغ أول)، فكتبت تلك الدوال كل قيمة بعمود خاطئ بصمت. الرأس الحالي المعتمَد: date/time, id,
// cpr, name, by, level, reason — أي تعديل مستقبلي على ترتيب/تسمية الأعمدة يلزمه تحديث هذه
// الخريطة فقط (nameByKey)، لا كل دالة كتابة على حدة. fields = بعض أو كل مفاتيح nameByKey؛ أي
// مفتاح غائب أو عمود غير موجود بالشيت يُترك فارغًا بأمان دون أي خطأ.
function buildAttendanceRow_(fields, sheet){
  var headers = sheet.getRange('1:1').getValues()[0];
  var row = new Array(headers.length).fill('');
  var nameByKey = { date: 'date/time', id: 'id', cpr: 'cpr', name: 'name', by: 'by', level: 'level', reason: 'reason' };
  Object.keys(nameByKey).forEach(function(key){
    if (!(key in fields)) return;
    var col = headers.indexOf(nameByKey[key]);
    if (col > -1) row[col] = fields[key];
  });
  return row;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// تحضير عبر مسح QR. رموز البطاقات الحالية كلها لا تزال تحمل الاسم والرمز التعريفي مباشرةً، لكن
// نُفضِّل قيم شيت الطلاب (خريطة getStudentLookupMap_) دومًا كمصدر الحقيقة الأدق والمطابق تمامًا
// لما يكتبه التحضير اليدوي — مع بقاء السرعة عالية بفضل التخزين المؤقت أعلاه بدل قراءة كاملة
// لكل مسح. منع التكرار اليومي عبر PropertiesService (بلا انتهاء صلاحية تلقائي، بخلاف
// CacheService المحدود بـ6 ساعات فقط) — مفتاحها لكل طالب لا لكل يوم، فتُستبدَل قيمتها يوميًا.
function setAttendQr(data){

  var lookup = getStudentLookupMap_();
  var info = lookup[normalizeCpr_(data.cpr)];
  var realName = (info && info.name) || data.name || '';
  var realCode = (info && info.code) || data.perId || '';
  var level = info ? info.level : '';

  var props = PropertiesService.getScriptProperties();
  var todayKey = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var propKey = 'attendDay_' + data.cpr;

  if (props.getProperty(propKey) === todayKey) {
    return { status: 'duplicate', message: 'تم تسجيل حضور ' + realName + ' مسبقًا اليوم', studentName: realName };
  }

  var ss =  SpreadsheetApp.openById(attendanceData);
  var dataSh = ss.getSheetByName('attendance');
  ensureAttendanceLevelHeader(dataSh);

  dataSh.appendRow(buildAttendanceRow_({
    date: new Date(), id: realCode, cpr: data.cpr, name: realName, by: data.resp, level: level
  }, dataSh));

  props.setProperty(propKey, todayKey);

  return { status: 'ok', studentName: realName };

}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// جلسات قارئ QR — بطاقة صلاحية قصيرة المدى تُولَّد وتبويب لوحة الإدارة لا يزال نشطًا ومُصادَقًا
// فعليًا (لحظة الضغط على "فتح قارئ QR")، وتُرفَق مع رابط الصفحة الوسيطة على Firebase Hosting.
// كل مسح لاحق يرسل هذه البطاقة مباشرة لـ doPost (راجع code.js) للتحقق منها، دون الحاجة لأي
// اتصال بتبويب لوحة الإدارة إطلاقًا بعد لحظة الفتح — كان الاعتماد على بقاء ذلك التبويب نشطًا (عبر
// postMessage) هو سبب تعطّل التسجيل بعد أول طالب واحد فقط، لأن متصفحات الجوال تُعلّق تنفيذ
// الجافاسكربت في أي تبويب ينتقل للخلفية، وتبويب لوحة الإدارة يبقى بالخلفية طوال جلسة المسح.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function startQrSession(staffName) {
  var token = Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put('qrSession_' + token, JSON.stringify({ name: staffName || '' }), 21600); // الحد الأقصى المسموح لـCacheService: 6 ساعات
  return token;
}

function handleQrAttendRequest_(body) {
  if (!body.token) return { status: 'error', message: 'جلسة غير صالحة، أعد فتح قارئ QR من لوحة الإدارة' };
  var sessionRaw = CacheService.getScriptCache().get('qrSession_' + body.token);
  if (!sessionRaw) return { status: 'error', message: 'انتهت صلاحية الجلسة (6 ساعات)، أعد فتح قارئ QR من لوحة الإدارة' };
  if (!body.cpr) return { status: 'error', message: 'رمز غير صالح' };

  var session;
  try { session = JSON.parse(sessionRaw); } catch (e) { session = {}; }

  return setAttendQr({ cpr: body.cpr, perId: body.perId, name: body.name, resp: session.name || '' });
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * إضافة يوم حضور يدوي للطالب من قبل المشرف. بنفس بنية صف setAttendQr تمامًا الآن: العمود الثالث
 * دومًا الرمز التعريفي الحقيقي للطالب (لا نص "manual")، والتمييز بين "يدوي"/"QR" انتقل لعمود
 * "المسجَّل بواسطة" بدلًا — يحمل النص الحرفي "manual" هنا دومًا (بدل اسم الموظف).
 * payload = { cpr, name, date (ISO string اختياري) }
 * يرجع كائن { ok: true/false, message?: string } لاستخدامه في الواجهة.
 */
function addManualAttendance(payload){
  try{
    payload = payload || {};
    if(!payload.cpr) return { ok:false, message:'الرقم الشخصي (CPR) مطلوب' };

    var when = payload.date ? new Date(payload.date) : new Date();
    if(isNaN(when.getTime())){
      return { ok:false, message:'التاريخ غير صالح' };
    }

    var lookup = getStudentLookupMap_();
    var info = lookup[normalizeCpr_(payload.cpr)];
    var realName = (info && info.name) || payload.name || '';
    var realCode = (info && info.code) || '';
    var level = info ? info.level : '';

    var ss = SpreadsheetApp.openById(attendanceData);
    var dataSh = ss.getSheetByName('attendance');
    ensureAttendanceLevelHeader(dataSh);

    // فحص أولي: هل هذا الطالب مسجّل بالفعل في نفس اليوم؟ (لتفادي التكرار)
    var headers = dataSh.getRange('1:1').getValues()[0];
    var dateCol = headers.indexOf('date/time');
    var cprCol  = headers.indexOf('cpr');
    if(dateCol >= 0 && cprCol >= 0 && dataSh.getLastRow() > 1){
      var allRows = dataSh.getRange(2,1,dataSh.getLastRow()-1,dataSh.getLastColumn()).getValues();
      var tz = ss.getSpreadsheetTimeZone();
      var targetDay = Utilities.formatDate(when, tz, 'dd-MM-yyyy');
      var dup = allRows.some(function(r){
        if(!r[dateCol]) return false;
        var rowDay = Utilities.formatDate(new Date(r[dateCol]), tz, 'dd-MM-yyyy');
        return rowDay === targetDay && (+r[cprCol] === +payload.cpr);
      });
      if(dup){
        return { ok:false, message:'الطالب مسجّل حضوراً في هذا اليوم بالفعل' };
      }
    }

    dataSh.appendRow(buildAttendanceRow_({
      date: when, id: realCode, cpr: payload.cpr, name: realName, by: 'manual', level: level
    }, dataSh));

    return { ok:true };
  }catch(err){
    return { ok:false, message: String(err && err.message || err) };
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * طلب الطالب نفسه (لا الإدارة) إضافة يوم حضور — بحالة "طلب" بانتظار المراجعة، وليس حضورًا فعليًا
 * فورًا: عمود resp يحمل النص الحرفي 'request' (بدل 'manual' أو اسم الموظف)، وعمود reason الجديد
 * يحمل سبب الطلب إلزاميًا. لا يُقبل تاريخ سابق (اليوم أو لاحقًا فقط)، ونفس فحص التكرار على
 * addManualAttendance. تُقبَل/تُرفَض لاحقًا من لوحة الإدارة (acceptAttendanceRequests_/
 * rejectAttendanceRequests_ أدناه).
 * payload = { cpr, name, date, reason }
 */
function requestAttendance(payload){
  try{
    // لا نثق بإخفاء الزر بالواجهة وحده — نتحقق من حالة المفتاح على الخادم أيضًا (شيت main)،
    // حتى لا يبقى الطلب ممكنًا عبر استدعاء مباشر وقت إغلاق الإدارة لهذه الميزة.
    var mainSh = SpreadsheetApp.openById(refID).getSheetByName('main');
    var reqCol = ensureAttendanceRequestsColumn_(mainSh);
    if(!mainSh.getRange(2, reqCol).getValue()) return { ok:false, message:'طلبات إضافة الحضور غير مفعَّلة حاليًا' };

    payload = payload || {};
    if(!payload.cpr) return { ok:false, message:'الرقم الشخصي (CPR) مطلوب' };
    var reason = String(payload.reason || '').trim();
    if(!reason) return { ok:false, message:'سبب الإضافة مطلوب' };

    var when = payload.date ? new Date(payload.date) : new Date();
    if(isNaN(when.getTime())) return { ok:false, message:'التاريخ غير صالح' };

    var lookup = getStudentLookupMap_();
    var info = lookup[normalizeCpr_(payload.cpr)];
    var realName = (info && info.name) || payload.name || '';
    var realCode = (info && info.code) || '';
    var level = info ? info.level : '';

    var ss = SpreadsheetApp.openById(attendanceData);
    var dataSh = ss.getSheetByName('attendance');
    ensureAttendanceLevelHeader(dataSh);
    ensureAttendanceReasonHeader_(dataSh);

    var tz = ss.getSpreadsheetTimeZone();
    var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var targetStr = Utilities.formatDate(when, tz, 'yyyy-MM-dd');
    if(targetStr > todayStr) return { ok:false, message:'لا يمكن اختيار تاريخ مستقبلي' };

    var headers = dataSh.getRange('1:1').getValues()[0];
    var dateCol = headers.indexOf('date/time');
    var cprCol = headers.indexOf('cpr');

    // فحص التكرار: هل يوجد بالفعل سجل حضور أو طلب لنفس الطالب بنفس اليوم؟
    if(dataSh.getLastRow() > 1){
      var allRows = dataSh.getRange(2,1,dataSh.getLastRow()-1,dataSh.getLastColumn()).getValues();
      var targetDay = Utilities.formatDate(when, tz, 'dd-MM-yyyy');
      var dup = allRows.some(function(r){
        if(!r[dateCol]) return false;
        var rowDay = Utilities.formatDate(new Date(r[dateCol]), tz, 'dd-MM-yyyy');
        return rowDay === targetDay && (+r[cprCol] === +payload.cpr);
      });
      if(dup) return { ok:false, message:'يوجد سجل حضور أو طلب بهذا التاريخ بالفعل' };
    }

    dataSh.appendRow(buildAttendanceRow_({
      date: when, id: realCode, cpr: payload.cpr, name: realName, by: 'request', level: level, reason: reason
    }, dataSh));

    return { ok:true };
  }catch(err){
    return { ok:false, message: String(err && err.message || err) };
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// تضيف عنوان عمود "level" لشيت الحضور إن لم يكن موجودًا بعد (عمود سابع جديد) — تنفيذ آمن يُعاد
// بلا أي أثر إضافي لو استُدعي مرارًا (idempotent)، فلا حاجة لتعديل الشيت يدويًا مرة واحدة مسبقًا.
function ensureAttendanceLevelHeader(dataSh) {
  var headers = dataSh.getRange('1:1').getValues()[0];
  if (headers.indexOf('level') > -1) return;
  var lastCol = dataSh.getLastColumn() || 6;
  dataSh.getRange(1, lastCol + 1).setValue('level');
}

// تضيف عنوان عمود "reason" لشيت الحضور إن لم يكن موجودًا بعد (لسبب طلبات الحضور من الطلاب) —
// idempotent بنفس نمط ensureAttendanceLevelHeader أعلاه.
function ensureAttendanceReasonHeader_(dataSh) {
  var headers = dataSh.getRange('1:1').getValues()[0];
  if (headers.indexOf('reason') > -1) return;
  var lastCol = dataSh.getLastColumn() || 7;
  dataSh.getRange(1, lastCol + 1).setValue('reason');
}

// يبني خريطة {cpr_dd-MM-yyyy: true} من items=[{cpr,date}] — نفس مفتاح المطابقة تستخدمه
// acceptAttendanceRequests و rejectAttendanceRequests أدناه لتحديد صفوف الطلبات المطلوبة
// بدل الاعتماد على رقم صف قد يتغيّر بين القراءة والكتابة.
function buildAttendanceRequestKeys_(items, tz){
  var wanted = {};
  (items || []).forEach(function(it){
    var d = new Date(it.date);
    if(isNaN(d.getTime())) return;
    wanted[(+it.cpr) + '_' + Utilities.formatDate(d, tz, 'dd-MM-yyyy')] = true;
  });
  return wanted;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * قبول طلبات حضور محدَّدة دفعة واحدة: يحوّل عمود resp من 'request' إلى اسم الموظف الذي قَبِل
 * الطلب (فيصبح السجل حضورًا فعليًا فورًا، بنفس تاريخه ورمز الطالب كما هما).
 * items = [{cpr, date}] بنفس القيم المُعادة من getAttendanceRequests.
 */
function acceptAttendanceRequests(adminName, items){
  try{
    if(!Array.isArray(items) || items.length === 0) return { ok:false, message:'لم يتم تحديد أي طلب' };

    var ss = SpreadsheetApp.openById(attendanceData);
    var dataSh = ss.getSheetByName('attendance');
    var headers = dataSh.getRange('1:1').getValues()[0];
    var dateCol = headers.indexOf('date/time');
    var cprCol = headers.indexOf('cpr');
    var byCol = headers.indexOf('by');
    if (byCol === -1) return { ok:false, message:'تعذّر تحديد عمود "by" بشيت الحضور' };

    var lastRow = dataSh.getLastRow();
    if(lastRow < 2) return { ok:false, message:'لا توجد طلبات' };

    var tz = ss.getSpreadsheetTimeZone();
    var wanted = buildAttendanceRequestKeys_(items, tz);
    var allRows = dataSh.getRange(2, 1, lastRow - 1, dataSh.getLastColumn()).getValues();

    var acceptedCount = 0;
    allRows.forEach(function(r, i){
      if(r[byCol] !== 'request' || !r[dateCol]) return;
      var key = (+r[cprCol]) + '_' + Utilities.formatDate(new Date(r[dateCol]), tz, 'dd-MM-yyyy');
      if(!wanted[key]) return;
      dataSh.getRange(i + 2, byCol + 1).setValue(adminName || 'الإدارة');
      acceptedCount++;
    });

    if(acceptedCount === 0) return { ok:false, message:'لم يتم العثور على الطلبات المحدَّدة' };
    return { ok:true, acceptedCount: acceptedCount };
  }catch(err){
    return { ok:false, message: String(err && err.message || err) };
  }
}

/**
 * رفض طلبات حضور محدَّدة دفعة واحدة: حذف الصفوف المطابقة فعليًا (لم تكن حضورًا فعليًا أصلًا،
 * فلا داعي للاحتفاظ بها). items = [{cpr, date}] بنفس شكل acceptAttendanceRequests أعلاه.
 */
function rejectAttendanceRequests(items){
  try{
    if(!Array.isArray(items) || items.length === 0) return { ok:false, message:'لم يتم تحديد أي طلب' };

    var ss = SpreadsheetApp.openById(attendanceData);
    var dataSh = ss.getSheetByName('attendance');
    var headers = dataSh.getRange('1:1').getValues()[0];
    var dateCol = headers.indexOf('date/time');
    var cprCol = headers.indexOf('cpr');
    var byCol = headers.indexOf('by');
    if (byCol === -1) return { ok:false, message:'تعذّر تحديد عمود "by" بشيت الحضور' };

    var lastRow = dataSh.getLastRow();
    if(lastRow < 2) return { ok:false, message:'لا توجد طلبات' };

    var tz = ss.getSpreadsheetTimeZone();
    var wanted = buildAttendanceRequestKeys_(items, tz);
    var allRows = dataSh.getRange(2, 1, lastRow - 1, dataSh.getLastColumn()).getValues();

    var rowsToDelete = [];
    allRows.forEach(function(r, i){
      if(r[byCol] !== 'request' || !r[dateCol]) return;
      var key = (+r[cprCol]) + '_' + Utilities.formatDate(new Date(r[dateCol]), tz, 'dd-MM-yyyy');
      if(!wanted[key]) return;
      rowsToDelete.push(i + 2);
    });

    if(rowsToDelete.length === 0) return { ok:false, message:'لم يتم العثور على الطلبات المحدَّدة' };

    // نحذف من الأسفل للأعلى حتى لا يتغيّر ترقيم الصفوف المتبقية أثناء الحذف
    rowsToDelete.sort(function(a,b){ return b - a; });
    rowsToDelete.forEach(function(rowIndex){ dataSh.deleteRow(rowIndex); });

    return { ok:true, rejectedCount: rowsToDelete.length };
  }catch(err){
    return { ok:false, message: String(err && err.message || err) };
  }
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
/**
 * حذف سجل (سجلات) حضور طالب معيّن في يوم معيّن. يحذف كل الصفوف المطابقة دفعة واحدة، وهو ما
 * يعالج أيضًا حالة الصفوف المكرَّرة (لو تكرر مسح QR لنفس الطالب في نفس اليوم قبل تفعيل منع التكرار).
 * يرجع كائن { ok: true/false, deletedCount?, message? }.
 */
function deleteAttendance(cpr, dateStr){
  try{
    if(!cpr) return { ok:false, message:'الرقم الشخصي (CPR) مطلوب' };

    var when = dateStr ? new Date(dateStr) : new Date();
    if(isNaN(when.getTime())){
      return { ok:false, message:'التاريخ غير صالح' };
    }

    var ss = SpreadsheetApp.openById(attendanceData);
    var dataSh = ss.getSheetByName('attendance');
    var headers = dataSh.getRange('1:1').getValues()[0];
    var dateCol = headers.indexOf('date/time');
    var cprCol  = headers.indexOf('cpr');

    if(dataSh.getLastRow() < 2) return { ok:false, message:'لا يوجد سجل مطابق' };

    var allRows = dataSh.getRange(2, 1, dataSh.getLastRow() - 1, dataSh.getLastColumn()).getValues();
    var tz = ss.getSpreadsheetTimeZone();
    var targetDay = Utilities.formatDate(when, tz, 'dd-MM-yyyy');

    var rowsToDelete = [];
    allRows.forEach(function(r, i){
      if(!r[dateCol]) return;
      var rowDay = Utilities.formatDate(new Date(r[dateCol]), tz, 'dd-MM-yyyy');
      if(rowDay === targetDay && (+r[cprCol] === +cpr)){
        rowsToDelete.push(i + 2); // +2: تعويض صف العناوين، وبداية ترقيم صفوف الشيت من 1
      }
    });

    if(rowsToDelete.length < 1) return { ok:false, message:'لم يتم العثور على سجل مطابق' };

    // نحذف من الأسفل للأعلى حتى لا يتغيّر ترقيم الصفوف المتبقية أثناء الحذف
    rowsToDelete.sort(function(a,b){ return b - a; });
    rowsToDelete.forEach(function(rowIndex){ dataSh.deleteRow(rowIndex); });

    return { ok:true, deletedCount: rowsToDelete.length };
  }catch(err){
    return { ok:false, message: String(err && err.message || err) };
  }
}

// استبيان الطلاب (قبل الاختبار: المادة/المحاضر/إدارة الأكاديمية — بعد الاختبار: صعوبة
// الاختبار/وضوح الأسئلة) — استبانة عامة واحدة لكل نوع تتكرر قبل/بعد كل اختبار (وليست
// مخصَّصة لكل اختبار على حدة)، إلزامية (بوابة لا يمكن تخطّيها) من طرف العميل
// (showPreExamSurveyGate/showPostExamSurveyGate بـsurvey-js.html). الإجابات مربوطة بهوية
// الطالب (cpr) صراحة — ليست مجهولة. كل تعبئة صف مستقل جديد (بلا تحديث/استبدال لاحق)، بنفس
// Spreadsheet نتائج الاختبارات (answersData) لا refID، لأنها بيانات ناتجة عن أداء/تجربة
// الطالب لا إعداد اختبار.
// الأعمدة الأساسية ثابتة الترتيب، وأعمدة تقييمات الأسئلة (rating_key لكل سؤال معرَّف بـ
// SURVEY_PRE_GROUPS_/SURVEY_PRE_STANDALONE_/SURVEY_POST_STANDALONE_ بcode.js) تُضاف تلقائيًا
// بالنهاية فقط عند أول استخدام لسؤال جديد، بلا لمس أي عمود موجود ولا ترتيبه — الأعمدة الأربعة
// الأصلية (rating_subject/rating_lecturer/rating_difficulty/rating_quality) تبقى محفوظة
// لبيانات الردود القديمة فقط ولم تعد تُكتَب من هنا بعد توسعة الأسئلة لعشرة/أربعة عناصر.
function ensureSurveysSheet_() {
  var ss = SpreadsheetApp.openById(answersData);
  var sh = ss.getSheetByName('surveys');
  var allKeys = surveyPreFieldDefs_().concat(surveyPostFieldDefs_()).map(function (f) { return f.key; });
  if (!sh) {
    sh = ss.insertSheet('surveys');
    var headers = ['id', 'cpr', 'name', 'exam', 'level', 'type']
      .concat(allKeys.map(function (k) { return 'rating_' + k; }))
      .concat(['comment', 'submittedAt']);
    sh.appendRow(headers);
    return sh;
  }
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  allKeys.forEach(function (k) {
    var col = 'rating_' + k;
    if (headers.indexOf(col) === -1) { sh.getRange(1, sh.getLastColumn() + 1).setValue(col); headers.push(col); }
  });
  return sh;
}

function submitExamSurvey(cpr, name, examName, level, type, ratings, comment) {
  cpr = normalizeCpr_(cpr);
  if (!cpr) return { error: true, message: 'رقم شخصي غير صالح' };
  if (type !== 'pre' && type !== 'post') return { error: true, message: 'نوع استبيان غير صالح' };

  var fieldDefs = type === 'pre' ? surveyPreFieldDefs_() : surveyPostFieldDefs_();
  ratings = ratings || {};
  var values = {};
  for (var i = 0; i < fieldDefs.length; i++) {
    var key = fieldDefs[i].key;
    var v = parseInt(ratings[key], 10);
    if (!isFinite(v) || v < 1 || v > 5) return { error: true, message: 'يلزم تقييم كل عناصر الاستبيان (من 1 إلى 5)' };
    values[key] = v;
  }

  try {
    var sh = ensureSurveysSheet_();
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var row = headers.map(function () { return ''; });
    var setCol = function (name, val) { var idx = headers.indexOf(name); if (idx !== -1) row[idx] = val; };
    setCol('id', Utilities.getUuid());
    setCol('cpr', cpr);
    setCol('name', name || '');
    setCol('exam', examName || '');
    setCol('level', level);
    setCol('type', type);
    fieldDefs.forEach(function (f) { setCol('rating_' + f.key, values[f.key]); });
    setCol('comment', String(comment || '').trim());
    setCol('submittedAt', new Date());
    sh.appendRow(row);
    return { ok: true };
  } catch (err) {
    return { error: true, message: String(err) };
  }
}

// هل سبق للطالب إجابة استبيان "قبل الاختبار" لنفس الاختبار (بعد تحويل مذهب الفقه إن وُجد،
// نفس branch المُرسَل من startExamFromBtn) والمرحلة تحديدًا؟ تُستدعى من #iqrarBtn (js.html) قبل
// عرض بوابة الاستبيان — لو true تُتخطَّى البوابة تمامًا، حتى لو لم تكن هناك جلسة نشطة حاليًا
// (مثلًا: طالب أجاب الاستبيان ثم حُظر بدء الاختبار لسبب آخر ولم تُنشَأ جلسة أصلًا، فلا يجوز
// إجباره على تكرار الاستبيان لمجرد عدم وجود جلسة نشطة — راجع مناقشات.md).
function hasSubmittedPreExamSurvey(cpr, examName, level) {
  cpr = normalizeCpr_(cpr);
  if (!cpr || !examName) return false;
  var sh = ensureSurveysSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr'), examCol = headers.indexOf('exam'),
    levelCol = headers.indexOf('level'), typeCol = headers.indexOf('type');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return false;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return rows.some(function (r) {
    return r[typeCol] === 'pre' && r[examCol] === examName && String(r[levelCol]) === String(level) &&
      normalizeCpr_(r[cprCol]) === cpr;
  });
}

// عملية تكييف — تُشغَّل يدويًا مرة واحدة فقط من محرر Apps Script (اختر migrateSurveyLegacyRatings
// من القائمة المنسدلة أعلى المحرر، ثم اضغط Run) — لا تُستدعى من الواجهة إطلاقًا. تنقل بيانات
// الردود القديمة (السؤال الواحد لكل من المادة/المحاضر، واستبيان الاختبار بسؤالين) إلى بنية
// الأسئلة الفرعية الجديدة (SURVEY_PRE_GROUPS_/SURVEY_POST_STANDALONE_ بcode.js):
//   - لكل صف "pre" قديم: قيمة rating_subject تُنسَخ لكل الأسئلة الفرعية الخمسة عن "المادة
//     المقررة"، وقيمة rating_lecturer تُنسَخ لكل الأسئلة الفرعية الأربعة عن "المحاضر".
//     (rating_admin لم يتغيّر — نفس العمود قبل وبعد التوسعة، فلا حاجة لنقله.)
//   - لكل صف "post" قديم: متوسط rating_difficulty وrating_quality (مقرَّب لأقرب عدد صحيح
//     1-5) يُنسَخ لكل الأسئلة الأربعة الجديدة عن الاختبار.
// آمنة التكرار: أي عمود جديد بصف مُعبَّأ بالفعل (سواء من تشغيل سابق لهذه الدالة، أو من ردٍّ
// حقيقي جديد وصل بالبنية الجديدة مباشرة) لا يُكتَب فوقه أبدًا — فقط الفراغات تُملأ. الأعمدة
// القديمة نفسها لا تُلمَس ولا تُحذف، تبقى محفوظة كمرجع تاريخي.
function migrateSurveyLegacyRatings() {
  var sh = ensureSurveysSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) { Logger.log('لا توجد صفوف بشيت surveys بعد.'); return; }

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = function (name) { return headers.indexOf(name); };
  var typeCol = col('type');
  var oldSubjectCol = col('rating_subject'), oldLecturerCol = col('rating_lecturer'),
    oldDifficultyCol = col('rating_difficulty'), oldQualityCol = col('rating_quality');

  var isFilled = function (v) { return v !== '' && v !== null && v !== undefined; };
  var subjectCols = ['subject_need', 'subject_difficulty', 'subject_society_need', 'subject_added_value', 'subject_size'].map(function (k) { return col('rating_' + k); });
  var lecturerCols = ['lecturer_adherence', 'lecturer_style', 'lecturer_time', 'lecturer_communication'].map(function (k) { return col('rating_' + k); });
  var examCols = ['exam_level', 'exam_length', 'exam_comprehensiveness', 'exam_clarity'].map(function (k) { return col('rating_' + k); });

  var range = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn());
  var data = range.getValues();
  var migratedPre = 0, migratedPost = 0, skipped = 0;

  data.forEach(function (row) {
    if (row[typeCol] === 'pre') {
      if (subjectCols.concat(lecturerCols).every(function (c) { return isFilled(row[c]); })) { skipped++; return; }
      var subjectVal = row[oldSubjectCol], lecturerVal = row[oldLecturerCol];
      if (isFilled(subjectVal)) subjectCols.forEach(function (c) { if (!isFilled(row[c])) row[c] = subjectVal; });
      if (isFilled(lecturerVal)) lecturerCols.forEach(function (c) { if (!isFilled(row[c])) row[c] = lecturerVal; });
      migratedPre++;
    } else if (row[typeCol] === 'post') {
      if (examCols.every(function (c) { return isFilled(row[c]); })) { skipped++; return; }
      var vals = [row[oldDifficultyCol], row[oldQualityCol]].filter(function (v) { return isFilled(v) && isFinite(+v); }).map(Number);
      if (vals.length) {
        var avg = Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
        examCols.forEach(function (c) { if (!isFilled(row[c])) row[c] = avg; });
      }
      migratedPost++;
    }
  });

  range.setValues(data);
  Logger.log('تم تكييف ' + migratedPre + ' صفًا من استبانة ما قبل الاختبار، و' + migratedPost + ' صفًا من استبانة ما بعد الاختبار. تم تخطي ' + skipped + ' صف مكيَّف مسبقًا (أو بلا بيانات قديمة أصلًا).');
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// المسار الحالي: لا يستقبل من العميل إلا cpr + session_id + الإجابات. هوية الاختبار والمذهب
// والمرحلة والمدة موجودة في سجل الجلسة الدائم ولا يُوثَق بأي قيمة بديلة من المتصفح.
function submitAnswerData(cpr, data, sessionId) {
  return submitExamSessionAnswers_(cpr, sessionId, data);
}

// محفوظ مؤقتًا كمرجع لترحيل الصيغة القديمة، وغير مستدعًى من الواجهة.
function submitAnswerDataLegacy_(cpr,data, branch, level, name, gender, phone){
  /* 
    cpr = 850839092;
    branch = 'المذهب الحنبلي';
    data = ['{فَقَدْ ضَلَّ ضَلالًا بَعيدًا} (ضلالًا): هنا منصوبة على أنها:%مفعول مطلق','(الياء) ليست علامة للنصب في:%المثنى','نائب الفاعل هو في الأصل:%مفعول به حذف فاعله وأقيم مقامه','إذا كان النعت منصوبًا فإن المنعوت يكون:%مجرورا','(جاء غلامي) {غلامي}: فاعل مرفوع بضمة مقدرة منع من ظهورها:%التعذر','فعل الأمر مبني على حذف النون إذا:%إذا كان معتل الأخر','من علامات الفعل المضارع التي تميزه عن غيره:%قبول دخول السين أو سوف عليه','المنادى من حيث إعرابه:%نوعان','{لِيُنْفِق ذو سَعَةٍ مِنْ سَعَتِه} (ينفق): %فعل مجزوم بالسكون','(رأيته يذاكر ثم لم يذاكر ولن يذاكر) الفعل {يذاكر} هنا -------- لتغيُّر آخره بتغير العوامل الداخلة عليه%معرب','من ألقاب الإعراب:%النصب','(أينما) تجزم: %فعلا واحدا','من علامات الاسم أن يكون في آخره:%تنوين','الكلام التام في باب الاستثناء هو:%ما كان مكونا من مبتدأ وخبر','الحروف كلها:%لها معنى في نفسها','تكون (الألف) علامة للنصب في:%الأسماء الخمسة','المفعول معه هو اسم:%منصوب','نستطيع أن نركب كلامًا مفيدًا من:%الأفعال فقط.','المؤكِّد يتبع المؤكَّد في:%ابتدائه وانتهائه','حروف القَسَم من حروف الخفض.%خطأ','إذا كان الخبر جملة فإما أن تكون:%جملة اسمية أو فعلية','(التاء) التي تكون علامة للفعل هي:%تاء التأنيث مطلقا','(الفتحة) علامة للخفض في:%جمع المؤنث السالم','"المحمَّدون وقَّافون عند حدود الله" تعرب كلمتا (المحمدون) و(وقّافون) على أنهما مرفوعتان وعلامة الرفع:%الواو لأن كُلا منهما جمع مذكر سالم','كلمة دلّت على معنى في غيرها:%الحرف'];
  */

  // مفتاح الجلسة يُبنى بـbranch الأصلي (قبل تحويل "الفقه" أدناه) لأن getQuestions خزّنها بنفس
  // القيمة الأصلية (اسم المذهب المحدَّد، لا "الفقه" العام).
  var cache = CacheService.getScriptCache();
  var sessionKey = examSessionKey_(cpr, branch, level);
  var cachedSession = cache.get(sessionKey);
  if (!cachedSession) {
    return { ok: false, reason: 'no-session' };
  }
  var session = JSON.parse(cachedSession);

  if (Date.now() > session.endTime + 30000) { // هامش سماح 30 ثانية لتأخر الشبكة عند الإرسال
    return { ok: false, reason: 'time-expired' };
  }

  // 🧮 التصحيح الكامل يتم هنا على الخادم اعتمادًا على أسئلة الجلسة المخزَّنة (مع الإجابة الصحيحة)
  // — لا يُوثَق بأي درجة أو نتيجة تصحيح قادمة من العميل.
  var resultMap = {};
  session.questions.forEach(function(q){ resultMap[q.question] = q; });

  var correctCount = 0;
  var results = [];
  data.forEach(function(entry){
    var sep = entry.indexOf('%');
    var ques = entry.substring(0, sep);
    var userAnswer = entry.substring(sep + 1);
    var qObj = resultMap[ques];
    if (!qObj) return;
    var trueAnswer = qObj.answers[qObj.trueAnswer - 1];
    var correct = trueAnswer.toString() === userAnswer.toString();
    if (correct) correctCount++;
    results.push({ question: ques, trueAnswer: trueAnswer, userAnswer: userAnswer, correct: correct });
  });

  var totalCount = data.length;
  var degree = totalCount > 0 ? Number(((correctCount / totalCount) * 100).toFixed(2)) : 0;

  branch.includes('المذهب') ? branch = 'الفقه' : null;

  var ss = SpreadsheetApp.openById(answersData);
  var sheet = ss.getSheetByName('answers');
  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var cprCol = headers.indexOf('cpr');
  var branchCol = headers.indexOf('exam');
  var statusCol = headers.indexOf('rate');

  var rate = degree >= 90 ? 'ممتاز'
    : degree >= 80 ? 'جيّد جدًا'
    : degree >= 70 ? 'جيّد'
    : degree >= 50 ? 'مقبول'
    : 'راسب';

  var newRow = ['', new Date(), cpr, name, gender, phone, branch, level, '', degree, rate, '', ...data];

  // البحث مرة واحدة
  var rowIndex = allData.findIndex((row, i) =>
    i > 0 && row[cprCol] == cpr && row[branchCol] == branch
  );

  // إظهار مراجعة الإجابات (سؤالًا سؤالًا مع الإجابة الصحيحة) بتحكم إداري صريح لكل اختبار
  // (showAnswerReview بشيت rules) — إن كانت false يُحذَف results من الاستجابة كليًا هنا خادميًا،
  // لا يُكتفى بإخفاء زر المراجعة بالواجهة فقط (نفس مبدأ عدم إرسال الإجابة الصحيحة أصلًا لو
  // المراجعة غير مسموحة، كما في getQuestions).
  var showReview = examShowsAnswerReview_(branch, level);
  var response = { ok: true, degree: degree, rate: rate, results: showReview ? results : [], showReview: showReview, correctCount: correctCount, totalCount: totalCount };

  if (rowIndex > -1) {
    // موجود CPR + Branch
    if (allData[rowIndex][statusCol] == 'راسب') {
      // إعادة المحاولة بعد الرسوب باتت بتحكم إداري صريح لكل اختبار (retakeOpen بشيت rules)، لا
      // مهلة زمنية ثابتة — مغلقة افتراضيًا ما لم يفتحها الإداري صراحةً من صفحة إدارة الاختبارات.
      var retakeMap = getExamRetakeMap_();
      if (retakeMap[branch + '|' + level] !== true) {
        return { ok: false, reason: 'retake-closed' };
      }
      // الإعادة مفتوحة → يُسمح بمحاولة جديدة، تستبدل الصف القديم
      sheet.getRange(rowIndex + 1, 1, 1, newRow.length).setValues([newRow]);
      cache.remove(sessionKey);
      return response;
    } else {
      // تقييم مختلف (نجح مسبقًا أو حالة أخرى) → يُمنع التكرار
      return { ok: false, reason: 'already-recorded' };
    }

  } else {
    // غير موجود → إضافة صف
    sheet.appendRow(newRow);
    cache.remove(sessionKey);
    return response;
  }

}
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function submitDectationData(data){

  var ss = SpreadsheetApp.openById(dectationData);
  var dataSh = ss.getSheetByName('motonRates');
  var headers = dataSh.getRange(1, 1, 1, dataSh.getLastColumn()).getValues()[0];

  var now = new Date();
  var tz = ss.getSpreadsheetTimeZone();

  // "code": نسخة رقمية (الرقم التسلسلي للتاريخ) من الطابع الزمني — نفس ما كانت المعادلة القديمة بترجعه
  var y = Number(Utilities.formatDate(now, tz, 'yyyy'));
  var mo = Number(Utilities.formatDate(now, tz, 'MM'));
  var d = Number(Utilities.formatDate(now, tz, 'dd'));
  var h = Number(Utilities.formatDate(now, tz, 'HH'));
  var mi = Number(Utilities.formatDate(now, tz, 'mm'));
  var s = Number(Utilities.formatDate(now, tz, 'ss'));
  var sheetsEpoch = Date.UTC(1899, 11, 30);
  var code = (Date.UTC(y, mo - 1, d, h, mi, s) - sheetsEpoch) / 86400000;

  // الجنس: من شيت الطلاب الأساسي (mainData) بمطابقة cpr
  var gender = '';
  var stSh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var stHeaders = stSh.getRange(1, 1, 1, stSh.getLastColumn()).getValues()[0];
  var stCprCol = stHeaders.indexOf('cpr');
  var stGenderCol = stHeaders.indexOf('gender');
  var stRow = stSh.getRange(2, 1, stSh.getLastRow() - 1, stSh.getLastColumn()).getValues()
    .find(function (r) { return cprEquals_(r[stCprCol], data.stCpr); });
  if (stRow) gender = stRow[stGenderCol];

  // level: من شيت matns (refID) بمطابقة اسم المتن
  var level = '';
  var matnsSh = SpreadsheetApp.openById(refID).getSheetByName('matns');
  var matnsHeaders = matnsSh.getRange(1, 1, 1, matnsSh.getLastColumn()).getValues()[0];
  var matnsMatnCol = matnsHeaders.indexOf('الكتاب / المتن');
  var matnsLevelCol = matnsHeaders.indexOf('المستوى');
  var matnsRow = matnsSh.getRange(2, 1, matnsSh.getLastRow() - 1, matnsSh.getLastColumn()).getValues()
    .find(function (r) { return r[matnsMatnCol] === data.matn; });
  if (matnsRow) level = matnsRow[matnsLevelCol];

  var valuesByHeader = {
    'طابع زمني': now,
    'اسم الطالب': data.stName,
    'المتن': data.matn,
    'الورد': data.werd,
    'الدرجة': data.degree,
    'student_Cpr': data.stCpr,
    'responsible': data.resp,
    'code': code,
    'الجنس': gender,
    'level': level,
  };

  var newRow = headers.map(function (h) {
    return valuesByHeader.hasOwnProperty(h) ? valuesByHeader[h] : '';
  });

  dataSh.appendRow(newRow);

}

// setMoqarrarat/deleteMoqarrarat القديمتان (بلا تحقق صلاحية، كتابة بمواقع أعمدة ثابتة) حُذفتا
// من هنا — استُبدلتا بـsaveMatnsItem/deleteMatnsItem (بجانب دوال "إدارة المواد" — راجع
// مناقشات.md "دمج إدارة المقررات") بعد إلغاء الصفحة المستقلة القديمة التي كانتا المستهلك
// الوحيد لهما.

/* ==========================================================================
   حفظ/حذف محاضرة — شيت "ref" داخل attendanceData (راجع dataGet.js:
   ensureLecturesRefSheet_/getLecturesRef). نفس مبدأ saveMatnsItem/deleteMatnsItem
   بالأعلى بالضبط: قراءة/كتابة بأسماء الأعمدة دومًا، id كمعرّف فريد حصري (رقم الدرس نفسه غير
   كافٍ، ممكن يتكرر عبر مواد/مراحل مختلفة). بلا شرطة سفلية بآخر اسمَي الدالتين عمدًا:
   google.script.run من العميل لا يستطيع استدعاء دالة خادم اسمها ينتهي بشرطة سفلية.
   ========================================================================== */
function saveLectureRef(id, formData) {
  formData = formData || {};
  var lesson = String(formData.lesson || '').trim();
  var subject = String(formData.subject || '').trim();
  var lecturer = String(formData.lecturer || '').trim();
  var date = String(formData.date || '').trim();
  // مصفوفة أسماء مراحل حقيقية (التأهيلية/...) — درس واحد ممكن يخص أكثر من مرحلة الآن،
  // تُخزَّن بفاصلة واحدة داخل نفس الخلية (راجع getLecturesRef في dataGet.js للقراءة العكسية)
  var levels = (Array.isArray(formData.level) ? formData.level : [formData.level])
    .map(function (l) { return String(l || '').trim(); })
    .filter(Boolean);

  if (!date) return { ok: false, message: 'يرجى إدخال تاريخ المحاضرة.' };
  if (!lesson) return { ok: false, message: 'يرجى إدخال اسم الدرس.' };
  if (!subject) return { ok: false, message: 'يرجى إدخال المادة.' };
  if (levels.length === 0) return { ok: false, message: 'يرجى اختيار مرحلة واحدة على الأقل.' };
  if (!lecturer) return { ok: false, message: 'يرجى اختيار المحاضر.' };

  var sh = ensureLecturesRefSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');

  var rowByName = {
    'lesson no': formData.lessonNumber === '' || formData.lessonNumber === undefined ? '' : formData.lessonNumber,
    'date': date,
    'lesson': lesson,
    'subject': subject,
    'stage': levels.join(', '),
    'lecturer': lecturer
  };
  var rowValues = headers.map(function (h) { return rowByName.hasOwnProperty(h) ? rowByName[h] : ''; });

  if (id) {
    var lastRow = sh.getLastRow();
    var rowIndex = lastRow >= 2 ? sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues().flat().indexOf(id) : -1;
    if (rowIndex === -1) return { ok: false, message: 'تعذّر العثور على هذه المحاضرة، ربما حُذفت بالفعل.' };
    rowValues[idCol] = id;
    sh.getRange(rowIndex + 2, 1, 1, rowValues.length).setValues([rowValues]);
    return { ok: true, id: id };
  }

  var newId = Utilities.getUuid();
  rowValues[idCol] = newId;
  sh.appendRow(rowValues);
  return { ok: true, id: newId };
}

function deleteLectureRef(id) {
  if (!id) return { ok: false, message: 'معرّف غير صالح.' };
  var sh = ensureLecturesRefSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, message: 'تعذّر العثور على هذه المحاضرة.' };

  var rowIndex = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues().flat().indexOf(id);
  if (rowIndex === -1) return { ok: false, message: 'تعذّر العثور على هذه المحاضرة، ربما حُذفت بالفعل.' };

  sh.deleteRow(rowIndex + 2);
  return { ok: true };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// إدارة المواد/المقررات/المذاهب — حفظ/حذف عامّان تخدمان الثلاث قوائم البسيطة معًا
// (getSubjectsList/getCurriculaList/getMadhabsList بdataGet.js — جميعها بنفس بنية
// id/name/description، مع extraCols إضافية عند الحاجة). "الأوراد" وحدها **لا** تستخدم هاتين
// الدالتين — مربوطة مباشرة بشيت matns الحقيقي عبر saveMatnsItem/deleteMatnsItem
// (أسفل) لأن بنيتها مختلفة تمامًا (كتاب/متن+وِرد+مدى، لا اسم/وصف عامّين). الأوراد مبنية على
// المقررات (متن الوِرد = اسم المقرر نصًّا) وليست هي نفسها المقررات — راجع مناقشات.md
// "تصحيح مفهوم المقررات/الأوراد" للتصحيح الكامل.
// manage=true فقط (hasExamPermission.isAdmin — إعادة استخدام نفس فحص "الإدارة" العام، لا
// علاقة خاصة بالاختبارات هنا). راجع مناقشات.md "إدارة المواد"/"دمج إدارة المقررات" للسياق الكامل.
function saveCurriculumItem_(sheetName, extraCols, userCpr, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var name = String(item.name || '').trim();
  if (!name) return { error: true, message: 'الاسم مطلوب' };

  var sh = ensureCurriculumSheet_(sheetName, extraCols);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();

  var rowValues = {};
  headers.forEach(function (h, i) {
    if (h === 'id' || h === 'createdAt' || h === 'name') return;
    if (h === 'updatedBy') { rowValues[i] = userCpr; return; }
    if (h === 'updatedAt') { rowValues[i] = new Date(); return; }
    rowValues[i] = item[h] !== undefined ? item[h] : '';
  });
  rowValues[headers.indexOf('name')] = name;

  var existingRowNum = -1;
  if (item.id) {
    var ids = lastRow > 1 ? sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues() : [];
    for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]) === String(item.id)) { existingRowNum = i + 2; break; } }
  }

  var id = item.id || Utilities.getUuid();
  if (existingRowNum > -1) {
    var fullRow = sh.getRange(existingRowNum, 1, 1, headers.length).getValues()[0];
    Object.keys(rowValues).forEach(function (colIdx) { fullRow[+colIdx] = rowValues[colIdx]; });
    sh.getRange(existingRowNum, 1, 1, fullRow.length).setValues([fullRow]);
  } else {
    var newRow = new Array(headers.length).fill('');
    Object.keys(rowValues).forEach(function (colIdx) { newRow[+colIdx] = rowValues[colIdx]; });
    newRow[idCol] = id;
    newRow[headers.indexOf('createdAt')] = new Date();
    sh.appendRow(newRow);
  }
  return { ok: true, id: id };
}

function deleteCurriculumItem_(sheetName, userCpr, id) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var sh = SpreadsheetApp.openById(refID).getSheetByName(sheetName);
  if (!sh) return { ok: true };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true };
  var ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: true };
}

function saveSubject(userCpr, item) { return saveCurriculumItem_('subjects', ['level'], userCpr, item); }
function deleteSubject(userCpr, id) { return deleteCurriculumItem_('subjects', userCpr, id); }

// "المقررات" — قائمة كتب/متون بسيطة (id/name/description/subjectId)، أعيدت (كانت أُلغيت خطأً
// بمحاولة أولى ظنّت أنها نفس شيء "الأوراد" — راجع getCurriculaList بdataGet.js للتصحيح الكامل).
function saveCurriculum(userCpr, item) { return saveCurriculumItem_('curricula', ['subjectId', 'level'], userCpr, item); }
function deleteCurriculum(userCpr, id) { return deleteCurriculumItem_('curricula', userCpr, id); }

// "المتون" — كتالوج أسماء منفصل تمامًا عن "المقررات" (راجع تعليق getMatnCatalogList بdataGet.js
// للتفصيل الكامل: مادة واحدة قد تضم مقررات ومتونًا معًا بلا أي تبعية بينهما). matnCatalog اسم
// شيت مقصود يختلف عن matns الحقيقي (الأوراد) لتفادي أي تصادم.
function saveMatnCatalog(userCpr, item) { return saveCurriculumItem_('matnCatalog', ['subjectId', 'level'], userCpr, item); }
function deleteMatnCatalog(userCpr, id) { return deleteCurriculumItem_('matnCatalog', userCpr, id); }

// "المهارات" — قائمة بسيطة بنفس بنية المقررات (راجع getSkillsList بdataGet.js).
function saveSkill(userCpr, item) { return saveCurriculumItem_('skills', ['subjectId', 'level'], userCpr, item); }
function deleteSkill(userCpr, id) { return deleteCurriculumItem_('skills', userCpr, id); }

// استيراد أسماء المتون الفريدة من شيت الأوراد الحقيقي (matns، عمود "الكتاب / المتن") إلى
// كتالوج "المتون" (matnCatalog) دون تكرار — بطلب المستخدم. آمنة للتشغيل أكثر من مرة: أي اسم
// موجود بالفعل بالكتالوج (بعد الحذف) يُتجاهل ولا يُعاد إنشاؤه. لكل اسم متن مستورَد: المرحلة =
// اتحاد كل مراحل صفوف الأوراد التي ظهر بها (STAGE_NAMES_ بdataGet.js نفس ترتيب/نصوص
// getLevelName بadmin-js.html)، والمادة = أول subjectId غير فارغ وُجد بين تلك الصفوف.
function importMatnCatalogFromAwrad(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  var awradRows = getMatns() || [];
  var existing = getCurriculumList_('matnCatalog', ['subjectId', 'level']);
  var existingNames = {};
  existing.forEach(function (m) { existingNames[String(m.name || '').trim()] = true; });

  var groups = {};
  var order = [];
  awradRows.forEach(function (r) {
    var name = String(r.matn || '').trim();
    if (!name) return;
    if (!groups[name]) { groups[name] = { levels: [], subjectId: '' }; order.push(name); }
    var g = groups[name];
    if (r.level !== '' && r.level !== null && r.level !== undefined) {
      var label = STAGE_NAMES_[+r.level];
      if (label && g.levels.indexOf(label) === -1) g.levels.push(label);
    }
    if (!g.subjectId && r.subjectId) g.subjectId = r.subjectId;
  });

  var imported = 0;
  order.forEach(function (name) {
    if (existingNames[name]) return;
    var g = groups[name];
    saveCurriculumItem_('matnCatalog', ['subjectId', 'level'], userCpr, {
      name: name, description: '', subjectId: g.subjectId || '', level: g.levels.join(',')
    });
    existingNames[name] = true;
    imported++;
  });

  return { ok: true, imported: imported, total: order.length, skipped: order.length - imported };
}

function requireSuperAdmin_(userCpr) {
  return hasExamPermission(userCpr).isSuperAdmin === true;
}

// عمليات إعداد Meta أشد حساسية من CRUD الإداري المعتاد لأنها تتحكم في مزوّد خارجي وسر وصول.
// لذلك لا نكتفي بـCPR القادم من المتصفح: نتحقق من Firebase ID token لدى Identity Toolkit ثم
// نطابق localId مع authUid المحفوظ لنفس الحساب. لا يُسجَّل التوكن ولا يُخزَّن.
function requireVerifiedSuperAdmin_(userCpr, firebaseIdToken) {
  if (!requireSuperAdmin_(userCpr) || !firebaseIdToken) return false;
  try {
    var person = findPersonByCpr_(userCpr);
    if (!person) return false;
    var expectedUid = person.authUid || ('u' + String(userCpr).trim());
    var response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + AUTH_FIREBASE_API_KEY, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: String(firebaseIdToken) }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return false;
    var result = JSON.parse(response.getContentText());
    return !!(result.users && result.users[0] && String(result.users[0].localId) === String(expectedUid));
  } catch (err) {
    return false;
  }
}

function findMadhabRecord_(id) {
  var sh = ensureCurriculumSheet_('madhabs', ['level', 'archived']), hm = headerMap_(sh), h = hm.map;
  if (sh.getLastRow() < 2) return null;
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][h.id]) === String(id)) return { sheet: sh, headers: hm.headers, map: h, row: rows[i], rowNumber: i + 2 };
  }
  return null;
}

function countExactColumnValue_(spreadsheetId, sheetName, columnName, value, statusFilter) {
  var sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return 0;
  var hm = headerMap_(sh), h = hm.map, col = h[columnName];
  if (col === undefined) return 0;
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().filter(function (r) {
    return String(r[col]) === String(value) && (!statusFilter || r[h.status] === statusFilter);
  }).length;
}

function madhabImpactByName_(name) {
  return {
    students: countExactColumnValue_(mainData, 'students', 'mazhab', name),
    questions: countExactColumnValue_(refID, 'questions', 'الكتاب / المتن', name),
    answers: countExactColumnValue_(answersData, 'answers', 'matn', name),
    surveys: countExactColumnValue_(answersData, 'surveys', 'exam', name),
    sessions: countExactColumnValue_(answersData, 'examSessions', 'matn', name),
    activeSessions: countExactColumnValue_(answersData, 'examSessions', 'matn', name, 'active')
  };
}

function getMadhabImpact(userCpr, id) {
  if (!requireSuperAdmin_(userCpr)) return { error: true, message: 'يلزم صلاحية سوبر أدمن' };
  var rec = findMadhabRecord_(id);
  if (!rec) return { error: true, message: 'المذهب غير موجود' };
  return { ok: true, name: rec.row[rec.map.name], impact: madhabImpactByName_(rec.row[rec.map.name]) };
}

function replaceExactColumnValue_(spreadsheetId, sheetName, columnName, oldValue, newValue) {
  var sh = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return null;
  var hm = headerMap_(sh), col = hm.map[columnName];
  if (col === undefined) return null;
  var range = sh.getRange(2, col + 1, sh.getLastRow() - 1, 1), values = range.getValues(), before = values.map(function (r) { return [r[0]]; }), changed = false;
  values.forEach(function (r) { if (String(r[0]) === String(oldValue)) { r[0] = newValue; changed = true; } });
  if (changed) range.setValues(values);
  return changed ? { range: range, before: before } : null;
}

function saveMadhab(userCpr, item) {
  if (!requireSuperAdmin_(userCpr)) return { error: true, message: 'تعديل قائمة المذاهب متاح للسوبر أدمن فقط' };
  item = item || {};
  var oldRec = item.id ? findMadhabRecord_(item.id) : null;
  var oldName = oldRec ? String(oldRec.row[oldRec.map.name] || '').trim() : '';
  var newName = String(item.name || '').trim();
  var impact = oldName ? madhabImpactByName_(oldName) : null;
  var isRename = !!oldName && oldName !== newName;
  if (isRename && impact.activeSessions > 0) return { error: true, message: 'لا يمكن إعادة تسمية المذهب أثناء وجود جلسات فقه نشطة عليه' };
  if (isRename && !item.confirmLinkedRename && (impact.students || impact.questions || impact.answers || impact.surveys || impact.sessions)) {
    return { requiresConfirmation: true, oldName: oldName, newName: newName, impact: impact };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { error: true, message: 'البيانات مشغولة بعملية أخرى الآن، حاول بعد قليل' };
  var changes = [];
  try {
    if (isRename) {
      [
        [mainData, 'students', 'mazhab'],
        [refID, 'questions', 'الكتاب / المتن'],
        [answersData, 'answers', 'matn'],
        [answersData, 'surveys', 'exam'],
        [answersData, 'examSessions', 'matn'],
        [refID, 'examModels', 'branch']
      ].forEach(function (spec) {
        var changed = replaceExactColumnValue_(spec[0], spec[1], spec[2], oldName, newName);
        if (changed) changes.push(changed);
      });
    }
    var result = saveCurriculumItem_('madhabs', ['level', 'archived'], userCpr, item);
    if (!result || result.error) throw new Error((result && result.message) || 'تعذّر حفظ المذهب');
    logExamOperation_(userCpr, oldRec ? 'edit_madhab' : 'add_madhab', JSON.stringify({ oldValue: oldName, newValue: newName, impact: impact || {} }));
    return result;
  } catch (err) {
    // تراجع عن كل تحديث مرجعي اكتمل قبل الخطأ، ليظهر تغيير الاسم كوحدة واحدة للمستخدم.
    for (var i = changes.length - 1; i >= 0; i--) {
      try { changes[i].range.setValues(changes[i].before); } catch (rollbackErr) { Logger.log(rollbackErr); }
    }
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function deleteMadhab(userCpr, id) {
  if (!requireSuperAdmin_(userCpr)) return { error: true, message: 'حذف/أرشفة المذاهب متاح للسوبر أدمن فقط' };
  var rec = findMadhabRecord_(id);
  if (!rec) return { ok: true };
  var name = rec.row[rec.map.name], impact = madhabImpactByName_(name);
  if (impact.students || impact.questions) {
    rec.sheet.getRange(rec.rowNumber, rec.map.archived + 1).setValue(true);
    rec.sheet.getRange(rec.rowNumber, rec.map.updatedBy + 1).setValue(userCpr);
    rec.sheet.getRange(rec.rowNumber, rec.map.updatedAt + 1).setValue(new Date());
    logExamOperation_(userCpr, 'archive_madhab', JSON.stringify({ oldValue: name, impact: impact }));
    return { ok: true, archived: true, message: 'المذهب مستخدم؛ تمت أرشفته وإخفاؤه بدل حذفه نهائيًا' };
  }
  rec.sheet.deleteRow(rec.rowNumber);
  logExamOperation_(userCpr, 'delete_madhab', JSON.stringify({ oldValue: name, impact: impact }));
  return { ok: true, archived: false };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// تبويب "المقررات" — أُلغيت قائمة curricula الجديدة (كانت فارغة تمامًا) واستُبدلت بربط مباشر
// بشيت matns الحقيقي الموجود أصلًا بـrefID (نفس الشيت المستخدَم فعليًا لبناء قوائم المتون/
// الأوراد بميزة التسميع بالكامل — matn/werd/start/end/level — راجع getMatns بـdataGet.js
// وsubmitDectationData أدناه، **لا تُعدَّل أعمدته الأصلية أو مواقعها إطلاقًا**). أُضيف فقط عمود
// جديد subjectId (إضافة بالنهاية، بلا حذف/إعادة ترتيب — نفس نمط ensure* القائم بالمشروع كله).
//
// الصفحة الإدارية المستقلة القديمة "إدارة المقررات" (matns.html/matns-js.html بغلاف
// emp.html القديم) أُلغيت بالكامل لصالح هذا التبويب الموحَّد الجديد (بطلب صريح من المستخدم) —
// setMoqarrarat/deleteMoqarrarat القديمتان (كانتا المستهلك الوحيد لهما) حُذفتا معهما، لأنهما
// كانتا بلا أي تحقق صلاحية إطلاقًا وتكتبان بمواقع أعمدة ثابتة (positional) بدل أسماء الأعمدة —
// استُبدلتا بالدالتين أدناه (تحقق صلاحية + كتابة بأسماء الأعمدة، أكثر أمانًا).
//
// تنبيه مهم لأي جلسة لاحقة: عمود "الكتاب / المتن" (matn) هنا **يُطابَق بالاسم النصي فقط لا
// بمعرّف** من submitDectationData (بحث مباشر بالقيمة الحرفية) لتحديد مرحلة كل تسميعة — تغيير
// اسم مقرر موجود من هنا لن يُحدِّث السجلات القديمة بشيت motonRates (تبقى بأسماء وقت تسجيلها)،
// وأي تسميعات جديدة بعد التغيير ستُطابَق بالاسم الجديد فقط. هذا سلوك موجود ومقصود مسبقًا، لم
// يتغيّر بهذا التعديل — فقط تنبيه له.
function ensureMatnsSubjectColumn_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = headers.indexOf('subjectId');
  if (col === -1) {
    col = sh.getLastColumn();
    sh.getRange(1, col + 1).setValue('subjectId');
    return col + 1;
  }
  return col + 1;
}

// تنبيه حرج (اكتُشف بعد بناء الدالة أول مرة، بمعلومة من المستخدم مباشرة من الشيت الحي): عمود
// "id" هنا **ليس قيمة ثابتة** — صيغة ArrayFormula حيّة بالخلية الأولى تُركِّب تلقائيًا
// "المستوى-الورد-الكتاب/المتن" لكل صف (`=ArrayFormula(IF(...,B:B&"-"&C:C&"-"&D:D))`). الكتابة
// المباشرة على عمود A لأي صف — حتى بنفس قيمته المحسوبة الحالية كنص ثابت — **تكسر الصيغة لهذا
// الصف تحديدًا نهائيًا** (يتوقف عن التحديث التلقائي لاحقًا لو تغيّر المستوى/الورد/المتن). لذلك:
// كل كتابة هنا (صف جديد أو تعديل) تبدأ من العمود B فصاعدًا حصرًا، وعمود A لا يُقرأ ولا يُكتَب
// إطلاقًا إلا للقراءة النهائية بعد الإدراج (بعد flush لضمان اكتمال حساب الصيغة).
function saveMatnsItem(userCpr, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var matn = String(item.matn || '').trim();
  if (!matn) return { error: true, message: 'اسم الكتاب / المتن مطلوب' };
  if (item.level === '' || item.level === undefined || item.level === null) return { error: true, message: 'المرحلة مطلوبة' };

  var sh = SpreadsheetApp.openById(refID).getSheetByName('matns');
  ensureMatnsSubjectColumn_(sh);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id'), levelCol = headers.indexOf('المستوى'), werdCol = headers.indexOf('الورد'),
    matnCol = headers.indexOf('الكتاب / المتن'), startCol = headers.indexOf('من'), endCol = headers.indexOf('إلى'),
    subjectCol = headers.indexOf('subjectId');
  var lastRow = sh.getLastRow();

  var rowValues = {};
  rowValues[levelCol] = item.level;
  rowValues[werdCol] = item.werd || '';
  rowValues[matnCol] = matn;
  rowValues[startCol] = item.start || '';
  rowValues[endCol] = item.end || '';
  rowValues[subjectCol] = item.subjectId || '';

  var existingRowNum = -1;
  if (item.id) {
    var ids = lastRow > 1 ? sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues() : [];
    for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]) === String(item.id)) { existingRowNum = i + 2; break; } }
  }

  var id;
  if (existingRowNum > -1) {
    // نقرأ فقط من العمود B فصاعدًا (نتجاهل A كليًا)، نعدّل القيم المطلوبة بإزاحة فهرس واحد
    // للخلف (lastRow/headers محسوبة على كامل الأعمدة بما فيها A)، ونكتب نفس النطاق (B فصاعدًا) فقط.
    var restRow = sh.getRange(existingRowNum, 2, 1, headers.length - 1).getValues()[0];
    Object.keys(rowValues).forEach(function (colIdx) {
      var relIdx = +colIdx - 1;
      if (relIdx >= 0) restRow[relIdx] = rowValues[colIdx];
    });
    sh.getRange(existingRowNum, 2, 1, restRow.length).setValues([restRow]);
    id = item.id; // الصف نفسه لم يتغيّر موضعه؛ الصيغة ستعيد حساب نص الid تلقائيًا لو تغيّر المستوى/الورد/المتن
  } else {
    var newRowNum = lastRow + 1;
    var restRow = new Array(headers.length - 1).fill('');
    Object.keys(rowValues).forEach(function (colIdx) {
      var relIdx = +colIdx - 1;
      if (relIdx >= 0) restRow[relIdx] = rowValues[colIdx];
    });
    sh.getRange(newRowNum, 2, 1, restRow.length).setValues([restRow]);
    SpreadsheetApp.flush(); // لضمان اكتمال حساب ArrayFormula قبل قراءة الid المُولَّد تاليًا
    id = sh.getRange(newRowNum, idCol + 1).getValue();
  }
  return { ok: true, id: id };
}

function deleteMatnsItem(userCpr, id) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var sh = SpreadsheetApp.openById(refID).getSheetByName('matns');
  if (!sh) return { ok: true };
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true };
  var ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: true };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// data.isRemote: true لو اختار الطالب "خارج البحرين (دراسة عن بُعد)" في الفورم — عندها لا
// يملك رقمًا شخصيًا بحرينيًا، فيُولَّد له معرّف دخول بديل (راجع generateRemoteStudentId في
// code.js)، ويُتجاهَل أي data.cpr وصل من العميل في هذه الحالة تمامًا (حتى لو كان قيمة تخمينية
// أو متبقية من محاولة سابقة). القيمة المُعادة أصبحت كائنًا (وليس نصًا كما كانت) ليحمل المعرّف
// المُولَّد؛ راجع submitNewReg في funcs-js.html للطرف المقابل الذي يقرأ res.status/res.cpr.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function newStuReg(data){

  ensureStudentResidencyColumns_();

  var ss =  SpreadsheetApp.openById(mainData);
  var dataSh = ss.getSheetByName('students');
  var headers = dataSh.getRange(1, 1, 1, dataSh.getLastColumn()).getValues()[0];

  var isRemote = !!data.isRemote;
  var finalCpr = isRemote ? generateRemoteStudentId(data.dob) : String(data.cpr || '').trim();

  // منع التسجيل المكرر لنفس الرقم الشخصي (مثلًا بسبب ضغط مزدوج على زر التسجيل) — لا داعي له
  // للطلاب خارج البحرين لأن generateRemoteStudentId نفسها تفحص عدم وجود المعرّف بالفعل قبل
  // إعادته (راجع تعليقها).
  var cprCol = headers.indexOf('cpr');
  if (!isRemote && cprCol > -1 && dataSh.getLastRow() > 1) {
    var existingCprs = dataSh.getRange(2, cprCol + 1, dataSh.getLastRow() - 1, 1).getValues()
      .map(function (r) { return r[0]; });
    if (existingCprs.some(function (c) { return cprEquals_(c, finalCpr); })) {
      return { status: 'duplicate' };
    }
  }

  // نكتب كل قيمة في عمودها بالبحث عن اسمه، بدل الاعتماد على ترتيب ثابت للأعمدة
  // (كان الاعتماد على المواضع الثابتة يكتب أحيانًا في عمود غير مقصود، مثل "مذهب").
  var row = new Array(headers.length).fill('');
  var setByName = function (name, value) {
    var col = headers.indexOf(name);
    if (col > -1) row[col] = value;
  };

  setByName('Timestamp', new Date());
  setByName('cpr', finalCpr);
  setByName('name', data.name);
  setByName('gender', data.gender);
  setByName('dob', data.dob);
  setByName('nationality', data.nationality);
  setByName('phone', data.phone);
  setByName('email', data.mail);
  setByName('block', data.block);
  setByName('area', data.area);
  setByName('pastStudies', data.pastStudies);
  setByName('didYou', data.didYou); // إن لم يوجد عمود بهذا الاسم في الشيت، تُتجاهل القيمة دون أن تؤثر على بقية الأعمدة
  // لا تُعيَّن أي مرحلة هنا عمدًا (بعد أن كانت تُنسَب حصريًا للتأسيسية) — إنشاء الحساب أصبح
  // مفصولًا تمامًا عن التسجيل في مرحلة. الطالب (الجديد هنا، أو أي طالب قائم لم يُسجَّل بعد في
  // مرحلة مفتوحة حاليًا) يُعرَض عليه لاحقًا طلب "هل تود التسجيل في المرحلة X؟" من داخل لوحته
  // (راجع maybeOfferStageJoinModal في funcs-js.html، تعمل بالفعل لكلا الحالتين دون أي تعديل هنا).
  // true في الحالة الطبيعية (تحقّق البريد بالفعل أثناء التسجيل، برمز أو عبر جوجل)، فلا داعي
  // لتكراره عند أول تسجيل دخول. تكون false فقط لو تعذّر إرسال رمز التحقق بسبب امتلاء حصة
  // البريد اليومية، فيُؤجَّل التحقق الفعلي لأول تسجيل دخول (عبر آلية طلب رمز الدخول الحالية).
  setByName('emailVerified', data.emailVerified !== false);
  // حقلان تلقائيان بالكامل حسب اختيار الإقامة، لا يظهران للطالب ولا يختارهما أبدًا.
  setByName('outsideBahrain', isRemote);
  setByName('studyType', isRemote ? 'عن بُعد' : 'حضوري');

  dataSh.appendRow(row);

  // نُرسل معرّف الدخول المُولَّد بالإيميل فورًا (وليس عند القبول لاحقًا كباقي الإشعارات) لأنه
  // بديل الرقم الشخصي هنا، والطالب لن يكون بمقدوره الدخول لاحقًا من دونه إطلاقًا.
  if (isRemote && data.mail) {
    try {
      // القالب المصمَّم (basair-theme-studio) بدل HTML مباشر بسيط — راجع emailTemplates.js
      sendBasairLoginIdEmail_(data.mail, String(data.name || ''), finalCpr, 'https://basaerbh.com');
    } catch (err) {
      // فشل إرسال الإيميل لا يُفسد نجاح التسجيل نفسه — المعرّف يُعرَض على الشاشة فورًا أيضًا
    }
  }

  return { status: 'ok', cpr: finalCpr, generated: isRemote };
}

// تحويل نمط دراسة طالب قائم بين "حضوري" و"عن بُعد" من "قوائم الطلاب" بلوحة الإدارة. يكتب
// العمودين outsideBahrain وstudyType معًا بنفس القيمتين اللتين يكتبهما newStuReg عند التسجيل، فلا
// يتعارضان أبدًا. لا يمسّ الرقم الشخصي/معرّف الدخول عمدًا: كل سجلات الطالب (حضور/أوراد/اختبارات/
// شهادات) مفهرسة به، وتغييره كان سيفصلها عنه. mode: 'remote' أو 'onsite'.
function setStudentStudyMode(userCpr, studentCpr, mode) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة لتحويل نمط دراسة الطالب' };
  if (mode !== 'remote' && mode !== 'onsite') return { error: true, message: 'نمط الدراسة غير صالح' };

  // يُنشئ العمودين لو لم يوجدا بعد (طلاب قدامى لم يسجّل بعدهم أحد طالبًا جديدًا) — قبل قراءة الرؤوس.
  ensureStudentResidencyColumns_();

  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var folderCol = headers.indexOf('folder');
  var outsideCol = headers.indexOf('outsideBahrain');
  var typeCol = headers.indexOf('studyType');
  if (lastRow < 2 || cprCol === -1 || outsideCol === -1 || typeCol === -1) {
    return { error: true, message: 'تعذّر العثور على الطالب' };
  }

  // نفس قاعدة getPersons: صفوف folder = 'no' مستبعدة، فلا يُعدَّل صف مخفي عن قوائم الإدارة.
  var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var rowNumber = 0;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][cprCol] !== '' && cprEquals_(rows[i][cprCol], studentCpr) && (folderCol === -1 || rows[i][folderCol] != 'no')) {
      rowNumber = i + 2;
      break;
    }
  }
  if (!rowNumber) return { error: true, message: 'تعذّر العثور على الطالب' };

  var isRemote = mode === 'remote';
  var studyType = isRemote ? 'عن بُعد' : 'حضوري';
  sh.getRange(rowNumber, outsideCol + 1).setValue(isRemote);
  sh.getRange(rowNumber, typeCol + 1).setValue(studyType);
  return { ok: true, isRemote: isRemote, studyType: studyType };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
function deleteDectation(code){

  //code = '45766.73800038194';

  var ss = SpreadsheetApp.openById(dectationData);
  var sheet = ss.getSheetByName('motonRates');
  var headers = sheet.getRange("1:1").getValues()[0];
  var codeCol = headers.indexOf('code');
  var codes = sheet.getRange(1,codeCol+1,sheet.getLastRow(),1).getValues();
  var row = codes.map(r=> +r[0]).indexOf(+code);

  //Logger.log(row);
  //return;

  if(row == null || row < 0){
    return false;
  }else{
    sheet.deleteRow(row);
    return true;
  }

}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// القفل (allowMazhabChange بشيت main، مفتاح "تغيير المذهب" بتبويب المذاهب — إدارة المواد) يُنفَّذ
// خادميًا هنا أيضًا لا بالواجهة فقط (كانت هذه الدالة بلا أي تحقق إطلاقًا سابقًا) — يمنع كل
// تسجيل أو تغيير للمذهب عند الإغلاق، بما فيه الاختيار الأول لطالب لا يمتلك مذهبًا بعد
// (قرار المستخدم 2026-10-03: السماح بالاختيار الأول عند الإغلاق كان سلوكًا خاطئًا).
function setMazhab(mazhab , cpr){

  var ss = SpreadsheetApp.openById(mainData);
  var sheet = ss.getSheetByName('students');
  var headers = sheet.getRange("1:1").getValues()[0];
  var cprsCol = headers.indexOf('cpr');
  var mazhabCol = headers.indexOf('mazhab');
  var cprs = sheet.getRange(1,cprsCol+1,sheet.getLastRow(),1).getValues();
  var row = cprs.map(r=> +r[0]).indexOf(+cpr);
  if (row === -1) return { error: true, message: 'الطالب غير موجود' };

  var currentMazhab = sheet.getRange(row+1, mazhabCol+1).getValue();
  if (currentMazhab !== mazhab) {
    var mainSh = SpreadsheetApp.openById(refID).getSheetByName('main');
    var col = ensureAllowMazhabChangeColumn_(mainSh);
    var allowChange = !!mainSh.getRange(2, col).getValue();
    if (!allowChange) return { error: true, message: 'تغيير المذهب الفقهي مغلق حاليًا' };
  }

  sheet.getRange(row+1 , mazhabCol+1).setValue(mazhab);
  return { ok: true };

}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// إدارة المراحل — استُبدلت الأربع دوال المنفصلة القديمة (setTaas1/setTaas2/setTaaseeleia/setTaas3،
// كل واحدة منسوخة عن الأخرى بمرحلة مختلفة، بلا أي تحقق من كون التسجيل مفتوحًا أصلًا) بدالتين
// عامّتين هنا. راجع مناقشات.md "نظام إدارة المراحل" للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function saveStageSettings(userCpr, stageIndex, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var sh = ensureStagesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex');
  var lastRow = sh.getLastRow();
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var rowIdx = rows.findIndex(function (r) { return +r[stageCol] === +stageIndex; });
  if (rowIdx === -1) return { error: true, message: 'مرحلة غير معروفة' };

  var row = rows[rowIdx];
  var setByName = function (name, value) {
    var col = headers.indexOf(name);
    if (col > -1) row[col] = value;
  };
  setByName('registrationOpen', !!item.registrationOpen);
  setByName('courseStartDate', item.courseStartDate || '');
  setByName('courseEndDate', item.courseEndDate || '');
  setByName('cardTemplateId', item.cardTemplateId || '');
  setByName('certTemplateId', item.certTemplateId || '');
  setByName('bagLink', item.bagLink || '');
  setByName('hoursPerAttendance', item.hoursPerAttendance === '' || item.hoursPerAttendance == null ? '' : +item.hoursPerAttendance);
  setByName('updatedBy', userCpr);
  setByName('updatedAt', new Date());
  sh.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  return { ok: true };
}

// حفظ مستقل لموارد المرحلة المقفولة افتراضيًا في الواجهة، ولكلٍ منها زر تعديل/حفظ خاص.
// نخزّن معرّف القالب فقط حتى يظل متوافقًا مع DriveApp.getFileById، بينما نخزّن الحقيبة
// كرابط مجلد Drive كامل لأنها تظهر للطالب كرابط مباشر.
function saveStageTemplateField(userCpr, stageIndex, fieldName, value) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var allowedFields = ['cardTemplateId', 'certTemplateId', 'bagLink'];
  if (allowedFields.indexOf(fieldName) === -1) return { error: true, message: 'حقل المورد غير معروف' };

  value = String(value || '').trim();
  if (value) {
    var idMatch = value.match(/[-\w]{20,}/);
    if (!idMatch) return { error: true, message: fieldName === 'bagLink' ? 'أدخل رابط مجلد Google Drive أو معرّفًا صالحًا' : 'أدخل رابط Google Doc أو معرّف ملف صالحًا' };
    value = fieldName === 'bagLink' ? 'https://drive.google.com/drive/folders/' + idMatch[0] : idMatch[0];
  }

  var sh = ensureStagesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex');
  var fieldCol = headers.indexOf(fieldName);
  var lastRow = sh.getLastRow();
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var rowIdx = rows.findIndex(function (r) { return +r[stageCol] === +stageIndex; });
  if (rowIdx === -1 || fieldCol === -1) return { error: true, message: 'مرحلة أو حقل مورد غير معروف' };

  sh.getRange(rowIdx + 2, fieldCol + 1).setValue(value);
  var updatedByCol = headers.indexOf('updatedBy');
  var updatedAtCol = headers.indexOf('updatedAt');
  if (updatedByCol > -1) sh.getRange(rowIdx + 2, updatedByCol + 1).setValue(userCpr);
  if (updatedAtCol > -1) sh.getRange(rowIdx + 2, updatedAtCol + 1).setValue(new Date());
  return { ok: true, value: value };
}

// تحديث حدّ/إلزامية معيار اجتياز واحد لمرحلة (الصفوف الاثنا عشر ثابتة — أُنشئت تلقائيًا بـ
// ensureStageCriteriaSheet_، لا إضافة/حذف حرّ). راجع getStageCriteriaList/getStageCompletionStatus
// (dataGet.js) للقراءة والاستخدام.
function saveStageCriterion(userCpr, stageIndex, criterionKey, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var sh = ensureStageCriteriaSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex'), keyCol = headers.indexOf('criterionKey');
  var lastRow = sh.getLastRow();
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var rowIdx = rows.findIndex(function (r) { return +r[stageCol] === +stageIndex && r[keyCol] === criterionKey; });
  if (rowIdx === -1) return { error: true, message: 'معيار غير معروف' };

  var row = rows[rowIdx];
  var setByName = function (name, value) {
    var col = headers.indexOf(name);
    if (col > -1) row[col] = value;
  };
  setByName('threshold', +item.threshold || 0);
  setByName('isMandatory', !!item.isMandatory);
  if (criterionKey === 'examPassRate') setByName('considerAllExams', !!item.considerAllExams);
  if (criterionKey === 'recitationRate') setByName('considerMadhab', !!item.considerMadhab);
  setByName('updatedBy', userCpr);
  setByName('updatedAt', new Date());
  sh.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  return { ok: true };
}

// تسجيل رغبة طالب بالانضمام لمرحلة (يكتب class{stageIndex}=true، بانتظار مراجعة الإدارة عبر
// "طلبات التسجيل" الموجودة أصلًا — لم تُمَس). يتحقق أولًا من المفتاح العام (main.تسجيل) ومن
// مفتاح المرحلة نفسها (stages.registrationOpen) معًا — كلاهما لازم مفتوحان (راجع مناقشات.md).
function requestStageJoin(cpr, stageIndex) {
  stageIndex = +stageIndex;
  if (stageIndex < 0 || stageIndex > 3) return { error: true, message: 'مرحلة غير صحيحة' };

  var mainStatus = getMainStatus();
  if (!mainStatus.registration) return { error: true, message: 'باب التسجيل مغلق حاليًا' };

  var stage = getStagesList().find(function (s) { return +s.stageIndex === stageIndex; });
  if (!stage || !stage.registrationOpen) return { error: true, message: 'التسجيل بهذه المرحلة مغلق حاليًا' };

  var ss = SpreadsheetApp.openById(mainData);
  var sheet = ss.getSheetByName('students');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var classCol = headers.indexOf('class' + stageIndex);
  if (classCol === -1) return { error: true, message: 'تعذّر تحديد عمود المرحلة' };

  var lastRow = sheet.getLastRow();
  var cprs = sheet.getRange(2, cprCol + 1, lastRow - 1, 1).getValues();
  var rowIdx = cprs.findIndex(function (r) { return cprEquals_(r[0], cpr); });
  if (rowIdx === -1) return { error: true, message: 'تعذّر العثور على حسابك' };

  // من أنهى مرحلة سابقة (class[n] === 'done') لا يجوز له طلب مرحلة مساوية أو أدنى منها — يجب أن
  // تكون المرحلة الجديدة أعلى صراحةً. تحقق خادمي مطابق لفحص العميل (maybeOfferStageJoinModal/
  // highestDoneStageIndex بـfuncs-js.html) حماية مزدوجة، لا يعتمد على العميل وحده.
  var classCols = [0, 1, 2, 3].map(function (n) { return headers.indexOf('class' + n); });
  var rowValues = sheet.getRange(rowIdx + 2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var highestDone = null;
  classCols.forEach(function (col, idx) {
    if (col > -1 && rowValues[col] === 'done' && (highestDone === null || idx > highestDone)) highestDone = idx;
  });
  if (highestDone !== null && stageIndex <= highestDone) {
    return { error: true, message: 'لا يمكن التسجيل بهذه المرحلة، لأنك أنهيت بالفعل مرحلة مساوية أو أعلى منها.' };
  }

  sheet.getRange(rowIdx + 2, classCol + 1).setValue(true);
  return { ok: true };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// شهادات الاجتياز — سجل الشهادات المُصدَرة فعليًا (لمنع تكرار الإصدار لنفس الطالب/المرحلة، ولعرض
// تاريخ الإصدار). راجع getStageCompletionStatus/getGraduationCandidates (dataGet.js) للمرشَّحين،
// وexportStageCert_ أعلاه لتقنية بناء الشهادة نفسها. مناقشات.md "نظام إدارة المراحل" للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function ensureStageCertificatesSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('stageCertificates');
  if (!sh) {
    sh = ss.insertSheet('stageCertificates');
    sh.appendRow(['cpr', 'stageIndex', 'certUrl', 'issuedBy', 'issuedAt']);
  }
  return sh;
}

// شهادات المرحلة الصادرة لطالب بعينه — يستدعيها الطالب لنفسه (لا صلاحية إدارية مطلوبة، بنفس
// نمط getStageAttendanceStats/getStageRecitationRate_ الذاتية القائمة أصلًا) لعرض بادج "شهادة
// اجتياز" ذهبي قابل للضغط أمام كل مرحلة أنهاها بصفحة "رحلتي العلمية" (renderStudentJourney،
// js.html) — راجع مناقشات.md "شهادات الاجتياز" للسياق الكامل. issuedAt نص جاهز (لا Date خام —
// راجع الذاكرة الدائمة: google.script.run يُسقط حقل Date خام بصمت أحيانًا).
function getMyStageCertificates(cpr) {
  var sh = ensureStageCertificatesSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var rows = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  return rows.filter(function (r) { return cprEquals_(r[0], cpr); }).map(function (r) {
    return { stageIndex: +r[1], url: r[2], issuedAt: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || '') };
  });
}

// قائمة تحقّق كاملة لأوراد مرحلة طالب — كل ورد مفروض على المرحلة (مصفّى بالمذهب لو considerMadhab
// مفعَّلة، بنفس منطق getStageCompletionStatusBatch_ بالضبط) مع حالة تسميعه، لعرضها بمودال تفاصيل
// نسبة التسميع (openRecitDetails، admin-js.html) — بطلب المستخدم صراحةً "علشان اتأكد" من صحة
// النسبة الظاهرة. راجع مناقشات.md "شهادات الاجتياز" للسياق الكامل.
function getStudentRecitationBreakdown(userCpr, studentCpr, stageIndex) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  stageIndex = +stageIndex;

  var student = (getPersons() || []).find(function (s) { return cprEquals_(s.cpr, studentCpr); });
  if (!student) return { error: true, message: 'تعذّر العثور على الطالب' };

  var studentFiqhRoot = fiqhRootIn_(student.mazhab);
  var criterion = getStageCriteriaList().find(function (c) { return +c.stageIndex === stageIndex && c.criterionKey === 'recitationRate'; });
  var considerMadhab = !!(criterion && criterion.considerMadhab);

  var stageAwrad = getMatns().filter(function (m) { return +m.level === stageIndex; }).filter(function (m) {
    if (!considerMadhab) return true;
    var matnFiqhRoot = fiqhRootIn_(m.matn);
    return !matnFiqhRoot || matnFiqhRoot === studentFiqhRoot;
  });

  // آخر سجل تسميع فقط لكل (متن+ورد) — لو أُعيد تسميع نفس الورد أكثر من مرة، نعرض الأحدث.
  var recitedMap = {};
  (getDectationData() || []).forEach(function (d) {
    if (!cprEquals_(d.stuCpr, studentCpr) || +d.level !== stageIndex) return;
    var key = d.matn + '|' + d.werd;
    var existing = recitedMap[key];
    if (!existing || new Date(d.date) > new Date(existing.date)) recitedMap[key] = d;
  });

  var items = stageAwrad.map(function (m) {
    var rec = recitedMap[m.matn + '|' + m.werd];
    return { matn: m.matn, werd: m.werd, recited: !!rec, date: rec ? rec.date : '', rate: rec ? rec.rate : '' };
  });

  // مؤقتًا بطلب المستخدم: تثبيت المقام عند 30 وردًا مقررًا لحين مراجعة الحساب التلقائي
  var totalAwrad = 30;
  return {
    ok: true,
    total: totalAwrad,
    recited: items.filter(function (i) { return i.recited; }).length,
    considerMadhab: considerMadhab,
    items: items
  };
}

// قائمة تحقّق كاملة لاختبارات مرحلة طالب — كل اختبار مفروض على المرحلة (مصفّى بالمذهب لفروع
// الفقه، نفس منطق getStageCompletionStatusBatch_ بالضبط) مع درجته الفعلية (لا نجح/رسب فقط)،
// لعرضها بمودال تفاصيل نسبة النجاح (openExamDetails، admin-js.html) — بطلب المستخدم صراحةً
// "علشان اتأكد" من صحة النسبة (متوسط درجات، لا عدّ ثنائي، منذ 2026-09-16). راجع مناقشات.md
// "شهادات الاجتياز" للسياق الكامل.
function getStudentExamPassBreakdown(userCpr, studentCpr, stageIndex) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  stageIndex = +stageIndex;

  var student = (getPersons() || []).find(function (s) { return cprEquals_(s.cpr, studentCpr); });
  if (!student) return { error: true, message: 'تعذّر العثور على الطالب' };

  var studentFiqhRoot = fiqhRootIn_(student.mazhab);
  var stageExams = (getExams(null, stageIndex) || []).filter(function (e) {
    var examFiqhRoot = fiqhRootIn_(e.subject);
    return !examFiqhRoot || examFiqhRoot === studentFiqhRoot;
  });

  var criterion = getStageCriteriaList().find(function (c) { return +c.stageIndex === stageIndex && c.criterionKey === 'examPassRate'; });
  var considerAllExams = !criterion || criterion.considerAllExams !== false;

  // آخر محاولة فقط لكل اختبار (لو أعاد الطالب اختبارًا، الشيت يحتفظ بصف واحد يُستبدَل عند كل
  // محاولة — لا حاجة فعليًا لمقارنة تواريخ هنا، لكن الاحتياط بلا ضرر لو تغيّر الافتراض لاحقًا).
  var attemptsByExam = {};
  (getAnswersData(studentCpr) || []).forEach(function (a) {
    if (+a.level !== stageIndex) return;
    var existing = attemptsByExam[a.exam];
    if (!existing || new Date(a.date) > new Date(existing.date)) attemptsByExam[a.exam] = a;
  });

  var items = stageExams.map(function (e) {
    var a = attemptsByExam[e.exam];
    var degree = a ? Number(a.result) : null;
    return {
      exam: e.exam,
      attempted: !!a,
      degree: (typeof degree === 'number' && isFinite(degree)) ? degree : null,
      rate: a ? a.rate : '',
      date: a ? a.date : ''
    };
  });

  var scoreSum = items.reduce(function (sum, it) { return sum + (it.attempted && it.degree !== null ? it.degree : 0); }, 0);
  var attemptedCount = items.filter(function (it) { return it.attempted; }).length;
  var denominator = considerAllExams ? items.length : attemptedCount;

  return {
    ok: true,
    total: items.length,
    attempted: attemptedCount,
    average: denominator ? Math.round(scoreSum / denominator) : null,
    considerAllExams: considerAllExams,
    items: items
  };
}

// كل الطلاب النشطين حاليًا بأي مرحلة (لا "المرشّحون" فقط — بطلب المستخدم صراحةً "يعرض جميع
// الطلاب" لصفحة "مرشّحو الاجتياز") مع تقدّمهم بكل معيار اجتياز، وحالتهم النهائية (مجتاز/غير
// مجتاز)، وهل صدرت شهادتهم لهذه المرحلة بالفعل (certificateIssued — تمنع إعادة الإصدار
// بالخطأ، بلا استبعادهم من القائمة). راجع مناقشات.md "نظام إدارة المراحل" للسياق الكامل.
function getGraduationCandidates(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  var sh = ensureStageCertificatesSheet_();
  var lastRow = sh.getLastRow();
  var issuedKeys = {};
  if (lastRow > 1) {
    sh.getRange(2, 1, lastRow - 1, 2).getValues().forEach(function (r) {
      issuedKeys[normalizeCpr_(r[0]) + '|' + r[1]] = true;
    });
  }

  var persons = getPersons() || [];
  var personsByCpr = {};
  persons.forEach(function (s) { personsByCpr[normalizeCpr_(s.cpr)] = s; });

  // حساب دفعة واحدة لكل الطلاب معًا (لا استدعاء منفصل لكل طالب) — راجع تعليق
  // getStageCompletionStatusBatch_ (dataGet.js) لسبب هذا التغيير (كانت الصفحة تستغرق وقتًا
  // طويلاً جدًا بسبب إعادة قراءة شيتات كاملة لكل طالب على حدة). قد تُعيد أكثر من نتيجة لنفس
  // الطالب الآن (مرحلته الحالية + مرحلة سابقة "done" لم تُصدَر شهادتها بعد)، فلم تعد قائمة
  // مسطَّحة مُحاذية لـpersons بالترتيب — كل نتيجة تحمل cpr الخاص بها فتُطابَق به مباشرة.
  var statusList = getStageCompletionStatusBatch_(persons);

  var candidates = [];
  // مرحلة صدرت شهادة اجتيازها بالفعل (stageCertificates) لكن عمودها بشيت الطلاب ('class'+
  // stageIndex) ما زال 'active' — يحدث عادة بالمرحلة التحصيلية الأخيرة (class3) التي لا "مرحلة
  // تالية" يُقبَل بها الطالب فتُحوِّلها acceptedStu_ (oldJS.js) تلقائيًا لـ'done' كباقي المراحل.
  // تُجمَع هنا وتُصحَّح دفعة واحدة أدناه إلى 'done' بطلب المستخدم صراحةً "كل من صدر له شهادة
  // اجتياز... يُكتب أمامه done بالشيت الأساسي" — تُطبَّق عند كل ضغطة "تحديث" بهذه الصفحة.
  var pendingDoneUpdates_ = [];
  statusList.forEach(function (status) {
    var s = personsByCpr[normalizeCpr_(status.cpr)];
    if (!s) return;
    var certIssued = !!issuedKeys[normalizeCpr_(s.cpr) + '|' + status.stageIndex];
    if (certIssued && status.sourceStatus === 'active') {
      pendingDoneUpdates_.push({ cpr: s.cpr, stageIndex: status.stageIndex });
      status.sourceStatus = 'done';
    }
    // مرحلة "done" (انتقل منها الطالب لمرحلة أخرى) لا تُعرَض هنا إن صدرت شهادتها بالفعل — سجل
    // تاريخي مُنجَز لا داعي لتكديسه ضمن قائمة مرشَّحين فعليين. مرحلته "active" الحالية تبقى
    // تُعرَض دومًا كالسابق بصرف النظر عن حالة الشهادة.
    if (status.sourceStatus === 'done' && certIssued) return;
    candidates.push({
      cpr: s.cpr,
      name: s.name,
      gender: s.gender,
      phone: s.phone,
      hasEmail: !!String(s.mail || '').trim(),
      avatarUrl: s.avatarUrl || '',
      stageIndex: status.stageIndex,
      criteria: status.criteria,
      meetsAllMandatory: status.meetsAllMandatory,
      certificateIssued: certIssued
    });
  });
  markDoneForIssuedStageCertificates_(pendingDoneUpdates_);
  return candidates;
}

// السجل الرسمي للطلاب المجتازين: المصدر هو stageCertificates لا قيمة class وحدها، لأن "done"
// قد تُكتب عند انتقال الطالب إلى مرحلة تالية قبل اعتماد اجتيازه رسميًا. كل شهادة تمثل اجتياز
// مرحلة مستقلًا، لذلك قد يظهر الطالب أكثر من مرة إذا اجتاز عدة مراحل. نرفق نسب المرحلة الحالية
// المحسوبة دفعة واحدة كي يعرض تبويب "مجتازون" تفاصيل المرحلة دون طلب منفصل لكل صف.
function getPassedStudents(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  var sh = ensureStageCertificatesSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  var persons = getPersons() || [];
  var personsByCpr = {};
  persons.forEach(function (s) { personsByCpr[normalizeCpr_(s.cpr)] = s; });

  var certificateRows = sh.getRange(2, 1, lastRow - 1, 5).getValues();
  var certifiedCprs = {};
  certificateRows.forEach(function (r) { certifiedCprs[normalizeCpr_(r[0])] = true; });
  var certifiedPersons = persons.filter(function (s) { return !!certifiedCprs[normalizeCpr_(s.cpr)]; });
  if (!certifiedPersons.length) return [];

  var statusByKey = {};
  getStageCompletionStatusBatch_(certifiedPersons).forEach(function (status) {
    statusByKey[normalizeCpr_(status.cpr) + '|' + (+status.stageIndex)] = status;
  });

  // لو وُجد تكرار قديم لنفس الطالب/المرحلة نحتفظ بأحدث إصدار فقط.
  var latestByKey = {};
  certificateRows.forEach(function (r) {
    var cpr = normalizeCpr_(r[0]);
    var stageIndex = +r[1];
    if (!cpr || stageIndex < 0 || stageIndex > 3 || !personsByCpr[cpr]) return;
    var key = cpr + '|' + stageIndex;
    var timestamp = r[4] instanceof Date ? r[4].getTime() : new Date(r[4]).getTime();
    if (!isFinite(timestamp)) timestamp = 0;
    if (!latestByKey[key] || timestamp >= latestByKey[key].timestamp) {
      latestByKey[key] = { row: r, timestamp: timestamp };
    }
  });

  return Object.keys(latestByKey).map(function (key) {
    var entry = latestByKey[key];
    var r = entry.row;
    var cpr = normalizeCpr_(r[0]);
    var stageIndex = +r[1];
    var s = personsByCpr[cpr];
    var status = statusByKey[key];
    var mandatoryPercents = status ? status.criteria.filter(function (c) {
      return c.isMandatory && typeof c.percent === 'number';
    }).map(function (c) { return c.percent; }) : [];
    return {
      cpr: cpr,
      name: s.name,
      gender: s.gender,
      phone: s.phone,
      nationality: s.nationality,
      mazhab: s.mazhab,
      avatarUrl: s.avatarUrl || '',
      stageIndex: stageIndex,
      criteria: status ? status.criteria : [],
      mandatoryAverage: mandatoryPercents.length ? Math.round((mandatoryPercents.reduce(function (sum, n) { return sum + n; }, 0) / mandatoryPercents.length) * 10) / 10 : null,
      certificateUrl: String(r[2] || ''),
      issuedBy: normalizeCpr_(r[3]),
      issuedAt: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || '')
    };
  }).sort(function (a, b) {
    return new Date(b.issuedAt || 0).getTime() - new Date(a.issuedAt || 0).getTime();
  });
}

// تصحيح عمود 'class'+stageIndex بشيت الطلاب الأساسي (mainData) إلى 'done' لكل (cpr, stageIndex)
// صدرت شهادة اجتيازها بالفعل لكن العمود ما زال 'active' — راجع تعليق الاستدعاء أعلاه
// (getGraduationCandidates) للسياق الكامل. لا تلمس أي مرحلة أخرى ولا تُصدر أي شهادة، تكتفي
// بتصحيح الحالة النصية فقط. pending: [{cpr, stageIndex}].
function markDoneForIssuedStageCertificates_(pending) {
  if (!pending || !pending.length) return;

  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var classCols = [headers.indexOf('class0'), headers.indexOf('class1'), headers.indexOf('class2'), headers.indexOf('class3')];

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var rowByCpr = {};
  sh.getRange(2, cprCol + 1, lastRow - 1, 1).getValues().forEach(function (r, i) {
    rowByCpr[normalizeCpr_(r[0])] = i + 2;
  });

  pending.forEach(function (p) {
    var rowNumber = rowByCpr[normalizeCpr_(p.cpr)];
    var col = classCols[+p.stageIndex];
    if (!rowNumber || col === -1) return;
    sh.getRange(rowNumber, col + 1).setValue('done');
  });
}

// حارس "تضارب المصالح" — يمنع تنفيذ إجراء إداري حسّاس على حساب الشخص نفسه حتى لو كانت لديه
// الصلاحية (حالة "طالب بصلاحية إدارية" ممكنة فعليًا بهذا المشروع؛ راجع مناقشات.md "طالب
// بصلاحية إدارية"). يُستدعى بأول سطر أي دالة حسّاسة تستقبل هوية المنفِّذ والهدف معًا.
function guardNotSelfAction_(actorCpr, targetCpr) {
  if (actorCpr && targetCpr && cprEquals_(actorCpr, targetCpr)) {
    return { error: true, message: 'لا يمكنك تنفيذ هذا الإجراء على حسابك الشخصي — يلزم إداري آخر لاعتماده.' };
  }
  return null;
}

// يستبدل {name}/{stage}/{link} داخل نص رسالة حرة يكتبها الإداري لإشعار طالب بشهادة اجتياز —
// مشتركة بين قناتَي الإيميل والواتساب. لو النص لا يحتوي رابط الشهادة الفعلي بعد الاستبدال (سواء
// لم يكتب الإداري {link} إطلاقًا، أو النص فارغ)، يُضاف الرابط تلقائيًا بنهاية الرسالة — حماية
// من نسيان الإداري وضعه، فالطالب لازم يستلم الرابط دائمًا طالما اختار الإداري الإرسال.
function resolveCertMessageTemplate_(template, fields) {
  var out = String(template || '').trim() || MESSAGE_TEMPLATE_DEFS_.stageCertificate.defaultBody;
  Object.keys(fields || {}).forEach(function (k) {
    var value = fields[k] == null ? '' : String(fields[k]);
    out = out.split('{' + k + '}').join(value);
  });
  if (fields && fields.link && out.indexOf(fields.link) === -1) {
    out = (out ? out + '\n\n' : '') + 'رابط الشهادة: ' + fields.link;
  }
  return out;
}

// notify (اختياري): { email: true/false, messageTemplate: نص خام بـ{name}/{stage}/{link} } —
// إرسال الإيميل فوري ومتزامن هنا (فرق مقصود عن الواتساب: الأخير يُجدوَل دفعة واحدة بعد انتهاء
// كل الإصدارات عبر scheduleStageCertWhatsAppNotify أدناه، لأن نظام الطابور القائم أصلًا حملة
// واحدة فقط بالمرة — لا يصلح لاستدعاء منفصل لكل طالب). فشل إرسال الإيميل لا يُفشل الإصدار نفسه.
function issueStageCertificate(userCpr, studentCpr, stageIndex, notify) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var selfGuard = guardNotSelfAction_(userCpr, studentCpr);
  if (selfGuard) return selfGuard;
  stageIndex = +stageIndex;

  var student = (getPersons() || []).find(function (s) { return cprEquals_(s.cpr, studentCpr); });
  if (!student) return { error: true, message: 'تعذّر العثور على الطالب' };

  // حماية من إعادة الإصدار عند بقاء صفحة قديمة مفتوحة أو تكرار الطلب. نعيد الرابط الموجود بلا
  // إنشاء ملف جديد ولا إعادة إرسال الإشعارات حتى لا تصل الرسالة للطالب مرتين. يسبق هذا الفحص
  // الإعدادات الحالية لأن الشهادة الصادرة تظل صحيحة حتى لو تغير القالب أو شروط المرحلة لاحقًا.
  var certSheet = ensureStageCertificatesSheet_();
  var certLastRow = certSheet.getLastRow();
  if (certLastRow > 1) {
    var certRows = certSheet.getRange(2, 1, certLastRow - 1, 5).getValues();
    for (var certRowIndex = certRows.length - 1; certRowIndex >= 0; certRowIndex--) {
      if (cprEquals_(certRows[certRowIndex][0], studentCpr) && +certRows[certRowIndex][1] === stageIndex) {
        return { ok: true, url: certRows[certRowIndex][2], alreadyIssued: true };
      }
    }
  }

  var stageStatus = student['class' + stageIndex];
  if (stageStatus !== 'active' && stageStatus !== 'done') return { error: true, message: 'الطالب غير مسجّل بهذه المرحلة' };
  if (!student.folderUrl) return { error: true, message: 'تعذّر تحديد مجلد الطالب بـDrive' };

  var stage = getStagesList().find(function (s) { return +s.stageIndex === stageIndex; });
  if (!stage || !stage.certTemplateId) return { error: true, message: 'لا يوجد قالب شهادة اجتياز مُعَدّ لهذه المرحلة بعد — راجع "إدارة المراحل"' };

  // إعادة التحقق خادميًا من الاستحقاق؛ لا نعتمد على كون زر التحديد ظاهرًا في الواجهة فقط.
  var completion = getStageCompletionStatusBatch_([student]).find(function (s) { return +s.stageIndex === stageIndex; });
  if (!completion || !completion.meetsAllMandatory) return { error: true, message: 'الطالب لم يستوفِ شروط الاجتياز الإلزامية لهذه المرحلة' };

  try {
    var url = exportStageCert_(stageIndex, student, stage.certTemplateId, getDriveId(student.folderUrl));
    certSheet.appendRow([studentCpr, stageIndex, url, userCpr, new Date()]);
    var result = { ok: true, url: url };

    if (notify && notify.email) {
      if (!student.mail) {
        result.emailSent = false;
        result.emailSkipReason = 'لا يوجد بريد إلكتروني مسجَّل';
      } else {
        try {
          var stageName = STAGE_NAMES_[stageIndex] || '';
          var message = resolveCertMessageTemplate_(notify.messageTemplate, { name: student.name, stage: stageName, link: url });
          sendBasairStageCertEmail_(student.mail, student.name, message, url, stageName);
          result.emailSent = true;
        } catch (emailErr) {
          result.emailSent = false;
          result.emailSkipReason = emailErr.message;
        }
      }
    }

    return result;
  } catch (e) {
    return { error: true, message: 'تعذّر إصدار الشهادة: ' + e.message };
  }
}

// جدولة إشعار واتساب دفعة واحدة لكل من صدرت شهادته بنجاح — بعد انتهاء حلقة الإصدار بالكامل من
// العميل (لا داخل issueStageCertificate نفسها، لأن scheduleWPQueueSend_ حملة واحدة فقط بالمرة
// عبر المشروع كله — استدعاؤها لكل طالب على حدة سيرفض كل الاستدعاءات التالية للأول). items:
// [{cpr, stageIndex, link}] بيانات دنيا فقط (لا اسم/هاتف — تُقرَأ من سجل الطالب الرسمي هنا
// خادميًا، لا من العميل، حماية من أي تلاعب أو بيانات غير محدَّثة بالطرف الآخر).
function scheduleStageCertWhatsAppNotify(userCpr, items, messageTemplate) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { ok: false, reason: 'يلزم صلاحية الإدارة' };

  var personByCpr = {};
  (getPersons() || []).forEach(function (p) { personByCpr[normalizeCpr_(p.cpr)] = p; });

  var rows = [], skipped = [];
  (items || []).forEach(function (it) {
    var student = personByCpr[normalizeCpr_(it.cpr)];
    if (!student || !student.phone) { skipped.push(it.cpr); return; }
    var target = toInternationalWhatsAppNumber(student.phone);
    if (!target) { skipped.push(it.cpr); return; }
    var message = resolveCertMessageTemplate_(messageTemplate, {
      name: student.name,
      stage: STAGE_NAMES_[+it.stageIndex] || '',
      link: it.link
    });
    rows.push({ name: student.name, target: target, targetType: 'phone', message: message });
  });

  if (!rows.length) return { ok: false, reason: 'لا يوجد طلاب لديهم رقم هاتف صالح لإرسال واتساب.', skipped: skipped };

  var res = scheduleWPQueueSend_(rows, { templateKey: 'stageCertificate', sentBy: userCpr });
  res.skipped = skipped;
  return res;
}

// معاينة شهادة اجتياز بلا أي إصدار رسمي — لمراجعة عينات حقيقية قبل اعتماد قالب/معادلات مرحلة،
// بطلب المستخدم صراحةً (راجع مناقشات.md "شهادات الاجتياز"). تكتب الـPDF بمجلد Drive مشترك
// مؤقت (tempFolderID، code.js) لا مجلد الطالب الحقيقي، وبلا أي تسجيل بشيت stageCertificates —
// فلا تمنع إصدارًا رسميًا لاحقًا لنفس الطالب، ولا تترك أثرًا بمجلده الشخصي. تحقق صلاحية إداري
// حقيقي بالكود (نفس نمط issueStageCertificate أعلاه بالضبط) — لا اعتماد على تسمية الدالة كحماية
// (القاعدة العامة بالمشروع: لا "_" بنهاية اسم أي دالة إطلاقًا، راجع مناقشات.md "إعادة تسمية
// شاملة" — أي دالة عامة يلزمها تحقق صلاحية حقيقي بداخلها دومًا، لا حجبًا بالتسمية).
function previewStageCertSample_(userCpr, studentCpr, stageIndex) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  stageIndex = +stageIndex;

  var student = (getPersons() || []).find(function (s) { return cprEquals_(s.cpr, studentCpr); });
  if (!student) return { error: true, message: 'تعذّر العثور على الطالب: ' + studentCpr };

  var stage = getStagesList().find(function (s) { return +s.stageIndex === stageIndex; });
  if (!stage || !stage.certTemplateId) return { error: true, message: 'لا يوجد قالب شهادة اجتياز مُعَدّ لهذه المرحلة بعد' };

  try {
    var url = exportStageCert_(stageIndex, student, stage.certTemplateId, tempFolderID);
    return { ok: true, url: url };
  } catch (e) {
    return { error: true, message: 'تعذّر إنشاء العيّنة: ' + e.message };
  }
}

// شغّلها يدويًا من محرر Apps Script (Extensions ← Apps Script ← اختيار الدالة من القائمة
// المنسدلة أعلى المحرر ← Run) بعد وضع رقمك الشخصي كإداري + 1-2 رقم شخصي حقيقي لطلاب "مجتاز"
// فعليًا بمرحلة التأهيلية (صفحة "مرشّحو الاجتياز") مكان القيم النائبة أدناه. الروابط الناتجة
// تظهر بـ"Execution log" (View ← Logs، أو Ctrl+Enter). تُحذَف هذه الدالة لاحقًا بعد انتهاء
// مرحلة المراجعة.
function debugPreviewStage0Certs() {
  var adminCpr = 'ضع رقمك الشخصي كإداري هنا';
  var cprs = ['ضع الرقم الشخصي الأول هنا', 'ضع الرقم الشخصي الثاني هنا'];
  cprs.forEach(function (cpr) {
    var res = previewStageCertSample_(adminCpr, cpr, 0);
    Logger.log(cpr + ' -> ' + (res.ok ? res.url : 'خطأ: ' + res.message));
  });
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// Registration open/closed toggle (admin dashboard)
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function setRegistrationStatus(isOpen) {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('main');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var registrationCol = headers.indexOf('registration') + 1;
  if (registrationCol === 0) throw new Error('لم يتم العثور على عمود باسم registration');
  sh.getRange(2, registrationCol).setValue(!!isOpen);
  return !!isOpen;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// مفتاح تفعيل/إلغاء ميزة "طلب إضافة حضور" من صفحة الطالب — بنفس شيت main وبنفس فكرة مفتاح
// فتح/إغلاق التسجيل أعلاه بالضبط. تُنشئ العمود بقيمة TRUE (مفعَّلة) افتراضيًا أول مرة، حتى لا
// تظهر الميزة معطَّلة بالغلط فور إنشاء العمود قبل أي ضبط يدوي من الإدارة.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function ensureAttendanceRequestsColumn_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = headers.indexOf('attendanceRequestsOpen');
  if (col === -1) {
    col = sh.getLastColumn();
    sh.getRange(1, col + 1).setValue('attendanceRequestsOpen');
    sh.getRange(2, col + 1).setValue(true);
    return col + 1;
  }
  return col + 1;
}

function setAttendanceRequestsStatus(isOpen) {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('main');
  var col = ensureAttendanceRequestsColumn_(sh);
  sh.getRange(2, col).setValue(!!isOpen);
  return !!isOpen;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// مفتاح "إصدار الطالب شهادته بنفسه" — نفس شيت main ونفس نمط مفتاحي التسجيل/طلبات الحضور
// أعلاه، لكن **مغلق افتراضيًا** (خلافًا لهما) لأنها قدرة جديدة تُنشئ مستندات رسمية فعلية —
// نفس فلسفة retakeOpen بصفحة إدارة الاختبارات (لا تُفعَّل إلا بقرار إداري صريح). راجع
// issueCertificateSelfService أدناه لمنطق الإصدار الفعلي، ومناقشات.md للمواصفة الكاملة.
function ensureSelfIssueCertColumn_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = headers.indexOf('selfIssueCertEnabled');
  if (col === -1) {
    col = sh.getLastColumn();
    sh.getRange(1, col + 1).setValue('selfIssueCertEnabled');
    sh.getRange(2, col + 1).setValue(false);
    return col + 1;
  }
  return col + 1;
}

// exam_admin فقط — بخلاف setRegistrationStatus/setAttendanceRequestsStatus (بلا تحقق صلاحية
// إطلاقًا)، هذا المفتاح يعيش بصفحة "إدارة الاختبارات" فيُطبَّق عليه نفس معيار التحقق الخادمي
// الصارم المعتمد لهذه الصفحة تحديدًا (hasExamPermission بكل دالة كتابة، لا الاكتفاء بإخفاء الزر).
function setSelfIssueCertStatus(userCpr, isOpen) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية إدارة الاختبارات' };
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('main');
  var col = ensureSelfIssueCertColumn_(sh);
  sh.getRange(2, col).setValue(!!isOpen);
  return { ok: true, selfIssueCertEnabled: !!isOpen };
}

// مفتاح "السماح بتغيير المذهب الفقهي" — نفس شيت main ونمط مفاتيح التسجيل/طلبات الحضور
// أعلاه، **مفتوح افتراضيًا** (خلافًا لـselfIssueCertEnabled) لأن السماح بالتغيير هو السلوك
// الحالي فعليًا قبل وجود هذا المفتاح إطلاقًا — إغلاقه سلوك تقييدي جديد يحتاج قرارًا إداريًا
// صريحًا، لا العكس. عند الإغلاق: لا يستطيع أي طالب تسجيل مذهب أو تغييره، سواء اختار مذهبه
// سابقًا أم لا (renderMazhabSelection/معالج .mazhabBtn بـjs.html وsetMazhab).
function ensureAllowMazhabChangeColumn_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = headers.indexOf('allowMazhabChange');
  if (col === -1) {
    col = sh.getLastColumn();
    sh.getRange(1, col + 1).setValue('allowMazhabChange');
    sh.getRange(2, col + 1).setValue(true);
    return col + 1;
  }
  return col + 1;
}

function setAllowMazhabChangeStatus(userCpr, isOpen) {
  if (!requireSuperAdmin_(userCpr)) return { error: true, message: 'تعديل سياسة المذهب متاح للسوبر أدمن فقط' };
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('main');
  var col = ensureAllowMazhabChangeColumn_(sh);
  sh.getRange(2, col).setValue(!!isOpen);
  logExamOperation_(userCpr, 'set_madhab_change', String(!!isOpen));
  return { ok: true, value: !!isOpen };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// تبويب "الملف الشخصي" (طالب وموظف معًا) — أعمدة جديدة لازمة له وغير موجودة أصلًا: dob/
// nationality للموظفين (موجودة فعلًا للطلاب)، وcontactPreference/avatarUrl/phone2 للطلاب
// (موجودة فعلًا لدى الموظفين ما عدا avatarUrl). نمط ensure* نفسه المتّبع بقية المشروع —
// إضافة فقط بلا حذف، تُستدعى بأمان من كل دالة قراءة/كتابة لهذا التبويب.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function ensureProfileColumns_() {
  var ss = SpreadsheetApp.openById(mainData);
  var perSheetCols = {
    students: ['phone2', 'contactPreference', 'avatarUrl'],
    emp: ['dob', 'nationality', 'avatarUrl']
  };
  Object.keys(perSheetCols).forEach(function (sheetName) {
    var sh = ss.getSheetByName(sheetName);
    if (!sh) return;
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var toAdd = perSheetCols[sheetName].filter(function (col) { return headers.indexOf(col) === -1; });
    if (toAdd.length) {
      sh.getRange(1, sh.getLastColumn() + 1, 1, toAdd.length).setValues([toAdd]);
    }
  });
}

// حفظ البيانات القابلة للتعديل في تبويب "الملف الشخصي". لا تلمس البريد الإلكتروني (له تدفّق
// تحقّق مستقل عبر confirmProfileEmail/linkVerifiedEmailToProfile في auth.js) ولا كلمة المرور
// (عبر changePassword) ولا الرقم الشخصي/الحقول الأكاديمية للقراءة فقط (تُدار من الإدارة).
function saveProfileData(cpr, payload) {
  cpr = normalizeCpr_(cpr);
  if (!isValidPersonId(cpr)) return { ok: false, message: 'رقم شخصي غير صحيح.' };
  if (!payload || typeof payload !== 'object') return { ok: false, message: 'بيانات غير صالحة.' };

  var person = findPersonByCpr_(cpr);
  if (!person) return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };

  ensureProfileColumns_();
  var headers = person.sheet.getRange(1, 1, 1, person.sheet.getLastColumn()).getValues()[0];
  function setByName(col, val) {
    var i = headers.indexOf(col);
    if (i > -1) person.sheet.getRange(person.rowNumber, i + 1).setValue(val);
  }

  var name = String(payload.name || '').trim();
  if (name.length >= 6) setByName('name', name);

  if (payload.gender === 'ذكر' || payload.gender === 'أنثى') setByName('gender', payload.gender);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(payload.dob || ''))) setByName('dob', payload.dob);
  if (String(payload.nationality || '').trim()) setByName('nationality', String(payload.nationality).trim());
  // نطاق 4-14 رقمًا (وليس 8 بالضبط) لأن محدد الدولة في الواجهة صار تفاعليًا كنموذج التسجيل —
  // البحرين نفسها 8 أرقام، لكن دولًا أخرى قد تحتاج طولًا مختلفًا (نفس نمط updatePhonePattern).
  if (/^[0-9]{4,14}$/.test(String(payload.phone || ''))) setByName('phone', payload.phone);

  if (person.sheetName === 'students') {
    var phone2 = String(payload.phone2 || '');
    if (phone2 === '' || /^[0-9]{4,14}$/.test(phone2)) setByName('phone2', phone2);
    if (payload.contactPreference === 'whatsapp' || payload.contactPreference === 'email') {
      setByName('contactPreference', payload.contactPreference);
    }
  }

  return { ok: true };
}

// مجلد Drive واحد مشترك لكل صور الملف الشخصي (طلاب وموظفين معًا) — بخلاف مجلد بطاقة القبول
// الرسمية للطالب (folder/perArchiveID عبر acceptedStu_ في oldJS.js)، الذي لا يوجد له نظير
// إطلاقًا لدى الموظفين؛ مجلد مشترك واحد أبسط من تفريع المنطق حسب النوع، ويتفادى خلط صور
// شخصية غير رسمية داخل أرشيف بطاقات الهوية الرسمي.
var PROFILE_AVATARS_FOLDER_NAME_ = 'صور الملف الشخصي';
function getProfileAvatarsFolder_() {
  var parent = DriveApp.getFolderById(perArchiveID);
  var it = parent.getFoldersByName(PROFILE_AVATARS_FOLDER_NAME_);
  return it.hasNext() ? it.next() : parent.createFolder(PROFILE_AVATARS_FOLDER_NAME_);
}

function uploadProfileAvatar(cpr, base64Data, mimeType) {
  cpr = normalizeCpr_(cpr);
  if (!isValidPersonId(cpr)) return { ok: false, message: 'رقم شخصي غير صحيح.' };
  if (!base64Data) return { ok: false, message: 'لم يتم استلام أي صورة.' };

  var extByMime = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg' };
  var ext = extByMime[mimeType];
  if (!ext) return { ok: false, message: 'صيغة الصورة غير مدعومة (png أو jpg فقط).' };

  var person = findPersonByCpr_(cpr);
  if (!person) return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };

  var bytes;
  try {
    bytes = Utilities.base64Decode(base64Data);
  } catch (err) {
    return { ok: false, message: 'تعذّرت قراءة بيانات الصورة.' };
  }
  if (bytes.length > 3 * 1024 * 1024) {
    return { ok: false, message: 'حجم الصورة أكبر من الحد المسموح (3 ميجابايت).' };
  }

  var fileNamePrefix = 'avatar-' + cpr + '.';
  var blob = Utilities.newBlob(bytes, mimeType, fileNamePrefix + ext);
  var folder = getProfileAvatarsFolder_();

  var existing = folder.getFiles();
  while (existing.hasNext()) {
    var f = existing.next();
    if (f.getName().indexOf(fileNamePrefix) === 0) f.setTrashed(true);
  }

  var file = folder.createFile(blob);
  shareFileAnyoneWithLink_(file.getId());
  // Local file store: use the URL of the file we just created instead of a Google Drive thumbnail URL.
  var url = file.getUrl();

  ensureProfileColumns_();
  var headers = person.sheet.getRange(1, 1, 1, person.sheet.getLastColumn()).getValues()[0];
  var avatarCol = headers.indexOf('avatarUrl');
  if (avatarCol > -1) person.sheet.getRange(person.rowNumber, avatarCol + 1).setValue(url);

  return { ok: true, avatarUrl: url };
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// One-time setup: run manually once from the Apps Script editor.
// Adds the class3 column (المرحلة التحصيلية) to the students sheet if missing.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function ensureClass3Column() {
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (headers.indexOf('class3') === -1) {
    sh.getRange(1, sh.getLastColumn() + 1).setValue('class3');
  }
  return 'تم التأكد من عمود class3 (التحصيلية) في شيت الطلاب';
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// دالة صيانة لمرة واحدة، تُشغَّل يدويًا من محرر Apps Script: تنقل معرّفات قوالب بطاقة الطالب
// الأربعة (كانت مكتوبة حرفيًا بأعلى oldJS.js فقط) إلى عمود cardTemplateId بشيت stages، حتى
// تظهر جاهزة بحقل "قالب بطاقة الطالب" بكل كارت مرحلة بصفحة "إدارة المراحل" — بلا حاجة لإعادة
// كتابتها يدويًا. آمنة التكرار (لا تكتب فوق قيمة موجودة بالفعل بالعمود). راجع مناقشات.md
// "شروط الاجتياز... إدارة القوالب" للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function seedExistingCardTemplateIds() {
  var fallbackCardIds = [cardID00, cardID01, cardID02, cardID03];
  var sh = ensureStagesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var stageCol = headers.indexOf('stageIndex'), cardCol = headers.indexOf('cardTemplateId');
  var lastRow = sh.getLastRow();
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var updated = 0;
  rows.forEach(function (r, i) {
    var stageIndex = +r[stageCol];
    if (r[cardCol] === '' && fallbackCardIds[stageIndex]) {
      sh.getRange(i + 2, cardCol + 1).setValue(fallbackCardIds[stageIndex]);
      updated++;
    }
  });
  return 'تم نسخ ' + updated + ' معرّف قالب لشيت stages (تُرِكت أي قيمة موجودة بالفعل كما هي).';
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// دالة صيانة تُشغَّل يدويًا من محرر Apps Script (وليست من واجهة الموقع): تمر صفًا صفًا على
// شيت الطلاب، وتقرأ رقم المجمع من عمود block، ثم تبحث عن اسم المنطقة الموحّد بنفس الخدمة
// المستخدمة في صفحة التسجيل (lookupBlockArea في dataGet.js)، وتكتبه في عمود area — لتوحيد
// بيانات قديمة كانت المنطقة فيها مكتوبة يدويًا أو بشكل غير متطابق.
//
// بما إنها بتنادي خدمة خارجية لكل صف، ممكن تاخد وقت مع شيت كبير وتتوقف قبل حدّ التنفيذ
// (6 دقائق) — لو حصل كده ببساطة شغّلها تاني وهتكمل تلقائيًا من نفس الصف اللي وقفت عنده
// (نحفظ التقدّم في PropertiesService). لما تكمل كل الصفوف هتوصلك رسالة "اكتمل التصحيح".
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function fixStudentAreasFromBlocks() {
  var props = PropertiesService.getScriptProperties();
  var PROGRESS_KEY = 'fixAreasNextRow_';

  var sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var blockCol = headers.indexOf('block');
  var areaCol = headers.indexOf('area');
  if (blockCol === -1 || areaCol === -1) {
    throw new Error('لم يتم العثور على عمود block أو عمود area في شيت الطلاب');
  }

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 'شيت الطلاب فارغ';

  var startRow = +(props.getProperty(PROGRESS_KEY) || 2);
  if (startRow > lastRow) {
    props.deleteProperty(PROGRESS_KEY);
    return 'اكتمل التصحيح لكل الصفوف بالفعل. شغّل الدالة تاني بعد إضافة صفوف/طلاب جدد لو حبيت تعيد الفحص.';
  }

  var updated = 0, skipped = 0, failed = 0;
  var startTime = Date.now();
  var TIME_LIMIT_MS = 4.5 * 60 * 1000; // هامش أمان قبل حدّ تنفيذ الدوال (6 دقائق)

  var row = startRow;
  for (; row <= lastRow; row++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) break;

    var block = String(sh.getRange(row, blockCol + 1).getValue() || '').trim();
    if (!block) { skipped++; continue; }

    var result = lookupBlockArea(block);
    if (!result || result.error || !result.areaAR) {
      failed++;
      Logger.log('تعذّر إيجاد منطقة للمجمع "' + block + '" (صف ' + row + ')');
      continue;
    }

    var currentArea = sh.getRange(row, areaCol + 1).getValue();
    if (currentArea !== result.areaAR) {
      sh.getRange(row, areaCol + 1).setValue(result.areaAR);
      updated++;
    }
  }

  var summary;
  if (row > lastRow) {
    props.deleteProperty(PROGRESS_KEY);
    summary = 'اكتمل التصحيح لكل الصفوف — تحديث: ' + updated + ' — تعذّر إيجاد منطقة: ' + failed + ' — بدون رقم مجمع: ' + skipped;
  } else {
    props.setProperty(PROGRESS_KEY, String(row));
    summary = 'توقفت مؤقتًا عند الصف ' + row + ' من ' + lastRow + ' (حدّ وقت التنفيذ) — شغّل الدالة تاني للمتابعة تلقائيًا من نفس المكان. تحديث حتى الآن: ' + updated + ' — تعذّر: ' + failed + ' — بدون رقم مجمع: ' + skipped;
  }

  Logger.log(summary);
  return summary;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////
// صيانة لمرة واحدة (2026-08-16): حذف خصائص Script Properties تالفة نتجت عن نداء قديم بـ
// cpr=undefined (أسماء حرفية "...undefined")، اكتُشفت أثناء مراجعة تراكم خصائص otp*/attendDay*
// اللي تجاوزت حد عرض واجهة إعدادات المشروع (50 خاصية). آمنة الحذف تمامًا — لا معنى فعلي لها.
function cleanupUndefinedProps() {
  var props = PropertiesService.getScriptProperties();
  var toDelete = ['otpCount_undefined', 'otpDay_undefined', 'otpLastSent_undefined'];
  toDelete.forEach(function (key) { props.deleteProperty(key); });
  Logger.log('تم حذف: ' + toDelete.join(', '));
}

async function exportNewCard(name, mail, phone, cpr) {
  /* phone = 33229003;
    name = 'zorbeeh';
    mail = 'dfekra@gmail.com';
  */

  // القالب المفعَّل حاليًا من "إدارة القوالب" (تبويب "كروت التهنئة") — كان معرّف السلايد ونص
  // التهنئة مكتوبَين حرفيًا هنا لعيد الفطر 1447 تحديدًا (أي عيد جديد كان يحتاج تعديل هذا الكود
  // نفسه). راجع مناقشات.md "إدارة القوالب" للسياق الكامل.
  var template = getActiveGreetingTemplate_();
  if (!template) throw new Error('لا يوجد قالب تهنئة مفعَّل حاليًا — راجع "إدارة القوالب"');

  // ⚠️ تنبيه: تأكد أن هذا الـ ID يخص ملف عروض تقديمية (Google Slides) وليس مستند (Google Docs)
  var fileIdTemp = template.templateId;
  var targetFolderID = "1qQgSGoFAGbjrwl_UBLLo09zFKa7GflX-";

  var newName = template.name + " - " + name;

  // 1. نسخ قالب السلايد إلى المجلد
  var targetFolder = DriveApp.getFolderById(targetFolderID);
  var slideCopy = DriveApp.getFileById(fileIdTemp).makeCopy(newName, targetFolder);
  
  // 2. فتح السلايد واستبدال الاسم
  var presentation = SlidesApp.openById(slideCopy.getId());
  presentation.replaceAllText("{name}", name);
  presentation.saveAndClose();

  // 3. تحويل الشريحة إلى صورة PNG عالية الجودة برمجياً
  // Local port: render the slide to PNG locally (LibreOffice) instead of the Google export URL, which needed ScriptApp.getOAuthToken().
  var pngBlob = SlidesApp.openById(slideCopy.getId()).getBlob().getAs('image/png');
  var imageBlob = pngBlob.setName(newName + ".png");

  // 4. حفظ الصورة في Google Drive للحصول على الرابط
  var imageFile = targetFolder.createFile(imageBlob);
  shareFileAnyoneWithLink_(imageFile.getId());
  
  var fileId = imageFile.getId();
  // Local file store: use the URL of the image we just created instead of a Google Drive uc?export=view URL.
  var directImageUrl = imageFile.getUrl();
  var finalImageUrl = imageFile.getUrl();

  // 5. حذف ملف السلايد المؤقت للحفاظ على نظافة المجلد (سنبقي الصورة فقط)
  slideCopy.setTrashed(true);

  // 6. إرسال رسالة الواتساب باستخدام الرابط المباشر للصورة
  if (typeof sendWPmsg_ === "function") {
    sendWPmsg_(name, phone, directImageUrl, cpr);
  }

  // 7. إعداد نص البريد الإلكتروني وإرساله (القالب المصمَّم basair-theme-studio)
  var subject = template.subject;
  var plainText = template.body;
  var htmlBody = buildBasairGreetingEmail_(template.name, plainText);

  // نتخطّى البريد فقط إن كان محظورًا (فشل تسليم دائم سابق، راجع emailBounces.js) دون أن يمنع
  // ذلك رسالة الواتساب أعلاه (أُرسلت بالفعل) أو نجاح توليد البطاقة نفسه.
  if (mail && !isEmailBlocked_(mail)) {
    GmailApp.sendEmail(mail, subject, plainText, {
      name: 'بصائر للعلوم الشرعية',
      htmlBody: htmlBody,
      attachments: [imageBlob], // إرفاق صورة تهنئة العيد كملف مباشر في الإيميل
      inlineImages: { basairLogo: getBasairLogoBlob_() }
    });
  }

  var ss = SpreadsheetApp.openById(mainData);
  var sheet = ss.getSheetByName('students');
  var headers = sheet.getRange("1:1").getValues()[0];
  var cprsCol = headers.indexOf('cpr');
  var congratesCol = headers.indexOf('congrates');
  var cprs = sheet.getRange(1,cprsCol+1,sheet.getLastRow(),1).getValues();
  var row = cprs.map(r=> +r[0]).indexOf(+cpr);

// تحديد الخلية المطلوبة في متغير
  var targetCell = sheet.getRange(row + 1, congratesCol + 1);
  
  // جلب القيمة الحالية للخلية (مع التأكد من أنها رقم، ولو كانت فارغة نعتبرها صفر)
  var currentValue = Number(targetCell.getValue()) || 0;
  
  // إضافة 1 على القيمة الحالية ووضعها في الخلية
  targetCell.setValue(currentValue + 1);
  

  // إرجاع رابط الصورة (بدل الـ pdfUrl القديم) لاستخدامه إذا احتجت
  return finalImageUrl;
}

/////////////////////////////////////////////////////////////////////////////////////

/////////////////////////////////////////////////////////////////////////////////////
// templateBody: نص قالب "شهادة اختبار" من messageTemplates (جُلب مرة واحدة خارج الحلقة من
// المستدعي — راجع generatCertificate/generatWrksCertificate)، فارغ = يسقط للنص الاحتياطي
// القديم أدناه كما هو تمامًا. actorCpr: الإداري الذي شغّل عملية إصدار الشهادات (لتسجيله بسجل
// الرسائل — راجع مناقشات.md "إدارة الرسائل").
function sendWPCertificate_(data , pdfUrl, exam, templateBody, actorCpr) {

    var perName = data.name.trim();
    var phoneNumber = data.phone;

    // مصدر واحد للنص الاحتياطي (MESSAGE_TEMPLATE_DEFS_.examCertificate.defaultBody، dataGet.js)
    // — لا نص منفصل مكرَّر هنا، فما يظهر بمنطقة التعديل بالواجهة (قبل أي حفظ) هو نفسه المُرسَل
    // فعليًا حرفيًا، بلا احتمال تضارب مستقبلي بين الاثنين.
    var msg = renderMessageTemplate_(templateBody || MESSAGE_TEMPLATE_DEFS_.examCertificate.defaultBody, { name: perName, exam: exam, pdfUrl: pdfUrl });

      var result;
      try {
        result = sendWPRaw_(toInternationalWhatsAppNumber(phoneNumber), msg);
      } catch (err) {
        result = { status: false, reason: 'خطأ غير متوقع: ' + err.message };
      }
      var ok = !!(result && result.status);

      logWhatsAppMessage_({
        campaignId: '',
        templateKey: 'examCertificate',
        recipientName: perName,
        recipientTarget: phoneNumber,
        targetType: 'phone',
        messageText: msg,
        status: ok ? 'sent' : 'failed',
        reason: ok ? '' : ((result && (result.reason || result.detail)) || 'خطأ غير معروف من خدمة واتساب'),
        sentBy: actorCpr || ''
      });

      return result;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// "كروت التهنئة" ضمن صفحة "إدارة القوالب" — قائمة قابلة للتوسّع (اسم المناسبة، قالب Slides،
// موضوع/نص البريد) بدل معرّف ونص مكتوبَين حرفيًا بالكود لعيد واحد فقط (كانا يحتاجان تعديل هذا
// الملف نفسه لكل عيد جديد). "مفعَّل" حصري لصف واحد فقط في كل مرة — هو ما يُستخدَم فعليًا في
// exportNewCard أعلاه. راجع مناقشات.md "إدارة القوالب" للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function ensureGreetingTemplatesSheet_() {
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('greetingTemplates');
  var wantedCols = ['id', 'name', 'templateId', 'subject', 'body', 'isActive', 'createdAt', 'updatedBy', 'updatedAt'];
  if (!sh) {
    sh = ss.insertSheet('greetingTemplates');
    sh.appendRow(wantedCols);
    return sh;
  }
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var missing = wantedCols.filter(function (c) { return headers.indexOf(c) === -1; });
  if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  return sh;
}

function getGreetingTemplatesList() {
  var sh = ensureGreetingTemplatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return data.filter(function (r) { return r[headers.indexOf('id')] !== ''; }).map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) { var v = r[i]; obj[h] = (v instanceof Date) ? v.toISOString() : v; });
    return obj;
  });
}

function getActiveGreetingTemplate_() {
  return getGreetingTemplatesList().find(function (t) { return t.isActive; }) || null;
}

function saveGreetingTemplate(userCpr, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var name = String(item.name || '').trim();
  if (!name) return { error: true, message: 'اسم المناسبة مطلوب' };
  if (!String(item.templateId || '').trim()) return { error: true, message: 'معرّف القالب مطلوب' };

  var sh = ensureGreetingTemplatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];

  var setByName = function (row, colName, value) {
    var col = headers.indexOf(colName);
    if (col > -1) row[col] = value;
  };

  var id = item.id;
  var rowIdx = id ? rows.findIndex(function (r) { return r[idCol] === id; }) : -1;
  var row = rowIdx > -1 ? rows[rowIdx] : new Array(headers.length).fill('');
  if (rowIdx === -1) { id = Utilities.getUuid(); setByName(row, 'id', id); setByName(row, 'createdAt', new Date()); }

  setByName(row, 'name', name);
  setByName(row, 'templateId', String(item.templateId).trim());
  setByName(row, 'subject', item.subject || '');
  setByName(row, 'body', item.body || '');
  setByName(row, 'isActive', !!item.isActive);
  setByName(row, 'updatedBy', userCpr);
  setByName(row, 'updatedAt', new Date());

  if (rowIdx > -1) {
    sh.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }

  // "مفعَّل" حصري — تفعيل هذا الصف يُلغي تفعيل أي صف آخر تلقائيًا
  if (item.isActive) {
    var activeCol = headers.indexOf('isActive');
    var freshRows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    freshRows.forEach(function (r, i) {
      if (r[idCol] !== id && r[activeCol] === true) sh.getRange(i + 2, activeCol + 1).setValue(false);
    });
  }
  return { ok: true, id: id };
}

function deleteGreetingTemplate(userCpr, id) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var sh = ensureGreetingTemplatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true };
  var ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: true };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// "إدارة الرسائل" — كتابة القوالب/المجموعات/السجل. راجع dataGet.js لدوال القراءة المقابلة
// ولمناقشات.md "إدارة الرسائل" للتصميم الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////
function setWhatsAppProvider(userCpr, provider, firebaseIdToken) {
  if (!requireVerifiedSuperAdmin_(userCpr, firebaseIdToken)) return { error: true, message: 'تعذّر التحقق من جلسة Super Admin؛ أعد تسجيل الدخول ثم حاول مرة أخرى' };
  provider = String(provider || '').toLowerCase();
  if (provider !== 'fonnte' && provider !== 'meta') return { error: true, message: 'مزوّد واتساب غير معروف' };

  if (provider === 'meta') {
    var meta = getMetaWhatsAppConfig_();
    if (!meta.accessToken || !meta.phoneNumberId || !meta.businessAccountId) {
      return { error: true, code: 'META_NOT_CONFIGURED', message: 'أكمل إعداد Meta واحفظ رمز الوصول أولًا' };
    }
  }

  PropertiesService.getScriptProperties().setProperty(WHATSAPP_PROVIDER_PROP_, provider);
  return { ok: true, provider: provider };
}

// يحفظ إعدادات Meta في Script Properties (مخزن أسرار Apps Script)، ولا يعيد الرمز للعميل.
// ترك حقل accessToken فارغًا يعني الاحتفاظ بالرمز الموجود، وليس مسحه عرضًا.
function saveMetaWhatsAppConfiguration(userCpr, settings, firebaseIdToken) {
  if (!requireVerifiedSuperAdmin_(userCpr, firebaseIdToken)) return { error: true, message: 'تعذّر التحقق من جلسة Super Admin؛ أعد تسجيل الدخول ثم حاول مرة أخرى' };
  settings = settings || {};
  var apiVersion = String(settings.apiVersion || META_WA_DEFAULT_API_VERSION_).trim();
  var phoneNumberId = String(settings.phoneNumberId || '').replace(/\D/g, '');
  var businessAccountId = String(settings.businessAccountId || '').replace(/\D/g, '');
  var accessToken = String(settings.accessToken || '').trim();

  if (!/^v\d+\.\d+$/.test(apiVersion)) return { error: true, message: 'صيغة إصدار Graph API غير صحيحة، مثال: v25.0' };
  if (!phoneNumberId) return { error: true, message: 'Phone Number ID مطلوب' };
  if (!businessAccountId) return { error: true, message: 'WhatsApp Business Account ID مطلوب' };

  var props = PropertiesService.getScriptProperties();
  var values = {};
  values[META_WA_API_VERSION_PROP_] = apiVersion;
  values[META_WA_PHONE_NUMBER_ID_PROP_] = phoneNumberId;
  values[META_WA_BUSINESS_ACCOUNT_ID_PROP_] = businessAccountId;
  if (accessToken) values[META_WA_ACCESS_TOKEN_PROP_] = accessToken;
  props.setProperties(values);

  var config = getMetaWhatsAppConfig_();
  return {
    ok: true,
    metaConfigured: !!(config.accessToken && config.phoneNumberId && config.businessAccountId),
    meta: {
      apiVersion: config.apiVersion,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      hasAccessToken: !!config.accessToken
    }
  };
}

// يرسل نص الحملة الحالي إلى Meta كقالب للمراجعة. هذا لا يرسل أي رسالة للطلاب؛ وبعد قبول
// القالب يمكن اختياره بالحملة. يدعم قالب الصفحة الحالي المتغيّر الوحيد {name} الذي يتحول إلى
// {{1}}، وهو نفس ترتيب parameters المستخدم في sendMetaWhatsAppTemplate_ أدناه.
function submitMetaWhatsAppTemplateForReview(userCpr, template, firebaseIdToken) {
  if (!requireVerifiedSuperAdmin_(userCpr, firebaseIdToken)) return { error: true, message: 'تعذّر التحقق من جلسة Super Admin؛ أعد تسجيل الدخول ثم حاول مرة أخرى' };
  template = template || {};
  var name = String(template.name || '').trim().toLowerCase();
  var languageCode = String(template.languageCode || 'ar').trim();
  var category = String(template.category || 'MARKETING').trim().toUpperCase();
  var body = String(template.body || '').trim();
  if (!/^[a-z0-9_]+$/.test(name)) return { error: true, message: 'اسم قالب Meta يجب أن يحتوي حروفًا إنجليزية صغيرة وأرقامًا وشرطة سفلية فقط' };
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)) return { error: true, message: 'رمز لغة القالب غير صحيح' };
  if (['MARKETING', 'UTILITY', 'AUTHENTICATION'].indexOf(category) === -1) return { error: true, message: 'تصنيف قالب Meta غير صحيح' };
  if (!body || body.indexOf('{name}') === -1) return { error: true, message: 'يجب أن يحتوي القالب على {name}' };
  if (body.length > 1024) return { error: true, message: 'نص قالب Meta يتجاوز الحد الأقصى المسموح (1024 حرفًا)' };
  var unknownVars = body.match(/\{(?!name\})[^{}]+\}/g);
  if (unknownVars && unknownVars.length) return { error: true, message: 'القالب يحتوي متغيّرات غير مدعومة: ' + unknownVars.join('، ') };

  var meta = getMetaWhatsAppConfig_();
  if (!meta.accessToken) return { error: true, code: 'META_NOT_CONFIGURED', message: 'رمز وصول Meta غير محفوظ' };
  var metaBody = body.split('{name}').join('{{1}}');
  var payload = {
    name: name,
    language: languageCode,
    category: category,
    components: [{
      type: 'BODY',
      text: metaBody,
      example: { body_text: [['طالبة العلم']] }
    }]
  };
  var result = metaWhatsAppRequest_('/' + meta.businessAccountId + '/message_templates', payload, meta);
  if (!result.status) return { error: true, message: result.reason, httpCode: result.httpCode };
  return { ok: true, id: result.id || '', status: result.templateStatus || 'PENDING', category: result.category || category };
}

// يرسل قالب Meta الثابت الخاص برمز تحقق واتساب (OTP) للمراجعة — فئة AUTHENTICATION الرسمية
// التي تفرضها سياسة Meta لرسائل رموز التحقق (راجع WHATSAPP_CLOUD_API_HANDOFF_AR.md)، منفصل
// عمدًا عن submitMetaWhatsAppTemplateForReview أعلاه (قوالب حملات MARKETING/UTILITY بنص حر).
// لا نص حر هنا بتاتًا: Meta تولّد جملة التحذير بنفسها عبر add_security_recommendation، ولا يوجد
// مكان لتوقيع أو أي نص إضافي. code_expiration_minutes يطابق AUTH_OTP_TTL_SECONDS الفعلي
// (auth.js) حتى لا تتناقض رسالة القالب مع سلوك الخادم الحقيقي إن تغيّرت المدة مستقبلًا.
function submitMetaOtpTemplateForReview(userCpr, firebaseIdToken) {
  if (!requireVerifiedSuperAdmin_(userCpr, firebaseIdToken)) return { error: true, message: 'تعذّر التحقق من جلسة Super Admin؛ أعد تسجيل الدخول ثم حاول مرة أخرى' };
  var meta = getMetaWhatsAppConfig_();
  if (!meta.accessToken) return { error: true, code: 'META_NOT_CONFIGURED', message: 'رمز وصول Meta غير محفوظ' };
  var payload = {
    name: META_WA_OTP_TEMPLATE_NAME_,
    language: META_WA_OTP_TEMPLATE_LANGUAGE_,
    category: 'AUTHENTICATION',
    components: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: Math.max(1, Math.round(AUTH_OTP_TTL_SECONDS / 60)) },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'نسخ الرمز' }] }
    ]
  };
  var result = metaWhatsAppRequest_('/' + meta.businessAccountId + '/message_templates', payload, meta);
  if (!result.status) return { error: true, message: result.reason, httpCode: result.httpCode };
  return { ok: true, id: result.id || '', status: result.templateStatus || 'PENDING', category: result.category || 'AUTHENTICATION' };
}

// مزوّد رمز التحقق (OTP) عبر واتساب — منفصل عمدًا عن setWhatsAppProvider (مزوّد الحملات) لأن
// مسار الدخول لا يجوز أن يتأثر بتبديل يخص الحملات فقط. يرفض التفعيل إن لم يكن قالب
// AUTHENTICATION المعتمد (META_WA_OTP_TEMPLATE_NAME_) بحالة APPROVED فعليًا لدى Meta، حتى لا
// ينقطع دخول الطلاب فجأة بقالب لم توافق عليه Meta بعد.
function setOtpWhatsAppProvider(userCpr, provider, firebaseIdToken) {
  if (!requireVerifiedSuperAdmin_(userCpr, firebaseIdToken)) return { error: true, message: 'تعذّر التحقق من جلسة Super Admin؛ أعد تسجيل الدخول ثم حاول مرة أخرى' };
  provider = String(provider || '').toLowerCase();
  if (provider !== 'fonnte' && provider !== 'meta') return { error: true, message: 'مزوّد واتساب غير معروف' };

  if (provider === 'meta') {
    var meta = getMetaWhatsAppConfig_();
    if (!meta.accessToken || !meta.phoneNumberId || !meta.businessAccountId) {
      return { error: true, code: 'META_NOT_CONFIGURED', message: 'أكمل إعداد Meta واحفظ رمز الوصول أولًا' };
    }
    var status = getMetaWhatsAppTemplateStatus(userCpr, META_WA_OTP_TEMPLATE_NAME_, META_WA_OTP_TEMPLATE_LANGUAGE_, firebaseIdToken);
    if (status.error) return status;
    if (!status.exists || status.status !== 'APPROVED') {
      return { error: true, message: 'قالب رمز التحقق (' + META_WA_OTP_TEMPLATE_NAME_ + ') غير معتمد بعد لدى Meta؛ لا يمكن التفعيل قبل اعتماده.' };
    }
  }

  PropertiesService.getScriptProperties().setProperty(OTP_WHATSAPP_PROVIDER_PROP_, provider);
  return { ok: true, provider: provider };
}

// فحص صريح لحالة قالب Meta من الواجهة. يفيد أيضًا بعد انقطاع/تأخر رد إنشاء القالب، حتى لا
// يكرر الإداري طلب الإنشاء لمجرد أن إشعار المتصفح لم يظهر.
function getMetaWhatsAppTemplateStatus(userCpr, templateName, languageCode, firebaseIdToken) {
  if (!requireVerifiedSuperAdmin_(userCpr, firebaseIdToken)) {
    return { error: true, message: 'تعذّر التحقق من جلسة Super Admin؛ أعد تسجيل الدخول ثم حاول مرة أخرى' };
  }
  templateName = String(templateName || '').trim().toLowerCase();
  languageCode = String(languageCode || 'ar').trim();
  if (!/^[a-z0-9_]+$/.test(templateName)) return { error: true, message: 'اسم قالب Meta غير صالح' };
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)) return { error: true, message: 'رمز لغة القالب غير صحيح' };

  var config = getMetaWhatsAppConfig_();
  if (!config.accessToken || !config.businessAccountId) return { error: true, message: 'إعداد Meta غير مكتمل' };
  var url = 'https://graph.facebook.com/' + encodeURIComponent(config.apiVersion) + '/' + config.businessAccountId +
    '/message_templates?name=' + encodeURIComponent(templateName) + '&fields=id,name,status,language,category';
  try {
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
    var templates = Array.isArray(data.data) ? data.data : [];
    var found = templates.find(function (item) {
      return item && item.name === templateName && String(item.language || '') === languageCode;
    });
    if (!found) return { ok: true, exists: false, name: templateName, language: languageCode, status: 'NOT_FOUND' };
    return {
      ok: true,
      exists: true,
      id: found.id || '',
      name: found.name || templateName,
      language: found.language || languageCode,
      status: String(found.status || 'UNKNOWN').toUpperCase(),
      category: found.category || ''
    };
  } catch (err) {
    return { error: true, message: 'تعذّر فحص حالة قالب Meta: ' + err.message };
  }
}

function saveMessageTemplate(userCpr, key, body) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  if (!MESSAGE_TEMPLATE_DEFS_[key]) return { error: true, message: 'قالب غير معروف' };
  body = String(body || '');

  var missingVars = MESSAGE_TEMPLATE_DEFS_[key].requiredVars.filter(function (v) { return body.indexOf(v) === -1; });
  if (missingVars.length) return { error: true, message: 'النص لا يحتوي المتغيّرات الإلزامية التالية: ' + missingVars.join('، ') };

  var sh = ensureMessageTemplatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var keyCol = headers.indexOf('key');
  var lastRow = sh.getLastRow();
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
  var rowIdx = rows.findIndex(function (r) { return r[keyCol] === key; });

  var setByName = function (row, name, value) { var col = headers.indexOf(name); if (col > -1) row[col] = value; };
  var row = rowIdx > -1 ? rows[rowIdx] : new Array(headers.length).fill('');
  setByName(row, 'key', key);
  setByName(row, 'body', body);
  setByName(row, 'updatedBy', userCpr);
  setByName(row, 'updatedAt', new Date());

  if (rowIdx > -1) sh.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true };
}

// حفظ/تحديث توكن جهاز طالب (يُستدعى من handleSaveFcmTokenRequest_ في FCMService.js، بعد التحقق
// من وجود الرقم الشخصي فعليًا في شيت students). نفس نمط upsert-by-key المستخدم في
// saveWhatsappGroup أسفل هذه الدالة، لكن المفتاح هنا cpr بدل id.
function saveStudentToken_(cpr, token) {
  var sh = ensureFcmTokensSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var lastRow = sh.getLastRow();
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
  var setByName = function (row, colName, value) { var col = headers.indexOf(colName); if (col > -1) row[col] = value; };
  var rowIdx = rows.findIndex(function (r) { return cprEquals_(r[cprCol], cpr); });
  var row = rowIdx > -1 ? rows[rowIdx] : new Array(headers.length).fill('');
  if (rowIdx === -1) setByName(row, 'createdAt', new Date());
  setByName(row, 'cpr', cpr);
  setByName(row, 'token', token);
  setByName(row, 'updatedAt', new Date());
  if (rowIdx > -1) sh.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true };
}

// حذف توكن غير صالح (يُستدعى تلقائيًا من sendFcmNotification_ في FCMService.js عند رد
// UNREGISTERED/INVALID_ARGUMENT من FCM). يحذف كل الصفوف المطابقة لا أول صف فقط — نفس التوكن قد
// يتكرر بأكثر من صف (أكثر من طالب مسجَّل على نفس الجهاز، راجع saveStudentToken_)، فلو تُرك جهاز
// واحد ملغيًا (مثلًا الطالب مسح بيانات المتصفح) وحُذف صف واحد بس، يظل الطالب الآخر على نفس
// الجهاز يحمل توكنًا ميتًا يفشل بصمت للأبد بلا تنظيف. الحذف من الأسفل للأعلى يتفادى انزياح
// أرقام الصفوف أثناء الحذف المتكرر.
function removeFcmToken_(token) {
  var sh = ensureFcmTokensSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var tokenCol = headers.indexOf('token');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i][tokenCol] === token) sh.deleteRow(i + 2);
  }
}

function saveWhatsappGroup(userCpr, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var name = String(item.name || '').trim();
  var groupId = String(item.groupId || '').trim();
  if (!name) return { error: true, message: 'اسم المجموعة مطلوب' };
  if (!groupId) return { error: true, message: 'معرّف المجموعة مطلوب' };
  if (groupId.indexOf('@g.us') === -1) return { error: true, message: 'صيغة معرّف المجموعة غير صحيحة — يجب أن تنتهي بـ@g.us' };

  var sh = ensureWhatsappGroupsSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];

  var setByName = function (row, colName, value) { var col = headers.indexOf(colName); if (col > -1) row[col] = value; };

  var id = item.id;
  var rowIdx = id ? rows.findIndex(function (r) { return r[idCol] === id; }) : -1;
  var row = rowIdx > -1 ? rows[rowIdx] : new Array(headers.length).fill('');
  if (rowIdx === -1) { id = Utilities.getUuid(); setByName(row, 'id', id); setByName(row, 'createdAt', new Date()); }

  setByName(row, 'name', name);
  setByName(row, 'groupId', groupId);
  setByName(row, 'updatedBy', userCpr);
  setByName(row, 'updatedAt', new Date());

  if (rowIdx > -1) sh.getRange(rowIdx + 2, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
  return { ok: true, id: id };
}

function deleteWhatsappGroup(userCpr, id) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var sh = ensureWhatsappGroupsSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true };
  var ids = sh.getRange(2, idCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: true };
}

//////////////////////////////////////////////////////////////////////////////////////////////
// اكتشاف مجموعات واتساب الحقيقية التي رقم الأكاديمية عضو فيها فعليًا — عبر Fonnte، لا إدخال
// يدوي فقط. تحقّقنا من توثيق Fonnte الرسمي: يلزم استدعاءان منفصلان:
//  1) fetch-group — يطلب من واتساب نفسه تحديث قائمة المجموعات لدى Fonnte. توثيق Fonnte يحذّر
//     صراحةً: "should called only once: when you are joining new group or never call this API
//     yet" و"abusing this API may lead to whatsapp number ban" — لذا نادر ومتعمَّد فقط، بضغطة
//     زر إدارية صريحة (refreshWhatsappGroupsFromFonnte)، أبدًا تلقائيًا.
//  2) get-whatsapp-group — قراءة فقط لقائمة Fonnte المخزَّنة لديه بالفعل (لا تطلب من واتساب من
//     جديد)، آمنة للاستدعاء المتكرر (getWhatsappGroupsFromFonnte) — هذه ما تُستخدَم فعليًا
//     لتعبئة قائمة الاختيار بصفحة "إرسال رسالة جماعية".
// النتيجة تُزامَن (upsert بمعرّف المجموعة) مع شيت whatsappGroups المحلي — يحافظ على اسم مستقر
// بسجل الرسائل حتى لو غادر رقم الأكاديمية المجموعة لاحقًا، ويجنّب استدعاء Fonnte عند كل فتح
// للصفحة. راجع مناقشات.md "إدارة الرسائل".
//////////////////////////////////////////////////////////////////////////////////////////////
function refreshWhatsappGroupsFromFonnte(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  try {
    var response = UrlFetchApp.fetch('https://api.fonnte.com/fetch-group', {
      method: 'POST',
      headers: headersForWatsapp,
      muteHttpExceptions: true
    });
    var result = JSON.parse(response.getContentText());
    if (!result || result.status !== true) {
      return { error: true, message: (result && result.detail) || 'تعذّر تحديث قائمة المجموعات من واتساب' };
    }
    return { ok: true };
  } catch (err) {
    return { error: true, message: 'تعذّر الاتصال بخدمة واتساب: ' + err.message };
  }
}

function getWhatsappGroupsFromFonnte(userCpr) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  try {
    var response = UrlFetchApp.fetch('https://api.fonnte.com/get-whatsapp-group', {
      method: 'POST',
      headers: headersForWatsapp,
      muteHttpExceptions: true
    });
    var result = JSON.parse(response.getContentText());
    if (!result || result.status !== true) {
      return { error: true, message: (result && result.detail) || 'لم يتم تحديث قائمة المجموعات من واتساب بعد — استخدم زر "تحديث القائمة من واتساب" أولًا' };
    }
    var groups = (result.data || []).map(function (g) { return { id: g.id, name: g.name }; });
    syncWhatsappGroupsFromFonnte_(groups, userCpr);
    return groups;
  } catch (err) {
    return { error: true, message: 'تعذّر الاتصال بخدمة واتساب: ' + err.message };
  }
}

function syncWhatsappGroupsFromFonnte_(groups, userCpr) {
  try {
    var sh = ensureWhatsappGroupsSheet_();
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var idCol = headers.indexOf('id'), groupIdCol = headers.indexOf('groupId'), nameCol = headers.indexOf('name');
    var lastRow = sh.getLastRow();
    var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
    var byGroupId = {};
    rows.forEach(function (r, i) { byGroupId[r[groupIdCol]] = i; });

    groups.forEach(function (g) {
      if (byGroupId[g.id] !== undefined) {
        var i = byGroupId[g.id];
        if (rows[i][nameCol] !== g.name) {
          sh.getRange(i + 2, nameCol + 1).setValue(g.name);
          sh.getRange(i + 2, headers.indexOf('updatedAt') + 1).setValue(new Date());
        }
      } else {
        var newRow = new Array(headers.length).fill('');
        newRow[idCol] = Utilities.getUuid();
        newRow[nameCol] = g.name;
        newRow[groupIdCol] = g.id;
        newRow[headers.indexOf('createdAt')] = new Date();
        newRow[headers.indexOf('updatedBy')] = userCpr;
        newRow[headers.indexOf('updatedAt')] = new Date();
        sh.appendRow(newRow);
      }
    });
  } catch (err) {
    Logger.log('تعذّر مزامنة مجموعات واتساب: ' + err);
  }
}

// استبدال بسيط لمتغيّرات قالب رسالة، مثل {name}/{exam}/{pdfUrl} — راجع MESSAGE_TEMPLATE_DEFS_
// (dataGet.js) لمتغيّرات كل قالب. لا معالجة خاصة لأقواس متداخلة أو حالات استثنائية — القوالب كلها
// نصوص بسيطة أحادية المستوى بالتصميم.
function renderMessageTemplate_(body, vars) {
  var text = String(body || '');
  Object.keys(vars || {}).forEach(function (k) {
    text = text.split('{' + k + '}').join(vars[k] == null ? '' : String(vars[k]));
  });
  return text;
}

// المنسّق الكامل لتبويب "إرسال رسالة جماعية" بـ"إدارة الرسائل" — يستقبل قائمة مستلمين جاهزة
// (بعد أي تحديد/فلترة حدثت بالفعل بالعميل، بنفس نمط الصفحات الإدارية الأخرى)، يخصّص كل رسالة
// باسم مستلمها الأول (إلزامي للأفراد، حماية من حظر واتساب)، ثم يُسلِّمها لـscheduleWPQueueSend_
// (wpQueue.js). راجع مناقشات.md "إدارة الرسائل" للتصميم الكامل.
//
// params: { targetType: 'students'|'staff'|'groups',
//   recipients: [{name, phone}] لـstudents/staff أو [{name, groupId}] لـgroups,
//   message: نص حر لازم يحتوي {name} لغير المجموعات,
//   metaTemplateName/metaLanguageCode عند اختيار Meta,
//   batchSize, perMessageDelaySec, betweenBatchesSec, scheduledAt }
function prepareAndScheduleBroadcast(userCpr, params) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  params = params || {};
  var isGroup = params.targetType === 'groups';
  // مع Fonnte يُسمح بالمجموعات فقط؛ الأفراد (طلاب/موظفين) لا يُرسَل إليهم إلا عبر Meta.
  if (!isGroup && !isIndividualBroadcastAllowedForActiveProvider_()) return { error: true, message: BROADCAST_INDIVIDUALS_DISABLED_FONNTE_MESSAGE_ };
  var recipients = Array.isArray(params.recipients) ? params.recipients : [];
  var message = String(params.message || '').trim();
  // لا نثق في قيمة مزوّد قادمة من المتصفح؛ الخيار الفعلي المحفوظ مركزيًا هو المرجع الوحيد.
  var provider = getActiveWhatsAppProvider_();
  var metaTemplateName = String(params.metaTemplateName || '').trim().toLowerCase();
  var metaLanguageCode = String(params.metaLanguageCode || 'ar').trim();

  if (!message) return { error: true, message: 'لا يمكن إرسال رسالة فارغة' };
  if (recipients.length < 1) return { error: true, message: 'لا يوجد مستلمون لإرسال الرسالة إليهم' };
  if (!isGroup && message.indexOf('{name}') === -1) {
    return { error: true, message: 'يجب أن يحتوي نص الرسالة على {name} لتخصيصها باسم كل مستلم — إجراء حماية من حظر واتساب.' };
  }
  if (provider === 'meta') {
    var meta = getMetaWhatsAppConfig_();
    if (!meta.accessToken || !meta.phoneNumberId) return { error: true, message: 'إعداد Meta غير مكتمل؛ اطلب من Super Admin حفظ رمز الوصول أولًا' };
    if (isGroup) return { error: true, message: 'Meta Cloud API الرسمي لا يدعم الإرسال إلى مجموعات واتساب؛ اختر الطلاب أو الموظفين، أو بدّل إلى Fonnte' };
    if (!/^[a-z0-9_]+$/.test(metaTemplateName)) return { error: true, message: 'اسم قالب Meta غير صحيح' };
    if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(metaLanguageCode)) return { error: true, message: 'رمز لغة قالب Meta غير صحيح' };
    var templateCheck = validateMetaWhatsAppBroadcastTemplate_(metaTemplateName, metaLanguageCode, message);
    if (!templateCheck.ok) return { error: true, message: templateCheck.reason };
  }

  var rows = recipients.map(function (r) {
    var target = isGroup ? r.groupId : r.phone;
    var firstName = firstNameOnly_(r.name || '');
    var personalizedMsg = isGroup ? message : renderMessageTemplate_(message, { name: firstName });
    return {
      name: r.name || '',
      target: target,
      targetType: isGroup ? 'group' : 'phone',
      message: personalizedMsg,
      provider: provider,
      metaTemplateName: provider === 'meta' ? metaTemplateName : '',
      metaLanguageCode: provider === 'meta' ? metaLanguageCode : '',
      metaBodyParams: provider === 'meta' ? [firstName] : []
    };
  }).filter(function (r) { return r.target; });

  if (rows.length < 1) return { error: true, message: 'لا يوجد أرقام/معرّفات صالحة ضمن المستلمين المحدَّدين' };

  return scheduleWPQueueSend_(rows, {
    batchSize: params.batchSize,
    perMessageDelaySec: params.perMessageDelaySec,
    betweenBatchesSec: params.betweenBatchesSec,
    scheduledAt: params.scheduledAt,
    sentBy: userCpr,
    templateKey: 'broadcast',
    provider: provider,
    metaTemplateName: provider === 'meta' ? metaTemplateName : '',
    metaLanguageCode: provider === 'meta' ? metaLanguageCode : ''
  });
}

// تسجيل رسالة واتساب واحدة بالسجل الدائم — تُستدعى بعد كل محاولة إرسال فعلية (نجحت أو فشلت)
// من كل نقاط الإرسال بالمشروع. مغلَّفة بالكامل بحيث لو فشل التسجيل نفسه لأي سبب، لا يوقف أو
// يُفشل الإرسال الفعلي إطلاقًا — الإرسال دائمًا أهم من تسجيله.
function logWhatsAppMessage_(entry) {
  try {
    var sh = ensureMessageLogSheet_();
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var row = headers.map(function (h) {
      if (h === 'id') return Utilities.getUuid();
      if (h === 'sentAt') return new Date();
      return entry[h] !== undefined && entry[h] !== null ? entry[h] : '';
    });
    sh.appendRow(row);
  } catch (err) {
    Logger.log('تعذّر تسجيل رسالة واتساب بالسجل: ' + err);
  }
}

/////////////////////////////////////////////////////////////////////////////////////
// النص كان مكتوبًا حرفيًا لعيد الأضحى 1446 تحديدًا (بلا صلة بقالب "كروت التهنئة" المرئي القابل
// للتعديل من "إدارة القوالب") — أصبح الآن يقرأ من قالب "كارت التهنئة" بـ"إدارة الرسائل"، مع
// سقوط احتياطي لنفس النص القديم حرفيًا لو لم يُعَدّ القالب بعد. actorCpr: الطالب نفسه (يُصدر
// كارته الخاص). راجع مناقشات.md "إدارة الرسائل".
function sendWPmsg_(name , phone , pdfUrl, actorCpr) {

    var perName = name.trim();
    var phoneNumber = phone;
    var newName = "تهنئة - "+name;
    var templateBody = getActiveMessageTemplateBody_('greetingCard');
    // مصدر واحد للنص الاحتياطي — راجع نفس التعليق بـsendWPCertificate_ أعلاه.
    var msg = renderMessageTemplate_(templateBody || MESSAGE_TEMPLATE_DEFS_.greetingCard.defaultBody, { name: perName, pdfUrl: pdfUrl });

    var result;
    try {
      result = sendWPRaw_(toInternationalWhatsAppNumber(phoneNumber), msg, null, { url: pdfUrl, filename: newName });
    } catch (err) {
      result = { status: false, reason: 'خطأ غير متوقع: ' + err.message };
    }
    var ok = !!(result && result.status);

    logWhatsAppMessage_({
      campaignId: '',
      templateKey: 'greetingCard',
      recipientName: perName,
      recipientTarget: phoneNumber,
      targetType: 'phone',
      messageText: msg,
      status: ok ? 'sent' : 'failed',
      reason: ok ? '' : ((result && (result.reason || result.detail)) || 'خطأ غير معروف من خدمة واتساب'),
      sentBy: actorCpr || ''
    });

    return result;
}

/////////////////////////////////////////////////////////////////////////////////////
/* {"detail":"success! message in queue","id":["124251316"],"process":"pending","quota":{"97334440790":{"details":"deduced from total quota","quota":998,"remaining":997,"used":1}},"requestid":126176695,"status":true,"target":["97333229003"]} */
/////////////////////////////////////////////////////////////////////////////////////
function sendGeneralWPmsg_(phone , msg) {
    return sendWPRaw_(toInternationalWhatsAppNumber(phone), msg, '4-8');
}

function metaWhatsAppErrorReason_(httpCode, data) {
  var error = data && data.error ? data.error : {};
  var detail = error.error_data && error.error_data.details ? error.error_data.details : '';
  var parts = [];
  [error.error_user_title, error.error_user_msg, detail, error.message].forEach(function (value) {
    value = String(value || '').trim();
    if (value && parts.indexOf(value) === -1) parts.push(value);
  });
  var base = parts.length ? parts.join(' — ') : 'رد غير معروف من Meta';
  var graphCodes = [];
  if (error.code !== undefined && error.code !== null) graphCodes.push('code ' + error.code);
  if (error.error_subcode !== undefined && error.error_subcode !== null) graphCodes.push('subcode ' + error.error_subcode);
  if (graphCodes.length) base += ' [' + graphCodes.join(', ') + ']';
  var prefix = {
    400: 'رفضت Meta بيانات الرسالة',
    401: 'رمز وصول Meta غير صالح أو منتهي',
    403: 'رمز Meta لا يملك صلاحية الإرسال المطلوبة',
    429: 'تم بلوغ حد الإرسال لدى Meta مؤقتًا'
  }[httpCode] || (httpCode >= 500 ? 'خدمة Meta غير متاحة مؤقتًا' : 'فشل طلب Meta');
  return prefix + ' (HTTP ' + httpCode + '): ' + base;
}

// طلب Graph API مشترك لإنشاء القوالب وإرسالها. accessToken لا يُسجَّل ولا يدخل في نص الخطأ.
function metaWhatsAppRequest_(path, payload, config) {
  config = config || getMetaWhatsAppConfig_();
  if (!config.accessToken) return { status: false, httpCode: 0, reason: 'رمز وصول Meta غير محفوظ' };
  var url = 'https://graph.facebook.com/' + encodeURIComponent(config.apiVersion) + path;
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'POST',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + config.accessToken },
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    var httpCode = response.getResponseCode();
    var data;
    try { data = JSON.parse(response.getContentText()); }
    catch (parseErr) { data = {}; }
    if (httpCode < 200 || httpCode >= 300) {
      return { status: false, httpCode: httpCode, reason: metaWhatsAppErrorReason_(httpCode, data) };
    }
    var messageId = data.messages && data.messages[0] ? data.messages[0].id : '';
    return {
      status: true,
      provider: 'meta',
      httpCode: httpCode,
      id: messageId || data.id || '',
      messageId: messageId,
      templateStatus: data.status || '',
      category: data.category || ''
    };
  } catch (err) {
    return { status: false, provider: 'meta', httpCode: 0, reason: 'تعذّر الاتصال بخدمة Meta: ' + err.message };
  }
}

function sendMetaWhatsAppTemplate_(target, templateName, languageCode, bodyParameters) {
  var config = getMetaWhatsAppConfig_();
  if (!config.accessToken || !config.phoneNumberId) {
    return { status: false, provider: 'meta', reason: 'إعداد Meta غير مكتمل أو رمز الوصول غير محفوظ' };
  }
  var finalTarget = String(target || '').replace(/\D/g, '');
  if (!finalTarget) return { status: false, provider: 'meta', reason: 'رقم المستلم غير صالح لـMeta' };
  if (!/^[a-z0-9_]+$/.test(String(templateName || ''))) {
    return { status: false, provider: 'meta', reason: 'اسم قالب Meta غير صالح' };
  }

  var params = Array.isArray(bodyParameters) ? bodyParameters : [];
  var template = {
    name: templateName,
    language: { code: languageCode || 'ar' }
  };
  if (params.length) {
    template.components = [{
      type: 'body',
      parameters: params.map(function (value) { return { type: 'text', text: String(value == null ? '' : value) }; })
    }];
  }
  var payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: finalTarget,
    type: 'template',
    template: template
  };
  return metaWhatsAppRequest_('/' + config.phoneNumberId + '/messages', payload, config);
}

// يرسل رمز تحقق فعليًا عبر قالب Meta الثابت AUTHENTICATION (META_WA_OTP_TEMPLATE_NAME_) —
// مستدعاة من sendOtpCode_ (auth.js) عند اختيار Super Admin مزوّد Meta لرمز التحقق. منفصلة عمدًا
// عن sendMetaWhatsAppTemplate_ أعلاه (المستخدمة في الحملات ولا تدعم مكوّن زر copy_code)، لتفادي
// أي تعديل قد يمسّ مسار الحملات الجاري تشغيله فعليًا. زر OTP من نوع COPY_CODE يحتاج مكوّن
// button/copy_code إضافيًا بنفس قيمة الرمز، طبقًا لصيغة Meta الرسمية لقوالب Authentication.
function sendMetaOtpTemplate_(target, code) {
  var config = getMetaWhatsAppConfig_();
  if (!config.accessToken || !config.phoneNumberId) {
    return { status: false, provider: 'meta', reason: 'إعداد Meta غير مكتمل أو رمز الوصول غير محفوظ' };
  }
  var finalTarget = String(target || '').replace(/\D/g, '');
  if (!finalTarget) return { status: false, provider: 'meta', reason: 'رقم المستلم غير صالح لـMeta' };
  var codeStr = String(code || '');
  var payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: finalTarget,
    type: 'template',
    template: {
      name: META_WA_OTP_TEMPLATE_NAME_,
      language: { code: META_WA_OTP_TEMPLATE_LANGUAGE_ },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: codeStr }] },
        { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: codeStr }] }
      ]
    }
  };
  return metaWhatsAppRequest_('/' + config.phoneNumberId + '/messages', payload, config);
}

// فحص قبل جدولة الحملة يمنع أخطر التباس في واجهة Meta: أن يكتب الإداري نصًا جديدًا لكن يضع
// اسم قالب قديم، فتُرسل Meta محتوى القالب القديم بينما يعرض التأكيد/السجل النص الجديد. نتحقق
// مرة واحدة من وجود القالب، واعتماده، ولغته، وتطابق جسمه حرفيًا بعد تحويل {name} إلى {{1}}.
function validateMetaWhatsAppBroadcastTemplate_(templateName, languageCode, previewBody) {
  var config = getMetaWhatsAppConfig_();
  if (!config.accessToken || !config.businessAccountId) return { ok: false, reason: 'إعداد Meta غير مكتمل' };
  var url = 'https://graph.facebook.com/' + encodeURIComponent(config.apiVersion) + '/' + config.businessAccountId +
    '/message_templates?name=' + encodeURIComponent(templateName) + '&fields=name,status,language,category,components';
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + config.accessToken },
      muteHttpExceptions: true
    });
    var httpCode = response.getResponseCode();
    var data;
    try { data = JSON.parse(response.getContentText()); } catch (parseErr) { data = {}; }
    if (httpCode < 200 || httpCode >= 300) return { ok: false, reason: metaWhatsAppErrorReason_(httpCode, data) };
    var candidates = Array.isArray(data.data) ? data.data : [];
    var template = candidates.find(function (item) {
      return item && item.name === templateName && String(item.language || '') === String(languageCode || 'ar');
    });
    if (!template) return { ok: false, reason: 'لم يُعثر في Meta على القالب ' + templateName + ' باللغة ' + languageCode };
    if (String(template.status || '').toUpperCase() !== 'APPROVED') {
      return { ok: false, reason: 'قالب Meta غير معتمد بعد؛ حالته الحالية: ' + (template.status || 'غير معروفة') };
    }
    var components = Array.isArray(template.components) ? template.components : [];
    var bodyComponent = components.find(function (component) { return String(component.type || '').toUpperCase() === 'BODY'; });
    var approvedBody = bodyComponent ? String(bodyComponent.text || '') : '';
    var expectedBody = String(previewBody || '').split('{name}').join('{{1}}');
    var normalizeBody = function (value) { return String(value || '').replace(/\r\n/g, '\n').trim(); };
    if (normalizeBody(approvedBody) !== normalizeBody(expectedBody)) {
      return { ok: false, reason: 'نص الصفحة لا يطابق نص قالب Meta المعتمد. أرسل النص الحالي للمراجعة باسم جديد أو أعد النص المطابق للقالب.' };
    }
    return { ok: true, templateId: template.id || '', category: template.category || '' };
  } catch (err) {
    return { ok: false, reason: 'تعذّر فحص قالب Meta قبل الإرسال: ' + err.message };
  }
}

// نداء واتساب الخام. المسارات القديمة تظل على Fonnte حفاظًا على توافق الرسائل التلقائية؛
// حملات صفحة الرسائل تمرّر delivery.provider صراحةً، بعد أن ثبّت الخادم اختيار المزوّد عند
// إنشاء الحملة. extra خاص بمرفقات Fonnte، وdelivery خاص ببيانات قالب Meta ولا يُرسل إلى Fonnte.
function sendWPRaw_(target, msg, delay, extra, delivery) {
    delivery = delivery || {};
    if (delivery.provider === 'meta') {
      if (String(target || '').indexOf('@g.us') !== -1) {
        return { status: false, provider: 'meta', reason: 'Meta Cloud API الرسمي لا يدعم الإرسال إلى مجموعات واتساب' };
      }
      return sendMetaWhatsAppTemplate_(target, delivery.metaTemplateName, delivery.metaLanguageCode, delivery.metaBodyParams);
    }

    // countryCode: '0' إلزامي — Fonnte تفترض افتراضيًا (بلا هذا المعامل) أن الرقم "محلي" بمعيار
    // إندونيسيا (كود 62) وتُلصقه بمقدمة أي رقم لا تتعرّف عليه بثقة كرقم دولي كامل، حتى لو كان
    // بالفعل رقمًا دوليًا صحيحًا تمامًا بمقدمته رمز دولة آخر (بحرين 973 هنا) — يُنتج رقمًا فاسدًا
    // مثل "62973xxxxxxxx". اكتُشف فعليًا بطلب المستخدم بعد ملاحظته أرقامًا وصلت بمقدمة "62"
    // زائدة. راجع توثيق Fonnte الرسمي (api-send-message) ومناقشات.md "إدارة الرسائل". نحن
    // نبني الرقم الدولي الكامل بأنفسنا أصلًا (toInternationalWhatsAppNumber)، فلا حاجة إطلاقًا
    // لتدخّل Fonnte التلقائي هذا — يُعطَّل هنا مرة واحدة لكل نداء يمرّ عبر هذه الدالة المشتركة.
    const requestBody = { 'target': target, 'message': msg, 'countryCode': '0' };
    if (delay) requestBody.delay = delay;
    if (extra) Object.keys(extra).forEach(function (k) { requestBody[k] = extra[k]; });
    var bodyMessage = JSON.stringify(requestBody);
    try {
        var response = UrlFetchApp.fetch('https://api.fonnte.com/send',
          {
            method: 'POST',
            payload: bodyMessage,
            headers: headersForWatsapp,
            contentType: "application/json",
            muteHttpExceptions: true
          });
        Logger.log(response);
        var code = response.getResponseCode();
        var result;
        try {
          result = JSON.parse(response.getContentText());
        } catch (parseErr) {
          return { status: false, reason: 'ردّ غير مفهوم من خدمة واتساب (كود ' + code + '): ' + response.getContentText() };
        }
        if (code < 200 || code >= 300) {
          result.status = false;
          result.reason = result.reason || result.detail || ('فشل الطلب لدى خدمة واتساب (كود ' + code + ')');
        }
        result.provider = 'fonnte';
        return result;
      } catch (err) {
        return { status: false, provider: 'fonnte', reason: 'تعذّر الاتصال بخدمة واتساب: ' + err.message };
      }
}

/////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////
function sendFinishedMail(exam) {

    /*GmailApp.sendEmail(mail, "الانتهاء من إصدار شهادات"+exam, "null", {
      name: "بصائر للعلوم الشرعية",
      htmlBody: msg,
      }); */

    GmailApp.sendEmail('dfekra@gmail.com', 'basaer Certificates', 'تم الانتهاء من إصدار شهادات بصائر  -  ' + exam);

}


//////////////////////////////////////////////////////////////////////////////////////////////////////////
function exportCert_(exam, student, tempFileId, stuFolderID) {

  const code = `BAS-${exam}-${student.cpr}`;

  // نسخة القالب
  const cardFile = DriveApp.getFileById(tempFileId).makeCopy(DriveApp.getFolderById(tempFolderID));
  const doc = DocumentApp.openById(cardFile.getId());
  const body = doc.getBody();


  if (student.matn !== '') {
    body.replaceText("{matn}", '\r\nكما اجتاز{g2} تسميع المتن وحصل على تقدير ');
    body.replaceText("{matnD}", student.matn);
  } 
  else if (student.lecAttend) {
    body.replaceText("{matn}", '\r\nكما حضر{g2} الدورة المكثفة في شرح الكتاب بتاريخ ');
    body.replaceText("{matnD}", /* student.lecAttend+'-----'+ */toHindiNumbers_('8 جمادى الآخرة 1447 هـ'));
  } 
  else {
    body.replaceText("{matn}", '');
    body.replaceText("{matnD}", '');
  }

  body.replaceText("{name}", student.name);
  body.replaceText("{rate}", student.rate);
  body.replaceText("{g1}", student.gender == 'أنثى' ? 'ة' : '');
  body.replaceText("{g2}", student.gender == 'أنثى' ? 'ت' : '');
  body.replaceText("{code}", code);
  doc.saveAndClose();

  // تحويل PDF
  const stuFolder = DriveApp.getFolderById(stuFolderID);
  const pdfBlob = DriveApp.getFileById(cardFile.getId()).getBlob().getAs('application/pdf');
  const pdf = stuFolder.createFile(pdfBlob);
  const pdfId = pdf.getId();

  pdf.setName(code + " - " + student.name + ".pdf");
  shareFileAnyoneWithLink_(pdfId);

  const pdfUrl = pdf.getUrl();

  // QR Code الأسرع
  const color = (student.level === 0) ? qr00Color :
                (student.level === 1) ? qr01Color :
                (student.level === 2) ? qr02Color :
                (student.level === 3) ? qr03Color :
                'E42F28';

  var qrUrl =
    "https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=" +
    color +
    "&bgcolor=FFFFFF00&data=" +
    encodeURIComponent(pdfUrl);

  // استبدال QR
  replaceImage_(cardFile.getId(), qrUrl);
  DocumentApp.openById(cardFile.getId()).saveAndClose();
  overwriteFile(DocumentApp.openById(cardFile.getId()).getBlob(), pdfId);

  DriveApp.getFileById(cardFile.getId()).setTrashed(true);

  return pdfUrl;
}
/////////////////////////////////////////////////////////////////////////////////////

// حقول شهادة اجتياز مرحلة — معادلة واحدة موحَّدة لكل المراحل (بطلب المستخدم صراحةً 2026-09-17،
// بعد أن كانت مبنية لتقبل دالة منفصلة لكل مرحلة تحسّبًا لاختلاف مستقبلي لم يتحقق):
// - hrs: عدد جلسات حضور الطالب بهذه المرحلة تحديدًا (getStageAttendanceCountForStage_ — نسخة
//   مُصرَّح لها بالمرحلة صراحة، لا "المرحلة النشطة حاليًا" كما تفعل getStageAttendanceStats —
//   طالب مرشَّح لشهادة مرحلة قد يكون انتقل فعليًا لمرحلة تالية (class0='done') قبل إصدارها) ×
//   "ساعات الحضور لليوم" (hoursPerAttendance، شيت stages — البند الوحيد المُخصَّص فعليًا لكل
//   مرحلة على حدة، يُعدَّل من "إدارة المراحل"؛ صفر/فارغ = لم يُضبَط بعد لهذه المرحلة).
// - rate: متوسط درجات كل الاختبارات التي خاضها الطالب بهذه المرحلة (خاضها فقط، بصرف النظر عن
//   النجاح/الرسوب)، محوَّل لتقدير بنفس سلّم المشروع القائم لكل اختبار منفرد (dataPost.js/
//   examSessions.js: ≥90 ممتاز/≥80 جيد جدًا/≥70 جيد/≥50 مقبول/أقل راسب).
// - moton: أسماء الاختبارات التي نجحها الطالب فقط بهذه المرحلة، مفصولة بفواصل — كل المسافات
//   بالنص الناتج غير منفصمة (NBSP) بدل العادية، لمنع انقسام اسم اختبار على سطرين أو انفراد
//   فاصلة بأول/آخر سطر عند التفاف النص بمستند الشهادة (بطلب المستخدم صراحةً).
// راجع مناقشات.md "شهادات الاجتياز" للسياق الكامل.
///////////////////////////////////////////////////////////////////////////////////////////////
function getStageAttendanceCountForStage_(cpr, stageIndex) {
  var stage = getStagesList().find(function (s) { return +s.stageIndex === stageIndex; });
  if (!stage || !stage.courseStartDate) return 0;

  var tz = SpreadsheetApp.openById(mainData).getSpreadsheetTimeZone();
  var startDate = Utilities.formatDate(new Date(stage.courseStartDate), tz, 'yyyy-MM-dd');
  var endDate = stage.courseEndDate ? Utilities.formatDate(new Date(stage.courseEndDate), tz, 'yyyy-MM-dd') : Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var stageName = STAGE_NAMES_[stageIndex];

  var lectureDates = getLecturesRef()
    .filter(function (l) { return l.level.indexOf(stageName) !== -1 && l.date && l.date >= startDate && l.date <= endDate; })
    .map(function (l) { return l.date; });
  var uniqueLectureDates = lectureDates.filter(function (d, i) { return lectureDates.indexOf(d) === i; });
  if (uniqueLectureDates.length === 0) return 0;

  var attendedDates = {};
  (getAttendance(cpr) || []).filter(function (a) { return a.resp !== 'request'; }).forEach(function (a) {
    if (!a.date) return;
    var d = Utilities.formatDate(new Date(a.date), tz, 'yyyy-MM-dd');
    if (d >= startDate && d <= endDate) attendedDates[d] = true;
  });
  return uniqueLectureDates.filter(function (d) { return attendedDates[d]; }).length;
}

function buildStageCertFields_(student, stageIndex) {
  var cpr = student.cpr;

  var stage = getStagesList().find(function (s) { return +s.stageIndex === stageIndex; });
  var hoursPerAttendance = stage ? (+stage.hoursPerAttendance || 0) : 0;
  var hrs = getStageAttendanceCountForStage_(cpr, stageIndex) * hoursPerAttendance;

  var stageAnswers = (getAnswersData(cpr) || []).filter(function (a) { return +a.level === stageIndex; });
  var avgDegree = stageAnswers.length
    ? stageAnswers.reduce(function (sum, a) { return sum + (Number(a.result) || 0); }, 0) / stageAnswers.length
    : 0;
  var rateLabel = avgDegree >= 90 ? 'ممتاز'
    : avgDegree >= 80 ? 'جيّد جدًا'
    : avgDegree >= 70 ? 'جيّد'
    : avgDegree >= 50 ? 'مقبول'
    : 'راسب';

  var passedNames = stageAnswers.filter(function (a) { return a.rate !== 'راسب'; }).map(function (a) { return a.exam; });
  var motonLines = [];
  for (var i = 0; i < passedNames.length; i += 2) { motonLines.push(passedNames.slice(i, i + 2).join(' - ')); }
  // Shift+Enter لا كسر سطر فقرة كاملة — الأخيرة أنشأت سطرًا فارغًا إضافيًا بين كل مجموعتين
  // (فقرة جديدة كاملة لا كسر سطر ناعم داخل نفس الفقرة)، فطالت الفقرة وتصادمت مع التوقيعات أسفل الشهادة.
  var moton = motonLines.join(String.fromCharCode(11));

  return {
    hrs: toHindiNumbers_(hrs),
    rate: rateLabel,
    moton: moton,
    date: formatHijriDateHindi_(new Date(), SpreadsheetApp.openById(mainData).getSpreadsheetTimeZone())
  };
}

// شهادة اجتياز مرحلة — نفس تقنية exportCert_ بالضبط (نسخ قالب، استبدال نص، QR، تصدير PDF)
// لكن بعناصر نائبة مختلفة تناسب شهادة اجتياز مرحلة لا اختبار واحد. راجع issueStageCertificate
// (أدناه) للطرف المستدعي، ومناقشات.md "نظام إدارة المراحل" للسياق الكامل.
function exportStageCert_(stageIndex, student, tempFileId, stuFolderID) {
  const code = `BAS-STAGE${stageIndex}-${student.cpr}`;

  const cardFile = DriveApp.getFileById(tempFileId).makeCopy(DriveApp.getFolderById(tempFolderID));
  const doc = DocumentApp.openById(cardFile.getId());
  const body = doc.getBody();

  var extraFields = buildStageCertFields_(student, stageIndex);

  body.replaceText("{name}", student.name);
  body.replaceText("{stage}", STAGE_NAMES_[stageIndex] || '');
  body.replaceText("{g1}", student.gender == 'أنثى' ? 'ة' : '');
  body.replaceText("{g2}", student.gender == 'أنثى' ? 'ت' : '');
  body.replaceText("{code}", code);
  body.replaceText("{hrs}", extraFields.hrs || '');
  body.replaceText("{rate}", extraFields.rate || '');
  body.replaceText("{moton}", extraFields.moton || '');
  body.replaceText("{date}", extraFields.date || '');
  doc.saveAndClose();

  const stuFolder = DriveApp.getFolderById(stuFolderID);
  const pdfBlob = DriveApp.getFileById(cardFile.getId()).getBlob().getAs('application/pdf');
  const pdf = stuFolder.createFile(pdfBlob);
  const pdfId = pdf.getId();

  pdf.setName(code + " - " + student.name + ".pdf");
  shareFileAnyoneWithLink_(pdfId);

  const pdfUrl = pdf.getUrl();

  const color = [qr00Color, qr01Color, qr02Color, qr03Color][stageIndex] || 'E42F28';
  // bgcolor بثمان خانات (RRGGBBAA) — آخر خانتين "00" تعني شفافية كاملة، فتظهر خلفية الشهادة
  // (النقشة/التذهيب) من خلف مربّع QR بدل خلفية بيضاء صريحة تقطع التصميم — بطلب المستخدم صراحةً،
  // خاص بشهادة اجتياز المرحلة فقط (exportCert_/exportStWrkCert_ بلا تغيير).
  var qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=" + color + "&bgcolor=FFFFFF00&data=" + encodeURIComponent(pdfUrl);

  replaceImage_(cardFile.getId(), qrUrl);
  DocumentApp.openById(cardFile.getId()).saveAndClose();
  overwriteFile(DocumentApp.openById(cardFile.getId()).getBlob(), pdfId);

  DriveApp.getFileById(cardFile.getId()).setTrashed(true);

  return pdfUrl;
}
/////////////////////////////////////////////////////////////////////////////////////

//////////////////////////////////////////////////////////////////////////////////////////////////////////
function exportStWrkCert_(exam, student, tempFileId, stuFolderID) {

  const code = `BAS- مبادرة - ${exam}-${student.cpr}`;

  // نسخة القالب
  const cardFile = DriveApp.getFileById(tempFileId).makeCopy(DriveApp.getFolderById(tempFolderID));
  const doc = DocumentApp.openById(cardFile.getId());
  const body = doc.getBody();

  body.replaceText("{name}", student.name);
  body.replaceText("{g1}", student.gender == 'أنثى' ? 'ة' : '');
  body.replaceText("{g2}", student.gender == 'أنثى' ? 'ت' : '');
  body.replaceText("{g3}", student.gender == 'أنثى' ? 'ا' : '');
  body.replaceText("{code}", code);
  doc.saveAndClose();

  // تحويل PDF
  const stuFolder = DriveApp.getFolderById(stuFolderID);
  const pdfBlob = DriveApp.getFileById(cardFile.getId()).getBlob().getAs('application/pdf');
  const pdf = stuFolder.createFile(pdfBlob);
  const pdfId = pdf.getId();

  pdf.setName(code + " - " + student.name + ".pdf");
  shareFileAnyoneWithLink_(pdfId);

  const pdfUrl = pdf.getUrl();

  // QR Code الأسرع
  const color = (student.level === 0) ? qr00Color :
                (student.level === 1) ? qr01Color :
                (student.level === 2) ? qr02Color :
                (student.level === 3) ? qr03Color :
                'E42F28';

  var qrUrl =
    "https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=" +
    color +
    "&bgcolor=FFFFFF00&data=" +
    encodeURIComponent(pdfUrl);

  // استبدال QR
  replaceImage_(cardFile.getId(), qrUrl);
  DocumentApp.openById(cardFile.getId()).saveAndClose();
  overwriteFile(DocumentApp.openById(cardFile.getId()).getBlob(), pdfId);

  DriveApp.getFileById(cardFile.getId()).setTrashed(true);

  return pdfUrl;
}
/////////////////////////////////////////////////////////////////////////////////////

function sendBatchWP(queue){
  queue.forEach(q => {
    sendWPCertificate_(q.student, q.pdfUrl, q.exam);
  });
}
/////////////////////////////////////////////////////////////////////////////////////

function extractFileId_(fileUrl) {
  if (!fileUrl) return null;
  
  // Google Drive links (/d/<id>) and, after the migration to the self-hosted
  // file store, our own links (/files/<id>/<name>) — see tools/rewrite-drive-links.js.
  const regex = /\/(?:d|files)\/([a-zA-Z0-9_-]+)/;
  const match = fileUrl.match(regex);
  if (match && match[1]) {
    return match[1];
  }
  
  // إذا كان الملف مجرد ID وليس URL
  if (/^[a-zA-Z0-9_-]{10,}$/.test(fileUrl)) {
    return fileUrl;
  }

  return null; // لم يتم التعرف على ID
}

// مشاركة أي ملف صادر (شهادة، بطاقة، صورة) بصلاحية "قارئ" لأي شخص لديه الرابط — عبر خدمة Drive
// المتقدمة (v3) مع supportsAllDrives ليعمل الإعداد حتى لو كان الملف داخل درايف مشترك، بدل
// DriveApp.setSharing. تُنادى فور إنشاء الملف وقبل استخدام رابطه (QR، واتساب، بريد).
function shareFileAnyoneWithLink_(fileId) {
  Drive.Permissions.create({
    'role': 'reader',
    'type': 'anyone'
  }, fileId, {
    'supportsAllDrives': true
  });
}

// هل أحد مجلدات الأب (أو أجداده حتى 4 مستويات) هو أرشيف الطلاب أو مجلد العيّنات المؤقت؟ ملف
// الطالب الصادر يقع دومًا بمجلد الطالب داخل أرشيف الطلاب (مستوى واحد للأعلى)، وعيّنات الشهادات
// مباشرةً بمجلد العيّنات.
function isInsideIssuedFilesRoots_(parentIds) {
  var roots = [perArchiveID, tempFolderID];
  var level = parentIds || [];
  for (var depth = 0; depth < 4 && level.length; depth++) {
    if (level.some(function (id) { return roots.indexOf(id) !== -1; })) return true;
    var next = [];
    level.forEach(function (id) {
      var meta = Drive.Files.get(id, { fields: 'parents', supportsAllDrives: true });
      (meta.parents || []).forEach(function (p) { next.push(p); });
    });
    level = next;
  }
  return false;
}

// تُنادى من الواجهة قبل فتح أي بطاقة أو شهادة (openIssuedFile بـfuncs-js.html): تتحقق أن الملف
// متاح لأي شخص لديه الرابط، وتمنحه الصلاحية (shareFileAnyoneWithLink_) إن لم يكن، ثم تعود
// الواجهة لفتحه. دالة عامة يستطيع أي زائر مناداتها، فتقتصر عمدًا على ملفات الشهادات والبطاقات
// الصادرة فقط (اسم يبدأ بـ BAS- أو idCard- داخل أرشيف الطلاب أو مجلد العيّنات) كي لا تصلح لجعل
// أي ملف آخر عامًا — كأعمال الطلاب المرفوعة (stWork-) التي تبقى خاصة. أي فشل هنا لا يمنع الفتح؛
// تعود الواجهة لفتح الرابط كما هو.
function ensureIssuedFileViewable(fileUrl) {
  var fileId = extractFileId_(fileUrl);
  if (!fileId) return { ok: false, reason: 'invalid' };

  var cache = CacheService.getScriptCache();
  var cacheKey = 'issuedFilePublic_' + fileId;
  if (cache.get(cacheKey)) return { ok: true, granted: false };

  try {
    var meta = Drive.Files.get(fileId, { fields: 'id,name,trashed,parents', supportsAllDrives: true });
    if (meta.trashed) return { ok: false, reason: 'trashed' };
    if (!/^(BAS-|idCard-)/.test(meta.name || '') || !isInsideIssuedFilesRoots_(meta.parents)) {
      return { ok: false, reason: 'not-issued-file' };
    }

    var permissions = Drive.Permissions.list(fileId, {
      supportsAllDrives: true,
      fields: 'permissions(id,type,role)'
    }).permissions || [];
    var alreadyPublic = permissions.some(function (p) { return p.type === 'anyone'; });
    if (!alreadyPublic) shareFileAnyoneWithLink_(fileId);

    cache.put(cacheKey, '1', 21600);
    return { ok: true, granted: !alreadyPublic };
  } catch (err) {
    Logger.log('ensureIssuedFileViewable: ' + err.message);
    return { ok: false, reason: 'error' };
  }
}

// يضمن أن الملف متاح "مشاهدة فقط" لأي شخص لديه الرابط عبر Drive API (v3)، ويُرجع ما فُعل:
//   'created'    — لم تكن هناك صلاحية عامة فأُنشئت (shareFileAnyoneWithLink_)
//   'downgraded' — كانت هناك صلاحية عامة بدور أعلى من المشاهدة (محرّر/معلّق) فخُفّضت إلى قارئ
//   'ok'         — قارئ بالفعل، لم يُغيَّر شيء
// لا تمسّ أي صلاحية أخرى (مشاركة بأشخاص بعينهم أو بنطاق).
function setFileViewerForAnyone_(fileId) {
  var permissions = Drive.Permissions.list(fileId, {
    supportsAllDrives: true,
    fields: 'permissions(id,type,role)'
  }).permissions || [];
  var anyone = permissions.filter(function (p) { return p.type === 'anyone'; })[0];

  if (!anyone) {
    shareFileAnyoneWithLink_(fileId);
    return 'created';
  }
  if (anyone.role !== 'reader') {
    Drive.Permissions.update({ role: 'reader' }, fileId, anyone.id, { supportsAllDrives: true });
    return 'downgraded';
  }
  return 'ok';
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// دالة صيانة تُشغَّل يدويًا من محرر Apps Script (وليست من واجهة الموقع): تمر صفًا صفًا على شيت
// الطلاب، وتقرأ رابط بطاقة الطالب من عمود card، وتضبط صلاحية الملف عبر Drive API إلى "مشاهدة
// (قارئ) لكل من لديه الرابط" — بنفس أسلوب shareFileAnyoneWithLink_ (راجع setFileViewerForAnyone_
// لحالات الضبط الثلاث). آمنة التكرار.
//
// مع شيت كبير تتوقف قبل حدّ التنفيذ (6 دقائق) فتُجدول نفسها تلقائيًا بعد دقيقة (Trigger من نوع
// .after()) وتكمل من الصف الذي وقفت عنده (التقدّم والعدّادات التراكمية محفوظة في
// PropertiesService) — يكفي تشغيلها يدويًا مرة واحدة فقط. عند اكتمال كل الصفوف تتوقف عن
// الجدولة وتُسجَّل الحصيلة الكاملة ("اكتمل الضبط") في سجل التنفيذات (Executions) لآخر تشغيلة.
// البطاقات التي يتعذّر ضبطها (ملف محذوف، أو مالكه حساب آخر) تُسجَّل بـLogger مع رقم الصف.
//
// عمدًا بلا LockService.getScriptLock: قفل السكربت مشترك مع قبول الطلاب وطوابير واتساب/FCM،
// وحجزه لدقائق سيُعطّلها. التداخل هنا غير ضارّ لأن الضبط نفسه آمن التكرار.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function deleteFixCardsSharingTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'fixStudentCardsSharing') ScriptApp.deleteTrigger(t);
  });
}

function fixStudentCardsSharing() {
  var props = PropertiesService.getScriptProperties();
  var PROGRESS_KEY = 'fixCardsSharingNextRow';
  var TOTALS_KEY = 'fixCardsSharingTotals';

  // نفس عطل fcmQueue.js: Trigger الـ.after() لمرة واحدة لا يُحذَف تلقائيًا بموثوقية فور إطلاقه
  // فيتراكم حتى حدّ 20 Trigger بالمشروع. نحذف أي Trigger لهذه الدالة أول كل تشغيلة (يدوية أو
  // تلقائية)، ولا نُنشئ واحدًا جديدًا إلا عند التوقف بسبب حدّ الوقت.
  deleteFixCardsSharingTriggers_();

  var sh =SpreadsheetApp.openById(mainData).getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cardCol = headers.indexOf('card');
  if (cardCol === -1) throw new Error('لم يتم العثور على عمود card في شيت الطلاب');

  var lastRow = sh.getLastRow();
  if (lastRow < 2) return 'شيت الطلاب فارغ';

  var savedRow = props.getProperty(PROGRESS_KEY);
  var startRow = +(savedRow || 2);
  if (startRow > lastRow) {
    props.deleteProperty(PROGRESS_KEY);
    props.deleteProperty(TOTALS_KEY);
    return 'اكتمل الضبط لكل الصفوف بالفعل. شغّل الدالة ثانيةً بعد إصدار بطاقات جديدة إن أردت إعادة الفحص.';
  }

  var cards = sh.getRange(2, cardCol + 1, lastRow - 1, 1).getValues();
  // العدّادات تراكمية عبر التشغيلات المتتابعة (تبدأ من الصفر فقط عند بداية جديدة بلا تقدّم محفوظ)
  var totals = savedRow ? JSON.parse(props.getProperty(TOTALS_KEY) || '{}') : {};
  var created = totals.created || 0, downgraded = totals.downgraded || 0, alreadyOk = totals.alreadyOk || 0,
    skipped = totals.skipped || 0, failed = totals.failed || 0;
  var startTime = Date.now();
  var TIME_LIMIT_MS = 4.5 * 60 * 1000; // هامش أمان قبل حدّ تنفيذ الدوال (6 دقائق)

  var row = startRow;
  for (; row <= lastRow; row++) {
    if (Date.now() - startTime > TIME_LIMIT_MS) break;

    var fileId = extractFileId_(String(cards[row - 2][0] || '').trim());
    if (!fileId) { skipped++; continue; }

    try {
      var status = setFileViewerForAnyone_(fileId);
      if (status === 'created') created++;
      else if (status === 'downgraded') downgraded++;
      else alreadyOk++;
    } catch (err) {
      failed++;
      Logger.log('تعذّر ضبط صلاحية البطاقة (صف ' + row + '، ملف ' + fileId + '): ' + err.message);
    }
  }

  var counts = ' — أُنشئت صلاحية: ' + created + ' — خُفّضت إلى مشاهدة: ' + downgraded +
    ' — مضبوطة مسبقًا: ' + alreadyOk + ' — بلا رابط بطاقة: ' + skipped + ' — تعذّر: ' + failed;
  var summary;
  if (row > lastRow) {
    props.deleteProperty(PROGRESS_KEY);
    props.deleteProperty(TOTALS_KEY);
    summary = 'اكتمل الضبط لكل الصفوف' + counts;
  } else {
    props.setProperty(PROGRESS_KEY, String(row));
    props.setProperty(TOTALS_KEY, JSON.stringify({
      created: created, downgraded: downgraded, alreadyOk: alreadyOk, skipped: skipped, failed: failed
    }));
    ScriptApp.newTrigger('fixStudentCardsSharing').timeBased().after(60 * 1000).create();
    summary = 'توقفت مؤقتًا عند الصف ' + row + ' من ' + lastRow + ' (حدّ وقت التنفيذ) — جُدولت المتابعة تلقائيًا بعد دقيقة. الحصيلة التراكمية حتى الآن' + counts;
  }

  Logger.log(summary);
  return summary;
}

function overwriteFile(blobOfNewContent, currentFileID) {
  //https://drive.google.com/file/d/1mvRDAFeQPyJdH8liLox8gihJ0Agxm25D/view?usp=drivesdk
  var fileID = extractFileId_(currentFileID)
  Logger.log(fileID)
  try {
    const currentFile = DriveApp.getFileById(fileID);
    if (!currentFile) throw new Error("File not found: " + fileID);
    
    // تأكد من تمكين Advanced Drive Service
    Drive.Files.update({
      title: currentFile.getName(),
      mimeType: currentFile.getMimeType()
    }, currentFile.getId(), blobOfNewContent);

  } catch (err) {
    Logger.log("Error in overwriteFile: " + err.message);
    throw err;
  }
}

function replaceImage_(newFileId, qrCode) {
  var image = UrlFetchApp.fetch(qrCode).getBlob();
  var replaceTextToImage = function(body, searchText, image, width) {
    var next = body.findText(searchText);
    if (!next) return;
    var r = next.getElement();
    r.asText().setText("");
    var img = r.getParent().asParagraph().insertInlineImage(0, image);
    if (width && typeof width == "number") {
      var w = img.getWidth();
      var h = img.getHeight();
      img.setWidth(width);
      img.setHeight(width * h / w);
    }
    return next;
  };

  var body = DocumentApp.openById(newFileId).getBody();
  do {
    var next = replaceTextToImage(body, "QRCode", image, 120);
  } while (next);
}
//////////////////////////////////////////////////////////////////////////////////////////////////////////

function getCertIdTemp_(exam){

  //exam = 'الوسائل المفيدة للحياة السعيدة';

  var sheet = ensureCertificatesSheet_();
  var headers = sheet.getRange("1:1").getValues()[0];
  var dateCol = headers.indexOf('date');
  var examCol = headers.indexOf('name');
  var tempIDCol = headers.indexOf('template-id');

  const data = sheet.getDataRange().getValues(); // كل البيانات
  const filteredRows = data.slice(1).filter(row => row[examCol] === exam);
  //Logger.log(filteredRows.length);

  if(filteredRows.length >= 1){
    return {
      tempID: filteredRows[0][tempIDCol],
      date:   filteredRows[0][dateCol]
    };
  }else{
    return false;
  }

}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// "شهادات الاختبارات" ضمن صفحة "إدارة القوالب" — واجهة إدارية حقيقية بدل تعديل شيت Certificates
// يدويًا مباشرة (كان بلا أي واجهة أو تحقق من وجود القالب أصلًا). تغطي شهادات الاختبارات العادية
// وشهادات أعمال الطلاب معًا (كلاهما يقرأ من نفس الشيت عبر getCertIdTemp_ أعلاه — الفرق فقط أن
// شهادات أعمال الطلاب لاحقة اسم الاختبار بـ"-أعمال الطلاب"، راجع generatWrksCertificate أدناه).
// "name" هو المفتاح الفريد (نفس ما يقرأه getCertIdTemp_) — لا عمود id منفصل، حفاظًا على بنية
// الشيت الأصلية التي يعتمد عليها الكود الحي بالفعل. راجع مناقشات.md "إدارة القوالب" للسياق الكامل.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function ensureCertificatesSheet_() {
  var ss = SpreadsheetApp.openById(answersData);
  var sh = ss.getSheetByName('Certificates');
  var wantedCols = ['date', 'name', 'template-id'];
  if (!sh) {
    sh = ss.insertSheet('Certificates');
    sh.appendRow(wantedCols);
    return sh;
  }
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var missing = wantedCols.filter(function (c) { return headers.indexOf(c) === -1; });
  if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  return sh;
}

function getCertificateTemplatesList() {
  var sh = ensureCertificatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var nameCol = headers.indexOf('name'), dateCol = headers.indexOf('date'), tempCol = headers.indexOf('template-id');
  var data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  return data.filter(function (r) { return r[nameCol] !== ''; }).map(function (r) {
    var d = r[dateCol];
    return { name: r[nameCol], templateId: r[tempCol], date: (d instanceof Date) ? d.toISOString() : d };
  });
}

// نسخة Drive حقيقية جديدة من قالب موجود (لا إعادة استخدام لنفس الملف) — الطلب الصريح من
// المستخدم: "عاوز انسخ ملف القالب كله واعمل قالب جديد نسخة من قالب موجود، وبعدين افتحه وأعدّل
// عليه". النسخة تُوضَع بنفس مجلد الأصل (سلوك makeCopy الافتراضي بلا مجلد هدف محدَّد).
function duplicateCertificateTemplateDoc(userCpr, sourceTemplateId, newName) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  try {
    var copy = DriveApp.getFileById(sourceTemplateId).makeCopy(newName || ('نسخة قالب - ' + new Date().toISOString()));
    return { ok: true, templateId: copy.getId(), url: copy.getUrl() };
  } catch (e) {
    return { error: true, message: 'تعذّر نسخ القالب: ' + e.message };
  }
}

// originalName فارغ = إضافة صف جديد؛ غير فارغ = تعديل صف موجود (بما فيه تغيير الاسم نفسه).
function saveCertificateTemplate(userCpr, originalName, item) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  item = item || {};
  var name = String(item.name || '').trim();
  if (!name) return { error: true, message: 'اسم الاختبار مطلوب' };
  var templateId = String(item.templateId || '').trim();
  if (!templateId) return { error: true, message: 'معرّف القالب مطلوب' };

  var sh = ensureCertificatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var nameCol = headers.indexOf('name'), dateCol = headers.indexOf('date'), tempCol = headers.indexOf('template-id');
  var lastRow = sh.getLastRow();
  var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];

  var duplicateIdx = rows.findIndex(function (r) { return r[nameCol] === name; });
  if (duplicateIdx > -1 && rows[duplicateIdx][nameCol] !== originalName) {
    return { error: true, message: 'يوجد قالب بنفس هذا الاسم بالفعل' };
  }

  if (originalName) {
    var rowIdx = rows.findIndex(function (r) { return r[nameCol] === originalName; });
    if (rowIdx === -1) return { error: true, message: 'تعذّر العثور على القالب المطلوب تعديله' };
    sh.getRange(rowIdx + 2, nameCol + 1).setValue(name);
    sh.getRange(rowIdx + 2, tempCol + 1).setValue(templateId);
  } else {
    var row = new Array(headers.length).fill('');
    row[nameCol] = name; row[tempCol] = templateId; row[dateCol] = new Date();
    sh.appendRow(row);
  }
  return { ok: true };
}

function deleteCertificateTemplate(userCpr, name) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };
  var sh = ensureCertificatesSheet_();
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var nameCol = headers.indexOf('name');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true };
  var names = sh.getRange(2, nameCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < names.length; i++) {
    if (names[i][0] === name) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: true };
}

/***********************
  إعداد وتتبع التقدّم (Progress)
************************/

/**
 * تأكد من وجود شيت باسم 'progress' داخل نفس فایل الإجابات
 * شغّل setupProgress() مرة واحدة عند التثبيت الأولي
 */
function setupProgress() {
  const ss = SpreadsheetApp.openById(answersData);
  let sheet = ss.getSheetByName('progress');

  if (!sheet) {
    sheet = ss.insertSheet('progress');
    sheet.clear();
    sheet.appendRow(['exam', 'total', 'done', 'remaining', 'percent', 'last_update']);
    // إضافة ترويسة فقط - الصفوف ستملأ أثناء التشغيل
  }
}

/**
 * تحديث سجل التقدّم لامتحان معين
 * exam: اسم الامتحان
 * total: إجمالي عدد المستهدفين
 * done: عدد المكتملين
 */
function updateProgress_(exam, total, done) {
  const ss = SpreadsheetApp.openById(answersData);
  const sheet = ss.getSheetByName('progress');
  if (!sheet) {
    // إن لم يكن موجودًا ننشئه تلقائيًا
    setupProgress();
  }

  const remain = total - done;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  // اقرأ العمود A (الامتحانات)
  const lastRow = sheet.getLastRow();
  const range = lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues()
    : [];

  let rowIndex = -1;
  for (let i = 0; i < range.length; i++) {
    if (range[i][0] === exam) { rowIndex = i; break; }
  }

  if (rowIndex === -1) {
    // صف جديد
    sheet.appendRow([exam, total, done, remain, percent + '%', new Date()]);
  } else {
    const row = rowIndex + 2;
    sheet.getRange(row, 2).setValue(total);
    sheet.getRange(row, 3).setValue(done);
    sheet.getRange(row, 4).setValue(remain);
    sheet.getRange(row, 5).setValue(percent + '%');
    sheet.getRange(row, 6).setValue(new Date());
  }
}


// سجل أخطاء إصدار الشهادات الذاتي — شيت مستقل جديد بنفس Spreadsheet answersData (بيانات
// ناتجة عن تجربة الطالب، لا إعداد اختبار)، بنفس نمط examAuditLog/logExamOperation_ القائم:
// أفضل-جهد (try/catch حول الكتابة نفسها) حتى لا يفشل مسار الاستجابة للطالب بسبب فشل التسجيل.
function logCertificateError_(cpr, name, examName, level, err) {
  try {
    var ss = SpreadsheetApp.openById(answersData);
    var sh = ss.getSheetByName('certificateErrors');
    if (!sh) {
      sh = ss.insertSheet('certificateErrors');
      sh.appendRow(['timestamp', 'cpr', 'name', 'exam', 'level', 'error', 'stack']);
    }
    sh.appendRow([new Date(), cpr, name || '', examName || '', level, String((err && err.message) || err), String((err && err.stack) || '')]);
  } catch (e2) {
    Logger.log('logCertificateError_ فشل: ' + e2);
  }
}

// نفس عنوان البريد المستخدَم أصلًا لإشعار انتهاء دفعة إصدار الشهادات (sendFinishedMail أدناه) —
// عنوان الأكاديمية الإداري الوحيد المُستخدَم لإشعارات النظام التلقائية بكل المشروع.
function notifyCertificateError_(cpr, name, examName, level, err) {
  try {
    GmailApp.sendEmail('dfekra@gmail.com', 'خطأ في إصدار شهادة ذاتيًا — ' + examName,
      'تعذّر إصدار شهادة ذاتيًا لطالب:\n\n' +
      'الاسم: ' + (name || '') + '\n' +
      'الرقم الشخصي: ' + cpr + '\n' +
      'الاختبار: ' + examName + '\n' +
      'المرحلة: ' + level + '\n\n' +
      'تفاصيل الخطأ:\n' + String((err && err.message) || err) + '\n\n' +
      String((err && err.stack) || ''));
  } catch (e2) {
    Logger.log('notifyCertificateError_ فشل: ' + e2);
  }
}

// إصدار شهادة اجتياز اختبار بطلب الطالب نفسه مباشرة (لا عبر دفعة الإدارة generatCertificate)
// — بلا أي إرسال واتساب/إيميل تلقائي للطالب (خلافًا لـgeneratCertificate)، فقط توليد الملف
// وحفظ رابطه بشيت answers وإرجاعه للعميل مباشرة. يتحقق أولًا من مفتاح selfIssueCertEnabled
// (شيت main بـrefID، تتحكم به صفحة "إدارة الاختبارات" — setSelfIssueCertStatus أعلاه). أي
// استثناء أثناء التوليد الفعلي يُسجَّل بشيت certificateErrors ويُرسَل بريد تفصيلي للإدارة قبل
// إرجاع رسالة عامة للطالب (لا تفاصيل تقنية) — أما رفض الطلب لعدم استيفاء الشروط (لم يجتز/
// الخدمة معطَّلة) فليس خطأً تقنيًا ولا يُسجَّل/يُرسَل عنه بريد.
function issueCertificateSelfService(cpr, name, examName, level) {
  cpr = normalizeCpr_(cpr);
  if (!cpr) return { error: true, message: 'رقم شخصي غير صالح' };

  var mainSh = SpreadsheetApp.openById(refID).getSheetByName('main');
  var enabledCol = ensureSelfIssueCertColumn_(mainSh);
  var enabled = !!mainSh.getRange(2, enabledCol).getValue();
  if (!enabled) return { error: true, message: 'خدمة إصدار الشهادة الذاتي غير متاحة حاليًا، يرجى التواصل مع الإدارة' };

  var sheet, headers, cprCol, nameCol, genderCol, phoneCol, examCol, matnCol, rateCol, certificateCol, classCol, rowIdx, row, sheetRowNumber;
  try {
    sheet = SpreadsheetApp.openById(answersData).getSheetByName('answers');
    headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    cprCol = headers.indexOf('cpr'); nameCol = headers.indexOf('name'); genderCol = headers.indexOf('gender');
    phoneCol = headers.indexOf('phone'); examCol = headers.indexOf('exam'); matnCol = headers.indexOf('matn');
    rateCol = headers.indexOf('rate'); certificateCol = headers.indexOf('certificate'); classCol = headers.indexOf('level');

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { error: true, message: 'لم يُعثر على نتيجة مطابقة لهذا الاختبار' };
    var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

    rowIdx = -1;
    for (var i = 0; i < data.length; i++) {
      if (normalizeCpr_(data[i][cprCol]) === cpr && data[i][examCol] === examName && String(data[i][classCol]) === String(level)) { rowIdx = i; break; }
    }
    if (rowIdx === -1) return { error: true, message: 'لم يُعثر على نتيجة مطابقة لهذا الاختبار' };
    row = data[rowIdx];
    sheetRowNumber = rowIdx + 2;
  } catch (err) {
    logCertificateError_(cpr, name, examName, level, err);
    notifyCertificateError_(cpr, name, examName, level, err);
    return { error: true, message: 'تعذّر إصدار الشهادة حاليًا، حاول لاحقًا' };
  }

  if (row[rateCol] === 'راسب') return { error: true, message: 'لم تجتز هذا الاختبار بعد' };
  if (row[certificateCol]) return { ok: true, url: row[certificateCol] }; // صادرة أصلًا — لا داعي لإعادة التوليد

  try {
    var certIdTemp = getCertIdTemp_(examName);
    if (!certIdTemp) throw new Error('لا يوجد قالب شهادة مُعَدّ لهذا الاختبار بشيت Certificates');

    var allStudents = getPersons();
    var found = (Array.isArray(allStudents) ? allStudents : []).filter(function (e) { return normalizeCpr_(e.cpr) === cpr; })[0];
    var stuFolderID = found ? getDriveId(found.folderUrl) : tempFolderID;

    var student = {
      row: sheetRowNumber, cpr: cpr, name: row[nameCol], gender: row[genderCol], phone: row[phoneCol],
      rate: row[rateCol], matn: row[matnCol], url: row[certificateCol], thisExam: examName,
      level: row[classCol], lecAttend: getAttendance(cpr, certIdTemp.date)
    };

    var pdfUrl = exportCert_(examName, student, certIdTemp.tempID, stuFolderID);
    sheet.getRange(sheetRowNumber, certificateCol + 1).setValue(pdfUrl);

    return { ok: true, url: pdfUrl };
  } catch (err) {
    logCertificateError_(cpr, name, examName, level, err);
    notifyCertificateError_(cpr, name, examName, level, err);
    return { error: true, message: 'تعذّر إصدار الشهادة حاليًا، حاول لاحقًا' };
  }
}

function generatCertificate(exam, actorCpr) {
  //exam = 'الوسائل المفيدة للحياة السعيدة';
  // احفظ الامتحان الحالي (والمُنفِّذ، لتسجيله بسجل الرسائل الدائم لكل دفعة متابَعة عبر
  // continueCertificates أدناه — راجع مناقشات.md "إدارة الرسائل") ليستخدمهما trigger الاستكمال
  PropertiesService.getScriptProperties().setProperty('currentExam', exam);
  PropertiesService.getScriptProperties().setProperty('currentExamActor', actorCpr || '');

  const ss = SpreadsheetApp.openById(answersData);
  const sheet = ss.getSheetByName('answers');

  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];

  const rowCol = headers.indexOf('#');
  const cprCol = headers.indexOf('cpr');
  const nameCol = headers.indexOf('name');
  const genderCol = headers.indexOf('gender');
  const phoneCol = headers.indexOf('phone');
  const examCol = headers.indexOf('exam');
  const matnCol = headers.indexOf('matn');
  const rateCol = headers.indexOf('rate');
  const certificateCol = headers.indexOf('certificate');
  const classCol = headers.indexOf('level');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return "لا توجد بيانات";

  const data = sheet.getRange(2,1,lastRow-1,headers.length).getValues();

  const allStudents = getPersons();
  const certIdTemp = getCertIdTemp_(exam);
  if (!certIdTemp) return certIdTemp;

  const props = PropertiesService.getScriptProperties();
  const batchSize = 15; // يمكنك تغييره إن أردت
  // القالب يُجلَب مرة واحدة هنا خارج الحلقة (لا لكل طالب) — نفس احتياط الأداء المُتَّبع بصفحة
  // "مرشّحو الاجتياز" سابقًا. فارغ = لا قالب مُعَدّ بعد، فتسقط sendWPCertificate_ لنصّها القديم.
  const certTemplateBody = getActiveMessageTemplateBody_('examCertificate');

  // --- فلترة الصفوف الخاصة بهذا الامتحان فقط مع حفظ مؤشر الصف الحقيقي في الشيت ---
  const filteredRows = data
        .map((r, idx) => ({ rowData: r, index: idx }))   // index = 0-based بالنسبة لِ data (سطر في الشيت = idx+2)
        .filter(obj => obj.rowData[examCol] === exam);

  const totalCount = filteredRows.length;

  // --- startIndex: نفضّل القيمة المخزنة إن وجدت (تكملة) ---
  let startIndex = Number(props.getProperty('lastIndex_' + exam)) || 0;

  // --- لو لم يكن هناك قيمة مخزنة (أول تشغيل) نحسب أول صف فارغ داخل filteredRows فقط ---
  if (startIndex === 0) {
    const firstEmptyIdx = filteredRows.findIndex(obj => obj.rowData[certificateCol] === '');
    startIndex = (firstEmptyIdx === -1) ? filteredRows.length : firstEmptyIdx;
    // firstEmptyIdx = index أول عنصر لم تقم له بشهادة بعد → نبدأ منه
  }

  // تأكد من وجود صفحة progress
  setupProgress();
  // تحديث حالة البداية (قد تكون 0 إن انتهى كل شيء)
  updateProgress_(exam, totalCount, startIndex);

  for (let i = startIndex; i < filteredRows.length; i++) {

    const r = filteredRows[i].rowData;
    const actualRowIndex = filteredRows[i].index; // رقم صف داخل data (0-based)
    const sheetRowNumber = actualRowIndex + 2; // رقم السطر الفعلي في الشيت

    const student = {
      row: sheetRowNumber,
      cpr: r[cprCol],
      name: r[nameCol],
      gender: r[genderCol],
      phone: r[phoneCol],
      rate: r[rateCol],
      matn: r[matnCol],
      url: r[certificateCol],
      thisExam: exam,
      level: r[classCol],
      lecAttend: getAttendance(r[cprCol], certIdTemp.date) //getLecAttend(r[cprCol])
    };

    // جلب مجلد الطالب
    try {
      const found = allStudents.filter(e => (e.cpr * 1) === (student.cpr * 1))[0];
      stuFolderID = found ? getDriveId(found.folderUrl) : tempFolderID;
    } catch (err) {
      stuFolderID = tempFolderID;
    }

    if (student.url === '' && student.rate !== 'راسب') {

      const pdfUrl = exportCert_(exam, student, certIdTemp.tempID, stuFolderID);

      // كتابة الرابط في العمود certificate
      try {
        sheet.getRange(student.row, certificateCol + 1).setValue(pdfUrl);
      } catch (e) {
        // منع أخطاء الكتابة من إيقاف الحلقة
        Logger.log("خطأ في كتابة خلية الشهادة: " + e);
      }

      // إرسال واتساب مباشرة (تركنا الدالة كما هي عندك)
      try {
        sendWPCertificate_(student, pdfUrl, exam, certTemplateBody, actorCpr);
      } catch (e) {
        Logger.log("خطأ في إرسال واتساب: " + e);
      }
    }

    // حدّث التقدّم بعد كل عنصر (يمكن تخفيف التحديث ليكون كل N عناصر لتحسين الأداء)
    updateProgress_(exam, totalCount, i + 1);

    // --- انتهت الدفعة؟ أنشئ Trigger لاستكمال الدفعة التالية ---
    if ((i - startIndex + 1) >= batchSize) {

      props.setProperty('lastIndex_' + exam, i + 1); // نضع مكان الانتهاء التالي (index في filteredRows)

      // أنشئ Trigger يعمل بعد ثانية أو ثانيتين ليكمل العملية
      ScriptApp.newTrigger('continueCertificates')
        .timeBased()
        .after(1500) // بعد 1.5 ثانية
        .create();

      return "جاري استكمال الدفعة التالية…";
    }
    //return;
  }

  // --- كلهم انتهوا: نزيل مؤشر الدفعات ونحدّث التقدّم إلى 100% ---
  props.deleteProperty('lastIndex_' + exam);
  updateProgress_(exam, totalCount, totalCount);

  // يمكنك إرسال إيميل إشعار هنا أو استدعاء google.script.run.sendFinishedMail(exam);
  return true;
}

/***********************
  trigger لاستكمال الدفعات
************************/
function continueCertificates() {

  // حذف كل التريغرز الخاصين بهذه الدالة حال تشغيلها لتجنب التكرار
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continueCertificates') {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* ignore */ }
    }
  });

  const props = PropertiesService.getScriptProperties();
  const currentExam = props.getProperty('currentExam');
  if (currentExam) {
    generatCertificate(currentExam, props.getProperty('currentExamActor') || '');
  }
}

/***********************
  (اختياري) دالة مساعدة لإرسال دفعات إن أردت لاحقًا بدلاً من الإرسال داخل الحلقة
************************/
function sendBatchWP(queue){
  queue.forEach(q => {
    try {
      sendWPCertificate_(q.student, q.pdfUrl, q.exam);
    } catch (e) {
      Logger.log("خطأ أثناء إرسال دفعة واتساب: " + e);
    }
  });
}

/*********************** cpr	name	gender	phone	stWorks	url	notes	certificate
************************/

function generatWrksCertificate(exam, actorCpr) {
  //exam = 'الوسائل المفيدة للحياة السعيدة';
  // احفظ الامتحان الحالي (والمُنفِّذ، لتسجيله بسجل الرسائل الدائم) ليستخدمهما trigger الاستكمال
  PropertiesService.getScriptProperties().setProperty('currentStWrk', exam);
  PropertiesService.getScriptProperties().setProperty('currentStWrkActor', actorCpr || '');

  const ss = SpreadsheetApp.openById(answersData);
  const sheet = ss.getSheetByName('stWorks');

  const headers = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];

  const rowCol = headers.indexOf('#');
  const cprCol = headers.indexOf('cpr');
  const nameCol = headers.indexOf('name');
  const genderCol = headers.indexOf('gender');
  const phoneCol = headers.indexOf('phone');
  const examCol = headers.indexOf('stWorks');
  const certificateCol = headers.indexOf('certificate');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return "لا توجد بيانات";

  const data = sheet.getRange(2,1,lastRow-1,headers.length).getValues();

  const allStudents = getPersons();
  const certIdTemp = getCertIdTemp_(exam+'-أعمال الطلاب');
  if (!certIdTemp) return certIdTemp;

  const props = PropertiesService.getScriptProperties();
  const batchSize = 15; // يمكنك تغييره إن أردت
  // القالب يُجلَب مرة واحدة هنا خارج الحلقة (لا لكل طالب) — راجع نفس التعليق بـgeneratCertificate.
  const certTemplateBody = getActiveMessageTemplateBody_('examCertificate');

  // --- فلترة الصفوف الخاصة بهذا الامتحان فقط مع حفظ مؤشر الصف الحقيقي في الشيت ---
  const filteredRows = data
        .map((r, idx) => ({ rowData: r, index: idx }))   // index = 0-based بالنسبة لِ data (سطر في الشيت = idx+2)
        .filter(obj => obj.rowData[examCol] === exam);

  const totalCount = filteredRows.length;

  // --- startIndex: نفضّل القيمة المخزنة إن وجدت (تكملة) ---
  let startIndex = Number(props.getProperty('lastIndex_' + exam)) || 0;

  // --- لو لم يكن هناك قيمة مخزنة (أول تشغيل) نحسب أول صف فارغ داخل filteredRows فقط ---
  if (startIndex === 0) {
    const firstEmptyIdx = filteredRows.findIndex(obj => obj.rowData[certificateCol] === '');
    startIndex = (firstEmptyIdx === -1) ? filteredRows.length : firstEmptyIdx;
    // firstEmptyIdx = index أول عنصر لم تقم له بشهادة بعد → نبدأ منه
  }

  // تأكد من وجود صفحة progress
  setupProgress();
  // تحديث حالة البداية (قد تكون 0 إن انتهى كل شيء)
  updateProgress_(exam, totalCount, startIndex);

  for (let i = startIndex; i < filteredRows.length; i++) {

    const r = filteredRows[i].rowData;
    const actualRowIndex = filteredRows[i].index; // رقم صف داخل data (0-based)
    const sheetRowNumber = actualRowIndex + 2; // رقم السطر الفعلي في الشيت

    const student = {
      row: sheetRowNumber,
      cpr: r[cprCol],
      name: r[nameCol],
      gender: r[genderCol],
      phone: r[phoneCol],
      url: r[certificateCol],
      thisExam: exam,
    };

    // جلب مجلد الطالب
    try {
      const found = allStudents.filter(e => (e.cpr * 1) === (student.cpr * 1))[0];
      stuFolderID = found ? getDriveId(found.folderUrl) : tempFolderID;
    } catch (err) {
      stuFolderID = tempFolderID;
    }

    if (student.url === '') {

      const pdfUrl = exportStWrkCert_(exam, student, certIdTemp.tempID, stuFolderID);

      // كتابة الرابط في العمود certificate
      try {
        sheet.getRange(student.row, certificateCol + 1).setValue(pdfUrl);
      } catch (e) {
        // منع أخطاء الكتابة من إيقاف الحلقة
        Logger.log("خطأ في كتابة خلية الشهادة: " + e);
      }

      // إرسال واتساب مباشرة (تركنا الدالة كما هي عندك)
      try {
        sendWPCertificate_(student, pdfUrl, 'مبادرة - '+exam, certTemplateBody, actorCpr);
      } catch (e) {
        Logger.log("خطأ في إرسال واتساب: " + e);
      }
    }

    // حدّث التقدّم بعد كل عنصر (يمكن تخفيف التحديث ليكون كل N عناصر لتحسين الأداء)
    updateProgress_(exam, totalCount, i + 1);

    // --- انتهت الدفعة؟ أنشئ Trigger لاستكمال الدفعة التالية ---
    if ((i - startIndex + 1) >= batchSize) {

      props.setProperty('lastIndex_' + exam, i + 1); // نضع مكان الانتهاء التالي (index في filteredRows)

      // أنشئ Trigger يعمل بعد ثانية أو ثانيتين ليكمل العملية
      ScriptApp.newTrigger('continueWrksCertificates')
        .timeBased()
        .after(1500) // بعد 1.5 ثانية
        .create();

      return "جاري استكمال الدفعة التالية…";
    }
    //return;
  }

  // --- كلهم انتهوا: نزيل مؤشر الدفعات ونحدّث التقدّم إلى 100% ---
  props.deleteProperty('lastIndex_' + exam);
  updateProgress_(exam, totalCount, totalCount);

  // يمكنك إرسال إيميل إشعار هنا أو استدعاء google.script.run.sendFinishedMail(exam);
  return true;
}

/***********************
  شهادات أعمال الطلاب
************************/
function continueWrksCertificates() {

  // حذف كل التريغرز الخاصين بهذه الدالة حال تشغيلها لتجنب التكرار
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continueWrksCertificates') {
      try { ScriptApp.deleteTrigger(t); } catch (e) { /* ignore */ }
    }
  });

  const props = PropertiesService.getScriptProperties();
  const currentStWrk = props.getProperty('currentStWrk');
  if (currentStWrk) {
    generatWrksCertificate(currentStWrk, props.getProperty('currentStWrkActor') || '');
  }
}

/////////////////////////////////////////////////////////////////////////////////////
async function convertPDFToPNG(blob , name) {
  // Convert PDF to PNG images.
  const cdnjs = "https://cdn.jsdelivr.net/npm/pdf-lib/dist/pdf-lib.min.js";
  eval(UrlFetchApp.fetch(cdnjs).getContentText()); // Load pdf-lib
  const setTimeout = function (f, t) {
    // Overwrite setTimeout with Google Apps Script.
    Utilities.sleep(t);
    return f();
  };
  const data = new Uint8Array(blob.getBytes());
  const pdfData = await PDFLib.PDFDocument.load(data);
  const pageLength = pdfData.getPageCount();
  console.log(`Total pages: ${pageLength}`);
  const obj = { imageBlobs: [], fileIds: [] };
  for (let i = 0; i < pageLength; i++) {
    console.log(`Processing page: ${i + 1}`);
    const pdfDoc = await PDFLib.PDFDocument.create();
    const [page] = await pdfDoc.copyPages(pdfData, [i]);
    pdfDoc.addPage(page);
    const bytes = await pdfDoc.save();
    const blob = Utilities.newBlob(
      [...new Int8Array(bytes)],
      MimeType.PDF,
      `sample${i + 1}.pdf`
    );
    const id = DriveApp.createFile(blob).getId();
    Utilities.sleep(3000); // This is used for preparing the thumbnail of the created file.
    const link = Drive.Files.get(id, { fields: "thumbnailLink" }).thumbnailLink;
    if (!link) {
      throw new Error(
        "In this case, please increase the value of 3000 in Utilities.sleep(3000), and test it again."
      );
    }
    Logger.log(123456)
    const imageBlob = UrlFetchApp.fetch(link.replace(/\=s\d*/, "=s1000"))
      .getBlob()
      .setName(`${name + i + 1}.png`);
    obj.imageBlobs.push(imageBlob);
    obj.fileIds.push(id);
    Logger.log(id)
    DriveApp.getFileById(id).setTrashed(true);
  }
  obj.fileIds.forEach((id) => DriveApp.getFileById(id).setTrashed(true));
  Logger.log(obj.imageBlobs);
  
  return obj.imageBlobs;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////
function convertPDFToImageViaPDFco(pdfBlob) {

  const apiKey = 'basaerbah@gmail.com_hJxKJdot4ow0yD8qc16r2Kp6SrbmRhVIrMa68ma44jXJDpGRfJ1bhajIJo44Kli3'; // ← ضع مفتاح API من PDF.co هنا
  // 1. رفع الملف

  const uploadResponse = UrlFetchApp.fetch("https://api.pdf.co/v1/file/upload", {
    method: "post",
    headers: { "x-api-key": apiKey },
    payload: {
      name: "input.pdf",
      file: pdfBlob
    },
    muteHttpExceptions: true
  });
  const uploadResult = JSON.parse(uploadResponse.getContentText());
  if (uploadResult.error) throw new Error("Upload Error");

  const fileUrl = uploadResult.url;

  // 2. التحويل إلى PNG
  const convertPayload = {
    name: "converted",
    url: fileUrl,
    async: false
  };
  const convertResponse = UrlFetchApp.fetch("https://api.pdf.co/v1/pdf/convert/to/png", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(convertPayload),
    headers: { "x-api-key": apiKey },
    muteHttpExceptions: true
  });
  const convertResult = JSON.parse(convertResponse.getContentText());
  if (convertResult.error) throw new Error("Convert Error");

  // 3. تحميل الصورة كـ Blob
  const imageUrl = convertResult.urls[0];
  const imageBlob = UrlFetchApp.fetch(imageUrl).getBlob().setName("تهنئة عيد الأضحى 1446.png");
  return imageBlob;
}



// ✅ وظيفة فرعية لرفع الملف إلى PDF.co
function uploadFileToPDFco(pdfBlob, fileName, apiKey) {
  const boundary = "xxxxxxxxxx";
  const delimiter = "--" + boundary;
  const closeDelimiter = "--" + boundary + "--";

  const contentType = "application/pdf";

  const body = [
    delimiter,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    `Content-Type: ${contentType}`,
    '',
    pdfBlob.getDataAsString(),
    closeDelimiter
  ].join("\r\n");

  const payload = Utilities.newBlob(body).getBytes();

  const response = UrlFetchApp.fetch("https://api.pdf.co/v1/file/upload", {
    method: "post",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "multipart/form-data; boundary=" + boundary
    },
    payload: payload,
    muteHttpExceptions: true
  });

  const text = response.getContentText();
  Logger.log("Upload response: " + text);

Logger.log("Raw Upload Response:\n" + text);

let result;
try {
  result = JSON.parse(text);
} catch (e) {
  throw new Error("Upload Error: Could not parse response. Raw:\n" + text);
}

if (!result.success) {
  throw new Error("Upload Error: " + (result.message || JSON.stringify(result)));
}


  return result.url;
}

//////////////////////////////////////////////////////////////////////////////////////

function testPDFcoConvert() {
  const apiKey = 'basaerbah@gmail.com_hJxKJdot4ow0yD8qc16r2Kp6SrbmRhVIrMa68ma44jXJDpGRfJ1bhajIJo44Kli3';

  const fileUrl = 'https://pdf-temp-files.s3.us-west-2.amazonaws.com/7J3U1OJIZXXSZ7U68GK4NFG6NRFHTHZW/uploaded.pdf?X-Amz-Expires=3600\u0026X-Amz-Algorithm=AWS4-HMAC-SHA256\u0026X-Amz-Credential=AKIAIZJDPLX6D7EHVCKA/20250529/us-west-2/s3/aws4_request\u0026X-Amz-Date=20250529T062624Z\u0026X-Amz-SignedHeaders=host\u0026X-Amz-Signature=7c4971835e7b1bfb171bf6ba99d4f780147d9103dba8b2fd8a63d02882f6b1cb'; // ← انسخ الرابط اللي ظهرلك من الـ Logs

  const convertPayload = {
    name: "converted",
    url: fileUrl,
    async: false
  };

  const response = UrlFetchApp.fetch("https://api.pdf.co/v1/pdf/convert/to/png", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(convertPayload),
    headers: {
      "x-api-key": apiKey
    },
    muteHttpExceptions: true
  });

  Logger.log("Convert Response: " + response.getContentText());
}
////////////////////////////////////////////////////////////////////////////////////////////////////////////

// مساعد لاستخراج ID من رابط مجلد Google Drive
function getDriveId(url) {
  const match = url.match(/[-\w]{25,}/);
  return match ? match[0] : url;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////

function getOAuthToken() {
  return ScriptApp.getOAuthToken();
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
function submitStWRK(cpr,stWRKsel,id){

  var ss = SpreadsheetApp.openById(answersData);
  var sheet = ss.getSheetByName('stWorks');
  var allData = sheet.getDataRange().getValues();
  var headers = allData[0];
  var cprCol = headers.indexOf('cpr');
  var stWorksCol = headers.indexOf('stWorks');

  var cprF = cpr.split('-')[1];
  var url = DriveApp.getFileById(id).getUrl();
  
  var newRow = ['', new Date(), cprF, '', '', '', stWRKsel, url];

  // البحث مرة واحدة
  var rowIndex = allData.findIndex((row, i) =>
    i > 0 && row[cprCol] == cprF && row[stWorksCol] == stWRKsel
  );
  Logger.log(rowIndex)
  if (rowIndex > -1) {
    sheet.appendRow(newRow);
    return 0;

  } else {
    // غير موجود → إضافة صف
    sheet.appendRow(newRow);
    return 1;
  }

}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////////////////////

function checkWhatsApp(phone, actorCpr){
  var msg = 'التحقق من اتصال الواتساب عبر منصة بصائر';
  var result;
  try {
    result = sendWPRaw_(toInternationalWhatsAppNumber(phone), msg);
  } catch (err) {
    result = { status: false, reason: 'خطأ غير متوقع: ' + err.message };
  }
  var ok = !!(result && result.status);

  logWhatsAppMessage_({
    campaignId: '',
    templateKey: 'connectionTest',
    recipientName: '',
    recipientTarget: phone,
    targetType: 'phone',
    messageText: msg,
    status: ok ? 'sent' : 'failed',
    reason: ok ? '' : ((result && (result.reason || result.detail)) || 'خطأ غير معروف من خدمة واتساب'),
    sentBy: actorCpr || ''
  });

  return result;
}

//////////////////////////////////////////////////////////////////////////////////////////////////////////
// إدارة "المتعاونين" (شيت emp) من لوحة الإدارة — إضافة/تعديل/حذف، مع صلاحيات
// (تسجيل/تسميع/اختبار/إدارة/متابعة). راجع getStaffList في dataGet.js لدالة القراءة المقابلة.
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function findEmpRowByCpr_(cpr) {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('emp');
  if (!sh) return null;

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var lastRow = sh.getLastRow();
  if (lastRow < 2 || cprCol === -1) return null;

  var cprValues = sh.getRange(2, cprCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < cprValues.length; i++) {
    if (cprValues[i][0] !== '' && cprEquals_(cprValues[i][0], cpr)) {
      return { sheet: sh, headers: headers, rowNumber: i + 2 };
    }
  }
  return null;
}

function staffSetByName_(sheet, headers, rowNumber, values) {
  Object.keys(values).forEach(function (name) {
    var col = headers.indexOf(name);
    if (col > -1) sheet.getRange(rowNumber, col + 1).setValue(values[name]);
  });
}

function addStaff(data) {
  data = data || {};
  var cpr = String(data.cpr || '').trim();
  if (!/^\d{9}$/.test(cpr)) {
    return { ok: false, message: 'يرجى إدخال رقم شخصي صحيح (9 أرقام).' };
  }
  if (!data.name || !String(data.name).trim()) {
    return { ok: false, message: 'يرجى إدخال اسم المتعاون.' };
  }
  if (findEmpRowByCpr_(cpr)) {
    return { ok: false, message: 'هذا الرقم الشخصي مسجَّل بالفعل ضمن المتعاونين.' };
  }

  ensureEmpLecturerColumn_();
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('emp');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  var row = new Array(headers.length).fill('');
  var setByName = function (name, value) {
    var col = headers.indexOf(name);
    if (col > -1) row[col] = value;
  };
  setByName('cpr', cpr);
  setByName('name', String(data.name).trim());
  setByName('phone', data.phone || '');
  setByName('email', data.email || '');
  setByName('job', data.job || '');
  setByName('code', data.code || '');
  setByName('gender', data.gender || '');
  setByName('تسجيل', !!data.registration);
  setByName('تسميع', !!data.dictation);
  setByName('اختبار', !!data.exam);
  setByName('إدارة', !!data.manage);
  setByName('متابعة', !!data.followUp);
  setByName('محاضر', !!data.lecturer);

  sh.appendRow(row);
  return { ok: true };
}

function updateStaff(originalCpr, data) {
  data = data || {};
  ensureEmpLecturerColumn_();
  var found = findEmpRowByCpr_(originalCpr);
  if (!found) return { ok: false, message: 'تعذّر العثور على هذا المتعاون، ربما حُذف بالفعل.' };

  var newCpr = String(data.cpr || '').trim();
  if (!/^\d{9}$/.test(newCpr)) {
    return { ok: false, message: 'يرجى إدخال رقم شخصي صحيح (9 أرقام).' };
  }
  if (!data.name || !String(data.name).trim()) {
    return { ok: false, message: 'يرجى إدخال اسم المتعاون.' };
  }
  if (!cprEquals_(newCpr, originalCpr)) {
    var dup = findEmpRowByCpr_(newCpr);
    if (dup) return { ok: false, message: 'هذا الرقم الشخصي مستخدم بالفعل لمتعاون آخر.' };
  }

  staffSetByName_(found.sheet, found.headers, found.rowNumber, {
    cpr: newCpr,
    name: String(data.name).trim(),
    phone: data.phone || '',
    email: data.email || '',
    job: data.job || '',
    code: data.code || '',
    gender: data.gender || '',
    'تسجيل': !!data.registration,
    'تسميع': !!data.dictation,
    'اختبار': !!data.exam,
    'إدارة': !!data.manage,
    'متابعة': !!data.followUp,
    'محاضر': !!data.lecturer
  });

  return { ok: true };
}

function deleteStaff(cpr) {
  var found = findEmpRowByCpr_(cpr);
  if (!found) return { ok: false, message: 'تعذّر العثور على هذا المتعاون، ربما حُذف بالفعل.' };
  found.sheet.deleteRow(found.rowNumber);
  return { ok: true };
}

/* ==========================================================================
   إدارة الاختبارات — الكتابة الحقيقية (rules/questions)، حسب مواصفات مناقشات.md
   § "قسم إدارة الاختبارات". يقابلها القراءة في dataGet.js (getExamManagementData،
   getExamEditorData، ensureExamManagementColumns_، ensureQuestionManagementColumns_).

   ملاحظة هامة جدًا: اختبار "الفقه" حالة خاصة (يتفرّع فعليًا لثلاثة مذاهب منفصلة بشيت
   questions — انظر التعليق بجانب FIQH_MAZHAB_NAMES_ في dataGet.js)، ويُفترَض بكل أنحاء
   المشروع وجود صف واحد فقط باسمه بالضبط بشيت rules. saveExam يسمح بتعديل بياناته الأساسية
   (تاريخ/وقت/مدة/إظهار المراجعة) طالما بقي الاسم "الفقه" كما هو، لكنه يمنع صراحةً: إنشاء صف
   جديد بهذا الاسم، وتغيير اسمه من/إليه (يكسر كل فحوصات exam.name === 'الفقه' المنتشرة
   بالمشروع). أما النسخ (copyExam) فيبقى ممنوعًا له بالكامل أدناه — نسخ الصف الخاص سيُنشئ صفًا
   ثانيًا بنفس الاسم ويكسر نفس الافتراض، بخلاف مشكلة خلط أسئلة المذاهب الثلاثة بنموذج واحد.
   ========================================================================== */

// أول تحقق صلاحية من جانب الخادم بهذا المشروع (وليس فقط إخفاء أزرار بالواجهة، حسب
// مناقشات.md). exam_admin = إدارة=true بشيت emp (كل الصلاحيات). question_editor =
// اختبار=true بدون إدارة (الأسئلة فقط، بلا إنشاء/جدولة/أرشفة اختبار).
function hasExamPermission(userCpr) {
  var none = { allowed: false, isAdmin: false, isEditor: false, isSuperAdmin: false };
  if (!userCpr) return none;
  ensureEmpManagementColumns_();
  var sh = SpreadsheetApp.openById(mainData).getSheetByName('emp');
  var headers = sh.getRange('1:1').getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var manageCol = headers.indexOf('إدارة');
  var examCol = headers.indexOf('اختبار');
  var superAdminCol = headers.indexOf('superAdmin');
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return none;
  var rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
  var row = rows.find(function (r) { return normalizeCpr_(r[cprCol]) === normalizeCpr_(userCpr); });
  if (!row) return none;
  var isAdmin = row[manageCol] === true;
  var isEditor = row[examCol] === true;
  var isSuperAdmin = superAdminCol > -1 && row[superAdminCol] === true;
  return { allowed: isAdmin || isEditor || isSuperAdmin, isAdmin: isAdmin || isSuperAdmin, isEditor: isEditor, isSuperAdmin: isSuperAdmin };
}

// سجل عمليات إدارة الاختبارات (لا يوجد Audit Log سابق بالمشروع، حسب مناقشات.md) — يُنشئ
// الشيت أول استخدام له تلقائيًا.
function logExamOperation_(userCpr, action, details) {
  try {
    var ss = SpreadsheetApp.openById(refID);
    var sh = ss.getSheetByName('examAuditLog');
    if (!sh) {
      sh = ss.insertSheet('examAuditLog');
      sh.appendRow(['timestamp', 'userCpr', 'action', 'details']);
    }
    sh.appendRow([new Date(), userCpr, action, details]);
  } catch (err) {
    Logger.log('تعذّر تسجيل عملية بسجل عمليات الاختبارات: ' + err);
  }
}

// إنشاء/تعديل جدولة اختبار (شيت rules) — لا يلمس عمود check إطلاقًا. exam_admin فقط.
function saveExam(userCpr, examData) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية إدارة الاختبارات لإنشاء اختبار أو تعديل جدولته' };
  examData = examData || {};
  var name = String(examData.name || '').trim();
  if (!name) return { error: true, message: 'اسم الاختبار مطلوب' };
  if (examData.level === null || examData.level === undefined || examData.level === '') return { error: true, message: 'المرحلة مطلوبة' };
  if (!examData.startDate || !examData.endDate) return { error: true, message: 'تاريخ البداية والنهاية مطلوبان' };
  var start = new Date(examData.startDate + 'T' + (examData.startTime || '00:00'));
  var end = new Date(examData.endDate + 'T' + (examData.endTime || '23:59'));
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return { error: true, message: 'يجب أن يكون تاريخ/وقت النهاية بعد البداية' };
  var duration = parseInt(examData.duration, 10);
  if (!duration || duration < 5 || duration > 240) return { error: true, message: 'مدة الاختبار يجب أن تكون بين 5 و240 دقيقة' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
    var headers = ensureExamManagementColumns_();
    var levelCol = headers.indexOf('level'), examCol = headers.indexOf('exam'),
      startCol = headers.indexOf('start'), startTimeCol = headers.indexOf('startTime'),
      endCol = headers.indexOf('end'), endTimeCol = headers.indexOf('endTime'),
      durationCol = headers.indexOf('duration'), examIdCol = headers.indexOf('exam_id'),
      updatedByCol = headers.indexOf('updated_by'), updatedAtCol = headers.indexOf('updated_at'),
      archivedCol = headers.indexOf('archived'),
      showAnswerReviewCol = headers.indexOf('showAnswerReview');

    var lastRow = sh.getLastRow();
    var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];

    var targetRowIdx = -1;
    if (examData.id) {
      for (var i = 0; i < rows.length; i++) { if (String(rows[i][examIdCol]) === String(examData.id)) { targetRowIdx = i; break; } }
    }
    var existingName = targetRowIdx > -1 ? rows[targetRowIdx][examCol] : null;

    // اختبار "الفقه" حالة خاصة يتفرّع فعليًا لثلاثة مذاهب (راجع FIQH_MAZHAB_NAMES_ بـcode.js)
    // ويُفترَض بكل أنحاء المشروع وجود صف واحد فقط بهذا الاسم بالضبط — لذلك يُمنَع إنشاء اختبار
    // جديد بهذا الاسم (يكسر افتراض الصف الوحيد) ويُمنَع تغيير الاسم من/إلى "الفقه" (يكسر كل
    // فحوصات exam.name === 'الفقه' المنتشرة بـdataGet.js/examSessions.js). تعديل بياناته
    // الأساسية (تاريخ/وقت/مدة/إظهار المراجعة) مع بقاء الاسم "الفقه" كما هو مسموح صراحةً.
    if (name === 'الفقه' && existingName !== 'الفقه') {
      return { error: true, message: 'لا يمكن إنشاء اختبار جديد باسم "الفقه" أو إعادة تسمية اختبار آخر إليه من هنا' };
    }
    if (existingName === 'الفقه' && name !== 'الفقه') {
      return { error: true, message: 'لا يمكن تغيير اسم اختبار "الفقه" — الاسم مرتبط ببنية الاختبار الخاصة به' };
    }

    var dupExists = rows.some(function (r, i) {
      return i !== targetRowIdx && r[examCol] === name && +r[levelCol] === +examData.level && r[archivedCol] !== true;
    });
    if (dupExists) return { error: true, message: 'يوجد اختبار آخر بنفس الاسم في هذه المرحلة' };

    if (targetRowIdx > -1) {
      var rowNum = targetRowIdx + 2;
      sh.getRange(rowNum, examCol + 1).setValue(name);
      sh.getRange(rowNum, levelCol + 1).setValue(+examData.level);
      sh.getRange(rowNum, startCol + 1).setValue(examData.startDate);
      sh.getRange(rowNum, startTimeCol + 1).setValue(examData.startTime || '');
      sh.getRange(rowNum, endCol + 1).setValue(examData.endDate);
      sh.getRange(rowNum, endTimeCol + 1).setValue(examData.endTime || '');
      sh.getRange(rowNum, durationCol + 1).setValue(duration);
      sh.getRange(rowNum, showAnswerReviewCol + 1).setValue(examData.showAnswerReview !== false);
      sh.getRange(rowNum, updatedByCol + 1).setValue(userCpr);
      sh.getRange(rowNum, updatedAtCol + 1).setValue(new Date());
      logExamOperation_(userCpr, 'edit_exam', name);
      return { ok: true, id: examData.id };
    }

    var newId = Utilities.getUuid();
    var newRow = new Array(sh.getLastColumn()).fill('');
    newRow[levelCol] = +examData.level;
    newRow[examCol] = name;
    newRow[startCol] = examData.startDate;
    newRow[startTimeCol] = examData.startTime || '';
    newRow[endCol] = examData.endDate;
    newRow[endTimeCol] = examData.endTime || '';
    newRow[durationCol] = duration;
    newRow[examIdCol] = newId;
    newRow[updatedByCol] = userCpr;
    newRow[updatedAtCol] = new Date();
    newRow[archivedCol] = false;
    newRow[showAnswerReviewCol] = examData.showAnswerReview !== false;
    sh.appendRow(newRow);
    logExamOperation_(userCpr, 'create_exam', name);
    return { ok: true, id: newId };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// نسخ اختبار كامل (جدولته + كل نماذجه/أسئلته) كمسودة جديدة "الاسم - نسخة". exam_admin فقط.
function duplicateExam(userCpr, examId) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية إدارة الاختبارات للنسخ' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var ss = SpreadsheetApp.openById(refID);
    var sh = ss.getSheetByName('rules');
    var headers = ensureExamManagementColumns_();
    var levelCol = headers.indexOf('level'), examCol = headers.indexOf('exam'),
      durationCol = headers.indexOf('duration'), examIdCol = headers.indexOf('exam_id'),
      updatedByCol = headers.indexOf('updated_by'), updatedAtCol = headers.indexOf('updated_at'),
      archivedCol = headers.indexOf('archived');

    var lastRow = sh.getLastRow();
    var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
    var src = rows.find(function (r) { return String(r[examIdCol]) === String(examId); });
    if (!src) return { error: true, message: 'الاختبار غير موجود' };
    if (src[examCol] === 'الفقه') return { error: true, message: 'اختبار الفقه لا يمكن نسخه من هنا حاليًا' };

    var newId = Utilities.getUuid();
    var newName = src[examCol] + ' - نسخة';
    var newRow = new Array(sh.getLastColumn()).fill('');
    newRow[levelCol] = src[levelCol];
    newRow[examCol] = newName;
    newRow[durationCol] = src[durationCol];
    newRow[examIdCol] = newId;
    newRow[updatedByCol] = userCpr;
    newRow[updatedAtCol] = new Date();
    newRow[archivedCol] = false;
    // النسخة تُحفظ كمسودة دائمًا (بلا مواعيد إتاحة)، بصرف النظر عن مواعيد الأصل
    sh.appendRow(newRow);

    var qSh = ss.getSheetByName('questions');
    var qHeaders = ensureQuestionManagementColumns_();
    var qBranchCol = qHeaders.indexOf('الكتاب / المتن'), qLevelCol = qHeaders.indexOf('المرحلة'),
      qIdCol = qHeaders.indexOf('question_id'), qExamIdCol = qHeaders.indexOf('exam_id');
    var qLastRow = qSh.getLastRow();
    if (qLastRow > 1) {
      var qData = qSh.getRange(2, 1, qLastRow - 1, qSh.getLastColumn()).getValues();
      var toCopy = qData.filter(function (r) { return r[qBranchCol] === src[examCol] && r[qLevelCol] === src[levelCol]; });
      if (toCopy.length) {
        var copies = toCopy.map(function (r) {
          var copy = r.slice();
          copy[qBranchCol] = newName;
          copy[qIdCol] = Utilities.getUuid();
          copy[qExamIdCol] = newId;
          return copy;
        });
        qSh.getRange(qSh.getLastRow() + 1, 1, copies.length, qSh.getLastColumn()).setValues(copies);
      }
    }

    logExamOperation_(userCpr, 'duplicate_exam', src[examCol] + ' → ' + newName);
    return { ok: true, id: newId };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// حذف اختبار = أرشفة (archived=TRUE) لا حذف فعلي، فتُحفظ البيانات ويختفي من القوائم/الطلاب.
// exam_admin فقط.
function archiveExam(userCpr, examId) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية إدارة الاختبارات للحذف' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
    var headers = ensureExamManagementColumns_();
    var examIdCol = headers.indexOf('exam_id'), archivedCol = headers.indexOf('archived'),
      examCol = headers.indexOf('exam'), updatedByCol = headers.indexOf('updated_by'), updatedAtCol = headers.indexOf('updated_at');
    var lastRow = sh.getLastRow();
    var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][examIdCol]) === String(examId)) {
        var rowNum = i + 2;
        sh.getRange(rowNum, archivedCol + 1).setValue(true);
        sh.getRange(rowNum, updatedByCol + 1).setValue(userCpr);
        sh.getRange(rowNum, updatedAtCol + 1).setValue(new Date());
        logExamOperation_(userCpr, 'archive_exam', rows[i][examCol]);
        return { ok: true };
      }
    }
    return { error: true, message: 'الاختبار غير موجود' };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// استعادة اختبار مؤرشف (archived=FALSE) — يعيده لظهور الطلاب والقوائم بحالته المحسوبة من
// التواريخ كالمعتاد. exam_admin فقط، نفس صلاحية الحذف/الأرشفة.
function unarchiveExam(userCpr, examId) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية إدارة الاختبارات للاستعادة' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
    var headers = ensureExamManagementColumns_();
    var examIdCol = headers.indexOf('exam_id'), archivedCol = headers.indexOf('archived'),
      examCol = headers.indexOf('exam'), updatedByCol = headers.indexOf('updated_by'), updatedAtCol = headers.indexOf('updated_at');
    var lastRow = sh.getLastRow();
    var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][examIdCol]) === String(examId)) {
        var rowNum = i + 2;
        sh.getRange(rowNum, archivedCol + 1).setValue(false);
        sh.getRange(rowNum, updatedByCol + 1).setValue(userCpr);
        sh.getRange(rowNum, updatedAtCol + 1).setValue(new Date());
        logExamOperation_(userCpr, 'unarchive_exam', rows[i][examCol]);
        return { ok: true };
      }
    }
    return { error: true, message: 'الاختبار غير موجود' };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// يفتح/يغلق إمكانية إعادة المحاولة لكل من رسب في هذا الاختبار — يحل محل مهلة الـ24 ساعة الثابتة
// القديمة بتحكم إداري صريح لكل اختبار (submitAnswerData/getQuestions/getAnswersData بdataGet.js
// تقرأ نفس العمود). exam_admin فقط.
function setExamRetakeOpen(userCpr, examId, open) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية إدارة الاختبارات' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var sh = SpreadsheetApp.openById(refID).getSheetByName('rules');
    var headers = ensureExamManagementColumns_();
    var examIdCol = headers.indexOf('exam_id'), retakeCol = headers.indexOf('retakeOpen'),
      examCol = headers.indexOf('exam'), updatedByCol = headers.indexOf('updated_by'), updatedAtCol = headers.indexOf('updated_at');
    var lastRow = sh.getLastRow();
    var rows = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues() : [];
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][examIdCol]) === String(examId)) {
        var rowNum = i + 2;
        sh.getRange(rowNum, retakeCol + 1).setValue(!!open);
        sh.getRange(rowNum, updatedByCol + 1).setValue(userCpr);
        sh.getRange(rowNum, updatedAtCol + 1).setValue(new Date());
        logExamOperation_(userCpr, open ? 'open_retake' : 'close_retake', rows[i][examCol]);
        return { ok: true };
      }
    }
    return { error: true, message: 'الاختبار غير موجود' };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

function normalizeQuestionStoragePayload_(questionData) {
  questionData = questionData || {};
  var options = (questionData.options || []).slice(0, 5).map(function (option) {
    option = option || {};
    var marked = option.correct === true || option.correct === 1 || String(option.correct).toLowerCase() === 'true';
    return { text: option.text == null ? '' : String(option.text), correct: marked };
  });
  var correctIndexes = [];
  options.forEach(function (option, index) { if (option.correct) correctIndexes.push(index); });
  var filledOptions = options.filter(function (option) { return String(option.text || '').trim(); }).length;
  var correctIndex = correctIndexes.length === 1 ? correctIndexes[0] : -1;
  var correctIsFilled = correctIndex > -1 && !!String(options[correctIndex].text || '').trim();
  var text = questionData.text == null ? '' : String(questionData.text);
  return {
    text: text,
    options: options,
    correctNumber: correctIsFilled ? correctIndex + 1 : '',
    complete: !!text.trim() && filledOptions >= 2 && correctIndexes.length === 1 && correctIsFilled
  };
}

// حفظ سؤال واحد (جديد أو تعديل) بشيت questions — exam_admin أو question_editor. تُحفظ حتى
// الأسئلة غير المكتملة (status=draft)، حسب مناقشات.md. اختبار "الفقه" حالة خاصة (راجع
// FIQH_MAZHAB_NAMES_ بـcode.js) — `mazhab` مطلوب حينها، ويُستخدَم كاسم الفرع الفعلي بعمود
// "الكتاب / المتن" بدل "الفقه" نفسه.
function saveQuestion(userCpr, examId, modelNumber, questionData, mazhab) {
  var perm = hasExamPermission(userCpr);
  if (!perm.allowed) return { error: true, message: 'لا تملك صلاحية تعديل أسئلة الاختبارات' };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var ss = SpreadsheetApp.openById(refID);
    var rulesSh = ss.getSheetByName('rules');
    var rHeaders = rulesSh.getRange(1, 1, 1, rulesSh.getLastColumn()).getValues()[0];
    var rExamCol = rHeaders.indexOf('exam'), rLevelCol = rHeaders.indexOf('level'), rIdCol = rHeaders.indexOf('exam_id');
    var rLastRow = rulesSh.getLastRow();
    var rRows = rLastRow > 1 ? rulesSh.getRange(2, 1, rLastRow - 1, rulesSh.getLastColumn()).getValues() : [];
    var examRow = rRows.find(function (r) { return String(r[rIdCol]) === String(examId); });
    if (!examRow) return { error: true, message: 'الاختبار غير موجود' };
    var examName = examRow[rExamCol];
    var level = examRow[rLevelCol];
    var isFiqh = examName === 'الفقه';
    if (isFiqh && FIQH_MAZHAB_NAMES_.indexOf(mazhab) === -1) return { error: true, message: 'يلزم تحديد المذهب لحفظ سؤال باختبار الفقه' };
    var branchName = isFiqh ? mazhab : examName;

    var qSh = ss.getSheetByName('questions');
    var qHeaders = ensureQuestionManagementColumns_();
    var qBranchCol = qHeaders.indexOf('الكتاب / المتن'), qLevelCol = qHeaders.indexOf('المرحلة'),
      qFormCol = qHeaders.indexOf('نموذج'), qNumCol = qHeaders.indexOf('#'),
      qQuestionCol = qHeaders.indexOf('السؤال'),
      qTrueAnswerCol = qHeaders.indexOf('الجواب الصحيح'), qIdCol = qHeaders.indexOf('question_id'),
      qExamIdCol = qHeaders.indexOf('exam_id'), qStatusCol = qHeaders.indexOf('status'),
      qUpdatedByCol = qHeaders.indexOf('updated_by'), qUpdatedAtCol = qHeaders.indexOf('updated_at');
    var qAnswerCols = [1, 2, 3, 4, 5].map(function (number) { return qHeaders.indexOf('answer-' + number); });

    var normalizedQuestion = normalizeQuestionStoragePayload_(questionData);
    var options = normalizedQuestion.options;

    var lastRow = qSh.getLastRow();
    var existingRowNum = -1;
    if (questionData.id && String(questionData.id).indexOf('new_') !== 0) {
      var ids = lastRow > 1 ? qSh.getRange(2, qIdCol + 1, lastRow - 1, 1).getValues() : [];
      for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]) === String(questionData.id)) { existingRowNum = i + 2; break; } }
    }

    var questionId = (questionData.id && String(questionData.id).indexOf('new_') !== 0) ? questionData.id : Utilities.getUuid();

    var rowValues = {};
    rowValues[qBranchCol] = branchName;
    rowValues[qLevelCol] = level;
    rowValues[qFormCol] = modelNumber;
    rowValues[qQuestionCol] = normalizedQuestion.text;
    for (var a = 0; a < 5; a++) rowValues[qAnswerCols[a]] = options[a] ? (options[a].text || '') : '';
    // الإجابة الصحيحة تُحفظ برقم من 1 (مو 0) — مناقشات.md
    rowValues[qTrueAnswerCol] = normalizedQuestion.correctNumber;
    rowValues[qIdCol] = questionId;
    rowValues[qExamIdCol] = examId;
    rowValues[qStatusCol] = normalizedQuestion.complete ? 'complete' : 'draft';
    rowValues[qUpdatedByCol] = userCpr;
    rowValues[qUpdatedAtCol] = new Date();

    if (existingRowNum > -1) {
      var fullRow = qSh.getRange(existingRowNum, 1, 1, qSh.getLastColumn()).getValues()[0];
      Object.keys(rowValues).forEach(function (colIdx) { fullRow[+colIdx] = rowValues[colIdx]; });
      qSh.getRange(existingRowNum, 1, 1, fullRow.length).setValues([fullRow]);
      logExamOperation_(userCpr, 'edit_question', branchName + ' — نموذج ' + modelNumber);
    } else {
      var sameExamCount = lastRow > 1
        ? qSh.getRange(2, 1, lastRow - 1, qSh.getLastColumn()).getValues().filter(function (r) { return r[qBranchCol] === branchName && r[qLevelCol] === level; }).length
        : 0;
      rowValues[qNumCol] = sameExamCount + 1; // تقريبي؛ تُعاد الترقيم الدقيقة لاحقًا عند بناء دفعة "حفظ الاختبار" الشاملة
      var newRow = new Array(qSh.getLastColumn()).fill('');
      Object.keys(rowValues).forEach(function (colIdx) { newRow[+colIdx] = rowValues[colIdx]; });
      qSh.appendRow(newRow);
      logExamOperation_(userCpr, 'add_question', branchName + ' — نموذج ' + modelNumber);
    }

    // أي تعديل داخل نموذج معتمد يعيده تلقائيًا إلى مسودة حتى يُراجَع ويُعتمد من جديد.
    markExamModelDraft_(examId, branchName, level, modelNumber, userCpr);
    return { ok: true, id: questionId, status: rowValues[qStatusCol], modelStatus: 'draft' };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// استيراد دفعة أسئلة (من ملف إكسل يُحلَّل بالكامل في العميل عبر XLSX.js — راجع
// examImportExcelModal/parseImportedQuestionRows_ بـadmin-js.html) إلى نموذج واحد بنفس
// الاختبار. نفس بنية questionData بـsaveQuestion لكل عنصر ({text, options:[{text,correct}]})،
// لكن تُكتب كل الصفوف بنداء setValues واحد بدل تكرار saveQuestion (قفل/قراءة/كتابة منفصلة)
// لكل سؤال — قد يصل الملف لعشرات أو مئات الأسئلة. exam_admin أو question_editor (نفس صلاحية
// saveQuestion). اختبار "الفقه" حالة خاصة — نفس معالجة `mazhab` في saveQuestion تمامًا.
function importQuestionsBulk(userCpr, examId, modelNumber, questions, mazhab) {
  var perm = hasExamPermission(userCpr);
  if (!perm.allowed) return { error: true, message: 'لا تملك صلاحية تعديل أسئلة الاختبارات' };
  if (!Array.isArray(questions) || !questions.length) return { error: true, message: 'لا توجد أسئلة للاستيراد' };
  var normalizedQuestions = questions.map(normalizeQuestionStoragePayload_);
  for (var questionIndex = 0; questionIndex < normalizedQuestions.length; questionIndex++) {
    if (!normalizedQuestions[questionIndex].complete) {
      return { error: true, message: 'تعذّر الاستيراد: السؤال رقم ' + (questionIndex + 1) + ' لا يحتوي نصًا واختيارين وإجابة صحيحة واحدة صالحة' };
    }
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var ss = SpreadsheetApp.openById(refID);
    var rulesSh = ss.getSheetByName('rules');
    var rHeaders = rulesSh.getRange(1, 1, 1, rulesSh.getLastColumn()).getValues()[0];
    var rExamCol = rHeaders.indexOf('exam'), rLevelCol = rHeaders.indexOf('level'), rIdCol = rHeaders.indexOf('exam_id');
    var rLastRow = rulesSh.getLastRow();
    var rRows = rLastRow > 1 ? rulesSh.getRange(2, 1, rLastRow - 1, rulesSh.getLastColumn()).getValues() : [];
    var examRow = rRows.find(function (r) { return String(r[rIdCol]) === String(examId); });
    if (!examRow) return { error: true, message: 'الاختبار غير موجود' };
    var examName = examRow[rExamCol];
    var level = examRow[rLevelCol];
    var isFiqh = examName === 'الفقه';
    if (isFiqh && FIQH_MAZHAB_NAMES_.indexOf(mazhab) === -1) return { error: true, message: 'يلزم تحديد المذهب لاستيراد أسئلة باختبار الفقه' };
    var branchName = isFiqh ? mazhab : examName;

    var qSh = ss.getSheetByName('questions');
    var qHeaders = ensureQuestionManagementColumns_();
    var qBranchCol = qHeaders.indexOf('الكتاب / المتن'), qLevelCol = qHeaders.indexOf('المرحلة'),
      qFormCol = qHeaders.indexOf('نموذج'), qNumCol = qHeaders.indexOf('#'),
      qQuestionCol = qHeaders.indexOf('السؤال'),
      qTrueAnswerCol = qHeaders.indexOf('الجواب الصحيح'), qIdCol = qHeaders.indexOf('question_id'),
      qExamIdCol = qHeaders.indexOf('exam_id'), qStatusCol = qHeaders.indexOf('status'),
      qUpdatedByCol = qHeaders.indexOf('updated_by'), qUpdatedAtCol = qHeaders.indexOf('updated_at');
    var qAnswerCols = [1, 2, 3, 4, 5].map(function (number) { return qHeaders.indexOf('answer-' + number); });

    var lastRow = qSh.getLastRow();
    var existingCount = lastRow > 1
      ? qSh.getRange(2, 1, lastRow - 1, qSh.getLastColumn()).getValues().filter(function (r) { return r[qBranchCol] === branchName && r[qLevelCol] === level; }).length
      : 0;

    var now = new Date();
    var ids = [];
    var newRows = normalizedQuestions.map(function (qData, idx) {
      var options = qData.options;
      var questionId = Utilities.getUuid();
      ids.push(questionId);

      var row = new Array(qSh.getLastColumn()).fill('');
      row[qBranchCol] = branchName;
      row[qLevelCol] = level;
      row[qFormCol] = modelNumber;
      row[qNumCol] = existingCount + idx + 1;
      row[qQuestionCol] = qData.text || '';
      for (var a = 0; a < 5; a++) row[qAnswerCols[a]] = options[a] ? (options[a].text || '') : '';
      row[qTrueAnswerCol] = qData.correctNumber;
      row[qIdCol] = questionId;
      row[qExamIdCol] = examId;
      row[qStatusCol] = 'complete';
      row[qUpdatedByCol] = userCpr;
      row[qUpdatedAtCol] = now;
      return row;
    });

    qSh.getRange(lastRow + 1, 1, newRows.length, qSh.getLastColumn()).setValues(newRows);
    markExamModelDraft_(examId, branchName, level, modelNumber, userCpr);
    logExamOperation_(userCpr, 'import_questions', branchName + ' — نموذج ' + modelNumber + ' (' + newRows.length + ' سؤالًا)');

    return { ok: true, imported: newRows.length, ids: ids, modelStatus: 'draft' };
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}

// حذف سؤال واحد (حذف فعلي للصف، بخلاف حذف الاختبار نفسه اللي هو أرشفة). exam_admin أو
// question_editor.
function deleteQuestion(userCpr, questionId) {
  var perm = hasExamPermission(userCpr);
  if (!perm.allowed) return { error: true, message: 'لا تملك صلاحية حذف أسئلة الاختبارات' };
  if (!questionId || String(questionId).indexOf('new_') === 0) return { ok: true }; // سؤال محلي لسه ماتحفظش، مفيش صف نحذفه

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { error: true, message: 'الشيت مشغول بعملية أخرى الآن، حاول مرة أخرى بعد قليل' };
  try {
    var qSh = SpreadsheetApp.openById(refID).getSheetByName('questions');
    var headers = qSh.getRange(1, 1, 1, qSh.getLastColumn()).getValues()[0];
    var qIdCol = headers.indexOf('question_id'), qExamIdCol = headers.indexOf('exam_id'),
      qBranchCol = headers.indexOf('الكتاب / المتن'), qLevelCol = headers.indexOf('المرحلة'),
      qFormCol = headers.indexOf('نموذج');
    var lastRow = qSh.getLastRow();
    if (lastRow < 2) return { ok: true };
    var rows = qSh.getRange(2, 1, lastRow - 1, qSh.getLastColumn()).getValues();
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][qIdCol]) === String(questionId)) {
        var affected = rows[i];
        qSh.deleteRow(i + 2);
        markExamModelDraft_(affected[qExamIdCol], affected[qBranchCol], affected[qLevelCol], affected[qFormCol], userCpr);
        logExamOperation_(userCpr, 'delete_question', 'question_id=' + questionId);
        return { ok: true, modelStatus: 'draft' };
      }
    }
    return { ok: true }; // مش موجود أصلًا — نعتبرها نجحت
  } catch (err) {
    return { error: true, message: String(err) };
  } finally {
    lock.releaseLock();
  }
}
