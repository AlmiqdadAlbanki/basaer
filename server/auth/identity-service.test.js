'use strict';

// Tests for the sign-in brute-force protection in IdentityService. Uses an
// in-memory Storage and an injectable clock so window/lockout expiry can be
// tested without waiting.

const { test } = require('node:test');
const assert = require('node:assert');
const { Storage } = require('../storage.js');
const { IdentityService, MAX_FAILURES, FAILURE_WINDOW_MS, LOCKOUT_MS } = require('./identity-service.js');

const USER_EMAIL = 'Student@Example.com';
const USER_PASSWORD = 'correct horse battery staple';

function makeService() {
  const clock = { currentMs: 1700000000000 };
  clock.now = () => clock.currentMs;
  clock.advance = (ms) => { clock.currentMs += ms; };
  const storage = new Storage(':memory:');
  const service = new IdentityService(storage, { now: clock.now });
  service.setPassword('u123', USER_EMAIL, '123', USER_PASSWORD);
  return { service, storage, clock };
}

function failTimes(service, email, failureCount) {
  const results = [];
  for (let attempt = 0; attempt < failureCount; attempt++) results.push(service.verifyPassword(email, 'wrong password'));
  return results;
}

test('correct password returns the uid', () => {
  const { service } = makeService();
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
});

// A stranger who knows the email must not be able to lock its owner out: the
// lockout is per (email, client IP), and a success clears every IP's counter.
test('a lockout caused from one IP does not block the owner on another IP', () => {
  const { service } = makeService();
  for (let attempt = 0; attempt < MAX_FAILURES; attempt++) {
    service.verifyPassword(USER_EMAIL, 'wrong password', { clientIp: '203.0.113.9' });
  }
  assert.strictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD, { clientIp: '203.0.113.9' }).error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD, { clientIp: '198.51.100.7' }), { uid: 'u123' });
  // The owner's success cleared the attacker's counter too (no stale lock rows).
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD, { clientIp: '203.0.113.9' }), { uid: 'u123' });
});

test('email lookup is case-insensitive', () => {
  const { service } = makeService();
  assert.deepStrictEqual(service.verifyPassword('STUDENT@example.COM', USER_PASSWORD), { uid: 'u123' });
});

test('the constructor still works with just a storage argument', () => {
  const storage = new Storage(':memory:');
  const service = new IdentityService(storage);
  service.setPassword('u1', 'a@b.c', '1', 'pw');
  assert.deepStrictEqual(service.verifyPassword('a@b.c', 'pw'), { uid: 'u1' });
});

test('a wrong password returns INVALID_LOGIN_CREDENTIALS', () => {
  const { service } = makeService();
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, 'nope'), { error: 'INVALID_LOGIN_CREDENTIALS' });
});

test('an account with no password set returns INVALID_LOGIN_CREDENTIALS', () => {
  const { service } = makeService();
  service.upsertUser({ uid: 'u999', email: 'nopass@example.com', cpr: '999', emailVerified: true });
  assert.deepStrictEqual(service.verifyPassword('nopass@example.com', ''), { error: 'INVALID_LOGIN_CREDENTIALS' });
});

test('MAX_FAILURES wrong passwords lock the email with a positive retryAfterSeconds', () => {
  const { service } = makeService();
  const results = failTimes(service, USER_EMAIL, MAX_FAILURES);
  assert.ok(results.every((result) => result.error === 'INVALID_LOGIN_CREDENTIALS'));
  const locked = service.verifyPassword(USER_EMAIL, 'wrong password');
  assert.strictEqual(locked.error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
  assert.ok(locked.retryAfterSeconds > 0);
  assert.strictEqual(locked.retryAfterSeconds, LOCKOUT_MS / 1000);
});

test('the correct password is refused while the email is locked', () => {
  const { service } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  const refused = service.verifyPassword(USER_EMAIL, USER_PASSWORD);
  assert.strictEqual(refused.error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
  assert.strictEqual(refused.uid, undefined);
});

test('attempts while locked do not extend the lockout', () => {
  const { service, clock } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  clock.advance(60 * 1000);
  const refused = service.verifyPassword(USER_EMAIL, 'wrong password');
  assert.strictEqual(refused.retryAfterSeconds, LOCKOUT_MS / 1000 - 60);
});

test('the lockout expires and the correct password works again', () => {
  const { service, clock } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  clock.advance(LOCKOUT_MS);
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
});

test('after a lockout expires the failure count starts again from zero', () => {
  const { service, clock } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  clock.advance(LOCKOUT_MS);
  const results = failTimes(service, USER_EMAIL, MAX_FAILURES - 1);
  assert.ok(results.every((result) => result.error === 'INVALID_LOGIN_CREDENTIALS'));
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
});

test('a successful sign-in clears the failure counter', () => {
  const { service } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES - 1);
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
  // Counter was cleared, so another MAX_FAILURES - 1 failures still do not lock.
  failTimes(service, USER_EMAIL, MAX_FAILURES - 1);
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
});

test('failures older than the window reset the counter', () => {
  const { service, clock } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES - 1);
  clock.advance(FAILURE_WINDOW_MS);
  failTimes(service, USER_EMAIL, MAX_FAILURES - 1); // fresh window: still below the limit
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
});

