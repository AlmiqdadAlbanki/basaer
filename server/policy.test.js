'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { POLICY, enforce } = require('./policy.js');

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

test('full student list is staff-only (#3)', () => {
  assert.strictEqual(enforce('getPersons', [], STUDENT).allow, false);
  assert.strictEqual(enforce('getPersons', [], TEACHER).allow, true);
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
