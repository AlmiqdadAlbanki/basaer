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
const { enforce, scopeResult } = require('./policy.js');

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

// --- Page assembly ---------------------------------------------------------
//
// The Apps Script page inlines 11 `include()` partials (4 CSS + 7 JS) into one
// ~1.4MB document, so the browser re-downloads and re-parses every partial —
// including the 600KB admin bundle — on every load, for every role. We instead
// serve each partial as its own static, browser-cacheable file and reference it
// with <link>/<script src>, preserving document order (the JS partials have
// load-order dependencies and run non-deferred, exactly as when inlined). First
// load fetches them in parallel; every load after is a conditional 304. gas
// files stay byte-identical — the split happens here at serve time.

const INCLUDE_RE = /<\?!?=?\s*include\s*\(\s*["']([^"']+)["']\s*\)\s*;?\s*\?>/g;

// Extract each partial's inner content (minus its wrapping <style>/<script>),
// note whether it is CSS or JS, and give it a content-hashed served name so the
// browser can cache it immutably and re-fetch only when the content changes.
// `served` maps the hashed filename -> payload (the route); `ref` maps the base
// name -> its current hashed filename (the page builder).
function buildPartials() {
  const served = new Map();
  const ref = new Map();
  const main = fs.readFileSync(path.join(GAS_DIR, 'Main.html'), 'utf8');
  let m;
  INCLUDE_RE.lastIndex = 0;
  while ((m = INCLUDE_RE.exec(main))) {
    const name = m[1];
    const file = path.join(GAS_DIR, name + '.html');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const styleM = raw.match(/^\s*<style[^>]*>([\s\S]*)<\/style>\s*$/i);
    const scriptM = raw.match(/^\s*<script[^>]*>([\s\S]*)<\/script>\s*$/i);
    const body = styleM ? styleM[1] : (scriptM ? scriptM[1] : raw);
    const ext = styleM ? 'css' : 'js';
    const type = styleM ? 'text/css' : 'application/javascript';
    const hash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
    const servedName = `${name}.${hash}.${ext}`;
    served.set(servedName, { type, body });
    ref.set(name, servedName);
  }
  return { served, ref };
}

let { served: PARTIALS, ref: PARTIAL_REF } = buildPartials();

function buildIndexHtml() {
  if (process.env.BASAER_REBUILD) ({ served: PARTIALS, ref: PARTIAL_REF } = buildPartials());
  let html = fs.readFileSync(path.join(GAS_DIR, 'Main.html'), 'utf8');

  // Replace each include with a reference to its now-external, cache-busted file.
  html = html.replace(INCLUDE_RE, (_m, name) => {
    const file = PARTIAL_REF.get(name);
    if (!file) return `<!-- missing include: ${name} -->`;
    return file.endsWith('.css')
      ? `<link rel="stylesheet" href="/partials/${file}">`
      : `<script src="/partials/${file}"></script>`;
  });

  // `<base target="_top">` only matters inside the Apps Script iframe.
  html = html.replace(/<base\s+target=["']_top["']\s*\/?>/i, '');
  // Drop the real Firebase SDK scripts — our firebase-shim replaces them.
  html = html.replace(/<script[^>]*gstatic\.com\/firebasejs\/[^>]*><\/script>\s*/gi, '');
  // Inject our shims first: firebase-shim (gas calls firebase.auth()), then gas-shim.
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

// The split-out CSS/JS partials. The filename carries a content hash, so each
// is cached immutably for a year; a content change produces a new filename and
// a one-time re-fetch. After the first visit the browser serves these from
// cache with no network at all.
app.get('/partials/:file', (req, res) => {
  const p = PARTIALS.get(req.params.file);
  if (!p) return res.status(404).send('// no such partial');
  res.type(p.type).set('Cache-Control', 'public, max-age=31536000, immutable').send(p.body);
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

// Serve the page from the one-time build. Set BASAER_REBUILD=1 to re-inline the
// partials on every request while actively editing them.
app.get('/', (_req, res) => {
  res.type('html').send(process.env.BASAER_REBUILD ? buildIndexHtml() : INDEX_HTML);
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
    const result = scopeResult(decision, runtime.call(fn, decision.args || args));
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