test('failures inside the window keep accumulating', () => {
  const { service, clock } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES - 1);
  clock.advance(FAILURE_WINDOW_MS - 1);
  assert.strictEqual(service.verifyPassword(USER_EMAIL, 'wrong password').error, 'INVALID_LOGIN_CREDENTIALS');
  assert.strictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD).error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
});

test('unknown emails count failures too and lock after MAX_FAILURES', () => {
  const { service } = makeService();
  const results = failTimes(service, 'nobody@example.com', MAX_FAILURES);
  assert.ok(results.every((result) => result.error === 'INVALID_LOGIN_CREDENTIALS'));
  const locked = service.verifyPassword('nobody@example.com', 'anything');
  assert.strictEqual(locked.error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
  assert.ok(locked.retryAfterSeconds > 0);
});

test('known and unknown emails get identical replies throughout', () => {
  const { service } = makeService();
  const knownReplies = failTimes(service, USER_EMAIL, MAX_FAILURES + 1);
  const unknownReplies = failTimes(service, 'nobody@example.com', MAX_FAILURES + 1);
  assert.deepStrictEqual(unknownReplies, knownReplies);
});

test('lockout is tracked per normalised email, regardless of case', () => {
  const { service } = makeService();
  failTimes(service, 'STUDENT@EXAMPLE.COM', MAX_FAILURES);
  assert.strictEqual(service.verifyPassword('student@example.com', USER_PASSWORD).error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
});

test('locking one email does not affect another', () => {
  const { service } = makeService();
  service.setPassword('u456', 'other@example.com', '456', 'other password');
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  assert.deepStrictEqual(service.verifyPassword('other@example.com', 'other password'), { uid: 'u456' });
});

test('clearAttempts lifts a lockout', () => {
  const { service } = makeService();
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  service.clearAttempts(USER_EMAIL);
  assert.deepStrictEqual(service.verifyPassword(USER_EMAIL, USER_PASSWORD), { uid: 'u123' });
});

test('the lockout is shared by a second IdentityService on the same database', () => {
  const { service, storage, clock } = makeService();
  const otherWorker = new IdentityService(storage, { now: clock.now });
  failTimes(service, USER_EMAIL, MAX_FAILURES);
  assert.strictEqual(otherWorker.verifyPassword(USER_EMAIL, USER_PASSWORD).error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
});

// --- Accounts imported from Firebase --------------------------------------------
//
// The vector is the public one from the README of https://github.com/firebase/scrypt:
// this user's password is 'user1password'. An imported account keeps a
// 'fbscrypt$<salt>$<hash>' hash until its first successful sign-in, which swaps
// it for a local scrypt hash.

const FIREBASE_VECTOR = {
  uid: 'u555000111',
  cpr: '555000111',
  email: 'Imported.User@Example.com',
  password: 'user1password',
  salt: '42xEC+ixf3L2lw==',
  passwordHash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
};
const FIREBASE_HASH_CONFIG = {
  signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
};
const IMPORTED_HASH = 'fbscrypt$' + FIREBASE_VECTOR.salt + '$' + FIREBASE_VECTOR.passwordHash;
const LOCAL_HASH_FORMAT = /^[0-9a-f]{32}\$[0-9a-f]{64}$/;

// Service on a fresh in-memory database; pass { firebaseHashConfig: undefined }
// for a service that does not know the Firebase parameters.
function makeFirebaseFixture(serviceOptions) {
  const clock = { currentMs: 1700000000000 };
  clock.now = () => clock.currentMs;
  clock.advance = (ms) => { clock.currentMs += ms; };
  const storage = new Storage(':memory:');
  const service = new IdentityService(storage, Object.assign({ now: clock.now, firebaseHashConfig: FIREBASE_HASH_CONFIG }, serviceOptions));
  return { service, storage, clock };
}

function importVectorUser(service, overrides) {
  return service.importFirebaseUser(Object.assign({
    uid: FIREBASE_VECTOR.uid,
    email: FIREBASE_VECTOR.email,
    cpr: FIREBASE_VECTOR.cpr,
    salt: FIREBASE_VECTOR.salt,
    passwordHash: FIREBASE_VECTOR.passwordHash,
    emailVerified: true,
  }, overrides));
}

function storedHashOf(service, uid) {
  return service.findByUid(uid || FIREBASE_VECTOR.uid).pw_hash;
}

test('an imported Firebase user signs in with the old password, and the hash then becomes local', () => {
  const { service } = makeFirebaseFixture();
  assert.strictEqual(importVectorUser(service), 'imported');
  assert.strictEqual(storedHashOf(service), IMPORTED_HASH);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
  assert.ok(!storedHashOf(service).startsWith('fbscrypt$'));
  assert.match(storedHashOf(service), LOCAL_HASH_FORMAT);
  // Later sign-ins use the local hash.
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, 'nope'), { error: 'INVALID_LOGIN_CREDENTIALS' });
});

test('after the first sign-in the account no longer needs the Firebase config', () => {
  const { service, storage } = makeFirebaseFixture();
  importVectorUser(service);
  service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password);
  const serviceWithoutConfig = new IdentityService(storage);
  assert.deepStrictEqual(serviceWithoutConfig.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
});

test('a wrong password for an imported user fails and leaves the Firebase hash in place', () => {
  const { service } = makeFirebaseFixture();
  importVectorUser(service);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, 'user1passwordX'), { error: 'INVALID_LOGIN_CREDENTIALS' });
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, ''), { error: 'INVALID_LOGIN_CREDENTIALS' });
  assert.strictEqual(storedHashOf(service), IMPORTED_HASH);
});

