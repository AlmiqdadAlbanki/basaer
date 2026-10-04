'use strict';

// ScriptApp shim. The server code uses time-based triggers to work around
// Apps Script's 6-minute limit: queue "ticks" reschedule themselves with
// .after(ms), scheduled sends use .at(date), and monitors use everyMinutes /
// everyHours. We persist these in a `triggers` table; server/scheduler.js runs
// the due ones. getOAuthToken() is intentionally gone (SECURITY-FINDINGS #1).

const crypto = require('crypto');

function makeTrigger(row) {
  return {
    getUniqueId: () => row.id,
    getHandlerFunction: () => row.handler,
    getEventType: () => 'CLOCK',
    getTriggerSource: () => 'CLOCK',
    getTriggerSourceId: () => null,
    _row: row,
  };
}

function makeScriptApp(storage, opts) {
  const baseUrl = (opts && opts.baseUrl) || '';

  function insert(handler, kind, dueAt, intervalMs) {
    const row = {
      id: crypto.randomUUID(),
      handler: String(handler),
      kind,
      due_at: dueAt,
      interval_ms: intervalMs || null,
      created_at: Date.now(),
    };
    storage.db
      .prepare('INSERT INTO triggers (id, handler, kind, due_at, interval_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.handler, row.kind, row.due_at, row.interval_ms, row.created_at);
    return makeTrigger(row);
  }

  function clockBuilder(handler) {
    const builder = {
      _kind: null, _dueAt: 0, _intervalMs: null,
      after: (ms) => { builder._kind = 'once'; builder._dueAt = Date.now() + Math.max(0, +ms || 0); return builder; },
      at: (date) => { builder._kind = 'once'; builder._dueAt = new Date(date).getTime(); return builder; },
      everyMinutes: (count) => setRepeat(Math.max(1, +count || 1) * 60000),
      everyHours: (count) => setRepeat(Math.max(1, +count || 1) * 3600000),
      everyDays: (count) => setRepeat(Math.max(1, +count || 1) * 86400000),
      everyWeeks: (count) => setRepeat(Math.max(1, +count || 1) * 7 * 86400000),
      atHour: () => builder, nearMinute: () => builder, onWeekDay: () => builder, inTimezone: () => builder,
      create: () => {
        if (!builder._kind) throw new Error('ScriptApp trigger: no schedule specified');
        return insert(handler, builder._kind, builder._dueAt, builder._intervalMs);
      },
    };
    function setRepeat(intervalMs) {
      builder._kind = 'every';
      builder._intervalMs = intervalMs;
      builder._dueAt = Date.now() + intervalMs;
      return builder;
    }
    return builder;
  }

  return {
    newTrigger: (handler) => ({
      timeBased: () => clockBuilder(handler),
      // Spreadsheet/form event triggers are not used by this project.
      forSpreadsheet: () => { throw new Error('ScriptApp: spreadsheet-event triggers are not supported'); },
    }),
    getProjectTriggers: () => storage.db.prepare('SELECT * FROM triggers').all().map(makeTrigger),
    getScriptTriggers: () => storage.db.prepare('SELECT * FROM triggers').all().map(makeTrigger),
    deleteTrigger: (t) => {
      const id = t && (t._row ? t._row.id : (typeof t.getUniqueId === 'function' ? t.getUniqueId() : t));
      storage.db.prepare('DELETE FROM triggers WHERE id = ?').run(String(id));
    },
    getService: () => ({ getUrl: () => baseUrl, isEnabled: () => true }),
    getScriptId: () => 'basaer-local',
    getOAuthToken: () => {
      throw new Error('ScriptApp.getOAuthToken is disabled: it exposed the owner\'s Google token (see SECURITY-FINDINGS #1).');
    },
    EventType: { CLOCK: 'CLOCK' },
    TriggerSource: { CLOCK: 'CLOCK' },
  };
}

module.exports = { makeScriptApp };
