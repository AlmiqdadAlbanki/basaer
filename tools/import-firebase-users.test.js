'use strict';

// --mark-verified: accounts Firebase had verified get emailVerified = true in
// the students/emp sheets (the page signs out accounts whose cell is not true).

const test = require('node:test');
const assert = require('node:assert');

const { Storage } = require('../server/storage.js');
const { IDS } = require('./xlsx-common.js');
const { markVerifiedEmailsInSheets } = require('./import-firebase-users.js');

test('markVerifiedEmailsInSheets sets the cell only for verified exported accounts, idempotently', () => {
  const storage = new Storage(':memory:');
  storage.insertSheet(IDS.mainData, 'students');
  storage.saveGrid(IDS.mainData, 'students', [
    ['cpr', 'name', 'emailVerified', 'hasPassword'],
    [106968, 'A', '', true],      // verified in Firebase, empty here -> marked
    ['000222222', 'B', true, true], // already true -> untouched
    [333333333, 'C', '', false],  // not verified in Firebase -> untouched
  ]);
  storage.insertSheet(IDS.mainData, 'emp');
  storage.saveGrid(IDS.mainData, 'emp', [['cpr', 'emailVerified'], ['000444444', false]]);
  const exportedUsers = [
    { localId: 'u000106968', emailVerified: true },
    { localId: 'u000222222', emailVerified: true },
    { localId: 'u333333333', emailVerified: false },
    { localId: 'u000444444', emailVerified: true },
    { localId: 'u000555555', emailVerified: true }, // in Firebase only
    { localId: 'google-only-uid', emailVerified: true },
  ];
  const first = markVerifiedEmailsInSheets({ storage, exportedUsers, spreadsheetId: IDS.mainData });
  assert.deepStrictEqual(first, { marked: 2, alreadyTrue: 1, notInSheets: 1 });
  const students = storage.loadGrid(IDS.mainData, 'students');
  assert.strictEqual(students[1][2], true);
  assert.strictEqual(students[2][2], true);
  assert.strictEqual(students[3][2], '');
  assert.strictEqual(storage.loadGrid(IDS.mainData, 'emp')[1][1], true);
  const second = markVerifiedEmailsInSheets({ storage, exportedUsers, spreadsheetId: IDS.mainData });
  assert.deepStrictEqual(second, { marked: 0, alreadyTrue: 3, notInSheets: 1 });
  storage.close();
});
