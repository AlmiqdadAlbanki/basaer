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

// A single RPC runs start-to-finish synchronously in the worker's vm, so within
// one invocation there is no interleaving to guard against. Cross-invocation
// serialisation (the thing the queue tick code really wants) is enforced one
// level up by the trigger scheduler running one job at a time — see phase 4.
// Here the lock simply always succeeds.
function makeLockService() {
  const lock = {
    tryLock: () => true,
    waitLock: () => {},
    releaseLock: () => {},
    hasLock: () => true,
  };
  return {
    getScriptLock: () => lock,
    getUserLock: () => lock,
    getDocumentLock: () => lock,
  };
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
// content unchanged. We read from the gas/ directory.
function makeHtmlService(gasDir) {
  function readFile(name) {
    const candidates = [path.join(gasDir, name + '.html'), path.join(gasDir, name)];
    for (const f of candidates) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
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
  makeSession,
  makeLogger,
  makeHtmlService,
  makeContentService,
};
