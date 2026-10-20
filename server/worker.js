'use strict';

// Worker-thread entry: hosts one gas Runtime (the compiled 15k-line bundle plus
// shims) over its own SQLite connection, and executes the jobs the WorkerPool
// sends it one at a time. index.js runs the HTTP side; nothing here listens on
// the network.
//
// Ops (see worker-pool.js for the envelope):
//   call         { fn, args, context } -> the function's return value (must be
//                                structured-cloneable; gas results are JSON
//                                shaped because Apps Script serialised them);
//                                context = { clientIp } for browser calls
//   doPost       { body }      -> the JSON text doPost(e) produced
//   resolveRoles { cpr }       -> caller context for the policy layer

const { parentPort, workerData } = require('worker_threads');

const { Runtime } = require('./runtime.js');
const { Storage } = require('./storage.js');
const { Identity } = require('./auth/identity.js');
const { IdentityService, SA_CLIENT_EMAIL } = require('./auth/identity-service.js');
const { Mailer } = require('./shims/mail.js');

function buildMailer(storage, config) {
  let smtpTransport = null;
  if (config.outboundMode === 'live' && config.smtp && config.smtp.host) {
    // nodemailer is only needed for live delivery; dry-run never loads it.
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return new Mailer({ storage, mode: config.outboundMode, transport: smtpTransport, from: config.mailFrom });
}

function serialiseError(err) {
  return {
    message: String(err && err.message ? err.message : err),
    stack: err && err.stack ? String(err.stack) : undefined,
    status: err && err.status ? err.status : undefined,
  };
}

let runtime;
let identity;

try {
  const config = workerData;
  const storage = new Storage(config.dbPath);
  const mailer = buildMailer(storage, config);
  const tag = `[gas:${config.poolName}]`;

  runtime = new Runtime({
    gasDir: config.gasDir,
    storage,
    ownerEmail: config.ownerEmail,
    tz: config.tz,
    logSink: config.logGas ? (m) => console.log(tag, m) : null,
    outboundMode: config.outboundMode,
    mailer,
    baseUrl: config.baseUrl,
    localIssuer: SA_CLIENT_EMAIL,
    outboundLog: (m) => console.log('[outbound]', m),
    filesDir: config.filesDir,
    sharedLock: config.lockBuffer ? { int32: new Int32Array(config.lockBuffer), holderId: config.workerId } : null,
  });
  // The keypair already exists (index.js creates it before spawning workers);
  // this instance only verifies tokens and resolves roles through the runtime.
  identity = new Identity({ runtime, keyDir: config.keyDir });
  // Accounts imported from Firebase Auth keep their Firebase scrypt hashes
  // until their first successful login (tools/import-firebase-users.js stores
  // the hash parameters in this property). Absent property = no such accounts.
  const storedHashConfig = storage.propGet('script', 'FIREBASE_HASH_CONFIG');
  runtime.setAuthServices(identity, new IdentityService(storage, {
    firebaseHashConfig: storedHashConfig ? JSON.parse(storedHashConfig) : undefined,
  }));
  // Compile and evaluate the bundle now so the first request pays nothing.
  runtime.functionNames();
  parentPort.postMessage({ type: 'ready' });
} catch (err) {
  parentPort.postMessage({ type: 'init-error', error: serialiseError(err) });
  throw err;
}

const OPS = {
  call({ fn, args, context }) {
    return runtime.call(fn, Array.isArray(args) ? args : [], context || {});
  },
  doPost({ body }) {
    const event = { postData: { contents: JSON.stringify(body || {}) } };
    const output = runtime.call('doPost', [event]);
    return output && typeof output.getContent === 'function' ? output.getContent() : JSON.stringify(output);
  },
  resolveRoles({ cpr }) {
    return identity.resolveRoles(cpr);
  },
};

parentPort.on('message', (msg) => {
  if (!msg || !msg.id) return;
  const handler = OPS[msg.op];
  if (!handler) {
    parentPort.postMessage({ id: msg.id, ok: false, error: { message: 'unknown worker op: ' + msg.op } });
    return;
  }
  let reply;
  try {
    const result = handler(msg.payload || {});
    reply = { id: msg.id, ok: true, result: result === undefined ? null : result };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: serialiseError(err) };
  }
  try {
    parentPort.postMessage(reply);
  } catch (cloneErr) {
    // A result that cannot cross the thread boundary (an object with methods).
    parentPort.postMessage({ id: msg.id, ok: false, error: { message: 'result is not serialisable: ' + cloneErr.message } });
  }
});
