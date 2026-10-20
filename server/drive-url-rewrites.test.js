'use strict';

// Google Drive URLs built into the legacy pages/scripts are repointed at the
// local file store at serve time: in the served partials, in the page
// templates HtmlService returns, and for server-side UrlFetchApp.fetch calls.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rewriteLegacyDriveUrls, rewriteLegacyPartial } = require('./page-rewrites.js');
const { makeHtmlService } = require('./shims/platform.js');
const { makeUrlFetchApp } = require('./shims/urlfetch.js');
const { Storage } = require('./storage.js');

test('rewriteLegacyDriveUrls repoints thumbnail, file and folder URL prefixes and keeps the ids', () => {
  const input = [
    '<img src="https://drive.google.com/thumbnail?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&amp;sz=w1000.png">',
    "lvlLogo[i].src = 'https://drive.google.com/thumbnail?id='+logoId+'&amp;sz=w1000.png';",
    "window.open('https://drive.google.com/file/d/' + fileBtn.dataset.fileId + '/view', '_blank');",
    "mediaFrame.src = 'https://drive.google.com/file/d/' + id + '/preview';",
    "return 'https://drive.google.com/drive/folders/' + idMatch[0];",
  ].join('\n');
  const output = rewriteLegacyDriveUrls(input);
  assert.ok(output.includes('<img src="/thumb?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&amp;sz=w1000.png">'));
  assert.ok(output.includes("'/thumb?id='+logoId+"));
  assert.ok(output.includes("window.open('/files/' + fileBtn.dataset.fileId + '/view'"));
  assert.ok(output.includes("mediaFrame.src = '/files/' + id + '/preview'"));
  assert.ok(output.includes("return '/files/folder/' + idMatch[0]"));
  assert.ok(!output.includes('drive.google.com'));
  assert.strictEqual(rewriteLegacyDriveUrls(output), output, 'idempotent');
});

test('the real gas partials and templates contain no drive.google.com after the rewrite', () => {
  const gasDir = path.join(__dirname, '..', 'gas');
  for (const name of ['js', 'funcs-js', 'admin-js', 'student', 'login', 'homePage', 'adminDashboard', 'emp', 'registration', 'questions', 'Iqrar', 'style-css']) {
    const raw = fs.readFileSync(path.join(gasDir, name + '.html'), 'utf8');
    const rewritten = rewriteLegacyPartial(name, raw);
    assert.ok(!/drive\.google\.com\/(thumbnail|file\/d|drive\/folders)/.test(rewritten), name + ' still references Drive');
  }
});

test('HtmlService templates (loadPage* results) are rewritten too', () => {
  const htmlService = makeHtmlService(path.join(__dirname, '..', 'gas'));
  const studentPage = htmlService.createTemplateFromFile('student').evaluate().getContent();
  assert.ok(studentPage.includes('/thumb?id='));
  assert.ok(!studentPage.includes('drive.google.com/thumbnail'));
});

test('UrlFetchApp answers Drive URLs of imported files from the local store, in both modes', () => {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-urlfetch-'));
  const storage = new Storage(':memory:');
  const now = new Date().toISOString();
  storage.db.prepare('INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at) VALUES (?,?,?,?,?,0,1,0,?,?)')
    .run('1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX', 'logo.png', 'image/png', 4, null, now, now);
  fs.writeFileSync(path.join(filesDir, '1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  try {
    for (const mode of ['dry-run', 'live']) {
      const urlFetchApp = makeUrlFetchApp({ storage, filesDir, mode });
      for (const url of [
        'https://drive.google.com/thumbnail?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&sz=w1000',
        'https://drive.google.com/uc?export=view&id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX',
        'https://drive.google.com/file/d/1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX/view',
        'http://localhost:3000/files/1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX/logo.png',
      ]) {
        const response = urlFetchApp.fetch(url);
        assert.strictEqual(response.getResponseCode(), 200, mode + ' ' + url);
        assert.strictEqual(response.getBlob().getContentType(), 'image/png');
        assert.deepStrictEqual(Array.from(response.getContent()), [0x89, 0x50, 0x4e, 0x47]);
      }
      const logged = storage.db.prepare("SELECT count(*) AS n FROM outbound_log WHERE mode = 'local-file'").get().n;
      assert.ok(logged >= 4, 'recorded as local-file');
      // An unknown id is not answered locally (dry-run falls through to the canned reply).
      if (mode === 'dry-run') {
        const unknown = urlFetchApp.fetch('https://drive.google.com/thumbnail?id=1UNKNOWNUNKNOWNUNKNOWNUNKNOWNUNK&sz=w100');
        assert.strictEqual(unknown.getResponseCode(), 200);
        assert.notDeepStrictEqual(Array.from(unknown.getContent()), [0x89, 0x50, 0x4e, 0x47]);
      }
    }
  } finally {
    storage.close();
    fs.rmSync(filesDir, { recursive: true, force: true });
  }
});
