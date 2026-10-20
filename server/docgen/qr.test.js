'use strict';

// QR-code images: server/docgen/qr.js (module matrix from the `qrcode` package, PNG written by hand) and the
// UrlFetchApp shim, which answers api.qrserver.com requests with it in both outbound modes.
//
// PNGs are read back with an independent reader (its own CRC-32, zlib from the standard library) and compared with
// the module matrix `QRCode.create` yields for the same text, so a mirrored, shifted, inverted or mis-scaled picture
// fails here even though the suite has no QR decoder.

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const childProcess = require('child_process');
const QRCode = require('qrcode');

// The shim takes `spawnSync` from child_process when it is first required, so swap it out BEFORE requiring the shim:
// if live mode ever reached for curl (the real qrserver) the call would throw and be counted, not touch the network.
// Only curl is blocked; any other command (LibreOffice in other test files) goes through to the real spawnSync.
const realSpawnSync = childProcess.spawnSync;
const spawnSyncMock = test.mock.method(childProcess, 'spawnSync', (command, ...rest) => {
  if (command === 'curl') throw new Error('curl must not be spawned for a QR code');
  return realSpawnSync(command, ...rest);
});
const curlCallCount = () => spawnSyncMock.mock.calls.filter((call) => call.arguments[0] === 'curl').length;

const { renderQrPng, parseQrServerUrl } = require('./qr.js');
const { makeUrlFetchApp } = require('../shims/urlfetch.js');
const { Storage } = require('../storage.js');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];
const DRIVE_URL = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=drivesdk'; // 37 modules at level M
const CPR_PAYLOAD = JSON.stringify({ cpr: '123456789' }); // 25 modules
const ARABIC_TEXT = 'شهادة اجتياز مرحلة — محمد & أحمد؟';

