// ===================================================================
// v2
// New authentication system: CPR + emailed one-time code, or email+password
// (password accounts are created/linked client-side via the Firebase SDK
// after a successful custom-token sign-in — this file never sees a password).
// ===================================================================

const AUTH_SHEET_NAMES = ['emp', 'students'];
const AUTH_OTP_TTL_SECONDS = 600; // 10 minutes
const AUTH_OTP_MAX_ATTEMPTS = 5;
// فترة انتظار قصيرة بين طلبَي رمز متتاليين لنفس الرقم الشخصي (بدل قفل 24 ساعة سابق)، بالإضافة
// إلى حدّ أقصى يومي للطلبات كخط دفاع احتياطي فقط ضد إساءة الاستخدام — غير ملحوظ في الاستخدام
// العادي. الحصة اليومية للبريد أصبحت 1500 (بعد الانتقال لنطاق Workspace خاص)، فلم تعد هناك
// حاجة فعلية لتوفير الحصة عبر تأجيل/تجاوز التحقق كما كان سابقًا.
const AUTH_OTP_COOLDOWN_SECONDS = 75;
const AUTH_OTP_DAILY_MAX = 10;
const AUTH_FIREBASE_API_KEY = 'AIzaSyAzOQqhYH2lZxM6Yv3Ui62TlB4Bw6m3zkg'; // same public Web API key already embedded in the client SDK config

// Firebase's email/password provider requires a globally-unique email per credential,
// but two different people (different CPRs) are allowed to share the same real email
// address (e.g. family members). So the password credential is never tied to the
// person's real email — it's tied to a synthetic, always-unique per-CPR address instead.
// The real email is only ever used to actually send messages (OTP codes, notifications).
function authCredentialEmail_(cpr) {
  return 'u' + String(cpr).trim() + '@basaer-login.internal';
}

/////////////////////////////////////////////////////////////////////
// One-time setup: run manually once from the Apps Script editor.
// Adds the emailVerified/authUid columns to emp + students if missing.
/////////////////////////////////////////////////////////////////////
function ensureAuthColumns() {
  const ss = SpreadsheetApp.openById(mainData);
  AUTH_SHEET_NAMES.forEach(function (name) {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const toAdd = ['emailVerified', 'authUid', 'hasPassword'].filter(function (col) {
      return headers.indexOf(col) === -1;
    });
    if (toAdd.length) {
      sh.getRange(1, sh.getLastColumn() + 1, 1, toAdd.length).setValues([toAdd]);
    }
  });
  return 'تم التأكد من أعمدة emailVerified و authUid و hasPassword في emp و students';
}

/////////////////////////////////////////////////////////////////////
// Sheet lookup helper
/////////////////////////////////////////////////////////////////////
function findPersonByCpr_(cpr) {
  const ss = SpreadsheetApp.openById(mainData);
  for (let i = 0; i < AUTH_SHEET_NAMES.length; i++) {
    const sheetName = AUTH_SHEET_NAMES[i];
    const sh = ss.getSheetByName(sheetName);
    if (!sh) continue;
    const lastRow = sh.getLastRow();
    const lastCol = sh.getLastColumn();
    if (lastRow < 2) continue;
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    const cprCol = headers.indexOf('cpr');
    if (cprCol === -1) continue;
    const mailCol = headers.indexOf('email');
    const emailVerifiedCol = headers.indexOf('emailVerified');
    const authUidCol = headers.indexOf('authUid');
    const hasPasswordCol = headers.indexOf('hasPassword');
    const manageCol = headers.indexOf('إدارة');
    const folderCol = headers.indexOf('folder');

    const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
    for (let r = 0; r < data.length; r++) {
      if (cprEquals_(data[r][cprCol], cpr)) {
        return {
          sheetName: sheetName,
          sheet: sh,
          rowNumber: r + 2,
          mailCol: mailCol,
          emailVerifiedCol: emailVerifiedCol,
          authUidCol: authUidCol,
          hasPasswordCol: hasPasswordCol,
          email: mailCol > -1 ? String(data[r][mailCol] || '').trim() : '',
          emailVerified: emailVerifiedCol > -1 ? !!data[r][emailVerifiedCol] : false,
          authUid: authUidCol > -1 ? String(data[r][authUidCol] || '').trim() : '',
          hasPassword: hasPasswordCol > -1 ? !!data[r][hasPasswordCol] : false,
          isManager: manageCol > -1 ? !!data[r][manageCol] : false,
          folder: folderCol > -1 ? String(data[r][folderCol] || '').trim() : ''
        };
      }
    }
  }
  return null;
}

