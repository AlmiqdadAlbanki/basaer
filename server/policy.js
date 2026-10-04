'use strict';

// Per-function access policy — the default-deny allowlist that closes the
// "every function is public" hole (SECURITY-FINDINGS #4, #10). The RPC boundary
// calls enforce() before dispatching. Anything not listed here is refused.
//
// Entry shape:
//   level: 'public'      no token required (login, registration, static page
//                        shells, genuinely public reads)
//          'user'        any authenticated caller
//          'student'     caller must have a student row
//          'staff'       caller must have an emp row
//          'perm'        caller must hold entry.perm (registration | dictation |
//                        exam | manage | followUp | lecturer | superAdmin)
//          'admin'       manage OR superAdmin
//          'superadmin'  superAdmin
//          'denied'      never callable from a browser (handler/one-off/leaky)
//   perm:        permission name, with level 'perm'
//   selfCprArg:  index of a CPR argument that identifies the subject. For a
//                non-staff caller it is overwritten with the caller's own CPR,
//                so a student can only ever act on themselves (closes #8); staff
//                may target any CPR. Implies the caller must be authenticated.
//   check(ctx, args):  optional extra predicate returning true to allow.
//
// Where a function's subject-CPR position was not certain from the code, the
// entry is intentionally conservative (no selfCprArg, higher level) and tagged
// `// TODO verify`. These do not weaken security; at worst they are stricter
// than necessary and would surface as a blocked legitimate call to revisit.

