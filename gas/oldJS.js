let cardID00 = '1GhW_GrSh_rIOM9OvT1OloDAfugspkd9YUq2dRPbCDqI';
let cardID01 = '1jmUA5b5itLCxcI52aHI41boXHEbVo9HWULXAEXlOER4';
let cardID02 = '1DLiQpuBZcdsCzGVMQCCjtDTYDnJdpyYqP_0-QQIv49Q';
let cardID03 = '1Yg-Z22vRduKOggLvV0Q4uG6bWQMcbZoT9ydcGaQvGDU';
//////////===============////////////////////
//////////===============////////////////////
function localCardGenerat (){
  const cpr = 130407330;
  const newRegAproval = 'yes';
  const grade = 0;

  setStudentsQrCard(cpr , newRegAproval , grade)
}
//////////===============////////////////////
//////////===============////////////////////

function setStudentsQrCard(cpr , newRegAproval , grade, archivedBy, actorCpr){
  /* cpr = 60213493;
  newRegAproval = 'yes';
  grade = 0; */

  var data = getPersons();
  var thisPer = data.find(e=> e.cpr == cpr);

  Logger.log(thisPer.name);

      dataPer = {};
      dataPer.cpr = cpr;
      dataPer.grade = grade;
      dataPer.name = thisPer.name;
      dataPer.folderID = thisPer.folderUrl;
      dataPer.code = thisPer.code;
      dataPer.mail = thisPer.mail;
      dataPer.card = thisPer.cardUrl;
      // هوية الموظف المنفِّذ لعملية القبول (userData[0].name من طرف العميل) — تُستخدَم فقط في
      // مسار القبول لتسجيلها كـ archivedBy عند أرشفة بيانات مرحلة سابقة، راجع acceptedStu_ أدناه.
      dataPer.archivedBy = archivedBy || '';
      // رقم المنفِّذ الشخصي (لا اسمه) — لحارس "تضارب المصالح" بـacceptedStu_ فقط (منع قبول
      // الشخص لتسجيله الخاص)، راجع مناقشات.md "طالب بصلاحية إدارية".
      dataPer.actorCpr = actorCpr || '';

      newRegAproval === 'yes' ?
      acceptedStu_(dataPer , mainData , 'students') :
      refusedStu_(dataPer , mainData , 'students');

      Logger.log(dataPer.name);
      //return;

}
////////////////////////////////////////////////////////////////////////////////////////////////////////
// ===================================================================
// حارس تزامن عملية "قبول الطالب" — راجع مناقشات.md "علاج تكرار عملية القبول عند تعدّد الموظفين".
// طبقتان: (1) قفل مؤقت خفيف (CacheService، لا LockService الثقيل) لكل رقم شخصي، يمنع تشغيلين
// متزامنين لنفس الطالب بنفس اللحظة تقريبًا. (2) تحقق فوري: لو كانت هذه المرحلة (grade) مُفعَّلة
// له بالفعل بالشيت، يُرفَض فورًا قبل أي عمل ثقيل (مجلد/بطاقة/بريد) — يغطي الحالة الأشيع عمليًا:
// موظف يعالج طالبًا عالجه زميله قبل لحظات دون تحديث قائمته. القفل نفسه (وليس التحقق) محميّ بقفل
// LockService قصير جدًا (خطوة تحقق-ثم-تعيين فقط) لضمان عدم تسلل تشغيلين معًا رغم الفحص، بلا حجز
// القفل الثقيل طوال مدة العملية الكاملة (التي قد تستغرق ثوانٍ بسبب Drive/PDF/البريد).
// ===================================================================
function acquireAcceptLock_(cpr, grade, refID, refSH) {
  var scriptLock = LockService.getScriptLock();
  try {
    scriptLock.waitLock(5000);
  } catch (e) {
    throw new Error("الخادم مشغول حاليًا بمعالجة طلبات أخرى، يرجى إعادة المحاولة خلال لحظات.");
  }
  try {
    var cache = CacheService.getScriptCache();
    var key = 'acceptLock_' + normalizeCpr_(cpr);
    if (cache.get(key)) {
      throw new Error("هذا الطالب قيد المعالجة حاليًا من قبل موظف آخر، يرجى الانتظار قليلًا ثم إعادة المحاولة.");
    }

    // تحقق فوري: هل هذه المرحلة مُفعَّلة له بالفعل؟ (قبول سابق ناجح، ربما للتو من موظف آخر)
    if ([0, 1, 2, 3].includes(grade)) {
      var ss = SpreadsheetApp.openById(refID);
      var sheet = ss.getSheetByName(refSH);
      var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var cprCol = headers.indexOf('cpr');
      var classCol = headers.indexOf('class' + grade);
      if (cprCol >= 0 && classCol >= 0 && sheet.getLastRow() > 1) {
        var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
        var rowIndex = rows.findIndex(function (r) { return Number(r[cprCol]) === Number(cpr); });
        if (rowIndex > -1 && rows[rowIndex][classCol] === 'active') {
          throw new Error("هذا الطالب مقبول بالفعل بهذه المرحلة — على الأرجح تمت معالجته للتو من قبل موظف آخر.");
        }
      }
    }

    cache.put(key, '1', 180); // قفل مؤقت 3 دقائق كحد أقصى — تحرّر تلقائيًا احتياطًا لو تعطّلت العملية بمنتصفها بلا تحرير صريح
  } finally {
    scriptLock.releaseLock();
  }
}

