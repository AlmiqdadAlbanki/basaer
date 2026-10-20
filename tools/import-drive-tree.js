'use strict';

// Imports an `rclone lsjson -R` tree (all of My Drive, or Shared with me) into the local file
// store, keeping every ORIGINAL Google id, so the links the sheets still hold
// (.../file/d/<id>, .../folders/<id>) can be pointed at the local copies afterwards
// (tools/rewrite-drive-links.js).
//
//   node tools/import-drive-tree.js --listing <tree.lsjson> --dir <copied tree dir>
//                                   --root-id <id> --root-name <name> [--by-id-dir <dir>]
//                                   [--only-ids <ids.json>] [--unfound-ids <out file>]
//                                   [--db <path>] [--files-dir <dir>] [--dry-run]
//   node tools/import-drive-tree.js --listing <tree.lsjson> --only-ids <ids.json>
//                                   --list-paths <out file> [--unfound-ids <out file>]
//
//   --listing    the rclone lsjson -R output for the tree
//   --dir        the directory rclone copied that tree into; bytes are read from <dir>/<Path>
//   --root-id    id of the folder row the tree hangs under. It may be synthetic (e.g.
//                mydrive-root for an account root): the top-level entries become its children
//   --root-name  name of that row
//   --by-id-dir  single files fetched by id (rclone backend copyid); bytes are read from
//                <by-id-dir>/<ID>
//   --only-ids   a JSON array of Google ids, everything the sheets reference: only that part of
//                the tree is imported (see below)
//   --list-paths with --only-ids: writes the Paths of the files that would be imported, one per
//                line, and exits without importing (see below)
//   --unfound-ids  with --only-ids: writes the referenced ids that appear nowhere in the listing
//   --dry-run    reads only: prints the same counts and the first 10 missing ids, writes nothing
//                (but the files --list-paths and --unfound-ids name)
//
// Only what is referenced. Every imported row is public (the Drive files were anyone-with-link,
// and the sheets and WhatsApp messages hold bare links to them), so a whole tree must not be
// imported blindly. With --only-ids an entry is imported when (a) its own id is in the list, (b)
// a folder above it on its Path is in the list (the whole subtree below a referenced folder comes
// along), or (c) it is the root row. Everything else is skipped and counted as "skipped (not
// referenced)". The folders above everything imported are imported too, as private rows with no
// bytes (is_public 0), so no imported row has a parent that is missing from the store (a
// placeholder made later by DriveApp.getFolderById would not know the real folder name). Their
// siblings stay skipped. They are counted separately as "ancestor folders". An ancestor row that
// already exists keeps its flags (public, trashed); only its name and parent are refreshed. Where
// several folders share a path, the children go to the referenced one.
//
// --list-paths lets the operator copy only that part before importing it:
//
//   rclone copy gdrive: <dir> --files-from <out file> --drive-export-formats pdf
//
// (the same remote and root the listing was made from). Two kinds of file are left out of the list
// and fetched by id instead: those whose Path is shared by several entries (rclone cannot pick
// between the siblings) and those whose Path cannot be one line of a --files-from file (a newline,
// edge whitespace or a leading # or ;). Importing afterwards puts their ids in missing-ids.txt.
//
// Duplicate names. Google Drive lets two siblings share a name, but rclone copy writes by path,
// so of two entries with one Path only one can be on disk, and nothing says which. A file whose
// Path is shared by more than one entry is therefore never read from <dir>/<Path>; its bytes
// must be at <by-id-dir>/<ID>. Any other file whose bytes are absent from <dir> falls back to
// <by-id-dir>/<ID> as well. Files found nowhere are counted as missing and their ids written to
// <dir>/missing-ids.txt, one per line (the file is removed again once nothing is missing).
// To fetch them and finish the import:
//
//   while read id; do rclone backend copyid gdrive: "$id" <by-id-dir>/"$id" --drive-export-formats pdf; done < <dir>/missing-ids.txt
//   node tools/import-drive-tree.js ... --by-id-dir <by-id-dir>
//
// Running it again is safe: rows are upserted by id, so a repeat only adds what was missing.
//
// A listing gives each entry only its Path, never its parent's id. Children of a folder path
// shared by several folders therefore cannot be told apart; they are attached to one of those
// folders and counted as ambiguous parents (the files themselves are unaffected).
//
// rclone follows shortcuts and lists one as "<target id>\t<shortcut id>": that entry is stored
// under the target id, the real item the sheets link to. A dangling shortcut (a pointer with
// nothing behind it) has no bytes and is skipped, and so is an id met a second time in the
// listing (the first one listed wins). Both are counted under "skipped".
//
// Bytes are copied to <files-dir>/<ID> first, then every row is written in ONE transaction. The
// SQLite write lock (the live server waits only 5 s for it) is held for a moment instead of the
// minutes copying can take, and a row never shows up without its bytes. Rows are written by
// upsertFileRow from tools/import-google-exports.js, which marks them public.

