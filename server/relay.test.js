'use strict';

// Checks for the two popup pages the legacy client opens (Google sign-in and the
// QR scanner) and for the serve-time rewrite that points the client at them.
//
// The pages are the original Firebase-hosted ones (website/google-signin-relay.html
// and website/qr-scan-relay.html of the old site) with a few deliberate changes, all
// marked "[الخادم الجديد المستضاف ذاتيًا]" in their comments. The tests below pin
// those changes, and run each page's real inline script in a bare vm context with a
// fake DOM, Firebase, html5-qrcode and fetch, so what the page does is checked
// without a browser.
//
// Nothing here starts a server: server/index.js listens as soon as it is required,
// so its wiring is checked by reading the source, and the URL rewrite lives in
// server/page-rewrites.js precisely so it can be tested directly.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { rewriteLegacyRelayUrls, LEGACY_RELAY_URL_REWRITES } = require('./page-rewrites.js');

const SERVER_DIR = __dirname;
const GAS_DIR = path.join(SERVER_DIR, '..', 'gas');
const RELAY_DIR = path.join(SERVER_DIR, 'client', 'relay');
const PAGES = ['google-signin.html', 'qr-scan.html'];

// Any reference to a page that used to live on Firebase Hosting, e.g. https://basaerbh.com/qr-scan-relay
const LEGACY_RELAY_URL_PATTERN = /basaerbh\.com\/[\w-]*-relay/i;
const APPS_SCRIPT_EXEC_URL_PATTERN = /script\.google\.com\/macros/i;

const VERIFY_TOKEN = '0b7e9a52-31c4-4b43-9d6f-9a1a0c7e44d1';
const SESSION_TOKEN = '5e1d7c52-91aa-4c39-8d52-0f6c1b0a77e3';
const APP_ORIGIN = 'https://app.example.test';

function readRelayPage(fileName) {
  return fs.readFileSync(path.join(RELAY_DIR, fileName), 'utf8');
}

function readGasFile(fileName) {
  return fs.readFileSync(path.join(GAS_DIR, fileName), 'utf8');
}

// The page's own script: the <script> without a src attribute.
function inlineScript(pageHtml) {
  const scripts = Array.from(pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g), (match) => match[1]);
  assert.strictEqual(scripts.length, 1, 'expected exactly one inline script');
  return scripts[0];
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Objects the page script creates belong to the vm's realm and never deepStrictEqual one made here;
// a JSON round trip brings them across.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- A fake DOM, just enough for the two pages -----------------------------------

function makeFakeElement(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    innerHTML: '',
    style: {},
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    handlers: {},
    get className() { return Array.from(classes).join(' '); },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    appendChild(child) { this.children.push(child); },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    click() { if (this.handlers.click) this.handlers.click(); },
  };
}

function makeFakeDocument() {
  const elements = new Map();
  const documentHandlers = {};
  return {
    elements,
    documentHandlers,
    document: {
      hidden: false,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeFakeElement(id));
        return elements.get(id);
      },
      createElement() { return makeFakeElement('created'); },
      createTreeWalker() { return { nextNode: () => null }; },
      addEventListener(type, handler) { documentHandlers[type] = handler; },
    },
  };
}

// A timer queue the test drives by hand (the pages use timers for closing, toasts and retries).
function makeFakeTimers() {
  const queued = [];
  return {
    queued,
    setTimeout(callback, delayMs) { queued.push({ callback, delayMs }); return queued.length; },
    clearTimeout() {},
    runAll() { const due = queued.splice(0); due.forEach((timer) => timer.callback()); },
  };
}

// ---- Google sign-in relay: run the page ------------------------------------------