function releaseAcceptLock_(cpr) {
  try {
    CacheService.getScriptCache().remove('acceptLock_' + normalizeCpr_(cpr));
  } catch (e) {}
}

// ===================================================================
// حالة "دفعة قبول جارية" مشتركة بين كل الجلسات (CacheService عام، لا UserCache) — لعرض شريط
// تقدّم دائم بلوحة الإدارة لكل الموظفين طالما تجري عملية قبول من أي أحد، بدل مودال محلي لا يراه
// إلا من بدأ العملية (راجع مناقشات.md). العميل (js.html/admin-js.html) يستدعي startAcceptBatch
// مرة عند البدء، وupdateAcceptBatchProgress بعد كل طالب، وendAcceptBatch عند الانتهاء. أي جلسة
// إدارية أخرى تستطلع getAcceptBatchStatus دوريًا لعرض/إخفاء الشريط.
// ===================================================================
var ACCEPT_BATCH_STATUS_KEY_ = 'acceptBatchStatus';
var ACCEPT_BATCH_STATUS_TTL_ = 300; // 5 دقائق كحد أقصى — تحرّر تلقائيًا احتياطًا لو أُغلق المتصفح بمنتصف الدفعة بلا استدعاء endAcceptBatch

function startAcceptBatch(total, staffName) {
  try {
    CacheService.getScriptCache().put(ACCEPT_BATCH_STATUS_KEY_, JSON.stringify({
      active: true, total: total, completed: 0, staffName: staffName || ''
    }), ACCEPT_BATCH_STATUS_TTL_);
  } catch (e) {}
}

function updateAcceptBatchProgress(completed) {
  try {
    var cache = CacheService.getScriptCache();
    var raw = cache.get(ACCEPT_BATCH_STATUS_KEY_);
    if (!raw) return;
    var status = JSON.parse(raw);
    status.completed = completed;
    cache.put(ACCEPT_BATCH_STATUS_KEY_, JSON.stringify(status), ACCEPT_BATCH_STATUS_TTL_);
  } catch (e) {}
}

function endAcceptBatch() {
  try {
    CacheService.getScriptCache().remove(ACCEPT_BATCH_STATUS_KEY_);
  } catch (e) {}
}

function getAcceptBatchStatus() {
  try {
    var raw = CacheService.getScriptCache().get(ACCEPT_BATCH_STATUS_KEY_);
    return raw ? JSON.parse(raw) : { active: false };
  } catch (e) {
    return { active: false };
  }
}

