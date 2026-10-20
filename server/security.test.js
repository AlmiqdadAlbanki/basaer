'use strict';

// End-to-end HTTP regression suite for docs/SECURITY-FINDINGS.md. Boots the real
// server (production mode, dry-run outbound) against a throwaway database and
// proves each finding is closed at the HTTP boundary.

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.BASAER_TEST_PORT || '3177';
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Test@1234';
const ADMIN = '100000001';
const TEACHER = '100000003';
const STUDENT_A = '001234567';
const STUDENT_B = '003456789';

let tmpDir;
let child;
let childLog = '';

const tokens = {};

function serverEnv() {
  return Object.assign({}, process.env, {
    BASAER_DB: path.join(tmpDir, 'basaer.sqlite'),
    BASAER_KEYS: path.join(tmpDir, 'keys'),
    BASAER_FILES: path.join(tmpDir, 'files'),
    PORT,
    OUTBOUND_MODE: 'dry-run',
    NODE_ENV: 'production',
  });
}

async function rpc(fnName, args, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(`${BASE}/api/rpc/${encodeURIComponent(fnName)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args: args || [] }),
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, body };
}

// Same sequence the browser runs: gas loginWithPassword -> custom token ->
// POST /api/auth/exchange -> { accessToken (bearer), session cookie }.
async function exchangeLogin(cpr, password) {
  const login = await rpc('loginWithPassword', [cpr, password]);
  if (!login.body || !login.body.ok || !login.body.result || !login.body.result.ok) return null;
  const res = await fetch(`${BASE}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customToken: login.body.result.token }),
  });
  if (res.status !== 200) return null;
  const setCookie = res.headers.get('set-cookie') || '';
  const cookieMatch = /basaer_session=([^;]+)/.exec(setCookie);
  return { accessToken: (await res.json()).accessToken, sessionCookie: cookieMatch ? 'basaer_session=' + cookieMatch[1] : null, setCookie };
}

async function tryLogin(cpr, password) {
  const session = await exchangeLogin(cpr, password);
  return session ? session.accessToken : null;
}

async function loginAs(cpr, password) {
  const token = await tryLogin(cpr, password);
  assert.ok(token, `login failed for ${cpr}`);
  return token;
}

function expectStatus(response, status, label) {
  assert.strictEqual(response.status, status, `${label || 'request'}: expected ${status}, got ${response.status} ${JSON.stringify(response.body)}`);
}

function expectNotAllowed(response, label) {
  assert.ok(response.status === 401 || response.status === 403 || response.status === 404,
    `${label || 'request'}: expected 401/403/404, got ${response.status} ${JSON.stringify(response.body)}`);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(privateKey, payload) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createSign('RSA-SHA256').update(header + '.' + body).sign(privateKey);
  return header + '.' + body + '.' + b64url(sig);
}

async function upload(token, { folderId, fileName, bytes, declaredType }) {
  const form = new FormData();
  form.append('folderId', folderId);
  form.append('fileName', fileName);
  form.append('file', new Blob([bytes], { type: declaredType || 'application/octet-stream' }), fileName);
  const res = await fetch(`${BASE}/api/upload/student-work`, {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
    body: form,
  });
  let body = null;
  try { body = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, body };
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-sec-'));
  const env = serverEnv();
  const seed = spawnSync('node', ['tools/seed.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(seed.status, 0, 'seed failed: ' + seed.stdout + seed.stderr);

  child = spawn('node', ['server/index.js'], { cwd: ROOT, env });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      healthy = r.ok && (await r.json()).ok === true;
    } catch (_) { /* not up yet */ }
    if (!healthy) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(healthy, 'server did not become healthy:\n' + childLog);

  tokens.admin = await loginAs(ADMIN, PASSWORD);
  tokens.teacher = await loginAs(TEACHER, PASSWORD);
  tokens.studentA = await loginAs(STUDENT_A, PASSWORD);
  tokens.studentB = await loginAs(STUDENT_B, PASSWORD);
});

