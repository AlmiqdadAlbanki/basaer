////////////////////////////////////////////////////////////////////////////////////////////////////////
// طابور إرسال إشعارات FCM جماعي بالخلفية — نظير كامل لـwpQueue.js (نفس آلية العمل بالحرف: تشغيلة
// واحدة ترسل رسالة واحدة فقط بلا Utilities.sleep()، والتباعد كله عبر موعد Trigger مؤجَّل تالٍ،
// تفاديًا لاستنفاد حصة Apps Script اليومية المشتركة لكل مشغّلات المشروع — راجع الشرح الكامل لهذا
// القيد أعلى wpQueue.js). الفرق الوحيد الجوهري: لا يوجد هنا حد أدنى صارم للفاصل بين الرسائل —
// ذلك القيد كان تحديدًا لحماية رقم واتساب من الحظر (Fonnte)، ولا ينطبق على FCM إطلاقًا (نداء HTTP
// موقَّع عاديًا لخدمة جوجل، بلا مخاطرة حظر مشابهة) — الحد الأدنى هنا رمزي فقط لتفادي إغراق الحصة.
//
// آلية العمل مطابقة لـwpQueue.js:
//  1) scheduleFCMQueueSend_(rows, options) — عادة من prepareAndScheduleFcmBroadcast (FCMService.js).
//  2) processFCMQueueTick() ترسل إشعارًا واحدًا فقط، ثم تعيد جدولة نفسها حتى الانتهاء.
//  3) getFCMQueueStatus() لعرض الحالة الحيّة بتبويب "حالة الإرسال".
//  4) stopFCMQueueSend() لإيقاف/إلغاء حملة جارية أو مجدولة.
////////////////////////////////////////////////////////////////////////////////////////////////////////

var FCM_QUEUE_SHEET_NAME = 'fcmQueue';
var FCM_QUEUE_TICK_FN = 'processFCMQueueTick';
var FCM_QUEUE_START_FN = 'beginScheduledFCMQueue';
var FCM_QUEUE_HEADERS = ['name', 'cpr', 'token', 'title', 'body', 'status', 'reason'];
var FCM_MIN_PER_MESSAGE_DELAY_SEC = 2; // رمزي فقط — لا يوجد خطر حظر مشابه لواتساب هنا

function getFCMQueueSheet_() {
  var ss = SpreadsheetApp.openById(mainData);
  var sh = ss.getSheetByName(FCM_QUEUE_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(FCM_QUEUE_SHEET_NAME);
    sh.appendRow(FCM_QUEUE_HEADERS);
  }
  return sh;
}

function deleteFCMQueueTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === FCM_QUEUE_TICK_FN || fn === FCM_QUEUE_START_FN) ScriptApp.deleteTrigger(t);
  });
}

