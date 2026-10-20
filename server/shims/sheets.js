'use strict';

// SpreadsheetApp shim. Reproduces the subset of the Sheets service that the
// Basaer server code actually uses (verified by grep: getRange in its three
// numeric forms plus A1 row-range strings, getValues/setValues,
// getValue/setValue, getLastRow/getLastColumn, appendRow, insertSheet,
// deleteRow(s), getDataRange, sort, getSpreadsheetTimeZone, getSheets,
// clearContent/clear, setFrozenRows, flush). Formatting calls
// (setBackground, setFontWeight, setNumberFormat, setNote, ...) are accepted
// and ignored: they do not affect values, which is all the logic reads back.

const COL_A = 'A'.charCodeAt(0);

function colToLetter(col) {
  let s = '';
  let n = col;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(COL_A + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function letterToCol(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - COL_A + 1);
  return n;
}

function isEmpty(v) {
  return v === '' || v === null || v === undefined;
}

// A chainable object returned by every formatting setter so that call chains
// like range.setValues(...).setFontWeight('bold') keep working.
function makeFormatNoops(target) {
  const noops = [
    'setBackground', 'setBackgrounds', 'setFontWeight', 'setFontColor', 'setFontSize',
    'setFontFamily', 'setFontStyle', 'setFontLine', 'setNumberFormat', 'setNumberFormats',
    'setHorizontalAlignment', 'setVerticalAlignment', 'setWrap', 'setBorder', 'setNote',
    'setNotes', 'setBackgroundRGB', 'setDataValidation', 'setDataValidations', 'merge',
    'mergeAcross', 'breakApart', 'setFontWeights', 'setTextDirection', 'setFontColors',
    'setValue', 'setValues', // real ones override below; listed so order of assignment is safe
  ];
  for (const m of noops) {
    if (!(m in target)) target[m] = () => target;
  }
  return target;
}

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
    makeFormatNoops(this);
  }

  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getA1Notation() {
    return `${colToLetter(this.col)}${this.row}:${colToLetter(this.col + this.numCols - 1)}${this.row + this.numRows - 1}`;
  }

  getValues() {
    // Read the grid once per call: `_grid` is a live, version-checked view of
    // the storage master, and the check is per access.
    const grid = this.sheet._grid;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const gridRow = grid[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = gridRow[this.col - 1 + c];
        line.push(isEmpty(v) ? '' : v);
      }
      out.push(line);
    }
    return out;
  }

  getValue() {
    return this.getValues()[0][0];
  }

  getDisplayValues() {
    return this.getValues().map((line) => line.map((v) => (v instanceof Date ? v.toISOString() : String(isEmpty(v) ? '' : v))));
  }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }

  setValues(values) {
    if (!Array.isArray(values) || !Array.isArray(values[0])) {
      throw new Error('setValues expects a 2D array');
    }
    const grid = this.sheet._grid;
    for (let r = 0; r < values.length; r++) {
      const gr = this.row - 1 + r;
      if (!grid[gr]) grid[gr] = [];
      for (let c = 0; c < values[r].length; c++) {
        grid[gr][this.col - 1 + c] = values[r][c];
      }
    }
    this.sheet._persistRange(grid, this.row, this.numRows);
    return this;
  }

  setValue(value) {
    const vals = [];
    for (let r = 0; r < this.numRows; r++) {
      vals.push(new Array(this.numCols).fill(value));
    }
    return this.setValues(vals);
  }

  clearContent() {
    const grid = this.sheet._grid;
    for (let r = 0; r < this.numRows; r++) {
      const gr = this.row - 1 + r;
      if (!grid[gr]) continue;
      for (let c = 0; c < this.numCols; c++) grid[gr][this.col - 1 + c] = '';
    }
    // Only the touched rows need persisting; a whole-sheet rewrite would be
    // O(sheet) for every small clear.
    this.sheet._persistRange(grid, this.row, this.numRows);
    return this;
  }
  clear() { return this.clearContent(); }

  // sort({column, ascending}) or sort(columnNumber). Sorts the rows covered by
  // this range in place. Used on data ranges in the server code.
  sort(spec) {
    const specs = Array.isArray(spec) ? spec : [spec];
    const keys = specs.map((s) => (typeof s === 'object' ? { col: s.column, asc: s.ascending !== false } : { col: s, asc: true }));
    const start = this.row - 1;
    const grid = this.sheet._grid;
    const slice = grid.slice(start, start + this.numRows);
    slice.sort((a, b) => {
      for (const k of keys) {
        const av = a[k.col - 1];
        const bv = b[k.col - 1];
        let cmp = 0;
        if (av < bv) cmp = -1; else if (av > bv) cmp = 1;
        if (cmp !== 0) return k.asc ? cmp : -cmp;
      }
      return 0;
    });
    for (let i = 0; i < slice.length; i++) grid[start + i] = slice[i];
    this.sheet._persistRange(grid, this.row, slice.length);
    return this;
  }

  createTextFinder(text) {
    const self = this;
    const needle = String(text);
    return {
      matchEntireCell() { this._entire = true; return this; },
      matchCase() { this._case = true; return this; },
      findAll() {
        const matches = [];
        const vals = self.getValues();
        for (let r = 0; r < vals.length; r++) {
          for (let c = 0; c < vals[r].length; c++) {
            const cell = String(vals[r][c]);
            const hit = this._entire ? cell === needle : cell.indexOf(needle) > -1;
            if (hit) matches.push(self.sheet.getRange(self.row + r, self.col + c));
          }
        }
        return matches;
      },
      findNext() { return this.findAll()[0] || null; },
      replaceAllWith() { return 0; },
    };
  }
}

