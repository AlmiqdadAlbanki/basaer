'use strict';

// Storage substrate for the Sheets shim.
//
// Google Apps Script code treats a sheet as a 1-based 2D grid of mixed-type
// cells, addressed by position, with row 1 holding the column headers. The
// 15k lines we are porting depend on exactly those semantics (read the header
// row, then index data rows by position), so the faithful substrate is a grid,
// not a table with named columns. We therefore store one JSON-encoded row per
// record and reconstruct the grid on read. (This is a deliberate departure from
// the "one SQL table per sheet" idea in the plan: fidelity to GAS semantics
// wins for a drop-in port. Named-column SQL views for querying/export can be
// generated from the header row later, since it is always row 1.)
//
// Cell type preservation across JSON:
//   ''                      -> empty cell (what GAS returns for a blank cell)
//   number / boolean / str  -> stored as-is
//   Date                    -> {"__t":"date","v":"<ISO>"}  -> decoded back to Date
//
// We do NOT reproduce Sheets' write-time string->number coercion (e.g. "0123"
// becoming 123). Preserving the caller's JS type is safer and the legacy code
// already defends CPR comparisons against the number/string ambiguity
// (normalizeCpr_, cprEquals_ in code.js). Revisit against the real .xlsx
// exports — see "Known risks" in the plan.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function encodeCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return { __t: 'date', v: v.toISOString() };
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'string') return v;
  // Arrays/objects are not valid sheet cell values in GAS; stringify defensively.
  return String(v);
}

function decodeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.__t === 'date') return new Date(v.v);
  return v;
}

class Storage {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ss_meta (
        ss TEXT PRIMARY KEY,
        tz TEXT NOT NULL DEFAULT 'Asia/Qatar'
      );
      CREATE TABLE IF NOT EXISTS sheets (
        ss   TEXT NOT NULL,
        name TEXT NOT NULL,
        idx  INTEGER NOT NULL,
        PRIMARY KEY (ss, name)
      );
      CREATE TABLE IF NOT EXISTS rows (
        ss     TEXT NOT NULL,
        sheet  TEXT NOT NULL,
        rownum INTEGER NOT NULL,
        cells  TEXT NOT NULL,
        PRIMARY KEY (ss, sheet, rownum)
      );
      CREATE TABLE IF NOT EXISTS props (
        scope TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS cache (
        scope   TEXT NOT NULL,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        expires INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `);
  }

  // --- PropertiesService backing (scope: 'script' | 'user' | 'document') ---
  propGet(scope, key) {
    const r = this.db.prepare('SELECT value FROM props WHERE scope = ? AND key = ?').get(scope, key);
    return r ? r.value : null;
  }
  propSet(scope, key, value) {
    this.db.prepare('INSERT OR REPLACE INTO props (scope, key, value) VALUES (?, ?, ?)').run(scope, key, String(value));
  }
  propDelete(scope, key) {
    this.db.prepare('DELETE FROM props WHERE scope = ? AND key = ?').run(scope, key);
  }
  propAll(scope) {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value FROM props WHERE scope = ?').all(scope)) out[r.key] = r.value;
    return out;
  }
  propDeleteAll(scope) {
    this.db.prepare('DELETE FROM props WHERE scope = ?').run(scope);
  }

  // --- CacheService backing (with expiry in epoch ms) ---
  cacheGet(scope, key) {
    const r = this.db.prepare('SELECT value, expires FROM cache WHERE scope = ? AND key = ?').get(scope, key);
    if (!r) return null;
    if (r.expires <= Date.now()) {
      this.db.prepare('DELETE FROM cache WHERE scope = ? AND key = ?').run(scope, key);
      return null;
    }
    return r.value;
  }
  cacheSet(scope, key, value, ttlSeconds) {
    const expires = Date.now() + ttlSeconds * 1000;
    this.db.prepare('INSERT OR REPLACE INTO cache (scope, key, value, expires) VALUES (?, ?, ?, ?)').run(scope, key, String(value), expires);
  }
  cacheDelete(scope, key) {
    this.db.prepare('DELETE FROM cache WHERE scope = ? AND key = ?').run(scope, key);
  }

  ensureSpreadsheet(ss) {
    this.db.prepare('INSERT OR IGNORE INTO ss_meta (ss) VALUES (?)').run(ss);
  }

  getTz(ss) {
    const r = this.db.prepare('SELECT tz FROM ss_meta WHERE ss = ?').get(ss);
    return r ? r.tz : 'Asia/Qatar';
  }

  setTz(ss, tz) {
    this.ensureSpreadsheet(ss);
    this.db.prepare('UPDATE ss_meta SET tz = ? WHERE ss = ?').run(tz, ss);
  }

  sheetNames(ss) {
    return this.db
      .prepare('SELECT name FROM sheets WHERE ss = ? ORDER BY idx')
      .all(ss)
      .map((r) => r.name);
  }

  sheetExists(ss, name) {
    return !!this.db.prepare('SELECT 1 FROM sheets WHERE ss = ? AND name = ?').get(ss, name);
  }

  insertSheet(ss, name) {
    this.ensureSpreadsheet(ss);
    const max = this.db.prepare('SELECT MAX(idx) AS m FROM sheets WHERE ss = ?').get(ss);
    const idx = (max && max.m != null ? max.m : -1) + 1;
    this.db.prepare('INSERT OR IGNORE INTO sheets (ss, name, idx) VALUES (?, ?, ?)').run(ss, name, idx);
  }

  // Full grid as a 1-based-preserving 0-based 2D array (grid[0] is sheet row 1).
  loadGrid(ss, name) {
    const rows = this.db
      .prepare('SELECT rownum, cells FROM rows WHERE ss = ? AND sheet = ? ORDER BY rownum')
      .all(ss, name);
    const grid = [];
    for (const r of rows) {
      const arr = JSON.parse(r.cells).map(decodeCell);
      grid[r.rownum - 1] = arr;
    }
    // Fill any gaps so the array is dense.
    for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
    return grid;
  }

  // Replace the whole sheet contents with the given grid (0-based rows).
  saveGrid(ss, name, grid) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rows WHERE ss = ? AND sheet = ?').run(ss, name);
      const ins = this.db.prepare('INSERT INTO rows (ss, sheet, rownum, cells) VALUES (?, ?, ?, ?)');
      for (let i = 0; i < grid.length; i++) {
        const row = grid[i] || [];
        ins.run(ss, name, i + 1, JSON.stringify(row.map(encodeCell)));
      }
    });
    tx();
  }

  // Write a single row (1-based), used by appendRow / setValues to avoid
  // rewriting the whole sheet on every mutation.
  putRow(ss, name, rownum, cellsArray) {
    this.db
      .prepare('INSERT OR REPLACE INTO rows (ss, sheet, rownum, cells) VALUES (?, ?, ?, ?)')
      .run(ss, name, rownum, JSON.stringify((cellsArray || []).map(encodeCell)));
  }

  // Delete a row (1-based) and shift every subsequent row up by one, matching
  // GAS Sheet.deleteRow().
  deleteRowShift(ss, name, rownum) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rows WHERE ss = ? AND sheet = ? AND rownum = ?').run(ss, name, rownum);
      this.db
        .prepare('UPDATE rows SET rownum = rownum - 1 WHERE ss = ? AND sheet = ? AND rownum > ?')
        .run(ss, name, rownum);
    });
    tx();
  }

  close() {
    this.db.close();
  }
}

module.exports = { Storage, encodeCell, decodeCell };