/////////////////////////////////////////////////////////////////////
// Lightweight check used by the login page to decide which buttons to
// show as the user types their CPR — does not send anything.
/////////////////////////////////////////////////////////////////////
function checkCprStatus(cpr) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) return { found: false };
  const person = findPersonByCpr_(cpr);
  if (!person) return { found: false };
  return {
    found: true,
    emailVerified: !!person.emailVerified,
    hasPassword: !!person.hasPassword,
    maskedEmail: person.email ? maskEmail_(person.email) : ''
  };
}

/////////////////////////////////////////////////////////////////////
// Used right after a successful login for a non-employee, non-active-student
// account, to tell apart "registration was rejected" (folder === 'no') from
// "genuinely never registered" — these need very different messaging.
/////////////////////////////////////////////////////////////////////
function checkPersonFolderStatus(cpr) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) return { found: false };
  const person = findPersonByCpr_(cpr);
  if (!person) return { found: false };
  return { found: true, folder: person.folder || '' };
}

/////////////////////////////////////////////////////////////////////
// بديل getPersons() في فحص "رقم غير موجود بنظام الدخول" بصفحة الدخول (checkRegistrationEligibility
// بـauth-js.html): كانت الصفحة تستدعي getPersons() قبل أي مصادقة، فيصل جدول الطلاب كاملًا
// (أرقام شخصية، هواتف، بريد، تواريخ ميلاد، روابط بطاقات) لمتصفح أي زائر لمجرد فحص وجود رقم
// واحد. هذه لا تُرجع إلا نعم/لا، وبنفس شروط getPersons تمامًا: شيت students فقط، والطالب
// المرفوض (folder === 'no') مستثنى.
/////////////////////////////////////////////////////////////////////
function checkStudentRegistered(cpr) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) return { found: false };

  const sh = SpreadsheetApp.openById(mainData).getSheetByName('students');
  if (!sh || sh.getLastRow() < 2) return { found: false };

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const cprCol = headers.indexOf('cpr');
  const folderCol = headers.indexOf('folder');
  if (cprCol === -1) return { found: false };

  const rowCount = sh.getLastRow() - 1;
  const cprs = sh.getRange(2, cprCol + 1, rowCount, 1).getValues();
  const folders = folderCol > -1 ? sh.getRange(2, folderCol + 1, rowCount, 1).getValues() : null;
  for (let i = 0; i < rowCount; i++) {
    if (folders && folders[i][0] === 'no') continue;
    if (normalizeCpr_(cprs[i][0]) === cpr) return { found: true };
  }
  return { found: false };
}

