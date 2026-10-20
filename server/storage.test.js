'use strict';

// Storage: grid cache coherence between two connections on one database file
// (what two worker threads see), atomic appends, and session revocation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('./storage.js');

const SS = 'ssA';
const SHEET = 'students';

function openPair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-storage-'));
  const file = path.join(dir, 'test.sqlite');
  const first = new Storage(file);
  first.insertSheet(SS, SHEET);
  first.saveGrid(SS, SHEET, [['cpr', 'name'], ['1', 'Ali']]);
  const second = new Storage(file);
  return { first, second, dir };
}

test('a grid cached by one connection is refreshed after another connection writes', () => {
  const { first, second, dir } = openPair();
  try {
    assert.deepStrictEqual(second.loadGrid(SS, SHEET)[1], ['1', 'Ali']); // cached now
    first.putRows(SS, SHEET, 2, [['1', 'Ali Updated']]);
    assert.deepStrictEqual(second.loadGrid(SS, SHEET)[1], ['1', 'Ali Updated']);

    second.appendRow(SS, SHEET, ['2', 'Sara']);
    assert.strictEqual(first.loadGrid(SS, SHEET).length, 3);
    assert.deepStrictEqual(first.loadGrid(SS, SHEET)[2], ['2', 'Sara']);

    first.deleteRowShift(SS, SHEET, 2);
    assert.deepStrictEqual(second.loadGrid(SS, SHEET)[1], ['2', 'Sara']);
    assert.strictEqual(second.loadGrid(SS, SHEET).length, 2);

    second.saveGrid(SS, SHEET, [['cpr'], ['9']]);
    assert.deepStrictEqual(first.loadGrid(SS, SHEET), [['cpr'], ['9']]);
  } finally {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a connection own writes are visible to itself without reloading', () => {
  const { first, second, dir } = openPair();
  try {
    const grid = first.loadGrid(SS, SHEET);
    grid[1][1] = 'Mutated in place';
    first.putRows(SS, SHEET, 2, [grid[1]]);
    assert.strictEqual(first.loadGrid(SS, SHEET)[1][1], 'Mutated in place');
    assert.strictEqual(second.loadGrid(SS, SHEET)[1][1], 'Mutated in place');
  } finally {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The interactive worker reads a grid, mutates a row in place, and persists it;
// if the background worker committed to the same sheet in between, neither
// change may be lost and the writer's cache must end up equal to the database.
test('a write made after another connection changed the sheet keeps both changes', () => {
  const { first, second, dir } = openPair();
  try {
    const gridSeenByFirst = first.loadGrid(SS, SHEET);
    gridSeenByFirst[1][1] = 'Ali (edited by first)';
    second.appendRow(SS, SHEET, ['2', 'Sara (added by second)']);
    first.putRows(SS, SHEET, 2, [gridSeenByFirst[1]]);

    const expected = [['cpr', 'name'], ['1', 'Ali (edited by first)'], ['2', 'Sara (added by second)']];
    assert.deepStrictEqual(first.loadGrid(SS, SHEET), expected, 'writer cache');
    assert.deepStrictEqual(second.loadGrid(SS, SHEET), expected, 'other cache');
    const fresh = new Storage(path.join(dir, 'test.sqlite'));
    assert.deepStrictEqual(fresh.loadGrid(SS, SHEET), expected, 'database');
    fresh.close();

    // Same for a delete racing an append.
    second.appendRow(SS, SHEET, ['3', 'Omar']);
    first.deleteRowShift(SS, SHEET, 2);
    assert.deepStrictEqual(first.loadGrid(SS, SHEET), [['cpr', 'name'], ['2', 'Sara (added by second)'], ['3', 'Omar']]);
    assert.deepStrictEqual(second.loadGrid(SS, SHEET), first.loadGrid(SS, SHEET));
  } finally {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRow from two connections never reuses a row number', () => {
  const { first, second, dir } = openPair();
  try {
    const rows = [];
    for (let i = 0; i < 20; i++) {
      rows.push((i % 2 ? second : first).appendRow(SS, SHEET, [String(100 + i), 'p' + i]));
    }
    assert.deepStrictEqual(rows, Array.from({ length: 20 }, (_, i) => 3 + i));
    const final = first.loadGrid(SS, SHEET);
    assert.strictEqual(final.length, 22);
    assert.deepStrictEqual(second.loadGrid(SS, SHEET), final);
  } finally {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('appendRow skips trailing blank rows like Sheet.getLastRow()', () => {
  const storage = new Storage(':memory:');
  storage.insertSheet(SS, SHEET);
  storage.saveGrid(SS, SHEET, [['h'], ['a'], [''], []]);
  assert.strictEqual(storage.appendRow(SS, SHEET, ['b']), 3);
  assert.deepStrictEqual(storage.loadGrid(SS, SHEET)[2], ['b']);
  storage.close();
});

test('Date cells survive a round trip through another connection', () => {
  const { first, second, dir } = openPair();
  try {
    const when = new Date('2026-10-20T08:30:00.000Z');
    first.appendRow(SS, SHEET, ['3', when]);
    const seen = second.loadGrid(SS, SHEET)[2][1];
    assert.ok(seen instanceof Date);
    assert.strictEqual(seen.toISOString(), when.toISOString());
  } finally {
    first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revoked session ids are remembered until they expire', () => {
  const storage = new Storage(':memory:');
  storage.revokeSession('sid-1', Date.now() + 60000);
  storage.revokeSession('sid-old', Date.now() - 1);
  assert.strictEqual(storage.isSessionRevoked('sid-1'), true);
  assert.strictEqual(storage.isSessionRevoked('sid-2'), false);
  storage.cacheSweepExpired();
  assert.strictEqual(storage.isSessionRevoked('sid-1'), true);
  assert.strictEqual(storage.isSessionRevoked('sid-old'), false);
  storage.close();
});