const fs = require('fs');
const path = require('path');
const { parseArgs: parseCommandLine } = require('util');
const { Storage } = require('../server/storage.js');
const { DEFAULT_DB } = require('./xlsx-common.js');
const { upsertFileRow } = require('./import-google-exports.js');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
// Pointers, not files: rclone lists a dangling shortcut with no bytes behind it.
const SHORTCUT_MIME_PREFIX = 'application/vnd.google-apps.shortcut';
// The same ids the server serves (/files/<id>); they also double as safe file names.
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MISSING_IDS_FILE_NAME = 'missing-ids.txt';
const MISSING_IDS_SHOWN = 10;
const COPY_PROGRESS_EVERY = 1000;

const USAGE = 'Usage: node tools/import-drive-tree.js --listing <tree.lsjson> --dir <copied tree dir> --root-id <id> --root-name <name>\n'
  + '         [--by-id-dir <dir>] [--only-ids <ids.json>] [--unfound-ids <out file>] [--db <path>] [--files-dir <dir>] [--dry-run]\n'
  + '       node tools/import-drive-tree.js --listing <tree.lsjson> --only-ids <ids.json> --list-paths <out file> [--unfound-ids <out file>]';

function isGoogleNative_(entry) {
  return String(entry.MimeType || '').startsWith(GOOGLE_NATIVE_PREFIX);
}

function isShortcut_(entry) {
  return String(entry.MimeType || '').startsWith(SHORTCUT_MIME_PREFIX);
}

// rclone lists a shortcut it follows with the id "<target id>\t<shortcut id>". The target is the
// real folder or file, the one the sheets link to; the shortcut is only a pointer in My Drive.
function entryId_(entry) {
  return typeof entry.ID === 'string' ? entry.ID.split('\t')[0] : '';
}

// Whether a Path survives as one line of an rclone --files-from file, which skips comment lines
// (# and ;) and trims whitespace.
function isLineSafePath_(entryPath) {
  return !/[\r\n]/.test(entryPath) && entryPath === entryPath.trim() && !/^[#;]/.test(entryPath);
}

// { filePath, size } when baseDir/relativePath is a regular file that really lies inside
// baseDir (a Drive name such as ".." must not lead out of it), else null.
function findRegularFile_(baseDir, relativePath) {
  const filePath = path.resolve(baseDir, relativePath);
  const fromBase = path.relative(baseDir, filePath);
  if (fromBase === '' || fromBase === '..' || fromBase.startsWith('..' + path.sep) || path.isAbsolute(fromBase)) return null;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { filePath, size: stat.size } : null;
  } catch (_) {
    return null;
  }
}

// { filePath, size, fromById } for the bytes of one file entry, or null when nowhere to be found.
function locateBytes_(entry, id, entryIsDuplicate, sourceDir, byIdDir) {
  if (!entryIsDuplicate) {
    // Google-native files were exported as PDF; rclone names them <name>.pdf, but the listing
    // may or may not already show that suffix, so try both.
    const candidates = isGoogleNative_(entry) ? [entry.Path, entry.Path + '.pdf'] : [entry.Path];
    for (const candidate of candidates) {
      const found = findRegularFile_(sourceDir, candidate);
      if (found) return { ...found, fromById: false };
    }
  }
  if (byIdDir) {
    const found = findRegularFile_(byIdDir, id);
    if (found) return { ...found, fromById: true };
  }
  return null;
}

function checkListing_(listing, rootId) {
  if (!Array.isArray(listing)) throw new Error('the listing must be the JSON array printed by rclone lsjson -R');
  for (const entry of listing) {
    if (!entry || typeof entry.Path !== 'string' || entry.Path === '') {
      throw new Error('listing entry without a Path: ' + JSON.stringify(entry).slice(0, 200));
    }
    const id = entryId_(entry);
    if (!FILE_ID_PATTERN.test(id)) {
      throw new Error('listing entry without a usable ID (was it made with rclone lsjson on a Drive remote?): ' + entry.Path);
    }
    if (id === rootId) throw new Error('--root-id ' + rootId + ' is also the id of the listing entry ' + entry.Path);
  }
}

