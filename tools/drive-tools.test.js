'use strict';

// Tests for tools/import-drive-tree.js and tools/rewrite-drive-links.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Storage } = require('../server/storage.js');
const { IDS } = require('./xlsx-common.js');
const { importDriveTree, listPathsToCopy } = require('./import-drive-tree.js');
const { rewriteDriveLinks, rewriteLinksInText } = require('./rewrite-drive-links.js');

const importScript = path.join(__dirname, 'import-drive-tree.js');
const rewriteScript = path.join(__dirname, 'rewrite-drive-links.js');
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runScript(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function writeFile(rootDir, relativePath, content) {
  const target = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

// ---------------------------------------------------------------------------
// import-drive-tree
// ---------------------------------------------------------------------------

function listingEntry(relativePath, id, extra = {}) {
  return {
    Path: relativePath,
    Name: path.posix.basename(relativePath),
    Size: -1,
    MimeType: 'application/pdf',
    ModTime: '2026-01-01T00:00:00.000Z',
    IsDir: false,
    ID: id,
    ...extra,
  };
}

function folderEntry(relativePath, id) {
  return listingEntry(relativePath, id, { IsDir: true, MimeType: 'inode/directory' });
}

// A tree as rclone copy left it, plus the files the operator fetched by id:
//   twin.pdf     two siblings with one name; rclone kept one copy (wrong for at least one of them)
//   triplet.pdf  two siblings with one name; only the first was fetched by id
//   lonely.pdf   a unique name whose bytes rclone did not copy, but the operator fetched by id
//   vanished.pdf a unique name found nowhere
//   memo         a Google Doc listed without the .pdf suffix rclone gave its export
//   Twins        two sibling folders with one name, one file below them
function buildTreeFixture(dir) {
  const treeDir = path.join(dir, 'tree');
  const byIdDir = path.join(dir, 'by-id');
  writeFile(treeDir, 'Reports/summary.pdf', 'SUMMARY');
  writeFile(treeDir, 'Reports/twin.pdf', 'WRONG-ONE-OF-TWO');
  writeFile(treeDir, 'Reports/triplet.pdf', 'WRONG-ONE-OF-TWO-AGAIN');
  writeFile(treeDir, 'Reports/memo.pdf', 'MEMO-EXPORTED');
  writeFile(treeDir, 'Twins/inside.pdf', 'INSIDE');
  writeFile(byIdDir, 'idTwinFirst', 'FIRST-TWIN-BYTES');
  writeFile(byIdDir, 'idTwinSecond', 'SECOND-TWIN-BYTES');
  writeFile(byIdDir, 'idTripletFirst', 'TRIPLET-FIRST-BYTES');
  writeFile(byIdDir, 'idLonely', 'LONELY-BYTES');
  const listing = [
    folderEntry('Reports', 'idReports'),
    listingEntry('Reports/summary.pdf', 'idSummary'),
    listingEntry('Reports/twin.pdf', 'idTwinFirst'),
    listingEntry('Reports/twin.pdf', 'idTwinSecond'),
    listingEntry('Reports/triplet.pdf', 'idTripletFirst'),
    listingEntry('Reports/triplet.pdf', 'idTripletSecond'),
    listingEntry('Reports/lonely.pdf', 'idLonely'),
    listingEntry('Reports/vanished.pdf', 'idVanished'),
    listingEntry('Reports/memo', 'idMemoDoc', { MimeType: 'application/vnd.google-apps.document' }),
    listingEntry('Reports/Dead link', 'idDeadShortcut', { MimeType: 'application/vnd.google-apps.shortcut.dangling', Size: 0 }),
    folderEntry('Twins', 'idTwinsA'),
    folderEntry('Twins', 'idTwinsB'),
    listingEntry('Twins/inside.pdf', 'idInside'),
  ];
  return { treeDir, byIdDir, listing };
}

function importOptions(dir, fixture, storage, overrides = {}) {
  return {
    storage,
    filesDir: path.join(dir, 'files'),
    rootId: 'mydrive-root',
    rootName: 'My Drive',
    listing: fixture.listing,
    sourceDir: fixture.treeDir,
    byIdDir: fixture.byIdDir,
    missingIdsPath: path.join(fixture.treeDir, 'missing-ids.txt'),
    ...overrides,
  };
}

// Everything about a row except its timestamps, which change on every upsert.
function readFileRows(storage) {
  return storage.db.prepare('SELECT id, name, mime, size, parent_id, is_folder, is_public, trashed FROM files ORDER BY id').all();
}

const storedBytes = (dir, id) => fs.readFileSync(path.join(dir, 'files', id), 'utf8');

test('import-drive-tree: duplicate siblings are read by id, each under its own id', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildTreeFixture(dir);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  const logLines = [];

  const counts = importDriveTree(importOptions(dir, fixture, storage, { log: (line) => logLines.push(line) }));

  assert.deepEqual(logLines, ['WARN  Twins: 2 folders share this path (idTwinsA, idTwinsB); 1 item(s) below it were attached to idTwinsA']);
  assert.deepEqual(counts, {
    folders: 4, // the root, Reports and both Twins
    files: 7,
    duplicates: 6, // twin.pdf x2, triplet.pdf x2, Twins x2
    duplicatePaths: 3,
    missing: 2,
    fromById: 4, // both twins, the first triplet and lonely.pdf
    skippedShortcuts: 1,
    repeatedIds: 0,
    ambiguousParents: 1, // Twins/inside.pdf
    ancestorFolders: 0, // no --only-ids: every folder is imported as itself
    skippedNotReferenced: 0, // ... and everything is covered
    skippedFolders: 0,
    skippedFiles: 0,
    referencedIds: null,
    unfoundIds: [],
    missingIds: ['idTripletSecond', 'idVanished'],
  });

  const rows = Object.fromEntries(readFileRows(storage).map((row) => [row.id, row]));
  assert.deepEqual(Object.keys(rows).sort(), [
    'idInside', 'idLonely', 'idMemoDoc', 'idReports', 'idSummary', 'idTripletFirst', 'idTwinFirst', 'idTwinSecond',
    'idTwinsA', 'idTwinsB', 'mydrive-root',
  ]);
  assert.deepEqual(rows['mydrive-root'], { id: 'mydrive-root', name: 'My Drive', mime: FOLDER_MIME, size: 0, parent_id: null, is_folder: 1, is_public: 1, trashed: 0 });
  assert.equal(rows.idReports.parent_id, 'mydrive-root');
  assert.equal(rows.idSummary.parent_id, 'idReports');
  assert.equal(rows.idSummary.is_public, 1);
  assert.equal(storedBytes(dir, 'idSummary'), 'SUMMARY');

  // The two twins keep their own ids and bytes; the lone copy at the path is not trusted.
  assert.equal(rows.idTwinFirst.name, 'twin.pdf');
  assert.equal(rows.idTwinSecond.name, 'twin.pdf');
  assert.equal(rows.idTwinFirst.parent_id, 'idReports');
  assert.equal(rows.idTwinSecond.parent_id, 'idReports');
  assert.equal(storedBytes(dir, 'idTwinFirst'), 'FIRST-TWIN-BYTES');
  assert.equal(storedBytes(dir, 'idTwinSecond'), 'SECOND-TWIN-BYTES');
  assert.equal(rows.idTwinSecond.size, 'SECOND-TWIN-BYTES'.length);
  assert.equal(storedBytes(dir, 'idTripletFirst'), 'TRIPLET-FIRST-BYTES');

  // Any file whose path bytes are absent falls back to the by-id directory.
  assert.equal(storedBytes(dir, 'idLonely'), 'LONELY-BYTES');
  // A Google Doc gets the .pdf name and mime of its export, bytes from path + ".pdf".
  assert.equal(rows.idMemoDoc.name, 'memo.pdf');
  assert.equal(rows.idMemoDoc.mime, 'application/pdf');
  assert.equal(storedBytes(dir, 'idMemoDoc'), 'MEMO-EXPORTED');
  // Children of two folders sharing a path go to the first one listed.
  assert.equal(rows.idInside.parent_id, 'idTwinsA');

  // Nothing found for these: no row, no bytes, and a shortcut is neither.
  for (const id of ['idTripletSecond', 'idVanished', 'idDeadShortcut']) {
    assert.equal(fs.existsSync(path.join(dir, 'files', id)), false, id);
  }
  assert.equal(fs.readFileSync(path.join(fixture.treeDir, 'missing-ids.txt'), 'utf8'), 'idTripletSecond\nidVanished\n');
});

test('import-drive-tree: a second run changes nothing, then fetched ids complete the import', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildTreeFixture(dir);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  const missingIdsPath = path.join(fixture.treeDir, 'missing-ids.txt');

  const first = importDriveTree(importOptions(dir, fixture, storage));
  const rowsAfterFirst = readFileRows(storage);
  const second = importDriveTree(importOptions(dir, fixture, storage));
  assert.deepEqual(second, first);
  assert.deepEqual(readFileRows(storage), rowsAfterFirst);
  assert.equal(rowsAfterFirst.length, 11);
  assert.equal(fs.existsSync(missingIdsPath), true);

  // The operator runs the printed rclone backend copyid commands and imports again.
  writeFile(fixture.byIdDir, 'idTripletSecond', 'TRIPLET-SECOND-BYTES');
  writeFile(fixture.byIdDir, 'idVanished', 'VANISHED-BYTES');
  const third = importDriveTree(importOptions(dir, fixture, storage));
  assert.equal(third.missing, 0);
  assert.deepEqual(third.missingIds, []);
  assert.equal(third.files, 9);
  assert.equal(third.fromById, 6);
  assert.equal(fs.existsSync(missingIdsPath), false, 'a stale missing-ids.txt is removed');
  const rowsAfterThird = readFileRows(storage);
  assert.equal(rowsAfterThird.length, 13);
  assert.equal(new Set(rowsAfterThird.map((row) => row.id)).size, 13, 'one row per id');
  assert.equal(storedBytes(dir, 'idTripletSecond'), 'TRIPLET-SECOND-BYTES');
  // Everything the first run imported is unchanged.
  for (const row of rowsAfterFirst) assert.deepEqual(rowsAfterThird.find((candidate) => candidate.id === row.id), row);
});

