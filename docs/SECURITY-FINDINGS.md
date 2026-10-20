# Basaer web app: security findings

**Date:** 4 October 2026
**Basis:** a read of the Apps Script source as cloned with `clasp` (16 server files, 29 HTML files).
**Not done:** nothing here was tried against basaerbh.com or any live deployment. Every statement
is what the code allows, with the file and line that shows it. The deployed version may differ
from this clone.

## Summary

Anyone who can open basaerbh.com, without logging in, can currently:

1. **Download the full student table**: national ID (CPR), name, phone, email, date of birth,
   nationality, area, and links to each student's Drive folder and ID card.
2. **Obtain a Google access token for the account that owns the app**, which opens that
   account's Drive, every spreadsheet, and very likely its Gmail.
3. **Take over any student or staff account**, including administrators, by setting a new
   password for it.
4. **Act as an administrator**: add themselves to the staff list, change exam content, accept or
   reject students, and send WhatsApp and push messages in the academy's name.

None of this needs a password, a stolen session or any special tool. Each one is a single
function call from the browser's developer console on the public page.

Findings 1 to 4 below are critical and can be closed on the live Apps Script app now, before
any migration. The section "What to do on the live app this week" lists those steps.

## Why this happens

Three properties of the current setup combine:

- **The app runs as its owner for everyone.** `appsscript.json` sets
  `"executeAs": "USER_DEPLOYING"` and `"access": "ANYONE_ANONYMOUS"`. Every server function runs
  with the owner's full Google permissions, whoever the visitor is.
- **Every function is public.** Apps Script lets the browser call any top-level function whose
  name does not end in `_`. This project has 242 of them, including trigger handlers, debug
  helpers and maintenance scripts. The pages only *use* about 176, but all 242 are reachable.
- **The server does not know who is calling.** Login gives the browser a Firebase session, but
  server functions never see it. They receive a CPR as an ordinary argument and believe it.
  The one exception is `requireVerifiedSuperAdmin_` (`dataPost.js:974`), which checks the
  Firebase ID token properly. It protects 4 functions out of 242.

The login screen therefore protects the *pages*, not the *data*. A visitor who skips the pages
and calls the functions directly is not stopped by anything.

## Findings

| # | Severity | Finding |
|---|---|---|
| 1 | Critical | The owner's Google access token is given to any visitor |
| 2 | Critical | Any account's password can be set without proof |
| 3 | Critical | The full student table is sent to visitors before login |
| 4 | Critical | Admin rights are decided by a CPR the browser supplies |
| 5 | High | Login by CPR alone ("skip email verification") |
| 6 | High | "Verified by Google" accepts an email typed by the caller |
| 7 | High | First login lets the caller choose where the code is emailed |
| 8 | High | Any student's records can be read or changed by CPR |
| 9 | High | Messaging queues and attendance can be driven by anyone |
| 10 | Medium | Trigger handlers, debug and maintenance functions are callable |
| 11 | Medium | Secrets are stored in source code and in a spreadsheet cell |
| 12 | Medium | Registration trusts the browser's "email verified" flag |
| 13 | Low | Smaller weaknesses |

---

### 1. The owner's Google access token is given to any visitor (Critical)

**Evidence.** `dataPost.js:4390`:

```js
function getOAuthToken() {
  return ScriptApp.getOAuthToken();
}
```

The student-work upload calls it from the browser (`funcs-js.html:4398`) and then uploads
straight to the Drive API with `Authorization: Bearer <token>`.

**What a visitor can do.** Call `google.script.run.getOAuthToken()` from the console on the
public page. The reply is a live access token for the owner's account, valid for about an hour,
and a fresh one is available on every call. With it, using Google's ordinary REST APIs, they can:

- read, download, change or delete any file in the owner's Drive, including all student
  folders, ID cards, certificates and templates;
- read and edit all seven spreadsheets directly. That includes the WhatsApp provider token kept
  in the `main` sheet and the exam questions with their correct answers;
- very likely read and send mail as the owner. The script uses `GmailApp`, which normally makes
  Apps Script request the full `https://mail.google.com/` scope. The exact scope list is shown
  under Project Settings in the Apps Script editor.

