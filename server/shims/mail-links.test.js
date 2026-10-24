'use strict';

// Outgoing e-mail: the Drive links the legacy code writes into message bodies (the logo
// in every message, links to files) are repointed at this server as ABSOLUTE URLs, since
// a mail client cannot follow a relative path and the Drive originals are not reachable.

const test = require('node:test');
const assert = require('node:assert');

const { Storage } = require('../storage.js');
const { Mailer } = require('./mail.js');
const { rewriteLegacyDriveUrlsAbsolute } = require('../page-rewrites.js');

test('rewriteLegacyDriveUrlsAbsolute repoints the Drive prefixes at the server, with the origin', () => {
  const html = '<img src="https://drive.google.com/thumbnail?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&sz=w1000.png"> '
    + '<a href="https://drive.google.com/file/d/1AbC/view">file</a> https://drive.google.com/drive/folders/1Fo';
  const out = rewriteLegacyDriveUrlsAbsolute(html, 'https://basaerbh.com/');
  assert.ok(out.includes('src="https://basaerbh.com/thumb?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&sz=w1000.png"'));
  assert.ok(out.includes('href="https://basaerbh.com/files/1AbC/view"'));
  assert.ok(out.includes('https://basaerbh.com/files/folder/1Fo'));
  assert.ok(!out.includes('drive.google.com'));
  assert.strictEqual(rewriteLegacyDriveUrlsAbsolute(out, 'https://basaerbh.com'), out, 'idempotent');
});

test('the Mailer rewrites the HTML and text of every message it records', () => {
  const storage = new Storage(':memory:');
  try {
    const mailer = new Mailer({ storage, mode: 'dry-run', log: () => {}, baseUrl: 'https://basaerbh.com' });
    const id = mailer.send({
      to: 'x@example.com', subject: 's',
      text: 'see https://drive.google.com/file/d/1AbC/view',
      html: '<img src="https://drive.google.com/thumbnail?id=1Logo&sz=w100">',
    });
    const row = storage.db.prepare('SELECT body_text, body_html FROM outbox WHERE id = ?').get(id);
    assert.strictEqual(row.body_text, 'see https://basaerbh.com/files/1AbC/view');
    assert.strictEqual(row.body_html, '<img src="https://basaerbh.com/thumb?id=1Logo&sz=w100">');

    // Without a base URL nothing is touched (a relative link would be worse than the original).
    const plain = new Mailer({ storage, mode: 'dry-run', log: () => {} });
    const id2 = plain.send({ to: 'x@example.com', subject: 's', text: '', html: '<img src="https://drive.google.com/thumbnail?id=1Logo">' });
    assert.strictEqual(storage.db.prepare('SELECT body_html FROM outbox WHERE id = ?').get(id2).body_html, '<img src="https://drive.google.com/thumbnail?id=1Logo">');
  } finally {
    storage.close();
  }
});
