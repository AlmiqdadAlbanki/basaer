'use strict';

// Date cells must import as the exact wall-clock time the sheet showed. The
// real exports exposed an 8-second drift in the xlsx library's own conversion
// (a date-only cell became 23:59:52 of the previous day), so serials are
// converted here by calendar arithmetic. These tests pin that down and the
// epoch behaviour of Utilities.formatDate for invalid dates.

process.env.TZ = 'Asia/Qatar';

const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');

const { serialToDate, sheetToGrid, gridToSheet } = require('./xlsx-common.js');
const { Utilities } = require('../server/shims/utilities.js');

test('a date-only serial is local midnight of that day, to the second', () => {
  const date = serialToDate(45960); // the sheet showed 2025-10-30
  assert.strictEqual(date.getFullYear(), 2025);
  assert.strictEqual(date.getMonth(), 9);
  assert.strictEqual(date.getDate(), 30);
  assert.deepStrictEqual([date.getHours(), date.getMinutes(), date.getSeconds()], [0, 0, 0]);
});

test('a date-time serial keeps its time of day without drift', () => {
  const date = serialToDate(45941.61488432871); // the sheet showed 10/11/2025 14:45:26
  assert.strictEqual(date.toLocaleDateString('en-GB'), '11/10/2025');
  assert.deepStrictEqual([date.getHours(), date.getMinutes(), date.getSeconds()], [14, 45, 26]);
});

test('sheetToGrid converts numeric cells with a date format and leaves plain numbers alone', () => {
  const ws = {
    '!ref': 'A1:C1',
    A1: { t: 'n', v: 45960, z: 'yyyy-mm-dd' },
    B1: { t: 'n', v: 45960 },
    C1: { t: 'n', v: 45941.61488432871, z: 'm/d/yyyy h:mm:ss' },
  };
  const [row] = sheetToGrid(ws);
  assert.ok(row[0] instanceof Date);
  assert.strictEqual(row[0].getDate(), 30);
  assert.strictEqual(row[1], 45960);
  assert.strictEqual(row[2].getSeconds(), 26);
});

test('export then import round-trips a Date to the second', () => {
  const original = new Date(2026, 1, 3, 9, 30, 7);
  const ws = gridToSheet([['when'], [original]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 's');
  const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const reread = XLSX.read(bytes, { type: 'buffer', cellDates: false, cellNF: true });
  const [, row] = sheetToGrid(reread.Sheets.s);
  assert.ok(row[0] instanceof Date, 'date cell read back as Date');
  assert.strictEqual(row[0].getTime(), original.getTime());
});

test('Utilities.formatDate treats an invalid Date as the epoch, as Apps Script does', () => {
  assert.strictEqual(Utilities.formatDate(new Date('29/11/2025 15:51:13'), 'Asia/Qatar', 'yyyy-MM-dd'), '1970-01-01');
  assert.strictEqual(Utilities.formatDate(new Date(2025, 9, 30), 'Asia/Qatar', 'yyyy-MM-dd'), '2025-10-30');
});
