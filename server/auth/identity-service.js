'use strict';

// Local stand-in for the Firebase Auth account store. auth.js talks to the
// Google auth REST hosts; the UrlFetchApp shim routes those calls here instead,
// so auth.js is unchanged. Passwords live in a SQLite `auth_users` table,
// hashed with scrypt. A locally-generated RSA "service account" lets
// auth.js's mintFirebaseCustomToken_ / getFirebaseAccessToken_ sign as before;
// the custom token it mints is later verified at /api/auth/exchange with the
// matching public key.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SA_CLIENT_EMAIL = 'local-admin@basaer-local.iam.gserviceaccount.com';

// Ensure a service-account keypair exists and is recorded in Script Properties
// under the exact key auth.js reads (FIREBASE_SERVICE_ACCOUNT). Returns the
// public key PEM for verifying minted custom tokens.
function ensureServiceAccount(storage, keyDir) {
  const pubPath = path.join(keyDir, 'sa_rsa.pub.pem');
  const existing = storage.propGet('script', 'FIREBASE_SERVICE_ACCOUNT');
  if (existing && fs.existsSync(pubPath)) {
    return { publicKey: fs.readFileSync(pubPath, 'utf8'), clientEmail: SA_CLIENT_EMAIL };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const sa = { type: 'service_account', project_id: 'basaer-local', client_email: SA_CLIENT_EMAIL, private_key: privateKey };
  storage.propSet('script', 'FIREBASE_SERVICE_ACCOUNT', JSON.stringify(sa));
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(pubPath, publicKey);
  return { publicKey, clientEmail: SA_CLIENT_EMAIL };
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(password), s, 32).toString('hex');
  return s + '$' + h;
}
function verifyHash(password, stored) {
  if (!stored || stored.indexOf('$') === -1) return false;
  const salt = stored.slice(0, stored.indexOf('$'));
  const expected = stored.slice(stored.indexOf('$') + 1);
  const actual = crypto.scryptSync(String(password), salt, 32).toString('hex');
  // constant-time compare
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class IdentityService {
  constructor(storage) {
    this.storage = storage;
    storage.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        uid            TEXT PRIMARY KEY,
        email          TEXT,
        cpr            TEXT,
        pw_hash        TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS auth_users_email ON auth_users(email);
    `);
  }

  findByEmail(email) {
    return this.storage.db.prepare('SELECT * FROM auth_users WHERE email = ?').get(String(email || '').toLowerCase());
  }
  findByUid(uid) {
    return this.storage.db.prepare('SELECT * FROM auth_users WHERE uid = ?').get(String(uid));
  }

  upsertUser({ uid, email, cpr, emailVerified }) {
    const existing = this.findByUid(uid);
    if (existing) {
      this.storage.db.prepare('UPDATE auth_users SET email = ?, cpr = ?, email_verified = ? WHERE uid = ?')
        .run(String(email || existing.email || '').toLowerCase(), String(cpr || existing.cpr || ''), emailVerified ? 1 : existing.email_verified, uid);
    } else {
      this.storage.db.prepare('INSERT INTO auth_users (uid, email, cpr, pw_hash, email_verified) VALUES (?, ?, ?, ?, ?)')
        .run(uid, String(email || '').toLowerCase(), String(cpr || ''), null, emailVerified ? 1 : 0);
    }
  }

  // Called by the accounts:update interceptor (auth.js setUserPasswordAdmin_).
  setPassword(uid, email, cpr, password) {
    this.upsertUser({ uid, email, cpr, emailVerified: true });
    this.storage.db.prepare('UPDATE auth_users SET pw_hash = ?, email_verified = 1 WHERE uid = ?')
      .run(hashPassword(password), uid);
    return true;
  }

  // Called by the signInWithPassword interceptor. Returns the uid or null.
  verifyPassword(email, password) {
    const u = this.findByEmail(email);
    if (!u || !u.pw_hash) return null;
    return verifyHash(password, u.pw_hash) ? u.uid : null;
  }
}

module.exports = { IdentityService, ensureServiceAccount, SA_CLIENT_EMAIL };