This is the most serious finding because it reaches beyond the app to the whole Google account.

**Fix on Apps Script now.** Rename the function to `getOAuthToken_` so the browser cannot call
it, and change the upload to send the file through a server function (the same way
`uploadProfileAvatar` already does with base64). Then remove the app's access under
myaccount.google.com → Security → Third-party access and re-authorize it, in case a token has
already been taken.

**Fix in the new server.** The function is removed. Uploads go to an authenticated endpoint on
our own server and no Google token ever reaches a browser.

---

### 2. Any account's password can be set without proof (Critical)

**Evidence.** `auth.js:513`, `setPassword(cpr, password)`. It validates the CPR format and the
password length, then sets the password in Firebase with admin rights. It does not ask for the
old password, a login code or a session.

**What a visitor can do.** Call `setPassword('<any CPR>', '<new password>')`, then log in
normally with that CPR and password. `loginWithPassword` (`auth.js:457`) will accept it,
because `setPassword` also marks the account as having a password. This works for students,
staff and administrators alike. The real owner is locked out until they reset it.

**Fix on Apps Script now.** Make `verifyLoginCode` return a one-time ticket (a random value
stored in `CacheService` for a few minutes against that CPR) and make `setPassword` require it.
A logged-in user changing their password should go through `changePassword`, which should
always require the current password.

**Fix in the new server.** Setting a password requires either the caller's own verified session
or the one-time ticket from a successful code check.

---

### 3. The full student table is sent to visitors before login (Critical)

**Evidence.** `dataGet.js:86`, `getPersons()`, takes no arguments and returns every accepted
student with these fields: `cpr`, `name`, `phone`, `mail`, `dob`, `nationality`, `gender`,
`block`, `area`, `pastStudies`, `folderUrl`, `cardUrl`, `mazhab`, class and level fields.

The page calls it on every load, before any login (`js.html:2068`, `getAllStudent()` inside
`loadStartData()`), so the whole table is already sitting in the memory of every visitor's
browser. A comment at `auth.js:125-130` shows this problem was noticed and fixed for the login
page's "is this CPR registered" check, but the page-load call remained.

Related functions with the same problem:

- `loginData('all')` (`dataGet.js:52-55`) returns every staff member with CPR, phone, email
  and each permission flag, including who is an administrator.
- `getStaffList()` (`dataGet.js:2573`) returns the staff list.
- `getMessageLogList()` (`dataGet.js:2105`) returns up to 1,000 rows of message history.
- `getFcmActivatedStudents()` (`dataGet.js:2027`) lists students with push enabled.

**What a visitor can do.** Open the site and read the variable `allStuData` in the console, or
call `getPersons()` directly. The result is a complete export of students' personal data,
including national ID numbers. The `folderUrl` and `cardUrl` values point to Drive files shared
as "anyone with the link", so each student's ID card and certificates are one click further.

**Fix on Apps Script now.** Remove the `getAllStudent()` call from `loadStartData()` and load
the list only after a staff login. Add a caller check to `getPersons`, `loginData`,
`getStaffList` and `getMessageLogList` (see finding 4 for the check to use).

**Fix in the new server.** These functions are staff-only. A student receives only their own
record.

---

### 4. Admin rights are decided by a CPR the browser supplies (Critical)

**Evidence.** `dataPost.js:4586`, `hasExamPermission(userCpr)`, looks `userCpr` up in the `emp`
sheet and returns that person's permissions. It is the access check for about 49 call sites.
`userCpr` is whatever the browser sent.

Some administrative functions have no check at all:

- `addStaff`, `updateStaff`, `deleteStaff` (`dataPost.js:4484-4567`)
- `setStudentsQrCard` (`oldJS.js:17`): accept or reject a student, which creates Drive files
  and sends the acceptance email
- `setRegistrationStatus` (`dataPost.js:1880`): open or close registration
- `addManualAttendance`, `deleteAttendance` (`dataPost.js:179`, `416`)

**What a visitor can do.**

- Call `loginData('all')` (finding 3) to learn an administrator's CPR, then pass that CPR as
  `userCpr` to any protected function. The check passes.
