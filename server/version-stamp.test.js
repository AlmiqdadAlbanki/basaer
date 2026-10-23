'use strict';

// Storage.versionStamp(): moves on every change to the data — sheets, the file
// store, the properties — whichever connection or code path wrote it, and stays
// put on reads. The RPC read cache relies on exactly that.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('./storage.js');

test('versionStamp moves on sheet, file and property writes, from any connection, and not on reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-stamp-'));
  const dbPath = path.join(dir, 'stamp.sqlite');
  const storage = new Storage(dbPath);
  const other = new Storage(dbPath); // another connection, as a tool or a worker would be
  const seen = [storage.versionStamp()];
  const expectMoved = (label) => {
    const stamp = storage.versionStamp();
    assert.ok(!seen.includes(stamp), `${label}: stamp did not move (${stamp})`);
    assert.strictEqual(other.versionStamp(), stamp, `${label}: the other connection sees the same stamp`);
    seen.push(stamp);
  };
  try {
    storage.ensureSpreadsheet('ss1');
    storage.insertSheet('ss1', 'sheet');
    storage.saveGrid('ss1', 'sheet', [['h'], ['v']]);
    expectMoved('sheet write');
    storage.appendRow('ss1', 'sheet', ['w']);
    expectMoved('appended row');

    // The Drive shim and the uploads write the files table with plain SQL.
    storage.db.prepare("INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at) VALUES ('f1', 'n', 'text/plain', 1, NULL, 0, 0, 0, 't', 't')").run();
    expectMoved('file inserted');
    storage.db.prepare("UPDATE files SET is_public = 1 WHERE id = 'f1'").run();
    expectMoved('file updated');
    storage.db.prepare("DELETE FROM files WHERE id = 'f1'").run();
    expectMoved('file deleted');

    storage.db.prepare("INSERT OR REPLACE INTO props (scope, key, value) VALUES ('script', 'k', 'v')").run();
    expectMoved('property set');
    storage.db.prepare("DELETE FROM props WHERE scope = 'script' AND key = 'k'").run();
    expectMoved('property deleted');

    const before = storage.versionStamp();
    storage.loadGrid('ss1', 'sheet');
    storage.db.prepare('SELECT count(*) FROM files').get();
    assert.strictEqual(storage.versionStamp(), before, 'reads leave the stamp alone');
  } finally {
    other.close();
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
