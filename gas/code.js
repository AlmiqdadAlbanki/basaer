var myLogo = "https://drive.google.com/thumbnail?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&sz=w1000.png";
var perData = '17fdS60BDbh7uanOIBKcI_7H2ZDdUVVTs77_jV_M1EzE';
var mainData = '1Y3zNCw4i3VmNdj3BjhkerpzIV8VijOVfAwY9_ixN8ic';
var attendanceData = '1TjNcFeccyK9BhPBbpfx8cZqPvJbJtSfgptse_fahg1g';
var answersData = '18uSjZYwLzY5O5XlzL46SwAELnrTwzILHs3fzq0x58ok';
var dectationData = '1qs50ANDMENyGVPxet2S0keRZ2Cxur_jSAj2pMY4Mojo';
var refID = '1L-VXGGxNX-4th2ytpTC7YsVo1p3xAzc-JLmoGdpIdgo';
// Spreadsheet "الأرشيف" — راجع مناقشات.md "تعديل آلية قبول طالب".
var archiveData = '1RGgPD6r44RCnnGQFlxj9603bu1E-D6YaIVCJSySCxNs';

// اختبار "الفقه" الموحّد بشيت rules يتفرّع فعليًا لثلاثة مذاهب — لا توجد أسئلة مخزَّنة باسمه
// الحرفي بشيت questions إطلاقًا، بل تحت أحد هذه الأسماء الثلاثة بعمود "الكتاب / المتن"
// (راجع مناقشات.md "حل مشكلة اختبار الفقه"). مُستخدَم من dataGet.js وdataPost.js معًا.
var FIQH_MAZHAB_NAMES_ = ['المذهب الحنبلي', 'المذهب الشافعي', 'المذهب المالكي'];
var perArchiveID = '1PexT7pwgJdaBUncuykBh6kYDAzzhyNYs'

// تعريف أسئلة استبيانَي قبل/بعد الاختبار — مصدر واحد يستخدمه submitExamSurvey/ensureSurveysSheet_
// (dataPost.js) للتحقق وبناء أعمدة الشيت، وgetExamSurveyStats (dataGet.js) لبناء الإحصائية.
// **يجب مطابقة المفاتيح (key) والنصوص هنا يدويًا لنفس التعريف بواجهة الطالب (survey-js.html:
// SURVEY_PRE_GROUPS/SURVEY_PRE_ADMIN_FIELD/SURVEY_POST_FIELDS)** — Apps Script HTML Service لا
// تسمح بمشاركة كائن واحد بين كود الخادم وكود العميل. أي إضافة/حذف/تعديل نص لسؤال يلزمه تحديث
// الملفّين معًا. "options" اختيارية: تُترَك لتُستخدَم القيم 1-5 الافتراضية إن لم تُحدَّد.
var SURVEY_PRE_GROUPS_ = [
  { title: 'المادة المقررة', fields: [
    { key: 'subject_need', label: 'مدى الحاجة إلى هذه المادة' },
    { key: 'subject_difficulty', label: 'مستوى صعوبة المادة' },
    { key: 'subject_society_need', label: 'مدى حاجة المجتمع إلى هذه المادة' },
    { key: 'subject_added_value', label: 'مقدار الإضافة العلمية التي حقّقتها المادة لمعلوماتك' },
    { key: 'subject_size', label: 'مدى مناسبة حجم المادة وكمّها' }
  ] },
  { title: 'المحاضر', fields: [
    { key: 'lecturer_adherence', label: 'مدى التزام المحاضر بالمقرر' },
    { key: 'lecturer_style', label: 'أسلوب المحاضر في الشرح' },
    { key: 'lecturer_time', label: 'التزام المحاضر بالوقت المحدَّد' },
    { key: 'lecturer_communication', label: 'تواصل المحاضر مع الطلاب' }
  ] }
];
var SURVEY_PRE_STANDALONE_ = [
  { key: 'admin', label: 'تقييمك لإدارة الأكاديمية بشكل عام' }
];
var SURVEY_POST_STANDALONE_ = [
  { key: 'exam_level', label: 'مستوى الاختبار', options: ['سهل جدًا', 'سهل', 'متوسط', 'صعب', 'صعب جدًا'] },
  { key: 'exam_length', label: 'مدى مناسبة طول الاختبار' },
  { key: 'exam_comprehensiveness', label: 'مدى شمول الاختبار لمحتوى المادة' },
  { key: 'exam_clarity', label: 'وضوح صياغة أسئلة الاختبار' }
];