function checkRoot_(rootId, rootName) {
  if (typeof rootId !== 'string' || !FILE_ID_PATTERN.test(rootId)) {
    throw new Error('--root-id must be 1-128 letters, digits, "_" or "-": ' + rootId);
  }
  if (!rootName) throw new Error('--root-name is required');
}

// Without a reference list every entry is covered. With one an entry is covered by its own id or
// by a folder above it. Folders that share a path cannot be told apart, so the path counts as
// referenced when ANY folder on it is: importing a little too much beats losing a file.
function makeReferenceTest_(referencedIds, foldersByPath) {
  if (!referencedIds) return () => true;
  const coveredByPath = new Map();
  const isPathCovered = (folderPath) => {
    let covered = coveredByPath.get(folderPath);
    if (covered === undefined) {
      const parentPath = path.posix.dirname(folderPath);
      covered = (foldersByPath.get(folderPath) || []).some((folder) => referencedIds.has(folder.id))
        || (parentPath !== folderPath && isPathCovered(parentPath));
      coveredByPath.set(folderPath, covered);
    }
    return covered;
  };
  return (entry, id) => referencedIds.has(id) || isPathCovered(path.posix.dirname(entry.Path));
}

// Of the folders listed at one path (more than one when siblings share a name), the one the
// children hang from: a referenced one if there is one, else the first listed. null for a path
// that has no folder in the listing.
function pickFolder_(foldersByPath, referencedIds, folderPath) {
  const folders = foldersByPath.get(folderPath);
  if (!folders) return null;
  return (referencedIds && folders.find((folder) => referencedIds.has(folder.id))) || folders[0];
}

// With --only-ids: the folders above the chosen entries that are not chosen themselves, shallowest
// first. They are imported (private, no bytes) so no row has a parent that is missing from the
// store, and only the folders on the way up: their siblings stay skipped. Each was counted as
// skipped (not referenced), so it moves out of that count.
function findAncestorFolders_(chosen, foldersByPath, referencedIds, tally) {
  const chosenIds = new Set(chosen.map((item) => item.id));
  const ancestorIds = new Set();
  const visitedPaths = new Set();
  const ancestors = [];
  for (const { entry } of chosen) {
    for (let folderPath = path.posix.dirname(entry.Path); folderPath !== '.' && !visitedPaths.has(folderPath); folderPath = path.posix.dirname(folderPath)) {
      visitedPaths.add(folderPath);
      const folder = pickFolder_(foldersByPath, referencedIds, folderPath);
      // No folder at this path in the listing: what hangs below it hangs off the root, so the chain ends.
      if (!folder) break;
      if (chosenIds.has(folder.id) || ancestorIds.has(folder.id)) continue;
      ancestorIds.add(folder.id);
      ancestors.push(folder);
      tally.skippedNotReferenced--;
      tally.skippedFolders--;
    }
  }
  const depthOf = (item) => item.entry.Path.split('/').length;
  return ancestors.sort((a, b) => depthOf(a) - depthOf(b));
}

