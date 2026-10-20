'use strict';

// The remaining Apps Script services: PropertiesService, CacheService,
// LockService, Session, Logger, HtmlService, ContentService. All are thin and
// back onto the Storage instance or the gas/ file set.

const fs = require('fs');
const path = require('path');

function makePropertiesService(storage) {
  function store(scope) {
    return {
      getProperty: (k) => storage.propGet(scope, k),
      setProperty: (k, v) => { storage.propSet(scope, k, v); return store(scope); },
      deleteProperty: (k) => { storage.propDelete(scope, k); return store(scope); },
      getProperties: () => storage.propAll(scope),
      setProperties: (obj, deleteAllOthers) => {
        if (deleteAllOthers) storage.propDeleteAll(scope);
        for (const k of Object.keys(obj || {})) storage.propSet(scope, k, obj[k]);
        return store(scope);
      },
      deleteAllProperties: () => { storage.propDeleteAll(scope); return store(scope); },
      getKeys: () => Object.keys(storage.propAll(scope)),
    };
  }
  return {
    getScriptProperties: () => store('script'),
    getUserProperties: () => store('user'),
    getDocumentProperties: () => store('document'),
  };
}

function makeCacheService(storage) {
  function cache(scope) {
    return {
      get: (k) => storage.cacheGet(scope, k),
      put: (k, v, ttl) => storage.cacheSet(scope, k, v, ttl == null ? 600 : ttl),
      remove: (k) => storage.cacheDelete(scope, k),
      getAll: (keys) => {
        const out = {};
        for (const k of keys || []) { const v = storage.cacheGet(scope, k); if (v !== null) out[k] = v; }
        return out;
      },
      putAll: (obj, ttl) => { for (const k of Object.keys(obj || {})) storage.cacheSet(scope, k, obj[k], ttl == null ? 600 : ttl); },
      removeAll: (keys) => { for (const k of keys || []) storage.cacheDelete(scope, k); },
    };
  }
  return {
    getScriptCache: () => cache('script'),
    getUserCache: () => cache('user'),
    getDocumentCache: () => cache('document'),
  };
}

// LockService. The gas code takes the script lock around exam start/submit,
// question edits and every queue tick, expecting it to exclude *other
// executions*. Executions now run on several worker threads (interactive RPCs
// on one, triggers on another), so the lock is a real mutex over a
// SharedArrayBuffer shared by every worker: slot 0 is 0 when free, 1 when held.
//
// `sharedLock` is { int32: Int32Array, holderId } over that buffer, or null
// for the single-threaded case (tools, unit tests), where the lock trivially
// succeeds as before. Slot 1 records the holder's id so that the pool can free
// the lock if the holding worker dies or is terminated mid-execution
// (forceReleaseLockHeldBy). Apps Script releases a lock when the execution
// ends even if the code forgot to; Runtime.call() does the same through
// `_releaseIfHeld`.
const LOCK_STATE_SLOT = 0;
const LOCK_HOLDER_SLOT = 1;
const LOCK_BUFFER_BYTES = 8;

function makeLockService(sharedLock) {
  const int32 = sharedLock ? sharedLock.int32 : null;
  const holderId = sharedLock && sharedLock.holderId ? sharedLock.holderId : 0;
  let heldByThisExecution = false;

  function tryLock(timeoutMs) {
    if (!int32) return true;
    if (heldByThisExecution) return true; // re-entry within one execution
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      if (Atomics.compareExchange(int32, LOCK_STATE_SLOT, 0, 1) === 0) {
        Atomics.store(int32, LOCK_HOLDER_SLOT, holderId);
        heldByThisExecution = true;
        return true;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return false;
      // Sleep until the holder releases (notify) or a short slice passes; the
      // slice bounds the wait in case a notify is missed.
      Atomics.wait(int32, LOCK_STATE_SLOT, 1, Math.min(remainingMs, 50));
    }
  }
  function waitLock(timeoutMs) {
    if (!tryLock(timeoutMs)) {
      throw new Error('Lock timeout: another process was holding the lock for too long.');
    }
  }
  function releaseLock() {
    if (!int32 || !heldByThisExecution) return;
    heldByThisExecution = false;
    Atomics.store(int32, LOCK_HOLDER_SLOT, 0);
    Atomics.store(int32, LOCK_STATE_SLOT, 0);
    Atomics.notify(int32, LOCK_STATE_SLOT, 1);
  }
  function hasLock() {
    return int32 ? heldByThisExecution : true;
  }

  // Apps Script has three lock scopes; the server code only ever uses the
  // script lock, and one mutex for all three is the conservative choice.
  const lock = { tryLock, waitLock, releaseLock, hasLock };
  return {
    getScriptLock: () => lock,
    getUserLock: () => lock,
    getDocumentLock: () => lock,
    _releaseIfHeld: releaseLock,
  };
}

