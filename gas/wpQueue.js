////////////////////////////////////////////////////////////////////////////////////////////////////////
// طابور إرسال واتساب جماعي بالخلفية — أُعيد بناؤه بالكامل (2026-09-11) ليدعم: تخصيص كل رسالة
// (اسم أول لكل مستلم، عبر firstNameOnly_ بـcode.js)، حجم دفعة وفاصلين قابلين للتحكم (بين كل
// رسالة، وبين كل دفعة)، جدولة لوقت مستقبلي، إرسال لمجموعات واتساب لا الأفراد فقط، وتسجيل كل
// رسالة بسجل دائم (messageLog). راجع مناقشات.md "إدارة الرسائل" للتصميم الكامل المتفَق عليه مع
// المستخدم عبر نقاش مطوَّل قبل التنفيذ.
//
// ⚠️ قيد حاسم ثانٍ اكتُشف بعد النشر الأول (2026-09-12، بسؤال المستخدم مباشرة عن هذا الخطر):
// Google Apps Script لا يحدّه فقط 6 دقائق تنفيذ لكل تشغيلة — بل أيضًا **حصة يومية إجمالية**
// لكل مشغّلات (Triggers) المشروع مجتمعة: 90 دقيقة/يوم لحساب مجاني عادي، 6 ساعات/يوم لحساب
// Workspace (كلاهما مشترك مع بقية مشغّلات المشروع الأخرى القائمة أصلًا: monitorExamSessions
// كل دقيقة، monitorExamReadinessAlerts كل ساعة، continueCertificates عند الحاجة). **الانتظار
// داخل التشغيلة عبر Utilities.sleep() يُحتسَب بالكامل من هذه الحصة** تمامًا كأي تنفيذ فعلي —
// التصميم الأول (إرسال عدة رسائل بتشغيلة واحدة، مع sleep بينها) كان يستهلك دقيقة كاملة من
// الحصة اليومية *لكل رسالة* (بفاصل 60 ثانية)، فيستنفد الحصة اليومية بالكامل بعد عشرات
// الرسائل فقط، ويُعطِّل باقي مشغّلات المشروع لبقية اليوم لا حملة الرسائل فقط. **الحل النهائي**:
// كل تشغيلة ترسل رسالة واحدة فقط، بلا أي Utilities.sleep() إطلاقًا — التباعد كله يتحقق عبر
// توقيت Trigger مؤجَّل للتشغيلة التالية (ScriptApp...after(ms))، فتكلفة كل تشغيلة الفعلية من
// الحصة اليومية ثوانٍ معدودة فقط (وقت نداء Fonnte/Meta + قراءة/كتابة الشيت)، بصرف النظر تمامًا
// عن طول الفاصل الزمني المطلوب بين الرسائل.
//
// ⚠️ قيد حاسم ثالث اكتُشف بعد بلاغ مستخدم حي (2026-09-14): حملة 500 رسالة توقفت صامتة بعد 19
// فقط بلا أي خطأ ظاهر. السبب: كل الحلقة (بما فيها إنشاء Trigger التشغيلة التالية) كانت داخل
// try واحد بلا شبكة أمان — أي استثناء غير متوقَّع بأي خطوة (كتابة شيت، PropertiesService، حتى
// ScriptApp.newTrigger نفسها) كان يمنع الوصول لسطر جدولة التشغيلة التالية، فتموت السلسلة
// بالكامل بصمت (لا خطأ يظهر للإداري، الحالة تبقى 'running' للأبد بلا أي تقدّم). كذلك فشل
// tryLock (تزامن عابر مع تشغيلة أخرى تستخدم نفس القفل، كحفظ تقدّم اختبار طالب) كان يُنهي
// التشغيلة بلا أي إعادة محاولة لاحقة. الحل: كل مسار فاشل الآن يُعيد جدولة تشغيلة تالية (بدل
// الاستسلام الصامت)، ويُسجَّل آخر خطأ + آخر نبضة (lastError/lastTickAt) ليكتشف getWPQueueStatus
// حالة "متوقفة فعليًا رغم الحالة running" ويعرض زر استئناف.
//
// ⚠️ سبب جذري رابع مؤكَّد حيًّا (2026-09-14): "This script has too many triggers" — Apps Script
// لا يحذف Trigger الـ.after() لمرة واحدة فور إطلاقه بشكل موثوق دائمًا؛ كل تشغيلة كانت تُنشئ
// Trigger تاليًا بلا حذف الحالي (الذي استدعاها بالفعل وأدّى غرضه)، فيتراكم واحد إضافي كل رسالة
// حتى يضرب حدّ الـ20 Trigger لكل مستخدم بكل مشروع (تأكَّد بتشخيص حي: 18 نسخة متراكمة بالضبط).
// الحذف الآن يحصل في بداية كل تشغيلة (deleteWPQueueTriggers_) فلا يتراكم أكثر من واحد أبدًا.
//
// ⚠️ فصل مزدوج بطلب المستخدم (2026-09-16): "طابور الحملات محتاج نفصله نخليه طابورين باعتبار
// مزود الخدمة" — بعد إضافة دعم Meta WhatsApp Cloud API الرسمي كمزوّد بديل لـFonnte (dataPost.js:
// prepareAndScheduleBroadcast/sendMetaWhatsAppTemplate_)، كانت حملة Meta تُحجَب خلف حملة Fonnte
// جارية والعكس رغم أنهما قناتان مستقلتان تمامًا بلا أي تعارض حقيقي بينهما (حسابان مختلفان، حدود
// معدل مختلفة). كل الدوال أدناه أصبحت تأخذ provider ('fonnte'|'meta') وتستخدم شيتًا وخصائص
// Script Properties وTriggers خاصة بكل مزوّد على حدة، فتعملان بالتوازي دون أن تحجب إحداهما
// الأخرى. **فونتي احتفظت بكل الأسماء القديمة بالحرف** (لا بادئة، نفس شيت wpQueue، نفس أسماء
// الدوال processWPQueueTick/beginScheduledWPQueue/monitorWPQueueHealth) — أي حملة فونتي جارية
// فعليًا وقت هذا التعديل (أو Trigger مؤجَّل بالفعل) تستمر بلا انقطاع؛ Meta وحدها حصلت على مجموعة
// موازية جديدة تمامًا (شيت wpQueueMeta، بادئة خصائص wpQueueMeta_، دوال *Meta). طابور الحملات
// المنتظرة (wpCampaignQueue/wpCampaignQueueMeta — "Meta" هنا تعني "بيانات وصفية metadata"، لا
// علاقة لها بمزوّد Meta، تسمية سابقة لهذا التعديل) بقي شيتًا مشتركًا (كل صف مُعلَّم بعمود provider
// أصلًا) لأن الفلترة عند السحب كافية، فلا داعي لتكرار الشيتين.
//
// آلية العمل:
//  1) scheduleWPQueueSend_(rows, options) — عادة تُستدعى من prepareAndScheduleBroadcast
//     (dataPost.js) بعد تجهيز rows مُخصَّصة لكل مستلم مسبقًا: تكتب المستلمين بشيت هذا المزوّد، وإما
//     تبدأ الإرسال فورًا (وقت الآن/الماضي) أو تُنشئ Trigger مؤجَّل ليبدأ بموعد مستقبلي. لو كان هذا
//     المزوّد نفسه مشغولًا بالفعل، تُضاف الحملة لطابور انتظاره الخاص (enqueueWPCampaign_) بدل رفضها.
//  2) processWPQueueTick()/processWPQueueTickMeta() تُرسل رسالة واحدة فقط لمزوّدها، ثم تُعيد
//     جدولة نفسها (Trigger مؤجَّل تالٍ) تلقائيًا حتى انتهاء كل المستلمين، ثم تُشغِّل الحملة التالية
//     بطابور هذا المزوّد إن وُجدت (dequeueNextWPCampaign_).
//  3) getWPQueueStatus(provider)/getWPQueueStatusBoth() لعرض الحالة الحيّة لمزوّد واحد أو كليهما.
//  4) stopWPQueueSend(provider)/resumeWPQueueSend(provider) لإيقاف/استئناف حملة مزوّد بعينه.
////////////////////////////////////////////////////////////////////////////////////////////////////////

