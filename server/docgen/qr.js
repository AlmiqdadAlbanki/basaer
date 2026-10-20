'use strict';

// Local QR-code images, so the UrlFetchApp shim never has to call api.qrserver.com.
//
// The legacy Apps Script code builds every QR image by fetching
//   https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=a77d52&bgcolor=FFFFFF00&data=<url-encoded text>
// and inserting the reply blob into a Google Doc (replaceImage_ in gas/dataPost.js). That hands the link of every
// issued certificate to a third party (docs/SECURITY-FINDINGS.md), so the shim renders the image here instead —
// identically in dry-run and live mode, with no network access.
//
// UrlFetchApp is synchronous, which rules out the package's async toBuffer. The module matrix comes from the
// synchronous `create()` of the `qrcode` package; the PNG is then written below directly (signature, IHDR, one IDAT,
// IEND; 8-bit RGBA). Writing the ~40 lines of PNG ourselves keeps `qrcode`'s public `create()` the only thing we
// depend on: its own PNG renderer is an internal path, built on pngjs's stream API.
//
// Pixel layout is the one `qrcode` uses for its `width` and `margin` options: the image is exactly `size` pixels
// square and every module spans size / (modules + 2 * margin) pixels (fractional, nearest-neighbour), so a module is
// floor() or ceil() of that many pixels wide and the quiet zone is `margin` modules on each side. Boundaries are
// worked out in integer arithmetic, so pixels match qrcode's own renderer except where its floating-point scale
// rounds a boundary pixel into the neighbouring module, and the image is never a pixel short of `size` as qrcode's can be.
//
// qrserver parameters honoured: data, size (WxH — the width is used), color, bgcolor, margin. Where this differs
// from the real service it is on purpose:
//  - error correction is always M. qrserver defaults to L; M survives the wear of a printed card better. `ecc` is ignored.
//  - `margin` is the quiet zone in MODULES. qrserver's own `margin` is in pixels (its `qzone` is in modules). The gas
//    code passes margin=0 or nothing, where the two agree to within a pixel.
//  - defaults are ours (300 px, black on white, margin 0), not qrserver's (200 px, 1 px margin). Every call site in
//    gas/ passes size and colours explicitly.
//  - colours also take RGBA / RRGGBBAA. The gas code asks for a transparent background with bgcolor=FFFFFF00, which
//    qrserver does not document but evidently honours.
//  - format, charset-source/-target and qzone are ignored: the answer is always a PNG of the UTF-8 text.

const zlib = require('zlib');
const QRCode = require('qrcode');
const { crc32 } = require('./zip.js');

const ERROR_CORRECTION_LEVEL = 'M';
// qrserver's documented limits for raster images. The upper bound also caps what one call can allocate (4 MB of pixels).
const MIN_IMAGE_SIZE = 10;
const MAX_IMAGE_SIZE = 1000;
const DEFAULT_QR_OPTIONS = Object.freeze({ size: 300, color: '000000', bgcolor: 'FFFFFF', margin: 0 });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BIT_DEPTH = 8;
const PNG_COLOR_TYPE_RGBA = 6;

// 300, '300' or '300x300' -> 300. A non-square request uses its width: the image is always square.
function parseImageSize(size) {
  const match = /^(\d+)(?:x\d+)?$/i.exec(String(size).trim());
  const width = match ? Number(match[1]) : NaN;
  if (!(width >= MIN_IMAGE_SIZE && width <= MAX_IMAGE_SIZE)) {
    throw new RangeError(`QR size must be ${MIN_IMAGE_SIZE} to ${MAX_IMAGE_SIZE} pixels, as 300 or "300x300"; got ${String(size)}`);
  }
  return width;
}

// 0, 4 or '4' -> a whole number of modules.
function parseMarginModules(margin) {
  const text = String(margin).trim();
  if (!/^\d+$/.test(text)) throw new RangeError(`QR margin must be a whole number of modules, 0 or more; got ${String(margin)}`);
  return Number(text);
}