test.after(async () => {
  if (child) {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('#1 owner OAuth token: getOAuthToken is denied for admin and anonymous', async () => {
  expectStatus(await rpc('getOAuthToken', [], tokens.admin), 403, 'admin getOAuthToken');
  // 'denied' is checked before authentication, so anonymous gets 403 (never 200).
  expectNotAllowed(await rpc('getOAuthToken', []), 'anonymous getOAuthToken');
});

test('#2 password set without proof: setPassword is rescoped to the caller', async () => {
  expectStatus(await rpc('setPassword', [STUDENT_A, 'Whatever@1']), 401, 'anonymous setPassword');

  const NEW_PASSWORD = 'Changed@5678';
  const res = await rpc('setPassword', [STUDENT_B, NEW_PASSWORD], tokens.studentA);
  expectStatus(res, 200, 'student A setPassword(B)');
  try {
    assert.ok(await tryLogin(STUDENT_B, PASSWORD), 'B must still log in with the original password');
    assert.ok(await tryLogin(STUDENT_A, NEW_PASSWORD), 'A password must have changed');
    assert.strictEqual(await tryLogin(STUDENT_A, PASSWORD), null, 'A old password must no longer work');
  } finally {
    const restore = await rpc('setPassword', [STUDENT_A, PASSWORD], tokens.studentA);
    expectStatus(restore, 200, 'restore A password');
  }
  assert.ok(await tryLogin(STUDENT_A, PASSWORD), 'A restored');
});

test('#3 full student table before login: getPersons requires auth and is scoped', async () => {
  expectStatus(await rpc('getPersons', []), 401, 'anonymous getPersons');

  const student = await rpc('getPersons', [], tokens.studentA);
  expectStatus(student, 200, 'student getPersons');
  const rows = student.body.result;
  assert.ok(Array.isArray(rows), 'student result should be an array');
  assert.ok(rows.length >= 1, 'student should see own row');
  for (const row of rows) assert.strictEqual(Number(row.cpr), Number(STUDENT_A));

  const admin = await rpc('getPersons', [], tokens.admin);
  expectStatus(admin, 200, 'admin getPersons');
  assert.ok(Array.isArray(admin.body.result) && admin.body.result.length >= 3);
});

test('#8 authorization from browser CPR: loginData is rescoped to the caller', async () => {
  const mine = await rpc('loginData', [STUDENT_A], tokens.studentA);
  const spoof = await rpc('loginData', [STUDENT_B], tokens.studentA);
  expectStatus(spoof, 200, 'student loginData(B)');
  // The spoofed call must return exactly what the caller's own CPR returns.
  assert.deepStrictEqual(spoof.body.result, mine.body.result);
  const bText = JSON.stringify(spoof.body.result || '');
  assert.ok(!bText.includes(STUDENT_B), 'must not contain B CPR');
  // 'all' is admin-only.
  expectStatus(await rpc('loginData', ['all'], tokens.studentA), 403, 'student loginData(all)');
  assert.notStrictEqual((await rpc('loginData', ['all'], tokens.admin)).status, 403);
});

test('staff/permissions editable by anyone: admin-only staff functions refuse students and teachers', async () => {
  for (const fn of ['addStaff', 'updateStaff']) {
    expectStatus(await rpc(fn, ['x'], tokens.studentA), 403, `student ${fn}`);
    expectStatus(await rpc(fn, ['x'], tokens.teacher), 403, `teacher ${fn}`);
    expectStatus(await rpc(fn, ['x']), 401, `anonymous ${fn}`);
    const admin = await rpc(fn, ['x'], tokens.admin);
    assert.ok(admin.status !== 403 && admin.status !== 401, `admin ${fn} got ${admin.status}`);
  }
});

test('trigger handlers and queue controls are not callable from the browser', async () => {
  for (const fn of ['monitorExamSessions', 'continueCertificates', 'fixStudentCardsSharing']) {
    const admin = await rpc(fn, [], tokens.admin);
    assert.ok(admin.status === 403 || admin.status === 404, `admin ${fn} got ${admin.status}`);
    const student = await rpc(fn, [], tokens.studentA);
    assert.ok(student.status === 403 || student.status === 404, `student ${fn} got ${student.status}`);
    expectNotAllowed(await rpc(fn, []), `anonymous ${fn}`);
  }
});

test('dev endpoints are disabled in production even for admin', async () => {
  for (const p of ['/dev/outbox', '/dev/outbound', '/dev/triggers']) {
    const res = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tokens.admin } });
    assert.strictEqual(res.status, 404, p);
  }
});

test('forged or tampered session tokens are rejected', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const forged = signJwt(privateKey, { cpr: ADMIN, uid: 'u' + ADMIN, sub: 'u' + ADMIN, iat: now, exp: now + 3600 });
  expectStatus(await rpc('getFullAdminData', [], forged), 401, 'forged RS256');

  expectStatus(await rpc('getFullAdminData', [], 'aaaa.bbbb.cccc'), 401, 'garbage');
  const expired = signJwt(privateKey, { cpr: ADMIN, iat: now - 7200, exp: now - 3600 });
  expectStatus(await rpc('getFullAdminData', [], expired), 401, 'expired');

  const parts = tokens.admin.split('.');
  const sig = parts[2];
  const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  expectStatus(await rpc('getFullAdminData', [], parts[0] + '.' + parts[1] + '.' + flipped), 401, 'flipped signature');
  // Sanity: the untampered token works.
  assert.notStrictEqual((await rpc('getFullAdminData', [], tokens.admin)).status, 401);
});

