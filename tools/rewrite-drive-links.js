'use strict';

// Points the Google Drive links stored in the spreadsheets at the local file store, once the
// files themselves exist there under their original Google ids (tools/import-drive-tree.js,
// tools/import-google-exports.js).
//
//   node tools/rewrite-drive-links.js --base-url https://app.example.com [--db <path>]
//                                     [--rebase-from https://old.example.com] [--dry-run] [--report <path.json>]
//
//   --base-url     where the app is served (a trailing slash is fine)
//   --rebase-from  the address the app was served from before: every link that starts with
//                  it (links this tool wrote earlier, and links the app itself wrote while it
//                  ran there — certificates, cards, uploads) is re-pointed at --base-url. Use
//                  it when the domain changes, e.g. from a test domain to the final one.
//   --dry-run      changes nothing in the database; prints and reports the same totals
//   --report       also writes the totals and the findings below as JSON (with --dry-run too)
//
// Every cell of every sheet of every spreadsheet in IDS is scanned. A Google link whose id is a
// row of the `files` table is replaced. A cell may hold several links, or a link inside prose:
// every occurrence is replaced and the text around it is kept. The links understood:
//
//   file     drive.google.com/file/d/<id>/...   open?id=<id>   uc?...id=<id>...   thumbnail?id=<id>&sz=...
//            docs.google.com/(document|spreadsheets|presentation)/d/<id>/...   (exported copies)
//            -> <base>/files/<id>/<encoded name>
//   folder   drive.google.com/drive/folders/<id>[?...]   drive/u/<n>/folders/<id>
//            -> <base>/files/folder/<id>
//
// The `files` record decides which of the two URLs a link becomes, not the shape of the Google
// link: the old open?id=<id> form was used for folders too and ends up as a folder URL.
//
// A link whose id is NOT in `files` is left exactly as it is and counted per spreadsheet, sheet
// and column (the header in row 1), so the report shows what still points at Google:
//   unresolved    { spreadsheet, sheet, column, count, sampleIds }   a recognised link, id not local
//   unrecognized  { spreadsheet, sheet, column, count, samples }     a drive/docs.google.com URL of
//                                                                    another shape, no id to look up
//
// Only string cells are touched: numbers, booleans, Dates and blanks stay exactly as they were.
// A row is written back (one putRows call per run of consecutive rows) only when a link in it
// changed, and running the tool twice is harmless since rewritten cells hold no Google link.
// Rows are read, then written back whole: a cell the live app edits in between is overwritten,
// so run it while nobody is editing.

const fs = require('fs');
const path = require('path');
const { parseArgs: parseCommandLine } = require('util');
const { Storage } = require('../server/storage.js');
const { IDS, DEFAULT_DB } = require('./xlsx-common.js');

