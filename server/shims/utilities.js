'use strict';

// Utilities shim. Verified methods in use: formatDate, getUuid, base64Decode,
// base64Encode, base64EncodeWebSafe, newBlob, sleep, computeRsaSha256Signature,
// and the Charset enum. formatDate is the widely-used one and must honour the
// Java SimpleDateFormat tokens the code passes with a named time zone.

const crypto = require('crypto');

// Build date parts in a target IANA time zone.
function partsInZone(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'long',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  // Intl may emit hour '24' at midnight for hour12:false; normalise to 00.
  if (p.hour === '24') p.hour = '00';
  return p;
}

const WEEKDAY_SHORT = { Sunday: 'Sun', Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu', Friday: 'Fri', Saturday: 'Sat' };
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(date, tz, pattern) {
  if (!(date instanceof Date)) date = new Date(date);
  const p = partsInZone(date, tz || 'Asia/Qatar');
  const yyyy = p.year;
  const MM = p.month;
  const dd = p.day;
  const HH = p.hour;
  const mm = p.minute;
  const ss = p.second;
  const monthNum = parseInt(MM, 10);
  const dayNum = parseInt(dd, 10);
  const hourNum = parseInt(HH, 10);
  const minNum = parseInt(mm, 10);
  const secNum = parseInt(ss, 10);

  // Replace longest tokens first. Order matters: yyyy before yy, EEEE before EEE, etc.
  const tokens = [
    ['yyyy', yyyy],
    ['yy', yyyy.slice(-2)],
    ['MMMM', MONTH_LONG[monthNum - 1]],
    ['MMM', MONTH_LONG[monthNum - 1].slice(0, 3)],
    ['MM', MM],
    ['M', String(monthNum)],
    ['dd', dd],
    ['d', String(dayNum)],
    ['HH', HH],
    ['H', String(hourNum)],
    ['hh', String(((hourNum + 11) % 12) + 1).padStart(2, '0')],
    ['h', String(((hourNum + 11) % 12) + 1)],
    ['mm', mm],
    ['m', String(minNum)],
    ['ss', ss],
    ['s', String(secNum)],
    ['EEEE', p.weekday],
    ['EEE', WEEKDAY_SHORT[p.weekday] || p.weekday.slice(0, 3)],
    ['a', hourNum < 12 ? 'AM' : 'PM'],
  ];
  // Tokenise so literal characters are not themselves rewritten.
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    let matched = false;
    for (const [tok, val] of tokens) {
      if (pattern.startsWith(tok, i)) { out += val; i += tok.length; matched = true; break; }
    }
    if (!matched) { out += pattern[i]; i += 1; }
  }
  return out;
}

const Charset = { UTF_8: 'UTF-8', US_ASCII: 'US-ASCII' };

class Blob {
  constructor(bytes, contentType, name) {
    this._bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    this._contentType = contentType || 'application/octet-stream';
    this._name = name || '';
  }
  getBytes() { return Array.from(this._bytes); }
  getDataAsString(charset) { return this._bytes.toString(charset === 'US-ASCII' ? 'ascii' : 'utf8'); }
  setDataFromString(s, charset) { this._bytes = Buffer.from(s, charset === 'US-ASCII' ? 'ascii' : 'utf8'); return this; }
  getContentType() { return this._contentType; }
  setContentType(t) { this._contentType = t; return this; }
  getName() { return this._name; }
  setName(n) { this._name = n; return this; }
  getAs(type) { return new Blob(this._bytes, type, this._name); }
  copyBlob() { return new Blob(Buffer.from(this._bytes), this._contentType, this._name); }
  _buffer() { return this._bytes; }
}

function toBuffer(data, charset) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.from(data);
  return Buffer.from(String(data), charset === 'US-ASCII' ? 'ascii' : 'utf8');
}

const Utilities = {
  formatDate,
  Charset,

  getUuid() { return crypto.randomUUID(); },

  base64Encode(data, charset) { return toBuffer(data, charset).toString('base64'); },
  base64EncodeWebSafe(data, charset) {
    return toBuffer(data, charset).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  },
  base64Decode(data /*, charset */) {
    return Array.from(Buffer.from(String(data), 'base64'));
  },
  base64DecodeWebSafe(data) {
    return Array.from(Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  },

  newBlob(data, contentType, name) {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuffer(data);
    return new Blob(buf, contentType, name);
  },

  // Deliberately a no-op: a synchronous sleep in a request handler would block
  // the process. The only live callers are the queue tick pacers, which the
  // trigger scheduler handles with real delays in phase 4; the rest are in
  // dead PDF code.
  sleep() {},

  computeRsaSha256Signature(data, privateKeyPem) {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(typeof data === 'string' ? data : Buffer.from(data));
    sign.end();
    return Array.from(sign.sign(privateKeyPem));
  },

  computeHmacSha256Signature(value, key) {
    const h = crypto.createHmac('sha256', Buffer.isBuffer(key) ? key : Buffer.from(key));
    h.update(typeof value === 'string' ? value : Buffer.from(value));
    return Array.from(h.digest());
  },

  computeDigest(_algorithm, value, charset) {
    return Array.from(crypto.createHash('sha256').update(toBuffer(value, charset)).digest());
  },
};

module.exports = { Utilities, Blob };
