'use strict';

// HTTP entry point for the self-hosted Basaer app.
//
// Threads. This file is the HTTP thread: it never runs gas code. The
// synchronous gas runtime lives in worker threads (server/worker.js), in two
// pools:
//   rpcPool         interactive calls (POST /api/rpc, /exec). One worker by
//                   default: the legacy code has many check-then-write
//                   patterns (duplicate scans before appendRow, row numbers
//                   captured before deletes) that are only safe when
//                   interactive calls run one at a time, exactly as before.
//                   BASAER_RPC_WORKERS raises it once those paths are reviewed.
//   backgroundPool  time-based triggers (WhatsApp/FCM queue ticks, exam
//                   monitors, certificate batches), one worker. A long batch no
//                   longer freezes every user; the gas LockService is a real
//                   cross-thread mutex, so the sections the code guards with it
//                   stay exclusive across the two pools.
//
// Sessions. Logging in trades the custom token minted by auth.js for a
// long-lived session JWT in an httpOnly cookie plus a short-lived access JWT
// the page keeps in memory (see auth/identity.js). Requests authenticate with
// either; cookie-authenticated requests must also pass the CSRF rule below.
//
// Defences at this boundary: default-deny policy (policy.js), CPR rescoping,
// rate limits on anonymous and credential-proving calls, login lockout
// (auth/identity-service.js), verified Google sign-in (auth/google-token.js),
// security headers, generic error messages in production, request log.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const { Storage } = require('./storage.js');
const { Identity, TOKEN_KINDS } = require('./auth/identity.js');
const { ensureServiceAccount } = require('./auth/identity-service.js');
const { GoogleTokenVerifier } = require('./auth/google-token.js');
const { enforce, scopeResult, rpcKinds } = require('./policy.js');
const { storeStudentWork, isOwnFolder, MAX_UPLOAD_BYTES } = require('./uploads.js');
const { makeDriveShims } = require('./shims/drive.js');
const { convertWithSoffice } = require('./docgen/convert.js');
const { forceReleaseLockHeldBy, LOCK_BUFFER_BYTES } = require('./shims/platform.js');
const { Scheduler } = require('./scheduler.js');
const { WorkerPool } = require('./worker-pool.js');
const { RateLimiter } = require('./rate-limit.js');
const { rewriteLegacyPartial, rewriteLegacyShell, rewriteGoogleFontsUrls, legacyShellMeta } = require('./page-rewrites.js');

// --- Configuration ----------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const GAS_DIR = path.join(ROOT, 'gas');
const DB_PATH = process.env.BASAER_DB || path.join(ROOT, 'data', 'basaer.sqlite');
const KEY_DIR = process.env.BASAER_KEYS || path.join(ROOT, 'data', 'keys');
// Uploaded files and generated documents (the local replacement for Drive).
const FILES_DIR = process.env.BASAER_FILES || path.join(ROOT, 'data', 'files');
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// 'dry-run' (default): emails and external calls are recorded, never sent.
// 'live': really send (needs SMTP_* and provider credentials).
const OUTBOUND_MODE = process.env.OUTBOUND_MODE === 'live' ? 'live' : 'dry-run';
const IS_PROD = process.env.NODE_ENV === 'production';
const RPC_WORKERS = Math.max(1, parseInt(process.env.BASAER_RPC_WORKERS, 10) || 1);
// Session cookie lifetime (sliding) and the absolute cap after which a user
// must log in again however active they were.
const SESSION_TTL_SECONDS = (parseInt(process.env.SESSION_TTL_DAYS, 10) || 7) * 24 * 3600;
const SESSION_ABSOLUTE_MAX_SECONDS = 30 * 24 * 3600;
const ACCESS_TTL_SECONDS = 15 * 60;
// The cookie is only sent over HTTPS unless we are clearly in local http dev.
const COOKIE_SECURE = IS_PROD || /^https:/i.test(BASE_URL);
const SESSION_COOKIE = 'basaer_session';
// "Login by CPR alone" (auth.js skipEmailVerificationLogin). The admin chose
// this knowingly on Apps Script (see the comment in auth.js); here it is off
// unless explicitly enabled, because it lets anyone who knows a CPR in.
const ALLOW_CPR_ONLY_LOGIN = process.env.ALLOW_CPR_ONLY_LOGIN === '1';
// Behind nginx on the same host, req.ip must come from X-Forwarded-For so the
// rate limits apply per client, not per proxy.
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';

// --- Shared state for the HTTP thread ----------------------------------------
// This Storage is used only for non-grid tables (files, outbox, triggers,
// props); every sheet read or write happens inside a worker.
const storage = new Storage(DB_PATH);
const driveShims = makeDriveShims({ storage, filesDir: FILES_DIR, baseUrl: BASE_URL });

// Key material must exist before the workers start: ensureServiceAccount seeds
// the local "service account" auth.js signs custom tokens with, and Identity
// creates the session keypair on first run.
const serviceAccount = ensureServiceAccount(storage, KEY_DIR);
const identity = new Identity({ keyDir: KEY_DIR, accessTtlSeconds: ACCESS_TTL_SECONDS, sessionTtlSeconds: SESSION_TTL_SECONDS });
const googleTokenVerifier = new GoogleTokenVerifier({
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
});