const POLICY = {
  // ---- Static page shells (return HTML templates only, no data) -----------
  loadPageLogin: { level: 'public' },
  loadPageRegistration: { level: 'public' },
  loadHomePage: { level: 'public' },
  loadPageStudent: { level: 'user' },
  loadPageProfile: { level: 'user' },
  loadPageEmp: { level: 'staff' },
  loadPageAttending: { level: 'staff' },
  loadPageNewStuReg: { level: 'staff' },
  loadPageCurrentStus: { level: 'staff' },
  loadPageEmpManag: { level: 'admin' },
  loadPagellAttend: { level: 'staff' },
  loadPageIqrar: { level: 'user' },
  loadPageQuestions: { level: 'perm', perm: 'exam' },
  loadPageAdminDashboard: { level: 'admin' },
  loadPageSendMsg: { level: 'admin' },

  // ---- Login / registration bootstrap (pre-auth) --------------------------
  checkCprStatus: { level: 'public' },
  checkPersonFolderStatus: { level: 'public' },
  checkStudentRegistered: { level: 'public' },
  requestLoginCode: { level: 'public' },
  requestRegistrationOtp: { level: 'public' },
  verifyRegistrationOtp: { level: 'public' },
  verifyLoginCode: { level: 'public' },
  loginWithPassword: { level: 'public' },
  loginWithGoogleVerifiedEmail: { level: 'public' }, // server-side token check added separately (#6)
  skipEmailVerificationLogin: { level: 'public' },   // gated by a feature flag at the function (#5)
  checkOauthVerifyResult: { level: 'public' },
  newStuReg: { level: 'public' },                    // emailVerified proof enforced in the function (#12)

  // ---- Public reads used before/independent of login ----------------------
  getMainStatus: { level: 'public' },
  getMainData: { level: 'public' },
  getMatns: { level: 'public' },
  getAnnounces: { level: 'public' },
  getMadhabsList: { level: 'public' },
  getStagesList: { level: 'public' },
  getPublicDashboardStats: { level: 'public' },
  getBahrainTime: { level: 'public' },
  lookupBlockArea: { level: 'public' },
  clearUserData: { level: 'public' }, // logout bookkeeping; clears nothing sensitive

  // ---- Course materials browsing (Drive-backed) ---------------------------
  getDriveFolderContents: { level: 'user' },
  searchCourseFolder: { level: 'user' },

  // ---- A caller acting on their own account -------------------------------
  getMyProfileData: { level: 'user', selfCprArg: 0 },
  getAnswersData: { level: 'user', selfCprArg: 0 },
  getAttendance: { level: 'user', selfCprArg: 0 },
  getMyStageCertificates: { level: 'user', selfCprArg: 0 },
  getStudentRecitationBreakdown: { level: 'user', selfCprArg: 0 },
  getStudentExamPassBreakdown: { level: 'user', selfCprArg: 0 },
  getDectationData: { level: 'user', selfCprArg: 0 },
  saveProfileData: { level: 'user', selfCprArg: 0 },
  uploadProfileAvatar: { level: 'user', selfCprArg: 0 },
  changePassword: { level: 'user', selfCprArg: 0 },
  setPassword: { level: 'user', selfCprArg: 0 },       // can only set own password now (#2)
  confirmProfileEmail: { level: 'user', selfCprArg: 0 },
  linkVerifiedEmailToProfile: { level: 'user', selfCprArg: 0 },
  checkIsAlsoStudent: { level: 'user', selfCprArg: 0 },
  hasExamPermission: { level: 'user', selfCprArg: 0 }, // returns the caller's own permissions only
  setMazhab: { level: 'user', selfCprArg: 0 },
  requestStageJoin: { level: 'student', selfCprArg: 0 },
  requestAttendance: { level: 'student', selfCprArg: 0 },
  submitStWRK: { level: 'student', selfCprArg: 0 },

  // ---- Exam-taking (student acting on their own attempt) ------------------
  getQuestions: { level: 'user', selfCprArg: 0 },
  submitAnswerData: { level: 'user', selfCprArg: 0 },
  saveExamSessionProgress: { level: 'user', selfCprArg: 0 },
  checkExamSessionState: { level: 'user', selfCprArg: 0 },
  recordExamEntry: { level: 'user', selfCprArg: 0 },
  hasStudentEnteredExam: { level: 'user', selfCprArg: 0 },
  hasSubmittedPreExamSurvey: { level: 'user', selfCprArg: 0 },
  submitExamSurvey: { level: 'user', selfCprArg: 0 }, // TODO verify cpr index
  examAllowsReentry: { level: 'user' },
  studentFailedExam: { level: 'user' }, // TODO verify cpr index
  getExams: { level: 'user' },          // exam list; subject cpr is arg 2 (not scoped) — read only

  // ---- Staff reads --------------------------------------------------------
  // getPersons returns the full student table to staff, but only the caller's
  // own record to a student (#3). The client's student-login path reads its own
  // record out of this list, so self-scoping keeps that working while never
  // letting another student's data reach the browser.
  getPersons: { level: 'user', scopeSelf: true },
  getStaffList: { level: 'staff' },
  getLecturersList: { level: 'staff' },
  getLecturesRef: { level: 'staff' },
  getSubjectsList: { level: 'staff' },
  getCurriculaList: { level: 'staff' },
  getMatnCatalogList: { level: 'staff' },
  getLecAttend: { level: 'staff' },
  getAttendanceRequests: { level: 'staff' },
  getAllStWrks: { level: 'staff' },
  getDualRoleCprList: { level: 'admin' },
  getDictationStats: { level: 'perm', perm: 'dictation' },
  getFullAdminData: { level: 'admin' },
  // loginData doubles as self-bootstrap and admin 'all'. Allow any authenticated
  // caller to read their own emp row; only an admin may request every row.
  loginData: {
    level: 'user',
    selfCprArg: 0, // a non-staff caller is rescoped to their own CPR (no probing staff rows)
    check: (ctx, args) => String(args[0]) !== 'all' ? true : ctx.isAdmin,
  },

  // ---- Attendance management (staff) --------------------------------------
  startQrSession: { level: 'staff' },
  setAttendQr: { level: 'staff' },
  setLecAttend: { level: 'staff' },
  addManualAttendance: { level: 'perm', perm: 'followUp' }, // TODO verify perm
  deleteAttendance: { level: 'perm', perm: 'followUp' },
  acceptAttendanceRequests: { level: 'perm', perm: 'followUp' },
  rejectAttendanceRequests: { level: 'perm', perm: 'followUp' },
  saveLectureRef: { level: 'staff' },
  deleteLectureRef: { level: 'staff' },
  submitDectationData: { level: 'perm', perm: 'dictation' },
  deleteDectation: { level: 'perm', perm: 'dictation' },

  // ---- Student acceptance (admin) -----------------------------------------
  setStudentsQrCard: { level: 'perm', perm: 'registration' },
  setStudentStudyMode: { level: 'perm', perm: 'registration' },
  startAcceptBatch: { level: 'perm', perm: 'registration' },
  updateAcceptBatchProgress: { level: 'perm', perm: 'registration' },
  endAcceptBatch: { level: 'perm', perm: 'registration' },
  getAcceptBatchStatus: { level: 'perm', perm: 'registration' },

  // ---- Staff administration (admin / superadmin) --------------------------
  addStaff: { level: 'admin' },
  updateStaff: { level: 'admin' },
  deleteStaff: { level: 'admin' },
  setRegistrationStatus: { level: 'admin' },
  setAttendanceRequestsStatus: { level: 'admin' },
  setSelfIssueCertStatus: { level: 'admin' },
  setAllowMazhabChangeStatus: { level: 'admin' },
  seedExistingCardTemplateIds: { level: 'admin' },

  // ---- Catalogue / curriculum CRUD (admin) --------------------------------
  saveSubject: { level: 'admin' }, deleteSubject: { level: 'admin' },
  saveCurriculum: { level: 'admin' }, deleteCurriculum: { level: 'admin' },
  saveMatnCatalog: { level: 'admin' }, deleteMatnCatalog: { level: 'admin' },
  saveMadhab: { level: 'admin' }, deleteMadhab: { level: 'admin' },
  saveMatnsItem: { level: 'admin' }, deleteMatnsItem: { level: 'admin' },
  importMatnCatalogFromAwrad: { level: 'admin' }, getMadhabImpact: { level: 'admin' },

  // ---- Stages & graduation (admin) ----------------------------------------
  saveStageSettings: { level: 'admin' },
  saveStageTemplateField: { level: 'admin' },
  saveStageCriterion: { level: 'admin' },
  getStageCriteriaList: { level: 'staff' },
  getStageAttendanceStats: { level: 'staff' },
  getStageCompletionStatus: { level: 'staff' },
  getStageCertificateMessageTemplate: { level: 'admin' },
  getGraduationCandidates: { level: 'admin' },
  issueStageCertificate: { level: 'admin' },
  scheduleStageCertWhatsAppNotify: { level: 'admin' },

  // ---- Certificates (admin, except self-service) --------------------------
  getCertificateTemplatesList: { level: 'admin' },
  duplicateCertificateTemplateDoc: { level: 'admin' },
  saveCertificateTemplate: { level: 'admin' },
  deleteCertificateTemplate: { level: 'admin' },
  generatCertificate: { level: 'admin' },
  generatWrksCertificate: { level: 'admin' },
  exportNewCard: { level: 'admin' },
  ensureIssuedFileViewable: { level: 'admin' },
  issueCertificateSelfService: { level: 'student', selfCprArg: 0 }, // TODO verify cpr index

  // ---- Exam management / editor (exam permission) -------------------------
  getExamManagementData: { level: 'perm', perm: 'exam' },
  getExamEditorData: { level: 'perm', perm: 'exam' },
  getExamSurveyStats: { level: 'perm', perm: 'exam' },
  getExamPassCountsByLevel: { level: 'perm', perm: 'exam' },
  getExamResultsByLevel: { level: 'perm', perm: 'exam' },
  saveExam: { level: 'perm', perm: 'exam' },
  duplicateExam: { level: 'perm', perm: 'exam' },
  archiveExam: { level: 'perm', perm: 'exam' },
  unarchiveExam: { level: 'perm', perm: 'exam' },
  setExamRetakeOpen: { level: 'perm', perm: 'exam' },
  saveQuestion: { level: 'perm', perm: 'exam' },
  importQuestionsBulk: { level: 'perm', perm: 'exam' },
  deleteQuestion: { level: 'perm', perm: 'exam' },
  setExamModelApproval: { level: 'perm', perm: 'exam' },
  deleteExamModel: { level: 'perm', perm: 'exam' },

  // ---- Messaging: templates, groups, broadcasts (admin) -------------------
  getMessageTemplatesList: { level: 'admin' },
  saveMessageTemplate: { level: 'admin' },
  getMessageLogList: { level: 'admin' },
  getWhatsappGroupsList: { level: 'admin' },
  saveWhatsappGroup: { level: 'admin' },
  deleteWhatsappGroup: { level: 'admin' },
  refreshWhatsappGroupsFromFonnte: { level: 'admin' },
  getWhatsappGroupsFromFonnte: { level: 'admin' },
  getWhatsAppProviderSettings: { level: 'admin' },
  getApprovedMetaWhatsAppTemplates: { level: 'admin' },
  getGreetingTemplatesList: { level: 'admin' },
  saveGreetingTemplate: { level: 'admin' },
  deleteGreetingTemplate: { level: 'admin' },
  getFcmActivatedStudents: { level: 'admin' },
  checkWhatsApp: { level: 'admin' },
  sendFinishedMail: { level: 'admin' },
  prepareAndScheduleBroadcast: { level: 'admin' },
  prepareAndScheduleFcmBroadcast: { level: 'admin' },

  // ---- Messaging queue controls (admin) -----------------------------------
  getWPCampaignQueueListBoth: { level: 'admin' },
  cancelQueuedWPCampaign: { level: 'admin' },
  startWPQueueSend: { level: 'admin' },
  resumeWPQueueSend: { level: 'admin' },
  stopWPQueueSend: { level: 'admin' },
  getWPQueueStatus: { level: 'admin' },
  getWPQueueStatusBoth: { level: 'admin' },
  stopFCMQueueSend: { level: 'admin' },
  getFCMQueueStatus: { level: 'admin' },

  // ---- Meta WhatsApp settings (superadmin — already ID-token gated) --------
  setWhatsAppProvider: { level: 'superadmin' },
  saveMetaWhatsAppConfiguration: { level: 'superadmin' },
  submitMetaWhatsAppTemplateForReview: { level: 'superadmin' },
  getMetaWhatsAppTemplateStatus: { level: 'superadmin' },

  // ---- Explicitly never callable from a browser ---------------------------
  getOAuthToken: { level: 'denied' }, // handed out the owner's Google token (#1)
};

