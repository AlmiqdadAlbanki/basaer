'use strict';

// Compares row 1 of every imported sheet with the headers the server code looks
// up (tools/expected-headers.js). Never fails the process: it prints lines for a
// human to review after an import.
//
//   MISSING sheet   the sheet is not in the database at all
//   MISSING header  an expected column name is absent (the code will read blanks)
//   NOTE EXTRA      (a note, not a warning) a column the seed does not know (usually harmless: real data
//                   carries columns the code adds on demand)
//   ORDER           expected columns present but in a different relative order;
//                   matters where the code uses fixed column indexes
//
//   node tools/check-headers.js [--db <path>]

const path = require('path');
const { Storage } = require('../server/storage.js');
const { IDS, DEFAULT_DB, parseArgs } = require('./xlsx-common.js');
const { expectedHeaders } = require('./expected-headers.js');

const headerText = (cell) => String(cell == null ? '' : cell).trim();

// Returns an array of WARN lines (empty when everything matches).
function checkHeaders(storage, expected = expectedHeaders) {
  const warnings = [];
  const notes = [];
  for (const [logical, sheets] of Object.entries(expected)) {
    const spreadsheetId = IDS[logical];
    for (const [sheetName, wanted] of Object.entries(sheets)) {
      const label = logical + ' / ' + sheetName;
      if (!storage.sheetExists(spreadsheetId, sheetName)) {
        warnings.push('WARN  MISSING sheet: ' + label);
        continue;
      }
      const grid = storage.loadGrid(spreadsheetId, sheetName);
      const actual = (grid[0] || []).map(headerText).filter((h) => h !== '');
      const missing = wanted.filter((h) => !actual.includes(h));
      const extra = actual.filter((h) => !wanted.includes(h));
      if (missing.length) warnings.push('WARN  MISSING header: ' + label + ': ' + missing.join(', '));
      if (extra.length) notes.push('NOTE  EXTRA: ' + label + ': ' + extra.join(', '));
      // Order is compared on the columns both sides have.
      const wantedPresent = wanted.filter((h) => actual.includes(h));
      const actualPresent = actual.filter((h) => wanted.includes(h));
      if (wantedPresent.join('\u0000') !== actualPresent.join('\u0000')) {
        warnings.push('WARN  ORDER: ' + label + ': expected ' + wantedPresent.join(' | ') + ' but found ' + actualPresent.join(' | '));
      }
    }
  }
  return warnings.concat(notes);
}

function runCheck(storage, log = console.log) {
  const lines = checkHeaders(storage);
  const warnings = lines.filter((line) => line.startsWith('WARN'));
  for (const line of lines) log(line);
  log(warnings.length ? 'Header check: ' + warnings.length + ' warning(s)' : 'Header check: all expected headers present, in order');
  return warnings;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const storage = new Storage(path.resolve(args.db || process.env.BASAER_DB || DEFAULT_DB));
  try {
    runCheck(storage);
  } finally {
    storage.close();
  }
}

module.exports = { checkHeaders, runCheck };