// Shared by every worker: the gas script lock (state + holder id).
const lockBuffer = new SharedArrayBuffer(LOCK_BUFFER_BYTES);
// A worker that dies or is cut off by the pool timeout while holding the lock
// would otherwise block the other pool forever.
function releaseLockOfDeadWorker(workerId) {
  if (forceReleaseLockHeldBy(lockBuffer, workerId)) console.warn(`[lock] freed the gas lock held by dead worker ${workerId}`);
}
const workerData = {
  dbPath: DB_PATH,
  gasDir: GAS_DIR,
  keyDir: KEY_DIR,
  filesDir: FILES_DIR,
  baseUrl: BASE_URL,
  outboundMode: OUTBOUND_MODE,
  tz: 'Asia/Qatar',
  ownerEmail: process.env.OWNER_EMAIL || 'admin@basaerbh.com',
  logGas: !!process.env.BASAER_LOG,
  mailFrom: process.env.MAIL_FROM || 'بصائر للعلوم الشرعية <no-reply@basaerbh.com>',
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: +(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  lockBuffer,
};
const rpcPool = new WorkerPool({ name: 'rpc', size: RPC_WORKERS, workerData, onWorkerGone: releaseLockOfDeadWorker });
const backgroundPool = new WorkerPool({ name: 'background', size: 1, workerData, onWorkerGone: releaseLockOfDeadWorker });

// --- Rate limits ------------------------------------------------------------
// Fixed windows, per client IP or per target identifier. The numbers are far
// above any real user's pace and far below a brute-force or enumeration pace.
const limits = {
  authEndpoint: new RateLimiter({ windowMs: 60 * 1000, max: 30 }),          // /api/auth/* per IP
  anonymousRpc: new RateLimiter({ windowMs: 60 * 1000, max: 120 }),         // unauthenticated RPC per IP
  authenticatedRpc: new RateLimiter({ windowMs: 60 * 1000, max: 600 }),     // RPC per caller CPR
  credentialPerIp: new RateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }),  // identity-proving calls per IP
  // Per targeted CPR/email. Keyed together with the IP so that a stranger who
  // knows a CPR cannot shut its owner out; the IP-independent backstop is
  // loose enough never to hit a real user yet still bounds distributed
  // guessing of a 6-digit code to a few dozen tries per code lifetime.
  credentialPerTargetAndIp: new RateLimiter({ windowMs: 10 * 60 * 1000, max: 10 }),
  credentialPerTarget: new RateLimiter({ windowMs: 10 * 60 * 1000, max: 60 }),
  otpRequestPerTargetAndIp: new RateLimiter({ windowMs: 10 * 60 * 1000, max: 5 }), // OTP emails per CPR per IP
  otpRequestPerTarget: new RateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }),     // ... any IP
  exec: new RateLimiter({ windowMs: 60 * 1000, max: 60 }),                  // /exec per IP
};
// Functions that prove an identity (a wrong guess must cost the attacker) and
// functions that send an OTP (each one emails a real person). Not in the set:
// checkOauthVerifyResult, which the Google sign-in page polls every 1.5s and
// which can no longer log anyone in by itself (the verified-email gate below).
const CREDENTIAL_FUNCTIONS = new Set(['loginWithPassword', 'verifyLoginCode', 'verifyRegistrationOtp', 'skipEmailVerificationLogin', 'loginWithGoogleVerifiedEmail']);
const OTP_REQUEST_FUNCTIONS = new Set(['requestLoginCode', 'requestRegistrationOtp']);

function tooManyRequests(res, verdict, what) {
  res.set('Retry-After', String(verdict.retryAfterSeconds || 60));
  return res.status(429).json({ ok: false, error: 'عدد المحاولات كبير، يرجى المحاولة لاحقًا.', scope: what });
}

// --- Caller resolution ------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch (_) { out[name] = ''; }
  }
  return out;
}

function sessionCookieOptions(maxAgeMs) {
  return { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, path: '/', maxAge: maxAgeMs };
}

// Issue the pair the page needs after a login or a refresh. `sessionStartedAt`
// (seconds) rides along in the session token so the absolute cap holds across
// renewals.
function issueSession(res, { cpr, uid, sessionStartedAt }) {
  const startedAt = sessionStartedAt || Math.floor(Date.now() / 1000);
  const sessionToken = identity.signToken({ cpr, uid, sat: startedAt, sid: crypto.randomBytes(8).toString('hex') }, { kind: TOKEN_KINDS.session });
  res.cookie(SESSION_COOKIE, sessionToken, sessionCookieOptions(SESSION_TTL_SECONDS * 1000));
  const accessToken = identity.signToken({ cpr, uid }, { kind: TOKEN_KINDS.access });
  return {
    ok: true,
    user: { uid, cpr },
    accessToken,
    accessTokenExpiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
  };
}

// Role lookups run gas code (loginData, checkStudentRegistered) on the rpc
// worker. Cache briefly so a page's burst of calls costs one lookup, and
// share an in-flight lookup between concurrent requests for the same CPR.
const roleCache = new Map();
const ROLE_CACHE_MS = 15000;
function resolveRolesCached(cpr) {
  const hit = roleCache.get(cpr);
  if (hit && hit.promise) return hit.promise;
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.ctx);
  const promise = rpcPool.call('resolveRoles', { cpr })
    .then((ctx) => { roleCache.set(cpr, { ctx, exp: Date.now() + ROLE_CACHE_MS }); return ctx; })
    .catch((err) => { roleCache.delete(cpr); throw err; });
  roleCache.set(cpr, { promise });
  return promise;
}

// Cookie-authenticated requests are the only ones a cross-site page could
// make the browser send; the custom header cannot be added cross-origin
// without CORS consent, and Sec-Fetch-Site names the request's origin class.
function passesCsrfRule(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') return false;
  return req.headers['x-requested-with'] === 'basaer';
}

// The session cookie's verified payload, or null when absent, invalid, or
// logged out (revoked). Does not apply the CSRF rule.
function sessionFromCookie(req) {
  const cookieValue = parseCookies(req)[SESSION_COOKIE];
  if (!cookieValue) return null;
  let payload;
  try { payload = identity.verifyToken(cookieValue, { kind: TOKEN_KINDS.session }); } catch (_) { return null; }
  if (payload.sid && storage.isSessionRevoked(payload.sid)) return null;
  return payload;
}

// Resolve the caller from the Authorization header (access token) or the
// session cookie. Returns the caller context, or null for anonymous/invalid.
async function callerFrom(req) {
  let payload = null;
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (bearer) {
    try { payload = identity.verifyToken(bearer[1], { kind: TOKEN_KINDS.access }); } catch (_) { payload = null; }
  }
  if (!payload) {
    payload = sessionFromCookie(req);
    if (payload && req.method !== 'GET' && !passesCsrfRule(req)) payload = null;
  }
  if (!payload) return null;
  try {
    return await resolveRolesCached(String(payload.cpr));
  } catch (err) {
    console.error('role resolution failed for', payload.cpr, err.message);
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
  if (!crypto.createVerify('RSA-SHA256').update(signingInput).verify(serviceAccount.publicKey, sig)) {
    throw new Error('bad custom-token signature');
  }
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) throw new Error('custom token expired');
  if (!payload.uid) throw new Error('custom token has no uid');
  return payload.uid;
}

// --- Error exposure ---------------------------------------------------------
// gas functions throw Arabic messages meant for the user, which must reach
// the page. Internal failures (a missing column, a crashed worker, a SQLite
// error) must not: in production they become a generic message with a
// reference the operator can find in the log.
const INTERNAL_ERROR_RE = /SQLITE_|ENOENT|EACCES|EPERM|is not a function|Cannot read propert|Cannot set propert|is not defined|is not iterable|Unexpected token|Maximum call stack|worker crashed|not serialisable|timed out|ECONNREFUSED|spawnSync/i;
function clientErrorMessage(err, reference) {
  const message = String(err && err.message ? err.message : err);
  if (IS_PROD && INTERNAL_ERROR_RE.test(message)) return `حدث خطأ في الخادم (المرجع ${reference})`;
  return message;
}

