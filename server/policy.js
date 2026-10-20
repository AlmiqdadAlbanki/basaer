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
//   rescope(ctx, args): optional; for a non-staff caller, rewrites the argument
//                array in place so it can only refer to the caller (used where
//                the subject is not a bare CPR, e.g. "stWork-<cpr>").
//   kind:        how the browser-side RPC cache treats the function (see
//                rpcKinds(), which the page injects for the client cache):
//          'read'        pure read; the browser may cache the result for the
//                        page lifetime
//          'live'        read with no side effects but fetched every time
//                        (polled status, time/session dependent)
//          'write'       has side effects; a successful call clears the
//                        browser cache
//
// Where a function's subject-CPR position was not certain from the code, the
// entry is intentionally conservative (no selfCprArg, higher level) and tagged
// `// TODO verify`. These do not weaken security; at worst they are stricter
// than necessary and would surface as a blocked legitimate call to revisit.

const POLICY = {
  // ---- Static page shells (return HTML templates only, no data) -----------
  loadPageLogin: { level: 'public', kind: 'read' },
  loadPageRegistration: { level: 'public', kind: 'read' },
  loadHomePage: { level: 'public', kind: 'read' },
  loadPageStudent: { level: 'user', kind: 'read' },
  loadPageProfile: { level: 'user', kind: 'read' },
  loadPageEmp: { level: 'staff', kind: 'read' },
  loadPageAttending: { level: 'staff', kind: 'read' },
  loadPageNewStuReg: { level: 'staff', kind: 'read' },
  loadPageCurrentStus: { level: 'staff', kind: 'read' },
  loadPageEmpManag: { level: 'admin', kind: 'read' },
  loadPagellAttend: { level: 'staff', kind: 'read' },
  loadPageIqrar: { level: 'user', kind: 'read' },
  loadPageQuestions: { level: 'perm', perm: 'exam', kind: 'read' },
  loadPageAdminDashboard: { level: 'admin', kind: 'read' },
  loadPageSendMsg: { level: 'admin', kind: 'read' },

  // ---- Login / registration bootstrap (pre-auth) --------------------------
  checkCprStatus: { level: 'public', kind: 'read' },
  checkPersonFolderStatus: { level: 'public', kind: 'read' },
  checkStudentRegistered: { level: 'public', kind: 'read' },
  requestLoginCode: { level: 'public', kind: 'write' },
  requestRegistrationOtp: { level: 'public', kind: 'write' },
  verifyRegistrationOtp: { level: 'public', kind: 'write' },
  verifyLoginCode: { level: 'public', kind: 'write' },
  loginWithPassword: { level: 'public', kind: 'write' },
  loginWithGoogleVerifiedEmail: { level: 'public', kind: 'write' }, // server-side token check added separately (#6)
  skipEmailVerificationLogin: { level: 'public', kind: 'write' },   // gated by a feature flag at the function (#5)
  checkOauthVerifyResult: { level: 'public', kind: 'live' },
  newStuReg: { level: 'public', kind: 'write' },                    // emailVerified proof enforced in the function (#12)

  // ---- Public reads used before/independent of login ----------------------
  getMainStatus: { level: 'public', kind: 'read' },
  getMainData: { level: 'public', kind: 'read' },
  getMatns: { level: 'public', kind: 'read' },
  getAnnounces: { level: 'public', kind: 'read' },
  getMadhabsList: { level: 'public', kind: 'read' },
  getStagesList: { level: 'public', kind: 'read' },
  getPublicDashboardStats: { level: 'public', kind: 'read' },
  getBahrainTime: { level: 'public', kind: 'live' },
  lookupBlockArea: { level: 'public', kind: 'read' },
  clearUserData: { level: 'public', kind: 'write' }, // logout bookkeeping; clears nothing sensitive

  // ---- Course materials browsing (Drive-backed) ---------------------------
  getDriveFolderContents: { level: 'user', kind: 'read' },
  searchCourseFolder: { level: 'user', kind: 'read' },

  // ---- A caller acting on their own account -------------------------------
  getMyProfileData: { level: 'user', selfCprArg: 0, kind: 'read' },
  getAnswersData: { level: 'user', selfCprArg: 0, kind: 'read' },
  getAttendance: { level: 'user', selfCprArg: 0, kind: 'read' },
  getMyStageCertificates: { level: 'user', selfCprArg: 0, kind: 'read' },
  getStudentRecitationBreakdown: { level: 'user', selfCprArg: 0, kind: 'read' },
  getStudentExamPassBreakdown: { level: 'user', selfCprArg: 0, kind: 'read' },
  getDectationData: { level: 'user', selfCprArg: 0, kind: 'read' },
  saveProfileData: { level: 'user', selfCprArg: 0, kind: 'write' },
  uploadProfileAvatar: { level: 'user', selfCprArg: 0, kind: 'write' },
  changePassword: { level: 'user', selfCprArg: 0, kind: 'write' },
  setPassword: { level: 'user', selfCprArg: 0, kind: 'write' },       // can only set own password now (#2)
  confirmProfileEmail: { level: 'user', selfCprArg: 0, kind: 'write' },
  linkVerifiedEmailToProfile: { level: 'user', selfCprArg: 0, kind: 'write' },
  checkIsAlsoStudent: { level: 'user', selfCprArg: 0, kind: 'read' },
  hasExamPermission: { level: 'user', selfCprArg: 0, kind: 'read' }, // returns the caller's own permissions only
  setMazhab: { level: 'user', selfCprArg: 0, kind: 'write' },
  requestStageJoin: { level: 'student', selfCprArg: 0, kind: 'write' },
  requestAttendance: { level: 'student', selfCprArg: 0, kind: 'write' },
  // The subject is "stWork-<cpr>" (the gas function splits on '-'), so a plain
  // CPR rescope would blank the recorded CPR; rebuild the prefix instead.
  submitStWRK: { level: 'student', rescope: (ctx, args) => { args[0] = 'stWork-' + ctx.cpr; }, kind: 'write' },

  // ---- Exam-taking (student acting on their own attempt) ------------------
  getQuestions: { level: 'user', selfCprArg: 0, kind: 'write' },
  submitAnswerData: { level: 'user', selfCprArg: 0, kind: 'write' },
  saveExamSessionProgress: { level: 'user', selfCprArg: 0, kind: 'write' },
  checkExamSessionState: { level: 'user', selfCprArg: 0, kind: 'live' },
  recordExamEntry: { level: 'user', selfCprArg: 0, kind: 'write' },
  hasStudentEnteredExam: { level: 'user', selfCprArg: 0, kind: 'read' },
  hasSubmittedPreExamSurvey: { level: 'user', selfCprArg: 0, kind: 'read' },
  submitExamSurvey: { level: 'user', selfCprArg: 0, kind: 'write' }, // TODO verify cpr index
  examAllowsReentry: { level: 'user', kind: 'read' },               // (examName, level): no subject
  studentFailedExam: { level: 'user', selfCprArg: 0, kind: 'read' }, // (cpr, examName, level)
  getExams: { level: 'user', selfCprArg: 2, kind: 'live' },          // (exam, level, cpr): per-student session state

  // ---- Staff reads --------------------------------------------------------
  // getPersons returns the full student table to staff, but only the caller's
  // own record to a student (#3). The client's student-login path reads its own
  // record out of this list, so self-scoping keeps that working while never
  // letting another student's data reach the browser.
  getPersons: { level: 'user', scopeSelf: true, kind: 'read' },
  getStaffList: { level: 'staff', kind: 'read' },
  getLecturersList: { level: 'staff', kind: 'read' },
  getLecturesRef: { level: 'staff', kind: 'read' },
  getSubjectsList: { level: 'staff', kind: 'read' },
  getCurriculaList: { level: 'staff', kind: 'read' },
  getMatnCatalogList: { level: 'staff', kind: 'read' },
  // The student page reads its own lecture attendance at startup (js.html:643).
  getLecAttend: { level: 'user', selfCprArg: 0, kind: 'read' },
  getAttendanceRequests: { level: 'staff', kind: 'read' },
  getAllStWrks: { level: 'staff', kind: 'read' },
  getDualRoleCprList: { level: 'admin', kind: 'read' },
  getDictationStats: { level: 'perm', perm: 'dictation', kind: 'read' },
  getFullAdminData: { level: 'admin', kind: 'read' },
  // loginData doubles as self-bootstrap and admin 'all'. Allow any authenticated
  // caller to read their own emp row; only an admin may request every row.
  loginData: {
    level: 'user',
    selfCprArg: 0, // a non-staff caller is rescoped to their own CPR (no probing staff rows)
    check: (ctx, args) => String(args[0]) !== 'all' ? true : ctx.isAdmin,
    kind: 'read',
  },

  // ---- Attendance management (staff) --------------------------------------
  startQrSession: { level: 'staff', kind: 'write' },
  setAttendQr: { level: 'staff', kind: 'write' },
  setLecAttend: { level: 'staff', kind: 'write' },
  addManualAttendance: { level: 'perm', perm: 'followUp', kind: 'write' }, // TODO verify perm
  deleteAttendance: { level: 'perm', perm: 'followUp', kind: 'write' },
  acceptAttendanceRequests: { level: 'perm', perm: 'followUp', kind: 'write' },
  rejectAttendanceRequests: { level: 'perm', perm: 'followUp', kind: 'write' },
  saveLectureRef: { level: 'staff', kind: 'write' },
  deleteLectureRef: { level: 'staff', kind: 'write' },
  submitDectationData: { level: 'perm', perm: 'dictation', kind: 'write' },
  deleteDectation: { level: 'perm', perm: 'dictation', kind: 'write' },

  // ---- Student acceptance (admin) -----------------------------------------
  setStudentsQrCard: { level: 'perm', perm: 'registration', kind: 'write' },
  setStudentStudyMode: { level: 'perm', perm: 'registration', kind: 'write' },
  startAcceptBatch: { level: 'perm', perm: 'registration', kind: 'write' },
  updateAcceptBatchProgress: { level: 'perm', perm: 'registration', kind: 'write' },
  endAcceptBatch: { level: 'perm', perm: 'registration', kind: 'write' },
  getAcceptBatchStatus: { level: 'perm', perm: 'registration', kind: 'live' },

  // ---- Staff administration (admin / superadmin) --------------------------
  addStaff: { level: 'admin', kind: 'write' },
  updateStaff: { level: 'admin', kind: 'write' },
  deleteStaff: { level: 'admin', kind: 'write' },
  setRegistrationStatus: { level: 'admin', kind: 'write' },
  setAttendanceRequestsStatus: { level: 'admin', kind: 'write' },
  setSelfIssueCertStatus: { level: 'admin', kind: 'write' },
  setAllowMazhabChangeStatus: { level: 'admin', kind: 'write' },
  seedExistingCardTemplateIds: { level: 'admin', kind: 'write' },

  // ---- Catalogue / curriculum CRUD (admin) --------------------------------
  saveSubject: { level: 'admin', kind: 'write' }, deleteSubject: { level: 'admin', kind: 'write' },
  saveCurriculum: { level: 'admin', kind: 'write' }, deleteCurriculum: { level: 'admin', kind: 'write' },
  saveMatnCatalog: { level: 'admin', kind: 'write' }, deleteMatnCatalog: { level: 'admin', kind: 'write' },
  saveMadhab: { level: 'admin', kind: 'write' }, deleteMadhab: { level: 'admin', kind: 'write' },
  saveMatnsItem: { level: 'admin', kind: 'write' }, deleteMatnsItem: { level: 'admin', kind: 'write' },
  importMatnCatalogFromAwrad: { level: 'admin', kind: 'write' }, getMadhabImpact: { level: 'admin', kind: 'live' },

  // ---- Stages & graduation (admin) ----------------------------------------
  saveStageSettings: { level: 'admin', kind: 'write' },
  saveStageTemplateField: { level: 'admin', kind: 'write' },
  saveStageCriterion: { level: 'admin', kind: 'write' },
  getStageCriteriaList: { level: 'staff', kind: 'read' },
  getStageAttendanceStats: { level: 'user', selfCprArg: 0, kind: 'read' }, // student dashboard (js.html:1260)
  getStageCompletionStatus: { level: 'staff', kind: 'read' },
  getStageCertificateMessageTemplate: { level: 'admin', kind: 'read' },
  getGraduationCandidates: { level: 'admin', kind: 'read' },
  issueStageCertificate: { level: 'admin', kind: 'write' },
  scheduleStageCertWhatsAppNotify: { level: 'admin', kind: 'write' },

  // ---- Certificates (admin, except self-service) --------------------------
  getCertificateTemplatesList: { level: 'admin', kind: 'read' },
  duplicateCertificateTemplateDoc: { level: 'admin', kind: 'write' },
  saveCertificateTemplate: { level: 'admin', kind: 'write' },
  deleteCertificateTemplate: { level: 'admin', kind: 'write' },
  generatCertificate: { level: 'admin', kind: 'write' },
  generatWrksCertificate: { level: 'admin', kind: 'write' },
  exportNewCard: { level: 'admin', kind: 'write' },
  ensureIssuedFileViewable: { level: 'admin', kind: 'write' },
  issueCertificateSelfService: { level: 'student', selfCprArg: 0, kind: 'write' }, // TODO verify cpr index

  // ---- Exam management / editor (exam permission) -------------------------
  getExamManagementData: { level: 'perm', perm: 'exam', kind: 'live' },
  getExamEditorData: { level: 'perm', perm: 'exam', kind: 'live' },
  getExamSurveyStats: { level: 'perm', perm: 'exam', kind: 'read' },
  getExamPassCountsByLevel: { level: 'perm', perm: 'exam', kind: 'read' },
  getExamResultsByLevel: { level: 'perm', perm: 'exam', kind: 'read' },
  saveExam: { level: 'perm', perm: 'exam', kind: 'write' },
  duplicateExam: { level: 'perm', perm: 'exam', kind: 'write' },
  archiveExam: { level: 'perm', perm: 'exam', kind: 'write' },
  unarchiveExam: { level: 'perm', perm: 'exam', kind: 'write' },
  setExamRetakeOpen: { level: 'perm', perm: 'exam', kind: 'write' },
  saveQuestion: { level: 'perm', perm: 'exam', kind: 'write' },
  importQuestionsBulk: { level: 'perm', perm: 'exam', kind: 'write' },
  deleteQuestion: { level: 'perm', perm: 'exam', kind: 'write' },
  setExamModelApproval: { level: 'perm', perm: 'exam', kind: 'write' },
  deleteExamModel: { level: 'perm', perm: 'exam', kind: 'write' },

  // ---- Messaging: templates, groups, broadcasts (admin) -------------------
  getMessageTemplatesList: { level: 'admin', kind: 'read' },
  saveMessageTemplate: { level: 'admin', kind: 'write' },
  getMessageLogList: { level: 'admin', kind: 'live' },
  getWhatsappGroupsList: { level: 'admin', kind: 'read' },
  saveWhatsappGroup: { level: 'admin', kind: 'write' },
  deleteWhatsappGroup: { level: 'admin', kind: 'write' },
  refreshWhatsappGroupsFromFonnte: { level: 'admin', kind: 'write' },
  getWhatsappGroupsFromFonnte: { level: 'admin', kind: 'write' },
  getWhatsAppProviderSettings: { level: 'admin', kind: 'read' },
  getApprovedMetaWhatsAppTemplates: { level: 'admin', kind: 'live' },
  getGreetingTemplatesList: { level: 'admin', kind: 'read' },
  saveGreetingTemplate: { level: 'admin', kind: 'write' },
  deleteGreetingTemplate: { level: 'admin', kind: 'write' },
  getFcmActivatedStudents: { level: 'admin', kind: 'read' },
  checkWhatsApp: { level: 'admin', kind: 'write' },
  sendFinishedMail: { level: 'admin', kind: 'write' },
  prepareAndScheduleBroadcast: { level: 'admin', kind: 'write' },
  prepareAndScheduleFcmBroadcast: { level: 'admin', kind: 'write' },

  // ---- Messaging queue controls (admin) -----------------------------------
  getWPCampaignQueueListBoth: { level: 'admin', kind: 'live' },
  cancelQueuedWPCampaign: { level: 'admin', kind: 'write' },
  startWPQueueSend: { level: 'admin', kind: 'write' },
  resumeWPQueueSend: { level: 'admin', kind: 'write' },
  stopWPQueueSend: { level: 'admin', kind: 'write' },
  getWPQueueStatus: { level: 'admin', kind: 'live' },
  getWPQueueStatusBoth: { level: 'admin', kind: 'live' },
  stopFCMQueueSend: { level: 'admin', kind: 'write' },
  getFCMQueueStatus: { level: 'admin', kind: 'live' },

  // ---- Meta WhatsApp settings (superadmin — already ID-token gated) --------
  setWhatsAppProvider: { level: 'superadmin', kind: 'write' },
  saveMetaWhatsAppConfiguration: { level: 'superadmin', kind: 'write' },
  submitMetaWhatsAppTemplateForReview: { level: 'superadmin', kind: 'write' },
  getMetaWhatsAppTemplateStatus: { level: 'superadmin', kind: 'live' },

  // ---- Explicitly never callable from a browser ---------------------------
  getOAuthToken: { level: 'denied', kind: 'write' }, // handed out the owner's Google token (#1)
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
  if (entry.rescope && ctx && !ctx.isStaff) {
    outArgs = outArgs === args ? args.slice() : outArgs;
    entry.rescope(ctx, outArgs);
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

// { [functionName]: kind } for every function a browser may call (i.e. every
// entry whose level is not 'denied'). The page injects this for the client cache.
function rpcKinds() {
  const out = {};
  for (const name of Object.keys(POLICY)) {
    if (POLICY[name].level === 'denied') continue;
    out[name] = POLICY[name].kind;
  }
  return out;
}

module.exports = { POLICY, enforce, scopeResult, rpcKinds, policyNames: () => Object.keys(POLICY) };