function surveyPreFieldDefs_() {
  var list = SURVEY_PRE_STANDALONE_.slice();
  SURVEY_PRE_GROUPS_.forEach(function (g) { list = list.concat(g.fields); });
  return list;
}
function surveyPostFieldDefs_() { return SURVEY_POST_STANDALONE_.slice(); }

// الرقم الشخصي (CPR) دائمًا 9 أرقام بالضبط. بعض خلايا عمود cpr في الشيتات كانت (أو ما زالت)
// مُنسَّقة كرقم لا كنص، فتُسقِط أي صفر بادئ تلقائيًا (مثال: "012345678" تُخزَّن كـ 12345678،
// 8 أرقام فقط) — ما يجعل مقارنة نصية صارمة بين القيمة المقروءة من الشيت والرقم الذي يكتبه
// الطالب تفشل رغم تطابق الرقم الفعلي. هذه الدالة تُعيد بناء الصورة الصحيحة (9 أرقام) قبل أي
// مقارنة أو عرض، بإضافة أصفار بادئة عند الحاجة فقط لقيم رقمية بحتة أقصر من 9 خانات.
function normalizeCpr_(val) {
  var s = String(val == null ? '' : val).trim();
  if (!s) return '';
  while (s.length < 9 && /^\d+$/.test(s)) s = '0' + s;
  return s;
}

// للمقارنة (وليس للعرض): تحويل القيمتين لأرقام قبل المقارنة، بصرف النظر عن كون كل قيمة مقروءة
// من الشيت كنص أو كرقم. الصفر البادئ لا يغيّر القيمة الرقمية الفعلية، فمقارنة الأرقام آمنة
// دائمًا من مشكلة "نص مقابل رقم" التي تُفشل أي مقارنة نصية صارمة (===) بين خليتين لهما نفس
// الرقم الشخصي لكن بنوعي بيانات مختلفين.
function cprEquals_(a, b) {
  var na = Number(String(a == null ? '' : a).trim());
  var nb = Number(String(b == null ? '' : b).trim());
  return !isNaN(na) && !isNaN(nb) && na === nb;
}

// قاعدة خصوصية صور المستخدمين (بطلب صريح من المستخدم): صورة أي مستخدِمة أنثى لا تظهر إطلاقًا إلا
// لها هي شخصيًا من خلال صفحتها الشخصية تحديدًا (getMyProfileData بـdataGet.js هي المسار الوحيد
// المسموح له بإرجاع الصورة الحقيقية لأنثى). أي دالة أخرى تُعيد بيانات لعرضها لطرف آخر (قوائم
// الإدارة، الشريط الجانبي/العلوي، إلخ — حتى لو كان الطرف هو نفس صاحبة الحساب خارج صفحتها الشخصية)
// يجب أن تمرّر قيمة avatarUrl عبر هذه الدالة بدل قراءة العمود مباشرة. المستخدم الذكر: لا تغيير،
// صورته تظهر كما كانت دائمًا في كل مكان.
function genderSafeAvatarUrl_(gender, rawAvatarUrl) {
  return gender === 'أنثى' ? '' : (rawAvatarUrl || '');
}