// --- Page assembly ------------------------------------------------------------
//
// The Apps Script page inlines 11 `include()` partials (4 CSS + 7 JS) into one
// ~1.4MB document, so the browser re-downloads and re-parses every partial —
// including the 600KB admin bundle — on every load, for every role. We instead
// serve each partial as its own static, browser-cacheable file and reference it
// with <link>/<script src>, preserving document order (the JS partials have
// load-order dependencies and run non-deferred, exactly as when inlined). Our
// three client scripts are served the same way. gas files stay byte-identical —
// the split happens here at serve time.

const INCLUDE_RE = /<\?!?=?\s*include\s*\(\s*["']([^"']+)["']\s*\)\s*;?\s*\?>/g;
const CLIENT_SCRIPTS = ['firebase-shim', 'gas-shim', 'view-restore'];

function hashedName(baseName, body, ext) {
  return `${baseName}.${crypto.createHash('sha1').update(body).digest('hex').slice(0, 10)}.${ext}`;
}

// Extract each partial's inner content (minus its wrapping <style>/<script>),
// note whether it is CSS or JS, and give it a content-hashed served name so the
// browser can cache it immutably and re-fetch only when the content changes.
// `served` maps the hashed filename -> payload (the route); `ref` maps the base
// name -> its current hashed filename (the page builder).
function buildPartials() {
  const served = new Map();
  const ref = new Map();
  const main = fs.readFileSync(path.join(GAS_DIR, 'Main.html'), 'utf8');
  let match;
  INCLUDE_RE.lastIndex = 0;
  while ((match = INCLUDE_RE.exec(main))) {
    const name = match[1];
    const file = path.join(GAS_DIR, name + '.html');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const styleMatch = raw.match(/^\s*<style[^>]*>([\s\S]*)<\/style>\s*$/i);
    const scriptMatch = raw.match(/^\s*<script[^>]*>([\s\S]*)<\/script>\s*$/i);
    // The legacy relay-page and Drive URLs are repointed at our own routes before
    // hashing, so the hashed file name changes with them (see page-rewrites.js).
    const body = rewriteLegacyPartial(name, styleMatch ? styleMatch[1] : (scriptMatch ? scriptMatch[1] : raw));
    const ext = styleMatch ? 'css' : 'js';
    const type = styleMatch ? 'text/css' : 'application/javascript';
    const servedName = hashedName(name, body, ext);
    served.set(servedName, { type, body });
    ref.set(name, servedName);
  }
  for (const scriptName of CLIENT_SCRIPTS) {
    const body = fs.readFileSync(path.join(__dirname, 'client', scriptName + '.js'), 'utf8');
    const servedName = hashedName(scriptName, body, 'js');
    served.set(servedName, { type: 'application/javascript', body });
    ref.set(scriptName, servedName);
  }
  return { served, ref };
}

let { served: PARTIALS, ref: PARTIAL_REF } = buildPartials();
const RPC_KINDS_SCRIPT = `<script>window.__basaerRpcKinds = ${JSON.stringify(rpcKinds())};</script>`;

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
  // What the shell loads from Google Drive, Google Fonts and the old Firebase-hosted
  // site comes from the local store and this server's own routes instead.
  html = rewriteLegacyShell(html);
  // Drop the real Firebase SDK scripts — our firebase-shim replaces them.
  html = html.replace(/<script[^>]*gstatic\.com\/firebasejs\/[^>]*><\/script>\s*/gi, '');
  // Inject, first in <head>: the RPC cache classification, firebase-shim (gas
  // calls firebase.auth()), gas-shim, and view-restore (keeps the user's place
  // across a refresh).
  const clientTags = CLIENT_SCRIPTS.map((name) => `  <script src="/partials/${PARTIAL_REF.get(name)}"></script>`).join('\n');
  html = html.replace(/<head>/i, `<head>\n  ${RPC_KINDS_SCRIPT}\n${clientTags}`);
  // The tab title and icon doGet sets with setTitle/setFaviconUrl (gas/Main.html
  // has neither, Apps Script's wrapper page used to carry them).
  const { title, faviconUrl } = legacyShellMeta(fs.readFileSync(path.join(GAS_DIR, 'code.js'), 'utf8'));
  const escapeHtmlText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  html = html.replace(/<\/head>/i, `  <title>${escapeHtmlText(title)}</title>\n  <link rel="icon" type="image/png" href="${escapeHtmlText(faviconUrl)}">\n</head>`);
  return html;
}

// Built once for production; in dev the page is rebuilt per request so edits to
// the partials show up on reload.
const INDEX_HTML = buildIndexHtml();

// --- App --------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

// Security headers on every response. nginx adds the same in production; the
// app sets them too so it is safe on its own. The content-security-policy is
// deliberately minimal: the legacy page uses inline scripts and CDN assets, so
// only the directives that cannot break it are set.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy', "frame-ancestors 'self'; base-uri 'self'; object-src 'none'");
  res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  next();
});

// One line per API request: enough to investigate an incident, no bodies.
app.use((req, res, next) => {
  if (!/^\/(api|exec|files)\b/.test(req.path)) return next();
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(JSON.stringify({
      t: new Date().toISOString(), ip: req.ip, m: req.method, p: req.path, s: res.statusCode,
      ms: Math.round(ms * 10) / 10, cpr: res.locals.callerCpr || null, ref: res.locals.errorReference || undefined,
    }));
  });
  next();
});

const jsonBody = express.json({ limit: '15mb' });
// /exec is the doPost port for the two relay pages (served from /relay/*, same
// origin, JSON). The retired Firebase-hosted versions posted cross-origin as a
// `no-cors` text/plain request (the only kind the browser sends without a CORS
// preflight — the same trick they used against Apps Script's doPost), so /exec
// still takes the raw body whatever its content type and parses it itself.
const rawTextBody = express.text({ type: () => true, limit: '1mb' });
function parseExecBody(rawBody) {
  if (rawBody && typeof rawBody === 'object') return rawBody;
  if (typeof rawBody !== 'string' || !rawBody.trim()) return {};
  try { return JSON.parse(rawBody); } catch (_) { return {}; }
}

