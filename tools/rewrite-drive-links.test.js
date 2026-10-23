'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Storage } = require('../server/storage.js');
const { IDS } = require('./xlsx-common.js');
const { rewriteDriveLinks, rewriteLinksInText } = require('./rewrite-drive-links.js');

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const FOLDER_ID = '1FolderFolderFolderFolderFolder01';
const UNKNOWN_ID = '1UnknownUnknownUnknownUnknown001';

function seededStorage() {
  const storage = new Storage(':memory:');
  const now = new Date().toISOString();
  const insert = storage.db.prepare('INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at) VALUES (?,?,?,?,NULL,?,1,0,?,?)');
  insert.run(FILE_ID, 'شهادة.pdf', 'application/pdf', 10, 0, now, now);
  insert.run(FOLDER_ID, 'folder', 'application/vnd.google-apps.folder', 0, 1, now, now);
  storage.ensureSpreadsheet(IDS.answersData);
  storage.insertSheet(IDS.answersData, 'answers');
  storage.saveGrid(IDS.answersData, 'answers', [
    ['cpr', 'certificate', 'folder', 'note', 'count'],
    ['1', `https://drive.google.com/file/d/${FILE_ID}/view?usp=drivesdk`, `https://drive.google.com/drive/folders/${FOLDER_ID}`, 'plain text', 3],
    ['2', `https://drive.google.com/file/d/${UNKNOWN_ID}/view`, '', 'see http://localhost:3000/files/abc/x.pdf?download=1.', 4],
    ['3', 'http://localhost:3000/files/def/card.png', 'http://localhost:3000/files/folder/ghi', 'two: http://localhost:3000/a and http://localhost:3000/b', 5],
  ]);
  return storage;
}

test('Google links become local links; an unknown id is reported and left alone', () => {
  const storage = seededStorage();
  try {
    const report = rewriteDriveLinks({ storage, baseUrl: 'https://basaerbh.com/' });
    const grid = storage.loadGrid(IDS.answersData, 'answers');
    assert.strictEqual(grid[1][1], `https://basaerbh.com/files/${FILE_ID}/${encodeURIComponent('شهادة.pdf')}`);
    assert.strictEqual(grid[1][2], `https://basaerbh.com/files/folder/${FOLDER_ID}`);
    assert.strictEqual(grid[2][1], `https://drive.google.com/file/d/${UNKNOWN_ID}/view`, 'unknown id untouched');
    assert.strictEqual(grid[1][4], 3, 'numbers untouched');
    assert.strictEqual(report.totals.linksRewritten, 2);
    assert.strictEqual(report.totals.linksRebased, 0);
    assert.deepStrictEqual(report.unresolved.map((f) => [f.sheet, f.column, f.count, f.sampleIds]), [['answers', 'certificate', 1, [UNKNOWN_ID]]]);
    assert.strictEqual(report.rebaseFrom, null);
    // Links to the server's own address are not touched without --rebase-from.
    assert.strictEqual(grid[3][1], 'http://localhost:3000/files/def/card.png');
  } finally {
    storage.close();
  }
});

test('--rebase-from re-points every link that carries the previous address, keeping the path', () => {
  const storage = seededStorage();
  try {
    const report = rewriteDriveLinks({ storage, baseUrl: 'https://basaerbh.com', rebaseFrom: 'http://localhost:3000/' });
    const grid = storage.loadGrid(IDS.answersData, 'answers');
    assert.strictEqual(grid[2][3], 'see https://basaerbh.com/files/abc/x.pdf?download=1.', 'prose and query string kept');
    assert.strictEqual(grid[3][1], 'https://basaerbh.com/files/def/card.png');
    assert.strictEqual(grid[3][2], 'https://basaerbh.com/files/folder/ghi');
    assert.strictEqual(grid[3][3], 'two: https://basaerbh.com/a and https://basaerbh.com/b');
    assert.strictEqual(grid[1][1], `https://basaerbh.com/files/${FILE_ID}/${encodeURIComponent('شهادة.pdf')}`, 'Google links still handled in the same run');
    assert.strictEqual(report.totals.linksRebased, 5);
    assert.strictEqual(report.totals.linksRewritten, 2);
    assert.strictEqual(report.rebaseFrom, 'http://localhost:3000');

    // Running again is a no-op: nothing carries the old address any more.
    const again = rewriteDriveLinks({ storage, baseUrl: 'https://basaerbh.com', rebaseFrom: 'http://localhost:3000' });
    assert.strictEqual(again.totals.cellsChanged, 0);
    assert.strictEqual(again.totals.linksRebased, 0);
  } finally {
    storage.close();
  }
});

test('--dry-run reports the same totals and changes nothing; same address is refused', () => {
  const storage = seededStorage();
  try {
    const before = JSON.stringify(storage.loadGrid(IDS.answersData, 'answers'));
    const report = rewriteDriveLinks({ storage, baseUrl: 'https://basaerbh.com', rebaseFrom: 'http://localhost:3000', dryRun: true });
    assert.strictEqual(report.totals.linksRebased, 5);
    assert.strictEqual(report.totals.linksRewritten, 2);
    assert.strictEqual(JSON.stringify(storage.loadGrid(IDS.answersData, 'answers')), before);
    assert.throws(() => rewriteDriveLinks({ storage, baseUrl: 'https://basaerbh.com', rebaseFrom: 'https://basaerbh.com/' }), /same address/);
  } finally {
    storage.close();
  }
});

test('rewriteLinksInText counts what it did and never touches a different host with the same prefix', () => {
  const outcome = rewriteLinksInText('http://localhost:3000/files/a http://localhost:30000/files/b', { filesById: new Map(), baseUrl: 'https://x.test', rebaseFrom: 'http://localhost:3000' });
  assert.strictEqual(outcome.text, 'https://x.test/files/a http://localhost:30000/files/b');
  assert.strictEqual(outcome.rebased, 1);
});
