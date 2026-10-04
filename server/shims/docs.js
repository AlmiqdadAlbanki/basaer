'use strict';

// DocumentApp / SlidesApp compatibility shims over .docx / .pptx files held in
// the local file store (shims/drive.js). Verified usage in gas/: Body.replaceText
// with literal "{tag}" placeholders (replacement may contain "\r\n"), the
// replaceImage_ chain findText -> getElement -> asText().setText("") ->
// getParent().asParagraph().insertInlineImage(0, blob) -> get/setWidth/Height,
// Document.setName/saveAndClose/getBlob, and Presentation.replaceAllText /
// saveAndClose plus getBlob for the local PNG export in exportNewCard.
//
// Every edit is a read-modify-write of the stored file (write-through). Apps
// Script edits are live on the server-side document and the gas code depends on
// it: replaceImage_ edits through its own openById instance and never saves it,
// then a *different* instance's saveAndClose()/getBlob() must see the image.
// Re-reading the package per operation keeps all instances consistent without
// an open-document registry; saveAndClose() therefore has nothing left to flush.

const { ZipArchive } = require('../docgen/zip.js');
const { convertWithSoffice, DOCX_MIME, PPTX_MIME, PDF_MIME } = require('../docgen/convert.js');
const { Blob } = require('./utilities.js');
const { makeDriveShims } = require('./drive.js');

const DOCUMENT_PART = 'word/document.xml';
const DOCUMENT_RELS_PART = 'word/_rels/document.xml.rels';
const PRESENTATION_PART = 'ppt/presentation.xml';
const SLIDE_PART_PATTERN = /^ppt\/slides\/slide\d+\.xml$/;
const EMU_PER_POINT = 12700;
const IMAGE_RELATIONSHIP_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const NAMESPACES = {
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

// ---- XML text helpers ----------------------------------------------------

function decodeXmlText(xmlText) {
  return xmlText.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (entity, entityName) => {
    if (entityName === 'amp') return '&';
    if (entityName === 'lt') return '<';
    if (entityName === 'gt') return '>';
    if (entityName === 'quot') return '"';
    if (entityName === 'apos') return "'";
    const codePoint = entityName[1] === 'x' ? parseInt(entityName.slice(2), 16) : parseInt(entityName.slice(1), 10);
    return String.fromCodePoint(codePoint);
  });
}

