'use strict';

// ensureServiceAccount: the private key in the database is the truth, the public key file is
// derived from it. A database copied from another machine (its own private key) must not be
// verified against the public key this machine generated earlier.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('../storage.js');
const { ensureServiceAccount } = require('./identity-service.js');

function signWith(privateKey, text) {
  return crypto.createSign('RSA-SHA256').update(text).sign(privateKey);
}
function verifiesWith(publicKey, text, signature) {
  return crypto.createVerify('RSA-SHA256').update(text).verify(publicKey, signature);
}

test('a fresh database gets a new pair; the public file matches the stored private key', () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-sa-'));
  const storage = new Storage(':memory:');
  try {
    const account = ensureServiceAccount(storage, keyDir);
    const stored = JSON.parse(storage.propGet('script', 'FIREBASE_SERVICE_ACCOUNT'));
    assert.ok(verifiesWith(account.publicKey, 'token', signWith(stored.private_key, 'token')));
    assert.strictEqual(fs.readFileSync(path.join(keyDir, 'sa_rsa.pub.pem'), 'utf8'), account.publicKey);
    // A second start keeps the same pair.
    assert.strictEqual(ensureServiceAccount(storage, keyDir).publicKey, account.publicKey);
  } finally {
    storage.close();
    fs.rmSync(keyDir, { recursive: true, force: true });
  }
});

test('a database copied from another machine replaces the public key file this machine had', () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-sa-'));
  const thisMachine = new Storage(':memory:');
  const otherMachine = new Storage(':memory:');
  try {
    const before = ensureServiceAccount(thisMachine, keyDir); // this machine's first start
    ensureServiceAccount(otherMachine, path.join(keyDir, 'elsewhere')); // the other machine's pair
    const copiedPrivateKey = JSON.parse(otherMachine.propGet('script', 'FIREBASE_SERVICE_ACCOUNT')).private_key;
    // The database arrives from the other machine; the public file is still this machine's.
    thisMachine.propSet('script', 'FIREBASE_SERVICE_ACCOUNT', otherMachine.propGet('script', 'FIREBASE_SERVICE_ACCOUNT'));
    const after = ensureServiceAccount(thisMachine, keyDir);
    assert.notStrictEqual(after.publicKey, before.publicKey);
    assert.ok(verifiesWith(after.publicKey, 'token', signWith(copiedPrivateKey, 'token')), 'verifies what the copied key signs');
    assert.strictEqual(fs.readFileSync(path.join(keyDir, 'sa_rsa.pub.pem'), 'utf8'), after.publicKey, 'the file was rewritten');
    assert.strictEqual(thisMachine.propGet('script', 'FIREBASE_SERVICE_ACCOUNT'), otherMachine.propGet('script', 'FIREBASE_SERVICE_ACCOUNT'), 'the private key is untouched');
  } finally {
    thisMachine.close();
    otherMachine.close();
    fs.rmSync(keyDir, { recursive: true, force: true });
  }
});

test('a malformed stored property is replaced by a fresh pair', () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-sa-'));
  const storage = new Storage(':memory:');
  try {
    storage.propSet('script', 'FIREBASE_SERVICE_ACCOUNT', '{"private_key":"not a key"}');
    const account = ensureServiceAccount(storage, keyDir);
    const stored = JSON.parse(storage.propGet('script', 'FIREBASE_SERVICE_ACCOUNT'));
    assert.ok(stored.private_key.includes('PRIVATE KEY'));
    assert.ok(verifiesWith(account.publicKey, 'x', signWith(stored.private_key, 'x')));
  } finally {
    storage.close();
    fs.rmSync(keyDir, { recursive: true, force: true });
  }
});
