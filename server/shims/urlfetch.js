'use strict';

// UrlFetchApp shim.
//
// Four kinds of destination:
//   1. Google auth hosts (identitytoolkit / oauth2) — served locally by the
//      IdentityService so auth.js runs unchanged (see the plan's auth decision).
//   2. api.qrserver.com (QR-code images) — drawn locally by docgen/qr.js in BOTH
//      modes, so the text of a QR code (a certificate link, a CPR) never goes to a
//      third party and the gas code gets a real, scannable PNG even in dry-run.
//      Recorded in `outbound_log` with mode 'local-qr'.
//   3. Everything else in dry-run mode (the default) — the request is recorded
//      in `outbound_log` and a plausible success reply is returned per provider,
//      so WhatsApp/push features exercise fully without contacting anyone.
//   4. Everything else in live mode — a real synchronous HTTP call via curl
//      (UrlFetchApp is synchronous; Node's fetch is not, and curl is the
//      simplest dependable sync path for this traffic volume).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Blob } = require('./utilities.js');
const { renderQrPng, parseQrServerUrl } = require('../docgen/qr.js');

// 1x1 transparent PNG, used as the dry-run reply for the Slides PNG export (docs.google.com).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function makeResponse(statusCode, body, headers) {
  const isBuffer = Buffer.isBuffer(body);
  const bodyText = isBuffer ? body.toString('utf8') : (typeof body === 'string' ? body : JSON.stringify(body));
  const bodyBytes = isBuffer ? body : Buffer.from(bodyText, 'utf8');
  const responseHeaders = headers || {};
  return {
    getResponseCode: () => statusCode,
    getContentText: () => bodyText,
    getContent: () => Array.from(bodyBytes),
    getBlob: () => new Blob(bodyBytes, responseHeaders['Content-Type'] || responseHeaders['content-type'] || 'application/json'),
    getAllHeaders: () => responseHeaders,
    getHeaders: () => responseHeaders,
  };
}

function parsePayload(params) {
  if (!params || params.payload == null) return {};
  if (typeof params.payload === 'string') {
    try { return JSON.parse(params.payload); } catch (_) { return { _raw: params.payload }; }
  }
  return params.payload;
}

