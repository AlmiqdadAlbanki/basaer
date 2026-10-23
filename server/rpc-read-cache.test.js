'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { RpcReadCache, etagOf } = require('./rpc-read-cache.js');

// A cache with a controllable clock and database version stamp.
function makeCache(overrides) {
  let stamp = 'v1';
  let clock = 1000;
  const cache = new RpcReadCache(Object.assign({ versionStamp: () => stamp, ttlMs: 1000, now: () => clock }, overrides));
  return { cache, dataChanged: () => { stamp += '+'; }, tick: (ms) => { clock += ms; } };
}

test('the same read is computed once and shared until the data changes', async () => {
  const { cache, dataChanged } = makeCache();
  let computations = 0;
  const compute = async () => { computations++; return '{"ok":true,"result":' + computations + '}'; };
  const first = await cache.fetch('k', compute);
  const second = await cache.fetch('k', compute);
  assert.strictEqual(computations, 1);
  assert.strictEqual(first.hit, false);
  assert.strictEqual(second.hit, true);
  assert.strictEqual(second.entry.bodyText, first.entry.bodyText);
  assert.strictEqual(second.entry.etag, etagOf(first.entry.bodyText));
  assert.match(second.entry.etag, /^"[A-Za-z0-9_-]{27}"$/);
  dataChanged();
  const third = await cache.fetch('k', compute);
  assert.strictEqual(computations, 2);
  assert.strictEqual(third.hit, false);
  assert.deepStrictEqual(cache.stats(), { enabled: true, entries: 1, bytes: Buffer.byteLength(third.entry.bodyText), hits: 1, misses: 2, coalesced: 0, notModified: 0, evicted: 0 });
});

test('entries expire after ttlMs even when the data is unchanged (clock-dependent replies)', async () => {
  const { cache, tick } = makeCache();
  let computations = 0;
  const compute = async () => { computations++; return 'body'; };
  await cache.fetch('k', compute);
  tick(999);
  assert.strictEqual((await cache.fetch('k', compute)).hit, true);
  tick(1);
  assert.strictEqual((await cache.fetch('k', compute)).hit, false);
  assert.strictEqual(computations, 2);
});

test('a write that lands during the computation invalidates the entry at once', async () => {
  const { cache, dataChanged } = makeCache();
  await cache.fetch('k', async () => { dataChanged(); return 'computed on the old data'; });
  assert.strictEqual(cache.get('k'), null);
});

test('concurrent identical reads share one computation; a failure reaches all of them and leaves nothing behind', async () => {
  const { cache } = makeCache();
  let resolveCompute;
  let computations = 0;
  const compute = () => { computations++; return new Promise((resolve) => { resolveCompute = resolve; }); };
  const firstCall = cache.fetch('k', compute);
  const secondCall = cache.fetch('k', compute);
  resolveCompute('body');
  const [first, second] = await Promise.all([firstCall, secondCall]);
  assert.strictEqual(computations, 1);
  assert.strictEqual(first.hit, false);
  assert.strictEqual(second.hit, true);
  assert.strictEqual(cache.stats().coalesced, 1);

  const failing = () => Promise.reject(new Error('boom'));
  await assert.rejects(Promise.all([cache.fetch('f', failing), cache.fetch('f', failing)]), /boom/);
  assert.strictEqual(cache.get('f'), null);
  const afterwards = await cache.fetch('f', async () => 'fine now');
  assert.strictEqual(afterwards.entry.bodyText, 'fine now');
});

test('memory is bounded: least recently used entries go first, an oversized body is not kept', async () => {
  const { cache } = makeCache({ maxEntries: 2, maxBytes: 100 });
  await cache.fetch('a', async () => 'aaaa');
  await cache.fetch('b', async () => 'bbbb');
  cache.get('a'); // "a" is now the most recently used
  await cache.fetch('c', async () => 'cccc'); // one too many: "b" goes
  assert.ok(cache.get('a'));
  assert.strictEqual(cache.get('b'), null);
  assert.ok(cache.get('c'));
  assert.strictEqual(cache.stats().evicted, 1);

  const big = await cache.fetch('big', async () => 'x'.repeat(101));
  assert.strictEqual(big.entry.bytes, 101);
  assert.strictEqual(cache.get('big'), null, 'answered but not kept');
  assert.ok(cache.stats().bytes <= 100);

  cache.clear();
  assert.deepStrictEqual([cache.stats().entries, cache.stats().bytes], [0, 0]);
});

test('ttlMs 0 means disabled', () => {
  const { cache } = makeCache({ ttlMs: 0 });
  assert.strictEqual(cache.enabled, false);
  assert.throws(() => new RpcReadCache({}), /versionStamp/);
});