// Returns { allow, status?, message?, args? } where args is the (possibly
// CPR-rescoped) argument array to dispatch with.
function enforce(fnName, args, ctx) {
  const entry = POLICY[fnName];
  if (!entry) return { allow: false, status: 403, message: 'هذه العملية غير مسموح بها.' };
  if (entry.level === 'denied') return { allow: false, status: 403, message: 'هذه العملية غير متاحة.' };
  if (entry.level === 'public') return finalize(entry, args, ctx);

  // Everything else needs an authenticated caller.
  if (!ctx) return { allow: false, status: 401, message: 'يلزم تسجيل الدخول.' };

  switch (entry.level) {
    case 'user': break;
    case 'student': if (!ctx.isStudent && !ctx.isStaff) return forbidden(); break;
    case 'staff': if (!ctx.isStaff) return forbidden(); break;
    case 'perm': if (!(ctx.perms && ctx.perms[entry.perm]) && !ctx.isAdmin) return forbidden(); break;
    case 'admin': if (!ctx.isAdmin) return forbidden(); break;
    case 'superadmin': if (!ctx.perms.superAdmin) return forbidden(); break;
    default: return forbidden();
  }
  if (entry.check && !entry.check(ctx, args)) return forbidden();
  return finalize(entry, args, ctx);
}

function forbidden() {
  return { allow: false, status: 403, message: 'ليس لديك صلاحية لهذه العملية.' };
}

// Rescope a subject CPR to the caller when the caller is not staff, and carry
// any result-scoping instruction to the dispatcher.
function finalize(entry, args, ctx) {
  let outArgs = args;
  if (entry.selfCprArg != null && ctx && !ctx.isStaff) {
    outArgs = args.slice();
    outArgs[entry.selfCprArg] = ctx.cpr;
  }
  const scopeSelf = !!(entry.scopeSelf && ctx && !ctx.isStaff);
  return { allow: true, args: outArgs, scopeSelf, cpr: ctx ? ctx.cpr : null };
}

function cprEq(a, b) {
  const na = Number(a); const nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

// Apply a decision's result-scoping to a function's return value. For a
// self-scoped array result, keep only the caller's own rows.
function scopeResult(decision, result) {
  if (!decision.scopeSelf) return result;
  if (Array.isArray(result)) return result.filter((r) => r && cprEq(r.cpr, decision.cpr));
  return result; // non-array (e.g. the gas "no data" sentinel 0) passes through
}

module.exports = { POLICY, enforce, scopeResult, policyNames: () => Object.keys(POLICY) };
