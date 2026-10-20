'use strict';

// Tests for the Firebase modified-scrypt verifier. The first vector is the
// public one from the README of https://github.com/firebase/scrypt. The second
// was computed independently of this module (Python hashlib.scrypt plus the
// `cryptography` package's AES-CTR) for a non-ASCII password and cost
// parameters other than Firebase's defaults, so UTF-8 handling and the use of
// `rounds` / `memCost` are checked against something that shares no code with it.

const { test } = require('node:test');
const assert = require('node:assert');
const { verifyFirebasePassword, parseHashConfig, assertValidHashConfig } = require('./firebase-scrypt.js');

const README_VECTOR = {
  password: 'user1password',
  salt: '42xEC+ixf3L2lw==',
  passwordHash: 'lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==',
  signerKey: 'jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==',
  saltSeparator: 'Bw==',
  rounds: 8,
  memCost: 14,
};

// "pässwörd-密码-🔑", written with escapes so the source file stays ASCII.
const UNICODE_VECTOR = {
  password: 'pässwörd-密码-🔑',
  salt: 'BWC7FnHMJ4LdOJPu',
  passwordHash: 'sLLKhUTn3VRkt3LRRBrORQUXFuhhQUoZQzBYkTNhaZQOdWYhBrjrXMUE/eN2ITLXN1F8UdkeMdmTzX5FeNDaZA==',
  signerKey: 'CzBVep/E6Q4zWH2ix+wRNluApcrvFDleg6jN8hc8YYar0PUaP2SJrtP4HUJnjLHW+yBFao+02f4jSG2St9wBJg==',
  saltSeparator: '+gs=',
  rounds: 3,
  memCost: 10,
};

function verifyWith(vector, overrides) {
  return verifyFirebasePassword(Object.assign({}, vector, overrides));
}

function consoleBlockLines(vector) {
  return [
    'hash_config {',
    '  algorithm: SCRYPT,',
    '  base64_signer_key: ' + vector.signerKey + ',',
    '  base64_salt_separator: ' + vector.saltSeparator + ',',
    '  rounds: ' + vector.rounds + ',',
    '  mem_cost: ' + vector.memCost + ',',
    '}',
  ];
}

const README_CONFIG = {
  signerKey: README_VECTOR.signerKey,
  saltSeparator: README_VECTOR.saltSeparator,
  rounds: 8,
  memCost: 14,
};

// --- verifyFirebasePassword ---------------------------------------------------

test('the firebase/scrypt README vector verifies', () => {
  assert.strictEqual(verifyWith(README_VECTOR), true);
});

test('a wrong password does not verify', () => {
  assert.strictEqual(verifyWith(README_VECTOR, { password: 'user1passwordX' }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { password: 'User1password' }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { password: '' }), false);
});

test('a different user salt does not verify', () => {
  assert.strictEqual(verifyWith(README_VECTOR, { salt: 'AAAAAAAAAAA=' }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { salt: '' }), false);
});

test('every project parameter takes part in the hash', () => {
  assert.strictEqual(verifyWith(README_VECTOR, { saltSeparator: 'Bg==' }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { saltSeparator: '' }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { rounds: 7 }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { memCost: 13 }), false);
  // Same length as the real key (so the hash is comparable), different bytes.
  const otherSignerKey = Buffer.alloc(64, 7).toString('base64');
  assert.strictEqual(verifyWith(README_VECTOR, { signerKey: otherSignerKey }), false);
});

test('a tampered, truncated, over-long or empty stored hash does not verify and does not throw', () => {
  const hashBytes = Buffer.from(README_VECTOR.passwordHash, 'base64');
  assert.strictEqual(hashBytes.length, 64);
  const oneBitOff = Buffer.from(hashBytes);
  oneBitOff[0] ^= 0x01;
  const truncated = hashBytes.subarray(0, 32);
  const overLong = Buffer.concat([hashBytes, Buffer.from([0])]);
  for (const badHash of [oneBitOff, truncated, overLong]) {
    assert.strictEqual(verifyWith(README_VECTOR, { passwordHash: badHash.toString('base64') }), false);
  }
  assert.strictEqual(verifyWith(README_VECTOR, { passwordHash: '' }), false);
  assert.strictEqual(verifyWith(README_VECTOR, { passwordHash: undefined }), false);
});

test('an independently computed hash for a non-ASCII password with other cost parameters verifies', () => {
  assert.strictEqual(verifyWith(UNICODE_VECTOR), true);
  assert.strictEqual(verifyWith(UNICODE_VECTOR, { password: 'pässwörd-密码' }), false);
  // The same password in a different Unicode form is a different byte string.
  assert.strictEqual(verifyWith(UNICODE_VECTOR, { password: 'pässwörd-密码-🔑' }), false);
});

test('the password must be a string', () => {
  assert.throws(() => verifyWith(README_VECTOR, { password: undefined }), TypeError);
  assert.throws(() => verifyWith(README_VECTOR, { password: 12345 }), TypeError);
});

test('an invalid project config throws and never quotes the signer key', () => {
  const invalidOverrides = [
    { signerKey: undefined },
    { signerKey: '' },
    { signerKey: 'not base64!' },
    { saltSeparator: undefined },
    { saltSeparator: 'Bw=' },
    { rounds: 0 },
    { rounds: 9 },
    { rounds: 8.5 },
    { rounds: '8' },
    { memCost: 0 },
    { memCost: 15 },
    { memCost: 30 },
    { memCost: undefined },
  ];
  for (const overrides of invalidOverrides) {
    assert.throws(
      () => verifyWith(README_VECTOR, overrides),
      (error) => /Firebase hash config/.test(error.message) && !error.message.includes(README_VECTOR.signerKey),
      'overrides: ' + JSON.stringify(overrides),
    );
  }
});

