'use strict';

// Lists every Google Drive/Docs file or folder id the data refers to: ids inside
// links in any sheet cell, plus the ids the pages reference directly (the
// code-assets list written by the harvesting step). The output feeds
// tools/import-drive-tree.js --only-ids, so that only the files the app can
// actually reach are imported from the Drive trees — never whole trees.
//
//   node tools/list-referenced-ids.js --out /tmp/referenced-ids.json [--db <path>] [--code-assets <dir>]

const fs = require('fs');
const path = require('path');
const { Storage } = require('../server/storage.js');
const { DEFAULT_DB, parseArgs } = require('./xlsx-common.js');

// Google ids inside the link shapes the sheets use (file/d, folders, docs,
// thumbnail?id=, uc?id=, open?id=).
const LINK_ID_RE = /(?:\/(?:file\/d|folders|document\/d|spreadsheets\/d|presentation\/d)\/|[?&;]id=)([-\w]{20,})/g;

function referencedIdsFromSheets(storage) {
  const ids = new Set();
  for (const { ss, name } of storage.db.prepare('SELECT ss, name FROM sheets').all()) {
    for (const row of storage.loadGrid(ss, name)) {
      for (const cell of row || []) {
        if (typeof cell !== 'string' || cell.indexOf('google.com') < 0) continue;
        let match;
        LINK_ID_RE.lastIndex = 0;
        while ((match = LINK_ID_RE.exec(cell))) ids.add(match[1]);
      }
    }
  }
  return ids;
}

// ids.tsv: "<id>\t<gas files using it>" per line (see tools/import-code-assets.js).
function referencedIdsFromCodeAssets(codeAssetsDir) {
  const ids = new Set();
  const listing = path.join(codeAssetsDir, 'ids.tsv');
  if (!fs.existsSync(listing)) return ids;
  for (const line of fs.readFileSync(listing, 'utf8').split('\n')) {
    const id = line.split('\t')[0].trim();
    if (id) ids.add(id);
  }
  return ids;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) { console.error('usage: node tools/list-referenced-ids.js --out <ids.json> [--db <path>] [--code-assets <dir>]'); process.exit(2); }
  const storage = new Storage(path.resolve(args.db || process.env.BASAER_DB || DEFAULT_DB));
  try {
    const fromSheets = referencedIdsFromSheets(storage);
    const fromCode = referencedIdsFromCodeAssets(path.resolve(args['code-assets'] || path.join(__dirname, '..', 'data', 'google-exports', 'code-assets')));
    const all = new Set([...fromSheets, ...fromCode]);
    fs.writeFileSync(args.out, JSON.stringify([...all]));
    console.log(`referenced ids: ${all.size} (${fromSheets.size} from sheet links, ${fromCode.size} from the pages) -> ${args.out}`);
  } finally {
    storage.close();
  }
}

if (require.main === module) main();

module.exports = { referencedIdsFromSheets, referencedIdsFromCodeAssets, LINK_ID_RE };