// Decides which listing entries the import covers, touching no disk: the --only-ids rule, then
// the shortcut and repeated-id rules. Returns them in listing order with everything counted on
// the way. Shared by the import and --list-paths so both always agree.
function selectEntries_(listing, referencedIds) {
  const entries = listing.map((entry) => ({ entry, id: entryId_(entry) }));
  const entriesPerPath = new Map();
  const foldersByPath = new Map();
  const listedIds = new Set();
  for (const item of entries) {
    const { entry, id } = item;
    listedIds.add(id);
    entriesPerPath.set(entry.Path, (entriesPerPath.get(entry.Path) || 0) + 1);
    if (!entry.IsDir) continue;
    const folders = foldersByPath.get(entry.Path);
    if (folders) folders.push(item);
    else foldersByPath.set(entry.Path, [item]);
  }

  const isReferenced = makeReferenceTest_(referencedIds, foldersByPath);
  const tally = { skippedNotReferenced: 0, skippedFolders: 0, skippedFiles: 0, skippedShortcuts: 0, repeatedIds: 0, duplicates: 0 };
  const duplicatePaths = new Set();
  const chosen = [];
  const seenIds = new Set();
  for (const item of entries) {
    const { entry, id } = item;
    if (!isReferenced(entry, id)) {
      tally.skippedNotReferenced++;
      if (entry.IsDir) tally.skippedFolders++;
      else tally.skippedFiles++;
      continue;
    }
    if (entriesPerPath.get(entry.Path) > 1) {
      tally.duplicates++;
      duplicatePaths.add(entry.Path);
    }
    // The same id twice (a followed shortcut lists its target again): the first one wins.
    if (seenIds.has(id)) { tally.repeatedIds++; continue; }
    seenIds.add(id);
    if (!entry.IsDir && isShortcut_(entry)) { tally.skippedShortcuts++; continue; }
    chosen.push(item);
  }
  tally.duplicatePaths = duplicatePaths.size;
  const ancestors = referencedIds ? findAncestorFolders_(chosen, foldersByPath, referencedIds, tally) : [];
  const unfoundIds = referencedIds ? [...referencedIds].filter((id) => !listedIds.has(id)) : [];
  return { chosen, ancestors, entriesPerPath, foldersByPath, tally, unfoundIds };
}

// Decides, without writing anything, what the import will do with the chosen entries: one item
// per row to write, plus the counts both the dry run and the real run report.
function planDriveTree_({ selection, referencedIds, rootId, sourceDir, byIdDir, log }) {
  const { chosen, ancestors, entriesPerPath, foldersByPath, tally, unfoundIds } = selection;
  const counts = {
    folders: 1, // the root
    files: 0,
    duplicates: tally.duplicates,
    duplicatePaths: tally.duplicatePaths,
    missing: 0,
    fromById: 0,
    skippedShortcuts: tally.skippedShortcuts,
    repeatedIds: tally.repeatedIds,
    ambiguousParents: 0,
    ancestorFolders: ancestors.length,
    skippedNotReferenced: tally.skippedNotReferenced,
    skippedFolders: tally.skippedFolders,
    skippedFiles: tally.skippedFiles,
    referencedIds: referencedIds ? referencedIds.size : null,
    unfoundIds,
    missingIds: [],
  };

  const entriesUnderSharedFolder = new Map();
  // The id of the folder an entry hangs from: the root for a top-level entry or one whose folder
  // is not in the listing.
  const parentIdOf = (entry) => {
    const parentPath = path.posix.dirname(entry.Path);
    const parentFolder = parentPath === '.' ? null : pickFolder_(foldersByPath, referencedIds, parentPath);
    if (!parentFolder) return rootId;
    if (foldersByPath.get(parentPath).length > 1) {
      counts.ambiguousParents++;
      const shared = entriesUnderSharedFolder.get(parentPath) || { entryCount: 0, attachedTo: parentFolder.id };
      shared.entryCount++;
      entriesUnderSharedFolder.set(parentPath, shared);
    }
    return parentFolder.id;
  };

  const items = [];
  for (const { entry, id } of ancestors) {
    items.push({
      id,
      name: entry.Name || path.posix.basename(entry.Path),
      mime: FOLDER_MIME,
      size: 0,
      parentId: parentIdOf(entry),
      isFolder: true,
      ancestorOnly: true,
      sourceFile: null,
    });
  }
  for (const { entry, id } of chosen) {
    const parentId = parentIdOf(entry);
    const name = entry.Name || path.posix.basename(entry.Path);
    if (entry.IsDir) {
      counts.folders++;
      items.push({ id, name, mime: FOLDER_MIME, size: 0, parentId, isFolder: true, sourceFile: null });
      continue;
    }

    const located = locateBytes_(entry, id, entriesPerPath.get(entry.Path) > 1, sourceDir, byIdDir);
    if (!located) {
      counts.missing++;
      counts.missingIds.push(id);
      continue;
    }
    counts.files++;
    if (located.fromById) counts.fromById++;
    const isNative = isGoogleNative_(entry);
    items.push({
      id,
      name: isNative && !/\.pdf$/i.test(name) ? name + '.pdf' : name,
      mime: isNative ? 'application/pdf' : (entry.MimeType || 'application/octet-stream'),
      size: located.size,
      parentId,
      isFolder: false,
      sourceFile: located.filePath,
    });
  }

  for (const [folderPath, shared] of entriesUnderSharedFolder) {
    const folderIds = foldersByPath.get(folderPath).map((folder) => folder.id);
    log('WARN  ' + folderPath + ': ' + folderIds.length + ' folders share this path (' + folderIds.join(', ') + '); '
      + shared.entryCount + ' item(s) below it were attached to ' + shared.attachedTo);
  }
  return { items, counts };
}

