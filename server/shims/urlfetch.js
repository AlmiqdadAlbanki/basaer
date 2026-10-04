'use strict';

// UrlFetchApp shim.
//
// Phase 3 implements only the Google auth hosts that auth.js calls, routed to
// the local IdentityService + session-token verifier so auth.js stays
// unchanged. Every other host throws a clear, named error until phase 4 wires
// real outbound HTTP (which needs a worker, because UrlFetchApp is synchronous
// and fetch is not).

const { Blob } = require('./utilities.js');

function makeResponse(code, bodyObjOrString, headers) {
  const text = typeof bodyObjOrString === 'string' ? bodyObjOrString : JSON.stringify(bodyObjOrString);
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getContent: () => Array.from(Buffer.from(text, 'utf8')),
    getBlob: () => new Blob(Buffer.from(text, 'utf8'), (headers && headers['Content-Type']) || 'application/json'),
    getAllHeaders: () => headers || {},
    getHeaders: () => headers || {},
  };
}

function parsePayload(params) {
  if (!params || params.payload == null) return {};
  if (typeof params.payload === 'string') {
    try { return JSON.parse(params.payload); } catch (_) { return {}; }
  }
  return params.payload; // object form (e.g. the oauth2 token form body)
}

// opts: { identityService, identity }  (read lazily so construction order is free)
function makeUrlFetchApp(opts) {
  function fetch(url, params) {
    params = params || {};
    const svc = opts.identityService;
    const identity = opts.identity;
    const u = String(url);

    // 1) Service-account token exchange -> dummy admin access token.
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      return makeResponse(200, { access_token: 'local-admin-token', expires_in: 3600, token_type: 'Bearer' });
    }

    // 2) Password sign-in (login / change-password current-password check).
    if (u.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword')) {
      const body = parsePayload(params);
      const uid = svc.verifyPassword(body.email, body.password);
      if (!uid) return makeResponse(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } });
      return makeResponse(200, { localId: uid, email: body.email, idToken: 'local-signin', registered: true });
    }

    // 3) Admin password set/reset.
    if (u.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:update')) {
      const body = parsePayload(params);
      if (!body.localId) return makeResponse(400, { error: { message: 'MISSING_LOCAL_ID' } });
      const cpr = String(body.localId).replace(/^u/, '');
      svc.setPassword(body.localId, body.email, cpr, body.password);
      return makeResponse(200, { localId: body.localId, email: body.email, emailVerified: true });
    }

    // 4) ID-token lookup (requireVerifiedSuperAdmin_). The client holds our own
    //    session token; verify it and report the matching account.
    if (u.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup')) {
      const body = parsePayload(params);
      try {
        const payload = identity.verifyToken(body.idToken);
        const uid = payload.sub || ('u' + payload.cpr);
        return makeResponse(200, { users: [{ localId: uid, emailVerified: true }] });
      } catch (_) {
        return makeResponse(400, { error: { message: 'INVALID_ID_TOKEN' } });
      }
    }

    const host = (u.match(/^https?:\/\/([^/]+)/) || [])[1] || u;
    throw new Error('UrlFetchApp: outbound HTTP to ' + host + ' is not available in this build (wired in phase 4).');
  }

  return {
    fetch,
    fetchAll: (requests) => (requests || []).map((r) => (typeof r === 'string' ? fetch(r) : fetch(r.url, r))),
    getRequest: () => { throw new Error('UrlFetchApp.getRequest not supported'); },
  };
}

module.exports = { makeUrlFetchApp, makeResponse };
