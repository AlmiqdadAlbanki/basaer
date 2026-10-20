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
//
// In-memory grid cache and multi-connection coherence
// ---------------------------------------------------
// Every sheet grid is kept in memory after its first load, so reads never hit
// SQLite. Several Storage instances may be open on the same database file at
// once (one per worker thread, plus the tools), so a cached grid can go stale
// when another connection writes. Two cheap checks keep it coherent:
//   1. `PRAGMA data_version` changes whenever ANOTHER connection commits. It is
//      read on every grid access; while it is unchanged nothing external
//      happened and the cache is trusted as-is.
//   2. When it has changed, each cached grid is re-validated once against its
//      row in `sheet_versions` (bumped inside every write transaction) and
//      reloaded only if that sheet actually changed.
// Grids are handed out by reference (no per-call clone): the Sheets shim
// mutates them in place and persists immediately through the write methods
// below, which keep the cached copy and the database in step.

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

function isEmptyCell(v) {
  return v === '' || v === null || v === undefined;
}

// 1-based number of the last row holding any value (0 for an empty grid),
// matching Sheet.getLastRow().
function lastNonEmptyRow(grid) {
  for (let r = grid.length - 1; r >= 0; r--) {
    const row = grid[r];
    if (row && row.some((v) => !isEmptyCell(v))) return r + 1;
  }
  return 0;
}

