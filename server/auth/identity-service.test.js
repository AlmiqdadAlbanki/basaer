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
