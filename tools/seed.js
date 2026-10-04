'use strict';

// Seeds a local database with fake-but-shaped data so the app runs end to end
// without the real spreadsheets. Column names match what the server code looks
// up by header (verified against the readers in dataGet.js / auth.js). Sheets
// that the code auto-creates (stages, madhabs, and the various ensure*Sheet_
// targets) are left out on purpose and appear on first use.
//
// Spreadsheet IDs mirror the constants in gas/code.js so the shim opens the
// same logical spreadsheets the code names.

const path = require('path');
const { Storage } = require('../server/storage.js');
const { IdentityService } = require('../server/auth/identity-service.js');

// Shared demo password for every seeded account that has one.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Test@1234';
const credEmail = (cpr) => 'u' + cpr + '@basaer-login.internal';

const IDS = {
  mainData: '1Y3zNCw4i3VmNdj3BjhkerpzIV8VijOVfAwY9_ixN8ic',
  attendanceData: '1TjNcFeccyK9BhPBbpfx8cZqPvJbJtSfgptse_fahg1g',
  answersData: '18uSjZYwLzY5O5XlzL46SwAELnrTwzILHs3fzq0x58ok',
  dectationData: '1qs50ANDMENyGVPxet2S0keRZ2Cxur_jSAj2pMY4Mojo',
  refID: '1L-VXGGxNX-4th2ytpTC7YsVo1p3xAzc-JLmoGdpIdgo',
  archiveData: '1RGgPD6r44RCnnGQFlxj9603bu1E-D6YaIVCJSySCxNs',
};

const DB_PATH = process.env.BASAER_DB || path.join(__dirname, '..', 'data', 'basaer.sqlite');

function seedSheet(storage, ss, name, headers, rows) {
  storage.ensureSpreadsheet(ss);
  if (!storage.sheetExists(ss, name)) storage.insertSheet(ss, name);
  const grid = [headers.slice()];
  for (const r of rows) grid.push(r.slice());
  storage.saveGrid(ss, name, grid);
}