var WP_QUEUE_HEADERS = ['name', 'target', 'targetType', 'message', 'status', 'reason', 'provider', 'metaTemplateName', 'metaLanguageCode', 'metaBodyParamsJson', 'externalMessageId'];
var WP_MIN_PER_MESSAGE_DELAY_SEC = 60; // حد أدنى ثابت غير قابل للتخفيض — حماية من حظر واتساب

// طابور حملات (لا طابور رسائل مفردة) — بطلب المستخدم (2026-09-15): السماح بجدولة حملة جديدة
// أثناء عمل حملة أخرى بدل رفضها، بحيث تبدأ تلقائيًا فور انتهاء الحملة الحالية، كالأدوار. صفان
// منفصلان: WP_CAMPAIGN_QUEUE (صف واحد لكل مستلم بكل حملة منتظرة، بنفس بنية wpQueue + queueId/
// order للتجميع) وWP_CAMPAIGN_QUEUE_META (صف واحد لكل حملة منتظرة، بياناتها العامة فقط — "META"
// هنا "بيانات وصفية"، لا علاقة لها بمزوّد Meta). كل صف مُعلَّم بعمود provider، فيُفلتَر السحب لكل
// مزوّد على حدة (dequeueNextWPCampaign_) بلا حاجة لشيتين منفصلين لهذا الطابور تحديدًا.
var WP_CAMPAIGN_QUEUE_SHEET_NAME = 'wpCampaignQueue';
var WP_CAMPAIGN_QUEUE_META_SHEET_NAME = 'wpCampaignQueueMeta';
var WP_CAMPAIGN_QUEUE_HEADERS = ['queueId', 'order', 'name', 'target', 'targetType', 'message', 'provider', 'metaTemplateName', 'metaLanguageCode', 'metaBodyParamsJson'];
var WP_CAMPAIGN_QUEUE_META_HEADERS = ['queueId', 'order', 'label', 'total', 'batchSize', 'perMessageDelaySec', 'betweenBatchesSec', 'sentBy', 'templateKey', 'scheduledAt', 'createdAt', 'provider', 'metaTemplateName', 'metaLanguageCode'];

// أسماء الشيت/بادئة الخصائص/أسماء دوال الـTriggers الخاصة بكل مزوّد — فونتي بلا بادئة (توافقًا
// رجعيًا مع أي حملة جارية فعليًا وقت هذا التعديل)، وMeta بمجموعة موازية جديدة كليًا.
function wpQueueSheetName_(provider) { return provider === 'meta' ? 'wpQueueMeta' : 'wpQueue'; }
function wpQueuePropPrefix_(provider) { return provider === 'meta' ? 'wpQueueMeta_' : 'wpQueue_'; }
function wpQueueTickFn_(provider) { return provider === 'meta' ? 'processWPQueueTickMeta' : 'processWPQueueTick'; }
function wpQueueStartFn_(provider) { return provider === 'meta' ? 'beginScheduledWPQueueMeta' : 'beginScheduledWPQueue'; }
function wpQueueHealthFn_(provider) { return provider === 'meta' ? 'monitorWPQueueHealthMeta' : 'monitorWPQueueHealth'; }

// ترقية إضافية فقط لشيتات الطابور القائمة: تضيف الأعمدة الجديدة في النهاية بلا حذف صفوف أو
// إعادة ترتيب. الأعمدة القديمة تظل في أماكنها، فيبقى أي طابور قديم قابلًا للقراءة.
function ensureWPQueueColumns_(sh, wanted) {
  if (sh.getLastColumn() < 1) { sh.appendRow(wanted); return sh; }
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var missing = wanted.filter(function (name) { return headers.indexOf(name) === -1; });
  if (missing.length) sh.getRange(1, sh.getLastColumn() + 1, 1, missing.length).setValues([missing]);
  return sh;
}

function getWPQueueSheet_(provider) {
  var ss = SpreadsheetApp.openById(mainData);
  var name = wpQueueSheetName_(provider);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(WP_QUEUE_HEADERS);
  }
  return ensureWPQueueColumns_(sh, WP_QUEUE_HEADERS);
}

function deleteWPQueueTriggers_(provider) {
  var tickFn = wpQueueTickFn_(provider), startFn = wpQueueStartFn_(provider);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === tickFn || fn === startFn) ScriptApp.deleteTrigger(t);
  });
}

function getWPCampaignQueueSheet_() {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName(WP_CAMPAIGN_QUEUE_SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(WP_CAMPAIGN_QUEUE_SHEET_NAME); sh.appendRow(WP_CAMPAIGN_QUEUE_HEADERS); }
  return ensureWPQueueColumns_(sh, WP_CAMPAIGN_QUEUE_HEADERS);
}