// A candidate Google URL: the host, then URL-safe ASCII characters. It stops at whitespace, a
// quote, a bracket, any non-ASCII text (Arabic prose right after a link) and at the start of
// another URL (two links glued together with a comma).
const GOOGLE_URL_PATTERN = /https?:\/\/(?:drive|docs)\.google\.com\/(?:(?!https?:\/\/)[A-Za-z0-9._~%!$&*+,;=:@/?#-])*/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
const DRIVE_FILE_PATH_PATTERN = /^https?:\/\/drive\.google\.com\/file\/(?:u\/\d+\/)?d\/([\w-]+)/;
const DRIVE_FOLDER_PATH_PATTERN = /^https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/;
const DOCS_PATH_PATTERN = /^https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/(?:u\/\d+\/)?d\/(?:e\/)?([\w-]+)/;
const DRIVE_QUERY_PATTERN = /^https?:\/\/drive\.google\.com\/(?:u\/\d+\/)?(?:open|uc|thumbnail)\?([^#]*)/;
const SAMPLE_LIMIT = 5;

const USAGE = 'Usage: node tools/rewrite-drive-links.js --base-url https://app.example.com [--db <path>] [--rebase-from https://old.example.com] [--dry-run] [--report <path.json>]';

// The Google id inside a Drive/Docs URL, or null when the URL has none we recognise.
function googleIdOfUrl_(url) {
  for (const pathPattern of [DRIVE_FILE_PATH_PATTERN, DRIVE_FOLDER_PATH_PATTERN, DOCS_PATH_PATTERN]) {
    const match = pathPattern.exec(url);
    if (match) return match[1];
  }
  const queryMatch = DRIVE_QUERY_PATTERN.exec(url);
  if (queryMatch) {
    // "&amp;" shows up where a link was copied out of HTML.
    const id = new URLSearchParams(queryMatch[1].replace(/&amp;/g, '&')).get('id');
    if (id && /^[\w-]+$/.test(id)) return id;
  }
  return null;
}

// The same URLs the Drive shim hands out (server/shims/drive.js fileUrl / folderUrl).
function localUrlFor_(record, baseUrl) {
  return record.is_folder
    ? `${baseUrl}/files/folder/${record.id}`
    : `${baseUrl}/files/${record.id}/${encodeURIComponent(record.name)}`;
}

function normalizeBaseUrl_(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(trimmed)) {
    throw new Error('--base-url must look like https://app.example.com (got "' + baseUrl + '")');
  }
  return trimmed;
}

// Replaces every resolvable Google link in one string, and — with rebaseFrom, the app's
// previous address without trailing slash — re-points every link starting with that address
// at baseUrl. filesById maps an id to a files-table record ({ id, name, is_folder }); baseUrl
// has no trailing slash. Returns the new text and what was seen:
// { text, rewritten, rebased, unresolvedIds, unrecognizedUrls }.
function rewriteLinksInText(text, { filesById, baseUrl, rebaseFrom = null }) {
  const outcome = { text, rewritten: 0, rebased: 0, unresolvedIds: [], unrecognizedUrls: [] };
  if (rebaseFrom && text.includes(rebaseFrom + '/')) {
    // Only the origin changes; the path (/files/<id>/<name>, ?download=1, ...) is kept as is.
    const pieces = text.split(rebaseFrom + '/');
    outcome.rebased = pieces.length - 1;
    outcome.text = pieces.join(baseUrl + '/');
  }
  outcome.text = outcome.text.replace(GOOGLE_URL_PATTERN, (matched) => {
    // "see <link>." : the sentence's own punctuation is not part of the link.
    const trailing = TRAILING_PUNCTUATION_PATTERN.exec(matched);
    const url = trailing ? matched.slice(0, trailing.index) : matched;
    const punctuation = trailing ? trailing[0] : '';
    const id = googleIdOfUrl_(url);
    if (id === null) {
      outcome.unrecognizedUrls.push(url);
      return matched;
    }
    const record = filesById.get(id);
    if (!record) {
      outcome.unresolvedIds.push(id);
      return matched;
    }
    outcome.rewritten++;
    return localUrlFor_(record, baseUrl) + punctuation;
  });
  return outcome;
}

function columnLetter_(columnIndex) {
  let letters = '';
  for (let n = columnIndex + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function columnLabel_(headerRow, columnIndex) {
  const header = headerRow[columnIndex];
  const text = header === undefined || header === null ? '' : String(header).trim();
  return text !== '' ? text : '(column ' + columnLetter_(columnIndex) + ')';
}

// Adds one finding to a per-column tally ({ count, samples }), keeping a few distinct samples.
function tally_(tallyByColumn, columnIndex, sample) {
  let tally = tallyByColumn.get(columnIndex);
  if (!tally) {
    tally = { count: 0, samples: [] };
    tallyByColumn.set(columnIndex, tally);
  }
  tally.count++;
  if (tally.samples.length < SAMPLE_LIMIT && !tally.samples.includes(sample)) tally.samples.push(sample);
}

// Scans one grid without modifying it. changedRows holds a rewritten copy of each row that
// needs writing back.
function scanGrid_(grid, rewriteOptions) {
  const scan = {
    cellsScanned: 0,
    cellsChanged: 0,
    linksRewritten: 0,
    linksRebased: 0,
    changedRows: [],
    unresolvedByColumn: new Map(),
    unrecognizedByColumn: new Map(),
  };
  const oldAddress = rewriteOptions.rebaseFrom ? rewriteOptions.rebaseFrom + '/' : null;
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
    const row = grid[rowIndex];
    let rewrittenRow = null;
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      scan.cellsScanned++;
      const cell = row[columnIndex];
      if (typeof cell !== 'string') continue;
      if (!cell.includes('google.com') && !(oldAddress && cell.includes(oldAddress))) continue;
      const outcome = rewriteLinksInText(cell, rewriteOptions);
      scan.linksRewritten += outcome.rewritten;
      scan.linksRebased += outcome.rebased;
      for (const id of outcome.unresolvedIds) tally_(scan.unresolvedByColumn, columnIndex, id);
      for (const url of outcome.unrecognizedUrls) tally_(scan.unrecognizedByColumn, columnIndex, url);
      if (outcome.text === cell) continue;
      if (!rewrittenRow) rewrittenRow = row.slice();
      rewrittenRow[columnIndex] = outcome.text;
      scan.cellsChanged++;
    }
    if (rewrittenRow) scan.changedRows.push({ rowNumber: rowIndex + 1, cells: rewrittenRow });
  }
  return scan;
}

// One putRows call per run of consecutive changed rows.
function writeChangedRows_(storage, spreadsheetId, sheetName, changedRows) {
  let runStart = 0;
  for (let index = 1; index <= changedRows.length; index++) {
    const runEnds = index === changedRows.length || changedRows[index].rowNumber !== changedRows[index - 1].rowNumber + 1;
    if (!runEnds) continue;
    const run = changedRows.slice(runStart, index);
    storage.putRows(spreadsheetId, sheetName, run[0].rowNumber, run.map((changedRow) => changedRow.cells));
    runStart = index;
  }
}

function sortedFindings_(tallyByColumn, headerRow, location, sampleKey) {
  return [...tallyByColumn.keys()].sort((a, b) => a - b).map((columnIndex) => {
    const tally = tallyByColumn.get(columnIndex);
    return { ...location, column: columnLabel_(headerRow, columnIndex), count: tally.count, [sampleKey]: tally.samples };
  });
}

// Library entry point. Returns the report the CLI prints and --report writes:
// { baseUrl, rebaseFrom, dryRun, totals, unresolved, unrecognized }.
function rewriteDriveLinks({ storage, baseUrl, rebaseFrom = null, dryRun = false, log = () => {} }) {
  const normalizedBaseUrl = normalizeBaseUrl_(baseUrl);
  const normalizedRebaseFrom = rebaseFrom ? normalizeBaseUrl_(rebaseFrom) : null;
  if (normalizedRebaseFrom === normalizedBaseUrl) throw new Error('--rebase-from is the same address as --base-url: nothing to re-point');
  const filesById = new Map(storage.db.prepare('SELECT id, name, is_folder FROM files').all().map((record) => [record.id, record]));
  const totals = { cellsScanned: 0, cellsChanged: 0, linksRewritten: 0, linksRebased: 0, linksUnresolved: 0, linksUnrecognized: 0 };
  const unresolved = [];
  const unrecognized = [];

  for (const [spreadsheetName, spreadsheetId] of Object.entries(IDS)) {
    for (const sheetName of storage.sheetNames(spreadsheetId)) {
      const grid = storage.loadGrid(spreadsheetId, sheetName);
      const scan = scanGrid_(grid, { filesById, baseUrl: normalizedBaseUrl, rebaseFrom: normalizedRebaseFrom });
      const location = { spreadsheet: spreadsheetName, sheet: sheetName };
      const headerRow = grid[0] || [];
      const sheetUnresolved = sortedFindings_(scan.unresolvedByColumn, headerRow, location, 'sampleIds');
      const sheetUnrecognized = sortedFindings_(scan.unrecognizedByColumn, headerRow, location, 'samples');

      totals.cellsScanned += scan.cellsScanned;
      totals.cellsChanged += scan.cellsChanged;
      totals.linksRewritten += scan.linksRewritten;
      totals.linksRebased += scan.linksRebased;
      totals.linksUnresolved += sheetUnresolved.reduce((sum, finding) => sum + finding.count, 0);
      totals.linksUnrecognized += sheetUnrecognized.reduce((sum, finding) => sum + finding.count, 0);
      unresolved.push(...sheetUnresolved);
      unrecognized.push(...sheetUnrecognized);

      if (scan.changedRows.length) {
        if (!dryRun) writeChangedRows_(storage, spreadsheetId, sheetName, scan.changedRows);
        log(spreadsheetName + ' / ' + sheetName + ': ' + scan.linksRewritten + ' Google link(s) and ' + scan.linksRebased
          + ' re-pointed link(s) in ' + scan.cellsChanged + ' cell(s) of ' + scan.changedRows.length + ' row(s)'
          + (dryRun ? ' would be rewritten' : ' rewritten'));
      }
    }
  }
  return { baseUrl: normalizedBaseUrl, rebaseFrom: normalizedRebaseFrom, dryRun, totals, unresolved, unrecognized };
}

function summaryLines_(report) {
  const { totals } = report;
  const lines = [];
  if (report.dryRun) lines.push('DRY RUN: nothing was changed');
  lines.push('cells scanned:      ' + totals.cellsScanned);
  lines.push('cells changed:      ' + totals.cellsChanged);
  lines.push('links rewritten:    ' + totals.linksRewritten);
  if (report.rebaseFrom) lines.push('links re-pointed:   ' + totals.linksRebased + ' (from ' + report.rebaseFrom + ')');
  lines.push('links unresolved:   ' + totals.linksUnresolved);
  if (totals.linksUnrecognized) lines.push('links unrecognized: ' + totals.linksUnrecognized);
  if (report.unresolved.length) {
    lines.push('Still pointing at Google (id not in the local file store):');
    for (const finding of report.unresolved) {
      lines.push('  ' + finding.spreadsheet + ' / ' + finding.sheet + ' / ' + finding.column + ': ' + finding.count
        + ' (e.g. ' + finding.sampleIds.join(', ') + ')');
    }
  }
  if (report.unrecognized.length) {
    lines.push('Google URLs of a shape this tool does not rewrite:');
    for (const finding of report.unrecognized) {
      lines.push('  ' + finding.spreadsheet + ' / ' + finding.sheet + ' / ' + finding.column + ': ' + finding.count
        + ' (e.g. ' + finding.samples.join(', ') + ')');
    }
  }
  return lines;
}

function main() {
  let options;
  try {
    options = parseCommandLine({
      args: process.argv.slice(2),
      options: {
        'base-url': { type: 'string' },
        'rebase-from': { type: 'string' },
        db: { type: 'string' },
        'dry-run': { type: 'boolean' },
        report: { type: 'string' },
      },
    }).values;
  } catch (error) {
    console.error(error.message + '\n' + USAGE);
    process.exit(2);
  }
  if (!options['base-url']) {
    console.error(USAGE);
    process.exit(2);
  }

  // Rewriting links in a database that does not exist is a typo, not a job: do not create one.
  const databasePath = path.resolve(options.db || process.env.BASAER_DB || DEFAULT_DB);
  if (!fs.existsSync(databasePath)) throw new Error('database not found: ' + databasePath);
  const storage = new Storage(databasePath);
  try {
    const report = rewriteDriveLinks({
      storage, baseUrl: options['base-url'], rebaseFrom: options['rebase-from'] || null, dryRun: Boolean(options['dry-run']), log: console.log,
    });
    if (options.report) fs.writeFileSync(path.resolve(options.report), JSON.stringify(report, null, 2) + '\n');
    for (const line of summaryLines_(report)) console.log(line);
  } finally {
    storage.close();
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('rewrite failed: ' + (e && e.stack || e)); process.exit(1); }
}

module.exports = { rewriteDriveLinks, rewriteLinksInText };