// The split-out CSS/JS partials and client scripts. The filename carries a
// content hash, so each is cached immutably for a year; a content change
// produces a new filename and a one-time re-fetch.
app.get('/partials/:file', (req, res) => {
  const partial = PARTIALS.get(req.params.file);
  if (!partial) return res.status(404).send('// no such partial');
  res.type(partial.type).set('Cache-Control', 'public, max-age=31536000, immutable').send(partial.body);
});

// --- Self-hosted fonts and old-site files ---------------------------------------
// The pages used to load web fonts from Google Fonts, and a script, a font and a logo
// from the old Firebase-hosted site; page-rewrites.js points them at these two
// directories instead, so no visitor's browser has to contact those hosts:
//   /fonts/*        server/client/fonts/        Google Fonts stylesheets and their woff2 files
//   /site-assets/*  server/client/site-assets/  the old site's assets/ files the pages reference
// Cached for a year without revalidation by default, like the hashed partials above.
// Unlike those, these names carry no content hash: a file that changes later has to be
// saved under a new name (and page-rewrites.js pointed at it), or visitors keep the old
// copy — a directory whose files are edited in place passes a shorter `cache` instead.
// Dotfiles are never served, and directories are neither listed nor redirected.
const CACHE_FOR_A_YEAR = { immutable: true, maxAge: '365d' };
function serveStaticDirectory(directory, cache = CACHE_FOR_A_YEAR) {
  return express.static(directory, { ...cache, dotfiles: 'deny', index: false, redirect: false });
}
app.use('/fonts', serveStaticDirectory(path.join(__dirname, 'client', 'fonts')));
app.use('/site-assets', serveStaticDirectory(path.join(__dirname, 'client', 'site-assets')));

// Serve the page from the one-time build. Set BASAER_REBUILD=1 to re-inline the
// partials on every request while actively editing them. The app lives under /app
// (/ is the public website, below), and the SPA keeps its place in the URL
// (view-restore.js), so /app and any /app/p/... path serve the same page.
// /app is the address of the frame inside the website's /platform page, not a page
// of its own: a visitor who opens it directly (a top-level navigation, which browsers
// mark with Sec-Fetch-Dest: document) is sent to the same view under /platform, so
// the website's header bar is always there. The frame's own request (Sec-Fetch-Dest:
// iframe), tools and old browsers without the header get the page.
app.get(['/app', '/app/p/*'], (req, res) => {
  if (req.get('Sec-Fetch-Dest') === 'document') {
    return res.redirect(302, req.path.replace(/^\/app/, '/platform') + queryStringOf(req));
  }
  res.type('html').set('Cache-Control', 'no-store').send(process.env.BASAER_REBUILD ? buildIndexHtml() : INDEX_HTML);
});

// The app used to answer at / and /p/...: a bookmarked /p/... view lands on the same
// view under /app, query string included.
app.get('/p/*', (req, res) => res.redirect(301, '/app' + req.originalUrl));

// --- Public website ---------------------------------------------------------------
// The academy's public website used to be on Firebase Hosting at basaerbh.com, and its
// /platform page put a header bar over an iframe of the Apps Script web app. This server
// serves both, at the paths the public already knows:
//   /                    the home page                       server/client/site/index.html
//   /platform            header bar + the app (/app) in an iframe       .../platform.html
//   /student-guide       the student guide (and /student-guide.pdf)     .../student-guide.html
//   /assets/*            the site's css, js, images and fonts           .../assets/
//   /favicon.ico, /robots.txt, /sitemap.xml
// server/client/site/ is the site as exported from Firebase Hosting
// (data/google-exports/newweb/website/), without the two relay pages (ported to
// server/client/relay/), the FCM service worker and the export's README. The pages were
// edited only where they reached Google or named the old file names: Google Analytics is gone,
// links name the clean paths, and platform.html frames /app instead of the Apps Script URL,
// its reload link reloads that frame, and its push-notification button, dialog and FCM
// scripts are gone (web push needs a Web Push port first, docs/DEPLOY.md section 11).
const SITE_DIR = path.join(__dirname, 'client', 'site');

