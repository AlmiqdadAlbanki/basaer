'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { Document: DocxDocument, Packer, Paragraph, TextRun } = require('docx');

const { Storage } = require('../storage.js');
const { makeDriveShims } = require('./drive.js');
const { makeDocShims } = require('./docs.js');
const { Blob } = require('./utilities.js');
const { ZipArchive } = require('../docgen/zip.js');
const { convertBlob } = require('../docgen/convert.js');
const { buildDemoCertificateDocx, buildDemoGreetingPptx } = require('../../tools/make-demo-templates.js');
const { registerTemplate } = require('../../tools/register-template.js');

const HAS_SOFFICE = fs.existsSync('/usr/bin/soffice');
const SOFFICE_SKIP_MESSAGE = 'LibreOffice (/usr/bin/soffice) not installed: PDF/PNG conversion not exercised';
const LEGACY_DOC_ID = '1j7fbLyJH4Ef6zLRbHr9upaSy4zapOSu3VJpwrDELlN4';
const LEGACY_SLIDES_ID = 'legacySlidesTemplate0001';
// 1x1 PNG, the same shape as the dry-run QR-code reply.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

Blob.setConverter(convertBlob);

function makeFixture() {
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-docs-'));
  const storage = new Storage(':memory:');
  const driveShims = makeDriveShims({ storage, filesDir, baseUrl: 'http://localhost:3000' });
  const { DocumentApp, SlidesApp } = makeDocShims({ storage, filesDir, baseUrl: 'http://localhost:3000', driveInternals: driveShims.internals });
  return { storage, filesDir, DriveApp: driveShims.DriveApp, internals: driveShims.internals, DocumentApp, SlidesApp };
}

function documentXmlOf(fixture, fileId) {
  return ZipArchive.read(fixture.internals.readContent(fileId)).getText('word/document.xml');
}

// The replaceImage_ helper from gas/dataPost.js, verbatim in behaviour.
function replaceQrPlaceholder(DocumentApp, fileId, imageBlob, width) {
  const body = DocumentApp.openById(fileId).getBody();
  let next;
  do {
    next = body.findText('QRCode');
    if (!next) break;
    const element = next.getElement();
    element.asText().setText('');
    const image = element.getParent().asParagraph().insertInlineImage(0, imageBlob);
    const originalWidth = image.getWidth();
    const originalHeight = image.getHeight();
    image.setWidth(width);
    image.setHeight(width * originalHeight / originalWidth);
  } while (next);
}

async function registerDemoCertificate(fixture) {
  registerTemplate({ storage: fixture.storage, filesDir: fixture.filesDir, id: LEGACY_DOC_ID, fileName: 'cert.docx', buffer: await buildDemoCertificateDocx() });
  return fixture.DriveApp.getFileById(LEGACY_DOC_ID).makeCopy(fixture.DriveApp.getFolderById('legacyTempFolder')).getId();
}

