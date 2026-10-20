'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { POLICY, enforce, scopeResult, rpcKinds } = require('./policy.js');

// The authoritative set of server functions the client invokes (from the
// call-site inventory). Every one must have an explicit policy entry, so a new
// client call can never fall through to an unprotected default.
const CLIENT_CALLED = [
  'acceptAttendanceRequests', 'addManualAttendance', 'addStaff', 'archiveExam', 'cancelQueuedWPCampaign',
  'changePassword', 'checkCprStatus', 'checkIsAlsoStudent', 'checkOauthVerifyResult', 'checkPersonFolderStatus',
  'checkStudentRegistered', 'checkWhatsApp', 'clearUserData', 'confirmProfileEmail', 'deleteAttendance',
  'deleteCertificateTemplate', 'deleteDectation', 'deleteExamModel', 'deleteGreetingTemplate', 'deleteLectureRef',
  'deleteQuestion', 'deleteStaff', 'deleteWhatsappGroup', 'duplicateCertificateTemplateDoc', 'duplicateExam',
  'endAcceptBatch', 'ensureIssuedFileViewable', 'exportNewCard', 'generatCertificate', 'generatWrksCertificate',
  'getAcceptBatchStatus', 'getAllStWrks', 'getAnnounces', 'getAnswersData', 'getApprovedMetaWhatsAppTemplates',
  'getAttendance', 'getAttendanceRequests', 'getCertificateTemplatesList', 'getCurriculaList', 'getDectationData',
  'getDictationStats', 'getDriveFolderContents', 'getDualRoleCprList', 'getExamEditorData', 'getExamManagementData',
  'getExamPassCountsByLevel', 'getExamResultsByLevel', 'getExams', 'getExamSurveyStats', 'getFcmActivatedStudents',
  'getFCMQueueStatus', 'getGraduationCandidates', 'getGreetingTemplatesList', 'getLecAttend', 'getLecturersList',
  'getLecturesRef', 'getMadhabsList', 'getMainData', 'getMainStatus', 'getMatns', 'getMatnCatalogList',
  'getMessageLogList', 'getMessageTemplatesList', 'getMetaWhatsAppTemplateStatus', 'getMyProfileData',
  'getMyStageCertificates', 'getOAuthToken', 'getPersons', 'getPublicDashboardStats', 'getQuestions', 'getStaffList',
  'getStageAttendanceStats', 'getStageCertificateMessageTemplate', 'getStageCriteriaList', 'getStagesList',
  'getStudentExamPassBreakdown', 'getStudentRecitationBreakdown', 'getSubjectsList', 'getWhatsappGroupsFromFonnte',
  'getWhatsappGroupsList', 'getWhatsAppProviderSettings', 'getWPCampaignQueueListBoth', 'getWPQueueStatus',
  'getWPQueueStatusBoth', 'hasExamPermission', 'hasSubmittedPreExamSurvey', 'importMatnCatalogFromAwrad',
  'importQuestionsBulk', 'issueCertificateSelfService', 'issueStageCertificate', 'linkVerifiedEmailToProfile',
  'loginData', 'loginWithGoogleVerifiedEmail', 'loginWithPassword', 'lookupBlockArea', 'newStuReg',
  'prepareAndScheduleBroadcast', 'prepareAndScheduleFcmBroadcast', 'refreshWhatsappGroupsFromFonnte',
  'rejectAttendanceRequests', 'requestAttendance', 'requestLoginCode', 'requestRegistrationOtp', 'requestStageJoin',
  'resumeWPQueueSend', 'saveCertificateTemplate', 'saveExam', 'saveExamSessionProgress', 'saveGreetingTemplate',
  'saveLectureRef', 'saveMessageTemplate', 'saveMetaWhatsAppConfiguration', 'saveProfileData', 'saveQuestion',
  'saveStageCriterion', 'saveStageSettings', 'saveStageTemplateField', 'saveWhatsappGroup',
  'scheduleStageCertWhatsAppNotify', 'searchCourseFolder', 'seedExistingCardTemplateIds', 'sendFinishedMail',
  'setAllowMazhabChangeStatus', 'setAttendanceRequestsStatus', 'setAttendQr', 'setExamModelApproval',
  'setExamRetakeOpen', 'setLecAttend', 'setMazhab', 'setPassword', 'setRegistrationStatus', 'setSelfIssueCertStatus',
  'setStudentsQrCard', 'setStudentStudyMode', 'setWhatsAppProvider', 'skipEmailVerificationLogin', 'startAcceptBatch',
  'startQrSession', 'startWPQueueSend', 'stopFCMQueueSend', 'stopWPQueueSend', 'submitAnswerData',
  'submitDectationData', 'submitExamSurvey', 'submitMetaWhatsAppTemplateForReview', 'submitStWRK', 'unarchiveExam',
  'updateAcceptBatchProgress', 'updateStaff', 'uploadProfileAvatar', 'verifyLoginCode', 'verifyRegistrationOtp',
  // curriculum lookup-table names
  'saveSubject', 'saveCurriculum', 'saveMadhab', 'saveMatnsItem', 'deleteSubject', 'deleteCurriculum',
  'deleteMatnCatalog', 'deleteMadhab', 'deleteMatnsItem', 'saveMatnCatalog',
  // page loaders
  'loadPageRegistration', 'loadPageLogin', 'loadPageStudent', 'loadPageEmp', 'loadPageAttending',
  'loadPageNewStuReg', 'loadPageCurrentStus', 'loadPageEmpManag', 'loadPagellAttend', 'loadPageIqrar',
  'loadPageQuestions', 'loadPageAdminDashboard', 'loadPageSendMsg', 'loadHomePage',
];

