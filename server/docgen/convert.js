'use strict';

// Format conversion for generated documents, replacing what Google Drive did
// implicitly (Doc -> PDF on getAs/getBlob, Slides -> PNG via the export URL).
// LibreOffice renders OOXML -> PDF and poppler's pdftoppm rasterises PDF -> PNG.
// Both run synchronously because the calling gas code is synchronous.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { Blob } = require('../shims/utilities.js');

const SOFFICE_BINARY = process.env.BASAER_SOFFICE || 'soffice';
const PDFTOPPM_BINARY = process.env.BASAER_PDFTOPPM || 'pdftoppm';
const CONVERSION_TIMEOUT_MS = 90000;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PDF_MIME = 'application/pdf';
const PNG_MIME = 'image/png';

function makeWorkDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeWorkDir(workDir) {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// Run a converter binary; a missing binary or a non-zero exit becomes an error naming the tool.
function runTool(toolLabel, binary, toolArguments) {
  const result = spawnSync(binary, toolArguments, { timeout: CONVERSION_TIMEOUT_MS, encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(`${toolLabel} not found (looked for "${binary}" on PATH); install it to generate documents`);
    }
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`${toolLabel} timed out after ${CONVERSION_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`${toolLabel} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${toolLabel} exited with status ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

// Convert office bytes with LibreOffice. outputFormat is a soffice filter such
// as 'pdf' or 'docx'. Each call gets its own user profile directory so a stale
// or concurrent soffice instance never blocks it (soffice otherwise hands the
// job to the running instance and exits without producing anything).
function convertWithSoffice(inputBytes, inputExt, outputFormat) {
  const workDir = makeWorkDir('basaer-soffice-');
  try {
    const extension = String(inputExt).replace(/^\./, '');
    const inputPath = path.join(workDir, 'input.' + extension);
    fs.writeFileSync(inputPath, inputBytes);
    const profileUrl = pathToFileURL(path.join(workDir, 'profile')).href;
    const result = runTool('LibreOffice (soffice)', SOFFICE_BINARY, [
      '-env:UserInstallation=' + profileUrl,
      '--headless', '--norestore', '--nolockcheck',
      '--convert-to', outputFormat,
      '--outdir', workDir,
      inputPath,
    ]);
    const outputExtension = String(outputFormat).split(':')[0];
    const outputPath = path.join(workDir, 'input.' + outputExtension);
    if (!fs.existsSync(outputPath)) {
      throw new Error(`LibreOffice (soffice) produced no ${outputExtension} output: ${(result.stderr || result.stdout || '').trim()}`);
    }
    return fs.readFileSync(outputPath);
  } finally {
    removeWorkDir(workDir);
  }
}

// Rasterise the first page of a PDF at 150 dpi.
function pdfToPng(pdfBytes) {
  const workDir = makeWorkDir('basaer-pdftoppm-');
  try {
    const inputPath = path.join(workDir, 'input.pdf');
    const outputPrefix = path.join(workDir, 'page');
    fs.writeFileSync(inputPath, pdfBytes);
    runTool('pdftoppm (poppler-utils)', PDFTOPPM_BINARY, ['-png', '-r', '150', '-singlefile', inputPath, outputPrefix]);
    return fs.readFileSync(outputPrefix + '.png');
  } finally {
    removeWorkDir(workDir);
  }
}

// Office extension of a blob from its mime type or file name, or '' if it is not an office file.
function officeExtensionOf(blob) {
  const contentType = String(blob.getContentType() || '').toLowerCase();
  if (contentType === DOCX_MIME) return 'docx';
  if (contentType === PPTX_MIME) return 'pptx';
  const nameMatch = /\.(docx|pptx)$/i.exec(blob.getName() || '');
  return nameMatch ? nameMatch[1].toLowerCase() : '';
}

function renameWithExtension(fileName, extension) {
  if (!fileName) return '';
  return fileName.replace(/\.(docx|pptx|pdf)$/i, '') + '.' + extension;
}

// Blob.getAs converter (registered via Blob.setConverter in runtime.js).
// Returns a converted Blob, or null to let getAs fall back to relabelling.
// Like Apps Script, the converted blob's name takes the new extension.
function convertBlob(blob, targetMime) {
  const target = String(targetMime || '').toLowerCase();
  if (target !== PDF_MIME && target !== PNG_MIME) return null;
  const officeExtension = officeExtensionOf(blob);
  const isPdf = String(blob.getContentType() || '').toLowerCase() === PDF_MIME;
  if (!officeExtension && !(isPdf && target === PNG_MIME)) return null;

  const pdfBytes = officeExtension ? convertWithSoffice(blob._buffer(), officeExtension, 'pdf') : blob._buffer();
  if (target === PDF_MIME) return new Blob(pdfBytes, PDF_MIME, renameWithExtension(blob.getName(), 'pdf'));
  return new Blob(pdfToPng(pdfBytes), PNG_MIME, renameWithExtension(blob.getName(), 'png'));
}

module.exports = { convertWithSoffice, pdfToPng, convertBlob, DOCX_MIME, PPTX_MIME, PDF_MIME, PNG_MIME };
