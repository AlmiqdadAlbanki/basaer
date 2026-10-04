'use strict';

// Registers a local .docx/.pptx under an exact file id in the local file store,
// so gas code that still names a legacy Google Drive template id
// (DriveApp.getFileById(legacyId).makeCopy(...)) finds a real file.
//
//   node tools/register-template.js --id <legacyGoogleId> --file <path.docx|.pptx>
//                                   [--name <name>] [--db <sqlite path>] [--files-dir <dir>]
//
// An existing record with the same id is replaced.

const fs = require('fs');
const path = require('path');
const { Storage } = require('../server/storage.js');
const { makeDriveShims } = require('../server/shims/drive.js');
const { DOCX_MIME, PPTX_MIME } = require('../server/docgen/convert.js');

const DEFAULT_DB_PATH = process.env.BASAER_DB || path.join(__dirname, '..', 'data', 'basaer.sqlite');
const DEFAULT_FILES_DIR = process.env.BASAER_FILES || path.join(__dirname, '..', 'data', 'files');

function mimeForFileName(fileName) {
  if (/\.docx$/i.test(fileName)) return DOCX_MIME;
  if (/\.pptx$/i.test(fileName)) return PPTX_MIME;
  throw new Error('Template must be a .docx or .pptx file: ' + fileName);
}

// Library entry point (also used by make-demo-templates.js).
function registerTemplate({ storage, filesDir, id, fileName, buffer }) {
  if (!id) throw new Error('registerTemplate: id is required');
  const { internals } = makeDriveShims({ storage, filesDir, baseUrl: '' });
  return internals.registerFile({ id, name: fileName, mime: mimeForFileName(fileName), buffer });
}

function parseArguments(argumentList) {
  const options = {};
  for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex++) {
    const flag = argumentList[argumentIndex];
    if (!flag.startsWith('--')) throw new Error('Unexpected argument: ' + flag);
    options[flag.slice(2)] = argumentList[++argumentIndex];
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.id || !options.file) {
    console.error('Usage: node tools/register-template.js --id <legacyGoogleId> --file <path.docx|.pptx> [--name <name>] [--db <path>] [--files-dir <dir>]');
    process.exit(2);
  }
  const fileName = options.name || path.basename(options.file);
  // The extension decides the mime, so a custom --name must keep it.
  const nameWithExtension = /\.(docx|pptx)$/i.test(fileName) ? fileName : fileName + path.extname(options.file);
  const storage = new Storage(options.db || DEFAULT_DB_PATH);
  const record = registerTemplate({
    storage,
    filesDir: options['files-dir'] || DEFAULT_FILES_DIR,
    id: options.id,
    fileName: nameWithExtension,
    buffer: fs.readFileSync(options.file),
  });
  console.log(`Registered ${record.id} -> "${record.name}" (${record.size} bytes, ${record.mime})`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { registerTemplate, mimeForFileName };
