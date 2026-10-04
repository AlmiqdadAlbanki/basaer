'use strict';

// HTTP entry point for the self-hosted Basaer app.
//
// Phase 2 scope: serve Main.html (with the 11 Apps Script `include()` partials
// inlined and the client shim injected), expose POST /api/rpc/:fn backed by the
// gas runtime, and port doPost as POST /exec. Authentication and the per-call
// allowlist arrive in phase 3; for now every RPC runs unauthenticated so the
// page can be exercised on seed data.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { Runtime, Storage } = require('./runtime.js');
const { Identity } = require('./auth/identity.js');
const { IdentityService, ensureServiceAccount } = require('./auth/identity-service.js');
const { enforce } = require('./policy.js');

const ROOT = path.join(__dirname, '..');
const GAS_DIR = path.join(ROOT, 'gas');
const DB_PATH = process.env.BASAER_DB || path.join(ROOT, 'data', 'basaer.sqlite');
const KEY_DIR = process.env.BASAER_KEYS || path.join(ROOT, 'data', 'keys');
const PORT = process.env.PORT || 3000;

const storage = new Storage(DB_PATH);
const runtime = new Runtime({
  gasDir: GAS_DIR,
  storage,
  ownerEmail: process.env.OWNER_EMAIL || 'admin@basaerbh.com',
  tz: 'Asia/Qatar',
  logSink: process.env.BASAER_LOG ? (m) => console.log('[gas]', m) : null,
});

// Identity layer. ensureServiceAccount seeds the local "service account" key
// auth.js signs custom tokens with; Identity issues/verifies our session
// tokens; IdentityService is the local password store.
const sa = ensureServiceAccount(storage, KEY_DIR);
const identity = new Identity({ runtime, keyDir: KEY_DIR });
const identityService = new IdentityService(storage);
runtime.setAuthServices(identity, identityService);

// Cache role resolution briefly so a page's burst of calls doesn't rebuild the
// gas context for every lookup.
const roleCache = new Map();
function resolveRolesCached(cpr) {
  const hit = roleCache.get(cpr);
  if (hit && hit.exp > Date.now()) return hit.ctx;
  const ctx = identity.resolveRoles(cpr);
  roleCache.set(cpr, { ctx, exp: Date.now() + 15000 });
  return ctx;
}

// Resolve the caller from the Authorization header, or null if none/invalid.
function callerFrom(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  try {
    const payload = identity.verifyToken(m[1]);
    return resolveRolesCached(String(payload.cpr));
  } catch (_) {
    return null;
  }
}

// Verify a Firebase-style custom token minted by auth.js against our local
// service-account public key, and return its uid (or throw).
function verifyCustomToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed custom token');
  const signingInput = parts[0] + '.' + parts[1];
  const sig = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!crypto.createVerify('RSA-SHA256').update(signingInput).verify(sa.publicKey, sig)) {
    throw new Error('bad custom-token signature');
  }
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) throw new Error('custom token expired');
  if (!payload.uid) throw new Error('custom token has no uid');
  return payload.uid;
}

// --- Build the single page once at startup --------------------------------
function buildIndexHtml() {
  let html = fs.readFileSync(path.join(GAS_DIR, 'Main.html'), 'utf8');

  // Inline every `<?!= include("name"); ?>` (spaces and quote style vary).
  html = html.replace(/<\?!?=?\s*include\s*\(\s*["']([^"']+)["']\s*\)\s*;?\s*\?>/g, (_m, name) => {
    const file = path.join(GAS_DIR, name + '.html');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `<!-- missing include: ${name} -->`;
  });

  // `<base target="_top">` only matters inside the Apps Script iframe; drop it
  // so links and reloads act on our own page. (Done at serve time to keep
  // gas/Main.html byte-identical for clasp.)
  html = html.replace(/<base\s+target=["']_top["']\s*\/?>/i, '');

  // Drop the real Firebase compat SDK scripts — our firebase-shim replaces them.
  html = html.replace(/<script[^>]*gstatic\.com\/firebasejs\/[^>]*><\/script>\s*/gi, '');

  // Inject our shims before anything else runs: firebase-shim first (the gas
  // code calls firebase.auth()), then the google.script.run shim.
  html = html.replace(/<head>/i,
    '<head>\n  <script src="/firebase-shim.js"></script>\n  <script src="/gas-shim.js"></script>');

  return html;
}

// Built once for production; in dev the page is rebuilt per request so edits to
// the partials show up on reload.
const INDEX_HTML = buildIndexHtml();

const app = express();
app.use(express.json({ limit: '15mb' }));

app.get('/gas-shim.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'client', 'gas-shim.js'));
});
app.get('/firebase-shim.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'client', 'firebase-shim.js'));
});

// Trade a custom token (minted by a login function in auth.js) for a session
// token the browser then holds and sends on every RPC.
app.post('/api/auth/exchange', (req, res) => {
  try {
    const uid = verifyCustomToken(req.body && req.body.customToken);
    const cpr = String(uid).replace(/^u/, '');
    const sessionToken = identity.signToken({ cpr, uid });
    roleCache.delete(cpr); // force a fresh role lookup on next call
    res.json({ ok: true, sessionToken, uid });
  } catch (err) {
    res.status(401).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

app.get('/', (_req, res) => {
  const html = process.env.NODE_ENV === 'production' ? INDEX_HTML : buildIndexHtml();
  res.type('html').send(html);
});

// --- RPC: google.script.run -> POST /api/rpc/:fn ---------------------------
app.post('/api/rpc/:fn', (req, res) => {
  const fn = req.params.fn;
  const args = (req.body && Array.isArray(req.body.args)) ? req.body.args : [];
  const caller = callerFrom(req);

  const decision = enforce(fn, args, caller);
  if (!decision.allow) {
    return res.status(decision.status || 403).json({ ok: false, error: decision.message || 'غير مسموح' });
  }

  try {
    const result = runtime.call(fn, decision.args || args);
    res.json({ ok: true, result: result === undefined ? null : result });
  } catch (err) {
    console.error('RPC', fn, 'failed:', err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// --- doPost port: the relay pages POST JSON {action, ...} here --------------
app.post('/exec', (req, res) => {
  try {
    const e = { postData: { contents: JSON.stringify(req.body || {}) } };
    const out = runtime.call('doPost', [e]);
    const content = out && typeof out.getContent === 'function' ? out.getContent() : JSON.stringify(out);
    res.type('application/json').send(content);
  } catch (err) {
    res.status(500).json({ status: 'error', message: String(err && err.message ? err.message : err) });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Basaer server listening on http://localhost:${PORT}`);
  console.log(`  gas dir: ${GAS_DIR}`);
  console.log(`  db:      ${DB_PATH}`);
});
