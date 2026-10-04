'use strict';

// Loads the gas/*.js sources into one compiled script and runs a named
// function in a fresh V8 context per call, mirroring Apps Script semantics:
// every invocation starts with clean globals, and all files share one global
// scope (function declarations and `var`s hoist across files, exactly as GAS
// concatenates them).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { Storage } = require('./storage.js');
const { makeSpreadsheetApp } = require('./shims/sheets.js');
const { Utilities, Blob } = require('./shims/utilities.js');
const {
  makePropertiesService, makeCacheService, makeLockService,
  makeSession, makeLogger, makeHtmlService, makeContentService,
} = require('./shims/platform.js');
const { makeUrlFetchApp } = require('./shims/urlfetch.js');

// Files loaded code.js first (it declares the base `var` ids used elsewhere),
// then the rest alphabetically. Debug/test one-offs are excluded: they are
// dead (see the plan) and some reference Apps Script UI that has no analogue.
const EXCLUDE = new Set(['debugTriggers.js', 'debugFiqhExam.js', 'FCMSetup.js', 'test.js']);

function gasSources(gasDir) {
  const all = fs.readdirSync(gasDir).filter((f) => f.endsWith('.js') && !EXCLUDE.has(f));
  all.sort();
  const ordered = ['code.js', ...all.filter((f) => f !== 'code.js')];
  return ordered.map((f) => ({ name: f, code: fs.readFileSync(path.join(gasDir, f), 'utf8') }));
}

// A recursive proxy that tolerates any property access or construction but
// throws a clear error the moment it is actually *called*. Used for Apps Script
// services not yet ported, so the context always builds and only a genuine
// call to an unported feature fails, with a message naming it.
function notYetProxy(serviceName) {
  const handler = {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === Symbol.toStringTag) {
        return () => `[${serviceName} shim pending]`;
      }
      if (prop === 'then') return undefined; // not a thenable
      return notYetProxy(`${serviceName}.${String(prop)}`);
    },
    apply() { throw new Error(`Apps Script service not available in this build: ${serviceName}()`); },
    construct() { throw new Error(`Apps Script service not available in this build: new ${serviceName}()`); },
  };
  return new Proxy(function () {}, handler);
}

class Runtime {
  constructor(opts) {
    this.gasDir = opts.gasDir;
    this.storage = opts.storage;
    this.ownerEmail = opts.ownerEmail || 'admin@basaerbh.com';
    this.tz = opts.tz || 'Asia/Qatar';
    this.logSink = opts.logSink || null;

    const sources = gasSources(this.gasDir);
    const wrapped = sources
      .map((s) => `/*__FILE__ ${s.name} */\n${s.code}`)
      .join('\n;\n');
    // Expose the requested call via a trampoline the host sets per invocation.
    const trampoline = `\n;globalThis.__invoke__ = function(name, args){ return this[name].apply(this, args); };\n`;
    this.script = new vm.Script(wrapped + trampoline, { filename: 'gas-bundle.js' });

    this.htmlService = makeHtmlService(this.gasDir);
    // Auth services are attached after construction (they depend on this
    // Runtime for role resolution), breaking the construction cycle.
    this.identity = null;
    this.identityService = null;
  }

  // Called by the host once the identity layer exists. Enables the auth-host
  // interception in the UrlFetchApp shim.
  setAuthServices(identity, identityService) {
    this.identity = identity;
    this.identityService = identityService;
  }

  // Build the global object exposed to the gas code for one invocation.
  _makeGlobals() {
    const g = {
      SpreadsheetApp: makeSpreadsheetApp(this.storage),
      PropertiesService: makePropertiesService(this.storage),
      CacheService: makeCacheService(this.storage),
      LockService: makeLockService(),
      Session: makeSession(this.ownerEmail, this.tz),
      Logger: makeLogger(this.logSink),
      Utilities,
      Blob,
      HtmlService: this.htmlService,
      ContentService: makeContentService(),

      // Auth hosts are intercepted locally once setAuthServices has run; other
      // hosts throw until phase 4.
      UrlFetchApp: this.identityService
        ? makeUrlFetchApp({ identityService: this.identityService, identity: this.identity })
        : notYetProxy('UrlFetchApp'),
      GmailApp: notYetProxy('GmailApp'),
      MailApp: notYetProxy('MailApp'),
      Gmail: notYetProxy('Gmail'),
      DriveApp: notYetProxy('DriveApp'),
      Drive: notYetProxy('Drive'),
      ScriptApp: notYetProxy('ScriptApp'),
      DocumentApp: notYetProxy('DocumentApp'),
      SlidesApp: notYetProxy('SlidesApp'),
      OAuth2: notYetProxy('OAuth2'),
      CalendarApp: notYetProxy('CalendarApp'),

      // Standard globals the gas code assumes are present.
      console,
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Error,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      setTimeout,
      Promise,
    };
    g.globalThis = g;
    return g;
  }

  // Run a top-level gas function by name with the given argument array.
  call(fnName, args) {
    const sandbox = this._makeGlobals();
    const context = vm.createContext(sandbox);
    this.script.runInContext(context, { timeout: 30000 });
    if (typeof sandbox[fnName] !== 'function') {
      throw new Error('No such server function: ' + fnName);
    }
    return sandbox.__invoke__.call(sandbox, fnName, args || []);
  }

  // Introspection: the set of top-level function names the bundle defines.
  functionNames() {
    const sandbox = this._makeGlobals();
    const context = vm.createContext(sandbox);
    this.script.runInContext(context, { timeout: 30000 });
    return Object.keys(sandbox).filter((k) => typeof sandbox[k] === 'function' && !k.startsWith('__'));
  }
}

module.exports = { Runtime, Storage };
