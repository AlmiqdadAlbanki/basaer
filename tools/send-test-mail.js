'use strict';

// Sends one test e-mail with the SMTP settings the server would use in live mode, so the
// settings can be proven before OUTBOUND_MODE is switched to live.
//
//   node tools/send-test-mail.js --to you@example.com [--env /etc/basaer.env]
//
// The settings come from the environment, or from the env file named with --env (the same
// SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS and MAIL_FROM lines the server reads;
// the file is parsed here because it is not valid shell). The transport is built exactly as
// server/worker.js builds it. Nothing else is touched: no database, no queue.

const fs = require('fs');

function parseArguments(argumentList) {
  const options = {};
  for (let index = 0; index < argumentList.length; index++) {
    const flag = argumentList[index];
    if (!flag.startsWith('--')) throw new Error('Unexpected argument: ' + flag);
    options[flag.slice(2)] = argumentList[++index];
  }
  return options;
}

// KEY=value lines; blank lines and # comments skipped; the value is everything after the first "=".
function readEnvFile(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.to) {
    console.error('Usage: node tools/send-test-mail.js --to you@example.com [--env /etc/basaer.env]');
    process.exit(2);
  }
  const settings = Object.assign({}, options.env ? readEnvFile(options.env) : {}, process.env);
  if (!settings.SMTP_HOST) throw new Error('SMTP_HOST is not set (fill in the SMTP block first)');

  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: settings.SMTP_HOST,
    port: parseInt(settings.SMTP_PORT, 10) || 587,
    secure: String(settings.SMTP_SECURE).toLowerCase() === 'true',
    auth: settings.SMTP_USER ? { user: settings.SMTP_USER, pass: settings.SMTP_PASS } : undefined,
  });
  console.log(`connecting to ${settings.SMTP_HOST}:${settings.SMTP_PORT || 587} as ${settings.SMTP_USER || '(no login)'} ...`);
  await transport.verify();
  console.log('login accepted; sending ...');
  const info = await transport.sendMail({
    from: settings.MAIL_FROM || settings.SMTP_USER,
    to: options.to,
    subject: 'Basaer: test message — رسالة تجريبية',
    text: 'If you can read this, the server can send e-mail.\nإذا وصلتك هذه الرسالة فالخادم قادر على إرسال البريد.',
  });
  console.log('sent:', info.messageId, info.response || '');
}

main().catch((error) => {
  console.error('send failed: ' + (error && error.message ? error.message : error));
  process.exit(1);
});