// rows: [{name, cpr, token, title, body}] — title/body مُخصَّصان بالفعل لكل صف (استبدال {name}
// تم مسبقًا بالمستدعي، عادة prepareAndScheduleFcmBroadcast بFCMService.js).
// options: { batchSize, perMessageDelaySec, betweenBatchesSec, scheduledAt, sentBy, templateKey }
function scheduleFCMQueueSend_(rows, options) {
  var props = PropertiesService.getScriptProperties();
  var currentStatus = props.getProperty('fcmQueue_status');
  if (currentStatus === 'running' || currentStatus === 'scheduled') {
    return { ok: false, reason: 'توجد حملة إشعارات جارية أو مجدولة بالفعل، يرجى الانتظار حتى تنتهي أو إلغاؤها أولًا.' };
  }

  var list = (rows || []).filter(function (r) { return r && r.token; });
  if (list.length < 1) {
    return { ok: false, reason: 'لا يوجد مستلمون لديهم جهاز مُفعَّل لإرسال الإشعار إليهم.' };
  }

  options = options || {};
  var perMessageDelaySec = Math.max(FCM_MIN_PER_MESSAGE_DELAY_SEC, +options.perMessageDelaySec || FCM_MIN_PER_MESSAGE_DELAY_SEC);
  var batchSize = Math.max(1, +options.batchSize || 20);
  var betweenBatchesSec = Math.max(0, +options.betweenBatchesSec || 0);

  deleteFCMQueueTriggers_();

  var sh = getFCMQueueSheet_();
  sh.clearContents();
  sh.appendRow(FCM_QUEUE_HEADERS);
  var sheetRows = list.map(function (r) { return [r.name || '', r.cpr || '', String(r.token), r.title || '', r.body || '', 'pending', '']; });
  sh.getRange(2, 1, sheetRows.length, FCM_QUEUE_HEADERS.length).setValues(sheetRows);

  var campaignId = Utilities.getUuid();
  var scheduledAt = options.scheduledAt ? new Date(options.scheduledAt) : null;
  var startNow = !scheduledAt || isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now();

  props.setProperties({
    'fcmQueue_status': startNow ? 'running' : 'scheduled',
    'fcmQueue_campaignId': campaignId,
    'fcmQueue_sentBy': options.sentBy || '',
    'fcmQueue_templateKey': options.templateKey || 'fcmBroadcast',
    'fcmQueue_batchSize': String(batchSize),
    'fcmQueue_perMessageDelaySec': String(perMessageDelaySec),
    'fcmQueue_betweenBatchesSec': String(betweenBatchesSec),
    'fcmQueue_sentInBatch': '0',
    'fcmQueue_scheduledAt': startNow ? '' : scheduledAt.toISOString(),
    'fcmQueue_total': String(list.length),
    'fcmQueue_startedAt': startNow ? new Date().toISOString() : '',
    'fcmQueue_finishedAt': ''
  });

  if (startNow) {
    processFCMQueueTick();
  } else {
    ScriptApp.newTrigger(FCM_QUEUE_START_FN).timeBased().at(scheduledAt).create();
  }

  return { ok: true, total: list.length, status: startNow ? 'running' : 'scheduled' };
}

function beginScheduledFCMQueue() {
  deleteFCMQueueTriggers_();
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('fcmQueue_status') !== 'scheduled') return;
  props.setProperty('fcmQueue_status', 'running');
  props.setProperty('fcmQueue_startedAt', new Date().toISOString());
  processFCMQueueTick();
}

// ترسل إشعارًا واحدًا فقط في كل استدعاء — بلا Utilities.sleep() إطلاقًا، نفس منطق processWPQueueTick.
function processFCMQueueTick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    // نفس عطل processWPQueueTick المؤكَّد (wpQueue.js، راجع مناقشات.md 2026-09-14): Trigger
    // الـ.after() لمرة واحدة لا يُحذَف تلقائيًا بشكل موثوق فور إطلاقه، فيتراكم واحد إضافي كل
    // تشغيلة حتى يضرب حد الـ20 Trigger لكل مستخدم بكل مشروع. الحذف هنا أول كل تشغيلة يمنع أي
    // تراكم مماثل بهذا الطابور أيضًا، وقائيًا قبل وقوع نفس البلاغ فعليًا هنا.
    var props = PropertiesService.getScriptProperties();
    deleteFCMQueueTriggers_();
    if (props.getProperty('fcmQueue_status') !== 'running') {
      return;
    }

    var sh = getFCMQueueSheet_();
    var lastRow = sh.getLastRow();
    if (lastRow < 2) { finishFCMQueue_(); return; }

    var data = sh.getRange(2, 1, lastRow - 1, FCM_QUEUE_HEADERS.length).getValues();
    var pendingIdx = -1;
    for (var i = 0; i < data.length; i++) {
      if (data[i][5] === 'pending') { pendingIdx = i; break; }
    }
    if (pendingIdx === -1) { finishFCMQueue_(); return; }

    var perMessageDelaySec = +props.getProperty('fcmQueue_perMessageDelaySec') || FCM_MIN_PER_MESSAGE_DELAY_SEC;
    var batchSize = +props.getProperty('fcmQueue_batchSize') || 20;
    var betweenBatchesSec = +props.getProperty('fcmQueue_betweenBatchesSec') || 0;
    var campaignId = props.getProperty('fcmQueue_campaignId') || '';
    var sentBy = props.getProperty('fcmQueue_sentBy') || '';
    var templateKey = props.getProperty('fcmQueue_templateKey') || 'fcmBroadcast';
    var sentInBatch = +props.getProperty('fcmQueue_sentInBatch') || 0;

    var row = data[pendingIdx];
    var name = row[0], cpr = row[1], token = row[2], title = row[3], body = row[4];

    var result;
    try {
      result = sendFcmNotification_(token, title, body);
    } catch (err) {
      result = { error: true, message: 'خطأ غير متوقع: ' + err.message };
    }

    var ok = !!(result && result.ok);
    var reason = ok ? '' : ((result && result.message) || 'خطأ غير معروف من خدمة FCM');
    data[pendingIdx][5] = ok ? 'sent' : 'failed';
    data[pendingIdx][6] = reason;
    sh.getRange(pendingIdx + 2, 6, 1, 2).setValues([[data[pendingIdx][5], data[pendingIdx][6]]]);

    logWhatsAppMessage_({
      channel: 'fcm',
      campaignId: campaignId,
      templateKey: templateKey,
      recipientName: name,
      recipientTarget: cpr,
      targetType: 'fcmToken',
      messageText: title + ' — ' + body,
      status: ok ? 'sent' : 'failed',
      reason: reason,
      sentBy: sentBy
    });

    var stillPending = data.some(function (r) { return r[5] === 'pending'; });
    if (!stillPending) {
      finishFCMQueue_();
      return;
    }

    sentInBatch++;
    var isBatchDone = sentInBatch >= batchSize;
    props.setProperty('fcmQueue_sentInBatch', isBatchDone ? '0' : String(sentInBatch));
    var nextDelayMs = isBatchDone ? Math.max(1000, betweenBatchesSec * 1000) : (perMessageDelaySec * 1000);
    ScriptApp.newTrigger(FCM_QUEUE_TICK_FN).timeBased().after(nextDelayMs).create();
  } finally {
    lock.releaseLock();
  }
}