- Or skip that and call `addStaff({cpr: ..., name: ..., ...})` with the management permission
  set, creating their own administrator.

From there every admin feature is open: edit or delete exams and questions, issue
certificates, change stage settings, and schedule WhatsApp or push broadcasts to all students.

**Fix on Apps Script now.** The project already contains the right check in
`requireVerifiedSuperAdmin_` (`dataPost.js:974`): the browser sends its Firebase ID token, the
server asks Firebase who it belongs to, and compares that with the account. Generalize it into
one helper, for example `requireCaller_(idToken)`, that returns the verified CPR. Have the
browser pass `await firebase.auth().currentUser.getIdToken()` with every call, and have every
function use the returned CPR instead of a CPR argument. This is a large mechanical change (the
browser has 230 call sites), which is one reason the migration is a good moment to do it.

**Fix in the new server.** All calls pass through a single entry point. It verifies the ID
token, loads the caller's role from the database, and checks an allowlist that states who may
call each function. CPR arguments are overwritten with the caller's own CPR unless the caller
is staff with the right permission.

---

### 5. Login by CPR alone, "skip email verification" (High)

**Evidence.** `auth.js:330`, `skipEmailVerificationLogin(cpr)`, returns a login token for any
CPR that exists. It then emails a security notice to the address on file.

The comment above it (`auth.js:321-328`) records that this was a deliberate decision, made
knowing the risk, to help people who have lost access to their email.

**What a visitor can do.** Call it with any valid CPR and receive a working session for that
person. CPRs are not secret: finding 3 lists them all, and `checkCprStatus` (`auth.js:98`)
confirms whether any guessed number exists.

**Fix.** This is a policy choice for the academy, so the new server keeps the feature behind a
switch that is off by default. A safer way to meet the same need is for an administrator to
issue a one-time login link to a person they have identified.

---

### 6. "Verified by Google" accepts an email typed by the caller (High)

**Evidence.** `auth.js:291`, `loginWithGoogleVerifiedEmail(cpr, verifiedEmail)`, compares the
`verifiedEmail` argument with the email on file and, if they match, returns a login token. The
server never sees proof from Google. Likewise `doPost` action `oauthVerify`
(`auth.js:379`) stores whatever email is posted to it.

**What a visitor can do.** Take a student's CPR and email from finding 3 and call the function
with both. The strings match, so a login token is returned.

**Fix.** The relay page must send the Google ID token itself, and the server must verify its
signature and read the email from inside it.

---

### 7. First login lets the caller choose where the code is emailed (High)

**Evidence.** `auth.js:217`, `requestLoginCode(cpr, emailInput)`. When the account's email is
not yet verified, the code is sent to `emailInput`. `verifyLoginCode` (`auth.js:404`) then
marks the account verified and overwrites the stored email with that address
(`auth.js:438-440`).

**What a visitor can do.** For any account that has never completed email verification, supply
their own address, receive the code, log in, and become the account's registered email.

**Fix.** For an unverified account, send the code only to the email already on file. Changing
that email should need an administrator.

---

### 8. Any student's records can be read or changed by CPR (High)

**Evidence.** These take a `cpr` argument and trust it:

- Read: `getMyProfileData(cpr)` (`dataGet.js:166`), `getAnswersData(cpr)` (`dataGet.js:369`),
  `getAttendance(cpr)` (`dataGet.js:270`), `getMyStageCertificates`.
- Write: `saveProfileData(cpr, payload)` (`dataPost.js:1999`), `uploadProfileAvatar`
  (`dataPost.js:2046`), `linkVerifiedEmailToProfile` (`auth.js:672`).
- Exams: `getQuestions(cpr, examId)` (`dataGet.js:591`) starts an exam attempt in another
  student's name; `submitAnswerData(cpr, ...)` (`dataPost.js:604`) submits answers for them.

**What a visitor can do.** Read any student's profile, results and attendance; change their
phone, email or photo; use up or sabotage their exam attempt.

**Fix.** The same caller check as finding 4. A student may only act on their own CPR.

---

### 9. Messaging queues and attendance can be driven by anyone (High)

**Evidence.**