/////////////////////////////////////////////////////////////////////
// إرسال آمن موحّد لرمز تحقق مكوّن من 6 أرقام: يُولَّد ويُخزَّن ويُتحقَّق منه بالكامل على
// الخادم (CacheService)، مع فترة انتظار قصيرة بين الطلبات المتتالية وحدّ أقصى يومي احتياطي.
// يُستخدم من requestLoginCode (تسجيل الدخول/نسيت كلمة المرور) ومن requestRegistrationOtp
// (التسجيل وتغيير البريد في الملف الشخصي) — نفس الآلية الآمنة في كل موضع، بدل تكرارها بطرق
// مختلفة (كان التسجيل سابقًا يُولّد الرمز ويُقارنه في المتصفح نفسه، وهو أضعف أمنيًا).
/////////////////////////////////////////////////////////////////////
function sendOtpEmail_(cpr, email, purpose) {
  const props = PropertiesService.getScriptProperties();
  const cooldownKey = 'otpLastSent_' + cpr;
  const lastSent = parseInt(props.getProperty(cooldownKey) || '0', 10);
  const elapsedSec = (Date.now() - lastSent) / 1000;
  if (lastSent && elapsedSec < AUTH_OTP_COOLDOWN_SECONDS) {
    return { ok: false, cooldown: true, retryAfterSeconds: Math.ceil(AUTH_OTP_COOLDOWN_SECONDS - elapsedSec) };
  }

  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const dayKey = 'otpDay_' + cpr;
  const countKey = 'otpCount_' + cpr;
  const count = props.getProperty(dayKey) === today ? parseInt(props.getProperty(countKey) || '0', 10) : 0;
  if (count >= AUTH_OTP_DAILY_MAX) {
    return { ok: false, message: 'تجاوزت الحد الأقصى لطلبات رمز التحقق اليوم، يرجى المحاولة غدًا أو التواصل مع الإدارة.' };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const subject = purpose === 'login'
    ? 'رمز تسجيل الدخول - أكاديمية بصائر'
    : 'رمز التحقق من البريد الإلكتروني - أكاديمية بصائر';

  try {
    // نستخدم GmailApp (وليس MailApp) عمدًا: يُرسل فعليًا كحساب Gmail/Workspace نفسه (نفس مسار
    // الإرسال اليدوي من واجهة Gmail الذي تأكّدنا من وصوله)، بخلاف MailApp التي تمر عبر خدمة
    // بريد Apps Script العامة الأقل موثوقية في وصول رسائل تشبه رموز التحقق.
    // القالب المصمَّم (basair-theme-studio) بدل HTML مباشر — راجع emailTemplates.js.
    GmailApp.sendEmail(email, subject, 'رمز التحقق الخاص بك: ' + code, {
      name: 'بصائر للعلوم الشرعية',
      htmlBody: buildBasairOtpEmail_(code, purpose),
      inlineImages: { basairLogo: getBasairLogoBlob_() }
    });
  } catch (err) {
    // لا نُخزّن الرمز أو وقت الإرسال إن فشل الإرسال، حتى لا نمنع محاولة جديدة لاحقًا دون داعٍ
    var msgStr = String(err && err.message || err);
    var quotaExceeded = /invoked too many times|quota/i.test(msgStr);
    return {
      ok: false,
      quotaExceeded: quotaExceeded,
      message: quotaExceeded
        ? 'تعذّر إرسال رمز التحقق حاليًا بسبب امتلاء الحصة اليومية لإرسال البريد. يرجى المحاولة لاحقًا.'
        : 'تعذّر إرسال رمز التحقق: ' + msgStr
    };
  }

  CacheService.getScriptCache().put('otp_' + cpr, JSON.stringify({ code: code, email: email, attempts: 0 }), AUTH_OTP_TTL_SECONDS);
  props.setProperty(cooldownKey, String(Date.now()));
  props.setProperty(dayKey, today);
  props.setProperty(countKey, String(count + 1));

  return { ok: true, maskedEmail: maskEmail_(email), cooldownSeconds: AUTH_OTP_COOLDOWN_SECONDS };
}

/////////////////////////////////////////////////////////////////////
// Step 1: request a login code for a CPR
/////////////////////////////////////////////////////////////////////
function requestLoginCode(cpr, emailInput) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) {
    return { ok: false, message: 'يرجى إدخال رقم شخصي أو هوية دخول صحيحة.' };
  }

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, notFound: true };
  }

  let targetEmail;
  if (person.emailVerified && person.email) {
    targetEmail = person.email;
  } else {
    targetEmail = String(emailInput || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
      return { ok: false, needsEmail: true, prefillEmail: person.email || '' };
    }
  }

  return sendOtpEmail_(cpr, targetEmail, 'login');
}