test('unknown and private functions are refused', async () => {
  const unknown = await rpc('doesNotExist', [], tokens.admin);
  assert.ok(unknown.status === 403 || unknown.status === 404, 'doesNotExist ' + unknown.status);
  assert.notStrictEqual(unknown.status, 200);
  const priv = await rpc('findPersonByCpr_', [STUDENT_A], tokens.admin);
  assert.notStrictEqual(priv.status, 200);
  assert.ok(priv.status === 403 || priv.status === 404, 'private ' + priv.status);
});

test('student-work upload is confined to the caller folder and blocks executables', async () => {
  const other = await upload(tokens.studentA, { folderId: 'someoneElsesFolder', fileName: 'work.pdf', bytes: Buffer.from('%PDF-1.4 hi') });
  expectStatus(other, 403, 'foreign folder');

  expectStatus(await upload(null, { folderId: 'SEED', fileName: 'work.pdf', bytes: Buffer.from('%PDF-1.4 hi') }), 401, 'anonymous upload');

  // Seeded students all point at folder id SEED, so this reaches the type check.
  const exe = await upload(tokens.studentA, { folderId: 'SEED', fileName: 'evil.exe', bytes: Buffer.from('hello') });
  expectStatus(exe, 415, '.exe upload');
  const mz = await upload(tokens.studentA, { folderId: 'SEED', fileName: 'innocent.pdf', bytes: Buffer.from('MZ\x90\x00') });
  expectStatus(mz, 415, 'MZ signature upload');
});

// The browser-declared content type of an upload must never decide how the
// file is served back: a "pdf" declared as text/html would be stored XSS on
// the app's own origin.
test('uploaded files are served with a server-chosen content type, markup never inline', async () => {
  const fakePdf = await upload(tokens.studentA, { folderId: 'SEED', fileName: 'homework.pdf', bytes: Buffer.from('<script>alert(1)</script>'), declaredType: 'text/html' });
  expectStatus(fakePdf, 200, 'upload');
  const served = await fetch(fakePdf.body.url);
  assert.strictEqual(served.headers.get('content-type'), 'application/pdf');

  const unknown = await upload(tokens.studentA, { folderId: 'SEED', fileName: 'thing.xyz', bytes: Buffer.from('<html>'), declaredType: 'text/html' });
  expectStatus(unknown, 200, 'upload unknown type');
  const download = await fetch(unknown.body.url);
  assert.strictEqual(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition') || '', /^attachment/);
  assert.match(download.headers.get('content-security-policy') || '', /sandbox/);

  expectStatus(await upload(tokens.studentA, { folderId: 'SEED', fileName: 'page.html', bytes: Buffer.from('<b>x</b>') }), 415, '.html upload');
  expectStatus(await upload(tokens.studentA, { folderId: 'SEED', fileName: 'img.svg', bytes: Buffer.from('<svg/>') }), 415, '.svg upload');
});

test('file serving: unknown ids 404 and non-public files need authentication', async () => {
  expectStatus({ status: (await fetch(`${BASE}/files/f_doesnotexist/x.pdf`)).status }, 404, 'unknown file');

  // Insert a private file directly into the throwaway database.
  const Database = require('better-sqlite3');
  const id = 'f_' + crypto.randomBytes(16).toString('hex');
  const db = new Database(path.join(tmpDir, 'basaer.sqlite'));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at) VALUES (?,?,?,?,?,0,0,0,?,?)')
    .run(id, 'secret.txt', 'text/plain', 6, null, now, now);
  db.close();
  fs.mkdirSync(path.join(tmpDir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'files', id), 'secret');

  const anon = await fetch(`${BASE}/files/${id}/secret.txt`);
  assert.ok(anon.status === 401 || anon.status === 403 || anon.status === 404, 'anonymous private file got ' + anon.status);
  const authed = await fetch(`${BASE}/files/${id}/secret.txt`, { headers: { Authorization: 'Bearer ' + tokens.studentA } });
  assert.strictEqual(authed.status, 200);

  const folder = await fetch(`${BASE}/files/folder/anything`);
  assert.strictEqual(folder.status, 401);
});