function getWPCampaignQueueMetaSheet_() {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName(WP_CAMPAIGN_QUEUE_META_SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(WP_CAMPAIGN_QUEUE_META_SHEET_NAME); sh.appendRow(WP_CAMPAIGN_QUEUE_META_HEADERS); }
  return ensureWPQueueColumns_(sh, WP_CAMPAIGN_QUEUE_META_HEADERS);
}

// يضيف حملة كاملة لطابور الانتظار (لا تبدأ الآن) — تُستدعى من scheduleWPQueueSend_ نفسها عند
// وجود حملة أخرى لنفس المزوّد جارية/مجدولة بالفعل، بدل رفض الطلب.
function enqueueWPCampaign_(rows, options) {
  var metaSh = getWPCampaignQueueMetaSheet_();
  var lastRow = metaSh.getLastRow();
  var nextOrder = 1;
  if (lastRow > 1) {
    var orders = metaSh.getRange(2, WP_CAMPAIGN_QUEUE_META_HEADERS.indexOf('order') + 1, lastRow - 1, 1).getValues();
    orders.forEach(function (r) { if (+r[0] >= nextOrder) nextOrder = +r[0] + 1; });
  }

  var queueId = Utilities.getUuid();
  var rowsSh = getWPCampaignQueueSheet_();
  var sheetRows = rows.map(function (r) {
    return [queueId, nextOrder, r.name || '', String(r.target), r.targetType || 'phone', r.message || '',
      r.provider || options.provider || 'fonnte', r.metaTemplateName || options.metaTemplateName || '',
      r.metaLanguageCode || options.metaLanguageCode || '', JSON.stringify(r.metaBodyParams || [])];
  });
  rowsSh.getRange(rowsSh.getLastRow() + 1, 1, sheetRows.length, WP_CAMPAIGN_QUEUE_HEADERS.length).setValues(sheetRows);

  var label = String((options.templateKey === 'broadcast' && rows[0] && rows[0].message) || options.templateKey || 'حملة رسائل').substring(0, 60);
  metaSh.appendRow([queueId, nextOrder, label, rows.length, options.batchSize || 20, options.perMessageDelaySec || WP_MIN_PER_MESSAGE_DELAY_SEC,
    options.betweenBatchesSec || 0, options.sentBy || '', options.templateKey || 'broadcast', options.scheduledAt || '',
    new Date().toISOString(), options.provider || 'fonnte', options.metaTemplateName || '', options.metaLanguageCode || '']);

  // الترتيب المعروض بالواجهة (queuePosition) نسبي لطابور هذا المزوّد وحده، لا القيمة الخام
  // المشتركة order — راجع getWPCampaignQueueList_ أدناه لنفس الحساب.
  var myPosition = getWPCampaignQueueList_(options.provider || 'fonnte').filter(function (q) { return q.queueId === queueId; })[0];
  return { ok: true, queued: true, queuePosition: myPosition ? myPosition.position : 1, total: rows.length, provider: options.provider || 'fonnte' };
}

// يستخرج أول حملة بطابور مزوّد بعينه (أصغر order ضمن حملات هذا المزوّد فقط) ويُشغِّلها فعليًا عبر
// scheduleWPQueueSend_ نفسها — تُستدعى من finishWPQueue_ فور انتهاء حملة هذا المزوّد، فتُشغَّل
// حملته التالية تلقائيًا بلا أي تدخل يدوي وبلا أي أثر على طابور المزوّد الآخر.
function dequeueNextWPCampaign_(provider) {
  var metaSh = getWPCampaignQueueMetaSheet_();
  var lastRow = metaSh.getLastRow();
  if (lastRow < 2) return;

  var metaHeaders = metaSh.getRange(1, 1, 1, metaSh.getLastColumn()).getValues()[0];
  var mIdx = {}; metaHeaders.forEach(function (h, i) { mIdx[h] = i; });
  var metaData = metaSh.getRange(2, 1, lastRow - 1, metaHeaders.length).getValues();

  var minRow = -1, minOrder = Infinity;
  metaData.forEach(function (r, i) {
    var rProvider = mIdx.provider === undefined ? 'fonnte' : (r[mIdx.provider] || 'fonnte');
    if (rProvider !== provider) return;
    if (+r[mIdx.order] < minOrder) { minOrder = +r[mIdx.order]; minRow = i; }
  });
  if (minRow === -1) return; // لا حملات منتظرة لهذا المزوّد تحديدًا
  var meta = metaData[minRow];
  var queueId = meta[mIdx.queueId];

  var rowsSh = getWPCampaignQueueSheet_();
  var rLastRow = rowsSh.getLastRow();
  var rHeaders = rowsSh.getRange(1, 1, 1, rowsSh.getLastColumn()).getValues()[0];
  var rIdx = {}; rHeaders.forEach(function (h, i) { rIdx[h] = i; });
  var rData = rLastRow > 1 ? rowsSh.getRange(2, 1, rLastRow - 1, rHeaders.length).getValues() : [];
  var myRows = [], keepRows = [];
  rData.forEach(function (r) {
    if (r[rIdx.queueId] === queueId) {
      var metaBodyParams = [];
      try { metaBodyParams = JSON.parse(r[rIdx.metaBodyParamsJson] || '[]'); } catch (ignore) {}
      myRows.push({
        name: r[rIdx.name], target: r[rIdx.target], targetType: r[rIdx.targetType], message: r[rIdx.message],
        provider: rIdx.provider === undefined ? 'fonnte' : (r[rIdx.provider] || 'fonnte'),
        metaTemplateName: rIdx.metaTemplateName === undefined ? '' : r[rIdx.metaTemplateName],
        metaLanguageCode: rIdx.metaLanguageCode === undefined ? '' : r[rIdx.metaLanguageCode],
        metaBodyParams: metaBodyParams
      });
    }
    else keepRows.push(r);
  });
  rowsSh.clearContents();
  rowsSh.appendRow(WP_CAMPAIGN_QUEUE_HEADERS);
  if (keepRows.length) rowsSh.getRange(2, 1, keepRows.length, rHeaders.length).setValues(keepRows);

  metaSh.deleteRow(minRow + 2);

  if (!myRows.length) { dequeueNextWPCampaign_(provider); return; } // صف فارغ استثنائي — تجاوزه للحملة التالية

  scheduleWPQueueSend_(myRows, {
    batchSize: +meta[mIdx.batchSize],
    perMessageDelaySec: +meta[mIdx.perMessageDelaySec],
    betweenBatchesSec: +meta[mIdx.betweenBatchesSec],
    sentBy: meta[mIdx.sentBy],
    templateKey: meta[mIdx.templateKey],
    provider: provider,
    metaTemplateName: mIdx.metaTemplateName === undefined ? '' : meta[mIdx.metaTemplateName],
    metaLanguageCode: mIdx.metaLanguageCode === undefined ? '' : meta[mIdx.metaLanguageCode],
    scheduledAt: meta[mIdx.scheduledAt] || ''
  });
}