function acceptedStu_(data, refID, refSH) {
  // === حارس "تضارب المصالح" — لا يقبل موظف/إداري تسجيله الشخصي كطالب بنفسه، حتى لو كانت له
  //     صلاحية القبول (حالة "طالب بصلاحية إدارية" ممكنة فعليًا؛ راجع مناقشات.md "طالب بصلاحية
  //     إدارية"). data.actorCpr فارغة لأي مسار عميل لم يُحدَّث بعد لإرسالها — لا يُطبَّق الفحص
  //     حينها (سلوك سابق كما هو، بلا تراجع)، لا حجب أي عملية كانت تعمل من قبل. ===
  if (data.actorCpr && cprEquals_(data.cpr, data.actorCpr)) {
    throw new Error("لا يمكنك قبول تسجيلك الخاص كطالب — يلزم موظف آخر لاعتماد هذا الإجراء.");
  }
  // === حارس تزامن + منع تكرار العملية — راجع مناقشات.md "علاج تكرار عملية القبول عند تعدّد
  //     الموظفين". بسبب كثرة الموظفين المعالِجين لدفعات قبول متزامنة، كان يحدث أحيانًا أن يُعالَج
  //     الطالب نفسه أكثر من مرة (مجلد + بطاقة + بريد إلكتروني مكرر بالكامل)، لأن الدالة لم تكن
  //     تتحقق إطلاقًا هل هو مقبول بهذه المرحلة بالفعل، ولا تمنع تشغيلين متزامنين من العمل عليه
  //     معًا. acquireAcceptLock_ يرمي خطأً واضحًا فورًا (بدل تنفيذ أي عمل) في كلتا الحالتين:
  //     تشغيل آخر يعالج نفس الرقم الشخصي حاليًا، أو كانت هذه المرحلة مُفعَّلة له بالفعل. ===
  acquireAcceptLock_(data.cpr, data.grade, refID, refSH);
  try {
    // === تحقق مبكر: grade غير صحيحة كانت تؤدي سابقًا لتخطي تفعيل المرحلة الجديدة بصمت (مع
    //     تنفيذ منطق "تحويل المرحلة القديمة إلى done" رغم ذلك) — الآن تفشل العملية بوضوح بدل ===
    if (![0, 1, 2, 3].includes(data.grade)) {
      throw new Error("مرحلة غير صحيحة (grade=" + data.grade + ") — تعذّر تحديد المرحلة المطلوب قبول الطالب فيها");
    }

    // === أرشفة بيانات سابقة لنفس الطالب بنفس هذه المرحلة تحديدًا (اختبارات/أوراد/حضور)، إن
    //     وُجدت، قبل أي تعديل على الشيتات الحية — راجع مناقشات.md "تعديل آلية قبول طالب".
    //     لا تُلمس بيانات أي مرحلة أخرى مكتملة للطالب. فاشلة بأمان: لو حدث أي خطأ أثناء
    //     الأرشفة يُسجَّل ويُتجاهل فتكمل آلية القبول العادية دون توقف. ===
    archiveExistingLevelData(data.cpr, data.grade, data.archivedBy);

    // === إعداد المجلدات الأساسية ===
    const perArchive = DriveApp.getFolderById("1PexT7pwgJdaBUncuykBh6kYDAzzhyNYs");
    const tempFolder = DriveApp.getFolderById("1BqEH-ihrkLbPFL5mxBbGUhA2G-MYolae");

    // === اختيار الملف ولون QR حسب grade ===
    // القالب يُقرأ الآن من حقل "قالب بطاقة الطالب" بكارت المرحلة بصفحة "إدارة المراحل"
    // (شيت stages، عمود cardTemplateId) — مع سقوط احتياطي (fallback) للثوابت الأربعة القديمة
    // المكتوبة هنا لو المرحلة بلا قالب مضبوط بعد بالواجهة، حماية من تعطّل إصدار البطاقات أثناء
    // الانتقال. راجع مناقشات.md "شروط الاجتياز... إدارة القوالب" للسياق الكامل.
    const stageCardConfig = (getStagesList() || []).find(function (s) { return +s.stageIndex === data.grade; });
    const fallbackCardIds = [cardID00, cardID01, cardID02, cardID03];
    const qrColorsByGrade = [qr00Color, qr01Color, qr02Color, qr03Color];
    const gradeInfo = {
      fileId: (stageCardConfig && stageCardConfig.cardTemplateId) || fallbackCardIds[data.grade],
      qrColor: qrColorsByGrade[data.grade]
    };
    Logger.log("Attempting to open file ID: " + gradeInfo.fileId);
    const tempFile = DriveApp.getFileById(gradeInfo.fileId);
    const qrColor = gradeInfo.qrColor;

    // === فتح الـ Spreadsheet مرة واحدة ===
    const ss = SpreadsheetApp.openById(refID);
    const sheet = ss.getSheetByName(refSH);

    // === الحصول على كل البيانات دفعة واحدة ===
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const dataValues = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();

    const cprCol = headers.indexOf('cpr');
    const folderCol = headers.indexOf('folder');
    const pdfCol = headers.indexOf('card');
    const codeCol = headers.indexOf('code');
    const genderCol = headers.indexOf('gender');
    const outsideBahrainCol = headers.indexOf('outsideBahrain');
    const classCols = [headers.indexOf('class0'), headers.indexOf('class1'), headers.indexOf('class2'), headers.indexOf('class3')];

    // === البحث عن الصف ===
    let rowIndex = dataValues.findIndex(r => Number(r[cprCol]) === Number(data.cpr));
    if (rowIndex === -1) throw new Error("CPR not found in the sheet");
    const sheetRow = rowIndex + 2; // لأن البيانات تبدأ من الصف 2

    // === تحديد الكود الشخصي ===
    const perCode = data.code && data.code !== '' ? data.code : getRandomInt_(999999);

    // === إنشاء أو جلب مجلد المستخدم مرة واحدة ===
    let perFolderIterator = perArchive.getFoldersByName(perCode);
    const userFolder = perFolderIterator.hasNext() ? perFolderIterator.next() : perArchive.createFolder(perCode);
    data.folderID = userFolder.getId();

    // === اسم الملف النهائي ===
    const newName = `idCard-${data.cpr}-pdf`;

    // === إنشاء نسخة PDF جديدة أو تحديث الموجود ===
    const docCopy = tempFile.makeCopy(tempFolder);
    const doc = DocumentApp.openById(docCopy.getId());
    const body = doc.getBody();
    body.replaceText("{name}", data.name);

    // === إنشاء QR Code ===
    // الاسم والرمز التعريفي (perId) حُذفا عمدًا من بيانات الرمز — يُستخرَجان الآن من الرقم
    // الشخصي مباشرةً على الخادم عند المسح (انظر setAttendQr في dataPost.js). كانا يُضخّمان حجم
    // بيانات الرمز (الأسماء العربية طويلة خصوصًا) فيُنتجان رمزًا أكثر كثافة (وحدات أصغر) يصعب
    // مسحه بموثوقية، خصوصًا عند مسحه من شاشة هاتف طالب آخر بدل بطاقة مطبوعة — وهو الاستخدام
    // الفعلي الوحيد هنا، لا بطاقات مطبوعة إطلاقًا. رقم شخصي مجرّد (9 أرقام فقط) هو أبسط حمولة
    // ممكنة لرمز QR، وأكثرها موثوقية في القراءة.
    const qrData = encodeURIComponent(JSON.stringify({ cpr: data.cpr }));
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${qrData}&color=${qrColor}&bgcolor=ffffff00&margin=0`;
    replaceImage_(doc.getId(), qrUrl);

    doc.setName(newName);
    doc.saveAndClose();

    const pdfBlob = doc.getBlob();
    var currentFileID, pdfUrl;

    const existingFileId = checkExistFiles_(userFolder.getId(), newName);
    if (existingFileId) {
      var existingFileId2 = extractFileId_(existingFileId)
      Logger.log('existingFileId = '+existingFileId2)
      overwriteFile(pdfBlob, existingFileId2);
      const file = DriveApp.getFileById(existingFileId2);
      shareFileAnyoneWithLink_(existingFileId2);
      pdfUrl = file.getUrl();
      currentFileID = existingFileId2;
    } else {
      const newPdf = userFolder.createFile(pdfBlob).setName(newName);
      shareFileAnyoneWithLink_(newPdf.getId());
      pdfUrl = newPdf.getUrl();
      currentFileID = newPdf.getId();
    }

    // === حذف المستند المؤقت ===
    docCopy.setTrashed(true);

    // === تحديث البيانات في الـ Spreadsheet دفعة واحدة ===
    const updates = {};
    updates[folderCol] = userFolder.getUrl();
    updates[pdfCol] = pdfUrl;
    updates[codeCol] = perCode;
    if ([0, 1, 2, 3].includes(data.grade)) updates[classCols[data.grade]] = 'active';

    const updatesArr = [
      { col: folderCol, value: userFolder.getUrl() },
      { col: pdfCol, value: pdfUrl },
      { col: codeCol, value: perCode }
    ];

    // تحديث class column حسب grade
    if ([0,1,2,3].includes(data.grade)) {
      updatesArr.push({ col: classCols[data.grade], value: 'active' });
    }

    // === طالب منتسب فعلاً لمرحلة (active) ويُقبل الآن في مرحلة أخرى: مرحلته الحالية تتحوّل إلى
    //     "done" (منتهية/منتقل منها) بدل أن تبقى "active" في مرحلتين معًا ===
    const currentRow = dataValues[rowIndex];
    [0, 1, 2, 3].forEach(function (lvl) {
      if (lvl !== data.grade && currentRow[classCols[lvl]] === 'active') {
        updatesArr.push({ col: classCols[lvl], value: 'done' });
      }
    });

    updatesArr.forEach(item => {
      if (item.col >= 0) {  // تحقق أن العمود صحيح
        sheet.getRange(sheetRow, item.col + 1).setValue(item.value);
      } else {
        throw new Error("Invalid column index: " + item.col);
      }
    });



    // === إرسال البريد الإلكتروني (القالب المصمَّم basair-theme-studio) ===
    const msg = buildBasairAcceptanceEmail_(data.name, genderCol >= 0 ? currentRow[genderCol] : '', outsideBahrainCol >= 0 ? !!currentRow[outsideBahrainCol] : false);
    const startEventIcs = buildBasairStartEventIcs_(data.cpr);
    sendMailWithAttachment_(data.mail, "بصائر للعلوم الشرعية | قبول التسجيل", msg, DriveApp.getFileById(currentFileID), getBasairLogoBlob_(), [{ cid: 'whatsappIcon', blob: getWhatsAppIconBlob_() }], [{ content: startEventIcs, filename: 'بداية-الدراسة-في-بصائر.ics', mimeType: 'text/calendar; charset=UTF-8; method=PUBLISH' }]);

    return pdfUrl;

  } catch (err) {
    Logger.log("Error in acceptedStuOptimized: " + err.message);
    throw err;
  } finally {
    releaseAcceptLock_(data.cpr);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////
// "إعادة إصدار بطاقة" — نفس منطق توليد البطاقة بالضبط من acceptedStu_ (القالب حسب المرحلة، رمز
// QR، حفظ/استبدال PDF بمجلد الطالب، كتابة رابطها بعمود card) مُستخرَج في دالة مستقلة قابلة
// للاستدعاء لطالب نشِط بالفعل — بخلاف acceptedStu_ نفسها، التي تمنع صراحةً إعادة تشغيلها لطالب
// نشِط بنفس المرحلة (acquireAcceptLock_)، فلا توجد حاليًا أي وسيلة لإصدار بطاقة لطالب فقدها أو
// لم تُصدَر له لسبب ما (خطأ أثناء القبول، بيانات قديمة...). هذه الدالة لا تؤرشف، ولا تُفعِّل
// مرحلة، ولا ترسل بريد قبول — فقط البطاقة نفسها. راجع نقاش "بطاقة الحضور لا تظهر" مع المستخدم.
function reissueStudentCard(cpr) {
  try {
    var data = getPersons();
    var thisPer = data === 0 ? null : data.find(function (e) { return cprEquals_(e.cpr, cpr); });
    if (!thisPer) return { ok: false, message: 'تعذّر العثور على الطالب.' };

    var grade = null;
    if (thisPer.class0 === 'active') grade = 0;
    else if (thisPer.class1 === 'active') grade = 1;
    else if (thisPer.class2 === 'active') grade = 2;
    else if (thisPer.class3 === 'active') grade = 3;
    if (grade === null) return { ok: false, message: 'الطالب ليس نشِطًا في أي مرحلة حاليًا، لا يمكن تحديد قالب البطاقة المناسب.' };

    // نفس منطق اختيار القالب ولون QR حسب grade في acceptedStu_ أعلاه (سقوط احتياطي للثوابت
    // الأربعة القديمة لو المرحلة بلا قالب مضبوط بعد بالواجهة).
    var stageCardConfig = (getStagesList() || []).find(function (s) { return +s.stageIndex === grade; });
    var fallbackCardIds = [cardID00, cardID01, cardID02, cardID03];
    var qrColorsByGrade = [qr00Color, qr01Color, qr02Color, qr03Color];
    var fileId = (stageCardConfig && stageCardConfig.cardTemplateId) || fallbackCardIds[grade];
    var qrColor = qrColorsByGrade[grade];

    var perArchive = DriveApp.getFolderById("1PexT7pwgJdaBUncuykBh6kYDAzzhyNYs");
    var tempFolder = DriveApp.getFolderById("1BqEH-ihrkLbPFL5mxBbGUhA2G-MYolae");

    var perCode = thisPer.code && thisPer.code !== '' ? thisPer.code : getRandomInt_(999999);
    // يبحث عن مجلد الطالب الموجود أصلًا بالكود (أُنشئ وقت القبول الأول) بدل إنشاء مجلد جديد مكرَّر.
    var perFolderIterator = perArchive.getFoldersByName(perCode);
    var userFolder = perFolderIterator.hasNext() ? perFolderIterator.next() : perArchive.createFolder(perCode);

    var tempFile = DriveApp.getFileById(fileId);
    var newName = 'idCard-' + cpr + '-pdf';
    var docCopy = tempFile.makeCopy(tempFolder);
    var doc = DocumentApp.openById(docCopy.getId());
    var body = doc.getBody();
    body.replaceText("{name}", thisPer.name);

    var qrData = encodeURIComponent(JSON.stringify({ cpr: Number(cpr) }));
    var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + qrData + '&color=' + qrColor + '&bgcolor=ffffff00&margin=0';
    replaceImage_(doc.getId(), qrUrl);

    doc.setName(newName);
    doc.saveAndClose();

    var pdfBlob = doc.getBlob();
    var currentFileID, pdfUrl;
    var existingFileId = checkExistFiles_(userFolder.getId(), newName);
    if (existingFileId) {
      var existingFileId2 = extractFileId_(existingFileId);
      overwriteFile(pdfBlob, existingFileId2);
      var file = DriveApp.getFileById(existingFileId2);
      shareFileAnyoneWithLink_(existingFileId2);
      pdfUrl = file.getUrl();
      currentFileID = existingFileId2;
    } else {
      var newPdf = userFolder.createFile(pdfBlob).setName(newName);
      shareFileAnyoneWithLink_(newPdf.getId());
      pdfUrl = newPdf.getUrl();
      currentFileID = newPdf.getId();
    }

    docCopy.setTrashed(true);

    // كتابة رابط البطاقة بعمود card، + المجلد/الكود فقط لو كانا فارغين أصلًا لسبب ما (بيانات
    // ناقصة من تسجيل قديم) — لا نُعيد كتابة قيم موجودة بالفعل بلا داعٍ.
    var ss = SpreadsheetApp.openById(mainData);
    var sheet = ss.getSheetByName('students');
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var cprCol = headers.indexOf('cpr');
    var pdfCol = headers.indexOf('card');
    var folderCol = headers.indexOf('folder');
    var codeCol = headers.indexOf('code');
    var lastRow = sheet.getLastRow();
    var cprValues = sheet.getRange(2, cprCol + 1, lastRow - 1, 1).getValues();
    var rowIndex = cprValues.findIndex(function (r) { return cprEquals_(r[0], cpr); });
    if (rowIndex === -1) return { ok: false, message: 'تعذّر العثور على صف الطالب بالشيت.' };
    var sheetRow = rowIndex + 2;

    if (pdfCol > -1) sheet.getRange(sheetRow, pdfCol + 1).setValue(pdfUrl);
    if (folderCol > -1 && !thisPer.folderUrl) sheet.getRange(sheetRow, folderCol + 1).setValue(userFolder.getUrl());
    if (codeCol > -1 && (!thisPer.code || thisPer.code === '')) sheet.getRange(sheetRow, codeCol + 1).setValue(perCode);

    return { ok: true, cardUrl: pdfUrl };
  } catch (err) {
    Logger.log('reissueStudentCard فشل لـ' + cpr + ': ' + err);
    return { ok: false, message: 'تعذّر إصدار البطاقة: ' + (err && err.message ? err.message : err) };
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////
// أرشفة بيانات مرحلة سابقة عند إعادة قبول طالب في نفس المرحلة — راجع مناقشات.md "تعديل آلية
// قبول طالب" للمواصفة الكاملة. تُستدعى من acceptedStu_ كأول خطوة بعد التحقق من صحة grade.
// النطاق دومًا مقيَّد بنفس level المقبول فيها الطالب فقط — لا تُلمس أي مرحلة سابقة مكتملة له.
// fail-open بالكامل: أي خطأ غير متوقع يُسجَّل عبر Logger.log ويُبتلع، فتكمل acceptedStu_ مسارها
// الطبيعي دون توقف — أرشفة غير مكتملة أفضل من منع قبول طالب حقيقي بسبب عطل في هذه الخطوة.
////////////////////////////////////////////////////////////////////////////////////////////////////////
function archiveExistingLevelData(cpr, level, archivedBy) {
  try {
    if (!archiveData) { Logger.log('archiveExistingLevelData: archiveData غير مضبوط بعد (راجع code.js) — تخطّي الأرشفة'); return; }

    var normCpr = normalizeCpr_(cpr);
    var sources = [
      { ssId: answersData, sheetName: 'answers', cprHeader: 'cpr', archiveSheet: 'examResults' },
      { ssId: dectationData, sheetName: 'motonRates', cprHeader: 'student_Cpr', archiveSheet: 'motonRates' },
      { ssId: attendanceData, sheetName: 'attendance', cprHeader: 'cpr', archiveSheet: 'attendance' }
    ];

    // === تحديد كل الصفوف المطابقة في الشيتات الثلاثة أولًا، بلا أي حذف بعد ===
    var matches = sources.map(function (src) {
      var sh = SpreadsheetApp.openById(src.ssId).getSheetByName(src.sheetName);
      if (!sh || sh.getLastRow() < 2) return { src: src, sh: sh, headers: [], data: [], rowIndexes: [] };
      var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var cprCol = headers.indexOf(src.cprHeader);
      var levelCol = headers.indexOf('level');
      if (cprCol === -1 || levelCol === -1) return { src: src, sh: sh, headers: headers, data: [], rowIndexes: [] };
      var data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
      var rowIndexes = [];
      data.forEach(function (r, i) {
        if (normalizeCpr_(r[cprCol]) === normCpr && Number(r[levelCol]) === Number(level)) rowIndexes.push(i);
      });
      return { src: src, sh: sh, headers: headers, data: data, rowIndexes: rowIndexes };
    });

    var totalMatches = matches.reduce(function (sum, m) { return sum + m.rowIndexes.length; }, 0);
    if (totalMatches === 0) return; // لا بيانات سابقة بهذه المرحلة — آلية القبول الحالية تكمل كما هي بالضبط

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) { Logger.log('archiveExistingLevelData: تعذّر الحصول على القفل، تخطّي الأرشفة'); return; }

    try {
      var archiveBatchId = Utilities.getUuid();
      var archivedAt = new Date();
      var archiveSs = SpreadsheetApp.openById(archiveData);

      matches.forEach(function (m) {
        if (m.rowIndexes.length === 0) return;
        var archiveSh = archiveSs.getSheetByName(m.src.archiveSheet) || archiveSs.insertSheet(m.src.archiveSheet);
        ensureArchiveSheetHeaders_(archiveSh, m.headers);

        var rowsToCopy = m.rowIndexes.map(function (i) { return m.data[i].concat([archiveBatchId, archivedAt, archivedBy || '']); });
        archiveSh.getRange(archiveSh.getLastRow() + 1, 1, rowsToCopy.length, rowsToCopy[0].length).setValues(rowsToCopy);

        // حذف من الشيت الحي بعد النسخ الناجح — من الأسفل للأعلى تفاديًا لانزياح الفهارس
        m.rowIndexes.map(function (i) { return i + 2; }).sort(function (a, b) { return b - a; })
          .forEach(function (r) { m.sh.deleteRow(r); });
      });

      Logger.log('archiveExistingLevelData: أُرشف ' + totalMatches + ' صفًا (batch=' + archiveBatchId + ') للطالب ' + normCpr + ' بالمرحلة ' + level);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('archiveExistingLevelData: خطأ غير متوقع، تم تجاهله لإكمال آلية القبول: ' + (err && err.message || err));
  }
}

// يضبط رأس شيت الأرشيف تلقائيًا (رأس الشيت الحي + 3 أعمدة الأرشفة) أول مرة فقط — بنفس نمط
// ensureAttendanceLevelHeader في dataPost.js — فلا حاجة لإعداد يدوي مسبق لأي من الأوراق الثلاث.
function ensureArchiveSheetHeaders_(sheet, liveHeaders) {
  if (sheet.getLastRow() > 0) return; // رأس موجود بالفعل، لا نلمسه
  var fullHeaders = liveHeaders.concat(['archiveBatchId', 'archivedAt', 'archivedBy']);
  sheet.getRange(1, 1, 1, fullHeaders.length).setValues([fullHeaders]);
}

////////////////////////////////////////////////////////////////////////////////////////////////////////
// استرجاع دفعة أُرشفت سابقًا (المرحلة 3 من المواصفة) — استخدام إداري لاحق فقط، لا يُستدعى
// تلقائيًا من أي تدفق حالي. يعيد الصفوف لشيتاتها الحية بأعمدتها الأصلية (بلا أعمدة الأرشفة
// الثلاثة)، ثم يحذفها من "الأرشيف". لا يلمس عمود المرحلة (classCols) — يُترك للمسؤول تعديله
// يدويًا لو لزم، تفاديًا لتضارب مع أي نشاط حصل للطالب بعد الأرشفة.
////////////////////////////////////////////////////////////////////////////////////////////////////////
function restoreArchivedLevelData(archiveBatchId) {
  if (!archiveData) throw new Error('archiveData غير مضبوط (راجع code.js)');
  if (!archiveBatchId) throw new Error('archiveBatchId مطلوب');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('تعذّر الحصول على القفل، حاول مجددًا');

  try {
    var archiveSs = SpreadsheetApp.openById(archiveData);
    var targets = [
      { archiveSheet: 'examResults', ssId: answersData, sheetName: 'answers' },
      { archiveSheet: 'motonRates', ssId: dectationData, sheetName: 'motonRates' },
      { archiveSheet: 'attendance', ssId: attendanceData, sheetName: 'attendance' }
    ];
    var restoredCount = 0;

    targets.forEach(function (t) {
      var archiveSh = archiveSs.getSheetByName(t.archiveSheet);
      if (!archiveSh || archiveSh.getLastRow() < 2) return;
      var archiveHeaders = archiveSh.getRange(1, 1, 1, archiveSh.getLastColumn()).getValues()[0];
      var batchCol = archiveHeaders.indexOf('archiveBatchId');
      if (batchCol === -1) return;

      var data = archiveSh.getRange(2, 1, archiveSh.getLastRow() - 1, archiveSh.getLastColumn()).getValues();
      var matchRows = [];
      data.forEach(function (r, i) {
        if (String(r[batchCol]) === String(archiveBatchId)) matchRows.push({ rowIndex: i, values: r });
      });
      if (matchRows.length === 0) return;

      // أعمدة الأرشفة الثلاثة دومًا آخر 3 أعمدة (بنفس ترتيب إضافتها في ensureArchiveSheetHeaders_)
      var liveColCount = archiveHeaders.length - 3;
      var liveSh = SpreadsheetApp.openById(t.ssId).getSheetByName(t.sheetName);
      var rowsToRestore = matchRows.map(function (m) { return m.values.slice(0, liveColCount); });
      liveSh.getRange(liveSh.getLastRow() + 1, 1, rowsToRestore.length, liveColCount).setValues(rowsToRestore);

      // حذف من الأرشيف بعد الاسترجاع الناجح، من الأسفل للأعلى
      matchRows.map(function (m) { return m.rowIndex + 2; }).sort(function (a, b) { return b - a; })
        .forEach(function (r) { archiveSh.deleteRow(r); });

      restoredCount += matchRows.length;
    });

    return { ok: true, restoredCount: restoredCount };
  } finally {
    lock.releaseLock();
  }
}


////////////////////////////////////////////////////////////////////////////////////////////////////////
// inlineLogoBlob اختياري: لو مُمرَّر، يُضاف كصورة داخلية (cid:basairLogo) عبر multipart/related
// متداخل داخل multipart/mixed الأصلي — الغلاف المصمَّم (buildBasairEmailShell_) يعتمد عليها
// لعرض شعار بصائر في رأس الرسالة، تمامًا مثل بقية رسائل المشروع (GmailApp.sendEmail بخيار
// inlineImages)؛ هذه الدالة تستخدم Gmail API الخام لأنها تحتاج إرفاق ملف PDF أيضًا.
function sendMailWithAttachment_(to, subject, htmlBody, file, inlineLogoBlob, extraInlineImages, extraAttachments) {
  const pdfBlob = file.getAs(MimeType.PDF);
  const pdfBytes = pdfBlob.getBytes();
  const pdfBase64 = Utilities.base64Encode(pdfBytes);
  const pdfName = pdfBlob.getName();

  // 🔹 تشفير النصوص إلى UTF-8 Base64
  const subjectEnc = "=?UTF-8?B?" + Utilities.base64Encode(subject, Utilities.Charset.UTF_8) + "?=";
  const htmlBase64 = Utilities.base64Encode(htmlBody, Utilities.Charset.UTF_8);

  const mixedBoundary = "boundary_mixed_123";
  const relatedBoundary = "boundary_related_456";

  // 🔸 نص الرسالة (HTML) + الشعار الداخلي معًا في multipart/related واحد
  var relatedPart =
    "Content-Type: multipart/related; boundary=" + relatedBoundary + "\r\n\r\n" +
    "--" + relatedBoundary + "\r\n" +
    "Content-Type: text/html; charset=UTF-8\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    htmlBase64 + "\r\n\r\n";

  if (inlineLogoBlob) {
    const logoBase64 = Utilities.base64Encode(inlineLogoBlob.getBytes());
    relatedPart +=
      "--" + relatedBoundary + "\r\n" +
      "Content-Type: image/png\r\n" +
      "Content-Transfer-Encoding: base64\r\n" +
      "Content-ID: <basairLogo>\r\n" +
      "Content-Disposition: inline; filename=\"basair-logo.png\"\r\n\r\n" +
      logoBase64 + "\r\n\r\n";
  }

  // صور داخلية إضافية اختيارية (مثل أيقونة واتساب) — كل عنصر {cid, blob}
  (extraInlineImages || []).forEach(function (img) {
    const imgBase64 = Utilities.base64Encode(img.blob.getBytes());
    relatedPart +=
      "--" + relatedBoundary + "\r\n" +
      "Content-Type: image/png\r\n" +
      "Content-Transfer-Encoding: base64\r\n" +
      "Content-ID: <" + img.cid + ">\r\n" +
      "Content-Disposition: inline; filename=\"" + img.cid + ".png\"\r\n\r\n" +
      imgBase64 + "\r\n\r\n";
  });

  relatedPart += "--" + relatedBoundary + "--";

  const raw =
    "From: بصائر للعلوم الشرعية <youremail@domain.com>\r\n" +
    "To: " + to + "\r\n" +
    "Subject: " + subjectEnc + "\r\n" + // ✅ العنوان مشفر صح
    "MIME-Version: 1.0\r\n" +
    "Content-Type: multipart/mixed; boundary=" + mixedBoundary + "\r\n\r\n" +

    "--" + mixedBoundary + "\r\n" +
    relatedPart + "\r\n\r\n" +

    // 🔸 المرفق (PDF)
    "--" + mixedBoundary + "\r\n" +
    "Content-Type: application/pdf; name=\"" + pdfName + "\"\r\n" +
    "Content-Disposition: attachment; filename=\"" + pdfName + "\"\r\n" +
    "Content-Transfer-Encoding: base64\r\n\r\n" +
    pdfBase64 + "\r\n\r\n" +

    // 🔸 مرفقات نصية إضافية اختيارية (مثل ملف .ics لإضافة حدث للتقويم) — كل عنصر
    // {content, filename, mimeType}، content نص عادي (UTF-8) وليس Blob
    (extraAttachments || []).map(function (att) {
      return "--" + mixedBoundary + "\r\n" +
        "Content-Type: " + att.mimeType + "; name=\"" + att.filename + "\"\r\n" +
        "Content-Disposition: attachment; filename=\"" + att.filename + "\"\r\n" +
        "Content-Transfer-Encoding: base64\r\n\r\n" +
        Utilities.base64Encode(att.content, Utilities.Charset.UTF_8) + "\r\n\r\n";
    }).join("") +

    "--" + mixedBoundary + "--";

  const encodedRaw = Utilities.base64EncodeWebSafe(raw);

  Gmail.Users.Messages.send({ raw: encodedRaw }, "me");
}


////////////////////////////////////////////////////////////////////////////////////////////////////////

function refusedStu_(data , refID , refSH) {
    var ss =  SpreadsheetApp.openById(refID);
    var dataSh = ss.getSheetByName(refSH);

      var cpr = (data.cpr)*1;
      var headers = dataSh.getRange("1:1").getValues();
      var cprCol = headers[0].indexOf('cpr')+1;
      var folderCol = headers[0].indexOf('folder')+1;
      var classCols = [headers[0].indexOf('class0')+1, headers[0].indexOf('class1')+1, headers[0].indexOf('class2')+1, headers[0].indexOf('class3')+1];
      var cprs = dataSh.getRange(1,cprCol,dataSh.getLastRow(),1).getValues();
      var row = cprs.map(c=> c[0]*1).indexOf(cpr)+1;
      Logger.log(row);

      // === تفريغ علم المرحلة المرفوضة تحديدًا فقط، بدل التأثير على كامل سجل الطالب ===
      var grade = data.grade;
      if ([0,1,2,3].includes(grade)) {
        dataSh.getRange(row, classCols[grade]).setValue('');
      }

      // === folder = 'no' يُخفي الطالب نهائيًا من getPersons() — لا يجوز تطبيقه إلا إذا لم يعد له
      //     أي ارتباط بأي مرحلة أخرى (لا نشط ولا منتهٍ ولا معلّق)؛ وإلا فهو طالب منتسب فعلاً لمرحلة
      //     أخرى، ورفض طلب التحاقه بمرحلة إضافية يجب ألا يُخفي انتسابه القائم ===
      var rowValues = dataSh.getRange(row, 1, 1, dataSh.getLastColumn()).getValues()[0];
      var hasOtherRelation = classCols.some(function(col, idx){
        if (idx === grade) return false;
        var v = rowValues[col - 1];
        return v === 'active' || v === 'done' || v === true;
      });
      if (!hasOtherRelation) {
        dataSh.getRange(row,folderCol).setValue('no');
      }

}

//////////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////////////////
function checkExistFiles_(folderID , fileToCheck){
  var folder = DriveApp.getFolderById(folderID); // I change the folder ID  here 
  var files = folder.getFiles();
  while (files.hasNext()){
    file = files.next();
    if(file.getName() == fileToCheck){
      //Logger.log(file.getUrl())
      return file.getUrl();
    }else{
      //Logger.log('');
      return '';
    };

  }
  return '';
}
//////////////////////////////////////////////////////////////////////////////////////////////////////////
function randomID(){
  var rand = `${Math.floor(Math.random() * 9)+1}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}${Math.floor(Math.random() * 10)}`;

  return rand;
}

///////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////

function getRandomInt_(max) {
  const newCode = Math.floor(Math.random() * max);
  checkCodeExisted_(newCode) >= 0 ? getRandomInt_(max) : null;
  return newCode;
}

///////////////////////////////////////////////////////////////////
function checkCodeExisted_(code){
  Logger.log(code);
  var ss = SpreadsheetApp.openById(mainData);
  var sheet = ss.getSheetByName('students');
  var headers = sheet.getRange('1:1').getValues();
  var codeCol = headers[0].indexOf('code');

  const allCodes = sheet.getRange(1,codeCol+1,sheet.getLastRow(),1).getValues();
  const row = allCodes.map(e=> e[0]*1).indexOf(code*1);

  Logger.log(row);
  return row;
}
///////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////