// ===================================================================
// تسجيل الطلاب خارج البحرين (دراسة عن بُعد) — لا يملكون رقمًا شخصيًا بحرينيًا،
// فنولّد لهم "هويةً" بديلة تُخزَّن في نفس عمود cpr وتُستخدم بنفس طريقة الدخول تمامًا.
// 9 أرقام بالضبط، لتطابق شكل الرقم الشخصي البحريني تمامًا: أول رقمين = آخر رقمين من سنة
// الميلاد، يليهما رقمان لشهر الميلاد، ثم 5 أرقام عشوائية. لا ضمان رياضي بعدم التطابق مع رقم
// شخصي حقيقي مستقبلي (كما كان الحال مع الصيغة السابقة من 10 خانات)، فنعتمد بدلًا من ذلك على
// فحص فعلي لعدم تكرارها مع أي طالب مسجَّل حاليًا (الفحص عبر normalizeCpr_ حتى يقارن بالقيمة
// الصحيحة الكاملة حتى لو فقدت خلية قديمة صفرها البادئ).
// ===================================================================
function generateRemoteStudentId(dob) {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var cprCol = headers.indexOf('cpr');
  var lastRow = sh.getLastRow();
  var existing = (lastRow > 1 && cprCol > -1)
    ? sh.getRange(2, cprCol + 1, lastRow - 1, 1).getValues().map(function (r) { return normalizeCpr_(r[0]); })
    : [];

  var yy = '00', mm = '01';
  var d = dob ? new Date(dob) : null;
  if (d && !isNaN(d.getTime())) {
    // UTC عمدًا: dob يصل كسلسلة تاريخ فقط (YYYY-MM-DD من حقل type="date")، وJS يُفسّرها كمنتصف
    // ليل UTC — قراءتها بدوال محلية قد تُزيح اليوم لو اختلفت منطقة زمن السكربت لاحقًا.
    yy = String(d.getUTCFullYear() % 100);
    if (yy.length < 2) yy = '0' + yy;
    mm = String(d.getUTCMonth() + 1);
    if (mm.length < 2) mm = '0' + mm;
  }

  var id, attempts = 0;
  do {
    var rand5 = String(Math.floor(Math.random() * 100000));
    while (rand5.length < 5) rand5 = '0' + rand5;
    id = yy + mm + rand5;
    attempts++;
  } while (existing.indexOf(id) > -1 && attempts < 1000);

  return id;
}

// يقبل رقمًا شخصيًا صحيحًا (9 أرقام بالضبط) — سواء كان رقمًا شخصيًا بحرينيًا حقيقيًا أو هوية
// مولَّدة لطالب خارج البحرين (نفس الصيغة تمامًا، راجع generateRemoteStudentId أعلاه).
function isValidPersonId(id) {
  return /^\d{9}$/.test(String(id == null ? '' : id).trim());
}

// ===================================================================
// تطبيع رقم الهاتف لصيغة دولية كاملة (أرقام فقط، بلا +/مسافات) صالحة للإرسال المباشر
// لواتساب (wa.me أو Fonnte)، بصرف النظر عن الصيغة التي خُزِّن بها في عمود phone:
//  - أرقام بحرينية قديمة (قبل هذا التحديث): 8 خانات بلا كود دولة → نضيف 973.
//  - أي رقم آخر (تسجيل جديد بعد هذا التحديث، بحريني أو غير بحريني): مُخزَّن بالفعل بصيغة
//    دولية كاملة شاملة كود الدولة → يُستخدم كما هو دون أي تعديل.
// نسخة مطابقة تمامًا موجودة أيضًا على العميل (js.html) لنفس الغرض في واجهات لا تستدعي الخادم.
// ===================================================================
function toInternationalWhatsAppNumber(rawPhone) {
  var digits = String(rawPhone == null ? '' : rawPhone).replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.indexOf('00') === 0) digits = digits.substring(2); // كود خروج دولي زائد
  while (digits.charAt(0) === '0' && digits.length > 8) digits = digits.substring(1);
  if (digits.length === 8) digits = '973' + digits;
  return digits;
}