// قائمة الحملات المنتظرة بطابور مزوّد بعينه (للعرض بتبويب "حالة") — position هنا ترتيب نسبي
// ضمن هذا المزوّد وحده (1، 2، 3...)، لا القيمة الخام المشتركة order.
function getWPCampaignQueueList_(provider) {
  provider = provider === 'meta' ? 'meta' : 'fonnte';
  var metaSh = getWPCampaignQueueMetaSheet_();
  var lastRow = metaSh.getLastRow();
  if (lastRow < 2) return [];
  var headers = metaSh.getRange(1, 1, 1, metaSh.getLastColumn()).getValues()[0];
  var idx = {}; headers.forEach(function (h, i) { idx[h] = i; });
  return metaSh.getRange(2, 1, lastRow - 1, headers.length).getValues()
    .map(function (r) {
      return {
        queueId: r[idx.queueId], order: +r[idx.order], label: r[idx.label], total: +r[idx.total],
        provider: idx.provider === undefined ? 'fonnte' : (r[idx.provider] || 'fonnte'),
        scheduledAt: r[idx.scheduledAt] || ''
      };
    })
    .filter(function (q) { return q.provider === provider; })
    .sort(function (a, b) { return a.order - b.order; })
    .map(function (q, i) { q.position = i + 1; return q; });
}

// كلا المزوّدين معًا بنداء واحد — لتبسيط الواجهة (بطاقتان بلا رحلتي شبكة منفصلتين).
function getWPCampaignQueueListBoth() {
  return { fonnte: getWPCampaignQueueList_('fonnte'), meta: getWPCampaignQueueList_('meta') };
}

// إلغاء حملة منتظرة بالطابور قبل أن يأتي دورها — يحذف صفوفها من الشيتين معًا. queueId فريد عالميًا
// فلا حاجة لتمرير provider هنا.
function cancelQueuedWPCampaign(queueId) {
  var metaSh = getWPCampaignQueueMetaSheet_();
  var lastRow = metaSh.getLastRow();
  if (lastRow < 2) return { ok: false, reason: 'الطابور فارغ بالفعل.' };
  var headers = metaSh.getRange(1, 1, 1, metaSh.getLastColumn()).getValues()[0];
  var qIdCol = headers.indexOf('queueId');
  var data = metaSh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var targetRow = -1;
  for (var i = 0; i < data.length; i++) { if (data[i][qIdCol] === queueId) { targetRow = i; break; } }
  if (targetRow === -1) return { ok: false, reason: 'لم يُعثر على هذه الحملة بالطابور — ربما بدأت بالفعل أو أُلغيت مسبقًا.' };
  metaSh.deleteRow(targetRow + 2);

  var rowsSh = getWPCampaignQueueSheet_();
  var rLastRow = rowsSh.getLastRow();
  if (rLastRow > 1) {
    var rHeaders = rowsSh.getRange(1, 1, 1, rowsSh.getLastColumn()).getValues()[0];
    var rQIdCol = rHeaders.indexOf('queueId');
    var rData = rowsSh.getRange(2, 1, rLastRow - 1, rHeaders.length).getValues();
    var keepRows = rData.filter(function (r) { return r[rQIdCol] !== queueId; });
    rowsSh.clearContents();
    rowsSh.appendRow(WP_CAMPAIGN_QUEUE_HEADERS);
    if (keepRows.length) rowsSh.getRange(2, 1, keepRows.length, rHeaders.length).setValues(keepRows);
  }
  return { ok: true };
}

// rows: [{name, target, targetType:'phone'|'group', message}] — message مُخصَّص بالفعل لكل صف
// (استبدال {name} تم مسبقًا بالمستدعي، عادة prepareAndScheduleBroadcast بdataPost.js).
// options: { batchSize, perMessageDelaySec, betweenBatchesSec, scheduledAt (ISO string أو فارغ
// للإرسال الفوري), sentBy, templateKey, provider:'fonnte'|'meta' (افتراضي fonnte)، وبيانات قالب
// Meta إن كان هو المزوّد }
// لو كانت هناك حملة أخرى لنفس المزوّد جارية/مجدولة بالفعل، تُضاف هذه الحملة لطابور انتظار ذلك
// المزوّد تحديدًا (enqueueWPCampaign_) بدل رفضها — لا تتأثر بأي حملة للمزوّد الآخر إطلاقًا.
function scheduleWPQueueSend_(rows, options) {
  options = options || {};
  var provider = options.provider === 'meta' ? 'meta' : 'fonnte';
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  var currentStatus = props.getProperty(propPrefix + 'status');

  var list = (rows || []).filter(function (r) { return r && r.target; });
  if (list.length < 1) {
    return { ok: false, reason: 'لا يوجد مستلمون لإرسال الرسالة إليهم.' };
  }

  // الحد الأدنى مفروض دائمًا من الخادم بصرف النظر عمّا أرسله العميل — لا استثناء.
  var perMessageDelaySec = Math.max(WP_MIN_PER_MESSAGE_DELAY_SEC, +options.perMessageDelaySec || WP_MIN_PER_MESSAGE_DELAY_SEC);
  var batchSize = Math.max(1, +options.batchSize || 20);
  var betweenBatchesSec = Math.max(0, +options.betweenBatchesSec || 0);
  options.perMessageDelaySec = perMessageDelaySec;
  options.batchSize = batchSize;
  options.betweenBatchesSec = betweenBatchesSec;
  options.provider = provider;

  if (currentStatus === 'running' || currentStatus === 'scheduled') {
    return enqueueWPCampaign_(list, options);
  }

  deleteWPQueueTriggers_(provider); // تنظيف احتياطي لأي Trigger سابق متبقٍّ لهذا المزوّد تحديدًا

  var sh = getWPQueueSheet_(provider);
  sh.clearContents();
  sh.appendRow(WP_QUEUE_HEADERS);
  var sheetRows = list.map(function (r) {
    return [r.name || '', String(r.target), r.targetType || 'phone', r.message || '', 'pending', '',
      r.provider || provider, r.metaTemplateName || options.metaTemplateName || '',
      r.metaLanguageCode || options.metaLanguageCode || '', JSON.stringify(r.metaBodyParams || []), ''];
  });
  sh.getRange(2, 1, sheetRows.length, WP_QUEUE_HEADERS.length).setValues(sheetRows);

  var campaignId = Utilities.getUuid();
  var scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : null;
  var startNow = !scheduledAt || isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now();

  var propsObj = {};
  propsObj[propPrefix + 'status'] = startNow ? 'running' : 'scheduled';
  propsObj[propPrefix + 'campaignId'] = campaignId;
  propsObj[propPrefix + 'sentBy'] = options.sentBy || '';
  propsObj[propPrefix + 'templateKey'] = options.templateKey || 'broadcast';
  propsObj[propPrefix + 'provider'] = provider;
  propsObj[propPrefix + 'metaTemplateName'] = options.metaTemplateName || '';
  propsObj[propPrefix + 'metaLanguageCode'] = options.metaLanguageCode || '';
  propsObj[propPrefix + 'batchSize'] = String(batchSize);
  propsObj[propPrefix + 'perMessageDelaySec'] = String(perMessageDelaySec);
  propsObj[propPrefix + 'betweenBatchesSec'] = String(betweenBatchesSec);
  propsObj[propPrefix + 'sentInBatch'] = '0';
  propsObj[propPrefix + 'scheduledAt'] = startNow ? '' : scheduledAt.toISOString();
  propsObj[propPrefix + 'total'] = String(list.length);
  propsObj[propPrefix + 'startedAt'] = startNow ? new Date().toISOString() : '';
  propsObj[propPrefix + 'finishedAt'] = '';
  propsObj[propPrefix + 'lastTickAt'] = '';
  propsObj[propPrefix + 'lastError'] = '';
  propsObj[propPrefix + 'staleNotified'] = '';
  props.setProperties(propsObj);

  ensureWPQueueHealthTrigger_(provider);

  if (startNow) {
    processWPQueueTickCore_(provider); // إرسال أول رسالة فورًا، دون انتظار أول تشغيلة Trigger لاحقة
  } else {
    ScriptApp.newTrigger(wpQueueStartFn_(provider)).timeBased().at(scheduledAt).create();
  }

  return { ok: true, total: list.length, status: startNow ? 'running' : 'scheduled', provider: provider };
}