test('register-template makes a legacy id resolve through DriveApp', async () => {
  const fixture = makeFixture();
  await registerDemoCertificate(fixture);
  const templateFile = fixture.DriveApp.getFileById(LEGACY_DOC_ID);
  assert.strictEqual(templateFile.getName(), 'cert.docx');
  assert.strictEqual(templateFile.getMimeType(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  // Re-registering replaces the record rather than failing on the primary key.
  registerTemplate({ storage: fixture.storage, filesDir: fixture.filesDir, id: LEGACY_DOC_ID, fileName: 'cert2.docx', buffer: await buildDemoCertificateDocx() });
  assert.strictEqual(fixture.DriveApp.getFileById(LEGACY_DOC_ID).getName(), 'cert2.docx');
});

test('replaceText fills placeholders, "\\r\\n" becomes a line break, QR image is inserted and persisted', async () => {
  const fixture = makeFixture();
  const copyId = await registerDemoCertificate(fixture);
  // Drop the template's png content-type default so insertInlineImage has to add it.
  const templateArchive = ZipArchive.read(fixture.internals.readContent(copyId));
  templateArchive.set('[Content_Types].xml', templateArchive.getText('[Content_Types].xml').replace(/<Default [^>]*Extension="png"\/>/, ''));
  fixture.internals.replaceContent(copyId, templateArchive.toBuffer());

  const document = fixture.DocumentApp.openById(copyId);
  const body = document.getBody();
  body.replaceText('{matn}', '\r\nكما اجتاز{g2} تسميع المتن وحصل على تقدير ');
  body.replaceText('{name}', 'أحمد');
  body.replaceText('{g2}', 'ت');
  body.replaceText('{rate}', 'ممتاز');
  body.replaceText('{code}', 'BAS-1-123');
  document.saveAndClose();

  replaceQrPlaceholder(fixture.DocumentApp, copyId, new Blob(ONE_PIXEL_PNG, 'image/png', 'qr.png'), 120);
  fixture.DocumentApp.openById(copyId).saveAndClose();

  const reopenedBody = fixture.DocumentApp.openById(copyId).getBody();
  const text = reopenedBody.getText();
  assert.match(text, /أحمد/);
  assert.match(text, /اجتازت الاختبار بتقدير: ممتاز/);
  assert.match(text, /كما اجتازت تسميع المتن/);
  assert.doesNotMatch(text, /\{name\}|\{g2\}|\{matn\}|QRCode/);
  assert.strictEqual(reopenedBody.findText('QRCode'), null);

  const documentXml = documentXmlOf(fixture, copyId);
  assert.match(documentXml, /<w:br\/><w:t xml:space="preserve">كما اجتازت/);
  assert.match(documentXml, /<w:drawing>/);
  assert.match(documentXml, new RegExp(`<wp:extent cx="${120 * 12700}" cy="${120 * 12700}"/>`));

  // The package stays a valid OOXML zip that an independent reader accepts.
  const zip = await JSZip.loadAsync(fixture.internals.readContent(copyId));
  assert.ok(zip.file('word/media/basaer_image1.png'));
  assert.match(await zip.file('word/_rels/document.xml.rels').async('string'), /relationships\/image" Target="media\/basaer_image1\.png"/);
  const contentTypesXml = await zip.file('[Content_Types].xml').async('string');
  assert.strictEqual(contentTypesXml.match(/<Default [^>]*Extension="png"/g).length, 1);
  assert.match(contentTypesXml, /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.match(await zip.file('word/document.xml').async('string'), /أحمد/);
});

test('replaceText handles a placeholder split across runs and keeps each run\'s formatting', async () => {
  const fixture = makeFixture();
  const splitDocument = new DocxDocument({
    sections: [{
      children: [
        new Paragraph({ bidirectional: true, children: [new TextRun({ text: 'مرحبا {na', rightToLeft: true }), new TextRun({ text: 'me} نهاية', bold: true, rightToLeft: true })] }),
        new Paragraph({ children: [new TextRun('[{'), new TextRun({ text: 'rat', italics: true }), new TextRun('e}]')] }),
      ],
    }],
  });
  registerTemplate({ storage: fixture.storage, filesDir: fixture.filesDir, id: 'splitRunTemplate01', fileName: 'split.docx', buffer: await Packer.toBuffer(splitDocument) });
  assert.match(documentXmlOf(fixture, 'splitRunTemplate01'), /\{na<\/w:t>/, 'fixture really splits the placeholder');

  const body = fixture.DocumentApp.openById('splitRunTemplate01').getBody();
  body.replaceText('{name}', 'أحمد');
  body.replaceText('{rate}', 'جيد');
  const paragraphs = body.getParagraphs();
  assert.strictEqual(paragraphs[0].getText(), 'مرحبا أحمد نهاية');
  assert.strictEqual(paragraphs[1].getText(), '[جيد]');

  const documentXml = documentXmlOf(fixture, 'splitRunTemplate01');
  const runs = documentXml.match(/<w:r>[\s\S]*?<\/w:r>/g);
  const firstRun = runs.find((run) => run.includes('مرحبا'));
  const boldRun = runs.find((run) => run.includes('<w:b/>'));
  assert.match(firstRun, /<w:t xml:space="preserve">مرحبا أحمد<\/w:t>/);
  assert.doesNotMatch(firstRun, /<w:b\/>/);
  assert.match(boldRun, /<w:t xml:space="preserve"> نهاية<\/w:t>/);
  assert.doesNotMatch(documentXml, /me\}|\{na|rat/);
});

test('edits are live across DocumentApp instances (oldJS.js ID-card flow)', async () => {
  const fixture = makeFixture();
  const copyId = await registerDemoCertificate(fixture);
  const document = fixture.DocumentApp.openById(copyId);
  document.getBody().replaceText('{name}', 'فاطمة');
  // replaceImage_ opens its own instance and never saves it...
  replaceQrPlaceholder(fixture.DocumentApp, copyId, new Blob(ONE_PIXEL_PNG, 'image/png'), 120);
  // ...then the first instance renames and saves; the image must survive.
  document.setName('idCard-123-pdf');
  document.saveAndClose();
  const documentXml = documentXmlOf(fixture, copyId);
  assert.match(documentXml, /فاطمة/);
  assert.match(documentXml, /<w:drawing>/);
  assert.strictEqual(fixture.DriveApp.getFileById(copyId).getName(), 'idCard-123-pdf');
});

test('openById on a missing or non-OOXML file fails with a clear error', () => {
  const fixture = makeFixture();
  assert.throws(() => fixture.DocumentApp.openById('noSuchTemplate000'), /DocumentApp\.openById: file not found: noSuchTemplate000/);
  const textFile = fixture.DriveApp.createFile('notes.txt', 'hello', 'text/plain');
  assert.throws(() => fixture.DocumentApp.openById(textFile.getId()), /is not a \.docx/);
  assert.throws(() => fixture.SlidesApp.openById(textFile.getId()), /is not a \.pptx/);
});

test('SlidesApp.replaceAllText replaces across slides, including split runs', async () => {
  const fixture = makeFixture();
  registerTemplate({ storage: fixture.storage, filesDir: fixture.filesDir, id: LEGACY_SLIDES_ID, fileName: 'greeting.pptx', buffer: buildDemoGreetingPptx() });

  // Split the placeholder across two runs to mirror what real decks contain.
  const archive = ZipArchive.read(fixture.internals.readContent(LEGACY_SLIDES_ID));
  const slideXml = archive.getText('ppt/slides/slide1.xml');
  archive.set('ppt/slides/slide1.xml', slideXml.replace('<a:t>{name}</a:t>', '<a:t>{NA</a:t></a:r><a:r><a:rPr lang="ar-SA" i="1"/><a:t>me}!</a:t>'));
  fixture.internals.replaceContent(LEGACY_SLIDES_ID, archive.toBuffer());

  const copyId = fixture.DriveApp.getFileById(LEGACY_SLIDES_ID).makeCopy('تهنئة - عبد الله', fixture.DriveApp.getFolderById('legacyCards')).getId();
  const presentation = fixture.SlidesApp.openById(copyId);
  // Apps Script's replaceAllText is case-insensitive by default.
  assert.strictEqual(presentation.replaceAllText('{name}', 'عبد الله'), 1);
  presentation.saveAndClose();

  const reopenedXml = ZipArchive.read(fixture.internals.readContent(copyId)).getText('ppt/slides/slide1.xml');
  assert.match(reopenedXml, /<a:t>عبد الله<\/a:t><\/a:r><a:r><a:rPr lang="ar-SA" i="1"\/><a:t>!<\/a:t>/);
  assert.doesNotMatch(reopenedXml, /\{NA|me\}/);
  const blob = fixture.SlidesApp.openById(copyId).getBlob();
  assert.strictEqual(blob.getContentType(), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.strictEqual(blob.getName(), 'تهنئة - عبد الله.pptx');
});

test('Blob.getAs only relabels blobs it cannot convert', () => {
  const textBlob = new Blob(Buffer.from('plain'), 'text/plain', 'a.txt');
  const relabelled = textBlob.getAs('application/pdf');
  assert.strictEqual(relabelled.getContentType(), 'application/pdf');
  assert.strictEqual(relabelled.getDataAsString(), 'plain');
});

test('docx -> PDF and pptx -> PNG through LibreOffice', async (testContext) => {
  if (!HAS_SOFFICE) {
    testContext.skip(SOFFICE_SKIP_MESSAGE);
    return;
  }
  const fixture = makeFixture();
  const copyId = await registerDemoCertificate(fixture);
  fixture.DocumentApp.openById(copyId).getBody().replaceText('{name}', 'أحمد');

  // Document.getBlob() is the PDF rendering, as in Apps Script.
  const documentPdf = fixture.DocumentApp.openById(copyId).getBlob().getAs('application/pdf');
  assert.strictEqual(documentPdf.getContentType(), 'application/pdf');
  assert.strictEqual(documentPdf._buffer().subarray(0, 4).toString('latin1'), '%PDF');

  // DriveFile docx blob -> PDF goes through the registered Blob converter.
  const drivePdf = fixture.DriveApp.getFileById(copyId).getBlob().getAs('application/pdf');
  assert.strictEqual(drivePdf._buffer().subarray(0, 4).toString('latin1'), '%PDF');
  assert.match(drivePdf.getName(), /\.pdf$/);

  registerTemplate({ storage: fixture.storage, filesDir: fixture.filesDir, id: LEGACY_SLIDES_ID, fileName: 'greeting.pptx', buffer: buildDemoGreetingPptx() });
  const pngBlob = fixture.SlidesApp.openById(LEGACY_SLIDES_ID).getBlob().getAs('image/png');
  assert.strictEqual(pngBlob.getContentType(), 'image/png');
  assert.deepStrictEqual(Array.from(pngBlob._buffer().subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.strictEqual(pngBlob.getName(), 'greeting.png');
});