function encodeXmlText(plainText) {
  return plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Scan an XML part for paragraphs (<P:p>) and their text nodes (<P:t>) where P
// is 'w' (WordprocessingML) or 'a' (DrawingML, used by slides). Each text node
// belongs to its innermost enclosing paragraph, so text boxes nested inside a
// paragraph do not merge with it. Paragraphs are listed in document order.
function scanParagraphs(xml, prefix) {
  const tagPattern = new RegExp(`<(/?)(${prefix}:p|${prefix}:r|${prefix}:t)(?=[\\s/>])[^>]*?(/?)>`, 'g');
  const closeTextTag = `</${prefix}:t>`;
  const paragraphs = [];
  const openParagraphs = [];
  let runContentStart = -1;
  let match;
  while ((match = tagPattern.exec(xml))) {
    const [tagText, closingSlash, tagName, selfClosingSlash] = match;
    const tagStart = match.index;
    const tagEnd = tagStart + tagText.length;
    const localName = tagName.slice(prefix.length + 1);
    if (localName === 'p') {
      if (closingSlash) {
        const finishedParagraph = openParagraphs.pop();
        if (finishedParagraph) finishedParagraph.closeStart = tagStart;
      } else {
        const paragraph = { openStart: tagStart, openEnd: tagEnd, closeStart: -1, selfClosing: !!selfClosingSlash, textNodes: [] };
        paragraphs.push(paragraph);
        if (!selfClosingSlash) openParagraphs.push(paragraph);
      }
    } else if (localName === 'r') {
      if (closingSlash) runContentStart = -1;
      else if (!selfClosingSlash) runContentStart = tagEnd;
    } else if (!closingSlash) {
      const textNode = { start: tagStart, end: tagEnd, text: '' };
      if (!selfClosingSlash) {
        const closeIndex = xml.indexOf(closeTextTag, tagEnd);
        if (closeIndex < 0) break;
        textNode.text = decodeXmlText(xml.slice(tagEnd, closeIndex));
        textNode.end = closeIndex + closeTextTag.length;
        tagPattern.lastIndex = textNode.end;
      }
      textNode.originalText = textNode.text;
      textNode.inRun = runContentStart >= 0;
      // Run properties preceding the text, reused when a slide line break splits the run.
      textNode.runPrefix = textNode.inRun ? xml.slice(runContentStart, tagStart) : '';
      const ownerParagraph = openParagraphs[openParagraphs.length - 1];
      if (ownerParagraph) ownerParagraph.textNodes.push(textNode);
    }
  }
  return paragraphs;
}

function paragraphText(paragraph) {
  return paragraph.textNodes.map((textNode) => textNode.text).join('');
}

// Serialise a text node; "\r\n" / "\n" in the text become line breaks.
function serializeTextNode(textNode, prefix) {
  const segments = textNode.text.split(/\r\n|\r|\n/).map(encodeXmlText);
  if (prefix === 'w') {
    return '<w:t xml:space="preserve">' + segments.join('</w:t><w:br/><w:t xml:space="preserve">') + '</w:t>';
  }
  // DrawingML: <a:br/> sits between runs, so close the run and reopen it with the same properties.
  const lineBreak = textNode.inRun ? `</a:t></a:r><a:br/><a:r>${textNode.runPrefix}<a:t>` : ' ';
  return '<a:t>' + segments.join(lineBreak) + '</a:t>';
}

// Write back every text node whose text changed (from the end, so offsets stay valid).
function rewriteTextNodes(xml, paragraphs, prefix) {
  const changedNodes = paragraphs
    .flatMap((paragraph) => paragraph.textNodes)
    .filter((textNode) => textNode.text !== textNode.originalText)
    .sort((left, right) => right.start - left.start);
  let rewrittenXml = xml;
  for (const textNode of changedNodes) {
    rewrittenXml = rewrittenXml.slice(0, textNode.start) + serializeTextNode(textNode, prefix) + rewrittenXml.slice(textNode.end);
  }
  return rewrittenXml;
}

// Replace every occurrence of searchText in one paragraph's text nodes, even
// when a placeholder is split across runs: the replacement lands in the run
// holding the match start (keeping that run's formatting) and the consumed
// characters are removed from the following runs.
function replaceInTextNodes(textNodes, searchText, replacement, ignoreCase) {
  if (!searchText) return 0;
  const lowerSearchText = searchText.toLowerCase();
  let replacementCount = 0;
  let searchFrom = 0;
  for (;;) {
    const joinedText = textNodes.map((textNode) => textNode.text).join('');
    const lowerJoinedText = joinedText.toLowerCase();
    // Lower-casing can change length for a few characters; then offsets would not line up, so match exactly.
    const foldCase = ignoreCase && lowerJoinedText.length === joinedText.length && lowerSearchText.length === searchText.length;
    const matchStart = foldCase ? lowerJoinedText.indexOf(lowerSearchText, searchFrom) : joinedText.indexOf(searchText, searchFrom);
    if (matchStart < 0) return replacementCount;
    const matchEnd = matchStart + searchText.length;

    let nodeOffset = 0;
    let firstNodeIndex = -1;
    let firstNodeOffset = 0;
    let lastNodeIndex = -1;
    let lastNodeOffset = 0;
    for (let nodeIndex = 0; nodeIndex < textNodes.length; nodeIndex++) {
      const nodeLength = textNodes[nodeIndex].text.length;
      if (firstNodeIndex < 0 && matchStart < nodeOffset + nodeLength) {
        firstNodeIndex = nodeIndex;
        firstNodeOffset = matchStart - nodeOffset;
      }
      if (firstNodeIndex >= 0 && matchEnd <= nodeOffset + nodeLength) {
        lastNodeIndex = nodeIndex;
        lastNodeOffset = matchEnd - nodeOffset;
        break;
      }
      nodeOffset += nodeLength;
    }

    const firstNode = textNodes[firstNodeIndex];
    if (firstNodeIndex === lastNodeIndex) {
      firstNode.text = firstNode.text.slice(0, firstNodeOffset) + replacement + firstNode.text.slice(lastNodeOffset);
    } else {
      firstNode.text = firstNode.text.slice(0, firstNodeOffset) + replacement;
      for (let nodeIndex = firstNodeIndex + 1; nodeIndex < lastNodeIndex; nodeIndex++) textNodes[nodeIndex].text = '';
      textNodes[lastNodeIndex].text = textNodes[lastNodeIndex].text.slice(lastNodeOffset);
    }
    replacementCount += 1;
    searchFrom = matchStart + replacement.length;
  }
}

// Put newText in the paragraph's first text node and empty the rest
// (Apps Script Text.setText replaces the element's whole text).
function setParagraphText(xml, paragraph, newText, prefix) {
  if (paragraph.textNodes.length === 0) {
    if (!newText) return xml;
    const runXml = prefix === 'w'
      ? `<w:r>${serializeTextNode({ text: newText }, 'w')}</w:r>`
      : `<a:r>${serializeTextNode({ text: newText, inRun: true, runPrefix: '' }, 'a')}</a:r>`;
    if (paragraph.selfClosing) {
      const openTag = xml.slice(paragraph.openStart, paragraph.openEnd).replace(/\s*\/>$/, '>');
      return xml.slice(0, paragraph.openStart) + openTag + runXml + `</${prefix}:p>` + xml.slice(paragraph.openEnd);
    }
    return xml.slice(0, paragraph.closeStart) + runXml + xml.slice(paragraph.closeStart);
  }
  paragraph.textNodes.forEach((textNode, nodeIndex) => { textNode.text = nodeIndex === 0 ? String(newText) : ''; });
  return rewriteTextNodes(xml, [paragraph], prefix);
}

// ---- Images ---------------------------------------------------------------

// Format and pixel size from the image header (PNG, JPEG, GIF).
function describeImage(imageBytes) {
  if (imageBytes.length >= 24 && imageBytes.readUInt32BE(0) === 0x89504e47) {
    return { extension: 'png', mime: 'image/png', width: imageBytes.readUInt32BE(16), height: imageBytes.readUInt32BE(20) };
  }
  if (imageBytes.length >= 10 && imageBytes.toString('latin1', 0, 4) === 'GIF8') {
    return { extension: 'gif', mime: 'image/gif', width: imageBytes.readUInt16LE(6), height: imageBytes.readUInt16LE(8) };
  }
  if (imageBytes.length >= 4 && imageBytes[0] === 0xff && imageBytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 9 < imageBytes.length) {
      if (imageBytes[cursor] !== 0xff) { cursor += 1; continue; }
      const marker = imageBytes[cursor + 1];
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return { extension: 'jpeg', mime: 'image/jpeg', width: imageBytes.readUInt16BE(cursor + 7), height: imageBytes.readUInt16BE(cursor + 5) };
      }
      cursor += 2 + imageBytes.readUInt16BE(cursor + 2);
    }
    return { extension: 'jpeg', mime: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}

function maxNumberIn(text, pattern) {
  let maximum = 0;
  for (const match of text.matchAll(pattern)) maximum = Math.max(maximum, Number(match[1]));
  return maximum;
}

function inlineDrawingXml({ drawingId, relationshipId, mediaFileName, widthEmu, heightEmu }) {
  return '<w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${drawingId}" name="Picture ${drawingId}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NAMESPACES.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NAMESPACES.a}"><a:graphicData uri="${NAMESPACES.pic}">` +
    `<pic:pic xmlns:pic="${NAMESPACES.pic}">` +
    `<pic:nvPicPr><pic:cNvPr id="${drawingId}" name="${mediaFileName}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${widthEmu}" cy="${heightEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
}

// Make sure the root <w:document> declares the prefixes the drawing markup uses.
function ensureRootNamespaces(xml) {
  return xml.replace(/<w:document\b[^>]*>/, (rootTag) => {
    let patchedTag = rootTag;
    for (const prefix of ['wp', 'r']) {
      if (!new RegExp(`\\sxmlns:${prefix}=`).test(patchedTag)) {
        patchedTag = patchedTag.replace(/>$/, ` xmlns:${prefix}="${NAMESPACES[prefix]}">`);
      }
    }
    return patchedTag;
  });
}

function addImageRelationship(archive, mediaFileName) {
  const relationshipsXml = archive.getText(DOCUMENT_RELS_PART) ||
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const relationshipId = 'rId' + (maxNumberIn(relationshipsXml, /\bId="rId(\d+)"/g) + 1);
  const relationshipXml = `<Relationship Id="${relationshipId}" Type="${IMAGE_RELATIONSHIP_TYPE}" Target="media/${mediaFileName}"/>`;
  archive.set(DOCUMENT_RELS_PART, relationshipsXml.replace('</Relationships>', relationshipXml + '</Relationships>'));
  return relationshipId;
}

function ensureContentTypeDefault(archive, extension, mime) {
  const contentTypesXml = archive.getText('[Content_Types].xml');
  if (!contentTypesXml || new RegExp(`<Default\\s[^>]*Extension="${extension}"`, 'i').test(contentTypesXml)) return;
  archive.set('[Content_Types].xml', contentTypesXml.replace('</Types>', `<Default Extension="${extension}" ContentType="${mime}"/></Types>`));
}

// ---- Shim factory ---------------------------------------------------------

function makeDocShims({ storage, filesDir, baseUrl, driveInternals }) {
  const fileStore = driveInternals || makeDriveShims({ storage, filesDir, baseUrl }).internals;

  function requireRecord(serviceName, fileId) {
    const record = fileStore.getRecord(fileId);
    if (!record || record.is_folder) {
      throw new Error(`${serviceName}.openById: file not found: ${fileId} (register a stand-in with tools/register-template.js)`);
    }
    return record;
  }

  function readArchive(fileId) {
    return ZipArchive.read(fileStore.readContent(fileId));
  }

  // Open-time check that the stored bytes really are the expected OOXML package.
  function requirePackage(serviceName, fileId, requiredPart, formatLabel) {
    const record = requireRecord(serviceName, fileId);
    let archive;
    try {
      archive = readArchive(record.id);
    } catch (_) {
      archive = null;
    }
    if (!archive || !archive.has(requiredPart)) {
      throw new Error(`${serviceName}.openById: ${fileId} ("${record.name}", ${record.mime}) is not a ${formatLabel} file`);
    }
    return record;
  }

  // Read-modify-write of the stored package; returns whatever editFunction returns.
  function editArchive(fileId, editFunction) {
    const archive = readArchive(fileId);
    const result = editFunction(archive);
    if (archive.isModified()) fileStore.replaceContent(fileId, archive.toBuffer());
    return result;
  }

  // editFunction(xml, archive) -> { xml, value }.
  function editPart(fileId, partName, editFunction) {
    return editArchive(fileId, (archive) => {
      const originalXml = archive.getText(partName);
      const { xml, value } = editFunction(originalXml, archive);
      if (xml !== originalXml) archive.set(partName, xml);
      return value;
    });
  }

  function readPart(fileId, partName) {
    return readArchive(fileId).getText(partName);
  }

  function nameWithExtension(fileName, extension) {
    return String(fileName || 'Untitled').replace(/\.(docx|pptx)$/i, '') + '.' + extension;
  }

  // ---- DocumentApp ------------------------------------------------------

  class InlineImage {
    constructor(fileId, drawingId, widthPoints, heightPoints) {
      this._fileId = fileId;
      this._drawingId = drawingId;
      this._width = widthPoints;
      this._height = heightPoints;
    }
    getType() { return 'INLINE_IMAGE'; }
    getWidth() { return this._width; }
    getHeight() { return this._height; }
    setWidth(widthPoints) { this._width = Number(widthPoints); this._writeExtent(); return this; }
    setHeight(heightPoints) { this._height = Number(heightPoints); this._writeExtent(); return this; }
    _writeExtent() {
      const widthEmu = Math.round(this._width * EMU_PER_POINT);
      const heightEmu = Math.round(this._height * EMU_PER_POINT);
      editPart(this._fileId, DOCUMENT_PART, (xml) => {
        const docPrIndex = xml.search(new RegExp(`<wp:docPr\\s[^>]*\\bid="${this._drawingId}"`));
        if (docPrIndex < 0) return { xml };
        const inlineStart = xml.lastIndexOf('<wp:inline', docPrIndex);
        const inlineEnd = xml.indexOf('</wp:inline>', docPrIndex);
        if (inlineStart < 0 || inlineEnd < 0) return { xml };
        const resizedInline = xml.slice(inlineStart, inlineEnd)
          .replace(/<wp:extent\s+cx="\d+"\s+cy="\d+"/, `<wp:extent cx="${widthEmu}" cy="${heightEmu}"`)
          .replace(/<a:ext\s+cx="\d+"\s+cy="\d+"/, `<a:ext cx="${widthEmu}" cy="${heightEmu}"`);
        return { xml: xml.slice(0, inlineStart) + resizedInline + xml.slice(inlineEnd) };
      });
    }
  }

  // A paragraph is addressed by its position in document order; no edit made
  // through these shims adds or removes paragraphs, so the position is stable.
  class Paragraph {
    constructor(fileId, paragraphIndex) {
      this._fileId = fileId;
      this._paragraphIndex = paragraphIndex;
    }
    _paragraph(xml) {
      const paragraph = scanParagraphs(xml, 'w')[this._paragraphIndex];
      if (!paragraph) throw new Error('Paragraph no longer exists');
      return paragraph;
    }
    getType() { return 'PARAGRAPH'; }
    asParagraph() { return this; }
    asText() { return new TextElement(this._fileId, this._paragraphIndex); }
    editAsText() { return this.asText(); }
    getText() { return paragraphText(this._paragraph(readPart(this._fileId, DOCUMENT_PART))); }
    setText(newText) {
      editPart(this._fileId, DOCUMENT_PART, (xml) => ({ xml: setParagraphText(xml, this._paragraph(xml), String(newText), 'w') }));
      return this;
    }
    replaceText(searchPattern, replacement) {
      editPart(this._fileId, DOCUMENT_PART, (xml) => {
        const paragraph = this._paragraph(xml);
        replaceInTextNodes(paragraph.textNodes, String(searchPattern), String(replacement), false);
        return { xml: rewriteTextNodes(xml, [paragraph], 'w') };
      });
      return this;
    }
    // childIndex 0 puts the image at the paragraph start (after its properties);
    // any other index appends it, which covers every call in the gas code.
    insertInlineImage(childIndex, imageSource) {
      const imageBlob = imageSource && typeof imageSource._buffer === 'function' ? imageSource : imageSource.getBlob();
      const imageBytes = imageBlob._buffer();
      const imageInfo = describeImage(imageBytes);
      if (!imageInfo) throw new Error('insertInlineImage: unsupported image data (expected PNG, JPEG or GIF), got ' + imageBlob.getContentType());
      // Google sizes a new inline image at its pixel size; unknown sizes get a sane default.
      const widthPoints = imageInfo.width || 100;
      const heightPoints = imageInfo.height || 100;

      const drawingId = editPart(this._fileId, DOCUMENT_PART, (xml, archive) => {
        const paragraph = this._paragraph(xml);
        let mediaNumber = 1;
        while (archive.has(`word/media/basaer_image${mediaNumber}.${imageInfo.extension}`)) mediaNumber += 1;
        const mediaFileName = `basaer_image${mediaNumber}.${imageInfo.extension}`;
        archive.set('word/media/' + mediaFileName, imageBytes);
        const relationshipId = addImageRelationship(archive, mediaFileName);
        ensureContentTypeDefault(archive, imageInfo.extension, imageInfo.mime);

        const newDrawingId = Math.max(maxNumberIn(xml, /<wp:docPr\s[^>]*\bid="(\d+)"/g), maxNumberIn(xml, /<pic:cNvPr\s[^>]*\bid="(\d+)"/g)) + 1;
        const drawingXml = inlineDrawingXml({
          drawingId: newDrawingId,
          relationshipId,
          mediaFileName,
          widthEmu: Math.round(widthPoints * EMU_PER_POINT),
          heightEmu: Math.round(heightPoints * EMU_PER_POINT),
        });
        let editedXml;
        if (paragraph.selfClosing) {
          const openTag = xml.slice(paragraph.openStart, paragraph.openEnd).replace(/\s*\/>$/, '>');
          editedXml = xml.slice(0, paragraph.openStart) + openTag + drawingXml + '</w:p>' + xml.slice(paragraph.openEnd);
        } else {
          let insertAt = paragraph.closeStart;
          if (!childIndex) {
            insertAt = paragraph.openEnd;
            const propertiesMatch = /^\s*<w:pPr\b(?:[^>]*\/>|[\s\S]*?<\/w:pPr>)/.exec(xml.slice(paragraph.openEnd, paragraph.closeStart));
            if (propertiesMatch) insertAt += propertiesMatch[0].length;
          }
          editedXml = xml.slice(0, insertAt) + drawingXml + xml.slice(insertAt);
        }
        return { xml: ensureRootNamespaces(editedXml), value: newDrawingId };
      });
      return new InlineImage(this._fileId, drawingId, widthPoints, heightPoints);
    }
  }

  // Apps Script's Text element; here it spans its paragraph's whole text, which
  // is what setText("") in replaceImage_ relies on.
  class TextElement {
    constructor(fileId, paragraphIndex) {
      this._fileId = fileId;
      this._paragraphIndex = paragraphIndex;
    }
    getType() { return 'TEXT'; }
    asText() { return this; }
    getParent() { return new Paragraph(this._fileId, this._paragraphIndex); }
    getText() { return this.getParent().getText(); }
    setText(newText) { this.getParent().setText(newText); return this; }
    replaceText(searchPattern, replacement) { this.getParent().replaceText(searchPattern, replacement); return this; }
  }

  class RangeElement {
    constructor(fileId, paragraphIndex, startOffset, endOffsetInclusive) {
      this._fileId = fileId;
      this._paragraphIndex = paragraphIndex;
      this._startOffset = startOffset;
      this._endOffsetInclusive = endOffsetInclusive;
    }
    getElement() { return new TextElement(this._fileId, this._paragraphIndex); }
    getStartOffset() { return this._startOffset; }
    getEndOffsetInclusive() { return this._endOffsetInclusive; }
    isPartial() { return true; }
  }

  class Body {
    constructor(fileId) { this._fileId = fileId; }
    getType() { return 'BODY_SECTION'; }
    // Apps Script takes a regular expression string; the gas code only passes
    // literal "{tag}" placeholders, so the pattern is matched literally.
    replaceText(searchPattern, replacement) {
      const searchText = String(searchPattern);
      const replacementText = replacement === undefined || replacement === null ? '' : String(replacement);
      editPart(this._fileId, DOCUMENT_PART, (xml) => {
        const paragraphs = scanParagraphs(xml, 'w');
        for (const paragraph of paragraphs) replaceInTextNodes(paragraph.textNodes, searchText, replacementText, false);
        return { xml: rewriteTextNodes(xml, paragraphs, 'w') };
      });
      return this;
    }
    // First match (literal) in document order, or after `fromRange` when given.
    findText(searchPattern, fromRange) {
      const searchText = String(searchPattern);
      const paragraphs = scanParagraphs(readPart(this._fileId, DOCUMENT_PART), 'w');
      const startParagraph = fromRange ? fromRange._paragraphIndex : 0;
      for (let paragraphIndex = startParagraph; paragraphIndex < paragraphs.length; paragraphIndex++) {
        const searchFrom = fromRange && paragraphIndex === startParagraph ? fromRange._endOffsetInclusive + 1 : 0;
        const matchStart = paragraphText(paragraphs[paragraphIndex]).indexOf(searchText, searchFrom);
        if (searchText && matchStart >= 0) {
          return new RangeElement(this._fileId, paragraphIndex, matchStart, matchStart + searchText.length - 1);
        }
      }
      return null;
    }
    getText() {
      return scanParagraphs(readPart(this._fileId, DOCUMENT_PART), 'w').map(paragraphText).join('\n');
    }
    getParagraphs() {
      const paragraphCount = scanParagraphs(readPart(this._fileId, DOCUMENT_PART), 'w').length;
      return Array.from({ length: paragraphCount }, (_, paragraphIndex) => new Paragraph(this._fileId, paragraphIndex));
    }
    editAsText() { return this; }
  }

  class Document {
    constructor(fileId) { this._id = fileId; }
    getId() { return this._id; }
    getName() { return requireRecord('DocumentApp', this._id).name; }
    setName(newName) { fileStore.renameFile(this._id, newName); return this; }
    getBody() { return new Body(this._id); }
    // Edits are already written through; kept for API compatibility.
    saveAndClose() {}
    // As in Apps Script, a Document's blob is its PDF rendering (oldJS.js
    // stores doc.getBlob() directly as the student's ID-card PDF, and
    // overwriteFile writes it over the certificate PDF).
    getBlob() { return this.getAs(PDF_MIME); }
    getAs(contentType) {
      const record = requireRecord('DocumentApp', this._id);
      const docxBytes = fileStore.readContent(this._id);
      if (contentType === DOCX_MIME) return new Blob(docxBytes, DOCX_MIME, nameWithExtension(record.name, 'docx'));
      if (contentType === PDF_MIME) return new Blob(convertWithSoffice(docxBytes, 'docx', 'pdf'), PDF_MIME, nameWithExtension(record.name, 'pdf'));
      return new Blob(docxBytes, DOCX_MIME, nameWithExtension(record.name, 'docx')).getAs(contentType);
    }
  }

  const DocumentApp = {
    openById(fileId) {
      const record = requirePackage('DocumentApp', String(fileId), DOCUMENT_PART, '.docx (Word)');
      return new Document(record.id);
    },
    ElementType: { BODY_SECTION: 'BODY_SECTION', PARAGRAPH: 'PARAGRAPH', TEXT: 'TEXT', INLINE_IMAGE: 'INLINE_IMAGE' },
  };

  // ---- SlidesApp --------------------------------------------------------

  class Presentation {
    constructor(fileId) { this._id = fileId; }
    getId() { return this._id; }
    getName() { return requireRecord('SlidesApp', this._id).name; }
    setName(newName) { fileStore.renameFile(this._id, newName); return this; }
    // Case-insensitive unless matchCase is true, like Apps Script; returns the
    // number of occurrences replaced.
    replaceAllText(findText, replaceText, matchCase) {
      const searchText = String(findText);
      const replacementText = replaceText === undefined || replaceText === null ? '' : String(replaceText);
      return editArchive(this._id, (archive) => {
        let replacementCount = 0;
        for (const partName of archive.names().filter((name) => SLIDE_PART_PATTERN.test(name))) {
          const slideXml = archive.getText(partName);
          const paragraphs = scanParagraphs(slideXml, 'a');
          for (const paragraph of paragraphs) {
            replacementCount += replaceInTextNodes(paragraph.textNodes, searchText, replacementText, !matchCase);
          }
          const rewrittenXml = rewriteTextNodes(slideXml, paragraphs, 'a');
          if (rewrittenXml !== slideXml) archive.set(partName, rewrittenXml);
        }
        return replacementCount;
      });
    }
    saveAndClose() {}
    getBlob() {
      const record = requireRecord('SlidesApp', this._id);
      return new Blob(fileStore.readContent(this._id), PPTX_MIME, nameWithExtension(record.name, 'pptx'));
    }
    getAs(contentType) { return this.getBlob().getAs(contentType); }
  }

  const SlidesApp = {
    openById(fileId) {
      const record = requirePackage('SlidesApp', String(fileId), PRESENTATION_PART, '.pptx (PowerPoint)');
      return new Presentation(record.id);
    },
  };

  return { DocumentApp, SlidesApp };
}

module.exports = { makeDocShims, scanParagraphs, replaceInTextNodes };