// نظير الآلية القديمة (قبل توحيدها بصفحة "إدارة الرسائل" الجديدة) — يبقى متاحًا لأي نقطة دخول
// لم تُنقَل بعد لصيغة scheduleWPQueueSend_ الجديدة، فيحوّل الطلب البسيط القديم (مستلمون + نص
// مشترك واحد) لصيغة الطابور الجديدة عبر فونتي دائمًا (لا خيار مزوّد بهذا المسار القديم).
function startWPQueueSend(recipients, msg) {
  // هذا المسار القديم يرسل إلى أرقام أفراد عبر Fonnte دائمًا، فيخضع لنفس تعطيل الإرسال الجماعي
  // للأفراد عند اختيار Fonnte (راجع isIndividualBroadcastAllowedForActiveProvider_ بـdataGet.js)
  // حتى لا يتجاوز الفحصَ أحدٌ يناديه مباشرة.
  if (!isIndividualBroadcastAllowedForActiveProvider_()) return { ok: false, reason: BROADCAST_INDIVIDUALS_DISABLED_FONNTE_MESSAGE_ };
  var rows = (recipients || []).filter(function (r) { return r && r.phone; })
    .map(function (r) { return { name: r.name || '', target: r.phone, targetType: 'phone', message: msg || '' }; });
  return scheduleWPQueueSend_(rows, { templateKey: 'broadcast' });
}

// دالتا الـTrigger المؤجَّل لحملة مجدولة لكل مزوّد — تحوّلان الحالة من 'scheduled' لـ'running'
// الفعلية عند حلول الموعد وتبدآن الإرسال. تحذف نفسها من قائمة الـTriggers فور تنفيذها. لو أُلغيت
// الحملة (stopWPQueueSend) قبل حلول الموعد، الحالة لن تكون 'scheduled' وقتها فتتجاهل التنفيذ بأمان.
function beginScheduledWPQueue() { beginScheduledWPQueueCore_('fonnte'); }
function beginScheduledWPQueueMeta() { beginScheduledWPQueueCore_('meta'); }
function beginScheduledWPQueueCore_(provider) {
  deleteWPQueueTriggers_(provider);
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(propPrefix + 'status') !== 'scheduled') return;
  props.setProperty(propPrefix + 'status', 'running');
  props.setProperty(propPrefix + 'startedAt', new Date().toISOString());
  processWPQueueTickCore_(provider);
}

// دالتا الـTrigger الفعليتان لكل مزوّد — كل استدعاء يرسل رسالة واحدة فقط من طابور مزوّده، عمدًا،
// لا استثناء (راجع التعليق أعلى الملف بشأن حصة Apps Script اليومية). التباعد بين كل رسالة
// والتالية، وبين كل دفعة والتالية، يتحقق كليًا عبر موعد إنشاء Trigger التشغيلة القادمة — صفر
// استدعاءات Utilities.sleep() في كل هذا الملف.
function processWPQueueTick() { processWPQueueTickCore_('fonnte'); }
function processWPQueueTickMeta() { processWPQueueTickCore_('meta'); }