test('import-drive-tree: a dry run reports the same counts and writes nothing', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildTreeFixture(dir);
  const dryStorage = new Storage(':memory:');
  const realStorage = new Storage(':memory:');
  t.after(() => { dryStorage.close(); realStorage.close(); });

  const dryCounts = importDriveTree(importOptions(dir, fixture, dryStorage, { dryRun: true }));

  assert.equal(dryStorage.db.prepare('SELECT COUNT(*) FROM files').pluck().get(), 0);
  assert.equal(fs.existsSync(path.join(dir, 'files')), false);
  assert.equal(fs.existsSync(path.join(fixture.treeDir, 'missing-ids.txt')), false);
  assert.deepEqual(dryCounts.missingIds, ['idTripletSecond', 'idVanished']);

  const realCounts = importDriveTree(importOptions(dir, fixture, realStorage));
  assert.deepEqual(dryCounts, realCounts);
});

test('import-drive-tree: without a by-id directory every duplicate is missing', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildTreeFixture(dir);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  const allMissing = ['idTwinFirst', 'idTwinSecond', 'idTripletFirst', 'idTripletSecond', 'idLonely', 'idVanished'];

  const logLines = [];
  const notCreatedYet = importDriveTree(importOptions(dir, fixture, storage, {
    byIdDir: path.join(dir, 'fetch-here-later'),
    log: (line) => logLines.push(line),
  }));
  assert.match(logLines[0], /^NOTE  .*fetch-here-later does not exist yet/);
  assert.deepEqual(notCreatedYet.missingIds, allMissing);
  assert.equal(notCreatedYet.fromById, 0);

  const noOption = importDriveTree(importOptions(dir, fixture, storage, { byIdDir: undefined }));
  assert.deepEqual(noOption.missingIds, allMissing);
  // The path copy of a duplicate is still never used.
  assert.equal(fs.existsSync(path.join(dir, 'files', 'idTwinFirst')), false);
  assert.equal(fs.readFileSync(path.join(fixture.treeDir, 'missing-ids.txt'), 'utf8'), allMissing.join('\n') + '\n');
});

test('import-drive-tree: all rows are written in one transaction', (t) => {
  const dir = makeTempDir(t);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  writeFile(path.join(dir, 'tree'), 'good.pdf', 'GOOD');
  writeFile(path.join(dir, 'tree'), 'bad.pdf', 'BAD');
  const listing = [
    listingEntry('good.pdf', 'idGood'),
    // A name SQLite cannot bind makes the third insert throw after two rows went in.
    listingEntry('bad.pdf', 'idBad', { Name: { unbindable: true } }),
  ];

  assert.throws(
    () => importDriveTree({ storage, filesDir: path.join(dir, 'files'), rootId: 'mydrive-root', rootName: 'My Drive', listing, sourceDir: path.join(dir, 'tree') }),
    /SQLite3 can only bind/,
  );
  assert.equal(storage.db.prepare('SELECT COUNT(*) FROM files').pluck().get(), 0, 'the root and the good file were rolled back');
});

test('import-drive-tree: a repeated id keeps its first row; a path leading out of the tree is never read', (t) => {
  const dir = makeTempDir(t);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  writeFile(path.join(dir, 'tree'), 'a/report.pdf', 'REPORT');
  writeFile(path.join(dir, 'tree'), 'b/report again.pdf', 'REPORT');
  writeFile(dir, 'outside.pdf', 'SECRET');
  const listing = [
    folderEntry('a', 'idA'),
    folderEntry('b', 'idB'),
    listingEntry('a/report.pdf', 'idReport'),
    listingEntry('b/report again.pdf', 'idReport'), // a followed shortcut lists its target twice
    listingEntry('../outside.pdf', 'idOutside'),
  ];

  const counts = importDriveTree({
    storage, filesDir: path.join(dir, 'files'), rootId: 'mydrive-root', rootName: 'My Drive', listing, sourceDir: path.join(dir, 'tree'),
  });

  assert.equal(counts.repeatedIds, 1);
  assert.equal(counts.files, 1);
  assert.equal(counts.missing, 1);
  assert.deepEqual(counts.missingIds, ['idOutside']);
  assert.equal(storage.db.prepare("SELECT parent_id FROM files WHERE id = 'idReport'").pluck().get(), 'idA');
  assert.equal(fs.existsSync(path.join(dir, 'files', 'idOutside')), false);
});

test('import-drive-tree: a followed shortcut ("target<TAB>shortcut" id) is stored under the target id', (t) => {
  const dir = makeTempDir(t);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  writeFile(path.join(dir, 'tree'), 'Shared folder/notes.pdf', 'NOTES');
  writeFile(path.join(dir, 'by-id'), 'idTargetFile', 'TARGET-FILE-BYTES');
  const listing = [
    folderEntry('Shared folder', 'idTargetFolder\tidShortcutFolder'),
    listingEntry('Shared folder/notes.pdf', 'idNotes'),
    listingEntry('Shared folder/linked.pdf', 'idTargetFile\tidShortcutFile'), // bytes only by id, under the target id
  ];

  const counts = importDriveTree({
    storage,
    filesDir: path.join(dir, 'files'),
    rootId: 'mydrive-root',
    rootName: 'My Drive',
    listing,
    sourceDir: path.join(dir, 'tree'),
    byIdDir: path.join(dir, 'by-id'),
  });

  assert.equal(counts.missing, 0);
  assert.deepEqual(readFileRows(storage).map((row) => [row.id, row.parent_id]), [
    ['idNotes', 'idTargetFolder'],
    ['idTargetFile', 'idTargetFolder'],
    ['idTargetFolder', 'mydrive-root'],
    ['mydrive-root', null],
  ]);
  assert.equal(storedBytes(dir, 'idTargetFile'), 'TARGET-FILE-BYTES');
});

