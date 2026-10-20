'use strict';

// Loads the gas/*.js sources into one compiled script and runs a named
// function in a fresh V8 context per call, mirroring Apps Script semantics:
// every invocation starts with clean globals, and all files share one global
// scope (function declarations and `var`s hoist across files, exactly as GAS
// concatenates them).

const crypto = require('crypto');
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
const { makeScriptApp } = require('./shims/scriptapp.js');
const { makeMailShims } = require('./shims/mail.js');
const { makeOAuth2 } = require('./shims/oauth2lib.js');
const { makeDriveShims } = require('./shims/drive.js');
const { makeDocShims } = require('./shims/docs.js');
const { convertBlob } = require('./docgen/convert.js');

// Blob.getAs converts docx/pptx -> pdf/png through LibreOffice + pdftoppm.
Blob.setConverter(convertBlob);

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

// The gas code draws OTP codes with Math.random (SECURITY-FINDINGS #13), which
// is predictable. The sandbox gets a Math whose random() comes from the
// CSPRNG; everything else is inherited from the real Math. (QR session ids
// already use Utilities.getUuid, i.e. crypto.randomUUID.)
const SafeMath = Object.create(Math);
SafeMath.random = () => crypto.randomInt(0, 2 ** 48) / 2 ** 48;

class Runtime {
  constructor(opts) {
    this.gasDir = opts.gasDir;
    this.storage = opts.storage;
    // { int32 } over a SharedArrayBuffer shared with the other workers, or
    // null when running single-threaded (tools, tests). See makeLockService.
    this.sharedLock = opts.sharedLock || null;
    this.ownerEmail = opts.ownerEmail || 'admin@basaerbh.com';
    this.tz = opts.tz || 'Asia/Qatar';
    this.logSink = opts.logSink || null;
    // Outbound behaviour: 'dry-run' records and fakes every external call and
    // email (the default — nothing reaches real people from a test box);
    // 'live' sends for real.
    this.outboundMode = opts.outboundMode || 'dry-run';
    this.mailer = opts.mailer || null;      // shims/mail.js Mailer
    this.baseUrl = opts.baseUrl || '';
    this.localIssuer = opts.localIssuer || ''; // our local service-account email
    this.outboundLog = opts.outboundLog || null;
    this.filesDir = opts.filesDir || path.join(__dirname, '..', 'data', 'files');
    // Drive shims are stateless wrappers over storage, so one instance serves every call.
    this.driveShims = makeDriveShims({ storage: this.storage, filesDir: this.filesDir, baseUrl: this.baseUrl });
    // DocumentApp/SlidesApp edit .docx/.pptx bytes in the same file store.
    this.docShims = makeDocShims({
      storage: this.storage, filesDir: this.filesDir, baseUrl: this.baseUrl, driveInternals: this.driveShims.internals,
    });

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
    // Per-call metadata from the HTTP boundary (see call()).
    this.callContext = {};
  }

  // Called by the host once the identity layer exists. Enables the auth-host
  // interception in the UrlFetchApp shim.
  setAuthServices(identity, identityService) {
    this.identity = identity;
    this.identityService = identityService;
  }

  // Build the global object exposed to the gas code. The stateless shims and
  // constants live here and are created once; the stateful ones (Sheets, Logger
  // and the auth-aware UrlFetchApp) are refreshed per call in _refreshPerCall so
  // each invocation still sees the current database and a clean log, matching
  // Apps Script's "fresh execution" semantics without re-running 15k lines.
  _makeGlobals() {
    const g = {
      SpreadsheetApp: makeSpreadsheetApp(this.storage),
      PropertiesService: makePropertiesService(this.storage),
      CacheService: makeCacheService(this.storage),
      LockService: makeLockService(this.sharedLock),
      Session: makeSession(this.ownerEmail, this.tz),
      Logger: makeLogger(this.logSink),
      Utilities,
      Blob,
      HtmlService: this.htmlService,
      ContentService: makeContentService(),

      UrlFetchApp: this._makeUrlFetchApp(),
      ScriptApp: makeScriptApp(this.storage, { baseUrl: this.baseUrl }),
      // Email goes to the outbox (dry-run by default).
      ...(this.mailer ? makeMailShims(this.mailer) : {
        GmailApp: notYetProxy('GmailApp'), MailApp: notYetProxy('MailApp'), Gmail: notYetProxy('Gmail'),
      }),
      // OAuth2 library (FCM) resolves UrlFetchApp lazily so it always uses the
      // current per-call instance.
      OAuth2: makeOAuth2(() => this._sandbox.UrlFetchApp, this.outboundMode),

      // Ported in phase 5; calling one before then throws a named error.
      DriveApp: this.driveShims.DriveApp,
      Drive: this.driveShims.Drive,
      DocumentApp: this.docShims.DocumentApp,
      SlidesApp: this.docShims.SlidesApp,
      CalendarApp: notYetProxy('CalendarApp'),

      // Standard globals the gas code assumes are present.
      console,
      JSON,
      Math: SafeMath,
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

  // Build the shared context once (all 500+ functions defined a single time),
  // then reuse it for every call. This is the main performance lever: an
  // invocation becomes a function call instead of re-executing the whole bundle.
  _ensureContext() {
    if (this._sandbox) return;
    const sandbox = this._makeGlobals();
    vm.createContext(sandbox);
    this.script.runInContext(sandbox, { timeout: 30000 });
    this._sandbox = sandbox;
  }

  _makeUrlFetchApp() {
    return makeUrlFetchApp({
      identityService: this.identityService,
      identity: this.identity,
      localIssuer: this.localIssuer,
      storage: this.storage,
      mode: this.outboundMode,
      log: this.outboundLog,
      getCallContext: () => this.callContext,
    });
  }

  // Swap in fresh instances of the stateful shims before each call so one
  // invocation never sees another's cached sheet grids or log buffer.
  _refreshPerCall() {
    this._sandbox.SpreadsheetApp = makeSpreadsheetApp(this.storage);
    this._sandbox.Logger = makeLogger(this.logSink);
    this._sandbox.UrlFetchApp = this._makeUrlFetchApp();
  }

  // Run a top-level gas function by name with the given argument array.
  // `context` ({ clientIp } for a browser call) is visible to the shims for the
  // duration of the call, never to the gas code itself.
  call(fnName, args, context) {
    this._ensureContext();
    this._refreshPerCall();
    if (typeof this._sandbox[fnName] !== 'function') {
      throw new Error('No such server function: ' + fnName);
    }
    this.callContext = context || {};
    try {
      return this._sandbox.__invoke__.call(this._sandbox, fnName, args || []);
    } finally {
      this.callContext = {};
      // Apps Script frees the script lock when an execution ends, whether or
      // not the code released it (e.g. it threw while holding it).
      this._sandbox.LockService._releaseIfHeld();
    }
  }

  // Introspection: the set of top-level function names the bundle defines.
  functionNames() {
    this._ensureContext();
    return Object.keys(this._sandbox).filter((k) => typeof this._sandbox[k] === 'function' && !k.startsWith('__'));
  }
}

module.exports = { Runtime, Storage };