function hostOf(url) {
  return (String(url).match(/^https?:\/\/([^/?#]+)/) || [])[1] || String(url);
}

// The `iss` claim of a JWT-bearer assertion in an oauth2 token request, or ''.
function assertionIssuer(params) {
  try {
    const p = parsePayload(params);
    const jwt = p && p.assertion;
    if (!jwt) return '';
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.iss || '';
  } catch (_) { return ''; }
}

// Canned dry-run replies shaped like what the calling code reads back.
function dryRunReply(url, params) {
  const host = hostOf(url);
  const urlText = String(url);
  if (host === 'api.fonnte.com') {
    if (/\/send/.test(urlText)) return makeResponse(200, { status: true, detail: 'dry-run', id: ['dry-run-' + Date.now()], process: 'pending' });
    return makeResponse(200, { status: true, data: [] }); // group listing endpoints
  }
  if (host === 'graph.facebook.com') {
    if (/\/messages$/.test(urlText)) return makeResponse(200, { messaging_product: 'whatsapp', messages: [{ id: 'wamid.dryrun.' + Date.now() }] });
    if (/message_templates/.test(urlText)) return (params && /post/i.test(params.method || 'get'))
      ? makeResponse(200, { id: 'tpl-dryrun-' + Date.now(), status: 'PENDING' })
      : makeResponse(200, { data: [] });
    return makeResponse(200, { success: true });
  }
  if (host === 'fcm.googleapis.com') return makeResponse(200, { name: 'projects/basaer-local/messages/dryrun-' + Date.now() });
  if (host === 'docs.google.com') return makeResponse(200, TINY_PNG, { 'Content-Type': 'image/png' }); // Slides PNG export
  if (host === 'script.google.com') return makeResponse(200, { area: '', block: '' }); // external block->area lookup
  return makeResponse(200, { ok: true, dryRun: true });
}

// Real synchronous HTTP via curl.
function liveFetch(url, params) {
  params = params || {};
  const method = String(params.method || 'GET').toUpperCase();
  const args = ['-s', '-S', '-X', method, '--max-time', '30', '-w', '\n__HTTP_STATUS__:%{http_code}'];
  const headers = Object.assign({}, params.headers || {});
  if (params.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = params.contentType;
  }
  for (const k of Object.keys(headers)) args.push('-H', `${k}: ${headers[k]}`);
  if (params.payload != null) {
    if (typeof params.payload === 'string') args.push('--data-binary', params.payload);
    else if (Buffer.isBuffer(params.payload)) args.push('--data-binary', params.payload.toString('latin1'));
    else {
      const ct = (headers['Content-Type'] || '').toLowerCase();
      if (ct.includes('json')) args.push('--data-binary', JSON.stringify(params.payload));
      else for (const k of Object.keys(params.payload)) args.push('--data-urlencode', `${k}=${params.payload[k]}`);
    }
  }
  args.push(String(url));
  const result = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error('UrlFetchApp: ' + result.error.message);
  const output = result.stdout || '';
  const statusMarkerAt = output.lastIndexOf('\n__HTTP_STATUS__:');
  const statusCode = statusMarkerAt >= 0 ? parseInt(output.slice(statusMarkerAt + 17), 10) : 0;
  const responseBody = statusMarkerAt >= 0 ? output.slice(0, statusMarkerAt) : output;
  if (!statusCode) throw new Error('UrlFetchApp: request failed: ' + (result.stderr || 'no response'));
  return makeResponse(statusCode, responseBody);
}

// opts: { identityService, identity, storage, mode: 'dry-run'|'live', log,
//         getCallContext } — getCallContext() returns the current call's
//         { clientIp } so the login lockout can be keyed per client.
function makeUrlFetchApp(opts) {
  const mode = opts.mode || 'dry-run';
  const log = opts.log || (() => {});
  const getCallContext = opts.getCallContext || (() => ({}));

  // `recordedMode` replaces the shim's mode in the row, for calls that never left
  // the machine ('local-qr') and so must not show up as 'live' traffic.
  function record(url, params, code, responseText, recordedMode) {
    if (!opts.storage) return;
    try {
      opts.storage.db
        .prepare('INSERT INTO outbound_log (created_at, mode, host, url, method, payload, status, response) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Date.now(), recordedMode || mode, hostOf(url), String(url).slice(0, 2000),
          String((params && params.method) || 'GET').toUpperCase(),
          typeof (params && params.payload) === 'string' ? params.payload.slice(0, 4000) : JSON.stringify((params && params.payload) || null).slice(0, 4000),
          code, String(responseText || '').slice(0, 2000));
    } catch (_) { /* logging must never break a call */ }
  }

  // The file id a Drive URL or one of our own /files URLs names, or null.
  function fileIdFromUrl(urlText) {
    const host = hostOf(urlText).toLowerCase();
    if (host === 'drive.google.com' || host === 'docs.google.com') {
      const match = /\/(?:file\/d|document\/d|presentation\/d|spreadsheets\/d)\/([-\w]+)/.exec(urlText) || /[?&]id=([-\w]+)/.exec(urlText);
      return match ? match[1] : null;
    }
    const own = /\/files\/([-\w]+)(?:\/|$|\?)/.exec(urlText.replace(/^https?:\/\/[^/]+/, ''));
    return own && !/^files\/folder/.test(own[0].slice(1)) ? own[1] : null;
  }

  // { id, mime, bytes } for a file present in the local store, else null.
  function lookupLocalFile(urlText) {
    if (!opts.storage || !opts.filesDir) return null;
    const id = fileIdFromUrl(urlText);
    if (!id) return null;
    try {
      const record = opts.storage.db.prepare('SELECT id, mime FROM files WHERE id = ? AND is_folder = 0 AND trashed = 0').get(id);
      if (!record) return null;
      const contentPath = path.join(opts.filesDir, record.id);
      if (!fs.existsSync(contentPath)) return null;
      return { id: record.id, mime: record.mime || 'application/octet-stream', bytes: fs.readFileSync(contentPath) };
    } catch (_) {
      return null;
    }
  }

  function fetch(url, params) {
    params = params || {};
    const urlText = String(url);
    const identityService = opts.identityService;
    const identity = opts.identity;

    // --- 1) Local auth backend (auth.js unchanged) ---------------------------
    // Only hijack the token exchange when the JWT assertion was issued by OUR
    // local service account (auth.js's Firebase-admin flow). A real service
    // account (e.g. FCM in live mode) falls through to a genuine exchange.
    if (identityService && urlText.startsWith('https://oauth2.googleapis.com/token') && assertionIssuer(params) === opts.localIssuer) {
      return makeResponse(200, { access_token: 'local-admin-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (identityService && urlText.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')) {
      const requestBody = parsePayload(params);
      const result = identityService.verifyPassword(requestBody.email, requestBody.password, { clientIp: (getCallContext() || {}).clientIp });
      // Firebase-style failures: INVALID_LOGIN_CREDENTIALS, or
      // TOO_MANY_ATTEMPTS_TRY_LATER while the email is locked out.
      if (result.error) return makeResponse(400, { error: { code: 400, message: result.error } });
      return makeResponse(200, { localId: result.uid, email: requestBody.email, idToken: 'local-signin', registered: true });
    }
    if (identityService && urlText.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:update')) {
      const requestBody = parsePayload(params);
      if (!requestBody.localId) return makeResponse(400, { error: { message: 'MISSING_LOCAL_ID' } });
      const cpr = String(requestBody.localId).replace(/^u/, '');
      identityService.setPassword(requestBody.localId, requestBody.email, cpr, requestBody.password);
      return makeResponse(200, { localId: requestBody.localId, email: requestBody.email, emailVerified: true });
    }
    if (identityService && urlText.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const requestBody = parsePayload(params);
      try {
        const tokenPayload = identity.verifyToken(requestBody.idToken);
        return makeResponse(200, { users: [{ localId: tokenPayload.sub || ('u' + tokenPayload.cpr), emailVerified: true }] });
      } catch (_) {
        return makeResponse(400, { error: { message: 'INVALID_ID_TOKEN' } });
      }
    }

    // --- 2) QR codes: drawn locally, in dry-run and live alike ---------------
    // The legacy code fetches every QR image from api.qrserver.com, which would be
    // handed the text of each code. docgen/qr.js draws the same image here instead.
    if (hostOf(urlText).toLowerCase() === 'api.qrserver.com') {
      let png;
      try {
        png = renderQrPng(parseQrServerUrl(urlText));
      } catch (error) {
        throw new Error(`UrlFetchApp: could not draw the QR code for ${hostOf(urlText)}: ${error.message}`, { cause: error });
      }
      record(urlText, params, 200, `(local-qr) image/png, ${png.length} bytes`, 'local-qr');
      // Path only, no query string: the query carries the QR text (a certificate link, a CPR).
      log(`LOCAL-QR ${String(params.method || 'GET').toUpperCase()} ${hostOf(urlText)}${urlText.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0]} (${png.length} bytes)`);
      return makeResponse(200, png, { 'Content-Type': 'image/png' });
    }

    // --- 2b) Files that now live in the local store ---------------------------
    // The legacy code fetches a few Drive files by URL (the academy logo for
    // e-mails, exported cards). Those files were imported under their Drive
    // ids, so a Drive URL — or one of our own /files/<id> URLs — is answered
    // from disk and never leaves the machine. An id that is not in the store
    // falls through to the dry-run/live handling below.
    const localFile = lookupLocalFile(urlText);
    if (localFile) {
      record(urlText, params, 200, `(local-file) ${localFile.mime}, ${localFile.bytes.length} bytes`, 'local-file');
      log(`LOCAL-FILE ${String(params.method || 'GET').toUpperCase()} ${hostOf(urlText)} -> files/${localFile.id}`);
      return makeResponse(200, localFile.bytes, { 'Content-Type': localFile.mime });
    }

    // --- 3) Dry-run: record and fake a success ------------------------------
    if (mode !== 'live') {
      const response = dryRunReply(urlText, params);
      record(urlText, params, response.getResponseCode(), '(dry-run) ' + response.getContentText().slice(0, 200));
      log(`DRY-RUN ${String(params.method || 'GET').toUpperCase()} ${hostOf(urlText)}${urlText.replace(/^https?:\/\/[^/]+/, '').slice(0, 80)}`);
      return response;
    }

    // --- 4) Live --------------------------------------------------------------
    const response = liveFetch(urlText, params);
    record(urlText, params, response.getResponseCode(), response.getContentText());
    const statusCode = response.getResponseCode();
    if ((statusCode < 200 || statusCode >= 300) && !params.muteHttpExceptions) {
      throw new Error(`Request failed for ${hostOf(urlText)} returned code ${statusCode}. Truncated server response: ${response.getContentText().slice(0, 300)}`);
    }
    return response;
  }

  return {
    fetch,
    fetchAll: (requests) => (requests || []).map((r) => (typeof r === 'string' ? fetch(r) : fetch(r.url, r))),
    getRequest: () => { throw new Error('UrlFetchApp.getRequest not supported'); },
  };
}

module.exports = { makeUrlFetchApp, makeResponse };