// A folder that is only there because something imported hangs below it: private, no bytes.
// upsertFileRow marks every row public, so this has its own insert. A row that already exists
// (public, trashed, or the "Legacy folder <id>" placeholder the Drive shim makes) keeps its flags
// and only gets the real name and parent.
function upsertAncestorFolderRow_(storage, row) {
  storage.db.prepare(`
    INSERT INTO files (id, name, mime, size, parent_id, is_folder, is_public, trashed, created_at, updated_at)
    VALUES (@id, @name, @mime, 0, @parent_id, 1, 0, 0, @now, @now)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, mime = excluded.mime, parent_id = excluded.parent_id,
      is_folder = 1, updated_at = excluded.updated_at
  `).run({ id: row.id, name: row.name, mime: row.mime, parent_id: row.parent_id, now: new Date().toISOString() });
}

function writeItems_({ storage, filesDir, rootId, rootName, items, log }) {
  fs.mkdirSync(filesDir, { recursive: true });
  const filesToCopy = items.filter((item) => !item.isFolder);
  filesToCopy.forEach((item, index) => {
    const destination = path.join(filesDir, item.id);
    // --by-id-dir may be the file store itself (<files-dir>/<id>): nothing to copy then.
    if (path.resolve(item.sourceFile) !== path.resolve(destination)) fs.copyFileSync(item.sourceFile, destination);
    if ((index + 1) % COPY_PROGRESS_EVERY === 0) log('copied ' + (index + 1) + ' of ' + filesToCopy.length + ' files');
  });
  const writeAllRows = storage.db.transaction(() => {
    upsertFileRow(storage, { id: rootId, name: rootName, mime: FOLDER_MIME, size: 0, parent_id: null, is_folder: 1 });
    for (const item of items) {
      const row = { id: item.id, name: item.name, mime: item.mime, size: item.size, parent_id: item.parentId, is_folder: item.isFolder ? 1 : 0 };
      if (item.ancestorOnly) upsertAncestorFolderRow_(storage, row);
      else upsertFileRow(storage, row);
    }
  });
  writeAllRows.immediate();
}

// Writes (or, with nothing missing, removes) the list the operator feeds to rclone copyid.
function writeMissingIdsFile_(missingIdsPath, missingIds) {
  if (missingIds.length === 0) fs.rmSync(missingIdsPath, { force: true });
  else fs.writeFileSync(missingIdsPath, missingIds.join('\n') + '\n');
}

// A file the operator asked for by name: one line each, empty for an empty list.
function writeLinesFile_(filePath, lines) {
  fs.writeFileSync(filePath, lines.length ? lines.join('\n') + '\n' : '');
}

// Library entry point. With dryRun, storage and filesDir are not used (and may be omitted) and
// nothing is written anywhere. onlyIds (any iterable of Google ids) limits the import to what is
// referenced. Returns the counts the CLI prints, including missingIds and unfoundIds.
function importDriveTree({ storage, filesDir, rootId, rootName, listing, sourceDir, byIdDir, onlyIds, missingIdsPath, dryRun = false, log = () => {} }) {
  checkRoot_(rootId, rootName);
  checkListing_(listing, rootId);
  const resolvedSourceDir = path.resolve(sourceDir);
  const resolvedByIdDir = byIdDir ? path.resolve(byIdDir) : null;
  if (resolvedByIdDir && !fs.existsSync(resolvedByIdDir)) {
    log('NOTE  ' + resolvedByIdDir + ' does not exist yet, so no file can come from it');
  }
  const referencedIds = onlyIds ? new Set(onlyIds) : null;
  const selection = selectEntries_(listing, referencedIds);
  const { items, counts } = planDriveTree_({ selection, referencedIds, rootId, sourceDir: resolvedSourceDir, byIdDir: resolvedByIdDir, log });
  if (!dryRun) {
    writeItems_({ storage, filesDir: path.resolve(filesDir), rootId, rootName, items, log });
    if (missingIdsPath) writeMissingIdsFile_(missingIdsPath, counts.missingIds);
  }
  return counts;
}