function processWPQueueTickCore_(provider) {
  var propPrefix = wpQueuePropPrefix_(provider);
  var tickFn = wpQueueTickFn_(provider);
  var props = PropertiesService.getScriptProperties();
  props.setProperty(propPrefix + 'lastTickAt', new Date().toISOString());

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    // تزامن عابر فقط — نُعيد جدولة محاولة قريبة بدل التوقف نهائيًا؛ لو الحالة لم تعد 'running'
    // (مثلًا أُلغيت الحملة بالتزامن) ستتجاهل التشغيلة القادمة نفسها بأمان كالمعتاد.
    if (props.getProperty(propPrefix + 'status') === 'running') {
      try { ScriptApp.newTrigger(tickFn).timeBased().after(15000).create(); } catch (e) {}
    }
    return;
  }

  try {
    // السبب الجذري المؤكَّد حيًّا لـ"too many triggers" — راجع الشرح أعلى الملف. الحذف هنا في
    // بداية كل تشغيلة يضمن عدم وجود أكثر من Trigger واحد لطابور هذا المزوّد في أي لحظة.
    deleteWPQueueTriggers_(provider);

    if (props.getProperty(propPrefix + 'status') !== 'running') {
      return;
    }

    var sh = getWPQueueSheet_(provider);
    var lastRow = sh.getLastRow();
    if (lastRow < 2) { finishWPQueue_(provider); return; }

    var data = sh.getRange(2, 1, lastRow - 1, WP_QUEUE_HEADERS.length).getValues();
    var pendingIdx = -1;
    for (var i = 0; i < data.length; i++) {
      // Meta لا توفر مفتاح idempotency لإرسال الرسائل. إذا انقطعت تشغيلة سابقة بعد خروج طلب
      // Graph API وقبل حفظ رده، يبقى الصف "sending". لا نعيد إرساله تلقائيًا حتى لا تصل
      // الرسالة مرتين؛ نغلقه كفشل غير محسوم ونترك القرار ظاهرًا للإداري في السجل.
      if (data[i][4] === 'sending') {
        var ambiguousReason = 'نتيجة إرسال Meta غير محسومة بعد انقطاع التشغيلة؛ لم تُعَد المحاولة تلقائيًا منعًا لتكرار الرسالة';
        data[i][4] = 'failed';
        data[i][5] = ambiguousReason;
        sh.getRange(i + 2, 5, 1, 2).setValues([['failed', ambiguousReason]]);
        logWhatsAppMessage_({
          campaignId: props.getProperty(propPrefix + 'campaignId') || '',
          templateKey: props.getProperty(propPrefix + 'templateKey') || 'broadcast',
          provider: provider,
          externalMessageId: '',
          recipientName: data[i][0],
          recipientTarget: data[i][1],
          targetType: data[i][2],
          messageText: data[i][3],
          status: 'failed',
          reason: ambiguousReason,
          sentBy: props.getProperty(propPrefix + 'sentBy') || ''
        });
      }
      if (data[i][4] === 'pending') { pendingIdx = i; break; }
    }
    if (pendingIdx === -1) { finishWPQueue_(provider); return; }

    var perMessageDelaySec = +props.getProperty(propPrefix + 'perMessageDelaySec') || WP_MIN_PER_MESSAGE_DELAY_SEC;
    var batchSize = +props.getProperty(propPrefix + 'batchSize') || 20;
    var betweenBatchesSec = +props.getProperty(propPrefix + 'betweenBatchesSec') || 0;
    var campaignId = props.getProperty(propPrefix + 'campaignId') || '';
    var sentBy = props.getProperty(propPrefix + 'sentBy') || '';
    var templateKey = props.getProperty(propPrefix + 'templateKey') || 'broadcast';
    var sentInBatch = +props.getProperty(propPrefix + 'sentInBatch') || 0;

    var row = data[pendingIdx];
    var name = row[0], target = row[1], targetType = row[2], message = row[3];
    var rowProvider = row[6] || provider;
    var metaTemplateName = row[7] || '';
    var metaLanguageCode = row[8] || '';
    var metaBodyParams = [];
    try { metaBodyParams = JSON.parse(row[9] || '[]'); } catch (ignore) {}

    // شبكة أمان داخلية: أي استثناء غير متوقَّع من هنا فصاعدًا (كتابة الشيت، السجل، جدولة
    // التشغيلة التالية) يُعامَل الصف الحالي كفاشل ويُكمَل الطابور بدل موت السلسلة بالكامل.
    try {
      var result;
      try {
        if (rowProvider === 'meta') {
          // Outbox guard قبل الطلب الخارجي: أي انهيار بعد هذه النقطة يترك أثرًا يمنع إعادة
          // الإرسال التلقائي لنفس المستلم في التشغيلة التالية.
          sh.getRange(pendingIdx + 2, 5, 1, 2).setValues([['sending', 'بانتظار رد Meta']]);
          SpreadsheetApp.flush();
        }
        result = sendSingleWPTarget_(target, targetType, message, {
          provider: rowProvider,
          metaTemplateName: metaTemplateName,
          metaLanguageCode: metaLanguageCode,
          metaBodyParams: metaBodyParams
        });
      } catch (err) {
        result = { status: false, reason: 'خطأ غير متوقع: ' + err.message };
      }

      var ok = !!(result && result.status);
      var reason = ok ? '' : ((result && (result.reason || result.detail)) || 'خطأ غير معروف من خدمة واتساب');
      data[pendingIdx][4] = ok ? 'sent' : 'failed';
      data[pendingIdx][5] = reason;
      var rawExternalId = result && (result.messageId || result.id) ? (result.messageId || result.id) : '';
      data[pendingIdx][10] = Array.isArray(rawExternalId) ? rawExternalId.join(',') : String(rawExternalId || '');
      sh.getRange(pendingIdx + 2, 5, 1, 2).setValues([[data[pendingIdx][4], data[pendingIdx][5]]]);
      if (data[pendingIdx][10]) sh.getRange(pendingIdx + 2, 11).setValue(data[pendingIdx][10]);

      logWhatsAppMessage_({
        campaignId: campaignId,
        templateKey: templateKey,
        provider: rowProvider,
        externalMessageId: data[pendingIdx][10],
        recipientName: name,
        recipientTarget: target,
        targetType: targetType,
        messageText: message,
        status: ok ? 'sent' : 'failed',
        reason: reason,
        sentBy: sentBy
      });

      var stillPending = data.some(function (r) { return r[4] === 'pending'; });
      if (!stillPending) {
        finishWPQueue_(provider);
        return;
      }

      // "حجم الدفعة" هنا يعني: كم رسالة قبل أن يأخذ فاصلًا أطول ("الفاصل بين الدفعات") بدل الفاصل
      // العادي بين كل رسالة — لا "كم رسالة بتشغيلة واحدة" (كل تشغيلة رسالة واحدة دائمًا، بصرف
      // النظر عن حجم الدفعة).
      sentInBatch++;
      var isBatchDone = sentInBatch >= batchSize;
      props.setProperty(propPrefix + 'sentInBatch', isBatchDone ? '0' : String(sentInBatch));
      var nextDelayMs = isBatchDone ? Math.max(1000, betweenBatchesSec * 1000) : (perMessageDelaySec * 1000);
      ScriptApp.newTrigger(tickFn).timeBased().after(nextDelayMs).create();
      props.deleteProperty(propPrefix + 'lastError');
      props.deleteProperty(propPrefix + 'staleNotified');
    } catch (tickErr) {
      props.setProperty(propPrefix + 'lastError', String(tickErr));
      // نحاول جدولة تشغيلة تالية رغم الخطأ غير المتوقَّع — أفضل من ترك الحملة عالقة بصمت للأبد.
      try { ScriptApp.newTrigger(tickFn).timeBased().after(Math.max(WP_MIN_PER_MESSAGE_DELAY_SEC, 60) * 1000).create(); } catch (e2) {}
    }
  } finally {
    lock.releaseLock();
  }
}

