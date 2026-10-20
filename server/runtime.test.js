'use strict';

// The Math object handed to the gas sandbox: random() must be CSPRNG-backed,
// in [0, 1), and the rest of Math intact. The gas OTP code is
// Math.floor(100000 + Math.random() * 900000).

const test = require('node:test');
const assert = require('node:assert');

const { SafeMath } = require('./runtime.js');

test('SafeMath.random returns values in [0, 1) and never throws', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const value = SafeMath.random();
    assert.ok(value >= 0 && value < 1, 'out of range: ' + value);
    seen.add(value);
  }
  assert.ok(seen.size > 1990, 'values should be practically unique');
  const otp = Math.floor(100000 + SafeMath.random() * 900000);
  assert.ok(otp >= 100000 && otp <= 999999);
});

test('SafeMath inherits the rest of Math', () => {
  assert.strictEqual(SafeMath.floor(2.7), 2);
  assert.strictEqual(SafeMath.max(1, 5, 3), 5);
  assert.strictEqual(SafeMath.PI, Math.PI);
  assert.notStrictEqual(SafeMath.random, Math.random);
});