test('import-drive-tree: a listing entry without a usable id is refused before anything is written', (t) => {
  const dir = makeTempDir(t);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  fs.mkdirSync(path.join(dir, 'tree'));
  const run = (listing, rootId = 'mydrive-root') => importDriveTree({
    storage, filesDir: path.join(dir, 'files'), rootId, rootName: 'My Drive', listing, sourceDir: path.join(dir, 'tree'),
  });

  assert.throws(() => run([{ Path: 'a.pdf', Name: 'a.pdf', IsDir: false }]), /usable ID/);
  assert.throws(() => run([{ Path: 'a.pdf', Name: 'a.pdf', IsDir: false, ID: '../escape' }]), /usable ID/);
  assert.throws(() => run([listingEntry('a.pdf', 'mydrive-root')]), /also the id of the listing entry/);
  assert.throws(() => run([], 'not a valid id'), /--root-id/);
  assert.throws(() => run({ not: 'an array' }), /JSON array/);
  assert.equal(storage.db.prepare('SELECT COUNT(*) FROM files').pluck().get(), 0);
});

// A tree the sheets reference only in part (the referenced ids are returned too):
//   Archive            a referenced folder: everything below it comes along
//   Loose/kept         a referenced folder inside an unreferenced one
//   Loose/wanted.pdf   a referenced file; its folder Loose is not referenced
//   Loose/twin.pdf     two siblings with one name, only the first referenced (bytes by id)
//   Dup                two folders with one name, only the second referenced; one file below them
//   Other, Loose/unwanted.pdf, top-level.pdf   not referenced
// Every file has bytes in the tree, so a file left out is left out by --only-ids, not by chance.
function buildReferencedFixture(dir) {
  const treeDir = path.join(dir, 'tree');
  const byIdDir = path.join(dir, 'by-id');
  const bytes = {
    'Archive/card.pdf': 'CARD',
    'Archive/2025/letter.pdf': 'LETTER',
    'Other/skip-me.pdf': 'SKIP-ME',
    'Other/deep/skip-too.pdf': 'SKIP-TOO',
    'Loose/wanted.pdf': 'WANTED',
    'Loose/unwanted.pdf': 'UNWANTED',
    'Loose/twin.pdf': 'WRONG-ONE-OF-TWO',
    'Loose/kept/note.pdf': 'NOTE',
    'Dup/inside.pdf': 'INSIDE',
    'top-level.pdf': 'TOP',
  };
  for (const [relativePath, content] of Object.entries(bytes)) writeFile(treeDir, relativePath, content);
  writeFile(byIdDir, 'idTwinWanted', 'TWIN-WANTED-BYTES');
  const listing = [
    folderEntry('Archive', 'idArchive'),
    listingEntry('Archive/card.pdf', 'idCard'),
    folderEntry('Archive/2025', 'idArchive2025'),
    listingEntry('Archive/2025/letter.pdf', 'idLetter'),
    folderEntry('Other', 'idOther'),
    listingEntry('Other/skip-me.pdf', 'idSkipMe'),
    folderEntry('Other/deep', 'idDeep'),
    listingEntry('Other/deep/skip-too.pdf', 'idSkipToo'),
    folderEntry('Loose', 'idLoose'),
    listingEntry('Loose/wanted.pdf', 'idWanted'),
    listingEntry('Loose/unwanted.pdf', 'idUnwanted'),
    listingEntry('Loose/twin.pdf', 'idTwinWanted'),
    listingEntry('Loose/twin.pdf', 'idTwinOther'),
    folderEntry('Loose/kept', 'idKept'),
    listingEntry('Loose/kept/note.pdf', 'idNote'),
    folderEntry('Dup', 'idDupFirst'),
    folderEntry('Dup', 'idDupSecond'),
    listingEntry('Dup/inside.pdf', 'idInside'),
    listingEntry('top-level.pdf', 'idTopLevel'),
    listingEntry('Dead link', 'idDeadShortcut', { MimeType: 'application/vnd.google-apps.shortcut.dangling', Size: 0 }),
  ];
  const referencedIds = ['idArchive', 'idKept', 'idWanted', 'idTwinWanted', 'idDupSecond', 'idDeadShortcut', 'idNotInListing', 'idAlsoGone'];
  return { treeDir, byIdDir, listing, referencedIds };
}

// The imported rows: the root, what is selected, and idLoose, the one folder above selected items that is not selected itself.
const REFERENCED_ROW_IDS = [
  'idArchive', 'idArchive2025', 'idCard', 'idDupSecond', 'idInside', 'idKept', 'idLetter', 'idLoose', 'idNote', 'idTwinWanted', 'idWanted', 'mydrive-root',
];

test('import-drive-tree --only-ids: referenced folders bring their subtree, everything else is skipped', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildReferencedFixture(dir);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());

  const counts = importDriveTree(importOptions(dir, fixture, storage, { onlyIds: fixture.referencedIds }));

  assert.deepEqual(counts, {
    folders: 5, // the root, Archive, Archive/2025, Loose/kept and the referenced Dup
    files: 6, // card, letter, note, wanted, twin (by id) and Dup/inside
    duplicates: 2, // the selected twin.pdf and the selected Dup folder
    duplicatePaths: 2,
    missing: 0,
    fromById: 1,
    skippedShortcuts: 1, // the referenced dangling shortcut
    repeatedIds: 0,
    ambiguousParents: 1, // Dup/inside.pdf
    ancestorFolders: 1, // Loose, above the selected wanted.pdf, twin.pdf and kept
    skippedNotReferenced: 8, // Other, skip-me, deep, skip-too, unwanted, the other twin, the other Dup, top-level
    skippedFolders: 3,
    skippedFiles: 5,
    referencedIds: 8,
    unfoundIds: ['idNotInListing', 'idAlsoGone'],
    missingIds: [],
  });

  const rows = Object.fromEntries(readFileRows(storage).map((row) => [row.id, row]));
  assert.deepEqual(Object.keys(rows).sort(), REFERENCED_ROW_IDS);
  for (const row of Object.values(rows)) assert.equal(row.is_public, row.id === 'idLoose' ? 0 : 1, row.id);
  // The referenced folder, its children and grandchildren.
  assert.equal(rows.idArchive.parent_id, 'mydrive-root');
  assert.equal(rows.idCard.parent_id, 'idArchive');
  assert.equal(rows.idArchive2025.parent_id, 'idArchive');
  assert.equal(rows.idLetter.parent_id, 'idArchive2025');
  assert.equal(storedBytes(dir, 'idLetter'), 'LETTER');
  // Referenced items inside an unreferenced folder: that folder comes along as a private ancestor, so nothing is orphaned.
  assert.equal(rows.idWanted.parent_id, 'idLoose');
  assert.equal(rows.idKept.parent_id, 'idLoose');
  assert.equal(rows.idNote.parent_id, 'idKept');
  assert.deepEqual(rows.idLoose, { id: 'idLoose', name: 'Loose', mime: FOLDER_MIME, size: 0, parent_id: 'mydrive-root', is_folder: 1, is_public: 0, trashed: 0 });
  assert.equal(fs.existsSync(path.join(dir, 'files', 'idLoose')), false, 'a folder has no bytes');
  for (const row of Object.values(rows)) {
    if (row.parent_id !== null) assert.ok(rows[row.parent_id], row.id + ' has a parent that is in the store');
  }
  // A shared path is never read from the tree, even when only one of the siblings is referenced.
  assert.equal(storedBytes(dir, 'idTwinWanted'), 'TWIN-WANTED-BYTES');
  // Two folders with one name: the children go to the referenced one.
  assert.equal(rows.idDupSecond.parent_id, 'mydrive-root');
  assert.equal(rows.idInside.parent_id, 'idDupSecond');
  assert.equal(rows.idDupFirst, undefined);
  // The rest has neither a row nor bytes, although its bytes sit in the tree.
  for (const id of ['idOther', 'idSkipMe', 'idDeep', 'idSkipToo', 'idUnwanted', 'idTwinOther', 'idDupFirst', 'idTopLevel']) {
    assert.equal(rows[id], undefined, id);
    assert.equal(fs.existsSync(path.join(dir, 'files', id)), false, id);
  }
});

