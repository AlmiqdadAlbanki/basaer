// خدمة إرسال إشعارات Firebase Cloud Messaging (FCM HTTP v1) — تعتمد على مكتبة OAuth2
// (Resources > Libraries) وعلى بيانات الاعتماد المحفوظة في Script Properties
// (FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_EMAIL / FCM_PRIVATE_KEY)، راجع FCMSetup.js.

function getFcmOAuthService_() {
  var props = PropertiesService.getScriptProperties();
  return OAuth2.createService('FCM')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setPrivateKey(props.getProperty('FCM_PRIVATE_KEY'))
    .setIssuer(props.getProperty('FCM_SERVICE_ACCOUNT_EMAIL'))
    .setPropertyStore(props)
    .setScope('https://www.googleapis.com/auth/firebase.messaging');
}

// إرسال إشعار مباشر بتوكن جهاز معروف. لا تُستدعى من الواجهة عبر google.script.run إطلاقًا —
// استدعاء داخلي من الخادم فقط (Triggers.gs أو أي دالة حفظ حضور/درجة قائمة بالفعل).
function sendFcmNotification_(token, title, body) {
  var service = getFcmOAuthService_();
  if (!service.hasAccess()) {
    Logger.log('FCM auth error: ' + service.getLastError());
    return { error: true, message: 'تعذّرت المصادقة مع FCM' };
  }
  var projectId = PropertiesService.getScriptProperties().getProperty('FCM_PROJECT_ID');
  var url = 'https://fcm.googleapis.com/v1/projects/' + projectId + '/messages:send';
  var payload = {
    message: {
      token: token,
      notification: {
        title: title,
        body: body,
        image: 'https://basaerbh.com/assets/images/favicon-180.png'
      },
      webpush: {
        notification: { icon: 'https://basaerbh.com/assets/images/favicon-180.png' }
      }
    }
  };
  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code === 200) return { ok: true };
  if (text.indexOf('UNREGISTERED') > -1 || text.indexOf('INVALID_ARGUMENT') > -1) removeFcmToken_(token);
  Logger.log('FCM send error (' + code + '): ' + text);
  return { error: true, message: 'فشل إرسال الإشعار' };
}

// نقطة الاستدعاء المقترحة من أي مكان بالمشروع يريد تنبيه طالب معيّن (غياب/درجة/إلخ):
// sendFcmNotificationToStudent_(cpr, 'عنوان', 'نص الإشعار');
function sendFcmNotificationToStudent_(cpr, title, body) {
  var token = getFcmTokenForStudent_(cpr);
  if (!token) return { error: true, message: 'لا يوجد جهاز مسجَّل لهذا الطالب' };
  return sendFcmNotification_(token, title, body);
}

// المنسّق الكامل لتبويب "الإشعارات" بـ"إدارة الرسائل" — نظير prepareAndScheduleBroadcast
// (dataPost.js) لكن للإشعارات بدل واتساب. يستقبل مستلمين {name, cpr} فقط من العميل (بلا توكن —
// يُعاد استخراجه هنا من fcmTokens مباشرة، لا يُوثَق بأي توكن قد يُرسله العميل نفسه)، يُخصّص
// العنوان/النص باسم كل مستلم إن وُجد {name}، ثم يُسلِّمها لـscheduleFCMQueueSend_ (fcmQueue.js).
//
// params: { recipients: [{name, cpr}], title, body, batchSize, perMessageDelaySec,
//   betweenBatchesSec, scheduledAt }
function prepareAndScheduleFcmBroadcast(userCpr, params) {
  var perm = hasExamPermission(userCpr);
  if (!perm.isAdmin) return { error: true, message: 'يلزم صلاحية الإدارة' };

  params = params || {};
  var recipients = Array.isArray(params.recipients) ? params.recipients : [];
  var title = String(params.title || '').trim();
  var body = String(params.body || '').trim();

  if (!title) return { error: true, message: 'عنوان الإشعار مطلوب' };
  if (!body) return { error: true, message: 'نص الإشعار مطلوب' };
  if (recipients.length < 1) return { error: true, message: 'لا يوجد مستلمون لإرسال الإشعار إليهم' };

  var rows = recipients.map(function (r) {
    var token = getFcmTokenForStudent_(r.cpr);
    if (!token) return null;
    var vars = { name: firstNameOnly_(r.name || '') };
    return {
      name: r.name || '',
      cpr: r.cpr || '',
      token: token,
      title: renderMessageTemplate_(title, vars),
      body: renderMessageTemplate_(body, vars)
    };
  }).filter(Boolean);

  if (rows.length < 1) return { error: true, message: 'لا يوجد من المستلمين المحدَّدين من لديه جهاز مُفعَّل حاليًا' };

  return scheduleFCMQueueSend_(rows, {
    batchSize: params.batchSize,
    perMessageDelaySec: params.perMessageDelaySec,
    betweenBatchesSec: params.betweenBatchesSec,
    scheduledAt: params.scheduledAt,
    sentBy: userCpr,
    templateKey: 'fcmBroadcast'
  });
}

// معالج طلب تسجيل جهاز جديد القادم من platform.html عبر doPost (action: 'saveFcmToken').
function handleSaveFcmTokenRequest_(body) {
  var cpr = String(body.studentId || '').trim();
  var token = String(body.token || '').trim();
  if (!cpr) return { status: 'error', message: 'الرقم الشخصي مطلوب' };
  if (!token) return { status: 'error', message: 'تعذّر الحصول على بيانات الجهاز' };
  var info = checkIsAlsoStudent(cpr);
  if (!info.isStudent) return { status: 'error', message: 'الرقم الشخصي غير مسجَّل لدينا' };
  saveStudentToken_(cpr, token);
  return { status: 'ok', message: 'تم تفعيل الإشعارات بنجاح لـ' + (info.name || 'الطالب') };
}