/////////////////////////////////////////////////////////////////////
// رمز تحقق البريد أثناء التسجيل أو تعديل البريد من الملف الشخصي — نفس آلية requestLoginCode
// الآمنة (توليد وتخزين على الخادم)، بدل الآلية السابقة التي كانت تُولّد الرمز في المتصفح.
/////////////////////////////////////////////////////////////////////
function requestRegistrationOtp(cpr, email) {
  cpr = String(cpr || '').trim();
  email = String(email || '').trim();
  if (!cpr) {
    return { ok: false, message: 'تعذّر التعرّف على الحساب، يرجى إعادة تحميل الصفحة.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'يرجى إدخال بريد إلكتروني صحيح.' };
  }
  return sendOtpEmail_(cpr, email, 'registration');
}

/////////////////////////////////////////////////////////////////////
// تحقق من رمز التسجيل — يقرأ نفس الرمز المُخزَّن عبر sendOtpEmail_، لكن لا يُصدر أي رمز دخول
// (Firebase token)؛ فقط يؤكد ملكية البريد قبل إتمام نموذج التسجيل العادي.
/////////////////////////////////////////////////////////////////////
function verifyRegistrationOtp(cpr, code) {
  cpr = String(cpr || '').trim();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'otp_' + cpr;
  const raw = cache.get(cacheKey);
  if (!raw) {
    return { ok: false, message: 'انتهت صلاحية الرمز، يرجى طلب رمز جديد.' };
  }

  const data = JSON.parse(raw);
  if (data.attempts >= AUTH_OTP_MAX_ATTEMPTS) {
    cache.remove(cacheKey);
    return { ok: false, message: 'لقد تجاوزت عدد المحاولات المسموح بها، يرجى طلب رمز جديد.' };
  }
  if (String(code || '').trim() !== data.code) {
    data.attempts += 1;
    cache.put(cacheKey, JSON.stringify(data), AUTH_OTP_TTL_SECONDS);
    return { ok: false, message: 'الرمز غير صحيح، يرجى المحاولة مرة أخرى.' };
  }
  cache.remove(cacheKey);
  return { ok: true, email: data.email };
}

/////////////////////////////////////////////////////////////////////
// تسجيل دخول عبر بريد تحقّق منه مزوّد OAuth فعليًا (جوجل أو ياهو، نفس آلية "تحقّق سريع" في
// نموذج التسجيل — الاسم تاريخي، لكن الدالة لا تفترض مزوّدًا بعينه). تحقّق حقيقي 100% فنُعلّم
// البريد كمُتحقَّق منه بثقة، بشرط أن يطابق البريد المُتحقَّق منه البريدَ المسجَّل لدينا لهذا
// الرقم الشخصي بالذات — وإلا فلن يتمكّن أي شخص من "تسجيل الدخول بحسابه الخاص" مدّعيًا هوية
// رقم شخصي آخر.
/////////////////////////////////////////////////////////////////////
function loginWithGoogleVerifiedEmail(cpr, verifiedEmail) {
  cpr = String(cpr || '').trim();
  verifiedEmail = String(verifiedEmail || '').trim().toLowerCase();

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذر العثور على البيانات، يرجى التواصل مع الإدارة.' };
  }
  if (!person.email || person.email.trim().toLowerCase() !== verifiedEmail) {
    return { ok: false, message: 'البريد المرتبط بحساب جوجل هذا لا يطابق البريد المسجَّل لديك. يرجى استخدام رمز التحقق بدلًا من ذلك، أو التواصل مع الإدارة لتحديث بريدك.' };
  }

  const uid = person.authUid || ('u' + cpr);
  if (person.emailVerifiedCol > -1 && !person.emailVerified) {
    person.sheet.getRange(person.rowNumber, person.emailVerifiedCol + 1).setValue(true);
  }
  if (person.authUidCol > -1 && !person.authUid) {
    person.sheet.getRange(person.rowNumber, person.authUidCol + 1).setValue(uid);
  }

  return {
    ok: true,
    token: mintFirebaseCustomToken_(uid),
    isEmployee: person.sheetName === 'emp',
    email: person.email,
    hasPassword: !!person.hasPassword
  };
}