test('import-drive-tree --only-ids: a dry run reports the same counts and writes nothing', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildReferencedFixture(dir);
  const dryStorage = new Storage(':memory:');
  const realStorage = new Storage(':memory:');
  t.after(() => { dryStorage.close(); realStorage.close(); });

  const dryCounts = importDriveTree(importOptions(dir, fixture, dryStorage, { onlyIds: fixture.referencedIds, dryRun: true }));

  assert.equal(dryStorage.db.prepare('SELECT COUNT(*) FROM files').pluck().get(), 0);
  assert.equal(fs.existsSync(path.join(dir, 'files')), false);
  assert.deepEqual(dryCounts, importDriveTree(importOptions(dir, fixture, realStorage, { onlyIds: fixture.referencedIds })));
});

// A file referenced on its own, three folders deep. Org, Year 2025 and Student 7 must come along;
// their unreferenced siblings (Student 8, Archive 2024) and everything else must not.
function buildDeepFixture(dir) {
  const treeDir = path.join(dir, 'tree');
  const bytes = {
    'Org/Year 2025/Student 7/card.pdf': 'DEEP-CARD',
    'Org/Year 2025/Student 7/other.pdf': 'OTHER',
    'Org/Year 2025/Student 8/card.pdf': 'CARD-8',
    'Org/Archive 2024/old.pdf': 'OLD',
    'Elsewhere/readme.pdf': 'README',
  };
  for (const [relativePath, content] of Object.entries(bytes)) writeFile(treeDir, relativePath, content);
  const listing = [
    folderEntry('Org', 'idOrg'),
    folderEntry('Org/Year 2025', 'idYear'),
    folderEntry('Org/Year 2025/Student 7', 'idStudent7'),
    listingEntry('Org/Year 2025/Student 7/card.pdf', 'idDeepCard'),
    listingEntry('Org/Year 2025/Student 7/other.pdf', 'idDeepOther'),
    folderEntry('Org/Year 2025/Student 8', 'idStudent8'),
    listingEntry('Org/Year 2025/Student 8/card.pdf', 'idCard8'),
    folderEntry('Org/Archive 2024', 'idArchive2024'),
    listingEntry('Org/Archive 2024/old.pdf', 'idOld'),
    folderEntry('Elsewhere', 'idElsewhere'),
    listingEntry('Elsewhere/readme.pdf', 'idReadme'),
  ];
  return { treeDir, listing };
}

function importDeepFixture(dir, fixture, storage, overrides = {}) {
  return importDriveTree({
    storage,
    filesDir: path.join(dir, 'files'),
    rootId: 'mydrive-root',
    rootName: 'My Drive',
    listing: fixture.listing,
    sourceDir: fixture.treeDir,
    onlyIds: ['idDeepCard'],
    ...overrides,
  });
}

test('import-drive-tree --only-ids: the folders above a referenced file come along as private rows, their siblings do not', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildDeepFixture(dir);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());

  const counts = importDeepFixture(dir, fixture, storage);

  assert.equal(counts.folders, 1, 'only the root: no folder is selected itself');
  assert.equal(counts.files, 1);
  assert.equal(counts.ancestorFolders, 3);
  assert.deepEqual(
    [counts.skippedNotReferenced, counts.skippedFolders, counts.skippedFiles],
    [7, 3, 4], // Student 8, Archive 2024, Elsewhere; other.pdf, Student 8's card, old.pdf, readme.pdf
  );
  // Exactly these rows: the real names and parent chain, the ancestors private, the file public.
  assert.deepEqual(readFileRows(storage), [
    { id: 'idDeepCard', name: 'card.pdf', mime: 'application/pdf', size: 9, parent_id: 'idStudent7', is_folder: 0, is_public: 1, trashed: 0 },
    { id: 'idOrg', name: 'Org', mime: FOLDER_MIME, size: 0, parent_id: 'mydrive-root', is_folder: 1, is_public: 0, trashed: 0 },
    { id: 'idStudent7', name: 'Student 7', mime: FOLDER_MIME, size: 0, parent_id: 'idYear', is_folder: 1, is_public: 0, trashed: 0 },
    { id: 'idYear', name: 'Year 2025', mime: FOLDER_MIME, size: 0, parent_id: 'idOrg', is_folder: 1, is_public: 0, trashed: 0 },
    { id: 'mydrive-root', name: 'My Drive', mime: FOLDER_MIME, size: 0, parent_id: null, is_folder: 1, is_public: 1, trashed: 0 },
  ]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'files')), ['idDeepCard'], 'folders have no bytes, siblings are not copied');

  // A second run changes nothing.
  assert.deepEqual(importDeepFixture(dir, fixture, storage), counts);
  assert.equal(readFileRows(storage).length, 5);

  // A dry run reports the same ancestors and writes nothing.
  const dryStorage = new Storage(':memory:');
  t.after(() => dryStorage.close());
  assert.deepEqual(importDeepFixture(dir, fixture, dryStorage, { dryRun: true }), counts);
  assert.equal(dryStorage.db.prepare('SELECT COUNT(*) FROM files').pluck().get(), 0);

  // Referencing the middle folder as well makes it a selected folder (public, with its subtree), not an ancestor.
  const selectedStorage = new Storage(':memory:');
  t.after(() => selectedStorage.close());
  const withMiddle = importDeepFixture(dir, fixture, selectedStorage, { onlyIds: ['idDeepCard', 'idYear'] });
  assert.equal(withMiddle.ancestorFolders, 1, 'only Org is left above the selected Year 2025');
  const middleRows = Object.fromEntries(readFileRows(selectedStorage).map((row) => [row.id, row]));
  assert.equal(middleRows.idYear.is_public, 1);
  assert.equal(middleRows.idOrg.is_public, 0);
  assert.ok(middleRows.idStudent8 && middleRows.idCard8, 'the subtree of a referenced folder comes along');
  assert.equal(middleRows.idArchive2024, undefined, 'a sibling of the referenced folder still does not');
});