test('assertValidHashConfig accepts a good config and rejects a bad one', () => {
  assert.doesNotThrow(() => assertValidHashConfig(README_CONFIG));
  assert.throws(() => assertValidHashConfig(null), /Firebase hash config/);
  assert.throws(() => assertValidHashConfig({}), /Firebase hash config/);
  assert.throws(() => assertValidHashConfig(Object.assign({}, README_CONFIG, { memCost: 40 })), /memCost/);
});

// --- parseHashConfig ----------------------------------------------------------

test('parseHashConfig reads the console block', () => {
  assert.deepStrictEqual(parseHashConfig(consoleBlockLines(README_VECTOR).join('\n')), README_CONFIG);
});

test('parseHashConfig reads a block with Windows line endings and no trailing newline', () => {
  assert.deepStrictEqual(parseHashConfig(consoleBlockLines(README_VECTOR).join('\r\n')), README_CONFIG);
  assert.deepStrictEqual(parseHashConfig(consoleBlockLines(README_VECTOR).join('\r\n') + '\r\n'), README_CONFIG);
});

test('parseHashConfig does not care about indentation, the wrapper lines, commas, quotes or a single line', () => {
  const withoutWrapper = consoleBlockLines(README_VECTOR).slice(1, -1).map((line) => line.trim()).join('\n');
  assert.deepStrictEqual(parseHashConfig(withoutWrapper), README_CONFIG);
  const withoutCommas = consoleBlockLines(README_VECTOR).map((line) => line.replace(/,$/, '')).join('\n');
  assert.deepStrictEqual(parseHashConfig(withoutCommas), README_CONFIG);
  const quoted = consoleBlockLines(README_VECTOR).join('\n').replace(/: ([^,\n]+)/g, ': "$1"');
  assert.deepStrictEqual(parseHashConfig(quoted), README_CONFIG);
  const oneLine = consoleBlockLines(README_VECTOR).map((line) => line.trim()).join(' ');
  assert.deepStrictEqual(parseHashConfig(oneLine), README_CONFIG);
});

test('parseHashConfig keeps an empty salt separator empty', () => {
  const noSeparator = consoleBlockLines(README_VECTOR).join('\n').replace('base64_salt_separator: Bw==,', 'base64_salt_separator: ,');
  assert.deepStrictEqual(parseHashConfig(noSeparator), Object.assign({}, README_CONFIG, { saltSeparator: '' }));
});

test('parseHashConfig output feeds verifyFirebasePassword directly', () => {
  const config = parseHashConfig(consoleBlockLines(README_VECTOR).join('\n'));
  assert.strictEqual(verifyFirebasePassword(Object.assign({
    password: README_VECTOR.password, salt: README_VECTOR.salt, passwordHash: README_VECTOR.passwordHash,
  }, config)), true);
});

test('parseHashConfig refuses any algorithm other than SCRYPT', () => {
  const block = consoleBlockLines(README_VECTOR).join('\n');
  assert.throws(() => parseHashConfig(block.replace('algorithm: SCRYPT', 'algorithm: STANDARD_SCRYPT')), /unsupported algorithm "STANDARD_SCRYPT"/);
  assert.throws(() => parseHashConfig(block.replace('algorithm: SCRYPT', 'algorithm: BCRYPT')), /unsupported algorithm "BCRYPT"/);
  assert.throws(() => parseHashConfig(block.replace('algorithm: SCRYPT,\n', '')), /unsupported algorithm \(none given\)/);
  assert.throws(() => parseHashConfig(''), /unsupported algorithm/);
});

test('parseHashConfig refuses a block with a missing or invalid field', () => {
  const block = consoleBlockLines(README_VECTOR).join('\n');
  const withoutLine = (name) => block.split('\n').filter((line) => !line.includes(name)).join('\n');
  assert.throws(() => parseHashConfig(withoutLine('base64_signer_key')), /signerKey/);
  assert.throws(() => parseHashConfig(withoutLine('base64_salt_separator')), /saltSeparator/);
  assert.throws(() => parseHashConfig(withoutLine('rounds')), /rounds/);
  assert.throws(() => parseHashConfig(withoutLine('mem_cost')), /mem_cost/);
  assert.throws(() => parseHashConfig(block.replace('rounds: 8', 'rounds: eight')), /rounds/);
  assert.throws(() => parseHashConfig(block.replace('rounds: 8', 'rounds: 80')), /rounds/);
  assert.throws(() => parseHashConfig(block.replace('mem_cost: 14', 'mem_cost: 99')), /memCost/);
  assert.throws(() => parseHashConfig(block.replace('mem_cost: 14', 'mem_cost: 1.5')), /mem_cost/);
  assert.throws(() => parseHashConfig(block.replace(README_VECTOR.signerKey, 'not-base64')), /signerKey/);
});

test('parseHashConfig errors never contain the signer key', () => {
  const block = consoleBlockLines(README_VECTOR).join('\n');
  const brokenBlocks = [
    block.replace('algorithm: SCRYPT', 'algorithm: BCRYPT'),
    block.replace('rounds: 8', 'rounds: eight'),
    block.replace('mem_cost: 14', 'mem_cost: 99'),
    block.replace(README_VECTOR.saltSeparator, 'bad'),
  ];
  for (const brokenBlock of brokenBlocks) {
    assert.throws(() => parseHashConfig(brokenBlock), (error) => !error.message.includes(README_VECTOR.signerKey));
  }
});
