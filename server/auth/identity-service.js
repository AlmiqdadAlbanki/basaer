'use strict';

// Local stand-in for the Firebase Auth account store. auth.js talks to the
// Google auth REST hosts; the UrlFetchApp shim routes those calls here instead,
// so auth.js is unchanged. Passwords live in a SQLite `auth_users` table,
// hashed with scrypt. A locally-generated RSA "service account" lets
// auth.js's mintFirebaseCustomToken_ / getFirebaseAccessToken_ sign as before;
// the custom token it mints is later verified at /api/auth/exchange with the
// matching public key.
//
// Brute-force protection: failed sign-ins are counted per (lowercased) email in
// a SQLite `auth_attempts` table, so the count is shared by every worker thread
// and survives restarts. Unknown emails are counted too, so the reply never
// reveals which emails have accounts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SA_CLIENT_EMAIL = 'local-admin@basaer-local.iam.gserviceaccount.com';

// Login lockout policy. Attempts are counted per (email, client IP): a lockout
// keyed on the email alone would let anyone who knows a CPR lock its owner
// out by guessing wrong ten times. Distributed guessing from many IPs is
// bounded by the per-target rate limit at the HTTP boundary (index.js).
// Failures within FAILURE_WINDOW_MS of the first one are counted together; a
// failure arriving after the window starts a fresh count.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
// Number of failures within the window that locks the (email, IP) pair.
const MAX_FAILURES = 10;
// How long a locked pair refuses every sign-in, even with the right password.
const LOCKOUT_MS = 15 * 60 * 1000;

// The `email` column of auth_attempts holds this key.
function attemptKey(normalisedEmail, clientIp) {
  return normalisedEmail + '|' + String(clientIp || '');
}

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

// A throwaway hash checked when the email has no usable password, so a sign-in
// for an unknown email costs the same scrypt time as a wrong password for a
// real one (otherwise response time would reveal which emails exist).
let decoyHash = null;
function getDecoyHash() {
  if (!decoyHash) decoyHash = hashPassword(crypto.randomBytes(16).toString('hex'));
  return decoyHash;
}

function normaliseEmail(email) {
  return String(email || '').toLowerCase();
}

class IdentityService {
  // options.now: clock returning epoch milliseconds (injectable for tests).
  constructor(storage, options) {
    this.storage = storage;
    this.now = (options && typeof options.now === 'function') ? options.now : Date.now;
    storage.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        uid            TEXT PRIMARY KEY,
        email          TEXT,
        cpr            TEXT,
        pw_hash        TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS auth_users_email ON auth_users(email);
      -- Failed sign-in counters per lowercased email (see the lockout policy
      -- constants above). locked_until is 0 while the email is not locked.
      CREATE TABLE IF NOT EXISTS auth_attempts (
        email            TEXT PRIMARY KEY,
        failures         INTEGER NOT NULL DEFAULT 0,
        first_failure_at INTEGER NOT NULL,
        locked_until     INTEGER NOT NULL DEFAULT 0
      );
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

  // Called by the signInWithPassword interceptor. `options.clientIp` is the
  // requesting client's address (from the call context). Returns one of:
  //   { uid }                                              correct password
  //   { error: 'INVALID_LOGIN_CREDENTIALS' }               wrong password or unknown email
  //   { error: 'TOO_MANY_ATTEMPTS_TRY_LATER', retryAfterSeconds }   (email, IP) is locked
  // While a pair is locked the password is not checked at all. The failure
  // that reaches MAX_FAILURES is itself answered INVALID_LOGIN_CREDENTIALS; the
  // lockout then applies to every later attempt from that IP.
  verifyPassword(email, password, options) {
    const normalisedEmail = normaliseEmail(email);
    const key = attemptKey(normalisedEmail, options && options.clientIp);
    const lockedUntil = this.lockedUntil_(key);
    const nowMs = this.now();
    if (lockedUntil > nowMs) {
      return {
        error: 'TOO_MANY_ATTEMPTS_TRY_LATER',
        retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - nowMs) / 1000)),
      };
    }
    const user = this.findByEmail(normalisedEmail);
    const storedHash = user && user.pw_hash ? user.pw_hash : null;
    // Always run one scrypt check, against the decoy when there is no real hash.
    const passwordMatches = verifyHash(password, storedHash || getDecoyHash());
    if (!storedHash || !passwordMatches) {
      this.recordFailure_(key);
      return { error: 'INVALID_LOGIN_CREDENTIALS' };
    }
    this.clearAttempts(normalisedEmail);
    return { uid: user.uid };
  }

  // Forget the failed-attempt counters and any lockout for an email, from every
  // IP. Used after a successful sign-in, and by tests and admin tools to unlock
  // an account.
  clearAttempts(email) {
    const prefix = normaliseEmail(email) + '|';
    this.storage.db.prepare("DELETE FROM auth_attempts WHERE email LIKE ? ESCAPE '\\'")
      .run(prefix.replace(/[\\%_]/g, '\\$&') + '%');
  }

  // Epoch ms until which the key is locked, or 0 when it is not locked.
  lockedUntil_(key) {
    const attempts = this.storage.db.prepare('SELECT locked_until FROM auth_attempts WHERE email = ?').get(key);
    return attempts ? attempts.locked_until : 0;
  }

  // Count one failed sign-in. The read-modify-write runs in an IMMEDIATE
  // transaction so concurrent worker threads cannot lose each other's counts.
  recordFailure_(key) {
    const db = this.storage.db;
    const nowMs = this.now();
    db.transaction(() => {
      const attempts = db.prepare('SELECT failures, first_failure_at, locked_until FROM auth_attempts WHERE email = ?').get(key);
      // Another thread locked this email after our lock check: nothing to add.
      if (attempts && attempts.locked_until > nowMs) return;
      // Start a fresh count when there is none, when the window has elapsed, or
      // when a previous lockout has expired.
      const startsFresh = !attempts || attempts.locked_until > 0 || nowMs - attempts.first_failure_at >= FAILURE_WINDOW_MS;
      const failures = startsFresh ? 1 : attempts.failures + 1;
      const firstFailureAt = startsFresh ? nowMs : attempts.first_failure_at;
      const lockedUntil = failures >= MAX_FAILURES ? nowMs + LOCKOUT_MS : 0;
      db.prepare(`
        INSERT INTO auth_attempts (email, failures, first_failure_at, locked_until) VALUES (?, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET failures = excluded.failures,
          first_failure_at = excluded.first_failure_at, locked_until = excluded.locked_until
      `).run(key, failures, firstFailureAt, lockedUntil);
    }).immediate();
  }
}

module.exports = {
  IdentityService, ensureServiceAccount, SA_CLIENT_EMAIL,
  MAX_FAILURES, FAILURE_WINDOW_MS, LOCKOUT_MS,
};