/////////////////////////////////////////////////////////////////////
// "تجاوز التحقق من البريد الإلكتروني إلى وقت لاحق" — بطلب صريح من المستخدم، وبعد تنبيهه صراحةً
// أنها تُعيد فتح نفس فئة الثغرة التي أُصلحت سابقًا في هذا المشروع (رقم شخصي وحده كإثبات هوية):
// أي شخص يعرف/يخمّن رقمًا شخصيًا صحيحًا يستطيع دخول ذلك الحساب مؤقتًا وإنشاء كلمة مرور جديدة له
// دون أي إثبات لملكية البريد المسجَّل. القرار مقصود من المستخدم (رفع سهولة الوصول لحساب فُقد
// الوصول لبريده)، لا خطأ — لكن نُخفّف الأثر قدر الإمكان بتنبيه أمني فوري لصاحب البريد الحقيقي
// (لا حجب: البريد قد يكون هو بالذات من لا يصله، فلا نعتمد عليه كبوّابة، فقط كإشعار).
// لا تُعلَّم emailVerified هنا إطلاقًا (بخلاف loginWithGoogleVerifiedEmail/verifyLoginCode) —
// يبقى بريده غير مُتحقَّق منه رسميًا في النظام حتى يتحقق منه فعليًا لاحقًا من صفحته الشخصية.
/////////////////////////////////////////////////////////////////////
function skipEmailVerificationLogin(cpr) {
  cpr = String(cpr || '').trim();
  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذر العثور على البيانات، يرجى التواصل مع الإدارة.' };
  }

  const uid = person.authUid || ('u' + cpr);
  if (person.authUidCol > -1 && !person.authUid) {
    person.sheet.getRange(person.rowNumber, person.authUidCol + 1).setValue(uid);
  }

  if (person.email) {
    try {
      GmailApp.sendEmail(person.email, 'تنبيه أمني بشأن حسابك - أكاديمية بصائر',
        'تم إنشاء كلمة مرور جديدة لحسابك دون التحقق من بريدك الإلكتروني. إذا لم تكن أنت من قام بهذا، يرجى التواصل مع الإدارة فورًا.', {
        name: 'بصائر للعلوم الشرعية',
        htmlBody: buildBasairEmailShell_({
          kicker: 'تنبيه أمني',
          heading: 'تم الدخول إلى حسابك دون التحقق من البريد',
          bodyHtml: basairEmailParagraph_('تم للتو تجاوز خطوة التحقق من بريدك الإلكتروني، وسيُنشئ الداخل كلمة مرور جديدة لحسابك.') +
            basairEmailNoticeBox_('إذا لم تكن أنت من قام بهذا الإجراء، يرجى التواصل مع إدارة الأكاديمية فورًا عبر واتساب أو البريد الإلكتروني.')
        }),
        inlineImages: { basairLogo: getBasairLogoBlob_() }
      });
    } catch (err) {
      // فشل إرسال التنبيه لا يمنع الدخول نفسه — القرار مسؤولية المستخدم لا الطالب هنا
    }
  }

  return {
    ok: true,
    token: mintFirebaseCustomToken_(uid),
    isEmployee: person.sheetName === 'emp',
    email: person.email,
    hasPassword: !!person.hasPassword
  };
}

/////////////////////////////////////////////////////////////////////
// مسار احتياطي لنتيجة صفحة تحقّق OAuth الوسيطة (website/google-signin-relay.html) عبر doPost
// (code.js) بدل الاعتماد فقط على postMessage لـwindow.opener — راجع مناقشات مشابهة في نفس
// الجلسة عن مشكلة تسجيل QR: شكوى طالب متكررة "يتحقق من البريد ثم يعيد من البداية" رجّحت أن صفحات
// جوجل لتسجيل الدخول قد تقطع ارتباط opener بين النافذة الوسيطة والصفحة الأصلية أثناء
// signInWithRedirect (الذي استُخدم لحل مشكلة حجب popup داخل popup على الجوال) — فتصل النتيجة
// للنافذة الوسيطة فعليًا، لكنها لا تستطيع إخبار الصفحة الأصلية بها. الحل: النافذة الوسيطة ترسل
// النتيجة أيضًا (بمحاولة موازية، بلا اعتماد كامل على أيهما ينجح) لهذا المسار، وتُستطلَع (polling)
// من الصفحة الأصلية عبر checkOauthVerifyResult كخطة بديلة أيًّا منهما وصل أولًا يُعتمَد.
/////////////////////////////////////////////////////////////////////
function handleOauthVerifyResult_(body) {
  if (!body || !body.verifyToken) return { status: 'error', message: 'بيانات غير مكتملة' };
  CacheService.getScriptCache().put('oauthVerify_' + body.verifyToken, JSON.stringify({
    ok: !!body.ok,
    email: body.email ? String(body.email).trim() : '',
    message: body.message || '',
    provider: body.provider || ''
  }), 300); // 5 دقائق تكفي بكثير لإتمام الاستطلاع من الصفحة الأصلية
  return { status: 'ok' };
}