class Storage {
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    // `timeout`: how long a write waits for another connection's write lock
    // before failing with SQLITE_BUSY. Writers from several threads are
    // serialised by SQLite itself; 5s is far above any real transaction here.
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    // Durable enough under WAL (a crash of the process loses nothing; only an
    // OS crash or power loss can lose the last few transactions) and
    // noticeably faster for writes.
    this.db.pragma('synchronous = NORMAL');
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
      -- Bumped inside every write transaction on a sheet; lets other
      -- connections tell which cached grids went stale (see header comment).
      CREATE TABLE IF NOT EXISTS sheet_versions (
        ss      TEXT NOT NULL,
        sheet   TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (ss, sheet)
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
      -- Local file store (replaces Google Drive). Bytes live on disk at <filesDir>/<id>;
      -- folders have no disk content. Legacy Drive folder ids are auto-created as folders.
      CREATE TABLE IF NOT EXISTS files (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        mime       TEXT NOT NULL,
        size       INTEGER NOT NULL DEFAULT 0,
        parent_id  TEXT,
        is_folder  INTEGER NOT NULL DEFAULT 0,
        is_public  INTEGER NOT NULL DEFAULT 0,
        trashed    INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_parent ON files (parent_id);
      -- Time-based triggers (replaces ScriptApp triggers). kind: 'once' | 'every'
      CREATE TABLE IF NOT EXISTS triggers (
        id          TEXT PRIMARY KEY,
        handler     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        due_at      INTEGER NOT NULL,
        interval_ms INTEGER,
        created_at  INTEGER NOT NULL
      );
      -- Outgoing email (replaces GmailApp/MailApp). status: 'dry-run' | 'queued' | 'sent' | 'failed'
      CREATE TABLE IF NOT EXISTS outbox (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        to_addr    TEXT,
        subject    TEXT,
        body_text  TEXT,
        body_html  TEXT,
        meta       TEXT,
        status     TEXT NOT NULL,
        error      TEXT
      );
      -- Record of outbound HTTP calls (WhatsApp, FCM, ...). mode: 'dry-run' | 'live' |
      -- 'local-qr' (a QR image drawn locally instead of calling api.qrserver.com)
      CREATE TABLE IF NOT EXISTS outbound_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        mode       TEXT NOT NULL,
        host       TEXT,
        url        TEXT,
        method     TEXT,
        payload    TEXT,
        status     INTEGER,
        response   TEXT
      );
      -- Session ids (the \`sid\` claim of a session cookie) that were logged out
      -- before they expired. Rows are dropped once the cookie would have expired anyway.
      CREATE TABLE IF NOT EXISTS revoked_sessions (
        sid     TEXT PRIMARY KEY,
        expires INTEGER NOT NULL
      );
    `);

    // In-memory copy of each sheet grid, keyed "ss\u0000sheet" ->
    // { grid, version, needsVersionCheck }. See the header comment.
    this._grids = new Map();
    // Last `PRAGMA data_version` seen; a change means another connection wrote.
    this._seenDataVersion = null;

    // Prepared once: these run on nearly every call.
    this._stmts = {
      dataVersion: this.db.prepare('PRAGMA data_version').pluck(),
      sheetVersion: this.db.prepare('SELECT version FROM sheet_versions WHERE ss = ? AND sheet = ?').pluck(),
      bumpVersion: this.db.prepare(
        'INSERT INTO sheet_versions (ss, sheet, version) VALUES (?, ?, 1) '
        + 'ON CONFLICT(ss, sheet) DO UPDATE SET version = version + 1 RETURNING version',
      ).pluck(),
      selectRows: this.db.prepare('SELECT rownum, cells FROM rows WHERE ss = ? AND sheet = ? ORDER BY rownum'),
      upsertRow: this.db.prepare('INSERT OR REPLACE INTO rows (ss, sheet, rownum, cells) VALUES (?, ?, ?, ?)'),
      deleteSheetRows: this.db.prepare('DELETE FROM rows WHERE ss = ? AND sheet = ?'),
      deleteRow: this.db.prepare('DELETE FROM rows WHERE ss = ? AND sheet = ? AND rownum = ?'),
      shiftRowsUp: this.db.prepare('UPDATE rows SET rownum = rownum - 1 WHERE ss = ? AND sheet = ? AND rownum > ?'),
      propGet: this.db.prepare('SELECT value FROM props WHERE scope = ? AND key = ?').pluck(),
      propSet: this.db.prepare('INSERT OR REPLACE INTO props (scope, key, value) VALUES (?, ?, ?)'),
      propDelete: this.db.prepare('DELETE FROM props WHERE scope = ? AND key = ?'),
      propAll: this.db.prepare('SELECT key, value FROM props WHERE scope = ?'),
      propDeleteAll: this.db.prepare('DELETE FROM props WHERE scope = ?'),
      cacheGet: this.db.prepare('SELECT value, expires FROM cache WHERE scope = ? AND key = ?'),
      cacheSet: this.db.prepare('INSERT OR REPLACE INTO cache (scope, key, value, expires) VALUES (?, ?, ?, ?)'),
      cacheDelete: this.db.prepare('DELETE FROM cache WHERE scope = ? AND key = ?'),
      cacheSweep: this.db.prepare('DELETE FROM cache WHERE expires <= ?'),
      sheetExists: this.db.prepare('SELECT 1 FROM sheets WHERE ss = ? AND name = ?').pluck(),
      sheetNames: this.db.prepare('SELECT name FROM sheets WHERE ss = ? ORDER BY idx').pluck(),
      revokeSession: this.db.prepare('INSERT OR REPLACE INTO revoked_sessions (sid, expires) VALUES (?, ?)'),
      isSessionRevoked: this.db.prepare('SELECT 1 FROM revoked_sessions WHERE sid = ?').pluck(),
      sweepRevoked: this.db.prepare('DELETE FROM revoked_sessions WHERE expires <= ?'),
    };

    // Write transactions. `.immediate()` takes the database write lock up
    // front, so inside each one: `_entry` revalidates the cached grid against
    // the latest committed state (reloading it if another connection changed
    // the sheet), the rows are written, the version is bumped, and the same
    // change is applied to that up-to-date cached grid. Nothing can commit in
    // between, so the cache leaves the transaction exactly equal to the
    // database — including other connections' earlier writes.
    this._txSaveGrid = this.db.transaction((ss, name, grid) => {
      this._stmts.deleteSheetRows.run(ss, name);
      for (let i = 0; i < grid.length; i++) {
        this._stmts.upsertRow.run(ss, name, i + 1, JSON.stringify((grid[i] || []).map(encodeCell)));
      }
      const version = this._stmts.bumpVersion.get(ss, name);
      this._grids.set(this._key(ss, name), {
        grid: grid.map((row) => (row || []).slice()),
        version,
        needsVersionCheck: false,
      });
    });
    this._txPutRows = this.db.transaction((ss, name, startRow, rowsArray) => {
      const entry = this._entry(ss, name);
      for (let i = 0; i < rowsArray.length; i++) {
        this._stmts.upsertRow.run(ss, name, startRow + i, JSON.stringify((rowsArray[i] || []).map(encodeCell)));
      }
      entry.version = this._stmts.bumpVersion.get(ss, name);
      const grid = entry.grid;
      for (let i = grid.length; i < startRow - 1; i++) grid[i] = [];
      for (let i = 0; i < rowsArray.length; i++) grid[startRow - 1 + i] = (rowsArray[i] || []).slice();
    });
    this._txAppendRow = this.db.transaction((ss, name, cellsArray) => {
      // The row number is computed under the write lock against the current
      // grid, so it is unique even with several threads appending at once.
      const entry = this._entry(ss, name);
      const rownum = lastNonEmptyRow(entry.grid) + 1;
      this._stmts.upsertRow.run(ss, name, rownum, JSON.stringify((cellsArray || []).map(encodeCell)));
      entry.version = this._stmts.bumpVersion.get(ss, name);
      const grid = entry.grid;
      for (let i = grid.length; i < rownum - 1; i++) grid[i] = [];
      grid[rownum - 1] = (cellsArray || []).slice();
      return rownum;
    });
    this._txDeleteRowShift = this.db.transaction((ss, name, rownum) => {
      const entry = this._entry(ss, name);
      this._stmts.deleteRow.run(ss, name, rownum);
      this._stmts.shiftRowsUp.run(ss, name, rownum);
      entry.version = this._stmts.bumpVersion.get(ss, name);
      if (rownum - 1 < entry.grid.length) entry.grid.splice(rownum - 1, 1);
    });
  }