// استئناف حملة يدويًا لمزوّد بعينه لو بدت "عالقة" (الحالة لا تزال 'running' لكن بلا أي تقدّم
// فعلي منذ وقت طويل — راجع isStale بـgetWPQueueStatus). يستدعي التشغيلة مباشرة بدل انتظار
// Trigger قد لا يكون موجودًا أصلًا لو ماتت السلسلة بصمت. آمن الاستدعاء حتى لو لم تكن الحملة
// عالقة فعليًا (القفل الداخلي بالتشغيلة يمنع أي تعارض مع تشغيلة أخرى جارية بالفعل).
function resumeWPQueueSend(provider) {
  provider = provider === 'meta' ? 'meta' : 'fonnte';
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(propPrefix + 'status') !== 'running') {
    return { ok: false, reason: 'لا توجد حملة جارية حاليًا لاستئنافها.' };
  }
  // ضمان وجود الحارس الدوري هنا أيضًا لا فقط عند scheduleWPQueueSend_ — حملة بدأت قبل إضافة هذا
  // الحارس تبقى بلا أي مراقبة تلقائية للأبد وإن استُؤنفت يدويًا عدة مرات، فلا يصلها أي إشعار
  // توقّف صامت مستقبلي.
  ensureWPQueueHealthTrigger_(provider);
  props.deleteProperty(propPrefix + 'staleNotified');
  deleteWPQueueTriggers_(provider);
  processWPQueueTickCore_(provider);
  return { ok: true };
}

// إرسال رسالة واحدة لهدف واحد (رقم فردي أو مجموعة) — معرّفات المجموعات (xxx@g.us) لا تمر أبدًا
// على toInternationalWhatsAppNumber (ستُفسدها، فهي ليست رقم هاتف). راجع sendWPRaw_ (dataPost.js).
function sendSingleWPTarget_(target, targetType, message, delivery) {
  var finalTarget = targetType === 'group' ? target : toInternationalWhatsAppNumber(target);
  return sendWPRaw_(finalTarget, message, null, null, delivery || { provider: 'fonnte' });
}

function finishWPQueue_(provider) {
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  props.setProperty(propPrefix + 'status', 'done');
  props.setProperty(propPrefix + 'finishedAt', new Date().toISOString());
  deleteWPQueueTriggers_(provider);
  notifyWPQueueOwner_(provider, 'done');
  // طابور الحملات: لو كانت هناك حملة تالية منتظرة لنفس المزوّد، تبدأ الآن تلقائيًا (الحالة أصبحت
  // 'done' فعليًا أعلاه، فسيمر تحقق scheduleWPQueueSend_ الداخلي بأمان). لا يمسّ طابور المزوّد الآخر.
  dequeueNextWPCampaign_(provider);
}

// إيقاف/إلغاء يدوي لمزوّد بعينه — يعمل بنفس الطريقة سواء كانت حملته جارية بالفعل ('running') أو
// لسه بانتظار موعدها المستقبلي ('scheduled')؛ في الحالتين يحذف أي Trigger معلَّق لهذا المزوّد
// تحديدًا فلا يعمل شيء لاحقًا مهما حدث، بلا أي أثر على المزوّد الآخر.
function stopWPQueueSend(provider) {
  provider = provider === 'meta' ? 'meta' : 'fonnte';
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  var status = props.getProperty(propPrefix + 'status');
  if (status === 'running' || status === 'scheduled') {
    props.setProperty(propPrefix + 'status', 'stopped');
    props.setProperty(propPrefix + 'finishedAt', new Date().toISOString());
    notifyWPQueueOwner_(provider, 'stopped', 'أُلغيت يدويًا من قِبَل الإداري');
  }
  deleteWPQueueTriggers_(provider);
  return { ok: true };
}

// يبحث عن بيانات تواصل صاحب حملة مزوّد بعينه (sentBy، رقم شخصي لمتعاون) بشيت emp — لإرسال إشعار
// انتهاء/توقّف الحملة له مباشرة. يُعيد null بصمت لو لم يُعثر عليه (لا يوقف الحملة نفسها بأي حال).
function wpQueueOwnerContact_(provider) {
  var propPrefix = wpQueuePropPrefix_(provider);
  var cpr = PropertiesService.getScriptProperties().getProperty(propPrefix + 'sentBy');
  if (!cpr) return null;
  var found = findEmpRowByCpr_(cpr);
  if (!found) return null;
  var row = found.sheet.getRange(found.rowNumber, 1, 1, found.headers.length).getValues()[0];
  var idx = {};
  found.headers.forEach(function (h, i) { idx[h] = i; });
  return {
    name: idx.name !== undefined ? row[idx.name] : '',
    phone: idx.phone !== undefined ? String(row[idx.phone] || '').trim() : '',
    email: idx.email !== undefined ? String(row[idx.email] || '').trim() : ''
  };
}

// إشعار واتساب + إيميل لمن بدأ حملة مزوّد بعينه بحالتها النهائية (اكتملت/توقفت) — كلا القناتين
// معزولتان بـtry/catch مستقلَّين (فشل واحدة لا يمنع الأخرى، ولا يؤثر أي فشل هنا على الحملة نفسها
// بأي حال، نفس فلسفة sendExamAdminReadinessAlert_ بـexamSessions.js). kind: 'done'|'stopped'.
// ملاحظة: الإشعار نفسه يُرسَل عبر Fonnte دائمًا (sendWPRaw_ بلا delivery صريح) بصرف النظر عن
// مزوّد الحملة نفسها — إشعار إداري داخلي بسيط، لا رسالة ضمن الحملة التي قد تستخدم قالب Meta.
function notifyWPQueueOwner_(provider, kind, reasonText) {
  try {
    var contact = wpQueueOwnerContact_(provider);
    if (!contact) return;
    var st = getWPQueueStatus(provider);
    var templateKey = kind === 'done' ? 'wpQueueDone' : 'wpQueueStopped';
    var vars = { total: st.total, sent: st.sent, failed: st.failed, remaining: st.remaining, reason: reasonText || 'غير معروف' };
    var body = getActiveMessageTemplateBody_(templateKey);
    var msg = renderMessageTemplate_(body || MESSAGE_TEMPLATE_DEFS_[templateKey].defaultBody, vars);
    var providerLabel = provider === 'meta' ? ' (Meta)' : ' (Fonnte)';
    var subject = (kind === 'done' ? 'اكتملت حملة رسائل الواتساب' : 'توقّفت حملة رسائل الواتساب') + providerLabel;

    if (contact.phone) {
      try { sendWPRaw_(toInternationalWhatsAppNumber(contact.phone), msg); } catch (e1) { Logger.log('تعذّر إرسال إشعار واتساب لصاحب الحملة: ' + e1); }
    }
    if (contact.email && !isEmailBlocked_(contact.email)) {
      try {
        GmailApp.sendEmail(contact.email, subject, msg, {
          name: 'بصائر للعلوم الشرعية',
          htmlBody: buildBasairPlainMessageEmail_('إدارة الرسائل', subject, msg),
          inlineImages: { basairLogo: getBasairLogoBlob_() }
        });
      } catch (e2) { Logger.log('تعذّر إرسال إشعار إيميل لصاحب الحملة: ' + e2); }
    }
  } catch (err) {
    Logger.log('تعذّر إشعار صاحب حملة الرسائل: ' + err);
  }
}