// تُستهلَك مرة واحدة فقط (تُحذف فور قراءتها) لتفادي إعادة استخدام نفس النتيجة أكثر من مرة.
function checkOauthVerifyResult(verifyToken) {
  if (!verifyToken) return null;
  var cache = CacheService.getScriptCache();
  var key = 'oauthVerify_' + verifyToken;
  var raw = cache.get(key);
  if (!raw) return null;
  cache.remove(key);
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/////////////////////////////////////////////////////////////////////
// Step 2: verify the code, mint a Firebase custom token, flag the person
/////////////////////////////////////////////////////////////////////
function verifyLoginCode(cpr, code) {
  cpr = String(cpr || '').trim();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'otp_' + cpr;
  const raw = cache.get(cacheKey);
  if (!raw) {
    return { ok: false, message: 'انتهت صلاحية الرمز، يرجى طلب رمز جديد.' };
  }

  const data = JSON.parse(raw);
  if (data.attempts >= AUTH_OTP_MAX_ATTEMPTS) {
    cache.remove(cacheKey);
    return { ok: false, message: 'لقد تجاوزت عدد المحاولات المسموح بها، يرجى طلب رمز جديد.' };
  }
  if (String(code || '').trim() !== data.code) {
    data.attempts += 1;
    cache.put(cacheKey, JSON.stringify(data), AUTH_OTP_TTL_SECONDS);
    return { ok: false, message: 'الرمز غير صحيح، يرجى المحاولة مرة أخرى.' };
  }
  cache.remove(cacheKey);

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذر العثور على البيانات، يرجى التواصل مع الإدارة.' };
  }

  const uid = person.authUid || ('u' + cpr);
  const finalEmail = data.email || person.email;
  if (person.emailVerifiedCol > -1 && !person.emailVerified) {
    person.sheet.getRange(person.rowNumber, person.emailVerifiedCol + 1).setValue(true);
  }
  if (person.authUidCol > -1 && !person.authUid) {
    person.sheet.getRange(person.rowNumber, person.authUidCol + 1).setValue(uid);
  }
  if (person.mailCol > -1 && data.email && data.email !== person.email) {
    person.sheet.getRange(person.rowNumber, person.mailCol + 1).setValue(data.email);
  }

  return {
    ok: true,
    token: mintFirebaseCustomToken_(uid),
    isEmployee: person.sheetName === 'emp',
    email: finalEmail,
    hasPassword: !!person.hasPassword
  };
}

/////////////////////////////////////////////////////////////////////
// CPR + password login. The password is verified here (server-side,
// via the Identity Toolkit REST API) so the client never needs to know
// the account's email address; a Firebase custom token is minted on
// success, exactly like the OTP path.
/////////////////////////////////////////////////////////////////////
function loginWithPassword(cpr, password) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) {
    return { ok: false, message: 'يرجى إدخال رقم شخصي أو هوية دخول صحيحة.' };
  }
  if (!password) {
    return { ok: false, message: 'يرجى إدخال كلمة المرور.' };
  }

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, notFound: true };
  }
  if (!person.hasPassword || !person.email) {
    return { ok: false, message: 'لم تُنشأ كلمة مرور لهذا الحساب بعد، يرجى تسجيل الدخول عبر إرسال رمز التحقق أولًا.' };
  }

  const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + AUTH_FIREBASE_API_KEY;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ email: authCredentialEmail_(cpr), password: password, returnSecureToken: true }),
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());

  if (result.error) {
    const errCode = (result.error.message || '');
    let message = 'تعذّر تسجيل الدخول، يرجى المحاولة مرة أخرى.';
    if (errCode.indexOf('INVALID_PASSWORD') > -1 || errCode.indexOf('INVALID_LOGIN_CREDENTIALS') > -1) {
      message = 'كلمة المرور غير صحيحة.';
    } else if (errCode.indexOf('TOO_MANY_ATTEMPTS_TRY_LATER') > -1) {
      message = 'محاولات كثيرة، يرجى الانتظار قليلًا ثم إعادة المحاولة.';
    } else if (errCode.indexOf('EMAIL_NOT_FOUND') > -1 || errCode.indexOf('USER_DISABLED') > -1) {
      message = 'تعذّر العثور على الحساب، يرجى التواصل مع الإدارة.';
    }
    return { ok: false, message: message };
  }

  const uid = person.authUid || ('u' + cpr);
  return {
    ok: true,
    token: mintFirebaseCustomToken_(uid),
    isEmployee: person.sheetName === 'emp',
    email: person.email
  };
}

