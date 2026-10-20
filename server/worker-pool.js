'use strict';

// A small pool of worker threads running server/worker.js.
//
// The gas runtime is synchronous: a call occupies its thread from start to
// finish (a certificate render holds it for a second or two; a WhatsApp queue
// tick for one HTTP round trip). Running those on worker threads keeps the
// HTTP thread free to serve pages, files and health checks, and lets
// background triggers run beside interactive calls (see index.js for how the
// two pools are sized and why).
//
// Protocol with the worker (plain postMessage):
//   worker -> main   { type: 'ready' } | { type: 'init-error', error }
//   main   -> worker { id, op, payload }
//   worker -> main   { id, ok: true, result } | { id, ok: false, error: { message, stack } }

const { Worker } = require('worker_threads');
const path = require('path');

const WORKER_FILE = path.join(__dirname, 'worker.js');

// Every spawned worker (including respawns) gets a process-unique id, used as
// the holder id of the shared gas lock so a dead worker's lock can be freed.
let nextWorkerId = 1;

class WorkerPool {
  // opts: { name, size, workerData, maxQueue, jobTimeoutMs, log, onWorkerGone }
  // onWorkerGone(workerId) is called when a worker exits or is terminated.
  constructor(opts) {
    this.name = opts.name || 'pool';
    this.size = Math.max(1, opts.size | 0);
    this.workerData = opts.workerData || {};
    this.maxQueue = opts.maxQueue || 500;
    // A job past this is assumed hung; its worker is replaced. Must comfortably
    // exceed the slowest legitimate call (first LibreOffice run ~60s).
    this.jobTimeoutMs = opts.jobTimeoutMs || 5 * 60 * 1000;
    this.log = opts.log || ((...a) => console.log(`[${this.name}]`, ...a));
    this.onWorkerGone = opts.onWorkerGone || null;
    this._slots = [];     // { worker, workerId, busy, job }
    this._queue = [];     // pending jobs: { id, op, payload, resolve, reject, timer }
    this._nextId = 1;
    this._stopping = false;
  }

  // Spawn every worker and resolve once all report ready (or reject on the
  // first init error, so a broken deployment fails loudly at startup).
  start() {
    const startups = [];
    for (let i = 0; i < this.size; i++) startups.push(this._spawn(i));
    return Promise.all(startups);
  }

  _spawn(slotIndex) {
    const workerId = nextWorkerId++;
    const slot = { worker: null, workerId, busy: false, job: null };
    this._slots[slotIndex] = slot;
    return new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_FILE, { workerData: Object.assign({}, this.workerData, { poolName: this.name, slotIndex, workerId }) });
      slot.worker = worker;
      let ready = false;

      worker.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'ready') { ready = true; resolve(); this._dispatch(); return; }
        if (msg.type === 'init-error') { reject(new Error(`${this.name} worker failed to start: ${msg.error && msg.error.message}`)); return; }
        const job = slot.job;
        if (!job || msg.id !== job.id) return; // stale reply from a replaced job
        this._finish(slot, job, msg.ok ? null : msg.error, msg.result);
      });
      worker.on('error', (err) => {
        this.log(`worker error: ${err && err.stack ? err.stack : err}`);
        if (!ready) reject(err);
      });
      worker.on('exit', (code) => {
        if (this.onWorkerGone) {
          try { this.onWorkerGone(workerId); } catch (err) { this.log(`onWorkerGone failed: ${err.message}`); }
        }
        if (this._stopping) return;
        this.log(`worker exited with code ${code}; respawning`);
        if (slot.job) this._finish(slot, slot.job, { message: 'worker crashed while handling the request' });
        slot.worker = null;
        this._spawn(slotIndex).catch((err) => this.log(`respawn failed: ${err.message}`));
      });
    });
  }

  // Run `op` with `payload` on the next free worker. Resolves with the
  // worker's result or rejects with an Error carrying the worker's message.
  call(op, payload) {
    return new Promise((resolve, reject) => {
      if (this._stopping) return reject(Object.assign(new Error('server is shutting down'), { status: 503 }));
      if (this._queue.length >= this.maxQueue) {
        return reject(Object.assign(new Error('server busy, try again shortly'), { status: 503 }));
      }
      this._queue.push({ id: this._nextId++, op, payload, resolve, reject, timer: null });
      this._dispatch();
    });
  }

  _dispatch() {
    for (const slot of this._slots) {
      if (!this._queue.length) return;
      if (!slot.worker || slot.busy) continue;
      const job = this._queue.shift();
      slot.busy = true;
      slot.job = job;
      job.timer = setTimeout(() => this._onTimeout(slot, job), this.jobTimeoutMs);
      slot.worker.postMessage({ id: job.id, op: job.op, payload: job.payload });
    }
  }

  _finish(slot, job, error, result) {
    clearTimeout(job.timer);
    slot.busy = false;
    slot.job = null;
    if (error) {
      const err = new Error(error.message || 'worker error');
      err.workerStack = error.stack;
      if (error.status) err.status = error.status;
      job.reject(err);
    } else {
      job.resolve(result);
    }
    this._dispatch();
  }

  // A synchronous worker cannot be interrupted, so a hung job is cut off by
  // replacing its thread (the 'exit' handler respawns it). The slot is marked
  // empty before the job is finished, so the dispatch that follows cannot hand
  // the next job to the thread that is about to be killed.
  _onTimeout(slot, job) {
    if (slot.job !== job) return;
    this.log(`job ${job.op} ${job.payload && job.payload.fn ? job.payload.fn : ''} exceeded ${this.jobTimeoutMs}ms; terminating worker`);
    const dyingWorker = slot.worker;
    slot.worker = null;
    this._finish(slot, job, { message: 'request timed out', status: 504 });
    if (dyingWorker) dyingWorker.terminate();
  }

  stats() {
    return {
      size: this.size,
      busy: this._slots.filter((s) => s.busy).length,
      queued: this._queue.length,
    };
  }

  shutdown() {
    this._stopping = true;
    for (const job of this._queue) job.reject(new Error('server is shutting down'));
    this._queue = [];
    return Promise.all(this._slots.map((s) => (s.worker ? s.worker.terminate() : Promise.resolve())));
  }
}

module.exports = { WorkerPool };