// Library entry point for --list-paths: the Paths of the files the import would cover, as lines
// of an rclone --files-from file, reading no disk. Files whose Path is shared by several entries
// and Paths that cannot be one line are left out (they are fetched by id).
function listPathsToCopy({ listing, onlyIds }) {
  checkListing_(listing);
  const referencedIds = onlyIds ? new Set(onlyIds) : null;
  const selection = selectEntries_(listing, referencedIds);
  const result = {
    paths: [],
    selectedFiles: 0,
    sharedPathFiles: 0,
    unlistablePathFiles: 0,
    referencedIds: referencedIds ? referencedIds.size : null,
    unfoundIds: selection.unfoundIds,
  };
  for (const { entry } of selection.chosen) {
    if (entry.IsDir) continue;
    result.selectedFiles++;
    if (selection.entriesPerPath.get(entry.Path) > 1) result.sharedPathFiles++;
    else if (!isLineSafePath_(entry.Path)) result.unlistablePathFiles++;
    else result.paths.push(entry.Path);
  }
  return result;
}

function readListing_(listingPath) {
  let text;
  try {
    text = fs.readFileSync(listingPath, 'utf8');
  } catch (error) {
    throw new Error('cannot read the listing: ' + error.message);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(listingPath + ' is not valid JSON (is rclone still writing it?): ' + String(error.message).slice(0, 200));
  }
}

function readOnlyIds_(onlyIdsPath) {
  let ids;
  try {
    ids = JSON.parse(fs.readFileSync(onlyIdsPath, 'utf8'));
  } catch (error) {
    throw new Error('cannot read --only-ids ' + onlyIdsPath + ': ' + String(error.message).slice(0, 200));
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new Error(onlyIdsPath + ' must hold a JSON array of Google id strings');
  }
  const referencedIds = new Set(ids.map((id) => id.trim()).filter((id) => id !== ''));
  if (referencedIds.size === 0) throw new Error(onlyIdsPath + ' lists no ids, so nothing would be imported');
  return referencedIds;
}

function referencedLine_(referencedCount, unfoundCount) {
  return 'referenced ids: ' + referencedCount + ' (' + (referencedCount - unfoundCount) + ' in the listing, ' + unfoundCount + ' not found)';
}

function summaryLines_(counts, { dryRun, missingIdsPath, byIdDir }) {
  const lines = [];
  if (dryRun) lines.push('DRY RUN: nothing was written');
  if (counts.referencedIds !== null) lines.push(referencedLine_(counts.referencedIds, counts.unfoundIds.length));
  lines.push('folders:    ' + counts.folders + ' (including the root)');
  lines.push('files:      ' + counts.files + (counts.fromById ? ' (' + counts.fromById + ' from the by-id dir)' : ''));
  lines.push('duplicates: ' + counts.duplicates + (counts.duplicates ? ' (entries sharing ' + counts.duplicatePaths + ' paths)' : ''));
  lines.push('missing:    ' + counts.missing);
  if (counts.referencedIds !== null) {
    lines.push('selected:   ' + (counts.folders - 1) + ' folders, ' + (counts.files + counts.missing) + ' files');
    lines.push('ancestor folders: ' + counts.ancestorFolders + ' (private, no bytes: the folders above what is selected)');
    lines.push('skipped (not referenced): ' + counts.skippedNotReferenced + ' (' + counts.skippedFolders + ' folders, ' + counts.skippedFiles + ' files)');
  }
  if (counts.skippedShortcuts || counts.repeatedIds) {
    lines.push('skipped:    ' + counts.skippedShortcuts + ' shortcut(s), ' + counts.repeatedIds + ' repeated id(s)');
  }
  if (counts.ambiguousParents) {
    lines.push('ambiguous parents: ' + counts.ambiguousParents + ' entries below a folder path shared by several folders');
  }
  if (counts.missing) {
    lines.push('first ' + Math.min(MISSING_IDS_SHOWN, counts.missing) + ' missing ids:');
    for (const id of counts.missingIds.slice(0, MISSING_IDS_SHOWN)) lines.push('  ' + id);
    const fetchTarget = byIdDir || '<by-id-dir>';
    lines.push(dryRun ? 'A real run writes all ' + counts.missing + ' ids to ' + missingIdsPath : 'All ' + counts.missing + ' ids are in ' + missingIdsPath);
    lines.push('Fetch them, then run this command again (with --by-id-dir):');
    lines.push('  while read id; do rclone backend copyid gdrive: "$id" ' + fetchTarget + '/"$id" --drive-export-formats pdf; done < ' + missingIdsPath);
  }
  return lines;
}

