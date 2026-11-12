'use strict';

// rules!check was a live formula in Google Sheets (start+startTime <= NOW() <= end+endTime);
// the shim recomputes it on every read, for imported Date cells and for the text the app writes.

const test = require('node:test');
const assert = require('node:assert');

const { Storage } = require('../storage.js');
const { makeSpreadsheetApp } = require('./sheets.js');
const { examCheck_ } = require('./sheet-formulas.js');

const REF_ID = '1L-VXGGxNX-4th2ytpTC7YsVo1p3xAzc-JLmoGdpIdgo';
const HEADERS = ['level', 'exam', 'start', 'startTime', 'end', 'endTime', 'duration', 'check', 'exam_id'];
const TZ = 'Asia/Qatar';
const at = (iso) => new Date(iso).getTime();

test('the formula, cell by cell: dates as Date or text, times as Date, text or empty', () => {
  const row = (start, startTime, end, endTime, exam = 'الأربعين') => [1, exam, start, startTime, end, endTime, 30, false, 'id'];
  // Qatar is UTC+3: 2026-11-12 08:00 local = 05:00Z.
  const r = row('2026-11-12', '08:00', '2026-11-12', '20:00');
  assert.strictEqual(examCheck_(r, HEADERS, TZ, at('2026-11-12T04:59:59Z')), false, 'before the start');
  assert.strictEqual(examCheck_(r, HEADERS, TZ, at('2026-11-12T05:00:00Z')), true, 'at the start');
  assert.strictEqual(examCheck_(r, HEADERS, TZ, at('2026-11-12T17:00:00Z')), true, 'at the end');
  assert.strictEqual(examCheck_(r, HEADERS, TZ, at('2026-11-12T17:00:01Z')), false, 'after the end');
  // Imported cells: the date is local midnight, the time a 1899-12-30 serial made under TZ=Asia/Qatar.
  const importedStart = new Date('2026-11-11T21:00:00Z'); // 2026-11-12 00:00 in Qatar
  const importedTime = new Date('1899-12-30T04:33:52Z');  // 08:00 Qatar wall clock (1899 used LMT +03:26:08)
  const imported = row(importedStart, importedTime, '2026-11-13', '');
  assert.strictEqual(examCheck_(imported, HEADERS, TZ, at('2026-11-12T05:00:00Z')), true);
  // An empty end time is that day's midnight, as in Sheets: the end day itself is already over.
  assert.strictEqual(examCheck_(imported, HEADERS, TZ, at('2026-11-12T21:00:01Z')), false);
  // A blank exam name gives a blank cell; a missing end date is never open.
  assert.strictEqual(examCheck_(row('2026-11-12', '', '2026-11-13', '', ''), HEADERS, TZ, at('2026-11-12T05:00:00Z')), '');
  assert.strictEqual(examCheck_(row('2026-11-12', '', '', ''), HEADERS, TZ, at('2026-11-12T05:00:00Z')), false);
});

test('getValues returns the live value, not the stored one; other sheets and columns are untouched', () => {
  const storage = new Storage(':memory:');
  try {
    storage.ensureSpreadsheet(REF_ID);
    storage.insertSheet(REF_ID, 'rules');
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    storage.saveGrid(REF_ID, 'rules', [
      HEADERS,
      [1, 'open now', day(-1), '', day(2), '', 30, false, 'a'],
      [1, 'not yet', day(2), '', day(3), '', 30, true, 'b'],
      [1, '', '', '', '', '', '', true, 'c'],
    ]);
    const SpreadsheetApp = makeSpreadsheetApp(storage);
    const sheet = SpreadsheetApp.openById(REF_ID).getSheetByName('rules');
    const values = sheet.getRange(2, 1, 3, HEADERS.length).getValues();
    assert.deepStrictEqual(values.map((r) => r[7]), [true, false, '']);
    assert.strictEqual(sheet.getRange(1, 8).getValue(), 'check', 'the header row is not computed');
    assert.strictEqual(sheet.getRange(2, 8, 1, 1).getValue(), true, 'a range starting at the column');
    assert.deepStrictEqual(sheet.getRange(2, 1, 1, 2).getValues()[0], [1, 'open now'], 'a range without the column');
    assert.strictEqual(storage.loadGrid(REF_ID, 'rules')[1][7], false, 'the stored cell is left alone');
  } finally {
    storage.close();
  }
});