test('without a Firebase config an imported user cannot sign in, and the Firebase hash is kept', () => {
  const { service, storage } = makeFirebaseFixture({ firebaseHashConfig: undefined });
  importVectorUser(service);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { error: 'INVALID_LOGIN_CREDENTIALS' });
  assert.strictEqual(storedHashOf(service), IMPORTED_HASH);
  // Once a worker that knows the parameters runs, the same account signs in.
  const serviceWithConfig = new IdentityService(storage, { firebaseHashConfig: FIREBASE_HASH_CONFIG });
  assert.deepStrictEqual(serviceWithConfig.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
});

test('an existing local password is not overwritten by an import', () => {
  const { service } = makeFirebaseFixture();
  service.setPassword(FIREBASE_VECTOR.uid, 'chosen.here@example.com', FIREBASE_VECTOR.cpr, 'a password set locally');
  const rowBefore = service.findByUid(FIREBASE_VECTOR.uid);
  assert.strictEqual(importVectorUser(service), 'kept-local');
  assert.deepStrictEqual(service.findByUid(FIREBASE_VECTOR.uid), rowBefore);
  assert.deepStrictEqual(service.verifyPassword('chosen.here@example.com', 'a password set locally'), { uid: FIREBASE_VECTOR.uid });
  assert.deepStrictEqual(service.verifyPassword('chosen.here@example.com', FIREBASE_VECTOR.password), { error: 'INVALID_LOGIN_CREDENTIALS' });
  assert.strictEqual(service.findByEmail(FIREBASE_VECTOR.email), undefined);
});

test('an import never overwrites the local hash a first sign-in produced', () => {
  const { service } = makeFirebaseFixture();
  importVectorUser(service);
  service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password);
  const localHash = storedHashOf(service);
  assert.strictEqual(importVectorUser(service), 'kept-local');
  assert.strictEqual(storedHashOf(service), localHash);
});

test('importing a user that has no password yet stores the Firebase hash', () => {
  const { service } = makeFirebaseFixture();
  service.upsertUser({ uid: FIREBASE_VECTOR.uid, email: 'placeholder@example.com', cpr: FIREBASE_VECTOR.cpr, emailVerified: false });
  assert.strictEqual(importVectorUser(service), 'imported');
  assert.strictEqual(storedHashOf(service), IMPORTED_HASH);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
});

test('importing the same Firebase user again refreshes it without creating a second row', () => {
  const { service, storage } = makeFirebaseFixture();
  importVectorUser(service, { passwordHash: Buffer.alloc(64, 1).toString('base64') });
  assert.strictEqual(importVectorUser(service), 'imported');
  assert.strictEqual(storedHashOf(service), IMPORTED_HASH);
  assert.strictEqual(storage.db.prepare('SELECT COUNT(*) FROM auth_users').pluck().get(), 1);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
});