- `startWPQueueSend(recipients, msg)` (`wpQueue.js:361`) queues WhatsApp messages to phone
  numbers supplied by the caller. Its only guard is a provider setting, not the caller.
- `stopWPQueueSend`, `resumeWPQueueSend`, `cancelQueuedWPCampaign`, `stopFCMQueueSend`
  (`wpQueue.js:252`, `541`, `580`; `fcmQueue.js:191`) have no check.
- `startQrSession(staffName)` (`dataPost.js:152`) hands out a 6-hour token that authorizes
  writing attendance through `doPost`.
- `doPost` action `saveFcmToken` (`FCMService.js:107`) registers a device for any student CPR.

**What a visitor can do.** Send WhatsApp messages from the academy's number to numbers of their
choosing (when the provider setting allows individual sends), stop a running campaign, mark
attendance for any student, or register their own phone to receive a student's notifications.
Messages from the academy's own number are a ready-made phishing channel, and abuse can get the
number banned by WhatsApp.

**Fix.** Admin-only for the queue controls; staff-only for QR sessions; a logged-in student can
register a device only for themselves.

---

### 10. Trigger handlers, debug and maintenance functions are callable (Medium)

**Evidence.** Because of the naming rule, these are public: `processWPQueueTick`,
`processFCMQueueTick`, `continueCertificates`, `monitorExamSessions`,
`debugDeleteTriggersByHandler` (`debugTriggers.js:21`), `archiveExistingLevelData`
(`oldJS.js:327`), `fixStudentCardsSharing`, `deleteStudentFiles` (`code.js:311`),
`migrateSurveyLegacyRatings`, and others.

**What a visitor can do.** Run queue steps out of turn, delete the triggers that keep queues
moving, archive a student's results, or start bulk maintenance jobs.

**Fix on Apps Script now.** Delete the files whose own header says to delete them after
diagnosis (`debugTriggers.js`, `debugFiqhExam.js`, `FCMSetup.js`, `test.js`) and the dead
PDF.co functions.

**Fix in the new server.** Only functions on the allowlist can be called. Everything else,
including trigger handlers, is unreachable from the browser.

---

### 11. Secrets are stored in source code and in a spreadsheet cell (Medium)

**Evidence.**

- A PDF.co API key is hardcoded in `dataPost.js` (four uses between lines 4265 and 4375), in
  code that is no longer called.
- Two token-like strings sit at the end of comment lines in `code.js:188-189`, directly above
  the WhatsApp section. They look like old provider tokens.
- The live Fonnte (WhatsApp) token is read from a cell in the `main` sheet
  (`code.js:196-214`), so anyone with view access to that spreadsheet, or the token from
  finding 1, has it.

Stored correctly, in Script Properties and not in source: the Firebase service account, the
FCM private key and the Meta WhatsApp token.

**Fix.** Rotate the PDF.co key and both strings in `code.js`, and remove them from the code.
Move the Fonnte token to Script Properties now and to the server's environment file later.

---

### 12. Registration trusts the browser's "email verified" flag (Medium)

**Evidence.** `dataPost.js:1269`: `setByName('emailVerified', data.emailVerified !== false)`.
The value comes from the registration form's own payload.

**What a visitor can do.** Register with someone else's email address and have it recorded as
verified.

**Fix.** The server should record the email as verified only when it has itself confirmed a
code for that CPR and email within the last few minutes.

---

### 13. Smaller weaknesses (Low)

- **Login codes use `Math.random()`** (`auth.js:178`), which is not designed for secrets. Use
  a cryptographic source.
- **`checkCprStatus`** (`auth.js:98`) tells an anonymous caller whether a CPR exists, whether
  it has a password, and a masked email. That lets someone test guessed numbers in bulk.
- **Every issued file is public.** ID cards, certificates and photos are shared as "anyone with
  the link" (`dataPost.js:3384`). The links are hard to guess, but finding 3 lists them.
- **`XFrameOptionsMode.ALLOWALL`** (`code.js:241`) lets any website embed the app in a frame.
- **QR images are generated by a third party** (`api.qrserver.com`, `dataPost.js:3168`), which
  therefore receives the URL of every certificate.

