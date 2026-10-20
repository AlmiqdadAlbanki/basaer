'use strict';

// Builds the page images the legacy pages reference by Google Drive id but that
// no longer exist for anyone (the originals belong to a Google account nobody
// has access to; they are broken on the live site as well). Sources are the
// academy's own logo files (server/client/site-assets/, from basaerbh.com).
//
//   node tools/build-page-assets.js [--out data/google-exports/code-assets]
//
// then `node tools/import-code-assets.js` registers the output so that
// /thumb?id=<id> serves it. Ids not built here (page background pattern,
// the three announcement-carousel placeholders) stay absent on purpose: the
// carousel is filled from the announcements sheet at runtime, and the
// background simply falls back to the page colour, as on the live site.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { parseArgs } = require('./xlsx-common.js');

const SITE_ASSETS_DIR = path.join(__dirname, '..', 'server', 'client', 'site-assets');
const DEFAULT_OUT_DIR = path.join(__dirname, '..', 'data', 'google-exports', 'code-assets');

const DRIVE_IDS = {
  logoMark: '1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX',       // login card, favicon, level badge, print reports
  headerWordmark: '1zgseX_0_TPsyQlCjiTjKzxJ4dR5lZ1_7', // sidebar brand on the student/employee/admin pages
  defaultAvatar: '1BifdUAOo6594jxvnkxOUiwXonhetUPpm',  // shown when a student/employee has no photo
  congratsBanner: '1X_j-eUotY8W4jHaDaGYe_AQttOr1RXQb', // congratulations card picture (name overlaid at the bottom)
};

function pixel(png, x, y) {
  const i = (y * png.width + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}
function setPixel(png, x, y, [r, g, b, a]) {
  const i = (y * png.width + x) * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a;
}
// Source-over compositing of an opaque colour with coverage `alpha` (0..1) onto an opaque pixel.
function blend(png, x, y, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const [dr, dg, db] = pixel(png, x, y);
  setPixel(png, x, y, [dr + (r - dr) * alpha, dg + (g - dg) * alpha, db + (b - db) * alpha, 255]);
}
const clamp01 = (value) => Math.max(0, Math.min(1, value));

// The red calligraphic mark cropped out of the colour wordmark, with the geometry
// of the site's own favicon-mark.svg (the 1786x553 picture placed at x=-180.8
// y=6.52 width=280.8 in a 100x100 box): a square with transparent padding above
// and below the picture.
function buildLogoMark(wordmark) {
  const scale = 280.8 / wordmark.width;
  const left = Math.round(180.8 / scale);
  const top = Math.round(-6.52 / scale);
  const size = Math.round(100 / scale);
  const mark = new PNG({ width: size, height: size }); // zero-filled = transparent
  for (let y = 0; y < wordmark.height; y++) {
    const destY = y - top;
    if (destY < 0 || destY >= size) continue;
    for (let x = left; x < wordmark.width; x++) setPixel(mark, x - left, destY, pixel(wordmark, x, y));
  }
  return mark;
}

// Light grey square with a soft "head and shoulders" silhouette.
function buildDefaultAvatar() {
  const size = 512;
  const avatar = new PNG({ width: size, height: size });
  const background = [233, 236, 239];
  const silhouette = [173, 181, 189];
  const head = { cx: 256, cy: 196, r: 92 };
  const shoulders = { cx: 256, cy: 470, rx: 200, ry: 150 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      setPixel(avatar, x, y, [...background, 255]);
      const headDistance = Math.hypot(x - head.cx, y - head.cy) - head.r;
      const shoulderDistance = (Math.hypot((x - shoulders.cx) / shoulders.rx, (y - shoulders.cy) / shoulders.ry) - 1) * shoulders.ry;
      blend(avatar, x, y, silhouette, clamp01(0.5 - Math.min(headDistance, shoulderDistance))); // 1px anti-aliased edge
    }
  }
  return avatar;
}

// Deep-red gradient with the white horizontal logo in the upper part; the lower
// fifth is left plain because the page overlays the student's name there.
function buildCongratsBanner(whiteLogo) {
  const width = 1200, height = 480;
  const banner = new PNG({ width, height });
  const from = [112, 20, 24], to = [185, 28, 36];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width) * 0.6 + (y / height) * 0.4;
      setPixel(banner, x, y, [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t, 255]);
    }
  }
  // Faint concentric rings top-right for some depth.
  for (const radius of [220, 300, 380]) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ringDistance = Math.abs(Math.hypot(x - 1080, y - 40) - radius) - 1.5;
        blend(banner, x, y, [255, 255, 255], clamp01(0.5 - ringDistance) * 0.08);
      }
    }
  }
  // The white logo scaled to 560px wide, centred, 4x4 supersampled.
  const logoWidth = 560;
  const scale = logoWidth / whiteLogo.width;
  const logoHeight = Math.round(whiteLogo.height * scale);
  const originX = Math.round((width - logoWidth) / 2), originY = 84;
  const samples = 4;
  for (let y = 0; y < logoHeight; y++) {
    for (let x = 0; x < logoWidth; x++) {
      let alphaSum = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const srcX = Math.min(whiteLogo.width - 1, Math.floor((x + (sx + 0.5) / samples) / scale));
          const srcY = Math.min(whiteLogo.height - 1, Math.floor((y + (sy + 0.5) / samples) / scale));
          alphaSum += pixel(whiteLogo, srcX, srcY)[3];
        }
      }
      blend(banner, originX + x, originY + y, [255, 255, 255], alphaSum / (samples * samples * 255));
    }
  }
  return banner;
}

function buildPageAssets({ siteAssetsDir, outDir, log }) {
  const readPng = (name) => PNG.sync.read(fs.readFileSync(path.join(siteAssetsDir, name)));
  const wordmark = readPng('logo-color.png');
  const whiteLogo = readPng('logo-white-horizontal.png');
  const built = {
    [DRIVE_IDS.logoMark]: buildLogoMark(wordmark),
    [DRIVE_IDS.headerWordmark]: wordmark,
    [DRIVE_IDS.defaultAvatar]: buildDefaultAvatar(),
    [DRIVE_IDS.congratsBanner]: buildCongratsBanner(whiteLogo),
  };
  fs.mkdirSync(outDir, { recursive: true });
  for (const [id, png] of Object.entries(built)) {
    const file = path.join(outDir, id + '.png');
    fs.writeFileSync(file, PNG.sync.write(png));
    log(`${png.width}x${png.height}  ${file}`);
  }
  return Object.keys(built);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out || DEFAULT_OUT_DIR);
  const ids = buildPageAssets({ siteAssetsDir: SITE_ASSETS_DIR, outDir, log: console.log });
  console.log(`${ids.length} image(s) built; register them with: node tools/import-code-assets.js`);
}

if (require.main === module) main();

module.exports = { DRIVE_IDS, buildPageAssets, buildLogoMark, buildDefaultAvatar, buildCongratsBanner };
