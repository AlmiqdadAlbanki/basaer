'use strict';

// Minimal synchronous ZIP reader/writer for OOXML packages (.docx/.pptx).
// JSZip only offers a Promise API, but DocumentApp/SlidesApp are synchronous
// in Apps Script and the gas code calls them inline, so the shims need a sync
// path. Scope is deliberately narrow: no zip64, no encryption, stored (0) and
// deflate (8) entries only — which is all Word, LibreOffice, Google Docs and
// the `docx` package ever emit for these files. Unchanged entries are copied
// through with their original compressed bytes, so rewriting a template that
// carries a large background image only recompresses the edited XML part.

const zlib = require('zlib');

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const UTF8_NAME_FLAG = 0x0800;

// zlib.crc32 exists from Node 20.15 / 22.2; keep a table fallback for older runtimes.
let crcTable = null;
function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let tableIndex = 0; tableIndex < 256; tableIndex++) {
      let value = tableIndex;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[tableIndex] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

class ZipArchive {
  constructor() {
    // name -> entry; Map keeps insertion order so [Content_Types].xml stays first.
    this._entries = new Map();
  }

  static read(zipBytes) {
    const archive = new ZipArchive();
    const searchStart = Math.max(0, zipBytes.length - 65557);
    let endOffset = -1;
    for (let offset = zipBytes.length - 22; offset >= searchStart; offset--) {
      if (zipBytes.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) { endOffset = offset; break; }
    }
    if (endOffset < 0) throw new Error('Not a ZIP/OOXML file (no end-of-central-directory record)');
    const entryCount = zipBytes.readUInt16LE(endOffset + 10);
    let cursor = zipBytes.readUInt32LE(endOffset + 16);
    for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
      if (zipBytes.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) throw new Error('Corrupt ZIP central directory');
      const flags = zipBytes.readUInt16LE(cursor + 8);
      const method = zipBytes.readUInt16LE(cursor + 10);
      const nameLength = zipBytes.readUInt16LE(cursor + 28);
      const extraLength = zipBytes.readUInt16LE(cursor + 30);
      const commentLength = zipBytes.readUInt16LE(cursor + 32);
      const localOffset = zipBytes.readUInt32LE(cursor + 42);
      const nameBytes = zipBytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = nameBytes.toString(flags & UTF8_NAME_FLAG ? 'utf8' : 'latin1');
      const compressedSize = zipBytes.readUInt32LE(cursor + 20);
      // Sizes and CRC come from the central directory: local headers may defer
      // them to a trailing data descriptor (flag bit 3).
      const localNameLength = zipBytes.readUInt16LE(localOffset + 26);
      const localExtraLength = zipBytes.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      archive._entries.set(name, {
        name,
        method,
        time: zipBytes.readUInt16LE(cursor + 12),
        day: zipBytes.readUInt16LE(cursor + 14),
        crc: zipBytes.readUInt32LE(cursor + 16),
        compressedSize,
        size: zipBytes.readUInt32LE(cursor + 24),
        compressedData: zipBytes.subarray(dataStart, dataStart + compressedSize),
        data: null,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return archive;
  }

  names() { return Array.from(this._entries.keys()); }

  has(name) { return this._entries.has(name); }

  // True once any entry was added or replaced since the archive was read.
  isModified() {
    for (const entry of this._entries.values()) if (entry.dirty) return true;
    return false;
  }

  // Uncompressed bytes of an entry, or null when absent.
  get(name) {
    const entry = this._entries.get(name);
    if (!entry) return null;
    if (!entry.data) {
      if (entry.method === 0) entry.data = Buffer.from(entry.compressedData);
      else if (entry.method === 8) entry.data = zlib.inflateRawSync(entry.compressedData);
      else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${name}`);
    }
    return entry.data;
  }

  getText(name) {
    const data = this.get(name);
    return data === null ? null : data.toString('utf8');
  }

  // Add or replace an entry; it is recompressed when the archive is written.
  set(name, content) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const existing = this._entries.get(name);
    const { time, day } = existing || dosDateTime(new Date());
    this._entries.set(name, { name, method: 8, time, day, crc: null, compressedSize: 0, size: data.length, compressedData: null, data, dirty: true });
  }

  toBuffer() {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const entry of this._entries.values()) {
      if (entry.dirty) {
        entry.compressedData = zlib.deflateRawSync(entry.data);
        entry.crc = crc32(entry.data);
        entry.compressedSize = entry.compressedData.length;
        entry.size = entry.data.length;
        entry.method = 8;
        entry.dirty = false;
      }
      const nameBytes = Buffer.from(entry.name, 'utf8');
      const flags = /[^\x20-\x7e]/.test(entry.name) ? UTF8_NAME_FLAG : 0;

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(flags, 6);
      localHeader.writeUInt16LE(entry.method, 8);
      localHeader.writeUInt16LE(entry.time, 10);
      localHeader.writeUInt16LE(entry.day, 12);
      localHeader.writeUInt32LE(entry.crc, 14);
      localHeader.writeUInt32LE(entry.compressedSize, 18);
      localHeader.writeUInt32LE(entry.size, 22);
      localHeader.writeUInt16LE(nameBytes.length, 26);
      localHeader.writeUInt16LE(0, 28);
      localParts.push(localHeader, nameBytes, entry.compressedData);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(flags, 8);
      centralHeader.writeUInt16LE(entry.method, 10);
      centralHeader.writeUInt16LE(entry.time, 12);
      centralHeader.writeUInt16LE(entry.day, 14);
      centralHeader.writeUInt32LE(entry.crc, 16);
      centralHeader.writeUInt32LE(entry.compressedSize, 20);
      centralHeader.writeUInt32LE(entry.size, 24);
      centralHeader.writeUInt16LE(nameBytes.length, 28);
      centralHeader.writeUInt32LE(offset, 42);
      centralParts.push(centralHeader, nameBytes);

      offset += 30 + nameBytes.length + entry.compressedSize;
    }
    const centralDirectory = Buffer.concat(centralParts);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
    endRecord.writeUInt16LE(this._entries.size, 8);
    endRecord.writeUInt16LE(this._entries.size, 10);
    endRecord.writeUInt32LE(centralDirectory.length, 12);
    endRecord.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralDirectory, endRecord]);
  }
}

module.exports = { ZipArchive, crc32 };
