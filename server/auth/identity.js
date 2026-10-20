'use strict';

// Local identity: issues and verifies the tokens the client holds, and
// resolves a verified CPR into the caller's roles.
//
// Tokens are RS256 JWTs signed with a keypair kept under data/keys/. Using the
// same shape as a Firebase ID token (iss/aud/sub/exp + a `cpr` claim) keeps the
// door open to swapping in real Firebase later without touching callers: the
// RPC boundary only needs "verify token -> cpr".
//
// Two kinds of token, told apart by the `typ` claim:
//   'session'  long-lived, lives only in an httpOnly cookie the page's scripts
//              cannot read; renewed while the user keeps using the app.
//   'access'   short-lived, handed to the page's scripts for the Authorization
//              header and for the few gas functions that take an ID token
//              argument; re-issued from the session cookie when it nears expiry.
// Script injection on the page can therefore use a session only for minutes,
// not steal a credential that works for days.
//
// Role resolution reuses the existing gas functions as the single source of
// truth (loginData for staff + permissions, checkStudentRegistered for student
// membership) rather than re-implementing the sheet lookups here.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ISS = 'basaer-local';
const AUD = 'basaer';
const TOKEN_KINDS = { session: 'session', access: 'access' };
const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 3600;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

class Identity {
  // opts: { runtime?, keyDir?, accessTtlSeconds?, sessionTtlSeconds? }
  // `runtime` is only needed for resolveRoles (worker threads); the HTTP
  // thread constructs one without it to sign and verify tokens.
  constructor(opts) {
    this.runtime = opts.runtime || null;
    this.accessTtlSeconds = opts.accessTtlSeconds || DEFAULT_ACCESS_TTL_SECONDS;
    this.sessionTtlSeconds = opts.sessionTtlSeconds || DEFAULT_SESSION_TTL_SECONDS;
    const keyDir = opts.keyDir || path.join(__dirname, '..', '..', 'data', 'keys');
    this._loadOrCreateKeys(keyDir);
  }

  _loadOrCreateKeys(keyDir) {
    const priv = path.join(keyDir, 'id_rsa.pem');
    const pub = path.join(keyDir, 'id_rsa.pub.pem');
    if (fs.existsSync(priv) && fs.existsSync(pub)) {
      this.privateKey = fs.readFileSync(priv, 'utf8');
      this.publicKey = fs.readFileSync(pub, 'utf8');
      return;
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(priv, privateKey, { mode: 0o600 });
    fs.writeFileSync(pub, publicKey);
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  // Issue a token for a resolved uid/cpr. `kind` is 'access' (default) or
  // 'session'; the TTL follows the kind unless `ttlSeconds` overrides it.
  signToken(claims, options) {
    const kind = (options && options.kind) || TOKEN_KINDS.access;
    if (!TOKEN_KINDS[kind]) throw new Error('unknown token kind: ' + kind);
    const ttlSeconds = (options && options.ttlSeconds)
      || (kind === TOKEN_KINDS.session ? this.sessionTtlSeconds : this.accessTtlSeconds);
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = Object.assign({
      iss: ISS, aud: AUD, iat: now, exp: now + ttlSeconds,
      sub: claims.uid || ('u' + claims.cpr),
      typ: kind,
    }, claims);
    const signingInput = b64urlJson(header) + '.' + b64urlJson(payload);
    const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(this.privateKey);
    return signingInput + '.' + b64url(sig);
  }

  // Verify a token's signature and claims; returns the payload or throws.
  // With options.kind the token must be of that kind, so a session cookie
  // value can never be replayed as a bearer token or vice versa.
  verifyToken(token, options) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('malformed token');
    const signingInput = parts[0] + '.' + parts[1];
    const ok = crypto.createVerify('RSA-SHA256').update(signingInput).verify(this.publicKey, fromB64url(parts[2]));
    if (!ok) throw new Error('bad signature');
    const payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) throw new Error('token expired');
    if (payload.iss !== ISS || payload.aud !== AUD) throw new Error('wrong issuer/audience');
    if (!payload.cpr) throw new Error('no cpr claim');
    const kind = payload.typ || TOKEN_KINDS.access;
    if (options && options.kind && kind !== options.kind) throw new Error('wrong token kind');
    return payload;
  }

  // Resolve a verified CPR into a caller context used by the policy layer.
  resolveRoles(cpr) {
    if (!this.runtime) throw new Error('resolveRoles needs a Runtime (call it inside a worker)');
    const ctx = {
      cpr: String(cpr),
      isStaff: false,
      isStudent: false,
      perms: { registration: false, dictation: false, exam: false, manage: false, followUp: false, lecturer: false, superAdmin: false },
    };
    try {
      const emp = this.runtime.call('loginData', [ctx.cpr]);
      if (Array.isArray(emp) && emp.length > 0) {
        ctx.isStaff = true;
        const e = emp[0];
        ctx.perms.registration = !!e.registration;
        ctx.perms.dictation = !!e.dictation;
        ctx.perms.exam = !!e.exam;
        ctx.perms.manage = !!e.manage;
        ctx.perms.followUp = !!e.followUp;
        ctx.perms.superAdmin = e.superAdmin === true;
      }
    } catch (_) { /* leave defaults */ }
    try {
      const s = this.runtime.call('checkStudentRegistered', [ctx.cpr]);
      ctx.isStudent = !!(s && s.found);
    } catch (_) { /* leave defaults */ }
    ctx.isAdmin = ctx.perms.manage || ctx.perms.superAdmin;
    ctx.isEditor = ctx.perms.exam;
    return ctx;
  }
}

module.exports = { Identity, TOKEN_KINDS };