function ensureWPQueueHealthTrigger_(provider) {
  var healthFn = wpQueueHealthFn_(provider);
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === healthFn; });
  if (!exists) ScriptApp.newTrigger(healthFn).timeBased().everyMinutes(10).create();
}

// حارسان دوريان (كل 10 دقائق)، واحد لكل مزوّد، يكتشفان حملة "عالقة فعليًا رغم ظهورها running"
// (راجع isStale بـgetWPQueueStatus) ويُشعران صاحبها مرة واحدة فقط لكل فترة توقّف (لا يتكرر
// الإشعار كل 10 دقائق طالما بقيت عالقة — staleNotified، يُعاد ضبطها عند كل تشغيلة ناجحة أو
// استئناف يدوي جديد). لا يحاولان استئنافًا تلقائيًا — القرار يبقى بيد الإداري (زر "استئناف الآن"
// بالواجهة)، تفاديًا لحلقة محاولات صامتة لو كان العطل جذريًا (مثل توقف الخدمة نفسها).
function monitorWPQueueHealth() { monitorWPQueueHealthCore_('fonnte'); }
function monitorWPQueueHealthMeta() { monitorWPQueueHealthCore_('meta'); }
function monitorWPQueueHealthCore_(provider) {
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(propPrefix + 'status') !== 'running') return;
  var st = getWPQueueStatus(provider);
  if (!st.isStale) return;
  if (props.getProperty(propPrefix + 'staleNotified') === '1') return;
  props.setProperty(propPrefix + 'staleNotified', '1');
  notifyWPQueueOwner_(provider, 'stopped', st.lastError ? ('توقّف تلقائي غير متوقَّع — ' + st.lastError) : 'توقّف تلقائي غير متوقَّع بلا أي تقدّم منذ فترة طويلة');
}

function getWPQueueStatus(provider) {
  provider = provider === 'meta' ? 'meta' : 'fonnte';
  var propPrefix = wpQueuePropPrefix_(provider);
  var props = PropertiesService.getScriptProperties();
  var status = props.getProperty(propPrefix + 'status') || 'idle';
  var total = parseInt(props.getProperty(propPrefix + 'total') || '0', 10);

  var sent = 0, failed = 0, failedList = [];
  if (status !== 'idle') {
    var sh = getWPQueueSheet_(provider);
    var lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      var data = sh.getRange(2, 1, lastRow - 1, WP_QUEUE_HEADERS.length).getValues();
      data.forEach(function (row) {
        if (row[4] === 'sent') {
          sent++;
        } else if (row[4] === 'failed') {
          failed++;
          // phone مُكرَّرة (تطابق target) بلا داعٍ فعلي إلا التوافق مع واجهة "إرسال رسالة"
          // القديمة (js.html) التي تقرأ f.phone تحديدًا بجدول تفاصيل الفاشلين.
          failedList.push({ name: row[0], target: row[1], phone: row[1], reason: row[5] });
        }
      });
    }
  }

  // isStale: الحالة لا تزال 'running' لكن لم تسجَّل أي نبضة (lastTickAt) منذ مدة أطول بكثير من
  // الفاصل المتوقَّع بين رسالتين — دليل قوي على أن سلسلة الجدولة ماتت صمتًا رغم بقاء الحالة
  // running بلا أي مؤشر آخر. الواجهة تعرض عندها زر "استئناف" بدل الانتظار الأبدي.
  var lastTickAt = props.getProperty(propPrefix + 'lastTickAt') || '';
  var perMessageDelaySec = +props.getProperty(propPrefix + 'perMessageDelaySec') || WP_MIN_PER_MESSAGE_DELAY_SEC;
  var betweenBatchesSec = +props.getProperty(propPrefix + 'betweenBatchesSec') || 0;
  var staleThresholdMs = Math.max(perMessageDelaySec, betweenBatchesSec) * 1000 * 3 + 5 * 60 * 1000;
  var isStale = status === 'running' && (!lastTickAt || (Date.now() - new Date(lastTickAt).getTime()) > staleThresholdMs);

  return {
    provider: provider,
    status: status,
    total: total,
    sent: sent,
    failed: failed,
    remaining: Math.max(0, total - sent - failed),
    failedList: failedList,
    sentBy: props.getProperty(propPrefix + 'sentBy') || '',
    metaTemplateName: props.getProperty(propPrefix + 'metaTemplateName') || '',
    scheduledAt: props.getProperty(propPrefix + 'scheduledAt') || '',
    startedAt: props.getProperty(propPrefix + 'startedAt') || '',
    finishedAt: props.getProperty(propPrefix + 'finishedAt') || '',
    perMessageDelaySec: perMessageDelaySec,
    betweenBatchesSec: betweenBatchesSec,
    batchSize: +props.getProperty(propPrefix + 'batchSize') || 0,
    lastTickAt: lastTickAt,
    lastError: props.getProperty(propPrefix + 'lastError') || '',
    isStale: !!isStale
  };
}

// كلا المزوّدين معًا بنداء واحد — لتبسيط الواجهة (بطاقتان بلا رحلتي شبكة منفصلتين).
function getWPQueueStatusBoth() {
  return { fonnte: getWPQueueStatus('fonnte'), meta: getWPQueueStatus('meta') };
}
