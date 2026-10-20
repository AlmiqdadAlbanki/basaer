'use strict';

// tools/import-code-assets.js: type sniffing and registration of the images the
// pages reference by Drive id.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Storage } = require('../server/storage.js');
const { importCodeAssets, sniffMime, harvestIdsFromGas, writeIdsListing } = require('./import-code-assets.js');

test('harvestIdsFromGas finds the Drive ids written into the real pages and writes ids.tsv', () => {
  const idsByFile = harvestIdsFromGas(path.join(__dirname, '..', 'gas'));
  assert.ok(idsByFile.size >= 9, 'expected the logo, avatar and carousel ids; got ' + idsByFile.size);
  assert.ok(idsByFile.has('1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX'), 'the academy logo id');
  assert.ok([...idsByFile.get('1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX')].includes('login.html'));
  for (const id of idsByFile.keys()) assert.match(id, /^[-\w]{25,}$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-ids-'));
  try {
    writeIdsListing(dir, idsByFile);
    const lines = fs.readFileSync(path.join(dir, 'ids.tsv'), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, idsByFile.size);
    assert.ok(lines.every((line) => /^[-\w]{25,}\t\S+/.test(line)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const HTML = Buffer.from('<html><title>Sign in - Google Accounts</title></html>');

test('sniffMime recognises images and PDFs by their bytes only', () => {
  assert.strictEqual(sniffMime(PNG), 'image/png');
  assert.strictEqual(sniffMime(JPEG), 'image/jpeg');
  assert.strictEqual(sniffMime(Buffer.from('%PDF-1.4 x')), 'application/pdf');
  assert.strictEqual(sniffMime(Buffer.from('GIF89a....')), 'image/gif');
  assert.strictEqual(sniffMime(HTML), null);
  assert.strictEqual(sniffMime(Buffer.alloc(0)), null);
});

test('importCodeAssets registers id-named image files as public and skips non-images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-assets-'));
  const filesDir = path.join(dir, 'files');
  const storage = new Storage(':memory:');
  try {
    fs.writeFileSync(path.join(dir, '1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX'), PNG);
    fs.writeFileSync(path.join(dir, '1BifdUAOo6594jxvnkxOUiwXonhetUPpm'), JPEG);
    fs.writeFileSync(path.join(dir, '1zgseX_0_TPsyQlCjiTjKzxJ4dR5lZ1_7'), HTML); // a saved sign-in page by mistake
    fs.writeFileSync(path.join(dir, 'ids.tsv'), '1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX\tlogin.html\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const dry = importCodeAssets({ storage, filesDir, dir, dryRun: true, log: () => {} });
    assert.deepStrictEqual(dry, { registered: 2, skipped: 1 });
    assert.strictEqual(storage.db.prepare('SELECT count(*) AS n FROM files').get().n, 0, 'dry run writes nothing');

    const real = importCodeAssets({ storage, filesDir, dir, dryRun: false, log: () => {} });
    assert.deepStrictEqual(real, { registered: 2, skipped: 1 });
    const logo = storage.db.prepare('SELECT * FROM files WHERE id = ?').get('1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX');
    assert.strictEqual(logo.mime, 'image/png');
    assert.strictEqual(logo.name, '1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX.png');
    assert.strictEqual(logo.is_public, 1);
    assert.ok(fs.existsSync(path.join(filesDir, '1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX')));
    assert.strictEqual(storage.db.prepare('SELECT count(*) AS n FROM files').get().n, 2);
    // Re-running replaces rather than duplicates.
    importCodeAssets({ storage, filesDir, dir, dryRun: false, log: () => {} });
    assert.strictEqual(storage.db.prepare('SELECT count(*) AS n FROM files').get().n, 2);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
