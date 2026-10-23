'use strict';

// client/gas-shim.js, run in a vm with a fake fetch and an in-memory copy
// store: a 'read' is downloaded once per page, kept with its ETag, and on the
// next page load revalidated with If-None-Match — a 304 reuses the copy, a 200
// replaces it. Copies belong to the signed-in user and go on forget().

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'client', 'gas-shim.js'), 'utf8');

// Replies per fetch call, in order: { status, body, etag }.
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name) => (name.toLowerCase() === 'etag' ? reply.etag || null : null) },
      json: () => Promise.resolve(reply.body),
    });
  };
  return { fetchImpl, calls };
}

// The same promise API as the IndexedDB layer, in memory and inspectable.
function memoryPersistence() {
  const entries = new Map();
  return {
    entries,
    get: (key) => Promise.resolve(entries.get(key) || null),
    set: (key, value) => { entries.set(key, Object.assign({ key }, value)); return Promise.resolve(true); },
    clear: () => { entries.clear(); return Promise.resolve(true); },
  };
}

// One "page load": a fresh vm context running the shim (so a fresh in-memory cache).
function loadPage({ fetchImpl, persistence, user = { cpr: '0012' } }) {
  const sandbox = {
    console, setTimeout, clearTimeout,
    fetch: fetchImpl,
    localStorage: { getItem: (key) => (key === 'basaer_user' && user ? JSON.stringify(user) : null) },
    sessionStorage: { getItem: () => null },
    __basaerRpcKinds: { getStuff: 'read', ping: 'live', save: 'write' },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SCRIPT, sandbox);
  sandbox.__basaerRpcCache.setPersistence(persistence);
  return sandbox;
}

function call(page, name, ...args) {
  return new Promise((resolve, reject) => {
    page.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10)); // let fire-and-forget writes land
// Results come from the vm context (another Object prototype), so compare their JSON.
const assertSame = (actual, expected, message) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
const COPY_KEY = '0012\u0001getStuff\u0000["a"]';

test('a read is downloaded once per page and kept with its ETag; the next page revalidates and reuses it on 304', async () => {
  const store = memoryPersistence();
  const firstVisit = fakeFetch([{ status: 200, body: { ok: true, result: { n: 1 } }, etag: '"e1"' }]);
  const page1 = loadPage({ fetchImpl: firstVisit.fetchImpl, persistence: store });
  assertSame(await call(page1, 'getStuff', 'a'), { n: 1 });
  assertSame(await call(page1, 'getStuff', 'a'), { n: 1 }, 'second read on the same page is answered from memory');
  assert.strictEqual(firstVisit.calls.length, 1);
  assert.strictEqual(firstVisit.calls[0].headers['If-None-Match'], undefined, 'nothing to revalidate yet');
  await settle();
  assert.deepStrictEqual(store.entries.get(COPY_KEY).etag, '"e1"');
  assert.strictEqual(store.entries.get(COPY_KEY).resultText, '{"n":1}');

  const secondVisit = fakeFetch([{ status: 304 }]);
  const page2 = loadPage({ fetchImpl: secondVisit.fetchImpl, persistence: store });
  assertSame(await call(page2, 'getStuff', 'a'), { n: 1 }, 'the kept copy is used after a 304');
  assert.strictEqual(secondVisit.calls[0].headers['If-None-Match'], '"e1"');
  assert.strictEqual(secondVisit.calls.length, 1);
});

test('a 200 after If-None-Match (data changed) replaces the copy', async () => {
  const store = memoryPersistence();
  store.entries.set(COPY_KEY, { key: COPY_KEY, etag: '"old"', resultText: '{"n":1}', storedAt: 1 });
  const visit = fakeFetch([{ status: 200, body: { ok: true, result: { n: 2 } }, etag: '"e2"' }]);
  const page = loadPage({ fetchImpl: visit.fetchImpl, persistence: store });
  assertSame(await call(page, 'getStuff', 'a'), { n: 2 });
  assert.strictEqual(visit.calls[0].headers['If-None-Match'], '"old"');
  await settle();
  assert.strictEqual(store.entries.get(COPY_KEY).etag, '"e2"');
  assert.strictEqual(store.entries.get(COPY_KEY).resultText, '{"n":2}');
});

test('a 304 without a copy to use is followed by a plain request', async () => {
  const store = memoryPersistence();
  const visit = fakeFetch([{ status: 304 }, { status: 200, body: { ok: true, result: 'fresh' }, etag: '"e3"' }]);
  const page = loadPage({ fetchImpl: visit.fetchImpl, persistence: store });
  assert.strictEqual(await call(page, 'getStuff', 'a'), 'fresh');
  assert.strictEqual(visit.calls.length, 2);
  assert.strictEqual(visit.calls[1].headers['If-None-Match'], undefined);
});

test('copies belong to the signed-in user and are forgotten on forget(); a write clears memory but not the copies', async () => {
  const store = memoryPersistence();
  store.entries.set(COPY_KEY, { key: COPY_KEY, etag: '"e1"', resultText: '{"n":1}', storedAt: 1 });

  const otherUser = fakeFetch([{ status: 200, body: { ok: true, result: { n: 9 } }, etag: '"e9"' }]);
  const otherPage = loadPage({ fetchImpl: otherUser.fetchImpl, persistence: store, user: { cpr: '0099' } });
  assertSame(await call(otherPage, 'getStuff', 'a'), { n: 9 });
  assert.strictEqual(otherUser.calls[0].headers['If-None-Match'], undefined, "another user's copy is never offered");

  const visit = fakeFetch([
    { status: 304 },                                           // getStuff: revalidated
    { status: 200, body: { ok: true, result: 'saved' } },      // save: a write
    { status: 304 },                                           // getStuff again: memory was cleared, the copy still revalidates
  ]);
  const page = loadPage({ fetchImpl: visit.fetchImpl, persistence: store });
  assertSame(await call(page, 'getStuff', 'a'), { n: 1 });
  assert.strictEqual(await call(page, 'save', 'x'), 'saved');
  assertSame(await call(page, 'getStuff', 'a'), { n: 1 });
  assert.strictEqual(visit.calls.length, 3);
  assert.strictEqual(visit.calls[2].headers['If-None-Match'], '"e1"');

  await page.__basaerRpcCache.forget();
  assert.strictEqual(store.entries.size, 0);
  assert.strictEqual(page.__basaerRpcCache.size(), 0);
});

test("a 'live' call is never cached, never revalidated", async () => {
  const store = memoryPersistence();
  const visit = fakeFetch([{ status: 200, body: { ok: true, result: 1 } }, { status: 200, body: { ok: true, result: 2 } }]);
  const page = loadPage({ fetchImpl: visit.fetchImpl, persistence: store });
  assert.strictEqual(await call(page, 'ping'), 1);
  assert.strictEqual(await call(page, 'ping'), 2);
  assert.strictEqual(visit.calls.length, 2);
  await settle();
  assert.strictEqual(store.entries.size, 0);
});
