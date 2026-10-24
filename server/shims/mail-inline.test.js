'use strict';

// GmailApp.sendEmail with inlineImages (the logo in every legacy message, referenced as
// <img src="cid:basairLogo">) must reach the SMTP transport as an inline attachment with
// that content id; cc/bcc/replyTo must reach it too.

const test = require('node:test');
const assert = require('node:assert');

const { Storage } = require('../storage.js');
const { Mailer, makeMailShims } = require('./mail.js');

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47];
const fakeBlob = (name, type, bytes) => ({ getName: () => name, getContentType: () => type, getBytes: () => bytes });

test('inline images and attachments go out as MIME parts; the inline one carries its cid', async () => {
  const storage = new Storage(':memory:');
  const sent = [];
  const transport = { sendMail: (message) => { sent.push(message); return Promise.resolve(); } };
  try {
    const mailer = new Mailer({ storage, mode: 'live', log: () => {}, transport, from: 'Basaer <no-reply@example.com>', baseUrl: 'https://basaerbh.com' });
    const { GmailApp } = makeMailShims(mailer);
    GmailApp.sendEmail('student@example.com', 'subject', 'plain text', {
      htmlBody: '<img src="cid:basairLogo"> <a href="https://drive.google.com/file/d/1AbC/view">file</a>',
      inlineImages: { basairLogo: fakeBlob('logo.png', 'image/png', PNG_HEADER) },
      attachments: [fakeBlob('card.pdf', 'application/pdf', [0x25, 0x50, 0x44, 0x46])],
      cc: 'parent@example.com', replyTo: 'office@example.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(sent.length, 1);
    const message = sent[0];
    assert.strictEqual(message.to, 'student@example.com');
    assert.strictEqual(message.cc, 'parent@example.com');
    assert.strictEqual(message.replyTo, 'office@example.com');
    assert.ok(message.html.includes('src="cid:basairLogo"'), 'the cid reference is untouched');
    assert.ok(message.html.includes('https://basaerbh.com/files/1AbC/view'), 'Drive links still rewritten');
    const inline = message.attachments.find((part) => part.cid === 'basairLogo');
    assert.ok(inline, 'the inline image is attached');
    assert.strictEqual(inline.contentDisposition, 'inline');
    assert.strictEqual(inline.contentType, 'image/png');
    assert.deepStrictEqual(Array.from(inline.content), PNG_HEADER);
    const pdf = message.attachments.find((part) => part.filename === 'card.pdf');
    assert.ok(pdf && !pdf.cid, 'the ordinary attachment has no cid');
    assert.strictEqual(storage.db.prepare('SELECT status FROM outbox ORDER BY id DESC LIMIT 1').get().status, 'sent');
  } finally {
    storage.close();
  }
});

test('in dry-run nothing is attached and nothing is sent, but the message is recorded', () => {
  const storage = new Storage(':memory:');
  try {
    const mailer = new Mailer({ storage, mode: 'dry-run', log: () => {} });
    const { GmailApp } = makeMailShims(mailer);
    GmailApp.sendEmail('x@example.com', 's', 'b', { htmlBody: '<img src="cid:basairLogo">', inlineImages: { basairLogo: fakeBlob('logo.png', 'image/png', PNG_HEADER) } });
    const row = storage.db.prepare('SELECT status, meta FROM outbox ORDER BY id DESC LIMIT 1').get();
    assert.strictEqual(row.status, 'dry-run');
    assert.deepStrictEqual(JSON.parse(row.meta).inlineImages, ['basairLogo']);
    assert.strictEqual(JSON.parse(row.meta)._attachments, undefined, 'bytes are never persisted');
  } finally {
    storage.close();
  }
});
