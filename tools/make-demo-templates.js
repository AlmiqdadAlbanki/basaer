'use strict';

// Generates stand-in document templates and registers them in the local file
// store under the template ids the gas code names, so certificate, ID-card and
// greeting-card generation run end to end without the original Google Docs.
//
//   node tools/make-demo-templates.js [--db <sqlite path>] [--files-dir <dir>]
//
// Run after `node tools/seed.js` (seed.js does not depend on this). It:
//   - builds a certificate/ID-card .docx (every placeholder the gas code fills,
//     each on its own RTL paragraph, plus a paragraph that is exactly "QRCode")
//     and a one-slide greeting .pptx containing {name};
//   - registers the .docx under certIdTemp (gas/code.js) and cardID00..03
//     (gas/oldJS.js), plus any template id in the Certificates / stages sheets
//     that has no local file yet;
//   - registers the .pptx under every greetingTemplates templateId without a
//     local file, and adds an active demo greeting row when none is active
//     (the greeting template id lives only in that sheet, not in the code).

const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const { Runtime, Storage } = require('../server/runtime.js');
const { ZipArchive } = require('../server/docgen/zip.js');
const { registerTemplate } = require('./register-template.js');

const GAS_DIR = path.join(__dirname, '..', 'gas');
const DEFAULT_DB_PATH = process.env.BASAER_DB || path.join(__dirname, '..', 'data', 'basaer.sqlite');
const DEFAULT_FILES_DIR = path.join(__dirname, '..', 'data', 'files');
const DEMO_GREETING_TEMPLATE_ID = 'local_demo_greeting_template';
const CERTIFICATE_FILE_NAME = 'demo-certificate-template.docx';
const GREETING_FILE_NAME = 'demo-greeting-template.pptx';

// ---- Certificate / ID-card .docx -------------------------------------------

function rtlParagraph(text, runOptions = {}) {
  return new Paragraph({
    bidirectional: true,
    alignment: AlignmentType.CENTER,
    spacing: { after: 120 },
    children: [new TextRun({ text, rightToLeft: true, font: 'Amiri', size: 28, ...runOptions })],
  });
}

async function buildDemoCertificateDocx() {
  const document = new Document({
    creator: 'Basaer local port',
    title: 'Demo certificate template',
    sections: [{
      children: [
        rtlParagraph('بصائر للعلوم الشرعية', { bold: true, size: 40 }),
        rtlParagraph('شهادة — نموذج تجريبي محلي', { size: 32 }),
        rtlParagraph('تشهد بصائر للعلوم الشرعية بأنّ الطالب{g1}'),
        rtlParagraph('{name}', { bold: true, size: 36 }),
        rtlParagraph('قد اجتاز{g2} الاختبار بتقدير: {rate}'),
        rtlParagraph('{matn}'),
        rtlParagraph('{matnD}'),
        rtlParagraph('جزاه{g3} الله خيرًا'),
        rtlParagraph('المرحلة: {stage}'),
        rtlParagraph('عدد مرات الحضور: {hrs}'),
        rtlParagraph('المتون: {moton}'),
        rtlParagraph('التاريخ: {date}'),
        rtlParagraph('رمز الشهادة: {code}', { size: 22 }),
        rtlParagraph('QRCode'),
      ],
    }],
  });
  return Packer.toBuffer(document);
}

// ---- Greeting .pptx (hand-written minimal PresentationML) ----------------

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PRESENTATION_NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const RELATIONSHIP_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const EMPTY_SHAPE_TREE_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

function relationshipsXml(relationships) {
  return XML_DECLARATION +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    relationships.map(([id, type, target]) => `<Relationship Id="${id}" Type="${RELATIONSHIP_BASE}${type}" Target="${target}"/>`).join('') +
    '</Relationships>';
}

