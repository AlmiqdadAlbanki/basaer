'use strict';

// Email shims: GmailApp.sendEmail, MailApp (quota only), and the Gmail advanced
// service's Users.Messages.send({raw}). Every message goes into the `outbox`
// table. In dry-run mode (the default) nothing leaves the machine; the message
// is recorded and echoed to the server log, so OTP codes can be read while
// testing. In live mode the Mailer delivers through SMTP (nodemailer) when
// configured.

const { rewriteLegacyDriveUrlsAbsolute } = require('../page-rewrites.js');

function decodeRawMime(rawB64Url) {
  try {
    const raw = Buffer.from(String(rawB64Url).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const headerPart = raw.split(/\r?\n\r?\n/)[0] || '';
    const get = (h) => {
      const m = new RegExp('^' + h + ':\\s*(.*)$', 'im').exec(headerPart);
      return m ? m[1].trim() : '';
    };
    return { to: get('To'), subject: get('Subject'), raw };
  } catch (_) {
    return { to: '', subject: '', raw: String(rawB64Url) };
  }
}

// The bytes of a gas Blob (a Drive/UrlFetch blob keeps a Buffer; others expose getBytes()).
function blobBuffer(b) {
  return b._buffer ? b._buffer() : Buffer.from(b.getBytes());
}

function blobMeta(b) {
  try {
    return { name: b.getName ? b.getName() : '', type: b.getContentType ? b.getContentType() : '', bytes: b._buffer ? b._buffer().length : (b.getBytes ? b.getBytes().length : 0) };
  } catch (_) { return {}; }
}

class Mailer {
  constructor({ storage, mode, log, transport, from, baseUrl }) {
    this.storage = storage;
    this.mode = mode || 'dry-run';
    this.log = log || ((...a) => console.log('[mail]', ...a));
    this.transport = transport || null; // nodemailer transport in live mode
    this.from = from || 'no-reply@localhost';
    // Where this server is reachable from outside: the legacy code writes Drive links (the
    // logo, files) into message bodies, and a mail client cannot follow a relative path.
    this.baseUrl = baseUrl || '';
  }

  // Record and (in live mode) deliver. Returns the outbox id.
  send({ to, subject, text, html, meta }) {
    if (this.baseUrl) {
      if (html) html = rewriteLegacyDriveUrlsAbsolute(html, this.baseUrl);
      if (text) text = rewriteLegacyDriveUrlsAbsolute(text, this.baseUrl);
    }
    const status = this.mode === 'live' ? 'queued' : 'dry-run';
    const info = this.storage.db
      .prepare('INSERT INTO outbox (created_at, to_addr, subject, body_text, body_html, meta, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), to || '', subject || '', text || '', html || '', JSON.stringify(meta || {}), status);
    const id = info.lastInsertRowid;

    if (this.mode !== 'live') {
      const snippet = (text || '').replace(/\s+/g, ' ').slice(0, 160);
      this.log(`DRY-RUN #${id} to=${to} subject="${subject}" | ${snippet}`);
      return id;
    }

    if (!this.transport) {
      this.storage.db.prepare('UPDATE outbox SET status = ?, error = ? WHERE id = ?')
        .run('failed', 'live mode but no SMTP transport configured', id);
      this.log(`FAILED #${id}: live mode but no SMTP transport configured`);
      return id;
    }
    // Deliver asynchronously; the synchronous gas caller does not wait.
    const headers = meta || {};
    this.transport.sendMail({
      from: this.from, to, subject, text, html,
      cc: headers.cc || undefined, bcc: headers.bcc || undefined, replyTo: headers.replyTo || undefined,
      attachments: headers._attachments || [],
    })
      .then(() => this.storage.db.prepare('UPDATE outbox SET status = ? WHERE id = ?').run('sent', id))
      .catch((err) => {
        this.storage.db.prepare('UPDATE outbox SET status = ?, error = ? WHERE id = ?').run('failed', String(err && err.message || err), id);
        this.log(`FAILED #${id}: ${err && err.message}`);
      });
    return id;
  }
}

function makeMailShims(mailer) {
  const GmailApp = {
    sendEmail(recipient, subject, body, options) {
      options = options || {};
      const meta = {
        name: options.name || '',
        cc: options.cc || '', bcc: options.bcc || '', replyTo: options.replyTo || '',
        inlineImages: Object.keys(options.inlineImages || {}),
        attachments: (options.attachments || []).map(blobMeta),
      };
      // Carry attachment bytes for live delivery (not persisted in the outbox). Inline
      // images are attachments too, referenced from the HTML as <img src="cid:<key>">:
      // the legacy code sends the logo in every message that way (inlineImages:
      // { basairLogo: blob }), so without this part the message shows a broken image.
      if (mailer.mode === 'live') {
        const parts = (options.attachments || []).map((b) => ({
          filename: b.getName ? b.getName() : 'attachment',
          content: blobBuffer(b),
          contentType: b.getContentType ? b.getContentType() : undefined,
        }));
        for (const [contentId, b] of Object.entries(options.inlineImages || {})) {
          parts.push({
            filename: (b.getName && b.getName()) || contentId,
            content: blobBuffer(b),
            contentType: b.getContentType ? b.getContentType() : undefined,
            cid: contentId,
            contentDisposition: 'inline',
          });
        }
        if (parts.length) meta._attachments = parts;
      }
      mailer.send({ to: recipient, subject, text: body, html: options.htmlBody || '', meta });
      return GmailApp;
    },
    // Only used by dead bounce/quota-check code; return nothing found.
    search: () => [],
    getRemainingDailyQuota: () => 1500,
    getUserLabelByName: () => null,
  };

  const MailApp = {
    sendEmail: (...args) => GmailApp.sendEmail(...args),
    getRemainingDailyQuota: () => 1500,
  };

  // Gmail advanced service: Gmail.Users.Messages.send({ raw }, 'me')
  const Gmail = {
    Users: {
      Messages: {
        send(resource /*, userId */) {
          const d = decodeRawMime(resource && resource.raw);
          mailer.send({ to: d.to, subject: d.subject, text: '(raw MIME message)', html: '', meta: { rawMime: true, rawLength: d.raw.length } });
          return { id: 'local-' + Date.now(), labelIds: ['SENT'] };
        },
      },
    },
    newMessage: () => ({}),
  };

  return { GmailApp, MailApp, Gmail };
}

module.exports = { Mailer, makeMailShims };