  // --- PropertiesService backing (scope: 'script' | 'user' | 'document') ---
  propGet(scope, key) {
    const value = this._stmts.propGet.get(scope, key);
    return value === undefined ? null : value;
  }
  propSet(scope, key, value) {
    this._stmts.propSet.run(scope, key, String(value));
  }
  propDelete(scope, key) {
    this._stmts.propDelete.run(scope, key);
  }
  propAll(scope) {
    const out = {};
    for (const r of this._stmts.propAll.all(scope)) out[r.key] = r.value;
    return out;
  }
  propDeleteAll(scope) {
    this._stmts.propDeleteAll.run(scope);
  }

  // --- CacheService backing (with expiry in epoch ms) ---
  cacheGet(scope, key) {
    const r = this._stmts.cacheGet.get(scope, key);
    if (!r) return null;
    if (r.expires <= Date.now()) {
      this._stmts.cacheDelete.run(scope, key);
      return null;
    }
    return r.value;
  }
  cacheSet(scope, key, value, ttlSeconds) {
    const expires = Date.now() + ttlSeconds * 1000;
    this._stmts.cacheSet.run(scope, key, String(value), expires);
  }
  cacheDelete(scope, key) {
    this._stmts.cacheDelete.run(scope, key);
  }
  // Remove expired entries (OTP codes, QR sessions, revoked session ids) so
  // the tables never grow unbounded. Called periodically by the server.
  cacheSweepExpired() {
    const now = Date.now();
    this._stmts.sweepRevoked.run(now);
    return this._stmts.cacheSweep.run(now).changes;
  }

  // --- Logged-out session cookies (sid claim) ---
  revokeSession(sid, expiresMs) {
    this._stmts.revokeSession.run(String(sid), expiresMs);
  }
  isSessionRevoked(sid) {
    return this._stmts.isSessionRevoked.get(String(sid)) !== undefined;
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
    return this._stmts.sheetNames.all(ss);
  }

  sheetExists(ss, name) {
    return this._stmts.sheetExists.get(ss, name) !== undefined;
  }