test('import-drive-tree --only-ids: an ancestor row that already exists keeps its flags and gets the real name and parent', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildDeepFixture(dir);
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  const stamp = '2020-01-01T00:00:00.000Z';
  const insertFolder = storage.db.prepare(`
    INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, 1, ?, ?, ?, ?)
  `);
  // The placeholder DriveApp.getFolderById makes for a folder id it does not know.
  insertFolder.run('idOrg', 'Legacy folder idOrg', FOLDER_MIME, null, 0, 0, stamp, stamp);
  // A folder an earlier import made public and the app has since trashed.
  insertFolder.run('idYear', 'Old name', FOLDER_MIME, 'somewhere-else', 1, 1, stamp, stamp);

  importDeepFixture(dir, fixture, storage);

  const rows = Object.fromEntries(readFileRows(storage).map((row) => [row.id, row]));
  assert.deepEqual([rows.idOrg.name, rows.idOrg.parent_id, rows.idOrg.is_public, rows.idOrg.trashed], ['Org', 'mydrive-root', 0, 0]);
  assert.deepEqual([rows.idYear.name, rows.idYear.parent_id, rows.idYear.is_public, rows.idYear.trashed], ['Year 2025', 'idOrg', 1, 1]);
  const timestamps = storage.db.prepare("SELECT created_at, updated_at FROM files WHERE id = 'idYear'").get();
  assert.equal(timestamps.created_at, stamp, 'the row was updated, not replaced');
  assert.notEqual(timestamps.updated_at, stamp);
  assert.equal(rows.idStudent7.is_public, 0, 'a new ancestor row is private');
});

test('import-drive-tree --list-paths: the Paths of the files that would be imported, in listing order', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildReferencedFixture(dir);
  const result = listPathsToCopy({ listing: fixture.listing, onlyIds: fixture.referencedIds });

  assert.deepEqual(result.paths, [
    'Archive/card.pdf',
    'Archive/2025/letter.pdf',
    'Loose/wanted.pdf',
    'Loose/kept/note.pdf',
    'Dup/inside.pdf',
  ]);
  assert.equal(result.selectedFiles, 6); // the five above and Loose/twin.pdf
  assert.equal(result.sharedPathFiles, 1); // the twin: rclone cannot pick between the siblings, so it is fetched by id
  assert.equal(result.unlistablePathFiles, 0);
  assert.deepEqual(result.unfoundIds, ['idNotInListing', 'idAlsoGone']);
  assert.equal(result.referencedIds, 8);

  // The same selection drives the import: the listed files plus the one fetched by id are exactly the files it covers.
  const imported = importDriveTree(importOptions(dir, fixture, null, { onlyIds: fixture.referencedIds, dryRun: true }));
  assert.equal(imported.files + imported.missing, result.selectedFiles);
  assert.equal(imported.missing, 0);
});

test('import-drive-tree --list-paths: a Path that cannot be one line of a --files-from file is left out', () => {
  const listing = [
    listingEntry('fine/name.pdf', 'idFine'),
    listingEntry('fine/with a space .pdf', 'idSpace'),
    listingEntry('two\nlines.pdf', 'idNewline'),
    listingEntry('# not a comment.pdf', 'idHash'),
    listingEntry('; nor this.pdf', 'idSemicolon'),
    listingEntry(' leading space.pdf', 'idLeading'),
    listingEntry('trailing space.pdf ', 'idTrailing'),
    listingEntry('not-referenced.pdf', 'idElsewhere'),
  ];

  const result = listPathsToCopy({ listing, onlyIds: ['idFine', 'idSpace', 'idNewline', 'idHash', 'idSemicolon', 'idLeading', 'idTrailing'] });

  assert.deepEqual(result.paths, ['fine/name.pdf', 'fine/with a space .pdf']);
  assert.equal(result.unlistablePathFiles, 5);
  assert.equal(result.selectedFiles, 7);
  assert.deepEqual(result.unfoundIds, []);
});