// scenario: search, hasOpener, redirectPending (function returning a promise of the redirect result),
// attemptedBefore (sessionStorage marker), fetchImpl (function returning a promise of a fake Response).
// Returns { events, elements, timers, firebaseCalls } once the page has settled.
async function runGoogleRelayPage(scenario) {
  const events = [];
  const firebaseCalls = [];
  const { elements, document } = makeFakeDocument();
  const timers = makeFakeTimers();
  const storage = new Map(scenario.attemptedBefore ? [['basaerOauthAttempted', '1']] : []);
  const sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

  const authObject = {
    getRedirectResult: () => scenario.redirectPending ? scenario.redirectPending(events) : Promise.resolve({ user: null }),
    signInWithRedirect: (provider) => { events.push({ type: 'redirect', providerId: provider.providerId }); return new Promise(() => {}); },
  };
  function GoogleAuthProvider() { this.providerId = 'google.com'; }
  function OAuthProvider(providerId) { this.providerId = providerId; }
  const firebase = { initializeApp: (config) => firebaseCalls.push(config), auth: () => authObject };
  firebase.auth.GoogleAuthProvider = GoogleAuthProvider;
  firebase.auth.OAuthProvider = OAuthProvider;

  const windowObject = {
    location: { search: scenario.search === undefined ? `?provider=google&verifyToken=${VERIFY_TOKEN}` : scenario.search, origin: APP_ORIGIN },
    opener: scenario.hasOpener === false ? null : { postMessage: (message, targetOrigin) => events.push({ type: 'postMessage', message, targetOrigin }) },
    close: () => events.push({ type: 'close' }),
    addEventListener() {},
  };
  const context = vm.createContext({
    window: windowObject,
    document,
    firebase,
    sessionStorage,
    URLSearchParams,
    setTimeout: timers.setTimeout,
    fetch: (url, options) => {
      events.push({ type: 'fetch', url, options });
      return scenario.fetchImpl(url, options);
    },
  });
  vm.runInContext(inlineScript(readRelayPage('google-signin.html')), context, { filename: 'google-signin.html' });
  await settle();
  return { events, elements, timers, firebaseCalls, storage };
}

// What the Firebase user the redirect returns records, in order, when its methods are called.
function makeSignedInUser(events, overrides) {
  const options = Object.assign({ email: 'student.one@example.com', idToken: 'FIREBASE-ID-TOKEN', deleteFails: false }, overrides);
  return {
    email: options.email,
    getIdToken: () => { events.push({ type: 'getIdToken' }); return Promise.resolve(options.idToken); },
    delete: () => { events.push({ type: 'delete' }); return options.deleteFails ? Promise.reject(new Error('requires-recent-login')) : Promise.resolve(); },
  };
}

function fakeResponse(httpStatus, body) {
  return Promise.resolve({ ok: httpStatus >= 200 && httpStatus < 300, status: httpStatus, json: () => (body === undefined ? Promise.reject(new SyntaxError('not json')) : Promise.resolve(body)) });
}

const eventTypes = (events) => events.map((event) => event.type);

// ---- The pages: files and the contract with the legacy client --------------------

test('both relay pages exist, are right-to-left Arabic, and name neither a retired Firebase-hosted page nor Apps Script', () => {
  for (const fileName of PAGES) {
    const pageHtml = readRelayPage(fileName);
    assert.ok(pageHtml.length > 5000, `${fileName} looks empty`);
    assert.match(pageHtml, /^<!doctype html>/i, `${fileName} needs a doctype`);
    assert.match(pageHtml, /<html lang="ar" dir="rtl">/, `${fileName} must be an RTL Arabic page`);
    assert.doesNotMatch(pageHtml, LEGACY_RELAY_URL_PATTERN, `${fileName} still refers to a retired basaerbh.com relay page`);
    assert.doesNotMatch(pageHtml, APPS_SCRIPT_EXEC_URL_PATTERN, `${fileName} still posts to an Apps Script web app instead of /exec`);
    new vm.Script(inlineScript(pageHtml), { filename: fileName }); // throws on a syntax error
  }
});