function run() {
  const storage = new Storage(DB_PATH);

  // --- mainData / students ---------------------------------------------------
  // Headers are the union the readers reference (getPersons, findPersonByCpr_,
  // profile and residency columns).
  const studentHeaders = [
    'Timestamp', 'cpr', 'name', 'gender', 'dob', 'nationality', 'phone', 'email',
    'block', 'area', 'pastStudies', 'folder', 'card', 'mazhab', 'code',
    'class0', 'class1', 'class2', 'class3', 'level', 'past', 'congrates',
    'emailVerified', 'authUid', 'hasPassword', 'outsideBahrain', 'studyType', 'avatarUrl',
  ];
  const now = new Date();
  const student = (cpr, name, gender, email, extra = {}) => {
    const row = new Array(studentHeaders.length).fill('');
    const set = (h, v) => { row[studentHeaders.indexOf(h)] = v; };
    set('Timestamp', now);
    set('cpr', cpr);
    set('name', name);
    set('gender', gender);
    set('dob', new Date('2000-01-01T00:00:00Z'));
    set('nationality', 'بحريني');
    set('phone', '97333000000');
    set('email', email);
    set('block', '321');
    set('area', 'المنامة');
    set('folder', extra.folder || 'https://drive.google.com/drive/folders/SEED');
    set('card', 'https://drive.google.com/file/d/SEED/view');
    set('mazhab', 'المذهب الشافعي');
    set('level', extra.level != null ? extra.level : 0);
    set('emailVerified', extra.emailVerified !== false);
    set('authUid', 'u' + cpr);
    set('hasPassword', !!extra.hasPassword);
    set('outsideBahrain', false);
    set('studyType', 'حضوري');
    return row;
  };
  seedSheet(storage, IDS.mainData, 'students', studentHeaders, [
    student('001234567', 'عبد الله الطالب', 'ذكر', 'student1@example.com', { level: 1, hasPassword: true }),
    student('002345678', 'فاطمة الطالبة', 'أنثى', 'student2@example.com', { level: 0 }),
    student('003456789', 'محمد المتعلم', 'ذكر', 'student3@example.com', { level: 2, hasPassword: true }),
  ]);

  // --- mainData / emp (staff with permission columns) ------------------------
  const empHeaders = [
    'cpr', 'name', 'phone', 'email', 'job', 'code', 'gender',
    'تسجيل', 'تسميع', 'اختبار', 'إدارة', 'متابعة', 'محاضر', 'superAdmin',
    'authUid', 'hasPassword', 'emailVerified', 'avatarUrl',
  ];
  const staff = (cpr, name, email, perms = {}) => {
    const row = new Array(empHeaders.length).fill('');
    const set = (h, v) => { row[empHeaders.indexOf(h)] = v; };
    set('cpr', cpr); set('name', name); set('email', email); set('gender', 'ذكر');
    set('job', perms.job || 'متعاون');
    set('تسجيل', !!perms.registration);
    set('تسميع', !!perms.dictation);
    set('اختبار', !!perms.exam);
    set('إدارة', !!perms.manage);
    set('متابعة', !!perms.followUp);
    set('محاضر', !!perms.lecturer);
    set('superAdmin', !!perms.superAdmin);
    set('authUid', 'u' + cpr);
    set('hasPassword', !!perms.hasPassword);
    set('emailVerified', true);
    return row;
  };
  seedSheet(storage, IDS.mainData, 'emp', empHeaders, [
    staff('100000001', 'المدير العام', 'admin@example.com', { manage: true, exam: true, superAdmin: true, hasPassword: true, job: 'مدير' }),
    staff('100000002', 'مُعِدّ الاختبارات', 'editor@example.com', { exam: true, hasPassword: true, job: 'مُعِدّ' }),
    staff('100000003', 'المسمِّع', 'teacher@example.com', { dictation: true, hasPassword: true, job: 'مسمِّع' }),
  ]);

  // --- refID / main (global flags + logos; ensure* columns self-add) ---------
  const mainHeaders = ['registration', 'logo', 'bag', 'whatsApp', 'whatsAppName', 'whatsAppActive'];
  seedSheet(storage, IDS.refID, 'main', mainHeaders, [
    [true, 'https://example.com/logo.png', 'https://example.com/bag', 'SEED_FONNTE_TOKEN', 'basaer', true],
  ]);

  // --- refID / matns (recitation catalogue) ----------------------------------
  const matnHeaders = ['id', 'المستوى', 'الورد', 'الكتاب / المتن', 'من', 'إلى', 'عدد الأوراد', 'عدد الصفحات', 'عدد الأبيات'];
  seedSheet(storage, IDS.refID, 'matns', matnHeaders, [
    ['m1', 0, 1, 'الأربعون النووية', 1, 42, 1, 10, 0],
    ['m2', 1, 1, 'عمدة الأحكام', 1, 100, 1, 50, 0],
  ]);

  // --- refID / announce ------------------------------------------------------
  seedSheet(storage, IDS.refID, 'announce', ['time', 'description', 'link'], [
    [now, 'مرحبًا بكم في منصة بصائر', 'https://basaerbh.com'],
  ]);

  // --- refID / rules (exam definitions) --------------------------------------
  // Not auto-created by the readers; seed one example exam. The exam-management
  // code backfills its own extra columns (exam_id, archived, retakeOpen, ...).
  seedSheet(storage, IDS.refID, 'rules', ['exam', 'level', 'exam_id', 'questionsCount', 'duration', 'passMark'], [
    ['اختبار الأربعين النووية', 0, 'exam_demo_1', 10, 30, 50],
  ]);

  // --- refID / questions (the demo exam's question bank) ---------------------
  // ensureQuestionManagementColumns_ throws if the core columns are missing, so
  // this exact header set is required. Three questions, form ("نموذج") 1,
  // keyed to the demo exam by its name + level.
  const qHeaders = ['#', 'الكتاب / المتن', 'نموذج', 'المرحلة', 'السؤال', 'answer-1', 'answer-2', 'answer-3', 'answer-4', 'answer-5', 'الجواب الصحيح'];
  const q = (n, text, a1, a2, a3, correct) => [n, 'اختبار الأربعين النووية', 1, 0, text, a1, a2, a3, '', '', correct];
  seedSheet(storage, IDS.refID, 'questions', qHeaders, [
    q(1, 'كم عدد أحاديث الأربعين النووية؟', 'أربعون', 'اثنان وأربعون', 'خمسون', 'اثنان وأربعون'),
    q(2, 'من مؤلف الأربعين النووية؟', 'الإمام النووي', 'الإمام البخاري', 'الإمام مسلم', 'الإمام النووي'),
    q(3, 'ما أول حديث في الأربعين؟', 'إنما الأعمال بالنيات', 'الدين النصيحة', 'بُني الإسلام على خمس', 'إنما الأعمال بالنيات'),
  ]);

  // --- Empty data sheets that readers open (header row only) -----------------
  // These readers do not auto-create their sheet, so seed a header row to make
  // them return [] instead of throwing on a missing sheet.
  seedSheet(storage, IDS.attendanceData, 'attendance', ['date/time', 'id', 'cpr', 'name', 'by', 'level'], []);
  seedSheet(storage, IDS.answersData, 'answers', ['time', 'cpr', 'exam', 'matn', 'level', 'result'], []);
  seedSheet(storage, IDS.answersData, 'stWorks', ['cpr', 'name', 'gender', 'stWorks', 'url', 'notes', 'certificate'], []);
  seedSheet(storage, IDS.mainData, 'lecAttend', ['Timestamp', 'cpr', 'name', 'gender', 'study'], []);
  seedSheet(storage, IDS.dectationData, 'motonRates', ['طابع زمني', 'اسم الطالب', 'المتن', 'الورد', 'الدرجة', 'student_Cpr', 'responsible', 'code', 'level'], []);

  // --- Local identity store: give the hasPassword accounts a login ---------
  const ids = new IdentityService(storage);
  const withPassword = ['001234567', '003456789', '100000001', '100000002', '100000003'];
  for (const cpr of withPassword) {
    ids.setPassword('u' + cpr, credEmail(cpr), cpr, DEMO_PASSWORD);
  }

  console.log('Seeded database at', DB_PATH);
  console.log('Students: 3, Staff: 3 (admin/editor/teacher), refID: main/matns/announce');
  console.log('Password login (demo password "' + DEMO_PASSWORD + '") for CPRs:', withPassword.join(', '));
  console.log('  admin=100000001  editor=100000002  teacher=100000003  students=001234567,003456789');
  storage.close();
}

run();