test('import-drive-tree --only-ids CLI: list paths, unfound ids, dry run, real run and usage errors', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildReferencedFixture(dir);
  const listingPath = path.join(dir, 'tree.lsjson');
  fs.writeFileSync(listingPath, JSON.stringify(fixture.listing));
  const idsPath = path.join(dir, 'ids.json');
  // Whitespace around an id is ignored.
  fs.writeFileSync(idsPath, JSON.stringify(fixture.referencedIds.map((id) => (id === 'idWanted' ? '  idWanted ' : id))));
  const pathsFile = path.join(dir, 'paths.txt');
  const unfoundFile = path.join(dir, 'unfound.txt');
  const dbPath = path.join(dir, 'cli.sqlite');
  const filesDir = path.join(dir, 'cli-files');

  // --list-paths needs neither the copied tree nor a root, and opens no database.
  const listed = runScript(importScript, ['--listing', listingPath, '--only-ids', idsPath, '--list-paths', pathsFile, '--unfound-ids', unfoundFile, '--db', dbPath]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(fs.readFileSync(pathsFile, 'utf8'), 'Archive/card.pdf\nArchive/2025/letter.pdf\nLoose/wanted.pdf\nLoose/kept/note.pdf\nDup/inside.pdf\n');
  assert.equal(fs.readFileSync(unfoundFile, 'utf8'), 'idNotInListing\nidAlsoGone\n');
  assert.match(listed.stdout, /LIST PATHS: nothing was imported/);
  assert.match(listed.stdout, /^referenced ids: 8 \(6 in the listing, 2 not found\)$/m);
  assert.match(listed.stdout, /^paths written:\s+5 to /m);
  assert.match(listed.stdout, /left out, path shared with a sibling: 1/);
  assert.match(listed.stdout, /rclone copy gdrive: <dir> --files-from .*paths\.txt --drive-export-formats pdf/);
  assert.equal(fs.existsSync(dbPath), false);

  const baseArgs = [
    '--listing', listingPath, '--dir', fixture.treeDir, '--root-id', 'mydrive-root', '--root-name', 'My Drive',
    '--by-id-dir', fixture.byIdDir, '--only-ids', idsPath, '--db', dbPath, '--files-dir', filesDir,
  ];
  fs.rmSync(unfoundFile);
  const dry = runScript(importScript, [...baseArgs, '--unfound-ids', unfoundFile, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^referenced ids: 8 \(6 in the listing, 2 not found\)$/m);
  assert.match(dry.stdout, /^folders:\s+5\b/m);
  assert.match(dry.stdout, /^files:\s+6\b/m);
  assert.match(dry.stdout, /^missing:\s+0$/m);
  assert.match(dry.stdout, /^selected:\s+4 folders, 6 files$/m);
  assert.match(dry.stdout, /^ancestor folders: 1 \(/m);
  assert.match(dry.stdout, /^skipped \(not referenced\): 8 \(3 folders, 5 files\)$/m);
  assert.equal(fs.readFileSync(unfoundFile, 'utf8'), 'idNotInListing\nidAlsoGone\n', 'a dry run still writes the file it was asked for');
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(fs.existsSync(filesDir), false);

  const real = runScript(importScript, baseArgs);
  assert.equal(real.status, 0, real.stderr);
  const storage = new Storage(dbPath);
  t.after(() => storage.close());
  assert.deepEqual(readFileRows(storage).map((row) => row.id).sort(), REFERENCED_ROW_IDS);
  assert.deepEqual(fs.readdirSync(filesDir).sort(), ['idCard', 'idInside', 'idLetter', 'idNote', 'idTwinWanted', 'idWanted']);

  const listWithoutIds = runScript(importScript, ['--listing', listingPath, '--list-paths', pathsFile]);
  assert.equal(listWithoutIds.status, 2);
  assert.match(listWithoutIds.stderr, /--list-paths and --unfound-ids need --only-ids/);
  const argsWithoutOnlyIds = baseArgs.filter((arg, index) => arg !== '--only-ids' && baseArgs[index - 1] !== '--only-ids');
  const unfoundWithoutIds = runScript(importScript, [...argsWithoutOnlyIds, '--unfound-ids', unfoundFile]);
  assert.equal(unfoundWithoutIds.status, 2);

  fs.writeFileSync(idsPath, JSON.stringify({ not: 'an array' }));
  const notAnArray = runScript(importScript, [...baseArgs, '--dry-run']);
  assert.equal(notAnArray.status, 1);
  assert.match(notAnArray.stderr, /must hold a JSON array of Google id strings/);
  fs.writeFileSync(idsPath, '[]');
  const noIds = runScript(importScript, [...baseArgs, '--dry-run']);
  assert.equal(noIds.status, 1);
  assert.match(noIds.stderr, /lists no ids/);
});

test('import-drive-tree CLI: dry run, real run and usage errors', (t) => {
  const dir = makeTempDir(t);
  const fixture = buildTreeFixture(dir);
  const listingPath = path.join(dir, 'tree.lsjson');
  fs.writeFileSync(listingPath, JSON.stringify(fixture.listing));
  const dbPath = path.join(dir, 'cli.sqlite');
  const filesDir = path.join(dir, 'cli-files');
  const baseArgs = [
    '--listing', listingPath, '--dir', fixture.treeDir, '--root-id', 'mydrive-root', '--root-name', 'My Drive',
    '--by-id-dir', fixture.byIdDir, '--db', dbPath, '--files-dir', filesDir,
  ];
  const missingIdsPath = path.join(fixture.treeDir, 'missing-ids.txt');

  const dry = runScript(importScript, [...baseArgs, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, /^folders:\s+4\b/m);
  assert.match(dry.stdout, /^files:\s+7\b/m);
  assert.match(dry.stdout, /^duplicates:\s+6\b/m);
  assert.match(dry.stdout, /^missing:\s+2\b/m);
  assert.match(dry.stdout, /^WARN  Twins: 2 folders share this path/m);
  assert.match(dry.stdout, /first 2 missing ids:\n {2}idTripletSecond\n {2}idVanished\n/);
  assert.equal(fs.existsSync(dbPath), false, 'a dry run does not even create the database');
  assert.equal(fs.existsSync(filesDir), false);
  assert.equal(fs.existsSync(missingIdsPath), false);

  const real = runScript(importScript, baseArgs);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /^files:\s+7\b/m);
  assert.match(real.stdout, /rclone backend copyid gdrive:/);
  assert.equal(fs.readFileSync(missingIdsPath, 'utf8'), 'idTripletSecond\nidVanished\n');
  const storage = new Storage(dbPath);
  t.after(() => storage.close());
  assert.equal(readFileRows(storage).length, 11);
  assert.equal(fs.readFileSync(path.join(filesDir, 'idTwinSecond'), 'utf8'), 'SECOND-TWIN-BYTES');

  const missingOption = runScript(importScript, ['--listing', listingPath]);
  assert.equal(missingOption.status, 2);
  assert.match(missingOption.stderr, /Usage: node tools\/import-drive-tree\.js/);
  const unknownOption = runScript(importScript, [...baseArgs, '--no-such-option']);
  assert.equal(unknownOption.status, 2);

  fs.writeFileSync(listingPath, JSON.stringify(fixture.listing).slice(0, 100));
  const truncated = runScript(importScript, [...baseArgs, '--dry-run']);
  assert.equal(truncated.status, 1);
  assert.match(truncated.stderr, /is not valid JSON \(is rclone still writing it\?\)/);
});

// ---------------------------------------------------------------------------
// rewrite-drive-links
// ---------------------------------------------------------------------------

const BASE_URL = 'https://app.example.com';

function insertFileRecord(storage, { id, name, isFolder = false }) {
  const stamp = '2026-01-01T00:00:00.000Z';
  storage.db.prepare(`
    INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at)
    VALUES (?, ?, ?, 0, NULL, ?, 1, 0, ?, ?)
  `).run(id, name, isFolder ? FOLDER_MIME : 'application/pdf', isFolder ? 1 : 0, stamp, stamp);
}

function seedSheet(storage, spreadsheetId, sheetName, grid) {
  storage.ensureSpreadsheet(spreadsheetId);
  storage.insertSheet(spreadsheetId, sheetName);
  storage.saveGrid(spreadsheetId, sheetName, grid);
}

function seedLocalFiles(storage) {
  insertFileRecord(storage, { id: 'fileOne', name: 'Report One.pdf' });
  insertFileRecord(storage, { id: 'fileTwo', name: 'تقرير.pdf' });
  insertFileRecord(storage, { id: 'fileThree', name: 'photo (1).jpg' });
  insertFileRecord(storage, { id: 'fileFour', name: 'avatar.png' });
  insertFileRecord(storage, { id: 'docOne', name: 'Exported letter.pdf' });
  insertFileRecord(storage, { id: 'folderOne', name: 'Archive', isFolder: true });
}

const localFile = (id, encodedName) => `${BASE_URL}/files/${id}/${encodedName}`;
const localFolder = (id) => `${BASE_URL}/files/folder/${id}`;

test('rewrite-drive-links: every link shape, and what is left alone', () => {
  const filesById = new Map([
    ['fileOne', { id: 'fileOne', name: 'Report One.pdf', is_folder: 0 }],
    ['fileTwo', { id: 'fileTwo', name: 'تقرير.pdf', is_folder: 0 }],
    ['fileThree', { id: 'fileThree', name: 'photo (1).jpg', is_folder: 0 }],
    ['folderOne', { id: 'folderOne', name: 'Archive', is_folder: 1 }],
    ['docOne', { id: 'docOne', name: 'Exported letter.pdf', is_folder: 0 }],
  ]);
  const reportOne = localFile('fileOne', 'Report%20One.pdf');
  const arabicReport = localFile('fileTwo', encodeURIComponent('تقرير.pdf'));
  const rewrites = [
    ['https://drive.google.com/file/d/fileOne/view?usp=drivesdk', reportOne],
    ['https://drive.google.com/file/d/fileOne', reportOne],
    ['https://drive.google.com/file/u/0/d/fileOne/view', reportOne],
    ['https://drive.google.com/open?id=fileTwo', arabicReport],
    ['https://drive.google.com/open?usp=sharing&id=fileTwo', arabicReport],
    ['https://drive.google.com/open?usp=sharing&amp;id=fileTwo', arabicReport],
    ['https://drive.google.com/uc?export=download&id=fileThree', localFile('fileThree', 'photo%20(1).jpg')],
    ['https://drive.google.com/uc?id=fileOne&export=view', reportOne],
    ['https://drive.google.com/thumbnail?id=fileOne&sz=w500', reportOne],
    ['https://drive.google.com/drive/folders/folderOne', localFolder('folderOne')],
    ['https://drive.google.com/drive/folders/folderOne?usp=sharing', localFolder('folderOne')],
    ['https://drive.google.com/drive/u/1/folders/folderOne', localFolder('folderOne')],
    // The old open?id= form is used for folders too: the local record decides the URL.
    ['https://drive.google.com/open?id=folderOne', localFolder('folderOne')],
    ['https://docs.google.com/document/d/docOne/edit?usp=drivesdk&ouid=1&rtpof=true&sd=true', localFile('docOne', 'Exported%20letter.pdf')],
    ['http://drive.google.com/file/d/fileOne/view', reportOne],
    // Text around the links stays, including the sentence's own punctuation.
    ['راجع https://drive.google.com/file/d/fileOne/view.', 'راجع ' + reportOne + '.'],
    ['a: https://drive.google.com/file/d/fileOne/view, b: https://drive.google.com/drive/folders/folderOne;', `a: ${reportOne}, b: ${localFolder('folderOne')};`],
    // Links glued together by a comma are two links.
    ['https://drive.google.com/file/d/fileOne/view,https://drive.google.com/drive/folders/folderOne', `${reportOne},${localFolder('folderOne')}`],
    ['<a href="https://drive.google.com/file/d/fileOne/view">x</a> (https://drive.google.com/drive/folders/folderOne)', `<a href="${reportOne}">x</a> (${localFolder('folderOne')})`],
    ['line one https://drive.google.com/file/d/fileOne/view\nline two https://drive.google.com/open?id=fileTwo', `line one ${reportOne}\nline two ${arabicReport}`],
  ];
  for (const [input, expected] of rewrites) {
    const outcome = rewriteLinksInText(input, { filesById, baseUrl: BASE_URL });
    assert.equal(outcome.text, expected, input);
    assert.deepEqual(outcome.unresolvedIds, [], input);
  }

  const unresolved = [
    ['https://drive.google.com/file/d/ghostFile/view?usp=drivesdk', 'ghostFile'],
    ['https://drive.google.com/open?id=ghostFile', 'ghostFile'],
    ['https://drive.google.com/uc?export=download&id=ghostFile', 'ghostFile'],
    ['https://drive.google.com/thumbnail?id=ghostFile&sz=w500', 'ghostFile'],
    ['https://drive.google.com/drive/folders/ghostFile?usp=sharing', 'ghostFile'],
    ['https://docs.google.com/spreadsheets/d/ghostFile/edit#gid=0', 'ghostFile'],
    ['https://docs.google.com/presentation/d/ghostFile/edit', 'ghostFile'],
    ['https://docs.google.com/document/d/e/2PACX-published/pub', '2PACX-published'],
  ];
  for (const [input, id] of unresolved) {
    const outcome = rewriteLinksInText(input, { filesById, baseUrl: BASE_URL });
    assert.equal(outcome.text, input, 'left as it is: ' + input);
    assert.equal(outcome.rewritten, 0);
    assert.deepEqual(outcome.unresolvedIds, [id], input);
  }

  const noDriveId = rewriteLinksInText('see https://drive.google.com/drive/my-drive now', { filesById, baseUrl: BASE_URL });
  assert.equal(noDriveId.text, 'see https://drive.google.com/drive/my-drive now');
  assert.deepEqual(noDriveId.unrecognizedUrls, ['https://drive.google.com/drive/my-drive']);

  const otherHost = rewriteLinksInText('https://maps.app.goo.gl/PgRKH2qBMMLJhEEz5?g_st=ic', { filesById, baseUrl: BASE_URL });
  assert.equal(otherHost.text, 'https://maps.app.goo.gl/PgRKH2qBMMLJhEEz5?g_st=ic');
  assert.deepEqual([otherHost.rewritten, otherHost.unresolvedIds, otherHost.unrecognizedUrls], [0, [], []]);

  // One cell, one resolvable and one unknown link.
  const mixed = rewriteLinksInText('https://drive.google.com/file/d/fileOne/view https://drive.google.com/file/d/ghostFile/view', { filesById, baseUrl: BASE_URL });
  assert.equal(mixed.text, `${reportOne} https://drive.google.com/file/d/ghostFile/view`);
  assert.equal(mixed.rewritten, 1);
  assert.deepEqual(mixed.unresolvedIds, ['ghostFile']);
});

const studentsHeader = ['cpr', 'card', 'folder', 'avatarUrl', 'notes', 'age', 'joined', 'active'];
const joined = new Date('2024-03-05T10:20:30.000Z');
const answeredAt = new Date('2025-05-06T07:08:09.000Z');

function studentsGrid() {
  return [
    studentsHeader,
    ['001', 'https://drive.google.com/file/d/fileOne/view?usp=drivesdk', 'https://drive.google.com/drive/folders/folderOne?usp=sharing',
      'https://drive.google.com/thumbnail?id=fileFour&sz=w500', '', 17, joined, true],
    ['002', 'https://drive.google.com/open?id=fileTwo', 'https://drive.google.com/drive/u/1/folders/folderOne',
      'https://drive.google.com/uc?export=view&id=fileThree',
      'الملف https://drive.google.com/file/d/fileOne/view?usp=sharing، والمجلد https://drive.google.com/drive/folders/folderOne ثم اللقاء.', 18, joined, false],
    ['003', 'https://drive.google.com/file/d/ghostFile/view?usp=drivesdk', 'https://drive.google.com/drive/folders/ghostFolder',
      'https://drive.google.com/thumbnail?id=ghostThumb&sz=w500', 'https://docs.google.com/document/d/docOne/edit', '', '', ''],
    ['004', 'https://drive.google.com/file/d/ghostFile/view?usp=drivesdk', 'no link here', 'https://drive.google.com/file/d/ghostAvatar/view',
      'https://docs.google.com/spreadsheets/d/ghostSheet/edit#gid=0 and https://maps.app.goo.gl/PgRKH2qBMMLJhEEz5?g_st=ic', 987654321, joined, true],
    ['005', '', '', '', 'https://drive.google.com/drive/my-drive', 0, '', false],
  ];
}

function answersGrid() {
  return [
    ['time', 'certificate'],
    [answeredAt, 'https://drive.google.com/file/d/ghostCert/view'],
    [answeredAt, 'https://drive.google.com/file/d/ghostCert2/view?usp=drive_link'],
  ];
}

function expectedStudentsGrid() {
  const rewritten = studentsGrid();
  rewritten[1][1] = localFile('fileOne', 'Report%20One.pdf');
  rewritten[1][2] = localFolder('folderOne');
  rewritten[1][3] = localFile('fileFour', 'avatar.png');
  rewritten[2][1] = localFile('fileTwo', encodeURIComponent('تقرير.pdf'));
  rewritten[2][2] = localFolder('folderOne');
  rewritten[2][3] = localFile('fileThree', 'photo%20(1).jpg');
  rewritten[2][4] = `الملف ${localFile('fileOne', 'Report%20One.pdf')}، والمجلد ${localFolder('folderOne')} ثم اللقاء.`;
  rewritten[3][4] = localFile('docOne', 'Exported%20letter.pdf');
  return rewritten;
}

const expectedUnresolved = [
  { spreadsheet: 'mainData', sheet: 'students', column: 'card', count: 2, sampleIds: ['ghostFile'] },
  { spreadsheet: 'mainData', sheet: 'students', column: 'folder', count: 1, sampleIds: ['ghostFolder'] },
  { spreadsheet: 'mainData', sheet: 'students', column: 'avatarUrl', count: 2, sampleIds: ['ghostThumb', 'ghostAvatar'] },
  { spreadsheet: 'mainData', sheet: 'students', column: 'notes', count: 1, sampleIds: ['ghostSheet'] },
  { spreadsheet: 'answersData', sheet: 'answers', column: 'certificate', count: 2, sampleIds: ['ghostCert', 'ghostCert2'] },
];

function seedLinkedWorkbook(storage) {
  seedLocalFiles(storage);
  seedSheet(storage, IDS.mainData, 'students', studentsGrid());
  seedSheet(storage, IDS.answersData, 'answers', answersGrid());
}

test('rewrite-drive-links: rewrites resolvable links only, keeps every other cell, reports the rest', (t) => {
  const dir = makeTempDir(t);
  const dbPath = path.join(dir, 'links.sqlite');
  const storage = new Storage(dbPath);
  t.after(() => storage.close());
  seedLinkedWorkbook(storage);
  const cellCount = studentsGrid().flat().length + answersGrid().flat().length;

  // The trailing slash on the base url is tolerated.
  const report = rewriteDriveLinks({ storage, baseUrl: BASE_URL + '/' });

  assert.deepEqual(report.totals, {
    cellsScanned: cellCount,
    cellsChanged: 8, // row 2: 3, row 3: 4, row 4: 1
    linksRewritten: 9, // row 2: 3, row 3: 3 + 2 inside the notes, row 4: 1
    linksUnresolved: 8,
    linksUnrecognized: 1,
  });
  assert.equal(report.baseUrl, BASE_URL);
  assert.equal(report.dryRun, false);
  assert.deepEqual(report.unresolved, expectedUnresolved);
  assert.deepEqual(report.unrecognized, [
    { spreadsheet: 'mainData', sheet: 'students', column: 'notes', count: 1, samples: ['https://drive.google.com/drive/my-drive'] },
  ]);

  // Strict deep equality: numbers, booleans, Dates and blanks must come back exactly as they were.
  assert.deepEqual(storage.loadGrid(IDS.mainData, 'students'), expectedStudentsGrid());
  assert.deepEqual(storage.loadGrid(IDS.answersData, 'answers'), answersGrid());

  // What reached the database is what a fresh connection reads back.
  const reopened = new Storage(dbPath);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.loadGrid(IDS.mainData, 'students'), expectedStudentsGrid());
  assert.deepEqual(reopened.loadGrid(IDS.answersData, 'answers'), answersGrid());

  // A second run finds nothing left to rewrite and the same links still pointing at Google.
  const again = rewriteDriveLinks({ storage, baseUrl: BASE_URL });
  assert.deepEqual(again.totals, { ...report.totals, cellsChanged: 0, linksRewritten: 0 });
  assert.deepEqual(again.unresolved, expectedUnresolved);
  assert.deepEqual(storage.loadGrid(IDS.mainData, 'students'), expectedStudentsGrid());
});

test('rewrite-drive-links: a dry run counts the same and changes nothing', (t) => {
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  seedLinkedWorkbook(storage);
  const versionOf = (spreadsheetId, sheetName) => storage.db.prepare('SELECT version FROM sheet_versions WHERE ss = ? AND sheet = ?').pluck().get(spreadsheetId, sheetName);
  const studentsBefore = structuredClone(storage.loadGrid(IDS.mainData, 'students'));
  const versionBefore = versionOf(IDS.mainData, 'students');

  const dryReport = rewriteDriveLinks({ storage, baseUrl: BASE_URL, dryRun: true });

  assert.equal(dryReport.dryRun, true);
  assert.equal(dryReport.totals.cellsChanged, 8);
  assert.equal(dryReport.totals.linksRewritten, 9);
  assert.deepEqual(storage.loadGrid(IDS.mainData, 'students'), studentsBefore);
  assert.deepEqual(storage.loadGrid(IDS.mainData, 'students'), studentsGrid());
  assert.equal(versionOf(IDS.mainData, 'students'), versionBefore, 'no write happened');

  const realReport = rewriteDriveLinks({ storage, baseUrl: BASE_URL });
  assert.deepEqual({ ...dryReport, dryRun: false }, realReport);
});

test('rewrite-drive-links: writes one putRows call per run of consecutive changed rows', (t) => {
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  insertFileRecord(storage, { id: 'fileOne', name: 'a.pdf' });
  const link = 'https://drive.google.com/file/d/fileOne/view';
  const grid = [['card'], [link], [link], ['plain'], [link], ['plain'], [link], [link], [link]];
  seedSheet(storage, IDS.mainData, 'cards', grid);
  const writes = [];
  const originalPutRows = storage.putRows.bind(storage);
  storage.putRows = (spreadsheetId, sheetName, startRow, rows) => {
    writes.push([startRow, rows.length]);
    originalPutRows(spreadsheetId, sheetName, startRow, rows);
  };

  const report = rewriteDriveLinks({ storage, baseUrl: BASE_URL });

  assert.deepEqual(writes, [[2, 2], [5, 1], [7, 3]]);
  assert.equal(report.totals.cellsChanged, 6);
  const expectedCell = localFile('fileOne', 'a.pdf');
  assert.deepEqual(storage.loadGrid(IDS.mainData, 'cards'), [['card'], [expectedCell], [expectedCell], ['plain'], [expectedCell], ['plain'], [expectedCell], [expectedCell], [expectedCell]]);
});

test('rewrite-drive-links: an unnamed column is reported by its letter and a bad base url is refused', (t) => {
  const storage = new Storage(':memory:');
  t.after(() => storage.close());
  seedSheet(storage, IDS.refID, 'links', [['a', 'b', ''], ['', '', 'https://drive.google.com/file/d/ghostFile/view']]);

  const report = rewriteDriveLinks({ storage, baseUrl: BASE_URL });
  assert.deepEqual(report.unresolved, [{ spreadsheet: 'refID', sheet: 'links', column: '(column C)', count: 1, sampleIds: ['ghostFile'] }]);

  for (const badBaseUrl of ['', 'app.example.com', 'ftp://app.example.com', 'https://', 'https://app example.com']) {
    assert.throws(() => rewriteDriveLinks({ storage, baseUrl: badBaseUrl }), /--base-url must look like/, badBaseUrl);
  }
  // A base url may carry a path prefix.
  seedLocalFiles(storage);
  seedSheet(storage, IDS.refID, 'prefixed', [['x'], ['https://drive.google.com/drive/folders/folderOne']]);
  rewriteDriveLinks({ storage, baseUrl: 'https://example.com/basaer/' });
  assert.equal(storage.loadGrid(IDS.refID, 'prefixed')[1][0], 'https://example.com/basaer/files/folder/folderOne');
});

test('rewrite-drive-links CLI: dry run with a report, real run and usage errors', (t) => {
  const dir = makeTempDir(t);
  const dbPath = path.join(dir, 'cli-links.sqlite');
  const seeding = new Storage(dbPath);
  seedLinkedWorkbook(seeding);
  seeding.close();
  const reportPath = path.join(dir, 'report.json');

  const dry = runScript(rewriteScript, ['--base-url', BASE_URL, '--db', dbPath, '--dry-run', '--report', reportPath]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN/);
  assert.match(dry.stdout, /^cells changed:\s+8$/m);
  assert.match(dry.stdout, /^links rewritten:\s+9$/m);
  assert.match(dry.stdout, /^links unresolved:\s+8$/m);
  assert.match(dry.stdout, /mainData \/ students \/ card: 2 \(e\.g\. ghostFile\)/);
  const dryReport = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(dryReport.dryRun, true);
  assert.deepEqual(dryReport.unresolved, expectedUnresolved);
  const afterDry = new Storage(dbPath);
  t.after(() => afterDry.close());
  assert.deepEqual(afterDry.loadGrid(IDS.mainData, 'students'), studentsGrid());

  const real = runScript(rewriteScript, ['--base-url', BASE_URL, '--db', dbPath, '--report', reportPath]);
  assert.equal(real.status, 0, real.stderr);
  assert.equal(JSON.parse(fs.readFileSync(reportPath, 'utf8')).dryRun, false);
  const afterReal = new Storage(dbPath);
  t.after(() => afterReal.close());
  assert.deepEqual(afterReal.loadGrid(IDS.mainData, 'students'), expectedStudentsGrid());

  const noBaseUrl = runScript(rewriteScript, ['--db', dbPath]);
  assert.equal(noBaseUrl.status, 2);
  assert.match(noBaseUrl.stderr, /Usage: node tools\/rewrite-drive-links\.js/);
  const badBaseUrl = runScript(rewriteScript, ['--base-url', 'nonsense', '--db', dbPath]);
  assert.equal(badBaseUrl.status, 1);
  assert.match(badBaseUrl.stderr, /--base-url must look like/);
  const noDatabase = runScript(rewriteScript, ['--base-url', BASE_URL, '--db', path.join(dir, 'typo', 'nothing.sqlite'), '--dry-run']);
  assert.equal(noDatabase.status, 1);
  assert.match(noDatabase.stderr, /database not found/);
  assert.equal(fs.existsSync(path.join(dir, 'typo')), false, 'a mistyped --db must not create a database');
});