function escapeHtmlAttribute(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The query string of a request ('' when it has none), as the WHATWG URL parser writes it:
// quotes, spaces and angle brackets come out percent-encoded, so the result can go into a
// redirect's Location header, and HTML-escaped into an attribute.
function queryStringOf(req) {
  try { return new URL(req.originalUrl, 'http://localhost').search; } catch (_) { return ''; }
}

// The pages and the stylesheet below are read once at startup (a missing file stops the server
// there, not at the first visit) and on every request with BASAER_REBUILD=1. student-guide.html
// links a Google Fonts stylesheet with preconnect hints to Google's font hosts; the serve-time
// rewrite the app's own pages get (page-rewrites.js) points it at /fonts/* and drops the hints,
// so the file stays as exported.
function siteFileReader(relativePath) {
  const readFile = () => rewriteGoogleFontsUrls(fs.readFileSync(path.join(SITE_DIR, relativePath), 'utf8'));
  const fileText = readFile();
  return () => (process.env.BASAER_REBUILD ? readFile() : fileText);
}

// The pages name the site's files relatively (assets/css/style.css), which resolves to
// /assets/... only from a root-level path. Express also routes /platform/ (and /Platform) to
// app.get('/platform'), so anything other than the exact clean path is redirected to it.
// Never cached, like the app's shell: the pages carry no content hash.
function serveSitePage(cleanPath, pageFor) {
  return (req, res) => {
    if (req.path !== cleanPath) return res.redirect(301, cleanPath + queryStringOf(req));
    res.type('html').set('Cache-Control', 'no-store').send(pageFor(req));
  };
}

const readHomePage = siteFileReader('index.html');
const readStudentGuidePage = siteFileReader('student-guide.html');
const readPlatformPage = siteFileReader('platform.html');

// The platform page's iframe gets the query string /platform was asked with, as the Apps
// Script URL in it did, so /platform?logout=1 frames /app?logout=1 (gas/js.html clears the
// login the browser stored when the app starts with logout=1; doGet in gas/code.js read it too).
// It also gets the view: /platform/p/<view> frames /app/p/<view>. The app writes its view
// into its own URL (client/view-restore.js) and reports it to the platform page, which shows
// the same path under /platform; a refresh, bookmark or pasted link of that address comes
// back here. Anything else under /platform (a trailing slash, /Platform, a deeper path) is
// redirected to the plain page, since the page names its files by absolute /assets/ paths
// but the app's view-restore only reads one segment.
const PLATFORM_FRAME_START = '<iframe id="platform-frame" src="/app"';
if (!readPlatformPage().includes(PLATFORM_FRAME_START)) {
  throw new Error(`server/client/site/platform.html no longer contains ${PLATFORM_FRAME_START}`);
}
const PLATFORM_VIEW_PATH_RE = /^\/platform(\/p\/[^/]+)?$/;
function platformPageFor(req) {
  const viewPath = (PLATFORM_VIEW_PATH_RE.exec(req.path) || [])[1] || '';
  const frameStart = `<iframe id="platform-frame" src="${escapeHtmlAttribute('/app' + viewPath + queryStringOf(req))}"`;
  // A replacer function, not a replacement string: a "$&" or "$'" in the query must stay literal.
  return readPlatformPage().replace(PLATFORM_FRAME_START, () => frameStart);
}

app.get('/', serveSitePage('/', readHomePage));
app.get(['/platform', '/platform/p', '/platform/p/*'], (req, res) => {
  if (!PLATFORM_VIEW_PATH_RE.test(req.path)) return res.redirect(301, '/platform' + queryStringOf(req));
  res.type('html').set('Cache-Control', 'no-store').send(platformPageFor(req));
});
app.get('/student-guide', serveSitePage('/student-guide', readStudentGuidePage));

// The old file names (still in old links, and in the site's own app.js, which writes
// href="platform.html" into the menu) redirect to the clean paths, query string included.
for (const [oldPath, cleanPath] of [['/index.html', '/'], ['/platform.html', '/platform'], ['/student-guide.html', '/student-guide']]) {
  app.get(oldPath, (req, res) => res.redirect(301, cleanPath + queryStringOf(req)));
}

// Files with fixed, well-known names: browsers ask for /favicon.ico and crawlers for
// /robots.txt and /sitemap.xml by name, and the guide links its PDF by name. Like the files
// under /assets they are edited in place when the website changes, so they are cached for an
// hour, not a year.
for (const fileName of ['favicon.ico', 'robots.txt', 'sitemap.xml', 'student-guide.pdf']) {
  const filePath = path.join(SITE_DIR, fileName);
  app.get('/' + fileName, (_req, res) => res.sendFile(filePath, { maxAge: '1h' }));
}

// The website's own css/js/images/fonts. Their names carry no content hash and the site is
// edited in place (style.css, app.js, the fatawa snapshot), so they are cached for an hour
// only: a year-long immutable cache would keep returning visitors on a stale site after
// every update.
const SITE_ASSET_CACHE = { maxAge: '1h' };
// The site's stylesheet starts with an @import of Tajawal from Google Fonts. It gets the same
// rewrite as the pages (so it names /fonts/tajawal-400-500-700-800.css and the file stays as
// exported) and the same caching as the rest of /assets.
const readSiteStylesheet = siteFileReader(path.join('assets', 'css', 'style.css'));
app.get('/assets/css/style.css', (_req, res) => {
  res.type('css').set('Cache-Control', 'public, max-age=3600').send(readSiteStylesheet());
});
app.use('/assets', serveStaticDirectory(path.join(SITE_DIR, 'assets'), SITE_ASSET_CACHE));

// --- Relay pages ----------------------------------------------------------------
// The two helper pages the legacy client opens as popups: Google sign-in and the
// QR scanner (server/client/relay/). They used to live on Firebase Hosting; the
// client is repointed at these routes in page-rewrites.js. They are served from
// the app's own origin so they can post to /exec without CORS, and so the
// camera=(self) Permissions-Policy above lets the scanner use the camera.
// Never cached: the sign-in page carries a per-attempt verifyToken in its query
// string, and a stale copy of either page would outlive a fix.
const RELAY_PAGES_DIR = path.join(__dirname, 'client', 'relay');

function serveRelayPage(fileName) {
  // The relay pages name Google Fonts like the app's own pages do, so they get the same
  // serve-time rewrite (page-rewrites.js): the files in client/relay/ stay as written.
  const readPage = () => rewriteLegacyShell(fs.readFileSync(path.join(RELAY_PAGES_DIR, fileName), 'utf8'));
  const pageHtml = readPage(); // a missing page stops the server at startup, not at the first scan
  return (_req, res) => {
    res.type('html').set('Cache-Control', 'no-store').send(process.env.BASAER_REBUILD ? readPage() : pageHtml);
  };
}

app.get('/relay/google-signin', serveRelayPage('google-signin.html'));
app.get('/relay/qr-scan', serveRelayPage('qr-scan.html'));

// --- Sessions -----------------------------------------------------------------
app.use('/api/auth', (req, res, next) => {
  const verdict = limits.authEndpoint.hit(req.ip);
  if (!verdict.allowed) return tooManyRequests(res, verdict, 'auth');
  next();
});

// Trade a custom token (minted by a login function in auth.js) for a session
// cookie and an access token.
app.post('/api/auth/exchange', jsonBody, (req, res) => {
  try {
    const uid = verifyCustomToken(req.body && req.body.customToken);
    const cpr = String(uid).replace(/^u/, '');
    roleCache.delete(cpr); // force a fresh role lookup on next call
    res.json(issueSession(res, { cpr, uid }));
  } catch (err) {
    res.status(401).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// Fresh access token from the session cookie; renews the cookie (sliding
// expiry) up to the absolute cap. The previous cookie is deliberately NOT
// revoked here: two tabs refreshing at the same instant both carry it, and
// the second would otherwise be logged out.
app.post('/api/auth/session', (req, res) => {
  const payload = sessionFromCookie(req);
  if (!payload || !passesCsrfRule(req)) return res.status(401).json({ ok: false });
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.sat && nowSeconds - payload.sat > SESSION_ABSOLUTE_MAX_SECONDS) {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return res.status(401).json({ ok: false, error: 'session too old' });
  }
  res.json(issueSession(res, { cpr: String(payload.cpr), uid: payload.uid || payload.sub, sessionStartedAt: payload.sat }));
});

// Logout revokes the session server-side, so a copied cookie stops working
// too, not only the browser's own copy.
app.post('/api/auth/logout', (req, res) => {
  const payload = sessionFromCookie(req);
  if (payload) {
    if (payload.sid && payload.exp) storage.revokeSession(payload.sid, payload.exp * 1000);
    roleCache.delete(String(payload.cpr));
  }
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.json({ ok: true });
});

// --- RPC: google.script.run -> POST /api/rpc/:fn ---------------------------------
// Emails the Google verifier has proven, consumed by loginWithGoogleVerifiedEmail.
const verifiedGoogleEmails = new Map(); // email -> expiry (ms)
const VERIFIED_EMAIL_TTL_MS = 5 * 60 * 1000;
// Registration: the browser tells newStuReg whether the email was verified,
// which it cannot be trusted to do (SECURITY-FINDINGS #12). The server watches
// the OTP exchange itself — requestRegistrationOtp(cpr, email) then
// verifyRegistrationOtp(cpr, code) succeeding — and only an email it saw
// verified (here or by Google) may be recorded as verified.
const pendingRegistrationEmails = new Map();  // cpr -> email the OTP was sent to
const verifiedRegistrationEmails = new Map(); // email -> expiry (ms)
const VERIFIED_REGISTRATION_TTL_MS = 30 * 60 * 1000;

function identifierArgument(args) {
  const value = args && args.length ? args[0] : '';
  return String(value == null ? '' : value).trim().toLowerCase().slice(0, 64);
}

function normalisedEmailArgument(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function isServerVerifiedEmail(email) {
  const now = Date.now();
  return (verifiedRegistrationEmails.get(email) || 0) > now || (verifiedGoogleEmails.get(email) || 0) > now;
}

// Adjust the arguments of a registration call before dispatch: a claimed
// emailVerified survives only for an email this server verified.
function gateRegistrationArguments(args) {
  const data = args[0];
  if (!data || typeof data !== 'object') return args;
  if (data.emailVerified === false) return args;
  const email = normalisedEmailArgument(data.mail);
  if (email && isServerVerifiedEmail(email)) return args;
  const adjusted = args.slice();
  adjusted[0] = Object.assign({}, data, { emailVerified: false });
  return adjusted;
}

// Record what a successful call proved, for the gates above.
function noteRegistrationProgress(fn, args, result) {
  const succeeded = result && typeof result === 'object' && result.ok === true;
  if (fn === 'requestRegistrationOtp' && succeeded) {
    pendingRegistrationEmails.set(identifierArgument(args), normalisedEmailArgument(args[1]));
  } else if (fn === 'verifyRegistrationOtp' && succeeded) {
    const email = pendingRegistrationEmails.get(identifierArgument(args));
    if (email) verifiedRegistrationEmails.set(email, Date.now() + VERIFIED_REGISTRATION_TTL_MS);
    pendingRegistrationEmails.delete(identifierArgument(args));
  } else if (fn === 'newStuReg' && args[0] && typeof args[0] === 'object') {
    verifiedRegistrationEmails.delete(normalisedEmailArgument(args[0].mail));
  }
}

app.post('/api/rpc/:fn', jsonBody, async (req, res) => {
  const fn = req.params.fn;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(fn)) return res.status(400).json({ ok: false, error: 'bad function name' });
  if (!req.body || !Array.isArray(req.body.args)) return res.status(400).json({ ok: false, error: 'args must be an array' });
  const args = req.body.args;

  const caller = await callerFrom(req);
  if (caller) res.locals.callerCpr = caller.cpr;

  // Rate limits: anonymous traffic per IP; authenticated per caller;
  // identity-proving and OTP-sending calls additionally per target.
  const paceVerdict = caller ? limits.authenticatedRpc.hit('cpr:' + caller.cpr) : limits.anonymousRpc.hit('ip:' + req.ip);
  if (!paceVerdict.allowed) return tooManyRequests(res, paceVerdict, 'rpc');
  if (CREDENTIAL_FUNCTIONS.has(fn)) {
    const perIp = limits.credentialPerIp.hit('ip:' + req.ip);
    if (!perIp.allowed) return tooManyRequests(res, perIp, 'login');
    const target = identifierArgument(args);
    if (target) {
      const perTargetAndIp = limits.credentialPerTargetAndIp.hit(target + '|' + req.ip);
      if (!perTargetAndIp.allowed) return tooManyRequests(res, perTargetAndIp, 'login');
      const perTarget = limits.credentialPerTarget.hit(target);
      if (!perTarget.allowed) return tooManyRequests(res, perTarget, 'login');
    }
  }
  if (OTP_REQUEST_FUNCTIONS.has(fn)) {
    const target = identifierArgument(args) || req.ip;
    const perTargetAndIp = limits.otpRequestPerTargetAndIp.hit(target + '|' + req.ip);
    if (!perTargetAndIp.allowed) return tooManyRequests(res, perTargetAndIp, 'otp');
    const perTarget = limits.otpRequestPerTarget.hit(target);
    if (!perTarget.allowed) return tooManyRequests(res, perTarget, 'otp');
  }

  const decision = enforce(fn, args, caller);
  if (!decision.allow) {
    return res.status(decision.status || 403).json({ ok: false, error: decision.message || 'غير مسموح' });
  }

  // Login paths that need a server-side gate the gas code cannot provide.
  if (fn === 'skipEmailVerificationLogin' && !ALLOW_CPR_ONLY_LOGIN) {
    return res.status(403).json({ ok: false, error: 'تسجيل الدخول دون التحقق من البريد غير مفعّل على هذا الخادم.' });
  }
  let googleEmailToConsume = null;
  if (fn === 'loginWithGoogleVerifiedEmail') {
    const email = String(args[1] == null ? '' : args[1]).trim().toLowerCase();
    const expiresAt = verifiedGoogleEmails.get(email);
    if (!email || !expiresAt || expiresAt < Date.now()) {
      return res.status(403).json({ ok: false, error: 'لم يتم التحقق من هذا البريد عبر جوجل. يرجى إعادة المحاولة أو استخدام رمز التحقق.' });
    }
    googleEmailToConsume = email;
  }

  let dispatchArgs = decision.args || args;
  if (fn === 'newStuReg') dispatchArgs = gateRegistrationArguments(dispatchArgs);

  try {
    const result = scopeResult(decision, await rpcPool.call('call', { fn, args: dispatchArgs, context: { clientIp: req.ip } }));
    if (googleEmailToConsume && result && result.ok) verifiedGoogleEmails.delete(googleEmailToConsume);
    noteRegistrationProgress(fn, dispatchArgs, result);
    res.json({ ok: true, result: result === undefined ? null : result });
  } catch (err) {
    const reference = crypto.randomBytes(4).toString('hex');
    res.locals.errorReference = reference;
    console.error(`RPC ${fn} failed [${reference}]:`, err.workerStack || (err && err.stack) || err);
    res.status(err.status || 500).json({ ok: false, error: clientErrorMessage(err, reference) });
  }
});

// --- doPost port: the relay pages POST JSON {action, ...} here --------------
// Actions and what proves the caller:
//   qrAttend      the QR session token a staff member started (unchanged)
//   oauthVerify   a Google/Firebase ID token verified here; the email the
//                 relay claims is replaced by the verified one
//   saveFcmToken  a logged-in session; a student may only set their own token
app.post('/exec', rawTextBody, async (req, res) => {
  const verdict = limits.exec.hit(req.ip);
  if (!verdict.allowed) return tooManyRequests(res, verdict, 'exec');
  const body = Object.assign({}, parseExecBody(req.body));
  try {
    if (body.action === 'oauthVerify') {
      if (!googleTokenVerifier.enabled) {
        return res.status(503).json({ status: 'error', message: 'تسجيل الدخول عبر جوجل غير مفعّل على هذا الخادم.' });
      }
      let verified;
      try {
        verified = await googleTokenVerifier.verify(body.idToken);
      } catch (err) {
        return res.status(401).json({ status: 'error', message: 'تعذر التحقق من حساب جوجل: ' + err.message });
      }
      body.ok = true;
      body.email = verified.email;
      body.provider = verified.provider;
      verifiedGoogleEmails.set(verified.email, Date.now() + VERIFIED_EMAIL_TTL_MS);
    } else if (body.action === 'saveFcmToken') {
      const caller = await callerFrom(req);
      if (!caller) return res.status(401).json({ status: 'error', message: 'يلزم تسجيل الدخول.' });
      res.locals.callerCpr = caller.cpr;
      if (!caller.isStaff) body.studentId = caller.cpr;
    }
    const content = await rpcPool.call('doPost', { body });
    res.type('application/json').send(content);
  } catch (err) {
    const reference = crypto.randomBytes(4).toString('hex');
    res.locals.errorReference = reference;
    console.error(`/exec ${body.action} failed [${reference}]:`, err.workerStack || (err && err.stack) || err);
    res.status(500).json({ status: 'error', message: clientErrorMessage(err, reference) });
  }
});

// ---- Local file store (Drive replacement) ----------------------------------
// Public files (shared "anyone with link") are served without auth; everything
// else needs a session (the cookie makes plain links work in a new tab).
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// Only these are shown inline in the browser; everything else is a download.
// Stored files come from uploads and from the gas code (PDF certificates, PNG
// cards), and the app's own origin must never render user-supplied markup.
const INLINE_MIME_RE = /^(application\/pdf|image\/(jpeg|png|gif|webp)|audio\/|video\/|text\/plain)/i;
const ACTIVE_CONTENT_MIME_RE = /html|xml|svg|javascript|ecmascript/i;

app.get('/files/folder/:id', async (req, res) => {
  if (!FILE_ID_RE.test(req.params.id)) return res.status(404).json({ status: 'error', message: 'folder not found' });
  const caller = await callerFrom(req);
  if (!caller) return res.status(401).json({ status: 'error', message: 'authentication required' });
  res.locals.callerCpr = caller.cpr;
  const folderRecord = storage.db.prepare('SELECT * FROM files WHERE id = ? AND is_folder = 1 AND trashed = 0').get(req.params.id);
  if (!folderRecord) return res.status(404).json({ status: 'error', message: 'folder not found' });
  const childRecords = storage.db
    .prepare('SELECT * FROM files WHERE parent_id = ? AND is_folder = 0 AND trashed = 0 ORDER BY name')
    .all(folderRecord.id);
  res.json({
    id: folderRecord.id,
    name: folderRecord.name,
    files: childRecords.map((record) => ({
      id: record.id,
      name: record.name,
      mime: record.mime,
      size: record.size,
      url: `/files/${record.id}/${encodeURIComponent(record.name)}`,
    })),
  });
});

// --- Student work upload: replaces the old direct-to-Drive client upload ---
const studentWorkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
app.post('/api/upload/student-work', async (req, res) => {
  const caller = await callerFrom(req);
  if (!caller) return res.status(401).json({ ok: false, message: 'authentication required' });
  res.locals.callerCpr = caller.cpr;
  if (!caller.isStudent && !caller.isStaff) return res.status(403).json({ ok: false, message: 'forbidden' });
  studentWorkUpload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ ok: false, message: tooLarge ? 'file too large' : 'bad upload' });
    }
    if (!req.file) return res.status(400).json({ ok: false, message: 'file is required' });
    if (!caller.isStaff) {
      // Students may only upload into their own folder.
      let ownFolderUrl = '';
      try {
        const persons = await rpcPool.call('call', { fn: 'getPersons', args: [] });
        const me = Array.isArray(persons) ? persons.find((p) => String(p.cpr) === String(caller.cpr)) : null;
        ownFolderUrl = me ? me.folderUrl : '';
      } catch (_) { /* fall through to deny */ }
      if (!isOwnFolder(ownFolderUrl, req.body && req.body.folderId)) {
        return res.status(403).json({ ok: false, message: 'uploads are only allowed into your own student folder' });
      }
    }
    try {
      const stored = storeStudentWork(driveShims, {
        folderId: req.body && req.body.folderId,
        fileName: req.body && req.body.fileName,
        bytes: req.file.buffer,
        originalName: req.file.originalname,
      });
      res.json({ ok: true, id: stored.id, name: stored.name, url: stored.url });
    } catch (err) {
      res.status(err.status || 500).json({ ok: false, message: err.status ? err.message : 'upload failed' });
    }
  });
});

