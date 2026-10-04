'use strict';

// HTTP entry point for the self-hosted Basaer app.
//
// Phase 2 scope: serve Main.html (with the 11 Apps Script `include()` partials
// inlined and the client shim injected), expose POST /api/rpc/:fn backed by the
// gas runtime, and port doPost as POST /exec. Authentication and the per-call
// allowlist arrive in phase 3; for now every RPC runs unauthenticated so the
// page can be exercised on seed data.

const express = require('express');
const fs = require('fs');
const path = require('path');

const { Runtime, Storage } = require('./runtime.js');

const ROOT = path.join(__dirname, '..');
const GAS_DIR = path.join(ROOT, 'gas');
const DB_PATH = process.env.BASAER_DB || path.join(ROOT, 'data', 'basaer.sqlite');
const PORT = process.env.PORT || 3000;

const storage = new Storage(DB_PATH);
const runtime = new Runtime({
  gasDir: GAS_DIR,
  storage,
  ownerEmail: process.env.OWNER_EMAIL || 'admin@basaerbh.com',
  tz: 'Asia/Qatar',
  logSink: process.env.BASAER_LOG ? (m) => console.log('[gas]', m) : null,
});

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

  // Inject the google.script.run shim before anything else runs.
  html = html.replace(/<head>/i, '<head>\n  <script src="/gas-shim.js"></script>');

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

app.get('/', (_req, res) => {
  const html = process.env.NODE_ENV === 'production' ? INDEX_HTML : buildIndexHtml();
  res.type('html').send(html);
});

// --- RPC: google.script.run -> POST /api/rpc/:fn ---------------------------
app.post('/api/rpc/:fn', (req, res) => {
  const fn = req.params.fn;
  const args = (req.body && Array.isArray(req.body.args)) ? req.body.args : [];
  try {
    const result = runtime.call(fn, args);
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