/////////////////////////////////////////////////////////////////////
// Sets (creates or resets) a person's login password entirely server-side,
// via the Identity Toolkit Admin REST API. This avoids the Firebase client
// SDK's linkWithCredential/updatePassword calls, which require a "recent
// login" that a custom-token session can lose by the time the user finishes
// typing a new password in the dialog (auth/requires-recent-login), and
// which also depend on the client holding a live, unexpired session.
/////////////////////////////////////////////////////////////////////
function setPassword(cpr, password) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) {
    return { ok: false, message: 'رقم شخصي غير صحيح.' };
  }
  if (!password || password.length < 6) {
    return { ok: false, message: 'يجب أن تتكوّن كلمة المرور من ٦ أحرف على الأقل.' };
  }

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };
  }
  if (person.hasPasswordCol === -1) {
    return { ok: false, message: 'عمود hasPassword غير موجود، شغّل ensureAuthColumns أولًا.' };
  }

  const uid = person.authUid || ('u' + cpr);

  try {
    setUserPasswordAdmin_(uid, cpr, password);
  } catch (err) {
    return { ok: false, message: 'تعذّر حفظ كلمة المرور: ' + (err && err.message ? err.message : err) };
  }

  if (person.authUidCol > -1 && !person.authUid) {
    person.sheet.getRange(person.rowNumber, person.authUidCol + 1).setValue(uid);
  }
  person.sheet.getRange(person.rowNumber, person.hasPasswordCol + 1).setValue(true);

  return { ok: true };
}

/////////////////////////////////////////////////////////////////////
// Admin-level OAuth2 access token for the Firebase service account
// (JWT-bearer flow), cached for reuse until shortly before it expires.
/////////////////////////////////////////////////////////////////////
function getFirebaseAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('fb_admin_access_token');
  if (cached) return cached;

  const sa = getFirebaseServiceAccount_();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  const signingInput = base64UrlEncode_(JSON.stringify(header)) + '.' + base64UrlEncode_(JSON.stringify(claimSet));
  const signature = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  const jwt = signingInput + '.' + base64UrlEncode_(signature);

  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (result.error) {
    throw new Error(result.error_description || result.error);
  }

  cache.put('fb_admin_access_token', result.access_token, Math.min(result.expires_in - 60, 3500));
  return result.access_token;
}

function setUserPasswordAdmin_(uid, cpr, newPassword) {
  const accessToken = getFirebaseAccessToken_();
  const response = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:update', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({
      localId: uid,
      email: authCredentialEmail_(cpr),
      password: newPassword,
      emailVerified: true
    }),
    muteHttpExceptions: true
  });
  const result = JSON.parse(response.getContentText());
  if (result.error) {
    throw new Error(result.error.message || 'unknown error');
  }
  return true;
}

/////////////////////////////////////////////////////////////////////
// تغيير كلمة المرور من "الملف الشخصي" (بخلاف setPassword التي تُستخدم أيضًا للإنشاء الأول/
// إعادة التعيين عبر رمز البريد بلا كلمة مرور حالية) — إن كان للحساب كلمة مرور فعلًا، نتحقق
// منها أولًا عبر نفس نداء signInWithPassword المستخدَم في loginWithPassword، ثم نُفوّض
// لـsetPassword. إن لم تكن له كلمة مرور بعد، هذا إنشاء أول فلا حاجة للتحقق من شيء.
/////////////////////////////////////////////////////////////////////
function changePassword(cpr, currentPassword, newPassword) {
  cpr = String(cpr || '').trim();
  if (!isValidPersonId(cpr)) {
    return { ok: false, message: 'رقم شخصي غير صحيح.' };
  }

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };
  }

  if (person.hasPassword) {
    if (!currentPassword) {
      return { ok: false, message: 'يرجى إدخال كلمة المرور الحالية.' };
    }
    const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + AUTH_FIREBASE_API_KEY;
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ email: authCredentialEmail_(cpr), password: currentPassword, returnSecureToken: true }),
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText());
    if (result.error) {
      return { ok: false, message: 'كلمة المرور الحالية غير صحيحة.' };
    }
  }

  return setPassword(cpr, newPassword);
}

