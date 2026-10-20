'use strict';

// Imports the users of the old Firebase project into the local password store,
// so existing users keep their passwords.
//
//   node tools/import-firebase-users.js --users data/firebase-users.json
//                                       --hash-params data/firebase-hash-params.txt
//                                       [--db <sqlite path>] [--dry-run]
//
// --users        the Firebase Auth export: { "users": [ { localId, email,
//                emailVerified, passwordHash, salt, ... } ] }
// --hash-params  the "Password hash parameters" text block of the Firebase
//                console (Authentication > Users):
//                hash_config { algorithm: SCRYPT, base64_signer_key: ..., ... }
// --db           the database to import into; defaults to $BASAER_DB, else
//                data/basaer.sqlite (the live one, so try --dry-run first). The
//                path in use is printed before anything is written.
//
// Rules, per exported user:
//   - no passwordHash (e.g. a Google-only account): skipped
//   - no email: skipped (the sign-in is by email, so the account is unusable)
//   - uid = localId, cpr = localId without its leading "u", email lower-cased
//   - an account that already has a local password is left exactly as it is
//     ("kept-local"); every other account gets the Firebase hash stored as
//     'fbscrypt$<salt>$<hash>' (IdentityService.importFirebaseUser), which
//     IdentityService replaces with a local hash at the user's first sign-in
// The whole import is one transaction, and it is safe to run again.
//
// The hash parameters are stored as JSON in Script Properties under
// FIREBASE_HASH_CONFIG ({ signerKey, saltSeparator, rounds, memCost }). The
// server must load them at startup, or the imported hashes cannot be checked:
//
//   const stored = storage.propGet('script', 'FIREBASE_HASH_CONFIG');
//   new IdentityService(storage, { firebaseHashConfig: stored ? JSON.parse(stored) : undefined });
//
// --dry-run prints the counts a real run would produce and changes nothing: the
// database is only opened read-only (never created or modified) and the import
// runs against an in-memory copy of its accounts. (When no other process has a
// WAL-mode database open, SQLite may leave empty -wal/-shm files beside it
// after any read, however the file is opened.)
//
// Only counts and the database path are printed, never hashes, emails or the
// signer key.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Storage } = require('../server/storage.js');
const { IdentityService } = require('../server/auth/identity-service.js');
const { parseHashConfig } = require('../server/auth/firebase-scrypt.js');
const { DEFAULT_DB, parseArgs } = require('./xlsx-common.js');

const HASH_CONFIG_PROPERTY = 'FIREBASE_HASH_CONFIG';
const USAGE = 'usage: node tools/import-firebase-users.js --users <firebase-users.json> '
  + '--hash-params <firebase-hash-params.txt> [--db <path>] [--dry-run]';

function readFirebaseUsers(usersFile) {
  const exported = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  if (!exported || !Array.isArray(exported.users)) {
    throw new Error(usersFile + ': expected an object of the form { "users": [ ... ] }');
  }
  return exported.users;
}

// The local account for one exported Firebase user:
//   { account: { uid, email, cpr, salt, passwordHash, emailVerified } }
// or, when the user is not imported, { skipped: 'no-password' | 'no-email' }.
function mapFirebaseUser(exportedUser) {
  const user = exportedUser || {};
  if (!user.passwordHash || !user.salt) return { skipped: 'no-password' };
  if (!user.localId) throw new Error('Firebase export: a user with a password has no localId');
  const email = String(user.email || '').toLowerCase();
  if (!email) return { skipped: 'no-email' };
  const uid = String(user.localId);
  return {
    account: {
      uid,
      email,
      cpr: uid.replace(/^u/, ''),
      salt: user.salt,
      passwordHash: user.passwordHash,
      emailVerified: user.emailVerified === true,
    },
  };
}

// Imports into `storage` (all or nothing) and stores the hash parameters.
// Returns { total, imported, keptLocal, skippedNoPassword, skippedNoEmail }.
function importFirebaseUsers({ storage, exportedUsers, hashConfig }) {
  const identityService = new IdentityService(storage);
  const counts = { total: exportedUsers.length, imported: 0, keptLocal: 0, skippedNoPassword: 0, skippedNoEmail: 0 };
  storage.db.transaction(() => {
    for (const exportedUser of exportedUsers) {
      const mapped = mapFirebaseUser(exportedUser);
      if (mapped.skipped === 'no-password') counts.skippedNoPassword++;
      else if (mapped.skipped === 'no-email') counts.skippedNoEmail++;
      else if (identityService.importFirebaseUser(mapped.account) === 'kept-local') counts.keptLocal++;
      else counts.imported++;
    }
    storage.propSet('script', HASH_CONFIG_PROPERTY, JSON.stringify(hashConfig));
  }).immediate();
  return counts;
}

