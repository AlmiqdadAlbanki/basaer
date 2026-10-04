'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../server/storage.js');
const { IDS } = require('./xlsx-common.js');
const { exportDir } = require('./export-xlsx.js');
const { importDir } = require('./import-xlsx.js');

const quiet = () => {};

function seed(storage, ss, name, grid) {
  storage.ensureSpreadsheet(ss);
  storage.insertSheet(ss, name);
  storage.saveGrid(ss, name, grid);
}

// Compare type-exactly; Dates by getTime.
function assertGridsEqual(actual, expected) {
  assert.equal(actual.length, expected.length, 'row count');
  expected.forEach((row, r) => {
    assert.equal(actual[r].length, row.length, 'width of row ' + r);
    row.forEach((v, c) => {
      const a = actual[r][c];
      const where = '[' + r + ',' + c + ']';
      if (v instanceof Date) {
        assert.ok(a instanceof Date, 'Date expected at ' + where);
        assert.equal(a.getTime(), v.getTime(), 'date at ' + where);
      } else {
        assert.equal(typeof a, typeof v, 'type at ' + where);
        assert.strictEqual(a, v, 'value at ' + where);
      }
    });
  });
}

test('xlsx export -> import round-trips cell types', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-xlsx-'));
  const a = new Storage(':memory:');
  const b = new Storage(':memory:');
  try {
    const mixed = [
      ['cpr', 'age', 'active', 'when', 'note', 'tail'],
      ['001234567', 42, true, new Date('2024-03-05T10:20:30.000Z'), '', ''],
      ['abc', 3.5, false, new Date('2000-01-01T00:00:00.000Z'), 'نص عربي', ''],
      ['12345', 0, false, '', '', ''],
    ];
    seed(a, IDS.mainData, 'students', mixed);
    seed(a, IDS.mainData, 'headerOnly', [['x', 'y', 'z']]);
    seed(a, IDS.refID, 'main', [['k', 'v'], ['1', 1]]);

    exportDir(a, tmp, quiet);
    importDir(b, tmp, quiet);

    assert.deepEqual(b.sheetNames(IDS.mainData), ['students', 'headerOnly']);
    assertGridsEqual(b.loadGrid(IDS.mainData, 'students'), mixed);
    assertGridsEqual(b.loadGrid(IDS.mainData, 'headerOnly'), [['x', 'y', 'z']]);
    assertGridsEqual(b.loadGrid(IDS.refID, 'main'), [['k', 'v'], ['1', 1]]);
  } finally {
    a.close();
    b.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('import skips a missing workbook without failing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-xlsx-'));
  const s = new Storage(':memory:');
  try {
    assert.equal(importDir(s, tmp, quiet), 0);
  } finally {
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