// The QR URLs exactly as the gas code builds them (colours as in gas/code.js:182-185).
const OLD_JS_URL = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(JSON.stringify({ cpr: '123456789' }))}&color=325969&bgcolor=ffffff00&margin=0`; // gas/oldJS.js:240
const DATA_POST_URL = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=' + 'a77d52' + '&bgcolor=FFFFFF00&data=' + encodeURIComponent(DRIVE_URL); // gas/dataPost.js:3166 and :3338
const STAGE_CERT_URL = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=' + 'E42F28' + '&bgcolor=FFFFFF00&data=' + encodeURIComponent(DRIVE_URL); // gas/dataPost.js:3290

// Bitwise CRC-32, kept apart from the zlib/table version qr.js uses so the check is independent of it.
function referenceCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Strict reader for the PNGs renderQrPng writes: 8-bit RGBA, not interlaced, filter type 0 on every row. Fails the
// test on anything malformed: bad signature or CRC, extra or missing chunks, trailing bytes, wrong inflated length.
function readPng(pngBytes) {
  assert.deepStrictEqual(Array.from(pngBytes.subarray(0, 8)), PNG_SIGNATURE, 'PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset < pngBytes.length) {
    const bodyLength = pngBytes.readUInt32BE(offset);
    const type = pngBytes.toString('latin1', offset + 4, offset + 8);
    const typeAndBody = pngBytes.subarray(offset + 4, offset + 8 + bodyLength);
    assert.strictEqual(pngBytes.readUInt32BE(offset + 8 + bodyLength), referenceCrc32(typeAndBody), `CRC of the ${type} chunk`);
    chunks.push({ type, body: typeAndBody.subarray(4) });
    offset += 12 + bodyLength;
  }
  assert.strictEqual(offset, pngBytes.length, 'nothing after the last chunk');
  assert.deepStrictEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
  const header = chunks[0].body;
  assert.strictEqual(header.length, 13);
  assert.deepStrictEqual(Array.from(header.subarray(8)), [8, 6, 0, 0, 0], '8-bit RGBA, deflate, standard filtering, not interlaced');
  assert.strictEqual(chunks[2].body.length, 0, 'IEND is empty');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const scanlines = zlib.inflateSync(chunks[1].body);
  const rowBytes = 1 + width * 4;
  assert.strictEqual(scanlines.length, rowBytes * height, 'inflated size');
  const distinctColours = new Set();
  for (let row = 0; row < height; row++) {
    assert.strictEqual(scanlines[row * rowBytes], 0, `row ${row} has filter type 0`);
    for (let column = 0; column < width; column++) distinctColours.add(scanlines.readUInt32BE(row * rowBytes + 1 + column * 4));
  }
  return {
    width,
    height,
    pixelAt: (x, y) => Array.from(scanlines.subarray(y * rowBytes + 1 + x * 4, y * rowBytes + 5 + x * 4)),
    distinctColours, // as RGBA packed into an unsigned 32-bit number, see packRgba
  };
}

function packRgba([red, green, blue, alpha]) {
  return ((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0;
}

// The picture must show exactly the module matrix qrcode makes for `data` (level M): the centre of every module has the
// right colour, nothing but the two colours appears, and the quiet zone is all background. Fails on a transposed,
// mirrored, shifted, inverted or mis-scaled picture.
function assertPictureShowsMatrix(pngBytes, { data, size, margin = 0, dark = BLACK, light = WHITE }) {
  const picture = readPng(pngBytes);
  assert.strictEqual(picture.width, size, 'picture width');
  assert.strictEqual(picture.height, size, 'picture height');
  assert.deepStrictEqual(Array.from(picture.distinctColours).sort(), [packRgba(dark), packRgba(light)].sort(), 'only the two colours appear');

  const { modules } = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const cellCount = modules.size + 2 * margin;
  const wrongModules = [];
  for (let row = 0; row < modules.size; row++) {
    for (let column = 0; column < modules.size; column++) {
      const centreX = Math.floor(((margin + column + 0.5) * size) / cellCount);
      const centreY = Math.floor(((margin + row + 0.5) * size) / cellCount);
      const expected = modules.get(row, column) ? dark : light;
      if (packRgba(picture.pixelAt(centreX, centreY)) !== packRgba(expected)) wrongModules.push(`(${row},${column})`);
    }
  }
  assert.deepStrictEqual(wrongModules, [], 'modules whose centre pixel has the wrong colour');

  const quietBand = Math.floor((margin * size) / cellCount); // whole pixels that lie inside the margin whatever the rounding
  for (let along = 0; along < size; along++) {
    for (let depth = 0; depth < quietBand; depth++) {
      for (const [x, y] of [[along, depth], [along, size - 1 - depth], [depth, along], [size - 1 - depth, along]]) {
        assert.deepStrictEqual(picture.pixelAt(x, y), light, `quiet zone pixel (${x},${y})`);
      }
    }
  }
}

// --- renderQrPng ------------------------------------------------------------------------------------------------

test('the PNG has the signature and exactly the requested width and height', () => {
  for (const size of [200, 300, 123, 370, 1000]) {
    const png = renderQrPng({ data: DRIVE_URL, size });
    assert.deepStrictEqual(Array.from(png.subarray(0, 8)), PNG_SIGNATURE);
    // The offsets the DocumentApp shim reads the image size from.
    assert.strictEqual(png.readUInt32BE(16), size, `IHDR width for size ${size}`);
    assert.strictEqual(png.readUInt32BE(20), size, `IHDR height for size ${size}`);
    const picture = readPng(png);
    assert.deepStrictEqual([picture.width, picture.height], [size, size]);
  }
});

test('every module of the qrcode matrix is drawn, at integer and fractional scales, with and without a margin', () => {
  for (const data of [DRIVE_URL, CPR_PAYLOAD, ARABIC_TEXT]) {
    for (const size of [200, 300, 123, 370]) {
      for (const margin of [0, 1, 4]) {
        assertPictureShowsMatrix(renderQrPng({ data, size, margin }), { data, size, margin });
      }
    }
  }
});

test('the module count implied by the picture is the size of the qrcode matrix', () => {
  for (const data of [DRIVE_URL, CPR_PAYLOAD, ARABIC_TEXT]) {
    const moduleCount = QRCode.create(data, { errorCorrectionLevel: 'M' }).modules.size;
    const size = moduleCount * 8; // 8 pixels per module and no margin, so the scale is a whole number
    const picture = readPng(renderQrPng({ data, size }));
    let finderRun = 0; // the top row of the top-left finder pattern is 7 dark modules
    while (finderRun < size && packRgba(picture.pixelAt(finderRun, 0)) === packRgba(BLACK)) finderRun++;
    assert.strictEqual(finderRun, 7 * 8);
    assert.strictEqual(size / (finderRun / 7), moduleCount);
  }
});

test('a transparent background (bgcolor ending in 00) is written as alpha 0, the modules stay opaque', () => {
  const png = renderQrPng({ data: CPR_PAYLOAD, size: 300, color: 'a77d52', bgcolor: 'FFFFFF00' });
  assertPictureShowsMatrix(png, { data: CPR_PAYLOAD, size: 300, dark: [167, 125, 82, 255], light: [255, 255, 255, 0] });
  const withMargin = renderQrPng({ data: CPR_PAYLOAD, size: 300, color: '325969', bgcolor: 'ffffff00', margin: 4 });
  assertPictureShowsMatrix(withMargin, { data: CPR_PAYLOAD, size: 300, margin: 4, dark: [0x32, 0x59, 0x69, 255], light: [255, 255, 255, 0] });
  assert.deepStrictEqual(readPng(withMargin).pixelAt(0, 0), [255, 255, 255, 0], 'the quiet zone is transparent too');
});

test('colours: hex RGB and RGBA with or without #, the short forms, and decimal R-G-B', () => {
  const accepted = [
    ['a77d52', [167, 125, 82, 255]],
    ['A77D52', [167, 125, 82, 255]],
    ['#a77d52', [167, 125, 82, 255]],
    ['FFFFFF00', [255, 255, 255, 0]],
    ['ffffff00', [255, 255, 255, 0]],
    ['E42F2880', [228, 47, 40, 128]],
    ['f80', [255, 136, 0, 255]],
    ['f808', [255, 136, 0, 136]],
    ['255-0-128', [255, 0, 128, 255]],
  ];
  for (const [spelling, expected] of accepted) {
    // The top-left pixel with no margin is the first module of a finder pattern, always dark; with a margin it is background.
    assert.deepStrictEqual(readPng(renderQrPng({ data: 'x', size: 50, color: spelling })).pixelAt(0, 0), expected, `color ${spelling}`);
    assert.deepStrictEqual(readPng(renderQrPng({ data: 'x', size: 50, bgcolor: spelling, margin: 1 })).pixelAt(0, 0), expected, `bgcolor ${spelling}`);
  }
});

test('output is deterministic, and changes with the text, the size and the colours', () => {
  const options = { data: DRIVE_URL, size: 200, color: 'a77d52', bgcolor: 'FFFFFF00', margin: 0 };
  const first = renderQrPng(options);
  assert.ok(first.equals(renderQrPng({ ...options })), 'same input, same bytes');
  assert.ok(!first.equals(renderQrPng({ ...options, data: DRIVE_URL + 'x' })), 'different text');
  assert.ok(!first.equals(renderQrPng({ ...options, size: 201 })), 'different size');
  assert.ok(!first.equals(renderQrPng({ ...options, color: '000000' })), 'different colour');
  assert.ok(!first.equals(renderQrPng({ ...options, bgcolor: 'FFFFFF' })), 'different background');
  assert.ok(!first.equals(renderQrPng({ ...options, margin: 1 })), 'different margin');
});

test('defaults: 300 pixels, black on white, no margin; size may be a number, a string or WxH', () => {
  const byDefault = renderQrPng({ data: CPR_PAYLOAD });
  assert.ok(byDefault.equals(renderQrPng({ data: CPR_PAYLOAD, size: 300, color: '000000', bgcolor: 'FFFFFF', margin: 0 })));
  assertPictureShowsMatrix(byDefault, { data: CPR_PAYLOAD, size: 300 });
  const reference = renderQrPng({ data: CPR_PAYLOAD, size: 200 });
  for (const spelling of ['200', '200x200', '200X200', '200x100', ' 200 ']) {
    assert.ok(reference.equals(renderQrPng({ data: CPR_PAYLOAD, size: spelling })), `size ${JSON.stringify(spelling)} uses the width, 200`);
  }
});

test('options it cannot honour are refused with a clear error', () => {
  const refused = (options, errorName, messagePattern) => assert.throws(() => renderQrPng({ data: 'x', ...options }), { name: errorName, message: messagePattern });
  assert.throws(() => renderQrPng(), { name: 'TypeError', message: /data must be a non-empty string; got undefined/ });
  assert.throws(() => renderQrPng({ data: '' }), { name: 'TypeError', message: /got an empty string/ });
  assert.throws(() => renderQrPng({ data: 12345 }), { name: 'TypeError', message: /got number/ });
  for (const size of [9, 1001, 0, -5, 20.5, 'abc', '200x', '', null]) refused({ size }, 'RangeError', /size must be 10 to 1000 pixels/);
  for (const margin of [-1, 1.5, 'x', '', null]) refused({ margin }, 'RangeError', /margin must be a whole number of modules/);
  for (const color of ['zzz', '12345', '#1234567', '256-0-0', '']) refused({ color }, 'RangeError', /color must be hex RGB or RGBA/);
  refused({ bgcolor: 'nope' }, 'RangeError', /bgcolor must be hex RGB or RGBA/);
  assert.throws(() => renderQrPng({ data: DRIVE_URL, size: 30 }), { name: 'RangeError', message: /37 modules wide.*at least 37 pixels; size is 30/ });
  assert.throws(() => renderQrPng({ data: DRIVE_URL, size: 40, margin: 2 }), { name: 'RangeError', message: /at least 41 pixels; size is 40/ });
  assert.throws(() => renderQrPng({ data: 'a'.repeat(2400) }), /too big/);
});

// --- parseQrServerUrl ---------------------------------------------------------------------------------------------

test('parseQrServerUrl reads the URL shapes the gas code builds', () => {
  assert.deepStrictEqual(parseQrServerUrl(OLD_JS_URL), { data: CPR_PAYLOAD, size: 300, color: '325969', bgcolor: 'ffffff00', margin: 0 });
  assert.deepStrictEqual(parseQrServerUrl(DATA_POST_URL), { data: DRIVE_URL, size: 200, color: 'a77d52', bgcolor: 'FFFFFF00', margin: 0 });
  assert.deepStrictEqual(parseQrServerUrl(STAGE_CERT_URL), { data: DRIVE_URL, size: 200, color: 'E42F28', bgcolor: 'FFFFFF00', margin: 0 });
  for (const [url, size, data, margin, color] of [
    [OLD_JS_URL, 300, CPR_PAYLOAD, 0, [0x32, 0x59, 0x69, 255]],
    [DATA_POST_URL, 200, DRIVE_URL, 0, [167, 125, 82, 255]],
    [STAGE_CERT_URL, 200, DRIVE_URL, 0, [228, 47, 40, 255]],
  ]) {
    assertPictureShowsMatrix(renderQrPng(parseQrServerUrl(url)), { data, size, margin, dark: color, light: [255, 255, 255, 0] });
  }
});

test('parseQrServerUrl decodes the text exactly, whatever it contains', () => {
  for (const text of [DRIVE_URL, CPR_PAYLOAD, ARABIC_TEXT, 'a&b=c d+e%f#g?h', '100% /\\ "quoted" <tag>']) {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
    assert.strictEqual(parseQrServerUrl(url).data, text);
  }
});

test('parseQrServerUrl fills in defaults for missing or empty parameters and takes the width of WxH', () => {
  const defaults = { data: 'hello', size: 300, color: '000000', bgcolor: 'FFFFFF', margin: 0 };
  assert.deepStrictEqual(parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=hello'), defaults);
  assert.deepStrictEqual(parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=hello&size=&color=&bgcolor=&margin='), defaults);
  assert.strictEqual(parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=x&size=250').size, 250);
  assert.strictEqual(parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=x&size=120x80').size, 120);
  assert.strictEqual(parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=x&margin=3').margin, 3);
  assert.strictEqual(parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=x#fragment').data, 'x', 'a fragment is not sent to the server');
});

test('parseQrServerUrl refuses what is not a QR request', () => {
  assert.throws(() => parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?size=200x200'), { name: 'RangeError', message: /no data parameter/ });
  assert.throws(() => parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data='), { name: 'RangeError', message: /no data parameter/ });
  assert.throws(() => parseQrServerUrl('not a url'), { name: 'TypeError', message: /not an absolute URL/ });
  assert.throws(() => parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=x&size=5x5'), { name: 'RangeError', message: /size must be/ });
  assert.throws(() => parseQrServerUrl('https://api.qrserver.com/v1/create-qr-code/?data=x&margin=-1'), { name: 'RangeError', message: /margin must be/ });
});

// --- the UrlFetchApp shim -------------------------------------------------------------------------------------------

function makeShimFixture(mode) {
  const storage = new Storage(':memory:');
  const logLines = [];
  const UrlFetchApp = makeUrlFetchApp({ mode, storage, log: (line) => logLines.push(line) });
  const loggedRows = () => storage.db.prepare('SELECT mode, host, method, url, status, response FROM outbound_log ORDER BY id').all();
  return { UrlFetchApp, logLines, loggedRows };
}

for (const mode of ['dry-run', 'live']) {
  test(`${mode}: a qrserver URL is answered with a locally drawn PNG, without curl, logged as local-qr`, () => {
    const { UrlFetchApp, logLines, loggedRows } = makeShimFixture(mode);
    const curlCallsBefore = curlCallCount();

    for (const [url, size, data, color] of [
      [OLD_JS_URL, 300, CPR_PAYLOAD, [0x32, 0x59, 0x69, 255]],
      [DATA_POST_URL, 200, DRIVE_URL, [167, 125, 82, 255]],
    ]) {
      const response = UrlFetchApp.fetch(url);
      assert.strictEqual(response.getResponseCode(), 200);
      const blob = response.getBlob();
      assert.strictEqual(blob.getContentType(), 'image/png');
      const pngBytes = Buffer.from(blob.getBytes());
      assert.deepStrictEqual(Array.from(pngBytes.subarray(0, 8)), PNG_SIGNATURE);
      assert.ok(Buffer.from(response.getContent()).equals(pngBytes), 'getContent and getBlob agree');
      assert.deepStrictEqual(response.getHeaders(), { 'Content-Type': 'image/png' });
      assertPictureShowsMatrix(pngBytes, { data, size, dark: color, light: [255, 255, 255, 0] });
      assert.ok(pngBytes.equals(renderQrPng(parseQrServerUrl(url))));
    }

    assert.strictEqual(curlCallCount(), curlCallsBefore, 'curl was not spawned');
    const rows = loggedRows();
    assert.strictEqual(rows.length, 2);
    for (const row of rows) {
      assert.strictEqual(row.mode, 'local-qr', 'not recorded as dry-run or live traffic');
      assert.strictEqual(row.host, 'api.qrserver.com');
      assert.strictEqual(row.method, 'GET');
      assert.strictEqual(row.status, 200);
      assert.match(row.response, /^\(local-qr\) image\/png, \d+ bytes$/);
    }
    assert.deepStrictEqual(rows.map((row) => row.url), [OLD_JS_URL, DATA_POST_URL]);
    assert.strictEqual(logLines.length, 2);
    for (const line of logLines) {
      assert.match(line, /^LOCAL-QR GET api\.qrserver\.com\/v1\/create-qr-code\/ \(\d+ bytes\)$/);
      assert.ok(!/cpr|123456789|drive\.google/.test(line), 'the QR text stays out of the log line');
    }
  });

  test(`${mode}: the qrserver host is matched case-insensitively, over http too, and fetchAll goes through the same path`, () => {
    const { UrlFetchApp } = makeShimFixture(mode);
    const curlCallsBefore = curlCallCount();
    const shouted = DATA_POST_URL.replace('https://api.qrserver.com', 'http://API.QRSERVER.COM');
    const [first, second] = UrlFetchApp.fetchAll([shouted, { url: STAGE_CERT_URL, method: 'get' }]);
    assert.ok(Buffer.from(first.getContent()).equals(renderQrPng(parseQrServerUrl(DATA_POST_URL))));
    assert.ok(Buffer.from(second.getContent()).equals(renderQrPng(parseQrServerUrl(STAGE_CERT_URL))));
    assert.strictEqual(curlCallCount(), curlCallsBefore);
  });

  test(`${mode}: a QR request that cannot be drawn fails with a clear error and never falls back to the network`, () => {
    const { UrlFetchApp, loggedRows } = makeShimFixture(mode);
    const curlCallsBefore = curlCallCount();
    assert.throws(
      () => UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=200x200'),
      { message: /UrlFetchApp: could not draw the QR code for api\.qrserver\.com: QR URL has no data parameter/ },
    );
    assert.throws(
      () => UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=20x20&data=' + encodeURIComponent(DRIVE_URL)),
      { message: /could not draw the QR code.*at least 37 pixels/ },
    );
    assert.strictEqual(curlCallCount(), curlCallsBefore);
    assert.deepStrictEqual(loggedRows(), [], 'nothing is recorded for a request that was not served');
  });
}

test('the curl mock is wired in: live mode still reaches for curl for every other host', () => {
  const { UrlFetchApp } = makeShimFixture('live');
  const curlCallsBefore = curlCallCount();
  assert.throws(() => UrlFetchApp.fetch('https://api.fonnte.com/send'), /curl must not be spawned/);
  assert.strictEqual(curlCallCount(), curlCallsBefore + 1, 'so a zero count for the QR requests above is meaningful');
});

test('dry-run still answers other hosts as before, recorded as dry-run', () => {
  const { UrlFetchApp, loggedRows } = makeShimFixture('dry-run');
  const whatsapp = UrlFetchApp.fetch('https://api.fonnte.com/send', { method: 'post', payload: JSON.stringify({ target: '1', message: 'hi' }) });
  assert.strictEqual(whatsapp.getResponseCode(), 200);
  assert.strictEqual(JSON.parse(whatsapp.getContentText()).detail, 'dry-run');
  // The Slides PNG export is still the 1x1 placeholder: only QR codes are drawn for real.
  const slideExport = UrlFetchApp.fetch('https://docs.google.com/presentation/d/abc/export/png');
  assert.strictEqual(slideExport.getBlob().getContentType(), 'image/png');
  const slideBytes = Buffer.from(slideExport.getBlob().getBytes());
  assert.deepStrictEqual(Array.from(slideBytes.subarray(0, 8)), PNG_SIGNATURE);
  assert.deepStrictEqual([slideBytes.readUInt32BE(16), slideBytes.readUInt32BE(20)], [1, 1]);
  assert.deepStrictEqual(loggedRows().map((row) => [row.mode, row.host]), [['dry-run', 'api.fonnte.com'], ['dry-run', 'docs.google.com']]);
});