// ':memory:' is SQLite's in-memory database, not a file name.
function resolveDatabasePath(requestedPath) {
  return requestedPath === ':memory:' ? requestedPath : path.resolve(requestedPath);
}

// The accounts already in the database, read without any write: the file is
// opened read-only, and neither the file nor a missing table is created.
function readExistingAccounts(databasePath) {
  if (databasePath === ':memory:' || !fs.existsSync(databasePath)) return [];
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const hasAccountTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_users'").get();
    if (!hasAccountTable) return [];
    return database.prepare('SELECT uid, email, cpr, pw_hash, email_verified FROM auth_users').all();
  } finally {
    database.close();
  }
}

// A throwaway in-memory database holding a copy of the real database's
// accounts. A dry run imports into it with exactly the code of a real run, so
// the counts cannot differ from what a real run would do.
function openDryRunStorage(databasePath) {
  const scratchStorage = new Storage(':memory:');
  new IdentityService(scratchStorage); // creates the auth_users table
  const insertAccount = scratchStorage.db.prepare(
    'INSERT INTO auth_users (uid, email, cpr, pw_hash, email_verified) VALUES (@uid, @email, @cpr, @pw_hash, @email_verified)');
  for (const account of readExistingAccounts(databasePath)) insertAccount.run(account);
  return scratchStorage;
}

function printCounts(counts) {
  console.log('Firebase users in export: ' + counts.total);
  console.log('imported: ' + counts.imported);
  console.log('skipped (no password): ' + counts.skippedNoPassword);
  console.log('skipped (no email): ' + counts.skippedNoEmail);
  console.log('kept-local: ' + counts.keptLocal);
}

// The flags that take a value. parseArgs gives a flag that ends the line, or is
// followed by another flag, no usable value; for --db that would silently mean
// "use the default database", which is not what a typo should do to a tool that
// writes, so it is refused.
const VALUE_FLAGS = ['users', 'hash-params', 'db'];

function missingFlagValues(argv, args) {
  return VALUE_FLAGS.filter((flag) => argv.includes('--' + flag)
    && (typeof args[flag] !== 'string' || args[flag] === '' || args[flag].startsWith('--')));
}

function main() {
  const argv = process.argv.slice(2);
  // parseArgs reads "--key value" pairs, so the valueless --dry-run comes out first.
  const dryRun = argv.includes('--dry-run');
  const remainingArgv = argv.filter((argument) => argument !== '--dry-run');
  const args = parseArgs(remainingArgv);
  const flagsWithoutValue = missingFlagValues(remainingArgv, args);
  if (flagsWithoutValue.length > 0) {
    console.error('missing value for ' + flagsWithoutValue.map((flag) => '--' + flag).join(', '));
    console.error(USAGE);
    process.exit(2);
  }
  if (!args.users || !args['hash-params']) {
    console.error(USAGE);
    process.exit(2);
  }
  const exportedUsers = readFirebaseUsers(path.resolve(args.users));
  const hashConfig = parseHashConfig(fs.readFileSync(path.resolve(args['hash-params']), 'utf8'));
  const databasePath = resolveDatabasePath(args.db || process.env.BASAER_DB || DEFAULT_DB);

  if (dryRun) {
    console.log('DRY RUN: nothing is written; these are the counts a real run would produce.');
    console.log('Database (read-only): ' + databasePath);
    if (databasePath !== ':memory:' && !fs.existsSync(databasePath)) {
      console.log('(no database at that path, so no existing accounts are counted)');
    }
  } else {
    console.log('Database: ' + databasePath);
  }
  const storage = dryRun ? openDryRunStorage(databasePath) : new Storage(databasePath);
  try {
    printCounts(importFirebaseUsers({ storage, exportedUsers, hashConfig }));
    if (!dryRun) console.log('Stored the hash parameters as script property ' + HASH_CONFIG_PROPERTY + '.');
  } finally {
    storage.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('import failed: ' + error.message);
    process.exit(1);
  }
}

module.exports = { importFirebaseUsers, mapFirebaseUser, openDryRunStorage, readFirebaseUsers };