// Serve one stored file by id: public files to anyone, the rest to a session.
async function serveStoredFile(req, res, fileId) {
  if (!FILE_ID_RE.test(String(fileId || ''))) return res.status(404).send('Not found');
  const fileRecord = storage.db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  if (!fileRecord || fileRecord.is_folder || fileRecord.trashed) return res.status(404).send('Not found');
  if (!fileRecord.is_public) {
    const caller = await callerFrom(req);
    if (!caller) return res.status(401).send('Authentication required');
    res.locals.callerCpr = caller.cpr;
  }
  const contentPath = path.join(FILES_DIR, fileRecord.id);
  if (!fs.existsSync(contentPath)) return res.status(404).send('Not found');
  // Markup-like types are never served as such; inline display only for the
  // safe set (none of which can run script); everything else downloads, with
  // a CSP sandbox so that even a file a browser insists on rendering cannot
  // run script on this origin or read its cookies.
  const contentType = ACTIVE_CONTENT_MIME_RE.test(fileRecord.mime || '') ? 'application/octet-stream' : (fileRecord.mime || 'application/octet-stream');
  const showInline = req.query.download !== '1' && INLINE_MIME_RE.test(contentType);
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': fileRecord.is_public ? 'public, max-age=300' : 'private, max-age=300',
    'Content-Disposition': (showInline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(fileRecord.name),
  };
  if (!showInline) headers['Content-Security-Policy'] = 'sandbox; default-src \'none\'';
  // Streams the file (range requests, ETag) instead of reading it into memory.
  res.sendFile(contentPath, { headers, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(err.status || 500).send('Not found');
  });
}