const STUDENT = { cpr: '001234567', isStudent: true, isStaff: false, isAdmin: false, isEditor: false, perms: {} };
const TEACHER = { cpr: '100000003', isStudent: false, isStaff: true, isAdmin: false, isEditor: false, perms: { dictation: true } };
const ADMIN = { cpr: '100000001', isStudent: false, isStaff: true, isAdmin: true, isEditor: true, perms: { manage: true, exam: true, superAdmin: true } };

test('every client-called function has an explicit policy entry', () => {
  const missing = CLIENT_CALLED.filter((n) => !(n in POLICY));
  assert.deepStrictEqual(missing, [], 'missing policy entries: ' + missing.join(', '));
});

test('an unlisted function is denied', () => {
  const r = enforce('totallyUnknownFn', [], ADMIN);
  assert.strictEqual(r.allow, false);
  assert.strictEqual(r.status, 403);
});

test('getOAuthToken is denied even for a superadmin (#1)', () => {
  assert.strictEqual(enforce('getOAuthToken', [], ADMIN).allow, false);
});

test('public functions need no token', () => {
  assert.strictEqual(enforce('checkCprStatus', ['001234567'], null).allow, true);
  assert.strictEqual(enforce('getMainStatus', [], null).allow, true);
  assert.strictEqual(enforce('loginWithPassword', ['x', 'y'], null).allow, true);
});

test('protected functions reject an anonymous caller (401)', () => {
  assert.strictEqual(enforce('getPersons', [], null).status, 401);
  assert.strictEqual(enforce('getAnswersData', ['001234567'], null).status, 401);
});

test('getPersons: staff get the full list, a student only their own record (#3)', () => {
  const roster = [{ cpr: '001234567', name: 'me' }, { cpr: '003456789', name: 'other' }];

  const staffDec = enforce('getPersons', [], TEACHER);
  assert.strictEqual(staffDec.allow, true);
  assert.deepStrictEqual(scopeResult(staffDec, roster), roster); // not scoped

  const studentDec = enforce('getPersons', [], STUDENT);
  assert.strictEqual(studentDec.allow, true);
  const scoped = scopeResult(studentDec, roster);
  assert.strictEqual(scoped.length, 1);
  assert.strictEqual(scoped[0].cpr, '001234567'); // only the caller's own row leaves the server

  // anonymous still blocked
  assert.strictEqual(enforce('getPersons', [], null).status, 401);
});

test('scopeResult leaves the gas "no data" sentinel (0) untouched', () => {
  const dec = enforce('getPersons', [], STUDENT);
  assert.strictEqual(scopeResult(dec, 0), 0);
});

test('a student can only read their own records; CPR is rescoped (#8)', () => {
  const r = enforce('getAnswersData', ['999999999'], STUDENT); // tries another CPR
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.args[0], STUDENT.cpr); // overwritten with caller's own CPR
});

test('staff may target any CPR (not rescoped)', () => {
  const r = enforce('getAnswersData', ['999999999'], TEACHER);
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.args[0], '999999999');
});

// submitStWRK's subject is "stWork-<cpr>" (gas splits on '-'); a student is
// rescoped to their own prefixed id, never to a bare CPR, and the original
// argument array is left untouched.
test('submitStWRK is rescoped to "stWork-<callerCpr>" for students', () => {
  const original = ['stWork-999999999', 'work-1', 'f_abc'];
  const student = enforce('submitStWRK', original, STUDENT);
  assert.strictEqual(student.allow, true);
  assert.strictEqual(student.args[0], 'stWork-' + STUDENT.cpr);
  assert.strictEqual(original[0], 'stWork-999999999');
  const staff = enforce('submitStWRK', original, TEACHER);
  assert.strictEqual(staff.args[0], 'stWork-999999999');
});

