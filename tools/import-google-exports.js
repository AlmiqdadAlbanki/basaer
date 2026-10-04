'use strict';

// Date cells in the exports are local Bahrain time; xlsx turns them into JS Dates
// using the process time zone, so it must be fixed before any Date is created.
process.env.TZ = 'Asia/Qatar';

// Loads everything tools/google-exports.sh pulled into the local database and
// file store:
//   1. the six spreadsheets (.xlsx) via importDir
//   2. doc/slides templates, registered under their legacy Google ids
//   3. Drive folders, recreated with their ORIGINAL Google folder and file ids so
//      links stored in the sheets (.../folders/<id>, .../file/d/<id>) still resolve
//   4. a header check against what the server code expects
//
//   TZ=Asia/Qatar node tools/import-google-exports.js [--dir data/google-exports] [--db <path>] [--files-dir <dir>]

const fs = require('fs');
const path = require('path');
const { Storage } = require('../server/storage.js');
const { importDir } = require('./import-xlsx.js');
const { registerTemplate } = require('./register-template.js');
const { runCheck } = require('./check-headers.js');
const { DEFAULT_DB, parseArgs } = require('./xlsx-common.js');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
const manifestPath = path.join(__dirname, 'google-files.json');

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// Extension the pull script exported each template kind to.
const templateExtensions = { doc: 'docx', slides: 'pptx' };

function importTemplates({ storage, filesDir, dir, manifest, log }) {
  let count = 0;
  for (const entry of manifest.filter((e) => templateExtensions[e.kind])) {
    const fileName = entry.name + '.' + templateExtensions[entry.kind];
    const file = path.join(dir, fileName);
    if (!fs.existsSync(file)) {
      log('WARN  template ' + entry.name + ': ' + file + ' not found, skipped');
      continue;
    }
    // registerTemplate replaces an existing record with the same id.
    registerTemplate({ storage, filesDir, id: entry.registerAs || entry.id, fileName, buffer: fs.readFileSync(file) });
    count++;
  }
  return count;
}

// Rows are written straight into the files table (registerFile cannot set
// is_folder / is_public). Everything is public because the Drive files were
// anyone-with-link and the sheets hold bare links to them.
function upsertFileRow(storage, row) {
  const now = new Date().toISOString();
  storage.db.prepare(`
    INSERT OR REPLACE INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at)
    VALUES (@id, @name, @mime, @size, @parent_id, @is_folder, 1, 0, @now, @now)
  `).run({ ...row, now });
}

// listing = parsed `rclone lsjson -R` output; sourceDir = the folder rclone copied
// into. Returns { folders, files, missing } counts.
function importFolderListing({ storage, filesDir, rootId, rootName, listing, sourceDir, log = () => {} }) {
  const counts = { folders: 0, files: 0, missing: 0 };
  upsertFileRow(storage, { id: rootId, name: rootName, mime: FOLDER_MIME, size: 0, parent_id: null, is_folder: 1 });
  counts.folders++;

  const folderIdByPath = new Map();
  // Parents first: a shallow path always sorts before its children by depth.
  const entries = listing.slice().sort((a, b) => a.Path.split('/').length - b.Path.split('/').length);
  fs.mkdirSync(filesDir, { recursive: true });

  for (const entry of entries) {
    const parentPath = path.posix.dirname(entry.Path);
    const parentId = parentPath === '.' ? rootId : (folderIdByPath.get(parentPath) || rootId);
    if (entry.IsDir) {
      folderIdByPath.set(entry.Path, entry.ID);
      upsertFileRow(storage, { id: entry.ID, name: entry.Name, mime: FOLDER_MIME, size: 0, parent_id: parentId, is_folder: 1 });
      counts.folders++;
      continue;
    }
    // Google-native files were exported as PDF; rclone names them <name>.pdf, but
    // the listing may or may not already show that suffix, so try both.
    const isNative = String(entry.MimeType || '').startsWith(GOOGLE_NATIVE_PREFIX);
    const candidates = isNative ? [entry.Path, entry.Path + '.pdf'] : [entry.Path];
    const source = candidates.map((p) => path.join(sourceDir, p)).find((p) => fs.existsSync(p));
    if (!source) {
      log('WARN  file bytes missing for ' + entry.Path + ' (' + entry.ID + '), skipped');
      counts.missing++;
      continue;
    }
    const buffer = fs.readFileSync(source);
    fs.writeFileSync(path.join(filesDir, entry.ID), buffer);
    const name = isNative && !/\.pdf$/i.test(entry.Name) ? entry.Name + '.pdf' : entry.Name;
    const mime = isNative ? 'application/pdf' : (entry.MimeType || 'application/octet-stream');
    upsertFileRow(storage, { id: entry.ID, name, mime, size: buffer.length, parent_id: parentId, is_folder: 0 });
    counts.files++;
  }
  return counts;
}

function importFolders({ storage, filesDir, dir, manifest, log }) {
  const total = { folders: 0, files: 0, missing: 0 };
  for (const entry of manifest.filter((e) => e.kind === 'folder')) {
    const listingFile = path.join(dir, 'folders', entry.name + '.lsjson');
    if (!fs.existsSync(listingFile)) {
      log('WARN  folder ' + entry.name + ': no listing, skipped');
      continue;
    }
    const counts = importFolderListing({
      storage,
      filesDir,
      rootId: entry.id,
      rootName: entry.name,
      listing: JSON.parse(fs.readFileSync(listingFile, 'utf8')),
      sourceDir: path.join(dir, 'folders', entry.name),
      log,
    });
    log(entry.name + ': ' + counts.folders + ' folder(s), ' + counts.files + ' file(s)');
    total.folders += counts.folders;
    total.files += counts.files;
    total.missing += counts.missing;
  }
  return total;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(args.dir || path.join(__dirname, '..', 'data', 'google-exports'));
  const filesDir = path.resolve(args['files-dir'] || process.env.BASAER_FILES || path.join(__dirname, '..', 'data', 'files'));
  const storage = new Storage(path.resolve(args.db || process.env.BASAER_DB || DEFAULT_DB));
  try {
    const manifest = readManifest();
    const sheets = importDir(storage, dir);
    const templates = importTemplates({ storage, filesDir, dir, manifest, log: console.log });
    const folders = importFolders({ storage, filesDir, dir, manifest, log: console.log });
    console.log('Imported ' + sheets + ' sheet(s), ' + templates + ' template(s), ' + folders.folders + ' folder(s), ' + folders.files + ' file(s)');
    runCheck(storage);
    // The grid cache may hold pre-import copies.
    storage.invalidate();
  } finally {
    storage.close();
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('import failed: ' + (e && e.stack || e)); process.exit(1); }
}

module.exports = { importFolderListing, importFolders, importTemplates, readManifest };
