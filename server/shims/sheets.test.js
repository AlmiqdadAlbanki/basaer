'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { Storage } = require('../storage.js');
const { makeSpreadsheetApp } = require('./sheets.js');

function fresh() {
  const storage = new Storage(':memory:');
  return { storage, SpreadsheetApp: makeSpreadsheetApp(storage) };
}

test('insertSheet, appendRow, getRange round-trips values and types', () => {
  const { SpreadsheetApp } = fresh();
  const ss = SpreadsheetApp.openById('SS1');
  const sh = ss.insertSheet('students');
  sh.appendRow(['cpr', 'name', 'emailVerified', 'dob']);
  const d = new Date('2000-05-01T00:00:00.000Z');
  sh.appendRow(['001234567', 'Ahmad', true, d]);

  assert.strictEqual(sh.getLastRow(), 2);
  assert.strictEqual(sh.getLastColumn(), 4);

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  assert.deepStrictEqual(headers, ['cpr', 'name', 'emailVerified', 'dob']);

  const row = sh.getRange(2, 1, 1, 4).getValues()[0];
  assert.strictEqual(row[0], '001234567'); // string preserved (leading zeros kept)
  assert.strictEqual(row[2], true); // boolean preserved
  assert.ok(row[3] instanceof Date); // Date preserved
  assert.strictEqual(row[3].getTime(), d.getTime());
});

test('A1 notation: whole-row and cell forms', () => {
  const { SpreadsheetApp } = fresh();
  const sh = SpreadsheetApp.openById('SS1').insertSheet('main');
  sh.appendRow(['a', 'b', 'c']);
  sh.appendRow([1, 2, 3]);

  assert.deepStrictEqual(sh.getRange('1:1').getValues()[0], ['a', 'b', 'c']);
  assert.strictEqual(sh.getRange('B2').getValue(), 2);
  assert.deepStrictEqual(sh.getRange('A1:C1').getValues()[0], ['a', 'b', 'c']);
});

test('empty cells read back as empty string, beyond-data padded', () => {
  const { SpreadsheetApp } = fresh();
  const sh = SpreadsheetApp.openById('SS1').insertSheet('t');
  sh.appendRow(['x']);
  const vals = sh.getRange(1, 1, 2, 3).getValues();
  assert.deepStrictEqual(vals, [['x', '', ''], ['', '', '']]);
});

test('setValue and setValues persist and extend the grid', () => {
  const { storage, SpreadsheetApp } = fresh();
  const sh = SpreadsheetApp.openById('SS1').insertSheet('t');
  sh.getRange(1, 1, 1, 2).setValues([['h1', 'h2']]);
  sh.getRange(2, 2).setValue('v');
  // Re-open through a fresh app to confirm it hit storage.
  const sh2 = makeSpreadsheetApp(storage).openById('SS1').getSheetByName('t');
  assert.strictEqual(sh2.getRange(1, 1).getValue(), 'h1');
  assert.strictEqual(sh2.getRange(2, 2).getValue(), 'v');
  assert.strictEqual(sh2.getRange(2, 1).getValue(), '');
});

test('writing a new header cell adds a column (header-by-name pattern)', () => {
  const { SpreadsheetApp } = fresh();
  const sh = SpreadsheetApp.openById('SS1').insertSheet('emp');
  sh.appendRow(['cpr', 'name']);
  // mimic ensure*Columns_: append a missing header at lastColumn+1
  sh.getRange(1, sh.getLastColumn() + 1, 1, 1).setValues([['superAdmin']]);
  assert.deepStrictEqual(sh.getRange('1:1').getValues()[0], ['cpr', 'name', 'superAdmin']);
  assert.strictEqual(sh.getLastColumn(), 3);
});

test('deleteRow removes and shifts subsequent rows up', () => {
  const { storage, SpreadsheetApp } = fresh();
  const sh = SpreadsheetApp.openById('SS1').insertSheet('t');
  sh.appendRow(['h']);
  sh.appendRow(['r1']);
  sh.appendRow(['r2']);
  sh.appendRow(['r3']);
  sh.deleteRow(2); // remove r1
  assert.strictEqual(sh.getLastRow(), 3);
  assert.deepStrictEqual(sh.getRange(1, 1, 3, 1).getValues().map((r) => r[0]), ['h', 'r2', 'r3']);
  const sh2 = makeSpreadsheetApp(storage).openById('SS1').getSheetByName('t');
  assert.deepStrictEqual(sh2.getRange(1, 1, 3, 1).getValues().map((r) => r[0]), ['h', 'r2', 'r3']);
});

test('sort orders data rows by a column', () => {
  const { SpreadsheetApp } = fresh();
  const sh = SpreadsheetApp.openById('SS1').insertSheet('t');
  sh.appendRow([3, 'c']);
  sh.appendRow([1, 'a']);
  sh.appendRow([2, 'b']);
  sh.getRange(1, 1, 3, 2).sort({ column: 1, ascending: true });
  assert.deepStrictEqual(sh.getRange(1, 1, 3, 2).getValues().map((r) => r[1]), ['a', 'b', 'c']);
});

test('getSheetByName returns null for a missing sheet; same object cached', () => {
  const { SpreadsheetApp } = fresh();
  const ss = SpreadsheetApp.openById('SS1');
  assert.strictEqual(ss.getSheetByName('nope'), null);
  const a = ss.insertSheet('x');
  const b = ss.getSheetByName('x');
  assert.strictEqual(a, b); // writes through one object are visible to the next lookup
});

test('two openById calls in one app session share writes (live semantics)', () => {
  const { SpreadsheetApp } = fresh();
  SpreadsheetApp.openById('SS1').insertSheet('t').appendRow(['h']);
  const a = SpreadsheetApp.openById('SS1').getSheetByName('t');
  a.appendRow(['r1']);
  const b = SpreadsheetApp.openById('SS1').getSheetByName('t');
  assert.strictEqual(b.getLastRow(), 2);
});

test('getSpreadsheetTimeZone defaults then follows setter', () => {
  const { SpreadsheetApp } = fresh();
  const ss = SpreadsheetApp.openById('SS1');
  assert.strictEqual(ss.getSpreadsheetTimeZone(), 'Asia/Qatar');
});