function listPathsSummaryLines_(result, { pathsFile, dir }) {
  const lines = ['LIST PATHS: nothing was imported'];
  lines.push(referencedLine_(result.referencedIds, result.unfoundIds.length));
  lines.push('selected files:   ' + result.selectedFiles);
  lines.push('paths written:    ' + result.paths.length + ' to ' + pathsFile);
  if (result.sharedPathFiles) lines.push('left out, path shared with a sibling: ' + result.sharedPathFiles + ' (fetch them by id)');
  if (result.unlistablePathFiles) lines.push('left out, path cannot be one line of the list: ' + result.unlistablePathFiles + ' (fetch them by id)');
  lines.push('Copy them (same remote and root as the listing), then import:');
  lines.push('  rclone copy gdrive: ' + (dir || '<dir>') + ' --files-from ' + pathsFile + ' --drive-export-formats pdf');
  return lines;
}

function parseOptions_() {
  try {
    return parseCommandLine({
      args: process.argv.slice(2),
      options: {
        listing: { type: 'string' },
        dir: { type: 'string' },
        'root-id': { type: 'string' },
        'root-name': { type: 'string' },
        'by-id-dir': { type: 'string' },
        'only-ids': { type: 'string' },
        'list-paths': { type: 'string' },
        'unfound-ids': { type: 'string' },
        db: { type: 'string' },
        'files-dir': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    }).values;
  } catch (error) {
    console.error(error.message + '\n' + USAGE);
    process.exit(2);
  }
}

function main() {
  const options = parseOptions_();
  const listPathsMode = Boolean(options['list-paths']);
  // --list-paths reads no disk, so it needs neither the copied tree nor a root.
  const missingOption = listPathsMode
    ? !options.listing
    : (!options.listing || !options.dir || !options['root-id'] || !options['root-name']);
  const onlyIdsMissing = (listPathsMode || options['unfound-ids']) && !options['only-ids'];
  if (missingOption || onlyIdsMissing) {
    if (onlyIdsMissing) console.error('--list-paths and --unfound-ids need --only-ids');
    console.error(USAGE);
    process.exit(2);
  }

  const listing = readListing_(path.resolve(options.listing));
  const onlyIds = options['only-ids'] ? readOnlyIds_(path.resolve(options['only-ids'])) : null;

  if (listPathsMode) {
    const result = listPathsToCopy({ listing, onlyIds });
    writeLinesFile_(path.resolve(options['list-paths']), result.paths);
    if (options['unfound-ids']) writeLinesFile_(path.resolve(options['unfound-ids']), result.unfoundIds);
    for (const line of listPathsSummaryLines_(result, { pathsFile: options['list-paths'], dir: options.dir })) console.log(line);
    return;
  }

  const dir = path.resolve(options.dir);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('--dir is not a directory: ' + dir);
  const dryRun = Boolean(options['dry-run']);
  const missingIdsPath = path.join(dir, MISSING_IDS_FILE_NAME);
  // A dry run never opens the database, so even a mistyped --db cannot create one.
  const storage = dryRun ? null : new Storage(path.resolve(options.db || process.env.BASAER_DB || DEFAULT_DB));
  try {
    const counts = importDriveTree({
      storage,
      filesDir: options['files-dir'] || process.env.BASAER_FILES || path.join(__dirname, '..', 'data', 'files'),
      rootId: options['root-id'],
      rootName: options['root-name'],
      listing,
      sourceDir: dir,
      byIdDir: options['by-id-dir'],
      onlyIds,
      missingIdsPath,
      dryRun,
      log: console.log,
    });
    if (options['unfound-ids']) writeLinesFile_(path.resolve(options['unfound-ids']), counts.unfoundIds);
    for (const line of summaryLines_(counts, { dryRun, missingIdsPath, byIdDir: options['by-id-dir'] })) console.log(line);
  } finally {
    if (storage) storage.close();
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('import failed: ' + (e && e.stack || e)); process.exit(1); }
}

module.exports = { importDriveTree, listPathsToCopy };
