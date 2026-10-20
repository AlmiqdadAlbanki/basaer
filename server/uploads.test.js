'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { Storage } = require('./storage.js');
const { makeDriveShims } = require('./shims/drive.js');
const { storeStudentWork, isBlockedUpload } = require('./uploads.js');

function makeFixture() {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-upload-'));
  const storage = new Storage(':memory:');
  const driveShims = makeDriveShims({ storage, filesDir, baseUrl: 'http://localhost:3000' });
  const folderId = driveShims.DriveApp.getFolderById('legacyFolder1').createFolder('Student').getId();
  return { driveShims, folderId };
}

test('storeStudentWork creates a public file inside the folder', () => {
  const { driveShims, folderId } = makeFixture();
  const result = storeStudentWork(driveShims, { folderId, fileName: 'stWork-1-123456789', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 hi'), originalName: 'a.pdf' });
  assert.match(result.id, /^f_[0-9a-f]{32}$/);
  assert.strictEqual(result.name, 'stWork-1-123456789');
  assert.ok(result.url.includes(result.id));
  const file = driveShims.DriveApp.getFileById(result.id);
  assert.strictEqual(file.getUrl(), result.url);
  assert.strictEqual(file.getMimeType(), 'application/pdf');
  assert.strictEqual(file.getSize(), 11);
  assert.strictEqual(driveShims.Drive.Permissions.list(result.id).permissions[0].type, 'anyone');
  assert.strictEqual(file.getParents().next().getId(), folderId);
});

test('isOwnFolder handles local, legacy Google and bare folder URLs', () => {
  const { isOwnFolder, folderIdFromUrl } = require('./uploads.js');
  assert.strictEqual(folderIdFromUrl('/files/folder/f_abc123'), 'f_abc123');
  assert.ok(isOwnFolder('http://localhost:3000/files/folder/f_abc123', 'f_abc123'));
  assert.ok(isOwnFolder('https://drive.google.com/drive/folders/1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ?usp=sharing', '1AbC_dEf-gHiJkLmNoPqRsTuVwXyZ'));
  assert.ok(isOwnFolder('f_abc123', 'f_abc123'));
  assert.ok(!isOwnFolder('/files/folder/f_abc123', 'f_other'));
  assert.ok(!isOwnFolder('', ''));
  assert.ok(!isOwnFolder(undefined, 'f_abc123'));
});

test('storeStudentWork rejects executables, empty files and missing folders', () => {
  const { driveShims, folderId } = makeFixture();
  const base = { folderId, fileName: 'x', mime: 'application/octet-stream' };
  assert.throws(() => storeStudentWork(driveShims, { ...base, bytes: Buffer.from('hello'), originalName: 'run.exe' }), { status: 415 });
  assert.throws(() => storeStudentWork(driveShims, { ...base, bytes: Buffer.from([0x4d, 0x5a, 0, 0]), originalName: 'a.pdf' }), { status: 415 });
  assert.throws(() => storeStudentWork(driveShims, { ...base, bytes: Buffer.alloc(0), originalName: 'a.pdf' }), { status: 400 });
  assert.strictEqual(isBlockedUpload('photo.JPG', Buffer.from([0xff, 0xd8, 0xff])), false);
});
