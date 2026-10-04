'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Storage } = require('../server/storage.js');
const { IDS } = require('./xlsx-common.js');
const { checkHeaders } = require('./check-headers.js');
const { importFolderListing, readManifest } = require('./import-google-exports.js');

test('manifest parses, ids look like Drive ids, names are unique', () => {
  const manifest = readManifest();
  assert.ok(manifest.length > 0);
  for (const entry of manifest) {
    assert.match(entry.id, /^[A-Za-z0-9_-]{20,}$/, entry.name);
    assert.ok(['sheet', 'doc', 'slides', 'folder'].includes(entry.kind), entry.name);
  }
  assert.strictEqual(new Set(manifest.map((e) => e.name)).size, manifest.length);
  for (const logical of Object.keys(IDS)) {
    assert.ok(manifest.some((e) => e.name === logical && e.id === IDS[logical] && e.kind === 'sheet'), logical);
  }
});

test('check-headers reports a missing sheet, missing header and order change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'headers-'));
  const storage = new Storage(path.join(dir, 'test.sqlite'));
  try {
    storage.ensureSpreadsheet(IDS.attendanceData);
    storage.insertSheet(IDS.attendanceData, 'attendance');
    // 'cpr' dropped, 'id' and 'name' swapped, plus an unknown column.
    storage.saveGrid(IDS.attendanceData, 'attendance', [['date/time', 'name', 'id', 'by', 'level', 'surprise']]);
    const warnings = checkHeaders(storage, {
      attendanceData: { attendance: ['date/time', 'id', 'cpr', 'name', 'by', 'level'] },
      answersData: { answers: ['time'] },
    });
    const text = warnings.join('\n');
    assert.match(text, /MISSING header: attendanceData \/ attendance: cpr/);
    assert.match(text, /ORDER: attendanceData \/ attendance/);
    assert.match(text, /EXTRA: attendanceData \/ attendance: surprise/);
    assert.match(text, /MISSING sheet: answersData \/ answers/);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('folder import keeps original google ids, nesting and pdf bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folders-'));
  const storage = new Storage(path.join(dir, 'test.sqlite'));
  const filesDir = path.join(dir, 'files');
  const sourceDir = path.join(dir, 'src');
  try {
    fs.mkdirSync(path.join(sourceDir, 'A', 'B'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'A', 'card.pdf'), 'PDFBYTES');
    fs.writeFileSync(path.join(sourceDir, 'A', 'B', 'letter.pdf'), 'EXPORTED');
    const listing = [
      { Path: 'A', Name: 'A', IsDir: true, ID: 'idFolderA', MimeType: 'inode/directory' },
      { Path: 'A/B', Name: 'B', IsDir: true, ID: 'idFolderB', MimeType: 'inode/directory' },
      { Path: 'A/card.pdf', Name: 'card.pdf', IsDir: false, ID: 'idCardPdf', MimeType: 'application/pdf', Size: 8 },
      // Google Doc exported by rclone as letter.pdf; the listing has no suffix.
      { Path: 'A/B/letter', Name: 'letter', IsDir: false, ID: 'idLetterDoc', MimeType: 'application/vnd.google-apps.document', Size: -1 },
    ];
    const counts = importFolderListing({ storage, filesDir, rootId: 'idRoot', rootName: 'perArchiveID', listing, sourceDir });
    assert.deepStrictEqual(counts, { folders: 3, files: 2, missing: 0 });

    const row = (id) => storage.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    assert.strictEqual(row('idRoot').parent_id, null);
    assert.strictEqual(row('idFolderA').parent_id, 'idRoot');
    assert.strictEqual(row('idFolderB').parent_id, 'idFolderA');
    assert.strictEqual(row('idCardPdf').parent_id, 'idFolderA');
    assert.strictEqual(row('idCardPdf').mime, 'application/pdf');
    assert.strictEqual(row('idCardPdf').is_public, 1);
    const letter = row('idLetterDoc');
    assert.strictEqual(letter.parent_id, 'idFolderB');
    assert.strictEqual(letter.name, 'letter.pdf');
    assert.strictEqual(letter.mime, 'application/pdf');
    assert.strictEqual(letter.size, 8);
    assert.strictEqual(fs.readFileSync(path.join(filesDir, 'idCardPdf'), 'utf8'), 'PDFBYTES');
    assert.strictEqual(fs.readFileSync(path.join(filesDir, 'idLetterDoc'), 'utf8'), 'EXPORTED');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