function finishFCMQueue_() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('fcmQueue_status', 'done');
  props.setProperty('fcmQueue_finishedAt', new Date().toISOString());
  deleteFCMQueueTriggers_();
}

function stopFCMQueueSend() {
  var props = PropertiesService.getScriptProperties();
  var status = props.getProperty('fcmQueue_status');
  if (status === 'running' || status === 'scheduled') {
    props.setProperty('fcmQueue_status', 'stopped');
    props.setProperty('fcmQueue_finishedAt', new Date().toISOString());
  }
  deleteFCMQueueTriggers_();
  return { ok: true };
}

function getFCMQueueStatus() {
  var props = PropertiesService.getScriptProperties();
  var status = props.getProperty('fcmQueue_status') || 'idle';
  var total = parseInt(props.getProperty('fcmQueue_total') || '0', 10);

  var sent = 0, failed = 0, failedList = [];
  if (status !== 'idle') {
    var sh = getFCMQueueSheet_();
    var lastRow = sh.getLastRow();
    if (lastRow >= 2) {
      var data = sh.getRange(2, 1, lastRow - 1, FCM_QUEUE_HEADERS.length).getValues();
      data.forEach(function (row) {
        if (row[5] === 'sent') {
          sent++;
        } else if (row[5] === 'failed') {
          failed++;
          failedList.push({ name: row[0], target: row[1], reason: row[6] });
        }
      });
    }
  }

  return {
    status: status,
    total: total,
    sent: sent,
    failed: failed,
    remaining: Math.max(0, total - sent - failed),
    failedList: failedList,
    sentBy: props.getProperty('fcmQueue_sentBy') || '',
    scheduledAt: props.getProperty('fcmQueue_scheduledAt') || '',
    startedAt: props.getProperty('fcmQueue_startedAt') || '',
    finishedAt: props.getProperty('fcmQueue_finishedAt') || '',
    perMessageDelaySec: +props.getProperty('fcmQueue_perMessageDelaySec') || FCM_MIN_PER_MESSAGE_DELAY_SEC,
    betweenBatchesSec: +props.getProperty('fcmQueue_betweenBatchesSec') || 0,
    batchSize: +props.getProperty('fcmQueue_batchSize') || 0
  };
}
