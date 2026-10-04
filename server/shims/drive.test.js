'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { Storage } = require('../storage.js');
const { makeDriveShims } = require('./drive.js');
const { Blob } = require('./utilities.js');

function makeFixture() {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-drive-'));
  const storage = new Storage(':memory:');
  const { DriveApp, Drive } = makeDriveShims({ storage, filesDir, baseUrl: 'http://localhost:3000' });
  return { DriveApp, Drive, storage, filesDir };
}

test('createFile round-trips bytes, name and mime', () => {
  const { DriveApp } = makeFixture();
  const folder = DriveApp.getFolderById('legacyFolder1').createFolder('Avatars');
  const file = folder.createFile(new Blob(Buffer.from([1, 2, 3, 4]), 'image/png', 'a.png'));
  const loaded = DriveApp.getFileById(file.getId());
  assert.match(loaded.getId(), /^f_[0-9a-f]{32}$/);
  assert.strictEqual(loaded.getName(), 'a.png');
  assert.strictEqual(loaded.getMimeType(), 'image/png');
  assert.strictEqual(loaded.getSize(), 4);
  const blob = loaded.getBlob();
  assert.deepStrictEqual(Array.from(blob._buffer()), [1, 2, 3, 4]);
  assert.strictEqual(blob.getContentType(), 'image/png');
  assert.strictEqual(blob.getName(), 'a.png');
  assert.strictEqual(loaded.setName('b.png').getName(), 'b.png');
});

test('getFoldersByName finds an existing folder', () => {
  const { DriveApp } = makeFixture();
  const parent = DriveApp.getFolderById('legacyRoot');
  assert.strictEqual(parent.getFoldersByName('Certs').hasNext(), false);
  const created = parent.createFolder('Certs');
  const iterator = parent.getFoldersByName('Certs');
  assert.ok(iterator.hasNext());
  assert.strictEqual(iterator.next().getId(), created.getId());
  assert.strictEqual(iterator.hasNext(), false);
});

test('makeCopy duplicates record and bytes into destination', () => {
  const { DriveApp } = makeFixture();
  const source = DriveApp.getFolderById('src');
  const destination = DriveApp.getFolderById('dst');
  const original = source.createFile(new Blob('hello', 'text/plain', 'h.txt'));
  const copied = original.makeCopy('h2.txt', destination);
  assert.notStrictEqual(copied.getId(), original.getId());
  assert.strictEqual(copied.getName(), 'h2.txt');
  assert.strictEqual(copied.getBlob().getDataAsString(), 'hello');
  assert.strictEqual(copied.getParents().next().getId(), 'dst');
  const sameNameCopy = original.makeCopy(destination);
  assert.strictEqual(sameNameCopy.getParents().next().getId(), 'dst');
});

test('setTrashed hides files and folders from listings', () => {
  const { DriveApp } = makeFixture();
  const parent = DriveApp.getFolderById('p');
  const file = parent.createFile(new Blob('x', 'text/plain', 'x.txt'));
  const child = parent.createFolder('kid');
  assert.ok(parent.getFiles().hasNext());
  file.setTrashed(true);
  child.setTrashed(true);
  assert.strictEqual(parent.getFiles().hasNext(), false);
  assert.strictEqual(parent.getFoldersByName('kid').hasNext(), false);
  assert.strictEqual(parent.getFolders().hasNext(), false);
});

test('Permissions.create makes the file public and list reports it', () => {
  const { DriveApp, Drive, storage } = makeFixture();
  const file = DriveApp.getFolderById('p').createFile(new Blob('x', 'text/plain', 'x.txt'));
  assert.deepStrictEqual(Drive.Permissions.list(file.getId()).permissions, []);
  Drive.Permissions.create({ role: 'reader', type: 'anyone' }, file.getId(), { supportsAllDrives: true });
  assert.strictEqual(storage.db.prepare('SELECT is_public FROM files WHERE id = ?').get(file.getId()).is_public, 1);
  const permissions = Drive.Permissions.list(file.getId()).permissions;
  assert.strictEqual(permissions[0].type, 'anyone');
  assert.strictEqual(permissions[0].role, 'reader');
});

test('Drive.Files.list supports parents, trashed, mimeType and name contains', () => {
  const { DriveApp, Drive } = makeFixture();
  const parent = DriveApp.getFolderById('listParent');
  const keep = parent.createFile(new Blob('a', 'text/plain', 'Report one.txt'));
  const trashedFile = parent.createFile(new Blob('b', 'text/plain', 'Report two.txt'));
  const subfolder = parent.createFolder('Sub');
  trashedFile.setTrashed(true);

  const everything = Drive.Files.list({ q: "'listParent' in parents and trashed = false" }).files;
  assert.deepStrictEqual(everything.map((entry) => entry.id).sort(), [keep.getId(), subfolder.getId()].sort());

  const foldersOnly = Drive.Files.list({
    q: "'listParent' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
  }).files;
  assert.deepStrictEqual(foldersOnly.map((entry) => entry.id), [subfolder.getId()]);

  const nonFolders = Drive.Files.list({
    q: "'listParent' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
  }).files;
  assert.deepStrictEqual(nonFolders.map((entry) => entry.id), [keep.getId()]);

  const named = Drive.Files.list({ q: "'listParent' in parents and name contains 'report' and trashed = false" }).files;
  assert.deepStrictEqual(named.map((entry) => entry.id), [keep.getId()]);
  assert.deepStrictEqual(Drive.Files.get(keep.getId()).parents, ['listParent']);
});

test('Drive.Files.update replaces bytes', () => {
  const { DriveApp, Drive } = makeFixture();
  const file = DriveApp.getFolderById('p').createFile(new Blob('old', 'text/plain', 'f.txt'));
  Drive.Files.update({ title: 'f.txt', mimeType: 'text/plain' }, file.getId(), new Blob('newer', 'text/plain', 'f.txt'));
  assert.strictEqual(DriveApp.getFileById(file.getId()).getBlob().getDataAsString(), 'newer');
  assert.strictEqual(DriveApp.getFileById(file.getId()).getSize(), 5);
});

test('getFolderById auto-creates unknown legacy ids', () => {
  const { DriveApp } = makeFixture();
  const folder = DriveApp.getFolderById('1AbCdLegacyGoogleId');
  assert.strictEqual(folder.getId(), '1AbCdLegacyGoogleId');
  assert.strictEqual(DriveApp.getFolderById('1AbCdLegacyGoogleId').getId(), '1AbCdLegacyGoogleId');
});

test('getFileById throws a clear error for unknown ids', () => {
  const { DriveApp } = makeFixture();
  assert.throws(() => DriveApp.getFileById('1LegacyTemplate'), /File not found: 1LegacyTemplate/);
});

test('URL shapes', () => {
  const { DriveApp } = makeFixture();
  const folder = DriveApp.getFolderById('urlFolder');
  const file = folder.createFile(new Blob('x', 'text/plain', 'my file.txt'));
  assert.strictEqual(file.getUrl(), `http://localhost:3000/files/${file.getId()}/my%20file.txt`);
  assert.strictEqual(file.getDownloadUrl(), file.getUrl() + '?download=1');
  assert.strictEqual(folder.getUrl(), 'http://localhost:3000/files/folder/urlFolder');
});
