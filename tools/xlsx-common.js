'use strict';

// Shared pieces for the .xlsx import/export tools: the logical-name -> spreadsheet
// ID map (same values as tools/seed.js, which cannot be required without running
// the seed) and the grid <-> worksheet converters.
//
// Type fidelity rules (grid cell -> worksheet cell):
//   string  -> t:'s'  (always a string, so "001234567" never turns into a number)
//   number  -> t:'n'
//   boolean -> t:'b'
//   Date    -> t:'d'  (needs cellDates on write and read)
//   '' / null / undefined -> no cell at all (blank)
// On read, blank cells and error cells (#N/A, #REF!, ...) both become ''; an
// empty-string cell and a blank cell are indistinguishable in a grid anyway.

const path = require('path');
const XLSX = require('xlsx');

const IDS = {
  mainData: '1Y3zNCw4i3VmNdj3BjhkerpzIV8VijOVfAwY9_ixN8ic',
  attendanceData: '1TjNcFeccyK9BhPBbpfx8cZqPvJbJtSfgptse_fahg1g',
  answersData: '18uSjZYwLzY5O5XlzL46SwAELnrTwzILHs3fzq0x58ok',
  dectationData: '1qs50ANDMENyGVPxet2S0keRZ2Cxur_jSAj2pMY4Mojo',
  refID: '1L-VXGGxNX-4th2ytpTC7YsVo1p3xAzc-JLmoGdpIdgo',
  archiveData: '1RGgPD6r44RCnnGQFlxj9603bu1E-D6YaIVCJSySCxNs',
};

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'basaer.sqlite');
const DATE_FMT = 'yyyy-mm-dd hh:mm:ss';

// Minimal "--key value" parser for --dir and --db.
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

// Worksheet -> 0-based grid. Reads cell types directly instead of formatted
// text; every row is padded to the full width of the sheet range.
function sheetToGrid(ws) {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const width = range.e.c + 1;
  const grid = [];
  for (let r = 0; r <= range.e.r; r++) {
    const row = new Array(width).fill('');
    for (let c = 0; c < width; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (cell.t === 'n' || cell.t === 'b') row[c] = cell.v;
      else if (cell.t === 'd') row[c] = cell.v instanceof Date ? cell.v : new Date(cell.v);
      else if (cell.t === 's') row[c] = String(cell.v);
      // 'e' (error) and 'z' (stub) stay ''.
    }
    grid.push(row);
  }
  return grid;
}

// 0-based grid -> worksheet, with the cell type set explicitly from the JS type.
function gridToSheet(grid) {
  const ws = {};
  let maxC = 0;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    if (row.length > maxC) maxC = row.length;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === '' || v === null || v === undefined) continue;
      const addr = XLSX.utils.encode_cell({ r, c });
      if (v instanceof Date) ws[addr] = { t: 'd', v, z: DATE_FMT };
      else if (typeof v === 'number') ws[addr] = { t: 'n', v };
      else if (typeof v === 'boolean') ws[addr] = { t: 'b', v };
      else ws[addr] = { t: 's', v: String(v) };
    }
  }
  // An explicit range keeps trailing blank columns and blank rows.
  if (grid.length && maxC) {
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: grid.length - 1, c: maxC - 1 } });
  }
  return ws;
}

module.exports = { IDS, DEFAULT_DB, parseArgs, sheetToGrid, gridToSheet };
