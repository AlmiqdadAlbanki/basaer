'use strict';

// Header rows the server code expects, per logical spreadsheet and sheet.
// Mirrors the seedSheet(...) calls in tools/seed.js (seed.js runs on load, so it
// cannot be required). Keep both in step when a seeded header row changes.

const studentHeaders = [
  'Timestamp', 'cpr', 'name', 'gender', 'dob', 'nationality', 'phone', 'email',
  'block', 'area', 'pastStudies', 'folder', 'card', 'mazhab', 'code',
  'class0', 'class1', 'class2', 'class3', 'level', 'past', 'congrates',
  'emailVerified', 'authUid', 'hasPassword', 'outsideBahrain', 'studyType', 'avatarUrl',
];

const empHeaders = [
  'cpr', 'name', 'phone', 'email', 'job', 'code', 'gender',
  'تسجيل', 'تسميع', 'اختبار', 'إدارة', 'متابعة', 'محاضر', 'superAdmin',
  'authUid', 'hasPassword', 'emailVerified', 'avatarUrl',
];

const expectedHeaders = {
  mainData: {
    students: studentHeaders,
    emp: empHeaders,
    lecAttend: ['Timestamp', 'cpr', 'name', 'gender', 'study'],
  },
  refID: {
    main: ['registration', 'logo', 'bag', 'whatsApp', 'whatsAppName', 'whatsAppActive'],
    matns: ['id', 'المستوى', 'الورد', 'الكتاب / المتن', 'من', 'إلى', 'عدد الأوراد', 'عدد الصفحات', 'عدد الأبيات'],
    announce: ['time', 'description', 'link'],
    rules: ['exam', 'level', 'exam_id', 'questionsCount', 'duration', 'passMark'],
    questions: ['#', 'الكتاب / المتن', 'نموذج', 'المرحلة', 'السؤال', 'answer-1', 'answer-2', 'answer-3', 'answer-4', 'answer-5', 'الجواب الصحيح'],
  },
  attendanceData: {
    attendance: ['date/time', 'id', 'cpr', 'name', 'by', 'level'],
  },
  answersData: {
    answers: ['time', 'cpr', 'exam', 'matn', 'level', 'result'],
    stWorks: ['cpr', 'name', 'gender', 'stWorks', 'url', 'notes', 'certificate'],
  },
  dectationData: {
    motonRates: ['طابع زمني', 'اسم الطالب', 'المتن', 'الورد', 'الدرجة', 'student_Cpr', 'responsible', 'code', 'level'],
  },
};

module.exports = { expectedHeaders };