test('an import lower-cases the email and records the verified flag', () => {
  const { service } = makeFirebaseFixture();
  importVectorUser(service);
  assert.strictEqual(service.findByUid(FIREBASE_VECTOR.uid).email, 'imported.user@example.com');
  assert.strictEqual(service.findByUid(FIREBASE_VECTOR.uid).email_verified, 1);
  assert.deepStrictEqual(service.verifyPassword('IMPORTED.USER@EXAMPLE.COM', FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
  importVectorUser(service, { uid: 'u555000222', cpr: '555000222', email: 'second@example.com', emailVerified: false });
  assert.strictEqual(service.findByUid('u555000222').email_verified, 0);
});

test('importFirebaseUser needs a uid, a salt and a hash, in the form Firebase exports them', () => {
  const { service } = makeFirebaseFixture();
  assert.throws(() => importVectorUser(service, { uid: '' }), /required/);
  assert.throws(() => importVectorUser(service, { salt: '' }), /required/);
  assert.throws(() => importVectorUser(service, { passwordHash: undefined }), /required/);
  assert.throws(() => importVectorUser(service, { salt: 'abc$def' }), /base64/);
  assert.throws(() => importVectorUser(service, { passwordHash: 'abc$def' }), /base64/);
  assert.strictEqual(service.findByUid(FIREBASE_VECTOR.uid), undefined);
});

test('the lockout applies to imported accounts, and a locked account is not converted', () => {
  const { service, clock } = makeFirebaseFixture();
  importVectorUser(service);
  const results = failTimes(service, FIREBASE_VECTOR.email, MAX_FAILURES);
  assert.ok(results.every((result) => result.error === 'INVALID_LOGIN_CREDENTIALS'));
  const refused = service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password);
  assert.strictEqual(refused.error, 'TOO_MANY_ATTEMPTS_TRY_LATER');
  assert.strictEqual(refused.retryAfterSeconds, LOCKOUT_MS / 1000);
  assert.strictEqual(storedHashOf(service), IMPORTED_HASH);
  clock.advance(LOCKOUT_MS);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
  assert.match(storedHashOf(service), LOCAL_HASH_FORMAT);
});

test('a successful sign-in of an imported account clears the failure counter', () => {
  const { service } = makeFirebaseFixture();
  importVectorUser(service);
  failTimes(service, FIREBASE_VECTOR.email, MAX_FAILURES - 1);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
  failTimes(service, FIREBASE_VECTOR.email, MAX_FAILURES - 1);
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
});

test('a malformed Firebase hash never matches and never throws', () => {
  const { service, storage } = makeFirebaseFixture();
  importVectorUser(service);
  for (const malformedHash of ['fbscrypt$', 'fbscrypt$onlyonepart', 'fbscrypt$a$b$c', 'fbscrypt$$' + FIREBASE_VECTOR.passwordHash]) {
    storage.db.prepare('UPDATE auth_users SET pw_hash = ? WHERE uid = ?').run(malformedHash, FIREBASE_VECTOR.uid);
    assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { error: 'INVALID_LOGIN_CREDENTIALS' }, malformedHash);
  }
});

test('setPassword replaces an imported Firebase hash', () => {
  const { service } = makeFirebaseFixture();
  importVectorUser(service);
  service.setPassword(FIREBASE_VECTOR.uid, FIREBASE_VECTOR.email, FIREBASE_VECTOR.cpr, 'reset by an admin');
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { error: 'INVALID_LOGIN_CREDENTIALS' });
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, 'reset by an admin'), { uid: FIREBASE_VECTOR.uid });
});

// Another worker (or an admin reset) can change the password between the check
// and the hash swap. The swap must then leave the newer password alone.
test('a password changed while an imported sign-in is being checked is not overwritten', () => {
  const { service } = makeFirebaseFixture();
  importVectorUser(service);
  const checkPassword = service.passwordMatchesStoredHash_.bind(service);
  service.passwordMatchesStoredHash_ = (password, storedHash) => {
    const matches = checkPassword(password, storedHash);
    service.setPassword(FIREBASE_VECTOR.uid, FIREBASE_VECTOR.email, FIREBASE_VECTOR.cpr, 'changed in between');
    return matches;
  };
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { uid: FIREBASE_VECTOR.uid });
  delete service.passwordMatchesStoredHash_;
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, 'changed in between'), { uid: FIREBASE_VECTOR.uid });
  assert.deepStrictEqual(service.verifyPassword(FIREBASE_VECTOR.email, FIREBASE_VECTOR.password), { error: 'INVALID_LOGIN_CREDENTIALS' });
});

test('the constructor rejects an invalid Firebase config instead of failing at some later sign-in', () => {
  const storage = new Storage(':memory:');
  assert.throws(() => new IdentityService(storage, { firebaseHashConfig: { signerKey: 'AAAA' } }), /Firebase hash config/);
  assert.throws(() => new IdentityService(storage, { firebaseHashConfig: Object.assign({}, FIREBASE_HASH_CONFIG, { memCost: 40 }) }), /memCost/);
  assert.doesNotThrow(() => new IdentityService(storage, { firebaseHashConfig: FIREBASE_HASH_CONFIG }));
  assert.doesNotThrow(() => new IdentityService(storage, { firebaseHashConfig: null }));
});