// Called by the pool (main thread) when a worker died or was terminated: if
// that worker was holding the lock, free it so the other workers do not wait
// forever. Returns true when a lock was freed.
function forceReleaseLockHeldBy(lockBuffer, holderId) {
  const int32 = new Int32Array(lockBuffer);
  if (!holderId || Atomics.load(int32, LOCK_HOLDER_SLOT) !== holderId) return false;
  Atomics.store(int32, LOCK_HOLDER_SLOT, 0);
  Atomics.store(int32, LOCK_STATE_SLOT, 0);
  Atomics.notify(int32, LOCK_STATE_SLOT, 1);
  return true;
}

function makeSession(ownerEmail, tz) {
  const user = { getEmail: () => ownerEmail || '' };
  return {
    getScriptTimeZone: () => tz || 'Asia/Qatar',
    getEffectiveUser: () => user,
    getActiveUser: () => user,
    getActiveUserLocale: () => 'ar',
  };
}

function makeLogger(sink) {
  const buf = [];
  return {
    log: (...args) => {
      const msg = args.length <= 1 ? String(args[0] == null ? '' : args[0])
        : String(args[0]).replace(/%s/g, () => String(args.shift() === undefined ? '' : args[0]));
      buf.push(msg);
      if (sink) sink(msg);
    },
    clear: () => { buf.length = 0; },
    getLog: () => buf.join('\n'),
  };
}

// HtmlService: only the file-based paths are used (createHtmlOutputFromFile via
// include(), createTemplateFromFile(page).evaluate() via loadPages_). The gas
// partials contain no scriptlets (verified), so evaluate() returns the file
// content unchanged. We read from the gas/ directory. The page templates the
// loadPage* functions return embed Google Drive image URLs; those are repointed
// at the local file store (page-rewrites.js), the same way the served partials are.
function makeHtmlService(gasDir) {
  const { rewriteLegacyShell } = require('../page-rewrites.js');
  function readFile(name) {
    const candidates = [path.join(gasDir, name + '.html'), path.join(gasDir, name)];
    for (const f of candidates) if (fs.existsSync(f)) return rewriteLegacyShell(fs.readFileSync(f, 'utf8'));
    throw new Error('HtmlService: file not found: ' + name);
  }
  function htmlOutput(content) {
    const o = {
      _content: content,
      getContent: () => o._content,
      setContent: (c) => { o._content = c; return o; },
      setTitle: () => o,
      setFaviconUrl: () => o,
      setXFrameOptionsMode: () => o,
      addMetaTag: () => o,
      setWidth: () => o,
      setHeight: () => o,
      setSandboxMode: () => o,
      append: (c) => { o._content += c; return o; },
    };
    return o;
  }
  function template(content) {
    return {
      _content: content,
      evaluate: () => htmlOutput(content),
    };
  }
  return {
    createHtmlOutput: (html) => htmlOutput(String(html == null ? '' : html)),
    createHtmlOutputFromFile: (name) => htmlOutput(readFile(name)),
    createTemplateFromFile: (name) => template(readFile(name)),
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT', SAMEORIGIN: 'SAMEORIGIN' },
    SandboxMode: { IFRAME: 'IFRAME' },
  };
}

function makeContentService() {
  function textOutput(content) {
    const o = {
      _content: content,
      _mime: 'text/plain',
      getContent: () => o._content,
      setContent: (c) => { o._content = c; return o; },
      setMimeType: (m) => { o._mime = m; return o; },
      getMimeType: () => o._mime,
      append: (c) => { o._content += c; return o; },
    };
    return o;
  }
  return {
    createTextOutput: (content) => textOutput(String(content == null ? '' : content)),
    MimeType: { JSON: 'application/json', TEXT: 'text/plain', JAVASCRIPT: 'application/javascript', CSV: 'text/csv', XML: 'application/xml' },
  };
}

module.exports = {
  makePropertiesService,
  makeCacheService,
  makeLockService,
  forceReleaseLockHeldBy,
  LOCK_BUFFER_BYTES,
  makeSession,
  makeLogger,
  makeHtmlService,
  makeContentService,
};