## What to do on the live app this week

In order of value for effort:

1. Rename `getOAuthToken` to `getOAuthToken_`, route the student-work upload through a server
   function, then revoke and re-grant the app's Google access. *(Finding 1)*
2. Require a one-time ticket in `setPassword`. *(Finding 2)*
3. Remove `getAllStudent()` from page load. *(Finding 3)*
4. Add the ID-token check to `getPersons`, `loginData`, `getStaffList`, `addStaff`,
   `updateStaff`, `deleteStaff`, `setStudentsQrCard` and the queue controls. *(Findings 3, 4, 9)*
5. Send first-login codes only to the email on file, and verify the Google token on the
   server. *(Findings 6, 7)*
6. Delete the debug and test files, rotate the exposed keys, and move the Fonnte token out of
   the sheet. *(Findings 10, 11)*
7. Decide whether "skip email verification" stays. *(Finding 5)*

Steps 1 to 3 are small edits. Step 4 is the start of the full fix described in finding 4.

## How the new server closes these

| Finding | Status in the new server |
|---|---|
| 1 | Function removed; uploads handled by the server |
| 2, 5, 6, 7, 12 | Login functions rewritten to require server-side proof |
| 3, 4, 8, 9 | One entry point verifies the caller and enforces a per-function allowlist |
| 10 | Default deny: anything not on the allowlist cannot be called |
| 11 | Secrets live in an environment file outside the code |
| 13 | Cryptographic codes, rate limits, private file links, local QR generation |

Each row will have an automated test that makes the unauthenticated call and confirms it is
refused.

---

## Addendum (2026-10-20): production hardening

**Date:** 20 October 2026
**Basis:** a second read of the Node server in `server/` and of the Apps Script code it runs
(`gas/`), made before go-live. Same limits as above: nothing was tried against a live
deployment, and each statement is what the code allows, with the file and line that shows it.
Line numbers are those of the `gas/` files in this repository.

Five weaknesses were confirmed in this pass. Four of them are the same ones as findings 5, 6, 9
and 13 above, now with the exact path through the server and what closes it. The fifth, A4, is
new. All five are closed in the server and none needs a change to the `gas/` files, but A1 and A3
also depend on changes to pages outside this repository (named in each entry).

| # | Severity | Finding | Earlier finding |
|---|---|---|---|
| A1 | High | A login could be minted from a CPR and the email on file, without Google | 6 |
| A2 | High | Login by CPR alone had no switch | 5 |
| A3 | High | Anyone could overwrite a student's push token | 9 |
| A4 | Medium | Guessing passwords and login codes had no reliable server-side limit | new |
| A5 | Low | Login codes were drawn with `Math.random` | 13 |

### A1. A login could be minted from a CPR and the email on file (High)

**Evidence.** `gas/auth.js:291`, `loginWithGoogleVerifiedEmail(cpr, verifiedEmail)`, returns a
login token when the email it is given equals the email on file for the CPR. It never sees proof
from Google. The email it compares can be planted through `/exec` with `action: 'oauthVerify'`:
`gas/auth.js:379` (`handleOauthVerifyResult_`) stores the `ok` and `email` fields exactly as
posted.

**What it allowed.** Anyone who knew a CPR and the email registered to it could call the
function, or post a made-up "verified" result, and receive a working login for that person. Both
values were readable before login (finding 3).

**Fix.** `/exec` with `oauthVerify` now requires an `idToken`. `server/auth/google-token.js`
checks its signature against Google's published keys, its issuer, audience, expiry and
`email_verified`, and the server replaces whatever `email` and `ok` the page sent with the
verified email. That email is remembered in the server's memory for 5 minutes, and
`loginWithGoogleVerifiedEmail` is refused (403) for any email not remembered; the entry is used
up by one successful login. With neither `FIREBASE_PROJECT_ID` nor `GOOGLE_OAUTH_CLIENT_ID` set,
the whole path is refused (503 on `/exec`). The `google-signin-relay` page (outside this
repository) must send the ID token; until it does, Google sign-in fails closed and users sign in
with the emailed code or a password (`docs/DEPLOY.md`, section 5). Tests: `server/security.test.js`
("login gates", "/exec") and `server/auth/google-token.test.js`.