  insertSheet(ss, name) {
    this.ensureSpreadsheet(ss);
    const max = this.db.prepare('SELECT MAX(idx) AS m FROM sheets WHERE ss = ?').get(ss);
    const idx = (max && max.m != null ? max.m : -1) + 1;
    this.db.prepare('INSERT OR IGNORE INTO sheets (ss, name, idx) VALUES (?, ?, ?)').run(ss, name, idx);
  }

  _key(ss, name) { return ss + '\u0000' + name; }

  // Read the master grid from SQLite (uncached) together with its version.
  _loadGridFromDb(ss, name) {
    const rows = this._stmts.selectRows.all(ss, name);
    const grid = [];
    for (const r of rows) {
      grid[r.rownum - 1] = JSON.parse(r.cells).map(decodeCell);
    }
    for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
    const version = this._stmts.sheetVersion.get(ss, name);
    return { grid, version: version === undefined ? 0 : version, needsVersionCheck: false };
  }

  // The cached entry for a sheet, revalidated against other connections' writes.
  _entry(ss, name) {
    const dataVersion = this._stmts.dataVersion.get();
    if (dataVersion !== this._seenDataVersion) {
      // Another connection committed something since we last looked: every
      // cached grid must prove it is still current before being trusted.
      this._seenDataVersion = dataVersion;
      for (const entry of this._grids.values()) entry.needsVersionCheck = true;
    }
    const key = this._key(ss, name);
    let entry = this._grids.get(key);
    if (entry && entry.needsVersionCheck) {
      entry.needsVersionCheck = false;
      const current = this._stmts.sheetVersion.get(ss, name);
      if ((current === undefined ? 0 : current) !== entry.version) entry = undefined;
    }
    if (!entry) {
      entry = this._loadGridFromDb(ss, name);
      this._grids.set(key, entry);
    }
    return entry;
  }

  // Full grid as a 0-based 2D array (grid[0] is sheet row 1). This is the
  // cached master itself, not a copy: callers that mutate it must persist
  // through saveGrid/putRow/putRows/appendRow/deleteRowShift right away (the
  // Sheets shim does), passing the rows they mutated rather than re-reading
  // this getter (another thread's commit in between can swap the cached array
  // for a reloaded one). Anyone wanting a private copy must clone it.
  loadGrid(ss, name) {
    return this._entry(ss, name).grid;
  }

  // Run a write transaction; if it fails the cached grid is dropped so the next
  // read reloads the database's view rather than trusting a half-applied one.
  _write(ss, name, runTransaction) {
    try {
      return runTransaction();
    } catch (err) {
      this._grids.delete(this._key(ss, name));
      throw err;
    }
  }

  // Replace the whole sheet contents with the given grid (0-based rows).
  saveGrid(ss, name, grid) {
    this._write(ss, name, () => this._txSaveGrid.immediate(ss, name, grid));
  }

  // Write one row (1-based), used by setValue(s) on a single row.
  putRow(ss, name, rownum, cellsArray) {
    this.putRows(ss, name, rownum, [cellsArray || []]);
  }

  // Write consecutive rows starting at startRow (1-based) in one transaction,
  // so a multi-row setValues costs one version bump and one commit.
  putRows(ss, name, startRow, rowsArray) {
    this._write(ss, name, () => this._txPutRows.immediate(ss, name, startRow, rowsArray));
  }

  // Append after the last non-empty row, atomically with respect to other
  // connections (matches the server-side atomicity of GAS Sheet.appendRow()).
  // Returns the 1-based row number written.
  appendRow(ss, name, cellsArray) {
    return this._write(ss, name, () => this._txAppendRow.immediate(ss, name, cellsArray));
  }

  // Delete a row (1-based) and shift every subsequent row up by one, matching
  // GAS Sheet.deleteRow().
  deleteRowShift(ss, name, rownum) {
    this._write(ss, name, () => this._txDeleteRowShift.immediate(ss, name, rownum));
  }

  // Drop the in-memory copy (e.g. after an external import into the DB).
  invalidate(ss, name) {
    if (ss == null) this._grids.clear();
    else this._grids.delete(this._key(ss, name));
  }

  close() {
    this.db.close();
  }
}

module.exports = { Storage, encodeCell, decodeCell, lastNonEmptyRow };
