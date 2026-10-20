'use strict';

// GoogleTokenVerifier against locally generated keys served by a stub fetch.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { GoogleTokenVerifier } = require('./google-token.js');

const PROJECT = 'coming-soon-basaer';
const CLIENT_ID = '123-abc.apps.googleusercontent.com';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(privateKey, kid, payload) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createSign('RSA-SHA256').update(header + '.' + body).sign(privateKey);
  return header + '.' + body + '.' + b64url(signature);
}

function makeFixture() {
  const googleKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const firebaseKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const documents = {
    google: { keys: [Object.assign(googleKey.publicKey.export({ format: 'jwk' }), { kid: 'g1', alg: 'RS256', use: 'sig' })] },
    firebase: { f1: firebaseKey.publicKey.export({ type: 'spki', format: 'pem' }) },
  };
  let fetchCount = 0;
  const verifier = new GoogleTokenVerifier({
    firebaseProjectId: PROJECT,
    googleClientId: CLIENT_ID,
    keyUrls: { google: 'stub://google', firebase: 'stub://firebase' },
    fetchImpl: async (url) => {
      fetchCount++;
      const document = documents[url.replace('stub://', '')];
      return { ok: !!document, json: async () => document };
    },
  });
  const now = Math.floor(Date.now() / 1000);
  const firebaseClaims = (overrides) => Object.assign({
    iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, sub: 'uid-1', iat: now - 10, exp: now + 3600,
    email: 'Someone@Example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' },
  }, overrides || {});
  const googleClaims = (overrides) => Object.assign({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'g-1', iat: now - 10, exp: now + 3600,
    email: 'other@example.com', email_verified: true,
  }, overrides || {});
  return { googleKey, firebaseKey, verifier, firebaseClaims, googleClaims, fetchCount: () => fetchCount };
}

test('a valid Firebase ID token yields its verified email, lower-cased', async () => {
  const f = makeFixture();
  const result = await f.verifier.verify(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims()));
  assert.deepStrictEqual(result, { email: 'someone@example.com', sub: 'uid-1', provider: 'google.com', source: 'firebase' });
  await f.verifier.verify(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims()));
  assert.strictEqual(f.fetchCount(), 1, 'keys are cached');
});

test('a valid Google OAuth ID token is accepted too', async () => {
  const f = makeFixture();
  const result = await f.verifier.verify(signJwt(f.googleKey.privateKey, 'g1', f.googleClaims()));
  assert.strictEqual(result.email, 'other@example.com');
  assert.strictEqual(result.source, 'google');
});

test('tokens with the wrong audience, issuer, key, signature, expiry or unverified email are rejected', async () => {
  const f = makeFixture();
  const reject = (token, pattern) => assert.rejects(() => f.verifier.verify(token), pattern);
  await reject(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims({ aud: 'other-project' })), /issuer\/audience/);
  await reject(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims({ iss: 'https://evil.example' })), /issuer\/audience/);
  await reject(signJwt(f.firebaseKey.privateKey, 'unknown', f.firebaseClaims()), /unknown key/);
  // Signed with the Google key but claiming to be a Firebase token.
  await reject(signJwt(f.googleKey.privateKey, 'f1', f.firebaseClaims()), /bad ID token signature/);
  await reject(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims({ exp: Math.floor(Date.now() / 1000) - 600 })), /expired/);
  await reject(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims({ email_verified: false })), /not verified/);
  await reject(signJwt(f.firebaseKey.privateKey, 'f1', f.firebaseClaims({ email: '' })), /not verified/);
  await reject('not.a.jwt', /malformed/);
  await reject('', /malformed/);
});

test('an unconfigured verifier is disabled and refuses everything', async () => {
  const verifier = new GoogleTokenVerifier({});
  assert.strictEqual(verifier.enabled, false);
  await assert.rejects(() => verifier.verify('a.b.c'), /not configured/);
});
