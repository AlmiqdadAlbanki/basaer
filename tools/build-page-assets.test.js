'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const { DRIVE_IDS, buildPageAssets } = require('./build-page-assets.js');

const SITE_ASSETS_DIR = path.join(__dirname, '..', 'server', 'client', 'site-assets');

test('builds one PNG per replaced Drive id with the expected shapes', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-page-assets-'));
  try {
    const ids = buildPageAssets({ siteAssetsDir: SITE_ASSETS_DIR, outDir, log: () => {} });
    assert.deepStrictEqual(ids.sort(), Object.values(DRIVE_IDS).sort());
    const read = (id) => PNG.sync.read(fs.readFileSync(path.join(outDir, id + '.png')));

    const mark = read(DRIVE_IDS.logoMark);
    assert.strictEqual(mark.width, mark.height, 'the logo mark is square');
    assert.strictEqual(mark.data[3], 0, 'transparent padding in the top-left corner');
    const centre = (Math.floor(mark.height / 2) * mark.width + Math.floor(mark.width / 2)) * 4;
    assert.ok(mark.data[centre] > mark.data[centre + 2], 'red mark in the middle');

    const avatar = read(DRIVE_IDS.defaultAvatar);
    assert.strictEqual(avatar.width, 512);
    assert.strictEqual(avatar.data[3], 255, 'opaque');

    const banner = read(DRIVE_IDS.congratsBanner);
    assert.strictEqual(banner.width, 1200);
    assert.strictEqual(banner.height, 480);
    const bottomMiddle = (470 * banner.width + 600) * 4;
    assert.ok(banner.data[bottomMiddle] > 100 && banner.data[bottomMiddle + 1] < 60, 'plain red band left for the name');

    const wordmark = read(DRIVE_IDS.headerWordmark);
    assert.ok(wordmark.width > wordmark.height, 'horizontal wordmark');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
