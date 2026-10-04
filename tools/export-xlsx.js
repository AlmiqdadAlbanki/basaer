'use strict';

// Inverse of import-xlsx: writes <logicalName>.xlsx per logical spreadsheet,
// one worksheet per stored sheet.
//
//   node tools/export-xlsx.js --dir <folder> [--db <path>]

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { Storage } = require('../server/storage.js');
const { IDS, DEFAULT_DB, parseArgs, gridToSheet } = require('./xlsx-common.js');

function exportDir(storage, dir, log = console.log) {
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [logical, ssId] of Object.entries(IDS)) {
    const names = storage.sheetNames(ssId);
    if (!names.length) {
      log('WARN  ' + logical + ': no sheets, skipped');
      continue;
    }
    const wb = XLSX.utils.book_new();
    for (const name of names) {
      // Excel rejects longer/odd names; fail loudly rather than silently rename.
      if (name.length > 31 || /[\\/?*[\]:]/.test(name)) {
        throw new Error(logical + ': sheet name not valid in .xlsx: ' + name);
      }
      const grid = storage.loadGrid(ssId, name);
      XLSX.utils.book_append_sheet(wb, gridToSheet(grid), name);
      log(logical + ' / ' + name + ': ' + grid.length + ' rows');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
    fs.writeFileSync(path.join(dir, logical + '.xlsx'), buf);
    written++;
  }
  return written;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('usage: node tools/export-xlsx.js --dir <folder> [--db <path>]');
    process.exit(2);
  }
  const storage = new Storage(path.resolve(args.db || DEFAULT_DB));
  try {
    const n = exportDir(storage, path.resolve(args.dir));
    console.log('Exported ' + n + ' workbook(s)');
  } finally {
    storage.close();
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('export failed: ' + (e && e.stack || e)); process.exit(1); }
}

module.exports = { exportDir };