class Sheet {
  constructor(spreadsheet, name) {
    this.spreadsheet = spreadsheet;
    this.name = name;
  }

  // The storage master grid (0-based rows), revalidated against writes from
  // other worker threads on each access. Mutations made through it must be
  // persisted at once with the storage write methods, which is what every
  // method below does.
  get _grid() {
    return this.spreadsheet._storage.loadGrid(this.spreadsheet.id, this.name);
  }

  getName() { return this.name; }
  getSheetName() { return this.name; }
  getParent() { return this.spreadsheet; }

  getLastRow() {
    const grid = this._grid;
    for (let r = grid.length - 1; r >= 0; r--) {
      const row = grid[r];
      if (row && row.some((v) => !isEmpty(v))) return r + 1;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    for (const row of this._grid) {
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (!isEmpty(row[c])) { if (c + 1 > last) last = c + 1; break; }
      }
    }
    return last;
  }

  getMaxRows() { return Math.max(this._grid.length, this.getLastRow()); }
  getMaxColumns() { return this.getLastColumn(); }

  // getRange(a1) | getRange(row, col) | getRange(row, col, numRows) | getRange(row, col, numRows, numCols)
  getRange(a, b, c, d) {
    if (typeof a === 'string') return this._rangeFromA1(a);
    const row = a;
    const col = b;
    const numRows = c == null ? 1 : c;
    const numCols = d == null ? 1 : d;
    return new Range(this, row, col, numRows, numCols);
  }

  _rangeFromA1(a1) {
    // Whole-row range: "1:1", "2:5"
    let m = /^(\d+):(\d+)$/.exec(a1);
    if (m) {
      const r1 = +m[1];
      const r2 = +m[2];
      const cols = Math.max(this.getLastColumn(), 1);
      return new Range(this, r1, 1, r2 - r1 + 1, cols);
    }
    // Whole-column range: "A:A", "A:C"
    m = /^([A-Za-z]+):([A-Za-z]+)$/.exec(a1);
    if (m) {
      const c1 = letterToCol(m[1]);
      const c2 = letterToCol(m[2]);
      const rows = Math.max(this.getLastRow(), 1);
      return new Range(this, 1, c1, rows, c2 - c1 + 1);
    }
    // Cell or cell range: "A1" or "A1:C3"
    m = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(a1);
    if (m) {
      const c1 = letterToCol(m[1]);
      const r1 = +m[2];
      const c2 = m[3] ? letterToCol(m[3]) : c1;
      const r2 = m[4] ? +m[4] : r1;
      return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    }
    throw new Error('Unsupported A1 notation: ' + a1);
  }