// 'a77d52', '#A77D52', 'FFFFFF00' (RRGGBBAA), the short forms 'fff' / 'fff0', or decimal '255-0-0' -> [r, g, b, a].
function parseColor(value, optionName) {
  const text = String(value).trim().replace(/^#/, '');
  const decimal = /^(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(text);
  if (decimal) {
    const channels = decimal.slice(1).map(Number);
    if (channels.every((channel) => channel <= 255)) return [...channels, 255];
  } else if (/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) {
    const digits = text.length <= 4 ? text.replace(/./g, '$&$&') : text;
    return [0, 2, 4, 6].map((digitIndex) => (digitIndex < digits.length ? parseInt(digits.slice(digitIndex, digitIndex + 2), 16) : 255));
  }
  throw new RangeError(`QR ${optionName} must be hex RGB or RGBA (a77d52, FFFFFF00) or decimal R-G-B (255-0-0); got ${String(value)}`);
}

// length | type | data | CRC-32 of type + data
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

// `scanlines` holds `height` rows, each one filter-type byte followed by width * 4 RGBA bytes.
function encodeRgbaPng(width, height, scanlines) {
  const header = Buffer.alloc(13); // compression, filter method and interlace stay 0
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = PNG_BIT_DEPTH;
  header[9] = PNG_COLOR_TYPE_RGBA;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: zlib.constants.Z_BEST_COMPRESSION })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Synchronous. color / bgcolor are hex, usually without '#': RRGGBB, or RRGGBBAA so 'FFFFFF00' is a transparent
// background (parseColor lists the other spellings). Throws RangeError / TypeError for options it cannot honour, and
// qrcode's own Error when `data` does not fit in a QR code (about 2300 bytes at level M).
function renderQrPng({
  data,
  size = DEFAULT_QR_OPTIONS.size,
  color = DEFAULT_QR_OPTIONS.color,
  bgcolor = DEFAULT_QR_OPTIONS.bgcolor,
  margin = DEFAULT_QR_OPTIONS.margin,
} = {}) {
  if (typeof data !== 'string' || data === '') throw new TypeError(`QR data must be a non-empty string; got ${data === '' ? 'an empty string' : typeof data}`);
  const imageSize = parseImageSize(size);
  const marginModules = parseMarginModules(margin);
  const darkPixel = parseColor(color, 'color');
  const lightPixel = parseColor(bgcolor, 'bgcolor');

  const { modules } = QRCode.create(data, { errorCorrectionLevel: ERROR_CORRECTION_LEVEL });
  const moduleCount = modules.size;
  const cellCount = moduleCount + 2 * marginModules; // modules plus the quiet zone on both sides
  if (cellCount > imageSize) {
    throw new RangeError(`This QR code is ${moduleCount} modules wide plus a margin of ${marginModules} on each side, which needs at least ${cellCount} pixels; size is ${imageSize}`);
  }

  // Which cell (module or margin) each pixel column falls in; rows split the same way.
  const cellOfPixel = new Uint16Array(imageSize);
  for (let pixelIndex = 0; pixelIndex < imageSize; pixelIndex++) cellOfPixel[pixelIndex] = Math.floor((pixelIndex * cellCount) / imageSize);

  const rowBytes = 1 + imageSize * 4;
  const scanlines = Buffer.alloc(rowBytes * imageSize); // each row starts with filter type 0 (None)
  for (let pixelRow = 0; pixelRow < imageSize; pixelRow++) {
    const rowStart = pixelRow * rowBytes;
    if (pixelRow > 0 && cellOfPixel[pixelRow] === cellOfPixel[pixelRow - 1]) {
      scanlines.copy(scanlines, rowStart, rowStart - rowBytes, rowStart); // same module row: repeat the scanline above
      continue;
    }
    const moduleRow = cellOfPixel[pixelRow] - marginModules;
    const rowHoldsModules = moduleRow >= 0 && moduleRow < moduleCount;
    let writeAt = rowStart + 1;
    for (let pixelColumn = 0; pixelColumn < imageSize; pixelColumn++) {
      const moduleColumn = cellOfPixel[pixelColumn] - marginModules;
      const isDark = rowHoldsModules && moduleColumn >= 0 && moduleColumn < moduleCount && modules.get(moduleRow, moduleColumn) === 1;
      const pixel = isDark ? darkPixel : lightPixel;
      scanlines[writeAt++] = pixel[0];
      scanlines[writeAt++] = pixel[1];
      scanlines[writeAt++] = pixel[2];
      scanlines[writeAt++] = pixel[3];
    }
  }
  return encodeRgbaPng(imageSize, imageSize, scanlines);
}

// Options for renderQrPng from a qrserver "create-qr-code" URL: `data` URL-decoded, `size` as the width in pixels,
// `margin` as a number, `color` / `bgcolor` as written in the URL (renderQrPng validates them). A missing or empty
// parameter takes renderQrPng's default, so the result always carries all five options.
function parseQrServerUrl(url) {
  let query;
  try {
    query = new URL(String(url)).searchParams;
  } catch (_) {
    throw new TypeError(`QR URL is not an absolute URL: ${String(url).slice(0, 80)}`);
  }
  const valueOrDefault = (name) => {
    const value = query.get(name);
    return value === null || value === '' ? DEFAULT_QR_OPTIONS[name] : value;
  };
  const data = query.get('data');
  if (data === null || data === '') throw new RangeError('QR URL has no data parameter');
  return {
    data,
    size: parseImageSize(valueOrDefault('size')),
    color: valueOrDefault('color'),
    bgcolor: valueOrDefault('bgcolor'),
    margin: parseMarginModules(valueOrDefault('margin')),
  };
}

module.exports = { renderQrPng, parseQrServerUrl };
