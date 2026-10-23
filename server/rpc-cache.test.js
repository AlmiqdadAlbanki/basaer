'use strict';

// The RPC read cache and response compression, end to end against a booted
// server with the demo data: a read is computed once and shared by every
// caller, carries an ETag that answers If-None-Match with a 304, and is
// dropped as soon as the data changes — including a change made by another
// connection (a tool). Live and write calls are never cached.

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('./storage.js');

const ROOT = path.join(__dirname, '..');
// Offset from the shared test port so this file can run beside security.test.js.
const PORT = String((parseInt(process.env.BASAER_TEST_PORT, 10) || 3177) + 7);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'Test@1234';
const ADMIN = '100000001';
const TEACHER = '100000003';
const STUDENT_A = '001234567';
const STUDENT_B = '003456789';
const REF_ID = '1L-VXGGxNX-4th2ytpTC7YsVo1p3xAzc-JLmoGdpIdgo'; // refID in tools/seed.js

let tmpDir;
let child;
let childLog = '';

function serverEnv() {
  return Object.assign({}, process.env, {
    BASAER_DB: path.join(tmpDir, 'basaer.sqlite'),
    BASAER_KEYS: path.join(tmpDir, 'keys'),
    BASAER_FILES: path.join(tmpDir, 'files'),
    PORT,
    OUTBOUND_MODE: 'dry-run',
    NODE_ENV: 'production',
    RPC_READ_CACHE_TTL_MS: '60000',
  });
}

async function rpc(fnName, args, token, extraHeaders) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(`${BASE}/api/rpc/${encodeURIComponent(fnName)}`, { method: 'POST', headers, body: JSON.stringify({ args: args || [] }) });
  let body = null;
  try { body = res.status === 304 ? null : await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, body, headers: res.headers };
}

async function loginAs(cpr) {
  const login = await rpc('loginWithPassword', [cpr, PASSWORD]);
  assert.ok(login.body && login.body.ok && login.body.result && login.body.result.ok, `login failed for ${cpr}: ${JSON.stringify(login.body)}`);
  const res = await fetch(`${BASE}/api/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customToken: login.body.result.token }) });
  assert.strictEqual(res.status, 200);
  return (await res.json()).accessToken;
}

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-cache-'));
  const env = serverEnv();
  const seed = spawnSync('node', ['tools/seed.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.strictEqual(seed.status, 0, 'seed failed: ' + seed.stdout + seed.stderr);
  child = spawn('node', ['server/index.js'], { cwd: ROOT, env });
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline && !healthy) {
    try { healthy = (await fetch(`${BASE}/healthz`)).ok; } catch (_) { await new Promise((r) => setTimeout(r, 200)); }
  }
  assert.ok(healthy, 'server did not come up:\n' + childLog);
});

test.after(() => {
  if (child) child.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a read is computed once and shared by every caller, revalidates with If-None-Match, and is dropped when the data changes', async () => {
  const admin = await loginAs(ADMIN);
  const teacher = await loginAs(TEACHER);

  const first = await rpc('getAnnounces', [], admin);
  assert.strictEqual(first.status, 200);
  assert.ok(first.body.ok && Array.isArray(first.body.result));
  assert.strictEqual(first.headers.get('x-basaer-cache'), 'miss');
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
  assert.strictEqual(first.headers.get('cache-control'), 'private, no-store');

  const shared = await rpc('getAnnounces', [], teacher);
  assert.strictEqual(shared.headers.get('x-basaer-cache'), 'hit', 'another caller gets the same computed reply');
  assert.strictEqual(shared.headers.get('etag'), etag);
  assert.deepStrictEqual(shared.body, first.body);

  const notModified = await rpc('getAnnounces', [], admin, { 'If-None-Match': etag });
  assert.strictEqual(notModified.status, 304);
  assert.strictEqual(notModified.body, null);
  assert.strictEqual(notModified.headers.get('etag'), etag);

  // A tool (another connection) appends an announcement: the stamp moves, the entry goes.
  const storage = new Storage(path.join(tmpDir, 'basaer.sqlite'));
  try { storage.appendRow(REF_ID, 'announce', [new Date(), 'إعلان جديد', 'https://example.com/new']); } finally { storage.close(); }
  const afterWrite = await rpc('getAnnounces', [], admin, { 'If-None-Match': etag });
  assert.strictEqual(afterWrite.status, 200);
  assert.strictEqual(afterWrite.headers.get('x-basaer-cache'), 'miss');
  assert.notStrictEqual(afterWrite.headers.get('etag'), etag);
  assert.strictEqual(afterWrite.body.result.length, first.body.result.length + 1, 'the new announcement is in the fresh reply');

  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.ok(health.readCache.enabled && health.readCache.entries >= 1 && health.readCache.hits >= 1 && health.readCache.notModified >= 1, JSON.stringify(health.readCache));
});

test('self-scoped student reads are keyed per student', async () => {
  const studentA = await loginAs(STUDENT_A);
  const studentB = await loginAs(STUDENT_B);
  const a1 = await rpc('getAttendance', [STUDENT_A], studentA);
  const b1 = await rpc('getAttendance', [STUDENT_B], studentB);
  const a2 = await rpc('getAttendance', [STUDENT_A], studentA);
  assert.strictEqual(a1.status, 200);
  assert.strictEqual(a1.headers.get('x-basaer-cache'), 'miss');
  assert.strictEqual(b1.headers.get('x-basaer-cache'), 'miss', 'a different student is a different key');
  assert.strictEqual(a2.headers.get('x-basaer-cache'), 'hit');
  // Student B asking for A's rows is rescoped to B by the policy: B's own key, never A's reply.
  const bAsksForA = await rpc('getAttendance', [STUDENT_A], studentB);
  assert.strictEqual(bAsksForA.status, 200);
  assert.strictEqual(bAsksForA.headers.get('etag'), b1.headers.get('etag'));
});

test('live and write calls are never cached and carry no ETag', async () => {
  const live1 = await rpc('getBahrainTime', []);
  const live2 = await rpc('getBahrainTime', []);
  for (const reply of [live1, live2]) {
    assert.strictEqual(reply.status, 200);
    assert.strictEqual(reply.headers.get('etag'), null);
    assert.strictEqual(reply.headers.get('x-basaer-cache'), null);
  }
  const write = await rpc('clearUserData', []);
  assert.strictEqual(write.headers.get('etag'), null);
  assert.strictEqual(write.headers.get('x-basaer-cache'), null);
});

test('responses above 1 KB are gzip-compressed for a client that accepts it', async () => {
  const page = await fetch(`${BASE}/app`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.strictEqual(page.status, 200);
  assert.strictEqual(page.headers.get('content-encoding'), 'gzip');
  assert.ok((await page.text()).includes('<title>'), 'decoded transparently');

  const plain = await fetch(`${BASE}/app`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.strictEqual(plain.headers.get('content-encoding'), null);

  const read = await fetch(`${BASE}/api/rpc/loadPageLogin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' }, body: '{"args":[]}' });
  assert.strictEqual(read.status, 200);
  assert.strictEqual(read.headers.get('content-encoding'), 'gzip');
  assert.ok((await read.json()).ok);
});