  getDataRange() {
    const rows = Math.max(this.getLastRow(), 1);
    const cols = Math.max(this.getLastColumn(), 1);
    return new Range(this, 1, 1, rows, cols);
  }

  // The storage computes the target row inside the write transaction, so two
  // threads appending at once never land on the same row.
  appendRow(rowArray) {
    this.spreadsheet._storage.appendRow(this.spreadsheet.id, this.name, rowArray.slice());
    return this;
  }

  deleteRow(rowNum) {
    this.spreadsheet._storage.deleteRowShift(this.spreadsheet.id, this.name, rowNum);
    return this;
  }
  deleteRows(rowNum, howMany) {
    for (let i = 0; i < howMany; i++) this.deleteRow(rowNum);
    return this;
  }

  deleteColumn(colNum) {
    const grid = this._grid;
    for (const row of grid) if (row) row.splice(colNum - 1, 1);
    this.spreadsheet._storage.saveGrid(this.spreadsheet.id, this.name, grid);
    return this;
  }

  clearContents() {
    this.spreadsheet._storage.saveGrid(this.spreadsheet.id, this.name, []);
    return this;
  }
  clear() { return this.clearContents(); }

  // Accepted no-ops (visual only).
  setFrozenRows() { return this; }
  setFrozenColumns() { return this; }
  autoResizeColumns() { return this; }
  autoResizeColumn() { return this; }
  setColumnWidth() { return this; }
  hideColumns() { return this; }
  activate() { return this; }
  setName(n) {
    this.spreadsheet._renameSheet(this.name, n);
    this.name = n;
    return this;
  }

  // Persist rows startRow..startRow+numRows-1 (1-based) of `grid` in one
  // transaction. `grid` is the array the caller just mutated; it is passed in
  // rather than re-read through `_grid`, because a commit from the other
  // worker in between would make the getter return a freshly reloaded array
  // without the caller's changes.
  _persistRange(grid, startRow, numRows) {
    const rows = [];
    for (let r = startRow; r < startRow + numRows; r++) rows.push(grid[r - 1] || []);
    this.spreadsheet._storage.putRows(this.spreadsheet.id, this.name, startRow, rows);
  }
}

class Spreadsheet {
  constructor(storage, id) {
    this._storage = storage;
    this.id = id;
    this._sheetCache = new Map();
    storage.ensureSpreadsheet(id);
  }

  getId() { return this.id; }

  getSheetByName(name) {
    if (!this._storage.sheetExists(this.id, name)) return null;
    if (!this._sheetCache.has(name)) this._sheetCache.set(name, new Sheet(this, name));
    return this._sheetCache.get(name);
  }

  insertSheet(name) {
    if (!this._storage.sheetExists(this.id, name)) this._storage.insertSheet(this.id, name);
    this._sheetCache.delete(name);
    return this.getSheetByName(name);
  }

  getSheets() {
    return this._storage.sheetNames(this.id).map((n) => this.getSheetByName(n));
  }

  getSpreadsheetTimeZone() { return this._storage.getTz(this.id); }
  setSpreadsheetTimeZone(tz) { this._storage.setTz(this.id, tz); return this; }
  getName() { return this.id; }

  _renameSheet(oldName, newName) {
    // Rare; implemented by copying rows. Not used in the hot path.
    const grid = this._storage.loadGrid(this.id, oldName);
    this._storage.insertSheet(this.id, newName);
    this._storage.saveGrid(this.id, newName, grid);
    this._sheetCache.delete(oldName);
  }
}

function makeSpreadsheetApp(storage) {
  const cache = new Map();
  return {
    openById(id) {
      if (!cache.has(id)) cache.set(id, new Spreadsheet(storage, id));
      return cache.get(id);
    },
    // Not used by the server code, but harmless to provide.
    getActiveSpreadsheet() { return null; },
    flush() {},
  };
}

module.exports = { makeSpreadsheetApp, Spreadsheet, Sheet, Range, colToLetter, letterToCol };