---

### A2. Login by CPR alone had no switch (High)

**Evidence.** `gas/auth.js:330`, `skipEmailVerificationLogin(cpr)`, returns a login token for any
CPR on file. The Apps Script version had no way to turn it off (see finding 5).

**What it allowed.** A working session as any student or staff member for anyone who knew or
guessed their CPR.

**Fix.** The server refuses the call (403) unless `ALLOW_CPR_ONLY_LOGIN=1` is set in
`/etc/basaer.env`. It is off by default, and the server prints a WARNING line at start-up while it
is on. Test: `server/security.test.js` ("login gates").

---

### A3. Anyone could overwrite a student's push token (High)

**Evidence.** `gas/FCMService.js:107`, `handleSaveFcmTokenRequest_(body)`, reached through
`/exec` with `action: 'saveFcmToken'`, takes `body.studentId` and saves `body.token` for that
student. Nothing checked who was calling.

**What it allowed.** Pointing a student's push notifications at an attacker's device (and so
reading them), or replacing a working token to stop the student receiving any.

**Fix.** `/exec` with `saveFcmToken` now needs a logged-in session (401 otherwise). For anyone who
is not staff, the server overwrites `studentId` with the caller's own CPR, so a student can only
register their own device. Because the session is a same-origin cookie, the `platform.html` push
page must be served from the app's own domain (`docs/DEPLOY.md`, sections 5 and 8). Test:
`server/security.test.js` ("/exec").

---

### A4. Guessing passwords and login codes had no reliable server-side limit (Medium)

**Evidence.**

- `gas/auth.js:271-277`: the limit of 5 wrong tries per login code is a counter read from the
  script cache, incremented and written back. Concurrent requests each read the same value, so
  parallel guesses are not all counted.
- The password store that stands in for Firebase Auth (`server/auth/identity-service.js`) had no
  limit on wrong passwords.
- The server put no limit, per client or per target, on calls that prove an identity or send a
  code. Only the legacy code's own cache-based counters and resend cooldown applied.

**What it allowed.** A script could try many codes against one CPR in parallel, or many passwords
against one email, at the speed of the server.

**Fix.** Limits at the HTTP boundary (`server/index.js`), counted in memory per process and
answered with 429 and a `Retry-After` header:

| Limit | Per | Allowed |
|---|---|---|
| `/api/auth/*` | IP | 30 per minute |
| RPC, not logged in | IP | 120 per minute |
| RPC, logged in | user | 600 per minute |
| Identity-proving calls (password login, code checks, Google and skip-verification login) | IP | 30 per 10 minutes |
| The same calls | CPR or email entered, from one IP | 10 per 10 minutes |
| The same calls | CPR or email entered, from any IP | 60 per 10 minutes |
| Asking for a login or registration code | CPR or email entered, from one IP | 5 per 10 minutes |
| Asking for a login or registration code | CPR or email entered, from any IP | 20 per 10 minutes |
| `/exec` | IP | 60 per minute |

And a lockout kept in the database table `auth_attempts`, so it is shared by all worker threads
and survives restarts: 10 wrong passwords for one email from one client address within 15
minutes lock that pair for 15 minutes, even for the right password. The lock is per address on
purpose: CPRs are not secret, and a lock on the email alone would let a stranger shut its owner
out by guessing wrong ten times. Guessing from many addresses is bounded by the "from any IP"
rows above. Unknown emails are counted and answered identically, so the reply does not show which
emails have accounts. An administrator lifts a lock with one SQL statement (`docs/DEPLOY.md`,
section 9). Tests: `server/security.test.js` ("repeated wrong passwords"),
`server/auth/identity-service.test.js`, `server/rate-limit.test.js`.

---

### A5. Login codes were drawn with `Math.random` (Low)

**Evidence.** `gas/auth.js:178`: `Math.floor(100000 + Math.random() * 900000)`. `Math.random` is
not designed for secrets and its output can be predicted from earlier output.

**Fix.** The `gas/` file is unchanged. The sandbox that runs it (`server/runtime.js`) gives it a
`Math` whose `random()` is backed by Node's cryptographic generator, so every `Math.random` in
the legacy code, the codes included, is now unpredictable.

