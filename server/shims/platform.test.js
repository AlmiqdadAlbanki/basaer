'use strict';

// LockService over a SharedArrayBuffer: exclusive across worker threads,
// re-entrant within one execution, released when the holder lets go.

const test = require('node:test');
const assert = require('node:assert');
const { Worker } = require('worker_threads');
const path = require('path');

const { makeLockService, forceReleaseLockHeldBy, LOCK_BUFFER_BYTES } = require('./platform.js');

// A helper thread that takes the shared lock, holds it for `holdMs`, releases it
// and reports the timestamps. Resolves `held` once the worker holds the lock
// and `done` when it has released it.
function holdLockInWorker(lockBuffer, holdMs, holderId) {
  const code = `
    const { parentPort, workerData } = require('worker_threads');
    const { makeLockService } = require(${JSON.stringify(path.join(__dirname, 'platform.js'))});
    const lockService = makeLockService({ int32: new Int32Array(workerData.lockBuffer), holderId: workerData.holderId || 0 });
    const lock = lockService.getScriptLock();
    const acquired = lock.tryLock(5000);
    parentPort.postMessage({ phase: 'held', acquired });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(8)), 0, 0, workerData.holdMs); // sleep
    lock.releaseLock();
    parentPort.postMessage({ phase: 'done', acquired, releasedAt: Date.now() });
  `;
  let resolveHeld;
  let resolveDone;
  const held = new Promise((resolve) => { resolveHeld = resolve; });
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const worker = new Worker(code, { eval: true, workerData: { lockBuffer, holdMs, holderId } });
  worker.on('message', (msg) => { if (msg.phase === 'held') resolveHeld(msg); else resolveDone(msg); });
  worker.on('error', (err) => { resolveHeld({ error: err }); resolveDone({ error: err }); });
  return { held, done };
}

test('without a shared buffer the lock always succeeds (single-threaded tools and tests)', () => {
  const lock = makeLockService(null).getScriptLock();
  assert.strictEqual(lock.tryLock(0), true);
  assert.strictEqual(lock.hasLock(), true);
  lock.releaseLock();
});

test('the lock excludes another thread until released, then hands over', async () => {
  const lockBuffer = new SharedArrayBuffer(LOCK_BUFFER_BYTES);
  const lockService = makeLockService({ int32: new Int32Array(lockBuffer) });
  const lock = lockService.getScriptLock();

  const holder = holdLockInWorker(lockBuffer, 300);
  assert.strictEqual((await holder.held).acquired, true, 'worker takes the free lock');

  const startedAt = Date.now();
  assert.strictEqual(lock.tryLock(50), false, 'must time out while the worker holds it');
  assert.ok(Date.now() - startedAt >= 45, 'tryLock should have waited for its timeout');
  assert.strictEqual(lock.hasLock(), false);

  assert.strictEqual(lock.tryLock(5000), true, 'must acquire once the worker releases');
  const acquiredAt = Date.now();
  const report = await holder.done;
  assert.strictEqual(report.acquired, true);
  assert.ok(acquiredAt >= report.releasedAt - 5, 'acquired only after the worker released');

  assert.strictEqual(lock.tryLock(0), true, 're-entrant within one execution');
  lockService._releaseIfHeld();
  assert.strictEqual(lock.hasLock(), false);
  assert.doesNotThrow(() => makeLockService({ int32: new Int32Array(lockBuffer) }).getScriptLock().waitLock(0), 'free lock: waitLock must not throw');
});

test('a lock held by a worker that died can be freed by the pool', async () => {
  const lockBuffer = new SharedArrayBuffer(LOCK_BUFFER_BYTES);
  const lock = makeLockService({ int32: new Int32Array(lockBuffer), holderId: 99 }).getScriptLock();
  const holder = holdLockInWorker(lockBuffer, 2000, 42);
  assert.strictEqual((await holder.held).acquired, true);
  // Simulate the holder being terminated mid-execution: the lock stays taken.
  assert.strictEqual(lock.tryLock(20), false);
  assert.strictEqual(forceReleaseLockHeldBy(lockBuffer, 7), false, 'a different worker id frees nothing');
  assert.strictEqual(forceReleaseLockHeldBy(lockBuffer, 42), true, 'the dead holder id frees the lock');
  assert.strictEqual(lock.tryLock(20), true, 'free again');
  lock.releaseLock();
  await holder.done;
});

test('waitLock throws when the lock cannot be obtained in time', async () => {
  const lockBuffer = new SharedArrayBuffer(LOCK_BUFFER_BYTES);
  const lock = makeLockService({ int32: new Int32Array(lockBuffer) }).getScriptLock();
  const holder = holdLockInWorker(lockBuffer, 250);
  assert.strictEqual((await holder.held).acquired, true);
  assert.throws(() => lock.waitLock(30), /Lock timeout/);
  await holder.done;
});