// A cookie-authenticated POST needs the custom header (cross-site pages cannot
// add it); GET file links work with the cookie alone; logout revokes the
// cookie server-side so a copied value stops working too.
test('session cookie: httpOnly, CSRF rule on POST, usable for GET links, revoked by logout', async () => {
  const session = await exchangeLogin(TEACHER, PASSWORD);
  assert.ok(session && session.sessionCookie, 'exchange must set the session cookie');
  assert.match(session.setCookie, /HttpOnly/i);
  assert.match(session.setCookie, /SameSite=Lax/i);

  const withHeader = await fetch(`${BASE}/api/rpc/getStaffList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'basaer', Cookie: session.sessionCookie },
    body: JSON.stringify({ args: [] }),
  });
  assert.strictEqual(withHeader.status, 200, 'cookie + header');

  const withoutHeader = await fetch(`${BASE}/api/rpc/getStaffList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session.sessionCookie },
    body: JSON.stringify({ args: [] }),
  });
  assert.strictEqual(withoutHeader.status, 401, 'cookie without header');

  const crossSite = await fetch(`${BASE}/api/rpc/getStaffList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'basaer', 'Sec-Fetch-Site': 'cross-site', Cookie: session.sessionCookie },
    body: JSON.stringify({ args: [] }),
  });
  assert.strictEqual(crossSite.status, 401, 'cross-site fetch metadata');

  // The session cookie value is not an access token and vice versa.
  const cookieAsBearer = await rpc('getStaffList', [], session.sessionCookie.split('=')[1]);
  expectStatus(cookieAsBearer, 401, 'session cookie used as bearer');

  // A fresh access token comes from the cookie.
  const refreshed = await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'X-Requested-With': 'basaer', Cookie: session.sessionCookie } });
  assert.strictEqual(refreshed.status, 200);
  assert.ok((await refreshed.json()).accessToken);

  const logout = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { 'X-Requested-With': 'basaer', Cookie: session.sessionCookie } });
  assert.strictEqual(logout.status, 200);
  const replayed = await fetch(`${BASE}/api/auth/session`, { method: 'POST', headers: { 'X-Requested-With': 'basaer', Cookie: session.sessionCookie } });
  assert.strictEqual(replayed.status, 401, 'revoked cookie replayed');
});

test('login gates: CPR-only login is off, Google-verified login needs a server-verified email', async () => {
  expectStatus(await rpc('skipEmailVerificationLogin', [STUDENT_A]), 403, 'skipEmailVerificationLogin');
  // Knowing a CPR and the email on file must not be enough (SECURITY-FINDINGS #6).
  expectStatus(await rpc('loginWithGoogleVerifiedEmail', [STUDENT_A, 'student1@example.com']), 403, 'loginWithGoogleVerifiedEmail');
});

test('/exec: oauthVerify is refused without a verifiable ID token; saveFcmToken needs a session', async () => {
  const exec = (body, headers) => fetch(`${BASE}/exec`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
  const forgedVerify = await exec({ action: 'oauthVerify', verifyToken: 'abc', ok: true, email: 'student1@example.com' });
  assert.ok(forgedVerify.status === 401 || forgedVerify.status === 503, 'oauthVerify without token got ' + forgedVerify.status);
  // Even if the relay result had been accepted, the login must not be.
  expectStatus(await rpc('checkOauthVerifyResult', ['abc']), 200, 'poll is public');
  expectStatus(await rpc('loginWithGoogleVerifiedEmail', [STUDENT_A, 'student1@example.com']), 403, 'login after forged verify');

  const anonymousFcm = await exec({ action: 'saveFcmToken', studentId: STUDENT_B, token: 'tok' });
  assert.strictEqual(anonymousFcm.status, 401, 'anonymous saveFcmToken');
  const studentFcm = await exec({ action: 'saveFcmToken', studentId: STUDENT_B, token: 'tok' }, { Authorization: 'Bearer ' + tokens.studentA });
  assert.strictEqual(studentFcm.status, 200, 'student saveFcmToken');
});

// The browser's emailVerified flag on registration is only honoured for an
// email the server itself saw verified (OTP or Google); otherwise the student
// is stored unverified and verifies at first login, as the gas code intends.
test('newStuReg cannot self-declare a verified email', async () => {
  const cpr = '004444444';
  const registration = await rpc('newStuReg', [{
    cpr, name: 'Fake Verified', gender: 'ذكر', dob: '2000-01-01', nationality: 'بحريني', phone: '33333333',
    mail: 'fake-verified@example.com', block: '101', area: 'x', pastStudies: '', didYou: '', emailVerified: true,
  }]);
  expectStatus(registration, 200, 'newStuReg');
  const persons = await rpc('getPersons', [], tokens.admin);
  const stored = (persons.body.result || []).find((p) => String(p.cpr) === cpr);
  assert.ok(stored, 'student was registered');
  assert.strictEqual(!!stored.emailVerified, false, 'emailVerified must not come from the browser');
});

// Last: it spends most of the per-IP credential budget.
test('repeated wrong passwords are throttled', async () => {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    last = await rpc('loginWithPassword', [TEACHER, 'definitely-wrong-' + attempt]);
    if (last.status === 429) break;
  }
  const lockedByService = last.status === 200 && last.body && last.body.result && /TOO_MANY|كثير/.test(JSON.stringify(last.body.result));
  assert.ok(last.status === 429 || lockedByService, 'expected 429 or a lockout reply, got ' + last.status + ' ' + JSON.stringify(last.body));
});
