'use strict';

// Student-work uploads. Replaces the old direct-to-Google-Drive client upload
// (which leaked the owner's OAuth token, SECURITY-FINDINGS #1): the browser now
// posts the file here and it is stored through the same Drive shim that server
// code uses, so the record is identical to any other file the app creates.

const { Blob } = require('./shims/utilities.js');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'scr', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'jar',
  'sh', 'bash', 'apk', 'app', 'dmg', 'pif', 'hta', 'lnk', 'reg', 'html', 'htm', 'svg',
]);

function hasExecutableSignature(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true; // MZ (PE)
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true; // ELF
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true; // #! script
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0xcafebabe) return true; // Java class / Mach-O fat
  return false;
}

function isBlockedUpload(originalName, bytes) {
  const match = /\.([^.\\/]+)$/.exec(String(originalName || ''));
  if (match && BLOCKED_EXTENSIONS.has(match[1].toLowerCase())) return true;
  return hasExecutableSignature(bytes);
}

function cleanFileName(rawName) {
  const cleaned = String(rawName || '').replace(/[\\/\0\r\n]/g, '_').trim().slice(0, 200);
  return cleaned || 'upload';
}

// The content type stored for an upload is decided here from the file name,
// never taken from the request: a browser-supplied "text/html" on a file
// called homework.pdf would otherwise be served back as HTML on the app's own
// origin, with the viewer's session (stored XSS). Unknown extensions become
// octet-stream, which browsers only download.
const MIME_BY_EXTENSION = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', csv: 'text/csv',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', zip: 'application/zip',
};
function mimeFromFileName(fileName) {
  const match = /\.([^.\\/]+)$/.exec(String(fileName || ''));
  return (match && MIME_BY_EXTENSION[match[1].toLowerCase()]) || 'application/octet-stream';
}

// Stores the bytes in folderId, makes the file public-by-link (as issued files
// are) and returns { id, name, url }. Throws Error with .status for bad input.
// `driveShims` is the { DriveApp, Drive } pair from shims/drive.js. The
// request's own content type is deliberately not a parameter.
function storeStudentWork(driveShims, { folderId, fileName, bytes, originalName }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw Object.assign(new Error('empty file'), { status: 400 });
  if (bytes.length > MAX_UPLOAD_BYTES) throw Object.assign(new Error('file too large'), { status: 413 });
  if (isBlockedUpload(originalName || fileName, bytes)) throw Object.assign(new Error('file type not allowed'), { status: 415 });
  const { DriveApp, Drive } = driveShims;
  let folder;
  try {
    folder = DriveApp.getFolderById(String(folderId || ''));
  } catch (_) {
    throw Object.assign(new Error('folder not found'), { status: 404 });
  }
  const storedName = cleanFileName(fileName);
  const blob = new Blob(bytes, mimeFromFileName(originalName || storedName), storedName);
  const file = folder.createFile(blob);
  Drive.Permissions.create({ role: 'reader', type: 'anyone' }, file.getId());
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

// Extracts a folder id from a stored folder URL: local (/files/folder/<id>),
// legacy Google (.../folders/<id>[?...]) or a bare id.
function folderIdFromUrl(folderUrl) {
  const text = String(folderUrl || '').trim();
  const match = /\/(?:files\/folder|folders)\/([-\w]+)/.exec(text);
  if (match) return match[1];
  return /^[-\w]+$/.test(text) ? text : '';
}

function isOwnFolder(folderUrl, postedFolderId) {
  const ownId = folderIdFromUrl(folderUrl);
  return ownId !== '' && ownId === String(postedFolderId || '');
}

module.exports = { folderIdFromUrl, isOwnFolder, storeStudentWork, isBlockedUpload, mimeFromFileName, MAX_UPLOAD_BYTES };