test('google-signin: same Firebase project and SDK version as the legacy client; the original redirect flow is kept', () => {
  const pageHtml = readRelayPage('google-signin.html');
  const legacyClient = readGasFile('auth-js.html');
  // The relay must sign in against the project the legacy client's initFirebaseAuth() names.
  for (const key of ['apiKey', 'authDomain', 'projectId']) {
    const legacyValue = new RegExp(`${key}:\\s*"([^"]+)"`).exec(legacyClient);
    const relayValue = new RegExp(`${key}:\\s*"([^"]+)"`).exec(pageHtml);
    assert.ok(legacyValue && relayValue, `could not find ${key} in both files`);
    assert.strictEqual(relayValue[1], legacyValue[1], `${key} differs between the relay and gas/auth-js.html`);
  }
  assert.match(pageHtml, /gstatic\.com\/firebasejs\/10\.\d+\.\d+\/firebase-app-compat\.js/);
  assert.match(pageHtml, /gstatic\.com\/firebasejs\/10\.\d+\.\d+\/firebase-auth-compat\.js/);
  // Kept from the original on purpose (its comments explain why): redirect only, results picked up on every load.
  for (const needle of ['signInWithRedirect', 'getRedirectResult', 'basaerOauthAttempted', 'GoogleAuthProvider', "OAuthProvider('yahoo.com')"]) {
    assert.ok(pageHtml.includes(needle), `google-signin.html should still use ${needle}`);
  }
  assert.doesNotMatch(pageHtml, /\.signInWithPopup\(/, 'the original deliberately never opens a popup from this popup (its comments say why)');
});

test('google-signin: speaks the contract startOAuthRelay in gas/auth-js.html listens for and /exec expects', () => {
  const pageHtml = readRelayPage('google-signin.html');
  const legacyClient = readGasFile('auth-js.html');
  // The listener ignores any message whose source is not this string, and reads ok / email / message.
  assert.match(legacyClient, /data\.source !== 'basaer-oauth-relay'/);
  assert.match(legacyClient, /data\.ok && data\.email/);
  assert.match(legacyClient, /data\.message/);
  assert.doesNotMatch(legacyClient, /event\.origin/, 'the legacy listener does not check event.origin (if it starts to, the page must match)');
  // The legacy client opens the page with these query parameters.
  assert.match(legacyClient, /'\?provider=' \+ provider \+ '&verifyToken=' \+ encodeURIComponent\(verifyToken\)/);
  assert.match(pageHtml, /params\.get\('provider'\)/);
  assert.match(pageHtml, /params\.get\('verifyToken'\)/);
  assert.match(pageHtml, /source: 'basaer-oauth-relay'/);
  assert.match(pageHtml, /AUTH_EXEC_URL_ = '\/exec'/);
});

test('qr-scan: speaks the contract openQrScannerPage and handleQrAttendRequest_ define; the original scanner is kept', () => {
  const pageHtml = readRelayPage('qr-scan.html');
  const legacyClient = readGasFile('js.html');
  const legacyServer = readGasFile('dataPost.js');
  assert.match(legacyClient, /'\?t=' \+ Date\.now\(\) \+ '&session=' \+ encodeURIComponent\(token\)/);
  assert.match(pageHtml, /new URLSearchParams\(window\.location\.search\)\.get\('session'\)/);
  assert.match(legacyServer, /body\.token/);
  assert.match(legacyServer, /body\.cpr/);
  assert.match(legacyServer, /body\.perId/);
  assert.match(legacyServer, /body\.name/);
  assert.match(pageHtml, /\{ action: 'qrAttend', token: qrSessionToken_, cpr: payload\.cpr, perId: payload\.perId, name: payload\.name \}/);
  assert.match(pageHtml, /QR_EXEC_URL_ = '\/exec'/);
  // The original scanner library and settings.
  assert.match(pageHtml, /html5-qrcode@2\.3\.8\/html5-qrcode\.min\.js/);
  assert.match(pageHtml, /fps: 15/);
  assert.match(pageHtml, /useBarCodeDetectorIfSupported: true/);
});

// ---- Google sign-in relay: behaviour -----------------------------------------------

test('google-signin: a successful sign-in is verified by the server first, then announced to the opener on its own origin', async () => {
  const { events, elements, timers, firebaseCalls } = await runGoogleRelayPage({
    redirectPending: (recorded) => Promise.resolve({ user: makeSignedInUser(recorded) }),
    fetchImpl: () => fakeResponse(200, { status: 'ok' }),
  });

  assert.deepStrictEqual(firebaseCalls.map((config) => config.projectId), ['coming-soon-basaer']);
  // The ID token is taken while the temporary Firebase account still exists, the server step comes next, and only
  // after the server accepted does the app hear about it: the app logs in with this email straight away, and the
  // server refuses an email it has not verified yet.
  assert.deepStrictEqual(eventTypes(events), ['getIdToken', 'delete', 'fetch', 'postMessage']);

  const post = events.find((event) => event.type === 'fetch');
  assert.strictEqual(post.url, '/exec');
  assert.strictEqual(post.options.method, 'POST');
  assert.strictEqual(post.options.headers['Content-Type'], 'application/json');
  assert.strictEqual(post.options.credentials, 'same-origin');
  assert.deepStrictEqual(JSON.parse(post.options.body), { action: 'oauthVerify', verifyToken: VERIFY_TOKEN, idToken: 'FIREBASE-ID-TOKEN' },
    'exactly the token: no email or ok flag of its own');

  const announcement = events.find((event) => event.type === 'postMessage');
  assert.deepStrictEqual(plain(announcement.message), { source: 'basaer-oauth-relay', ok: true, email: 'student.one@example.com', provider: 'google' });
  assert.strictEqual(announcement.targetOrigin, APP_ORIGIN, "the message carries an address, so it goes to the page's own origin, never '*'");
  assert.match(elements.get('statusText').textContent, /تم التحقق بنجاح/);

  // The window closes a moment later, after the message had time to land.
  assert.ok(!eventTypes(events).includes('close'));
  timers.runAll();
  assert.strictEqual(eventTypes(events).pop(), 'close');
});

test('google-signin: the temporary account failing to delete changes nothing; yahoo reports its own provider name', async () => {
  const { events } = await runGoogleRelayPage({
    search: `?provider=yahoo&verifyToken=${VERIFY_TOKEN}`,
    redirectPending: (recorded) => Promise.resolve({ user: makeSignedInUser(recorded, { deleteFails: true }) }),
    fetchImpl: () => fakeResponse(200, { status: 'ok' }),
  });
  assert.deepStrictEqual(eventTypes(events), ['getIdToken', 'delete', 'fetch', 'postMessage']);
  assert.strictEqual(events.find((event) => event.type === 'postMessage').message.provider, 'yahoo');
});

test('google-signin: a token the server refuses is reported as a failure, never as a success', async () => {
  for (const reply of [
    () => fakeResponse(401, { status: 'error', message: 'تعذر التحقق من حساب جوجل: ID token email is not verified' }),
    () => fakeResponse(503, { status: 'error', message: 'تسجيل الدخول عبر جوجل غير مفعّل على هذا الخادم.' }),
    () => fakeResponse(200, { status: 'error', message: 'بيانات غير مكتملة' }),
    () => fakeResponse(502, undefined),
    () => Promise.reject(new TypeError('Failed to fetch')),
  ]) {
    const { events, elements, timers } = await runGoogleRelayPage({
      redirectPending: (recorded) => Promise.resolve({ user: makeSignedInUser(recorded) }),
      fetchImpl: reply,
    });
    const announcements = events.filter((event) => event.type === 'postMessage');
    assert.strictEqual(announcements.length, 1);
    assert.strictEqual(announcements[0].message.ok, false, 'a refused token must not be announced as verified');
    assert.strictEqual(announcements[0].message.email, undefined);
    assert.match(announcements[0].message.message, /[؀-ۿ]/, 'the opener shows this text to the user');
    assert.strictEqual(announcements[0].targetOrigin, APP_ORIGIN);
    assert.ok(elements.get('statusText').classList.contains('error'));
    timers.runAll();
    assert.strictEqual(eventTypes(events).pop(), 'close');
  }
  // The server's own words reach the opener.
  const { events } = await runGoogleRelayPage({
    redirectPending: (recorded) => Promise.resolve({ user: makeSignedInUser(recorded) }),
    fetchImpl: () => fakeResponse(503, { status: 'error', message: 'تسجيل الدخول عبر جوجل غير مفعّل على هذا الخادم.' }),
  });
  assert.strictEqual(events.find((event) => event.type === 'postMessage').message.message, 'تسجيل الدخول عبر جوجل غير مفعّل على هذا الخادم.');
});

test('google-signin: without an opener (the redirect drops it) the server step still happens and the window still closes', async () => {
  const { events, timers } = await runGoogleRelayPage({
    hasOpener: false,
    redirectPending: (recorded) => Promise.resolve({ user: makeSignedInUser(recorded) }),
    fetchImpl: () => fakeResponse(200, { status: 'ok' }),
  });
  assert.deepStrictEqual(eventTypes(events), ['getIdToken', 'delete', 'fetch']);
  timers.runAll();
  assert.strictEqual(eventTypes(events).pop(), 'close');
});

test('google-signin: opened without a verifyToken, a success is announced and closed without a server step (as the original)', async () => {
  const { events, timers } = await runGoogleRelayPage({
    search: '?provider=google',
    redirectPending: (recorded) => Promise.resolve({ user: makeSignedInUser(recorded) }),
    fetchImpl: () => assert.fail('nothing to post without a verifyToken'),
  });
  assert.deepStrictEqual(eventTypes(events), ['getIdToken', 'delete', 'postMessage']);
  timers.runAll();
  assert.strictEqual(eventTypes(events).pop(), 'close');
});

test('google-signin: a first visit waits for the button, then leaves for the provider and remembers that it did', async () => {
  for (const [provider, expectedProviderId] of [['google', 'google.com'], ['yahoo', 'yahoo.com'], [undefined, 'google.com'], ['unknown-provider', 'google.com']]) {
    const search = provider ? `?provider=${provider}&verifyToken=${VERIFY_TOKEN}` : `?verifyToken=${VERIFY_TOKEN}`;
    const { events, elements, storage } = await runGoogleRelayPage({ search, fetchImpl: () => assert.fail('no post before sign-in') });
    assert.deepStrictEqual(events, [], 'nothing is sent anywhere until the user presses the button');
    assert.strictEqual(elements.get('startBtn').style.display, '', 'the button is shown');
    assert.strictEqual(storage.has('basaerOauthAttempted'), false);

    elements.get('startBtn').click();
    assert.deepStrictEqual(events, [{ type: 'redirect', providerId: expectedProviderId }]);
    assert.strictEqual(storage.get('basaerOauthAttempted'), '1', 'so that coming back with nothing is not mistaken for a first visit');
    assert.strictEqual(elements.get('startBtn').style.display, 'none');
  }
});

test('google-signin: cancelling at the provider only says so in the window', async () => {
  for (const code of ['auth/popup-closed-by-user', 'auth/user-cancelled', 'auth/redirect-cancelled-by-user']) {
    const { events, elements, timers } = await runGoogleRelayPage({
      attemptedBefore: true,
      redirectPending: () => Promise.reject({ code, message: 'cancelled' }),
      fetchImpl: () => assert.fail('no post after a cancel'),
    });
    assert.deepStrictEqual(events, [], `${code}: nothing is posted to the opener or the server`);
    assert.match(elements.get('statusText').textContent, /تم إلغاء العملية/);
    assert.strictEqual(elements.get('startBtn').style.display, '', 'the button comes back for another try');
    assert.strictEqual(timers.queued.length, 0, 'and the window stays open');
  }
});

test('google-signin: other sign-in failures, and coming back from the provider with nothing, are reported to the opener', async () => {
  const failures = [
    { label: 'a provider error', scenario: { redirectPending: () => Promise.reject({ code: 'auth/internal-error', message: 'Firebase: Error (auth/internal-error).' }) }, text: 'Firebase: Error (auth/internal-error).' },
    { label: 'no result after an attempt', scenario: { attemptedBefore: true, redirectPending: () => Promise.resolve({ user: null }) }, text: /getRedirectResult/ },
    { label: 'an account without an email', scenario: { redirectPending: () => Promise.resolve({ user: { email: '' } }) }, text: /بريد إلكتروني/ },
  ];
  for (const failure of failures) {
    const { events, elements, timers } = await runGoogleRelayPage(Object.assign({ fetchImpl: () => assert.fail('no post without an ID token') }, failure.scenario));
    assert.deepStrictEqual(eventTypes(events), ['postMessage'], failure.label);
    const message = events[0].message;
    assert.strictEqual(message.source, 'basaer-oauth-relay');
    assert.strictEqual(message.ok, false);
    assert.match(message.message, failure.text instanceof RegExp ? failure.text : new RegExp(failure.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.strictEqual(events[0].targetOrigin, APP_ORIGIN);
    assert.ok(elements.get('statusText').classList.contains('error'));
    timers.runAll();
    assert.strictEqual(eventTypes(events).pop(), 'close');
  }
});

// ---- QR scanner relay: run the page ------------------------------------------------

// scenario: search, fetchImpl. Returns what the page did; scan(text) feeds a decoded code to the page the way
// html5-qrcode does, and the clock moves with advance(ms).
function runQrScanPage(scenario) {
  const events = [];
  const clock = { now: Date.UTC(2026, 9, 20, 8, 0, 0) };
  const { elements, document, documentHandlers } = makeFakeDocument();
  const timers = makeFakeTimers();
  const scanner = { constructed: [], onScanSuccess: null };
  class FakeHtml5QrcodeScanner {
    constructor(elementId, config) { scanner.constructed.push({ elementId, config }); }
    render(onScanSuccess) { scanner.onScanSuccess = onScanSuccess; }
    clear() {}
  }
  class FakeDate extends Date { static now() { return clock.now; } }

  const context = vm.createContext({
    window: { location: { search: scenario.search === undefined ? `?t=1&session=${SESSION_TOKEN}` : scenario.search }, addEventListener() {} },
    document,
    Date: FakeDate,
    URLSearchParams,
    AbortController,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Html5QrcodeScanner: FakeHtml5QrcodeScanner,
    MutationObserver: class { observe() {} },
    NodeFilter: { SHOW_TEXT: 4 },
    Audio: class { play() { events.push({ type: 'beep' }); } },
    fetch: (url, options) => {
      events.push({ type: 'fetch', url, options });
      return scenario.fetchImpl(url, options);
    },
  });
  vm.runInContext(inlineScript(readRelayPage('qr-scan.html')), context, { filename: 'qr-scan.html' });
  return {
    events,
    elements,
    scanner,
    timers,
    documentHandlers,
    scan: async (text) => { scanner.onScanSuccess(text); await settle(); },
    advance: (ms) => { clock.now += ms; },
    toast: () => elements.get('toast').className + ' | ' + elements.get('toast').textContent,
    fetchCount: () => events.filter((event) => event.type === 'fetch').length,
  };
}

const okReply = (studentName) => () => fakeResponse(200, { status: 'ok', studentName });

test('qr-scan: opened from the admin page it starts the original scanner; opened directly it does not', () => {
  const page = runQrScanPage({ fetchImpl: okReply('x') });
  assert.strictEqual(page.scanner.constructed.length, 1);
  assert.strictEqual(page.scanner.constructed[0].elementId, 'reader');
  assert.strictEqual(page.scanner.constructed[0].config.fps, 15);
  assert.strictEqual(page.scanner.constructed[0].config.experimentalFeatures.useBarCodeDetectorIfSupported, true);
  assert.strictEqual(typeof page.scanner.onScanSuccess, 'function');
  assert.notStrictEqual(page.elements.get('notOpened') && page.elements.get('notOpened').style.display, 'block');

  for (const search of ['?t=1', '', `?t=1&session=`]) {
    const direct = runQrScanPage({ search, fetchImpl: okReply('x') });
    assert.strictEqual(direct.scanner.constructed.length, 0, `${JSON.stringify(search)}: no camera without a session`);
    assert.strictEqual(direct.elements.get('notOpened').style.display, 'block');
    assert.strictEqual(direct.elements.get('mainArea').style.display, 'none');
  }
});

test('qr-scan: a card is sent to /exec as JSON on the same origin with the session token, and the server answer is shown at once', async () => {
  const page = runQrScanPage({ fetchImpl: okReply('أحمد الطالب') });
  await page.scan('{"cpr":"001234567","name":"أحمد","perId":"48213"}');

  assert.strictEqual(page.fetchCount(), 1);
  const post = page.events.find((event) => event.type === 'fetch');
  assert.strictEqual(post.url, '/exec');
  assert.strictEqual(post.options.method, 'POST');
  assert.strictEqual(post.options.headers['Content-Type'], 'application/json');
  assert.strictEqual(post.options.credentials, 'same-origin');
  // What the original forwarded from the card: the CPR, and the name and identifying code the older cards carry.
  assert.deepStrictEqual(JSON.parse(post.options.body), { action: 'qrAttend', token: SESSION_TOKEN, cpr: '001234567', perId: '48213', name: 'أحمد' });

  assert.match(page.toast(), /toast show success \| تم تسجيل حضور: أحمد الطالب/);
  assert.strictEqual(page.elements.get('scanCount').textContent, 1);
});

test('qr-scan: duplicates, errors and a dead network each get their own message', async () => {
  const replies = [
    { reply: () => fakeResponse(200, { status: 'duplicate', message: 'تم تسجيل حضور أحمد مسبقًا اليوم', studentName: 'أحمد' }), toast: /toast show info \| تم تسجيل حضور أحمد مسبقًا اليوم/ },
    { reply: () => fakeResponse(200, { status: 'error', message: 'انتهت صلاحية الجلسة (6 ساعات)، أعد فتح قارئ QR من لوحة الإدارة' }), toast: /toast show error \| انتهت صلاحية الجلسة/ },
    { reply: () => fakeResponse(429, { ok: false, error: 'عدد المحاولات كبير', scope: 'exec' }), toast: /toast show error \| تعذّر تسجيل الحضور/ },
    { reply: () => Promise.reject(new TypeError('Failed to fetch')), toast: /toast show error \| تعذّر الاتصال بالخادم/ },
  ];
  for (const { reply, toast } of replies) {
    const page = runQrScanPage({ fetchImpl: reply });
    await page.scan('{"cpr":"001234567"}');
    assert.match(page.toast(), toast);
    // The session counter only moves for a new record (the page does not even touch it otherwise).
    const counter = page.elements.get('scanCount');
    assert.ok(!counter || String(counter.textContent) === '0', 'only a new record counts');
  }
});

test('qr-scan: a code that is not a student card is explained and never sent', async () => {
  const page = runQrScanPage({ fetchImpl: () => assert.fail('nothing to send') });
  await page.scan('https://example.com/certificate.pdf');
  assert.match(page.toast(), /toast show error \| .*JSON/);
  await page.scan('{"name":"no cpr here"}');
  assert.match(page.toast(), /toast show error \| .*cpr/);
  assert.strictEqual(page.fetchCount(), 0);
});

test('qr-scan: the same card held in front of the camera is sent once, not on every frame (the server limits /exec to 60 a minute per address)', async () => {
  const page = runQrScanPage({ fetchImpl: okReply('أحمد') });
  const card = '{"cpr":"001234567"}';

  // The library reports the card on every frame it is in view: 10 frames a second for 12 seconds.
  for (let frame = 0; frame < 120; frame++) {
    await page.scan(card);
    page.advance(100);
  }
  assert.strictEqual(page.fetchCount(), 1, 'a card kept in view must not be re-sent, however long it stays');

  // A different student is not held back by the first one's quiet period.
  await page.scan('{"cpr":"003456789"}');
  assert.strictEqual(page.fetchCount(), 2);

  // Once the card has been out of view for more than 3 s, showing it again is a new scan.
  page.advance(3100);
  await page.scan(card);
  assert.strictEqual(page.fetchCount(), 3);
  await page.scan(card);
  assert.strictEqual(page.fetchCount(), 3, 'and is quiet again straight after');
});

// ---- The rewrite ---------------------------------------------------------------

test('the legacy client really contains the two URLs the rewrite targets', () => {
  assert.ok(readGasFile('auth-js.html').includes("'https://basaerbh.com/google-signin-relay'"));
  assert.ok(readGasFile('js.html').includes("'https://basaerbh.com/qr-scan-relay'"));
});

test('rewriteLegacyRelayUrls points auth-js and js at our own routes and changes nothing else', () => {
  const authJs = readGasFile('auth-js.html');
  const rewrittenAuthJs = rewriteLegacyRelayUrls('auth-js', authJs);
  assert.doesNotMatch(rewrittenAuthJs, LEGACY_RELAY_URL_PATTERN);
  assert.ok(rewrittenAuthJs.includes("const AUTH_OAUTH_RELAY_URL = '/relay/google-signin';"));
  assert.strictEqual(rewrittenAuthJs.split('/relay/google-signin').join('https://basaerbh.com/google-signin-relay'), authJs, 'only the URL may differ');

  const mainJs = readGasFile('js.html');
  const rewrittenMainJs = rewriteLegacyRelayUrls('js', mainJs);
  assert.doesNotMatch(rewrittenMainJs, LEGACY_RELAY_URL_PATTERN);
  assert.ok(rewrittenMainJs.includes("var QR_SCAN_RELAY_URL_ = '/relay/qr-scan';"));
  assert.strictEqual(rewrittenMainJs.split('/relay/qr-scan').join('https://basaerbh.com/qr-scan-relay'), mainJs, 'only the URL may differ');

  // Each partial gets only its own rewrite.
  assert.ok(rewriteLegacyRelayUrls('auth-js', mainJs).includes('https://basaerbh.com/qr-scan-relay'));
  assert.ok(rewriteLegacyRelayUrls('js', authJs).includes('https://basaerbh.com/google-signin-relay'));
});

test('rewriteLegacyRelayUrls is idempotent, ignores unknown partials and does not trip over odd names', () => {
  const body = "var A = 'https://basaerbh.com/google-signin-relay'; var B = \"https://basaerbh.com/google-signin-relay\";";
  const once = rewriteLegacyRelayUrls('auth-js', body);
  assert.strictEqual(once, "var A = '/relay/google-signin'; var B = \"/relay/google-signin\";", 'every occurrence, whatever the quotes');
  assert.strictEqual(rewriteLegacyRelayUrls('auth-js', once), once);
  assert.strictEqual(rewriteLegacyRelayUrls('funcs-js', body), body);
  for (const oddName of ['constructor', '__proto__', 'toString', '']) assert.strictEqual(rewriteLegacyRelayUrls(oddName, body), body);
});

test('no partial the browser receives still names a retired relay page, and every rewrite target is a served route', () => {
  const main = readGasFile('Main.html');
  const includedPartials = Array.from(main.matchAll(/<\?!?=?\s*include\s*\(\s*["']([^"']+)["']\s*\)\s*;?\s*\?>/g), (match) => match[1]);
  assert.ok(includedPartials.includes('auth-js') && includedPartials.includes('js'), 'Main.html should include both partials');
  for (const partialName of includedPartials) {
    const filePath = path.join(GAS_DIR, partialName + '.html');
    if (!fs.existsSync(filePath)) continue;
    assert.doesNotMatch(
      rewriteLegacyRelayUrls(partialName, fs.readFileSync(filePath, 'utf8')),
      LEGACY_RELAY_URL_PATTERN,
      `gas/${partialName}.html names a retired relay page; add it to LEGACY_RELAY_URL_REWRITES in page-rewrites.js`
    );
  }

  // Source check: requiring index.js would start the server. The rewrite must be applied before hashing,
  // and each route a rewrite points at must be registered with the page that serves it.
  const indexSource = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  assert.match(indexSource, /require\('\.\/page-rewrites\.js'\)/);
  // rewriteLegacyPartial applies the relay rewrite (plus the Drive URL rewrite) per partial.
  assert.match(indexSource, /rewriteLegacy(?:RelayUrls|Partial)\(name, /);
  const routeToPage = new Map([['/relay/google-signin', 'google-signin.html'], ['/relay/qr-scan', 'qr-scan.html']]);
  for (const rewrites of LEGACY_RELAY_URL_REWRITES.values()) {
    for (const { ownUrl } of rewrites) {
      assert.ok(routeToPage.has(ownUrl), `no page is known for ${ownUrl}`);
      assert.ok(
        indexSource.includes(`app.get('${ownUrl}', serveRelayPage('${routeToPage.get(ownUrl)}'))`),
        `server/index.js must register GET ${ownUrl} for ${routeToPage.get(ownUrl)}`
      );
    }
  }
});

test('the relay routes are never cached and the camera is allowed for the scanner by the global policy', () => {
  const indexSource = fs.readFileSync(path.join(SERVER_DIR, 'index.js'), 'utf8');
  // serveRelayPage sends the page as HTML with Cache-Control: no-store.
  const handlerSource = /function serveRelayPage\([\s\S]*?\n\}\n/.exec(indexSource);
  assert.ok(handlerSource, 'serveRelayPage not found in server/index.js');
  assert.match(handlerSource[0], /res\.type\('html'\)\.set\('Cache-Control', 'no-store'\)/);
  // The scanner is a top-level popup on the app's own origin, which camera=(self) covers.
  assert.match(indexSource, /'Permissions-Policy', 'camera=\(self\)/);
});
