'use strict';

// Checks passwords against Firebase Auth's modified scrypt hashes, so accounts
// exported from a Firebase project keep their existing passwords after the move
// to the local password store (identity-service.js stores them as
// 'fbscrypt$<salt>$<hash>' until the user's first sign-in).
//
// Algorithm (reference: https://github.com/firebase/scrypt), for one user:
//   1. saltBytes  = base64decode(user salt) + base64decode(project salt separator)
//   2. derivedKey = scrypt(utf8(password), saltBytes, N = 2 ** memCost, r = rounds, p = 1), 32 bytes
//   3. hash       = base64(AES-256-CTR(key = derivedKey, iv = 16 zero bytes) applied to
//                          base64decode(project signer key))
// The signer key, salt separator, rounds and memory cost are the project's
// "Password hash parameters" (Firebase console, Authentication > Users menu);
// the salt and the hash are the per-user `salt` and `passwordHash` fields of the
// auth export. Every binary value is base64, exactly as exported.
//
// None of the secrets handled here (signer key, hashes, passwords) is ever put
// into an error message.

const crypto = require('crypto');

// Firebase only accepts rounds 1-8 and memory cost 1-14 for SCRYPT, so a real
// project needs at most 128 * 2**14 * 8 = 16 MiB of scrypt memory. The same
// limits here stop a corrupt config from asking scrypt for gigabytes (the
// explicit maxmem passed to scrypt would otherwise allow it).
const MAX_ROUNDS = 8;
const MAX_MEMORY_COST = 14;
const DERIVED_KEY_BYTES = 32;
const AES_BLOCK_BYTES = 16;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Decodes a base64 config value, rejecting anything that is not canonical base64.
function decodeConfigBase64_(value, fieldName, allowEmpty) {
  if (typeof value !== 'string') throw new Error('Firebase hash config: ' + fieldName + ' is missing');
  if (!BASE64_PATTERN.test(value) || (value === '' && !allowEmpty)) {
    throw new Error('Firebase hash config: ' + fieldName + ' is not valid base64');
  }
  return Buffer.from(value, 'base64');
}

function assertIntegerInRange_(value, fieldName, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('Firebase hash config: ' + fieldName + ' must be a whole number from ' + minimum + ' to ' + maximum);
  }
}

// Validates the project-wide parameters and returns them decoded. Throws on the
// first problem.
function decodeHashConfig_(config) {
  if (!config || typeof config !== 'object') throw new Error('Firebase hash config is missing');
  const signerKeyBytes = decodeConfigBase64_(config.signerKey, 'signerKey', false);
  // A project without a salt separator is legal, so an empty one is accepted.
  const saltSeparatorBytes = decodeConfigBase64_(config.saltSeparator, 'saltSeparator', true);
  assertIntegerInRange_(config.rounds, 'rounds', 1, MAX_ROUNDS);
  assertIntegerInRange_(config.memCost, 'memCost', 1, MAX_MEMORY_COST);
  return { signerKeyBytes, saltSeparatorBytes, rounds: config.rounds, memCost: config.memCost };
}

// Throws unless `config` ({ signerKey, saltSeparator, rounds, memCost }) is
// usable by verifyFirebasePassword. IdentityService calls this at startup so a
// broken config fails loudly there instead of on some user's sign-in.
function assertValidHashConfig(config) {
  decodeHashConfig_(config);
}

// True when `password` produces `passwordHash` for this user. `salt` and
// `passwordHash` are the user's base64 values from the auth export. A malformed
// or wrong-length `passwordHash` simply does not match; an invalid project
// config (signerKey, saltSeparator, rounds, memCost) throws.
function verifyFirebasePassword({ password, salt, passwordHash, signerKey, saltSeparator, rounds, memCost }) {
  if (typeof password !== 'string') throw new TypeError('verifyFirebasePassword: password must be a string');
  const config = decodeHashConfig_({ signerKey, saltSeparator, rounds, memCost });

  const saltBytes = Buffer.concat([Buffer.from(String(salt || ''), 'base64'), config.saltSeparatorBytes]);
  const cost = 2 ** config.memCost;
  const derivedKey = crypto.scryptSync(Buffer.from(password, 'utf8'), saltBytes, DERIVED_KEY_BYTES, {
    N: cost,
    r: config.rounds,
    p: 1,
    maxmem: 128 * cost * config.rounds * 2,
  });
  const cipher = crypto.createCipheriv('aes-256-ctr', derivedKey, Buffer.alloc(AES_BLOCK_BYTES));
  const computedHash = Buffer.concat([cipher.update(config.signerKeyBytes), cipher.final()]);

  const storedHash = Buffer.from(String(passwordHash || ''), 'base64');
  // timingSafeEqual throws on different lengths, which here just means "no match".
  return computedHash.length === storedHash.length && crypto.timingSafeEqual(computedHash, storedHash);
}

function parseWholeNumber_(text, fieldName) {
  if (!/^\d+$/.test(String(text))) throw new Error('Firebase hash config: ' + fieldName + ' must be a whole number');
  return Number(text);
}

// Parses the "Password hash parameters" text block of the Firebase console:
//   hash_config {
//     algorithm: SCRYPT,
//     base64_signer_key: <base64>,
//     base64_salt_separator: <base64>,
//     rounds: 8,
//     mem_cost: 14,
//   }
// into { signerKey, saltSeparator, rounds, memCost }. Throws when the algorithm
// is not SCRYPT or a field is missing or invalid. Line endings, indentation and
// trailing commas do not matter.
function parseHashConfig(text) {
  const fields = {};
  // Base64 never contains ':', ',', quotes or braces, so "name: value" pairs
  // can be picked out of the block without caring how it is laid out. Only
  // spaces and tabs are allowed around the colon, so an empty value stays
  // empty instead of swallowing the next line.
  for (const match of String(text).matchAll(/([A-Za-z][A-Za-z0-9_]*)[ \t]*:[ \t]*"?([^",:\s{}]*)"?/g)) {
    fields[match[1]] = match[2];
  }
  if (fields.algorithm !== 'SCRYPT') {
    throw new Error('Firebase hash config: unsupported algorithm '
      + (fields.algorithm ? JSON.stringify(fields.algorithm) : '(none given)') + ', only SCRYPT is supported');
  }
  const config = {
    signerKey: fields.base64_signer_key,
    saltSeparator: fields.base64_salt_separator,
    rounds: parseWholeNumber_(fields.rounds, 'rounds'),
    memCost: parseWholeNumber_(fields.mem_cost, 'mem_cost'),
  };
  assertValidHashConfig(config);
  return config;
}

module.exports = { verifyFirebasePassword, parseHashConfig, assertValidHashConfig };
