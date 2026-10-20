'use strict';

// Runs due time-based triggers (see shims/scriptapp.js), replacing Apps
// Script's clock triggers. Polls once a second and executes one handler at a
// time, on the background worker (so a long queue tick or certificate batch
// never delays interactive calls, which run on their own worker). A 'once'
// trigger is deleted before it runs — matching Apps Script, where
// self-rescheduling handlers create their next trigger themselves. An 'every'
// trigger is advanced to its next due time.

class Scheduler {
  // runHandler(handlerName) -> Promise; resolves when the handler finished.
  constructor({ storage, runHandler, log }) {
    this.storage = storage;
    this.runHandler = runHandler;
    this.log = log || ((...a) => console.log('[scheduler]', ...a));
    this._timer = null;
    this._running = false;
  }

  start(intervalMs = 1000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.tick().catch((err) => this.log('tick failed:', err && err.message)); }, intervalMs);
    this.log('started');
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._running) return; // a long handler is still executing
    this._running = true;
    try {
      const now = Date.now();
      const due = this.storage.db
        .prepare('SELECT * FROM triggers WHERE due_at <= ? ORDER BY due_at LIMIT 5')
        .all(now);
      for (const trigger of due) {
        if (trigger.kind === 'once') {
          this.storage.db.prepare('DELETE FROM triggers WHERE id = ?').run(trigger.id);
        } else {
          // Advance past now so a slow handler does not pile up repeats.
          let next = trigger.due_at + (trigger.interval_ms || 60000);
          while (next <= Date.now()) next += (trigger.interval_ms || 60000);
          this.storage.db.prepare('UPDATE triggers SET due_at = ? WHERE id = ?').run(next, trigger.id);
        }
        await this._run(trigger);
      }
    } finally {
      this._running = false;
    }
  }

  async _run(trigger) {
    const started = Date.now();
    try {
      await this.runHandler(trigger.handler);
      this.log(`ran ${trigger.handler} (${Date.now() - started}ms)`);
    } catch (err) {
      this.log(`ERROR in ${trigger.handler}: ${err && err.message ? err.message : err}`);
    }
  }
}

module.exports = { Scheduler };
