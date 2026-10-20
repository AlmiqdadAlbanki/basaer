'use strict';

// Verifies ID tokens issued by Google for the "sign in with Google" relay page.
//
// The legacy flow trusted whatever email string the relay page POSTed
// (SECURITY-FINDINGS #6): anyone could claim any address and then call
// loginWithGoogleVerifiedEmail for the CPR that owns it. The relay now sends
// the ID token it received from Google, and only an email this verifier has
// checked — signature against Google's published keys, issuer, audience,
// expiry, email_verified — is accepted as proven.
//
// Two issuers are supported, each enabled by configuration:
//   Firebase Auth ID tokens  (FIREBASE_PROJECT_ID)  — what the relay gets from
//                            firebase.auth().currentUser.getIdToken()
//   Google OAuth ID tokens   (GOOGLE_OAUTH_CLIENT_ID) — from Google Identity
//                            Services directly
// With neither configured the verifier is disabled and the Google login path
// is refused outright.

const crypto = require('crypto');

const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const KEY_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

function fromB64url(text) {
  return Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment(text) {
  return JSON.parse(fromB64url(text).toString('utf8'));
}

// Turns a key document into { kid -> KeyObject }. Google publishes the
// Firebase keys as { kid: "<PEM certificate>" } and the OAuth keys as a JWKS
// { keys: [{ kid, kty, n, e }] }; createPublicKey reads both.
function keysFromDocument(document) {
  const keys = new Map();
  if (document && Array.isArray(document.keys)) {
    for (const jwk of document.keys) {
      if (jwk && jwk.kid && jwk.kty === 'RSA') keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
  } else if (document && typeof document === 'object') {
    for (const kid of Object.keys(document)) {
      if (typeof document[kid] === 'string') keys.set(kid, crypto.createPublicKey(document[kid]));
    }
  }
  return keys;
}

class GoogleTokenVerifier {
  // opts: { firebaseProjectId?, googleClientId?, fetchImpl?, now?, keyUrls? }
  constructor(opts) {
    opts = opts || {};
    this.firebaseProjectId = opts.firebaseProjectId || '';
    this.googleClientId = opts.googleClientId || '';
    this.fetchImpl = opts.fetchImpl || ((url) => fetch(url));
    this.now = opts.now || (() => Date.now());
    this.keyUrls = Object.assign({ firebase: FIREBASE_CERTS_URL, google: GOOGLE_JWKS_URL }, opts.keyUrls || {});
    // source -> { keys: Map, fetchedAt }
    this._keyCache = new Map();
  }

  get enabled() {
    return !!(this.firebaseProjectId || this.googleClientId);
  }

  async _keysFor(source, forceRefresh) {
    const cached = this._keyCache.get(source);
    if (cached && !forceRefresh && this.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.keys;
    const response = await this.fetchImpl(this.keyUrls[source]);
    if (!response || !response.ok) throw new Error('could not fetch Google signing keys');
    const keys = keysFromDocument(await response.json());
    this._keyCache.set(source, { keys, fetchedAt: this.now() });
    return keys;
  }

  // Which configured issuer this token claims to come from, or null.
  _sourceFor(payload) {
    if (this.firebaseProjectId && payload.iss === 'https://securetoken.google.com/' + this.firebaseProjectId
      && payload.aud === this.firebaseProjectId) return 'firebase';
    if (this.googleClientId && GOOGLE_ISSUERS.has(payload.iss) && payload.aud === this.googleClientId) return 'google';
    return null;
  }

  // Resolves { email, sub, provider, source } or throws with a short reason.
  async verify(idToken) {
    if (!this.enabled) throw new Error('Google sign-in is not configured on this server');
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new Error('malformed ID token');
    let header;
    let payload;
    try {
      header = decodeSegment(parts[0]);
      payload = decodeSegment(parts[1]);
    } catch (_) {
      throw new Error('malformed ID token');
    }
    if (header.alg !== 'RS256' || !header.kid) throw new Error('unsupported ID token');
    const source = this._sourceFor(payload);
    if (!source) throw new Error('ID token issuer/audience not accepted');

    // Unknown kid: Google rotates keys, so refetch once before giving up.
    let keys = await this._keysFor(source, false);
    let key = keys.get(header.kid);
    if (!key) {
      keys = await this._keysFor(source, true);
      key = keys.get(header.kid);
    }
    if (!key) throw new Error('ID token signed with an unknown key');

    const signatureOk = crypto.createVerify('RSA-SHA256')
      .update(parts[0] + '.' + parts[1])
      .verify(key, fromB64url(parts[2]));
    if (!signatureOk) throw new Error('bad ID token signature');

    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || nowSeconds >= payload.exp + CLOCK_SKEW_SECONDS) throw new Error('ID token expired');
    if (typeof payload.iat === 'number' && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) throw new Error('ID token issued in the future');
    if (!payload.sub) throw new Error('ID token has no subject');
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email || payload.email_verified !== true) throw new Error('ID token email is not verified');

    const provider = source === 'firebase'
      ? ((payload.firebase && payload.firebase.sign_in_provider) || 'firebase')
      : 'google.com';
    return { email, sub: String(payload.sub), provider, source };
  }
}

module.exports = { GoogleTokenVerifier, keysFromDocument, FIREBASE_CERTS_URL, GOOGLE_JWKS_URL };