function textBoxShape({ shapeId, name, offsetY, height, text, fontSize, isBold, color }) {
  return '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${shapeId}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="457200" y="${offsetY}"/><a:ext cx="5943600" cy="${height}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square" rtlCol="1" anchor="ctr"/><a:lstStyle/>' +
    '<a:p><a:pPr algn="ctr" rtl="1"/><a:r>' +
    `<a:rPr lang="ar-SA" sz="${fontSize}"${isBold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    '<a:latin typeface="Amiri"/><a:cs typeface="Amiri"/></a:rPr>' +
    `<a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function themeXml() {
  const solidFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const colour = (tag, value) => `<a:${tag}><a:srgbClr val="${value}"/></a:${tag}>`;
  const font = '<a:latin typeface="Amiri"/><a:ea typeface=""/><a:cs typeface="Amiri"/>';
  return XML_DECLARATION +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Basaer"><a:themeElements>' +
    '<a:clrScheme name="Basaer">' +
    colour('dk1', '000000') + colour('lt1', 'FFFFFF') + colour('dk2', '1F2937') + colour('lt2', 'F5EEDC') +
    colour('accent1', '7A5C1E') + colour('accent2', 'B08D57') + colour('accent3', '2F5D50') +
    colour('accent4', '8C4A2F') + colour('accent5', '4A6FA5') + colour('accent6', '6B7280') +
    colour('hlink', '0563C1') + colour('folHlink', '954F72') +
    '</a:clrScheme>' +
    `<a:fontScheme name="Basaer"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>` +
    '<a:fmtScheme name="Basaer">' +
    `<a:fillStyleLst>${solidFill.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${`<a:ln w="9525">${solidFill}</a:ln>`.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${solidFill.repeat(3)}</a:bgFillStyleLst>` +
    '</a:fmtScheme></a:themeElements></a:theme>';
}

function buildDemoGreetingPptx() {
  const archive = new ZipArchive();
  const contentType = (part, type) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`;
  archive.set('[Content_Types].xml', XML_DECLARATION +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    contentType('/ppt/presentation.xml', 'presentationml.presentation.main') +
    contentType('/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster') +
    contentType('/ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout') +
    contentType('/ppt/slides/slide1.xml', 'presentationml.slide') +
    contentType('/ppt/theme/theme1.xml', 'theme') +
    '</Types>');
  archive.set('_rels/.rels', relationshipsXml([['rId1', 'officeDocument', 'ppt/presentation.xml']]));
  archive.set('ppt/presentation.xml', XML_DECLARATION +
    `<p:presentation ${PRESENTATION_NAMESPACES}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '<p:sldSz cx="6858000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>');
  archive.set('ppt/_rels/presentation.xml.rels', relationshipsXml([
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ['rId2', 'slide', 'slides/slide1.xml'],
    ['rId3', 'theme', 'theme/theme1.xml'],
  ]));
  archive.set('ppt/slideMasters/slideMaster1.xml', XML_DECLARATION +
    `<p:sldMaster ${PRESENTATION_NAMESPACES}><p:cSld><p:spTree>${EMPTY_SHAPE_TREE_HEADER}</p:spTree></p:cSld>` +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>');
  archive.set('ppt/slideMasters/_rels/slideMaster1.xml.rels', relationshipsXml([
    ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
    ['rId2', 'theme', '../theme/theme1.xml'],
  ]));
  archive.set('ppt/slideLayouts/slideLayout1.xml', XML_DECLARATION +
    `<p:sldLayout ${PRESENTATION_NAMESPACES} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${EMPTY_SHAPE_TREE_HEADER}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>');
  archive.set('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationshipsXml([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]));
  archive.set('ppt/slides/slide1.xml', XML_DECLARATION +
    `<p:sld ${PRESENTATION_NAMESPACES}><p:cSld>` +
    '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5EEDC"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    `<p:spTree>${EMPTY_SHAPE_TREE_HEADER}` +
    textBoxShape({ shapeId: 2, name: 'Title', offsetY: 1143000, height: 1143000, text: 'عيد مبارك', fontSize: 5400, isBold: true, color: '7A5C1E' }) +
    textBoxShape({ shapeId: 3, name: 'Name', offsetY: 2857500, height: 1143000, text: '{name}', fontSize: 4000, isBold: true, color: '1F2937' }) +
    textBoxShape({ shapeId: 4, name: 'Footer', offsetY: 4572000, height: 914400, text: 'تقبّل الله منا ومنكم — بصائر للعلوم الشرعية', fontSize: 2000, isBold: false, color: '2F5D50' }) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>');
  archive.set('ppt/slides/_rels/slide1.xml.rels', relationshipsXml([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]));
  archive.set('ppt/theme/theme1.xml', themeXml());
  return archive.toBuffer();
}

// ---- Legacy template ids named in the gas code ----------------------------

function readLegacyTemplateIds(gasDir) {
  const codeSource = fs.readFileSync(path.join(gasDir, 'code.js'), 'utf8');
  const oldSource = fs.readFileSync(path.join(gasDir, 'oldJS.js'), 'utf8');
  const certificateMatch = /\bcertIdTemp\s*=\s*["']([\w-]+)["']/.exec(codeSource);
  const cardIds = Array.from(oldSource.matchAll(/\bcardID0\d\s*=\s*["']([\w-]+)["']/g), (match) => match[1]);
  return { certificateTemplateId: certificateMatch ? certificateMatch[1] : null, cardTemplateIds: cardIds };
}

// ---- Main -----------------------------------------------------------------

function parseArguments(argumentList) {
  const options = {};
  for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex++) {
    const flag = argumentList[argumentIndex];
    if (!flag.startsWith('--')) throw new Error('Unexpected argument: ' + flag);
    options[flag.slice(2)] = argumentList[++argumentIndex];
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const storage = new Storage(options.db || DEFAULT_DB_PATH);
  const filesDir = options['files-dir'] || DEFAULT_FILES_DIR;
  const runtime = new Runtime({ gasDir: GAS_DIR, storage, filesDir });
  const fileExists = (fileId) => !!runtime.driveShims.internals.getRecord(fileId);

  const certificateDocx = await buildDemoCertificateDocx();
  const greetingPptx = buildDemoGreetingPptx();
  const registered = [];
  const register = (fileId, fileName, buffer, purpose) => {
    registerTemplate({ storage, filesDir, id: fileId, fileName, buffer });
    registered.push(`${purpose.padEnd(22)} ${fileId}`);
  };

  // Ids hard-coded in the gas code: always (re)registered.
  const { certificateTemplateId, cardTemplateIds } = readLegacyTemplateIds(GAS_DIR);
  if (certificateTemplateId) register(certificateTemplateId, CERTIFICATE_FILE_NAME, certificateDocx, 'certIdTemp');
  cardTemplateIds.forEach((cardId, cardIndex) => register(cardId, CERTIFICATE_FILE_NAME, certificateDocx, `cardID0${cardIndex}`));

  // Ids held in sheets: only those that do not resolve to a local file yet.
  const sheetDocIds = new Set();
  for (const certificate of runtime.call('getCertificateTemplatesList', [])) sheetDocIds.add(String(certificate.templateId || ''));
  for (const stage of runtime.call('getStagesList', [])) {
    sheetDocIds.add(String(stage.cardTemplateId || ''));
    sheetDocIds.add(String(stage.certTemplateId || ''));
  }
  for (const templateId of sheetDocIds) {
    if (templateId && !fileExists(templateId)) register(templateId, CERTIFICATE_FILE_NAME, certificateDocx, 'sheet doc template');
  }

  // Greeting card: the template id comes from the greetingTemplates sheet.
  register(DEMO_GREETING_TEMPLATE_ID, GREETING_FILE_NAME, greetingPptx, 'demo greeting');
  const greetingTemplates = runtime.call('getGreetingTemplatesList', []);
  for (const greetingTemplate of greetingTemplates) {
    const templateId = String(greetingTemplate.templateId || '');
    if (templateId && !fileExists(templateId)) register(templateId, GREETING_FILE_NAME, greetingPptx, 'sheet greeting');
  }
  if (!greetingTemplates.some((greetingTemplate) => greetingTemplate.isActive)) {
    const greetingSheet = runtime.call('ensureGreetingTemplatesSheet_', []);
    const headers = greetingSheet.getRange(1, 1, 1, greetingSheet.getLastColumn()).getValues()[0];
    const values = {
      id: 'local-demo-greeting', name: 'تهنئة تجريبية', templateId: DEMO_GREETING_TEMPLATE_ID,
      subject: 'تهنئة من بصائر للعلوم الشرعية', body: 'تقبّل الله منا ومنكم صالح الأعمال.',
      isActive: true, createdAt: new Date(), updatedBy: 'make-demo-templates', updatedAt: new Date(),
    };
    greetingSheet.appendRow(headers.map((header) => (header in values ? values[header] : '')));
    registered.push('active greeting row     greetingTemplates -> ' + DEMO_GREETING_TEMPLATE_ID);
  }

  console.log('Registered demo templates:\n  ' + registered.join('\n  '));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

module.exports = { buildDemoCertificateDocx, buildDemoGreetingPptx, readLegacyTemplateIds, DEMO_GREETING_TEMPLATE_ID };