// ===================================================================
// الاسم الأول فقط من اسم كامل، مع معاملة "عبد" + كلمة تالية تبدأ بـ"ال" (عبد الله/عبد
// الرحمن/عبد الرازق/...) كاسم واحد غير قابل للتجزئة — بطلب المستخدم صراحةً لرسائل واتساب
// الشخصية ("خليها اسم واحد"). نفس قاعدة الزوج الأول المستخدَمة أصلًا بـshortDisplayName
// (js.html، للعرض المختصر بالشريط الجانبي)، لكن بمسافة طبيعية بين الكلمتين (لا دمج بلا
// مسافة) لأن هذا نص رسالة يُقرأ لا تسمية مضغوطة. نسخة مطابقة أيضًا بالعميل (js.html) لنفس
// السبب الموثَّق أعلاه لـtoInternationalWhatsAppNumber (بعض الواجهات لا تستدعي الخادم).
// ===================================================================
function firstNameOnly_(fullName) {
  var parts = String(fullName == null ? '' : fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  var isAbdPair = parts[0] === 'عبد' && parts[1] && parts[1].indexOf('ال') === 0;
  return isAbdPair ? (parts[0] + ' ' + parts[1]) : parts[0];
}

// يضمن وجود عمودي "خارج البحرين" و"نوع الدراسة" في شيت students (يُنشئهما تلقائيًا لو
// غير موجودين، بنفس أسلوب ensureAuthColumns في auth.js) — تُستدعى دفاعيًا من newStuReg قبل
// الكتابة عليهما، فلا حاجة لتشغيلها يدويًا من محرر Apps Script.
function ensureStudentResidencyColumns_() {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName('students');
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var toAdd = ['outsideBahrain', 'studyType'].filter(function (col) {
    return headers.indexOf(col) === -1;
  });
  if (toAdd.length) {
    sh.getRange(1, sh.getLastColumn() + 1, 1, toAdd.length).setValues([toAdd]);
  }
}


let qr00Color = 'a77d52';
let qr01Color = '325969';
let qr02Color = '7b7364';
let qr03Color = '8a4b3b';

///////////////////////////////////////////////////////////////
/////////////////////////////whatsApp/////////////////////////isav3xCvCrmnDJMJK6oFwCm
///////////////////////////////////////////////////////////////ZoZQ9kQyuqpCz9rjFR5h
  // Authorization is a lazy getter: the token is read from the sheet only when
  // a WhatsApp request actually reads this header, not at script-load time.
  // (On Apps Script the eager read ran on every single invocation; under the
  // self-hosted runtime every RPC rebuilds the global scope, so an eager read
  // here would hit the database on every call. Call sites are unchanged.)
  const headersForWatsapp = {
    get Authorization() { return getTokenForwhatsApp_(); },
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

function getTokenForwhatsApp_(){
  var ss = SpreadsheetApp.openById(refID);
  var sh = ss.getSheetByName('main');

  // قراءة رؤوس الأعمدة
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];

  // تحديد رقم عمود "registration"
  var whatsAppCol = headers.indexOf('whatsApp') + 1;
  if (whatsAppCol === 0) {
    throw new Error('لم يتم العثور على عمود باسم registration');
  }

  // قراءة قيمة الصف الثاني في هذا العمود
  var whatsAppData = sh.getRange(2, whatsAppCol,sh.getLastRow(),3).getValues().filter(e=> e[2]);

  Logger.log(whatsAppData[0][1]);
  return whatsAppData[0][1];  
}
///////////////////////////////////////////////////////////////
/////////////////////////////whatsApp/////////////////////////
///////////////////////////////////////////////////////////////


var certIdTemp = "1j7fbLyJH4Ef6zLRbHr9upaSy4zapOSu3VJpwrDELlN4";
var malesPdfsFolderID = "1olwmdY3CpEifAuiowYq-v2ye-u2kIgWw";
var femalesPdfsFolderID = "1rX1N8Ev05q1iL791iBMYk5lcuVGtDI0_";
var forPrintFolderID = "1lX4uTZx__9DES7SLhvFpfnp8OVvP7sHz";
var tempFolderID = "10JcyF3apckQ1UgrQ3MkquW85og-sQ4rH";
var sheetName = 'bayquneia';

///////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////

function doGet(e) {

  //var tmp = HtmlService.createTemplateFromFile("qrCodeTest");
  var tmp = HtmlService.createTemplateFromFile("Main");

  if (e.parameter && e.parameter.logout) {
    PropertiesService.getUserProperties().deleteAllProperties();
  }

  return tmp.evaluate().setTitle("بصائر للعلوم الشرعية")
  .setFaviconUrl(myLogo)
  .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
  .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

///////////////////////////////////////////////////////////////
// نقطة اتصال HTTP مباشرة (بلا google.script.run) لتسجيل الحضور عبر QR من صفحة الماسح الوسيطة
// (website/qr-scan-relay.html على Firebase Hosting) — راجع مناقشات مشابهة في المحادثة: النمط
// السابق (الصفحة الوسيطة ترسل postMessage لتبويب لوحة الإدارة الأصلي، وهو مَن يستدعي
// setAttendQr) ثبت عمليًا أنه غير موثوق على الجوال، لأن متصفحات الجوال تُعلّق تنفيذ الجافاسكربت
// في أي تبويب ينتقل للخلفية — وتبويب لوحة الإدارة يبقى بالخلفية طوال جلسة المسح كاملة (المستخدم
// ناظر لنافذة الكاميرا المنبثقة فقط)، فسجل تشخيص حقيقي من جهاز فعلي أثبت أن الرسالة تصل أحيانًا
// دون أن يُنفَّذ أي كود مستقبِل لها إطلاقًا (طالب واحد فقط يُسجَّل ثم تتعطل الجلسة كاملة).
// الحل: الصفحة الوسيطة تتصل بالخادم مباشرة (fetch)، فتبويب لوحة الإدارة لم يعد ضروريًا إطلاقًا
// لإتمام التسجيل — فقط لحظة بدء الجلسة (فتح قارئ QR)، حين تُولَّد بطاقة جلسة (token) قصيرة
// الصلاحية عبر startQrSession_ بينما تبويب الإدارة لا يزال نشطًا ومُصادَقًا فعليًا، وتُرفَق مع
// رابط الصفحة الوسيطة. كل مسح لاحق يرسل هذه البطاقة للتحقق بدل الاعتماد على جلسة حيّة.
///////////////////////////////////////////////////////////////
function doPost(e) {
  var result;
  try {
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    if (body.action === 'qrAttend') {
      result = handleQrAttendRequest_(body);
    } else if (body.action === 'oauthVerify') {
      result = handleOauthVerifyResult_(body);
    } else if (body.action === 'saveFcmToken') {
      result = handleSaveFcmTokenRequest_(body);
    } else {
      result = { status: 'error', message: 'إجراء غير معروف' };
    }
  } catch (err) {
    result = { status: 'error', message: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/////////////////////////////////////////////
function include (filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
//////////////////////////////////////////////////////////////////
function clearUserData() {
  PropertiesService.getUserProperties().deleteAllProperties();
  return true;
}
///////////////////////////////////////////////////////////////////////////////////
function onlyUnique(value, index, self) {
  return self.indexOf(value) === index;
}
/////////////////////////////////////////////////////////
function shuffle_(array) {
  let currentIndex = array.length,  randomIndex;

  // While there remain elements to shuffle_.
  while (currentIndex != 0) {

    // Pick a remaining element.
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
  }

  return array;
}

////////////////////////////////////////////////////////////////////////////////////

function deleteStudentFiles() {
  try {
    // 1. حدد الشيت والعمود اللي فيه الروابط
    var sheet = SpreadsheetApp.openById(mainData).getSheetByName("students"); // غيّر الاسم حسب شيتك
    var headers = sheet.getRange('1:1').getValues();
    var cardCol = headers[0].indexOf('card')+1;
  
    var linkColumn = cardCol; // رقم العمود اللي فيه الروابط (1 = العمود A)

    // 2. اقرأ كل الروابط من العمود
    var data = sheet.getRange(2, linkColumn, sheet.getLastRow() - 1, 1).getValues(); // يبدأ من الصف 2 لتجاهل العناوين

    var deletedCount = 0;
    var failedLinks = [];

    data.forEach(function(row, i) {
      var fileUrl = row[0];
      if (fileUrl) {
        try {
          // 3. استخرج الـ fileId من الرابط
          var fileId = getFileIdFromUrl_(fileUrl);
          if (fileId) {
            var file = DriveApp.getFileById(fileId);
            file.setTrashed(true); // ينقل الملف لسلة المهملات
            sheet.getRange(i + 2, linkColumn).clearContent();
            deletedCount++;
          } else {
            failedLinks.push({row: i + 2, reason: "لم يتم التعرف على ID الملف"});
          }
        } catch (err) {
          failedLinks.push({row: i + 2, reason: err.message});
        }
      }
    });

    // 4. أظهر ملخص
    var message = "✅ تم حذف " + deletedCount + " ملف.\n";
    if (failedLinks.length > 0) {
      message += "⚠️ فشل الحذف في " + failedLinks.length + " صفوف:\n";
      failedLinks.forEach(function(f) {
        message += "• الصف " + f.row + ": " + f.reason + "\n";
      });
    }
    Logger.log().alert(message);

  } catch (e) {
    Logger.log("حدث خطأ: " + e.message);
  }
}

// دالة مساعدة لاستخراج ID الملف من الرابط
function getFileIdFromUrl_(url) {
  var match = url.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
// حصة MailApp/GmailApp اليومية تعمل بنافذة متحركة 24 ساعة تبدأ من أول رسالة أُرسلت ضمن الفترة
// (وليست تصفيرًا عند منتصف ليل بأي توقيت ثابت) — راجع توثيق جوجل الرسمي:
// https://developers.google.com/apps-script/guides/services/quotas
// Apps Script لا يوفّر رقم "الحد الكلي" ولا "عدد المُرسَل" مباشرة، فقط المتبقي
// (getRemainingDailyQuota). لذا نحسب العدد الفعلي المُرسَل في آخر 24 ساعة من الآن بالبحث في
// مجلد "المرسَل" (Sent) نفسه، ونعرض بريد الحساب المنفَّذ عليه السكربت لتقدير الحد الكلي المرجّح.
function logRemainingQuota(e) {
  var emailQuotaRemaining = MailApp.getRemainingDailyQuota();
  var execEmail = Session.getEffectiveUser().getEmail();
  var estimatedTotal = /@gmail\.com$/i.test(execEmail) ? 100 : 1500;
  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var sentInfo = countSentEmailsLast24h_();

  var nowStr = Utilities.formatDate(now, tz, 'hh:mm a');
  var firstStr = sentInfo.earliest ? Utilities.formatDate(new Date(sentInfo.earliest), tz, 'hh:mm a') : 'لا توجد رسائل بعد';

  var summary = 'الحساب المُنفَّذ عليه السكربت: ' + execEmail + '\n' +
    'تم إرسال ' + sentInfo.count + ' رسالة في آخر 24 ساعة، من الساعة ' + firstStr + ' حتى الآن الساعة ' + nowStr + '،\n' +
    'من أصل ' + estimatedTotal + ' رسالة متاحة تقريبًا (المتبقي حاليًا حسب جوجل: ' + emailQuotaRemaining + ')';

  var reportLines = sentInfo.details.map(function (d, i) {
    return (i + 1) + '. إلى: ' + d.to + ' — الوقت: ' + d.time;
  });
  var fullReport = summary + '\n\n--- تقرير الرسائل ---\n' + (reportLines.join('\n') || '(لا توجد رسائل)');

  Logger.log(fullReport);
  return {
    execAccount: execEmail,
    remaining: emailQuotaRemaining,
    estimatedTotal: estimatedTotal,
    sentLast24h: sentInfo.count,
    firstMessageTime: firstStr,
    nowTime: nowStr,
    details: sentInfo.details,
    message: summary,
    fullReport: fullReport
  };
}

// عدّ الرسائل التي أرسلها هذا الحساب فعليًا (وليس أي ردود أو رسائل واردة أخرى ضمن نفس
// المحادثة/Thread) خلال آخر 24 ساعة بالضبط من لحظة التنفيذ، مع توقيت أقدم رسالة (وهي تقريبًا
// لحظة بداية نافذة الحصة المتحركة الحالية) وتفاصيل كل رسالة (المستلم والوقت).
//
// تنبيه على خطأ سابق: كنا نَعدّ كل رسائل المحادثة (thread.getMessages()) التي تقع ضمن آخر 24
// ساعة، بما في ذلك أي ردّ يصل من المستلم إلى نفس المحادثة — فيُحتسب كـ"رسالة مُرسَلة" رغم أنه
// رسالة واردة، مما يُضخّم العدد. أصبحنا الآن نتحقق من "المرسِل" (From) ونقارنه ببريد الحساب
// نفسه، فلا تُحتسب إلا الرسائل التي أرسلها هذا الحساب فعلًا.
//
// ملاحظة: أول استخدام لهذه الدالة قد يطلب موافقة إضافية على صلاحية قراءة جيميل (نطاق أوسع من
// صلاحية الإرسال المُفوَّضة سابقًا)، وهو أمر طبيعي متوقّع لمرة واحدة.
function countSentEmailsLast24h_() {
  var cutoff = Date.now() - 24 * 60 * 60 * 1000;
  var myEmail = Session.getEffectiveUser().getEmail().toLowerCase();
  var tz = Session.getScriptTimeZone();
  var threads = GmailApp.search('in:sent newer_than:1d', 0, 500);
  var count = 0;
  var earliest = null;
  var details = [];

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      var t = m.getDate().getTime();
      if (t < cutoff) return;

      var from = String(m.getFrom() || '').toLowerCase();
      if (from.indexOf(myEmail) === -1) return; // ليست رسالة أرسلها هذا الحساب (ردّ وارد مثلًا)

      count++;
      if (earliest === null || t < earliest) earliest = t;
      details.push({
        to: m.getTo(),
        time: Utilities.formatDate(new Date(t), tz, 'yyyy-MM-dd hh:mm a')
      });
    });
  });

  details.sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });

  return { count: count, earliest: earliest, details: details };
}

// تشخيص: هل تصل رسائل الارتداد (Bounce) الصامتة من خوادم المستلمين إلى بريد الوارد
// الخاص بالحساب المُنفَّذ عليه السكربت؟ رسائل "تم الإرسال لكن لم تصل ولا حتى في السبام" غالبًا
// إما (أ) تُرفض بصمت من خادم المستلم دون أي إشعار ارتداد على الإطلاق (شائع مع Outlook/Hotmail
// عند إرسال رسائل تشبه رموز التحقق من حساب Gmail شخصي وليس Workspace)، أو (ب) تصل كإشعار
// ارتداد (bounce) في بريد الوارد لكن لا يُنتبَه له لأنه لا يظهر في "المرسلة". هذه الدالة تبحث عن
// النوع الثاني تحديدًا. تُشغَّل يدويًا من محرر Apps Script، والنتيجة تظهر في Logger.log ايضاً.
function checkBounceNotifications() {
  var threads = GmailApp.search(
    'in:inbox newer_than:14d (from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification" OR subject:"Undeliverable" OR subject:"لم يتم تسليم")',
    0, 50
  );
  var tz = Session.getScriptTimeZone();
  var details = [];

  threads.forEach(function (thread) {
    var msg = thread.getMessages()[0];
    details.push({
      from: msg.getFrom(),
      subject: msg.getSubject(),
      time: Utilities.formatDate(msg.getDate(), tz, 'yyyy-MM-dd hh:mm a'),
      snippet: (msg.getPlainBody() || '').substring(0, 300)
    });
  });

  var report = details.length === 0
    ? 'لا توجد أي رسائل ارتداد (bounce) ظاهرة في بريد الوارد خلال آخر 14 يومًا.\n' +
      'هذا يرجّح أن الرسائل تُرفَض بصمت من خادم المستلم (بدون أي إشعار ارتداد على الإطلاق)،\n' +
      'وليس أن هناك ارتدادًا نغفل عنه.'
    : 'وُجدت ' + details.length + ' رسالة ارتداد/إشعار عدم تسليم:\n\n' +
      details.map(function (d, i) {
        return (i + 1) + '. من: ' + d.from + '\n   الموضوع: ' + d.subject + '\n   الوقت: ' + d.time + '\n   مقتطف: ' + d.snippet + '\n';
      }).join('\n');

  Logger.log(report);
  return { count: details.length, details: details, report: report };
}

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
function getDriveId(url) {
  const match = url.match(/[-\w]{25,}/);
  return match ? match[0] : null;
}


///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

function toHindiNumbers_(str) {
  var hindi = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
  return str.toString().replace(/\d/g, d => hindi[d]);
}

///////////////////////////////////////////////////////////////////////////////
// تاريخ اليوم هجريًا بالأرقام الهندية (لحقل {date} بشهادات اجتياز المراحل) — عبر Intl المتاحة
// بمحرّك V8 (Apps Script)، تقويم "أم القرى" (islamic-umalqura). نطلب الأرقام كإنجليزية أولًا
// (en-u-ca-...) لضمان تفسير رقمي مضمون بلا اختلاف لهجات ICU، ثم نبني اسم الشهر بأنفسنا من
// مصفوفة ثابتة (بدل الاعتماد على تسمية ICU العربية التلقائية التي قد تختلف صياغتها)، وأخيرًا
// نحوّل كل الأرقام للهندية. راجع مناقشات.md "شهادات الاجتياز" للسياق الكامل.
///////////////////////////////////////////////////////////////////////////////
function formatHijriDateHindi_(date, timeZone) {
  var hijriMonths_ = ['محرم', 'صفر', 'ربيع الأول', 'ربيع الثاني', 'جمادى الأولى', 'جمادى الآخرة',
    'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة'];
  var fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
    day: 'numeric', month: 'numeric', year: 'numeric', timeZone: timeZone || Session.getScriptTimeZone()
  });
  var parts = {};
  fmt.formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
  var monthName = hijriMonths_[(+parts.month) - 1] || '';
  return toHindiNumbers_(parts.day + ' ' + monthName + ' ' + parts.year + ' هـ');
}