app.get('/files/:id/:name?', (req, res) => serveStoredFile(req, res, req.params.id));

// The legacy pages load logos, avatars and carousel images from
// drive.google.com/thumbnail?id=<id>&sz=w500; page-rewrites.js turns that into
// /thumb?id=<id>&sz=w500. The size hint is ignored: the stored image is served.
app.get('/thumb', (req, res) => serveStoredFile(req, res, req.query.id));

// docs.google.com/document/d/<id>/edit|preview, rewritten to /doc/<id>/<mode>
// (admin template screen). edit: download the .docx to edit locally; preview:
// the document converted to PDF (cached beside the file as <id>.preview.pdf).
// Staff only — templates are not public files.
app.get('/doc/:id/:mode', async (req, res) => {
  if (!FILE_ID_RE.test(req.params.id)) return res.status(404).send('Not found');
  const caller = await callerFrom(req);
  if (!caller || !caller.isStaff) return res.status(caller ? 403 : 401).send('Staff only');
  res.locals.callerCpr = caller.cpr;
  const fileRecord = storage.db.prepare('SELECT * FROM files WHERE id = ? AND is_folder = 0 AND trashed = 0').get(req.params.id);
  const contentPath = path.join(FILES_DIR, req.params.id);
  if (!fileRecord || !fs.existsSync(contentPath)) return res.status(404).send('Not found');
  if (req.params.mode === 'edit') {
    req.query.download = '1';
    return serveStoredFile(req, res, req.params.id);
  }
  if (req.params.mode !== 'preview') return res.status(404).send('Not found');
  try {
    const previewPath = contentPath + '.preview.pdf';
    const stale = !fs.existsSync(previewPath) || fs.statSync(previewPath).mtimeMs < fs.statSync(contentPath).mtimeMs;
    if (stale) {
      const extension = /presentation/.test(fileRecord.mime) ? 'pptx' : 'docx';
      fs.writeFileSync(previewPath, convertWithSoffice(fs.readFileSync(contentPath), extension, 'pdf'));
    }
    res.set('Content-Type', 'application/pdf').set('Cache-Control', 'private, max-age=60');
    res.set('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(fileRecord.name.replace(/\.[^.]+$/, '') + '.pdf'));
    res.sendFile(previewPath, { dotfiles: 'deny' });
  } catch (err) {
    console.error('doc preview failed for', req.params.id, err.message);
    res.status(500).send('Preview failed');
  }
});

app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, mode: OUTBOUND_MODE, rpc: rpcPool.stats(), background: backgroundPool.stats() });
});

