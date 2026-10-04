'use strict';

// Runs due time-based triggers (see shims/scriptapp.js), replacing Apps
// Script's clock triggers. Polls once a second; executes one handler at a time
// (the runtime is synchronous, so this also gives the queue code the mutual
// exclusion it used LockService for). A 'once' trigger is deleted before it
// runs — matching Apps Script, where self-rescheduling handlers create their
// next trigger themselves. An 'every' trigger is advanced to its next due time.

class Scheduler {
  constructor({ storage, runtime, log }) {
    this.storage = storage;
    this.runtime = runtime;
    this.log = log || ((...a) => console.log('[scheduler]', ...a));
    this._timer = null;
    this._running = false;
  }

  start(intervalMs = 1000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), intervalMs);
    this.log('started');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    if (this._running) return; // a long handler is still executing
    this._running = true;
    try {
      const now = Date.now();
      const due = this.storage.db
        .prepare('SELECT * FROM triggers WHERE due_at <= ? ORDER BY due_at LIMIT 5')
        .all(now);
      for (const t of due) {
        if (t.kind === 'once') {
          this.storage.db.prepare('DELETE FROM triggers WHERE id = ?').run(t.id);
        } else {
          // Advance past now so a slow handler does not pile up repeats.
          let next = t.due_at + (t.interval_ms || 60000);
          while (next <= Date.now()) next += (t.interval_ms || 60000);
          this.storage.db.prepare('UPDATE triggers SET due_at = ? WHERE id = ?').run(next, t.id);
        }
        this._run(t);
      }
    } finally {
      this._running = false;
    }
  }

  _run(t) {
    const started = Date.now();
    try {
      this.runtime.call(t.handler, []);
      this.log(`ran ${t.handler} (${Date.now() - started}ms)`);
    } catch (err) {
      this.log(`ERROR in ${t.handler}: ${err && err.message ? err.message : err}`);
    }
  }
}

module.exports = { Scheduler };