---

### New defences in the server

| Area | What the server does |
|---|---|
| Sessions | Login sets an httpOnly cookie `basaer_session` (SameSite=Lax, Secure in production). It slides for `SESSION_TTL_DAYS` (default 7) up to an absolute 30 days. The page also gets a 15-minute access token that it keeps in memory only; the browser stores no token in localStorage. Logout revokes the session on the server, so a copied cookie stops working. |
| CSRF | A POST authenticated by the cookie must carry `X-Requested-With: basaer`, and is refused if the browser says it is cross-site (`Sec-Fetch-Site`). A cross-site page cannot add that header. |
| Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none'`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`. This ends the framing weakness in finding 13. HSTS is left to nginx once HTTPS works. |
| Error masking | In production a database error, crashed worker, timeout or code error reaches the user only as a generic message with a reference. The Arabic messages the legacy code writes for users still pass through. |
| Logging | One JSON line per API request in the journal: time, IP, method, path, status, duration, caller CPR and, on a server error, the reference. No request bodies. |
| Isolation | The HTTP thread never runs the legacy code. It runs on worker threads, and a call that hangs for 5 minutes is cut off by replacing its worker (any script lock it held is freed). |
| Uploaded files | The content type of a student upload is decided by the server from the file name, never taken from the browser; `.html`, `.svg` and executables are refused. Files are shown inline only when they are PDF, image, audio, video or plain text; anything else is a download with a sandboxing `Content-Security-Policy`. Without this, a file called `homework.pdf` uploaded as `text/html` would have run as a page on the app's origin for whoever opened it. |
| Registration | `newStuReg` records `emailVerified` only for an email this server saw verified (the registration code exchange, or Google); the browser's own flag is otherwise overridden to `false` and the student verifies at first login. This is the server-side half of finding 12. |

### Residual risks

What the administrator should know after the above:

1. **The QR attendance token is a shared secret, valid for 6 hours.** `startQrSession`
   (`gas/dataPost.js:152`) issues a random token that travels in the scanner page's link and
   authorizes `/exec` with `action: 'qrAttend'` (`gas/dataPost.js:159`). The request carries a
   CPR, and the server does not check that the CPR belongs to the person scanning. Anyone who
   sees the link while it is shown to a class can mark any CPR present until it expires, as many
   times as they like. The code has no function that cancels a session early. The only server
   limit is `/exec` at 60 requests a minute per IP. Start a session per class, do not share or
   photograph the link, and compare attendance against who was present.
2. **The data races in the legacy code are the legacy code's.** Check-then-write patterns (find
   a duplicate, then append; remember a row number, then delete) are still there. With the
   default of one interactive worker, users' calls never overlap each other. A call can still
   overlap a background job wherever the legacy code takes no lock, as on Apps Script, and
   raising `BASAER_RPC_WORKERS` brings back overlap between users. See `docs/DEPLOY.md`,
   [section 10](DEPLOY.md#10-capacity-and-scaling).
3. **`ALLOW_CPR_ONLY_LOGIN=1` reopens finding 5.** It exists because the academy chose that
   feature on Apps Script. While it is on, anyone who knows or guesses a CPR can log in as that
   person, and CPRs are not secret. Leave it off.
4. **The Google sign-in record is keyed by email, not by browser.** After a real Google check
   the server holds the verified email for up to 5 minutes. In that window, someone who knows the
   CPR and that email could call `loginWithGoogleVerifiedEmail` first. It needs both values and
   a victim who has just signed in with Google and not finished.
5. **The lockout can be used to lock someone out.** Anyone who knows an email can send 10 wrong
   passwords and lock it for 15 minutes. The lock expires by itself, and an administrator can lift
   it at once (`docs/DEPLOY.md`, section 9).
6. **The Content-Security-Policy is deliberately small.** The legacy page needs inline scripts and
   third-party assets, so the policy sets only framing, base-URI and plugin rules. It does not
   stop injected script. The session cookie cannot be read by script, and the in-memory access
   token lasts 15 minutes, which limits what injected script can do.