/////////////////////////////////////////////////////////////////////
// تأكيد تغيير البريد الإلكتروني من "الملف الشخصي" — يتحقق من رمز أُرسل عبر
// requestRegistrationOtp(cpr, newEmail) بواسطة verifyRegistrationOtp نفسها (لا تُصدر رمز دخول)،
// ثم يكتب البريد الجديد وemailVerified=true بنفسه (verifyRegistrationOtp لا تلمس الشيت إطلاقًا،
// بخلاف مسارَي الدخول اللذين يفعلان ذلك تلقائيًا).
/////////////////////////////////////////////////////////////////////
function confirmProfileEmail(cpr, code) {
  cpr = String(cpr || '').trim();
  const result = verifyRegistrationOtp(cpr, code);
  if (!result || !result.ok) return result || { ok: false, message: 'تعذّر التحقق من الرمز.' };

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };
  }
  if (person.mailCol > -1) person.sheet.getRange(person.rowNumber, person.mailCol + 1).setValue(result.email);
  if (person.emailVerifiedCol > -1) person.sheet.getRange(person.rowNumber, person.emailVerifiedCol + 1).setValue(true);

  return { ok: true, email: result.email };
}

/////////////////////////////////////////////////////////////////////
// ربط بريد تحقّق منه مزوّد OAuth فعليًا (جوجل/مايكروسوفت) من "الملف الشخصي" — بخلاف
// loginWithGoogleVerifiedEmail (تسجيل دخول، تشترط تطابق البريد المُتحقَّق منه مع البريد
// المسجَّل مسبقًا لمنع انتحال هوية)، هنا المستخدم موثَّق الجلسة أصلًا (داخل صفحته)، فتحقّق
// OAuth الحقيقي كافٍ وحده لقبول البريد الجديد وتوثيقه مباشرة، سواء طابق القديم أم كان مختلفًا.
/////////////////////////////////////////////////////////////////////
function linkVerifiedEmailToProfile(cpr, verifiedEmail) {
  cpr = String(cpr || '').trim();
  verifiedEmail = String(verifiedEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(verifiedEmail)) {
    return { ok: false, message: 'بريد إلكتروني غير صالح.' };
  }

  const person = findPersonByCpr_(cpr);
  if (!person) {
    return { ok: false, message: 'تعذّر العثور على بيانات هذا الحساب.' };
  }
  if (person.mailCol > -1) person.sheet.getRange(person.rowNumber, person.mailCol + 1).setValue(verifiedEmail);
  if (person.emailVerifiedCol > -1) person.sheet.getRange(person.rowNumber, person.emailVerifiedCol + 1).setValue(true);

  return { ok: true, email: verifiedEmail };
}

/////////////////////////////////////////////////////////////////////
// Firebase custom token minting (RS256 JWT signed with the service account)
/////////////////////////////////////////////////////////////////////
function getFirebaseServiceAccount_() {
  const raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT غير مُعرّف في Script Properties');
  return JSON.parse(raw);
}

function base64UrlEncode_(input) {
  const bytes = typeof input === 'string' ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function mintFirebaseCustomToken_(uid, claims) {
  const sa = getFirebaseServiceAccount_();
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    uid: String(uid)
  };
  if (claims) payload.claims = claims;

  const signingInput = base64UrlEncode_(JSON.stringify(header)) + '.' + base64UrlEncode_(JSON.stringify(payload));
  const signature = Utilities.computeRsaSha256Signature(signingInput, sa.private_key);
  return signingInput + '.' + base64UrlEncode_(signature);
}

/////////////////////////////////////////////////////////////////////
function maskEmail_(email) {
  const parts = String(email).split('@');
  if (parts.length !== 2) return email;
  const visible = parts[0].slice(0, Math.min(2, parts[0].length));
  return visible + '***@' + parts[1];
}