// --- Dev-only inspection (never in production): what would have been sent ---
// Lets a tester read an OTP code or see a queued WhatsApp message without any
// real delivery. Requires an admin session so students can't read others' mail.
if (!IS_PROD) {
  const requireAdmin = async (req, res, next) => {
    const caller = await callerFrom(req);
    if (!caller || !caller.isAdmin) return res.status(403).json({ ok: false, error: 'admin only' });
    next();
  };
  app.get('/dev/outbox', requireAdmin, (req, res) => {
    const limit = Math.min(+req.query.limit || 50, 500);
    res.json(storage.db.prepare('SELECT id, created_at, to_addr, subject, body_text, status, error FROM outbox ORDER BY id DESC LIMIT ?').all(limit));
  });
  app.get('/dev/outbound', requireAdmin, (req, res) => {
    const limit = Math.min(+req.query.limit || 50, 500);
    res.json(storage.db.prepare('SELECT id, created_at, mode, host, method, url, status, payload FROM outbound_log ORDER BY id DESC LIMIT ?').all(limit));
  });
  app.get('/dev/triggers', requireAdmin, (_req, res) => {
    res.json(storage.db.prepare('SELECT * FROM triggers ORDER BY due_at').all());
  });
}

// Malformed JSON and other body-parser errors should be a 400, not a stack trace.
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'invalid JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'request too large' });
  console.error('unhandled request error:', err && err.stack ? err.stack : err);
  res.status(500).json({ ok: false, error: 'server error' });
});

// --- Start --------------------------------------------------------------------
// Time-based triggers (queues, exam monitors) run on the background worker.
const scheduler = new Scheduler({ storage, runHandler: (handler) => backgroundPool.call('call', { fn: handler, args: [] }) });

let httpServer = null;
async function start() {
  await Promise.all([rpcPool.start(), backgroundPool.start()]);
  scheduler.start(1000);
  // Expired OTP codes, QR sessions and revoked session ids are deleted lazily
  // on read; sweep the rest (and the in-memory maps) so nothing grows unbounded.
  setInterval(() => {
    try { storage.cacheSweepExpired(); } catch (_) { /* best effort */ }
    const now = Date.now();
    for (const [email, expiresAt] of verifiedGoogleEmails) if (expiresAt < now) verifiedGoogleEmails.delete(email);
    for (const [email, expiresAt] of verifiedRegistrationEmails) if (expiresAt < now) verifiedRegistrationEmails.delete(email);
    if (pendingRegistrationEmails.size > 10000) pendingRegistrationEmails.clear();
    for (const [cpr, entry] of roleCache) if (!entry.promise && entry.exp < now) roleCache.delete(cpr);
  }, 10 * 60 * 1000).unref();

  httpServer = app.listen(PORT, () => {
    console.log(`Basaer server listening on ${BASE_URL}`);
    console.log(`  gas dir:  ${GAS_DIR}`);
    console.log(`  db:       ${DB_PATH}`);
    console.log(`  workers:  ${RPC_WORKERS} rpc + 1 background`);
    console.log(`  outbound: ${OUTBOUND_MODE}${OUTBOUND_MODE === 'dry-run' ? ' (emails/WhatsApp/push recorded, not sent)' : ''}`);
    console.log(`  google sign-in: ${googleTokenVerifier.enabled ? 'enabled' : 'disabled (set FIREBASE_PROJECT_ID or GOOGLE_OAUTH_CLIENT_ID)'}`);
    if (ALLOW_CPR_ONLY_LOGIN) console.log('  WARNING: ALLOW_CPR_ONLY_LOGIN=1 — anyone who knows a CPR can log in as it');
  });
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  scheduler.stop();
  if (httpServer) httpServer.close();
  await Promise.all([rpcPool.shutdown(), backgroundPool.shutdown()]);
  storage.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  console.error('startup failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