test('exam-state reads are scoped to the caller (getExams arg 2, studentFailedExam arg 0)', () => {
  assert.strictEqual(enforce('getExams', [null, null, '999999999'], STUDENT).args[2], STUDENT.cpr);
  assert.strictEqual(enforce('getExams', ['x', 1], STUDENT).args[2], STUDENT.cpr);
  assert.strictEqual(enforce('getExams', [null, null, '999999999'], TEACHER).args[2], '999999999');
  assert.strictEqual(enforce('studentFailedExam', ['999999999', 'x', 1], STUDENT).args[0], STUDENT.cpr);
});

test('setPassword can only set the caller\'s own password (#2)', () => {
  const r = enforce('setPassword', ['999999999', 'newpass'], STUDENT);
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.args[0], STUDENT.cpr);
});

test('hasExamPermission returns only the caller\'s own permissions (#4)', () => {
  const r = enforce('hasExamPermission', ['100000001'], STUDENT); // probing an admin CPR
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.args[0], STUDENT.cpr);
});

test('staff administration is admin-only (#4)', () => {
  assert.strictEqual(enforce('addStaff', [{}], STUDENT).allow, false);
  assert.strictEqual(enforce('addStaff', [{}], TEACHER).allow, false);
  assert.strictEqual(enforce('addStaff', [{}], ADMIN).allow, true);
});

test('queue controls are admin-only (#9)', () => {
  assert.strictEqual(enforce('stopWPQueueSend', ['fonnte'], TEACHER).allow, false);
  assert.strictEqual(enforce('stopWPQueueSend', ['fonnte'], ADMIN).allow, true);
});

test('exam editing requires the exam permission', () => {
  const editor = { cpr: '100000002', isStaff: true, isAdmin: false, perms: { exam: true } };
  assert.strictEqual(enforce('saveExam', [{}], TEACHER).allow, false); // teacher lacks exam
  assert.strictEqual(enforce('saveExam', [{}], editor).allow, true);
  assert.strictEqual(enforce('saveExam', [{}], ADMIN).allow, true); // admin always
});

test('recitation grading requires the dictation permission', () => {
  assert.strictEqual(enforce('submitDectationData', [{}], STUDENT).allow, false);
  assert.strictEqual(enforce('submitDectationData', [{}], TEACHER).allow, true);
});

test('Meta settings require superadmin', () => {
  const adminNotSuper = { cpr: '1', isStaff: true, isAdmin: true, perms: { manage: true } };
  assert.strictEqual(enforce('setWhatsAppProvider', ['meta'], adminNotSuper).allow, false);
  assert.strictEqual(enforce('setWhatsAppProvider', ['meta'], ADMIN).allow, true);
});

test('loginData: self for anyone, "all" for admin only', () => {
  assert.strictEqual(enforce('loginData', ['001234567'], STUDENT).allow, true);
  assert.strictEqual(enforce('loginData', ['all'], STUDENT).allow, false);
  assert.strictEqual(enforce('loginData', ['all'], ADMIN).allow, true);
});

// ---- RPC cache kinds (read / live / write) ----------------------------------

test('every policy entry has a valid cache kind', () => {
  const bad = Object.keys(POLICY).filter((n) => !['read', 'live', 'write'].includes(POLICY[n].kind));
  assert.deepStrictEqual(bad, [], 'entries without a valid kind: ' + bad.join(', '));
});

test('rpcKinds: omits denied functions and maps names to kinds', () => {
  const kinds = rpcKinds();
  const denied = Object.keys(POLICY).filter((n) => POLICY[n].level === 'denied');
  assert.ok(denied.length > 0); // the check below is only meaningful if something is denied
  for (const n of denied) assert.ok(!(n in kinds), n + ' must not be exposed to the client cache');
  assert.ok(!('getOAuthToken' in kinds));
  assert.strictEqual(Object.keys(kinds).length, Object.keys(POLICY).length - denied.length);
  assert.strictEqual(kinds.getPersons, 'read');
  assert.strictEqual(kinds.getWPQueueStatus, 'live');
  assert.strictEqual(kinds.saveExam, 'write');
});

test('rpcKinds: sanity counts per kind', () => {
  const counts = { read: 0, live: 0, write: 0 };
  for (const k of Object.values(rpcKinds())) counts[k]++;
  assert.ok(counts.read >= 60, 'read count ' + counts.read);
  assert.ok(counts.live >= 15, 'live count ' + counts.live);
  assert.ok(counts.write >= 90, 'write count ' + counts.write);
});
