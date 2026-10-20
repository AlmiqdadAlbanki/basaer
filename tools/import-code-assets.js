'use strict';

// Registers the images the legacy pages reference by Google Drive id (logo,
// default avatar, carousel pictures — see server/page-rewrites.js) in the
// local file store, so /thumb?id=<id> serves them.
//
//   node tools/import-code-assets.js --list [--dir data/google-exports/code-assets]
//   node tools/import-code-assets.js [--dir data/google-exports/code-assets] [--db <path>] [--files-dir <dir>] [--dry-run]
//
// `--list` scans gas/*.html and gas/*.js for Drive ids, writes `<dir>/ids.tsv`
// (id <TAB> the gas files using it) and prints the thumbnail URL of each id to
// save from a browser (those files belong to the admin's account, so the API
// cannot fetch them for us). The directory then holds one file per id, named
// exactly <id> (no extension). The content type is sniffed from the bytes,
// never guessed from a name. Files are public, like the "anyone with the link"
// originals.

const fs = require('fs');
const path = require('path');
const { Storage } = require('../server/storage.js');
const { DEFAULT_DB, parseArgs } = require('./xlsx-common.js');

const ID_RE = /^[A-Za-z0-9_-]{20,}$/;
const GAS_DIR = path.join(__dirname, '..', 'gas');
// Dead or editor-only gas files whose ids are not served by any page.
const GAS_FILES_TO_SKIP = /^(test|debug|driveMigration|FCMSetup)/;

// id -> Set of gas files that reference it, for every Drive id written into the pages.
function harvestIdsFromGas(gasDir) {
  const idsByFile = new Map();
  for (const file of fs.readdirSync(gasDir)) {
    if (!/\.(html|js)$/.test(file) || GAS_FILES_TO_SKIP.test(file)) continue;
    const text = fs.readFileSync(path.join(gasDir, file), 'utf8');
    for (const re of [/[?&;]id=([-\w]{25,})/g, /file\/d\/([-\w]{25,})/g, /folders\/([-\w]{25,})/g]) {
      let match;
      while ((match = re.exec(text))) {
        if (!idsByFile.has(match[1])) idsByFile.set(match[1], new Set());
        idsByFile.get(match[1]).add(file);
      }
    }
  }
  return idsByFile;
}

function writeIdsListing(dir, idsByFile) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = [...idsByFile].map(([id, files]) => id + '\t' + [...files].sort().join(','));
  fs.writeFileSync(path.join(dir, 'ids.tsv'), lines.join('\n') + '\n');
}

// Image/PDF type from the leading bytes; null for anything else (an HTML
// error page saved by mistake must not be registered as an image).
function sniffMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const EXTENSION_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function importCodeAssets({ storage, filesDir, dir, dryRun, log }) {
  const counts = { registered: 0, skipped: 0 };
  fs.mkdirSync(filesDir, { recursive: true });
  const upsert = storage.db.prepare(`
    INSERT OR REPLACE INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at)
    VALUES (@id, @name, @mime, @size, NULL, 0, 1, 0, @now, @now)
  `);
  for (const entry of fs.readdirSync(dir)) {
    if (!ID_RE.test(entry)) continue;
    const sourcePath = path.join(dir, entry);
    if (!fs.statSync(sourcePath).isFile()) continue;
    const bytes = fs.readFileSync(sourcePath);
    const mime = sniffMime(bytes);
    if (!mime) { log(`skip  ${entry}: not an image or PDF (${bytes.length} bytes)`); counts.skipped++; continue; }
    const name = `${entry}.${EXTENSION_BY_MIME[mime]}`;
    log(`${dryRun ? 'would register' : 'register'} ${entry} as ${mime} (${bytes.length} bytes)`);
    if (!dryRun) {
      fs.copyFileSync(sourcePath, path.join(filesDir, entry));
      const now = new Date().toISOString();
      upsert.run({ id: entry, name, mime, size: bytes.length, now });
    }
    counts.registered++;
  }
  return counts;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const listOnly = process.argv.includes('--list');
  const args = parseArgs(process.argv.slice(2).filter((a) => a !== '--dry-run' && a !== '--list'));
  const dir = path.resolve(args.dir || path.join(__dirname, '..', 'data', 'google-exports', 'code-assets'));
  if (listOnly) {
    const idsByFile = harvestIdsFromGas(GAS_DIR);
    writeIdsListing(dir, idsByFile);
    console.log(`${idsByFile.size} id(s) referenced by the pages -> ${path.join(dir, 'ids.tsv')}`);
    for (const [id, files] of idsByFile) {
      const have = fs.existsSync(path.join(dir, id)) ? 'have   ' : 'missing';
      console.log(`  ${have}  ${id}  https://drive.google.com/thumbnail?id=${id}&sz=w2000   (${[...files].sort().join(', ')})`);
    }
    return;
  }
  const filesDir = path.resolve(args['files-dir'] || process.env.BASAER_FILES || path.join(__dirname, '..', 'data', 'files'));
  const dbPath = path.resolve(args.db || process.env.BASAER_DB || DEFAULT_DB);
  if (!dryRun && !fs.existsSync(dbPath)) { console.error('database not found: ' + dbPath); process.exit(2); }
  const storage = new Storage(dryRun ? ':memory:' : dbPath);
  try {
    const counts = importCodeAssets({ storage, filesDir, dir, dryRun, log: console.log });
    console.log(`${dryRun ? 'Dry run: ' : ''}registered ${counts.registered}, skipped ${counts.skipped}`);
  } finally {
    storage.close();
  }
}

if (require.main === module) main();

module.exports = { importCodeAssets, sniffMime, harvestIdsFromGas, writeIdsListing };
