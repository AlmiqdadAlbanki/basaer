'use strict';

// Imports one .xlsx per logical spreadsheet (File -> Download -> Microsoft Excel
// from Google Sheets) into the SQLite grid store.
//
//   node tools/import-xlsx.js --dir <folder> [--db <path>]
//
// <folder> holds <logicalName>.xlsx files named after the IDS keys. Each
// worksheet replaces the stored sheet of the same name; row 1 stays the header.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { Storage } = require('../server/storage.js');
const { IDS, DEFAULT_DB, parseArgs, sheetToGrid } = require('./xlsx-common.js');

function importDir(storage, dir, log = console.log) {
  let imported = 0;
  for (const [logical, ssId] of Object.entries(IDS)) {
    const file = path.join(dir, logical + '.xlsx');
    if (!fs.existsSync(file)) {
      log('WARN  ' + logical + ': ' + file + ' not found, skipped');
      continue;
    }
    // cellDates turns date cells into JS Dates; the converter reads raw typed
    // values, never the formatted text.
    const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellDates: true });
    storage.ensureSpreadsheet(ssId);
    for (const name of wb.SheetNames) {
      const grid = sheetToGrid(wb.Sheets[name]);
      if (!storage.sheetExists(ssId, name)) storage.insertSheet(ssId, name);
      storage.saveGrid(ssId, name, grid);
      log(logical + ' / ' + name + ': ' + grid.length + ' rows x ' + (grid[0] ? grid[0].length : 0) + ' cols');
      imported++;
    }
  }
  return imported;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('usage: node tools/import-xlsx.js --dir <folder> [--db <path>]');
    process.exit(2);
  }
  const storage = new Storage(path.resolve(args.db || DEFAULT_DB));
  try {
    const n = importDir(storage, path.resolve(args.dir));
    console.log('Imported ' + n + ' sheet(s)');
  } finally {
    storage.close();
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('import failed: ' + (e && e.stack || e)); process.exit(1); }
}

module.exports = { importDir };
