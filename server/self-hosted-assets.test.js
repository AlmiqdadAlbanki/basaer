'use strict';

// The fonts and files the legacy pages used to load from Google Fonts and from the old
// Firebase-hosted site are served by this server. page-rewrites.js points the pages at
// /fonts/* and /site-assets/*; server/index.js serves server/client/fonts/ and
// server/client/site-assets/.
//
// The first half checks the files and the rewrite functions against the real pages in gas/ and
// server/client/relay/. The second half boots the real server on a spare port, with a throwaway
// database, and checks what a browser actually receives: the shell page, the partials, the relay
// pages, the fonts and the old-site files.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  rewriteGoogleFontsUrls, rewriteOldSiteAssetUrls, rewriteLegacyShell, rewriteLegacyPartial,
  GOOGLE_FONTS_STYLESHEET_REWRITES, UNUSED_ICON_FONT_STYLESHEET_URLS, OLD_SITE_ASSET_URL_PREFIXES,
} = require('./page-rewrites.js');
const { makeHtmlService } = require('./shims/platform.js');

const SERVER_DIR = __dirname;
const ROOT_DIR = path.join(SERVER_DIR, '..');
const GAS_DIR = path.join(ROOT_DIR, 'gas');
const RELAY_DIR = path.join(SERVER_DIR, 'client', 'relay');
const FONTS_DIR = path.join(SERVER_DIR, 'client', 'fonts');
const FONT_FILES_DIR = path.join(FONTS_DIR, 'files');
const SITE_ASSETS_DIR = path.join(SERVER_DIR, 'client', 'site-assets');

// Hosts no page the browser receives may name any more.
const FORBIDDEN_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|coming-soon-basaer\.web\.app|basaerbh\.com\/assets/;

// A Google Fonts / old-site URL as it appears in text: up to the quote, bracket, space or
// backslash that ends it (the same rule page-rewrites.js uses for Google Fonts).
const GOOGLE_FONTS_URL_TOKEN_RE = /https:\/\/fonts\.googleapis\.com\/[^\s"'<>()\\]*/g;
const OLD_SITE_ASSET_URL_TOKEN_RE = /https:\/\/(?:coming-soon-basaer\.web\.app|basaerbh\.com)\/assets\/[^\s"'<>()\\]*/g;

function readPageSource(directory, fileName) {
  return fs.readFileSync(path.join(directory, fileName), 'utf8');
}

// Every page, partial and template a browser can receive: all of gas/*.html (the shell Main.html,
// the partials it includes, and the page templates the loadPage* functions return) and the relay
// pages. The directory is listed rather than named, so a page added later is covered too.
function pagesTheBrowserReceives() {
  const pages = [];
  for (const [directory, label] of [[GAS_DIR, 'gas'], [RELAY_DIR, 'server/client/relay']]) {
    for (const fileName of fs.readdirSync(directory).filter((name) => name.endsWith('.html')).sort()) {
      pages.push({ label: `${label}/${fileName}`, partialName: fileName.replace(/\.html$/, ''), text: readPageSource(directory, fileName) });
    }
  }
  return pages;
}

function tokensIn(text, tokenPattern) {
  return Array.from(text.matchAll(tokenPattern), (match) => match[0]);
}

// assert.doesNotMatch(page, ...) would print the whole page as the failing value; this names
// what was found instead. The pattern must not be global.
function assertTextLacks(text, pattern, label) {
  const found = pattern.exec(text);
  assert.strictEqual(found ? found[0] : null, null, `${label} still contains ${found ? JSON.stringify(found[0]) : ''}`);
}

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(entryPath));
    else files.push(entryPath);
  }
  return files;
}

const FONT_STYLESHEET_NAMES = fs.readdirSync(FONTS_DIR).filter((name) => name.endsWith('.css')).sort();

// ---- The local font files ----------------------------------------------------------------------

describe('local font stylesheets and files', () => {
  it('every stylesheet names only font files under /fonts/files/, and each of them exists', () => {
    assert.ok(FONT_STYLESHEET_NAMES.length > 0, 'no stylesheets in server/client/fonts/');
    for (const stylesheetName of FONT_STYLESHEET_NAMES) {
      const css = fs.readFileSync(path.join(FONTS_DIR, stylesheetName), 'utf8');
      assertTextLacks(css, /https?:\/\/|url\(\s*["']?\/\//i, `${stylesheetName} names another host:`);
      const fontUrls = Array.from(css.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g), (match) => match[2]);
      const fontFaceCount = (css.match(/@font-face\s*\{/g) || []).length;
      assert.ok(fontFaceCount > 0, `${stylesheetName} has no @font-face rule`);
      assert.strictEqual(fontUrls.length, fontFaceCount, `${stylesheetName}: every @font-face rule needs exactly one src url()`);
      for (const fontUrl of fontUrls) {
        assert.match(fontUrl, /^\/fonts\/files\/[a-z0-9-]+\.woff2$/, `${stylesheetName}: ${fontUrl}`);
        assert.ok(fs.existsSync(path.join(SERVER_DIR, 'client', fontUrl)), `${stylesheetName} names ${fontUrl}, which does not exist`);
      }
    }
  });

  it('every font file is a real woff2 that some stylesheet uses', () => {
    const namedByStylesheets = new Set();
    for (const stylesheetName of FONT_STYLESHEET_NAMES) {
      const css = fs.readFileSync(path.join(FONTS_DIR, stylesheetName), 'utf8');
      for (const match of css.matchAll(/\/fonts\/files\/([a-z0-9-]+\.woff2)/g)) namedByStylesheets.add(match[1]);
    }
    const fontFileNames = fs.readdirSync(FONT_FILES_DIR).sort();
    assert.ok(fontFileNames.length > 0);
    for (const fontFileName of fontFileNames) {
      assert.match(fontFileName, /^[a-z0-9-]+\.woff2$/);
      const firstBytes = fs.readFileSync(path.join(FONT_FILES_DIR, fontFileName)).subarray(0, 4).toString('latin1');
      assert.strictEqual(firstBytes, 'wOF2', `${fontFileName} is not a woff2 file`);
      assert.ok(namedByStylesheets.has(fontFileName), `${fontFileName} is used by no stylesheet; delete it`);
    }
  });

  it('the rewrite table and the stylesheets match one to one', () => {
    const googleUrls = GOOGLE_FONTS_STYLESHEET_REWRITES.map((rewrite) => rewrite.googleUrl);
    assert.strictEqual(new Set(googleUrls).size, googleUrls.length, 'a Google Fonts URL is listed twice');
    const ownStylesheets = new Set();
    for (const { googleUrl, ownUrl } of GOOGLE_FONTS_STYLESHEET_REWRITES) {
      assert.match(googleUrl, /^https:\/\/fonts\.googleapis\.com\/css2?\?/);
      assert.match(ownUrl, /^\/fonts\/[a-z0-9-]+\.css$/);
      assert.ok(fs.existsSync(path.join(SERVER_DIR, 'client', ownUrl)), `${ownUrl} (for ${googleUrl}) does not exist`);
      ownStylesheets.add(path.basename(ownUrl));
    }
    for (const stylesheetName of FONT_STYLESHEET_NAMES) {
      assert.ok(ownStylesheets.has(stylesheetName), `${stylesheetName} is the target of no rewrite; delete it or list its URL`);
    }
  });
});

// ---- rewriteGoogleFontsUrls --------------------------------------------------------------------

describe('rewriteGoogleFontsUrls', () => {
  it('maps every Google Fonts stylesheet URL in the pages, in both spellings, to a local stylesheet that exists', () => {
    const unusedIconFontUrls = new Set(UNUSED_ICON_FONT_STYLESHEET_URLS);
    let urlsChecked = 0;
    for (const page of pagesTheBrowserReceives()) {
      for (const urlToken of tokensIn(page.text, GOOGLE_FONTS_URL_TOKEN_RE)) {
        const plainUrl = urlToken.replace(/&amp;/g, '&');
        if (unusedIconFontUrls.has(plainUrl)) continue; // dropped with its <link>; see the test below
        for (const spelling of [plainUrl, plainUrl.replace(/&/g, '&amp;')]) {
          const rewritten = rewriteGoogleFontsUrls(spelling);
          assert.match(rewritten, /^\/fonts\/[a-z0-9-]+\.css$/, `${page.label}: ${spelling} is not in GOOGLE_FONTS_STYLESHEET_REWRITES (page-rewrites.js)`);
          assert.ok(fs.existsSync(path.join(FONTS_DIR, path.basename(rewritten))), `${page.label}: ${rewritten} does not exist`);
        }
        urlsChecked++;
      }
    }
    assert.ok(urlsChecked > 0, 'found no Google Fonts URL in any page: has the search pattern gone stale?');
  });

  it('rewrites the URL in an HTML attribute (&amp;), a script string (&), a CSS @import and single-quoted markup', () => {
    const inHtmlAttribute = '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&amp;family=Readex+Pro:wght@500;600;700&amp;display=swap" rel="stylesheet">';
    assert.strictEqual(rewriteGoogleFontsUrls(inHtmlAttribute),
      '<link href="/fonts/ibm-plex-sans-arabic-400-500-600-700--readex-pro-500-600-700.css" rel="stylesheet">');

    const inScriptString = "'<link href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap\" rel=\"stylesheet\">' +";
    assert.strictEqual(rewriteGoogleFontsUrls(inScriptString),
      "'<link href=\"/fonts/ibm-plex-sans-arabic-400-600-700.css\" rel=\"stylesheet\">' +");

    const inCssImport = "@import url('https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,300..900;1,300..900&display=swap');";
    assert.strictEqual(rewriteGoogleFontsUrls(inCssImport), "@import url('/fonts/rubik-300-to-900-with-italic.css');");

    const inSingleQuotedMarkup = "<link href='https://fonts.googleapis.com/css?family=Tajawal' rel='stylesheet'>";
    assert.strictEqual(rewriteGoogleFontsUrls(inSingleQuotedMarkup), "<link href='/fonts/tajawal-400.css' rel='stylesheet'>");
  });

  it('answers the request for weight 800 of IBM Plex Sans Arabic with the 400/600/700 stylesheet, which is what Google sent', () => {
    // IBM Plex Sans Arabic has no 800, so Google answered that URL with the faces for 400, 600 and 700.
    const withEight = rewriteGoogleFontsUrls('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700;800&display=swap');
    const withoutEight = rewriteGoogleFontsUrls('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap');
    assert.strictEqual(withEight, withoutEight);
    const css = fs.readFileSync(path.join(SERVER_DIR, 'client', withEight), 'utf8');
    assert.doesNotMatch(css, /font-weight:\s*800/);
  });

  it('leaves a Google Fonts URL it does not know alone, even when it merely starts like a known one', () => {
    const unknownFamily = 'https://fonts.googleapis.com/css2?family=Some+Other+Font&display=swap';
    const knownPlusParameter = 'https://fonts.googleapis.com/css2?family=Lora&display=swap&text=abc';
    for (const unknownUrl of [unknownFamily, knownPlusParameter]) {
      assert.strictEqual(rewriteGoogleFontsUrls(`<link href="${unknownUrl}" rel="stylesheet">`), `<link href="${unknownUrl}" rel="stylesheet">`);
    }
  });

  it('removes the preconnect hints to Google\'s font hosts together with their line, in any attribute order and quoting', () => {
    const before = [
      '<head>',
      '  <link rel="preconnect" href="https://fonts.googleapis.com">',
      '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      "  <link href='https://fonts.gstatic.com/' rel='preconnect'>",
      '  <link rel="dns-prefetch" href="//fonts.googleapis.com" />',
      '  <link href="https://fonts.googleapis.com/css2?family=Lora&display=swap" rel="stylesheet">',
      '  <link rel="preconnect" href="https://cdn.jsdelivr.net">',
      '</head>',
      '',
    ].join('\n');
    const after = [
      '<head>',
      '  <link href="/fonts/lora-400.css" rel="stylesheet">',
      '  <link rel="preconnect" href="https://cdn.jsdelivr.net">',
      '</head>',
      '',
    ].join('\n');
    assert.strictEqual(rewriteGoogleFontsUrls(before), after, 'only the Google font hosts lose their hint');
    assert.strictEqual(rewriteGoogleFontsUrls(before.replace(/\n/g, '\r\n')), after.replace(/\n/g, '\r\n'), 'CRLF line breaks');
  });

  it('removes the <link> elements of the unused Material Icons and Material Symbols fonts and keeps every other link', () => {
    const before = [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />',
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">',
      '',
    ].join('\n');
    assert.strictEqual(rewriteGoogleFontsUrls(before), '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css">\n');
  });

  it('is safe to apply twice', () => {
    for (const { googleUrl } of GOOGLE_FONTS_STYLESHEET_REWRITES) {
      const once = rewriteGoogleFontsUrls(`<link rel="preconnect" href="https://fonts.googleapis.com">\n<link href="${googleUrl}" rel="stylesheet">\n`);
      assert.strictEqual(rewriteGoogleFontsUrls(once), once);
    }
  });
});

describe('the icon fonts that are dropped instead of copied', () => {
  it('no page uses the Material Icons or Material Symbols fonts', () => {
    // If one does, copy that font next to the others instead of dropping its link (page-rewrites.js
    // drops the links only because nothing used the fonts, and the Symbols font alone is about 4 MB).
    const usesIconFont = /material[-_ ]?(?:icons|symbols)/i;
    for (const page of pagesTheBrowserReceives()) {
      assertTextLacks(page.text, usesIconFont, `${page.label} uses a Material icon font (see UNUSED_ICON_FONT_STYLESHEET_URLS in page-rewrites.js):`);
    }
  });
});

// ---- rewriteOldSiteAssetUrls -------------------------------------------------------------------

describe('rewriteOldSiteAssetUrls', () => {
  it('replaces both old-site prefixes with /site-assets/ and nothing else', () => {
    const before = [
      "<script src=\"https://coming-soon-basaer.web.app/assets/js/basaer-tree.js\"></script>",
      "BasaerTree.setFontUrl('https://coming-soon-basaer.web.app/assets/fonts/IBMPlexSansArabic-Regular.woff2');",
      "background:url('https://basaerbh.com/assets/images/logo-mark-white.png') no-repeat center/70% ;",
      "window.open('https://basaerbh.com/google-signin-relay');",
      "<a href=\"https://basaerbh.com/\">",
    ].join('\n');
    const after = [
      '<script src="/site-assets/js/basaer-tree.js"></script>',
      "BasaerTree.setFontUrl('/site-assets/fonts/IBMPlexSansArabic-Regular.woff2');",
      "background:url('/site-assets/images/logo-mark-white.png') no-repeat center/70% ;",
      "window.open('https://basaerbh.com/google-signin-relay');",
      '<a href="https://basaerbh.com/">',
    ].join('\n');
    assert.strictEqual(rewriteOldSiteAssetUrls(before), after);
    assert.strictEqual(rewriteOldSiteAssetUrls(after), after, 'idempotent');
    assert.deepStrictEqual(OLD_SITE_ASSET_URL_PREFIXES.map(([, ownPrefix]) => ownPrefix), ['/site-assets/', '/site-assets/']);
  });

  it('every old-site file the pages reference exists under /site-assets/, with the layout below assets/ kept', () => {
    let referencesChecked = 0;
    for (const page of pagesTheBrowserReceives()) {
      for (const urlToken of tokensIn(page.text, OLD_SITE_ASSET_URL_TOKEN_RE)) {
        const rewritten = rewriteOldSiteAssetUrls(urlToken);
        assert.match(rewritten, /^\/site-assets\/[A-Za-z0-9_.\/-]+$/, `${page.label}: ${urlToken}`);
        const expectedFile = path.join(SITE_ASSETS_DIR, ...rewritten.slice('/site-assets/'.length).split('/'));
        assert.ok(fs.existsSync(expectedFile), `${page.label} references ${urlToken}, but ${path.relative(ROOT_DIR, expectedFile)} does not exist`);
        referencesChecked++;
      }
    }
    assert.ok(referencesChecked > 0, 'found no old-site asset URL in any page: has the search pattern gone stale?');
  });

  it('every /site-assets/ file a page names once rewritten exists, whichever way the page names it', () => {
    for (const page of pagesTheBrowserReceives()) {
      for (const assetPath of tokensIn(rewriteLegacyShell(page.text), /\/site-assets\/[A-Za-z0-9_.\/-]+/g)) {
        const expectedFile = path.join(SITE_ASSETS_DIR, ...assetPath.slice('/site-assets/'.length).split('/'));
        assert.ok(fs.existsSync(expectedFile), `${page.label} names ${assetPath}, but ${path.relative(ROOT_DIR, expectedFile)} does not exist`);
      }
    }
  });

  it('the copied files are intact, and only a few files were copied, not the old site\'s whole assets folder', () => {
    const files = filesBelow(SITE_ASSETS_DIR);
    const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
    // The old site's assets folder is about 16 MB of marketing images; the three files pages use are ~100 KB.
    assert.ok(totalBytes < 1024 * 1024, `site-assets is ${totalBytes} bytes: copy only the files pages reference`);

    const logo = fs.readFileSync(path.join(SITE_ASSETS_DIR, 'images', 'logo-mark-white.png'));
    assert.deepStrictEqual(Array.from(logo.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
    const font = fs.readFileSync(path.join(SITE_ASSETS_DIR, 'fonts', 'IBMPlexSansArabic-Regular.woff2'));
    assert.strictEqual(font.subarray(0, 4).toString('latin1'), 'wOF2');
    const treeScript = fs.readFileSync(path.join(SITE_ASSETS_DIR, 'js', 'basaer-tree.js'), 'utf8');
    assert.match(treeScript, /global\.BasaerTree\s*=/, 'basaer-tree.js should define window.BasaerTree');
  });
});

// ---- The combined rewriters --------------------------------------------------------------------

describe('rewriteLegacyShell and rewriteLegacyPartial', () => {
  it('rewriteLegacyShell repoints Drive URLs, Google Fonts and old-site assets in one pass', () => {
    const before = [
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link href="https://fonts.googleapis.com/css2?family=Lora&display=swap" rel="stylesheet">',
      '<img src="https://drive.google.com/thumbnail?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&amp;sz=w1000.png">',
      '<script src="https://coming-soon-basaer.web.app/assets/js/basaer-tree.js"></script>',
      '',
    ].join('\n');
    const after = [
      '<link href="/fonts/lora-400.css" rel="stylesheet">',
      '<img src="/thumb?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX&amp;sz=w1000.png">',
      '<script src="/site-assets/js/basaer-tree.js"></script>',
      '',
    ].join('\n');
    assert.strictEqual(rewriteLegacyShell(before), after);
    assert.strictEqual(rewriteLegacyShell(after), after, 'idempotent');
  });

  it('rewriteLegacyPartial does everything rewriteLegacyShell does, plus the partial\'s own relay URLs', () => {
    const body = "var QR_SCAN_RELAY_URL_ = 'https://basaerbh.com/qr-scan-relay'; var font = 'https://basaerbh.com/assets/fonts/IBMPlexSansArabic-Regular.woff2'; var css = 'https://fonts.googleapis.com/css2?family=Lora&display=swap';";
    assert.strictEqual(rewriteLegacyPartial('js', body),
      "var QR_SCAN_RELAY_URL_ = '/relay/qr-scan'; var font = '/site-assets/fonts/IBMPlexSansArabic-Regular.woff2'; var css = '/fonts/lora-400.css';");
    assert.strictEqual(rewriteLegacyPartial('funcs-js', body).includes('https://basaerbh.com/qr-scan-relay'), true, 'another partial keeps the relay URL');
    assert.strictEqual(rewriteLegacyPartial('funcs-js', body).includes('fonts.googleapis.com'), false);
  });

  it('both are safe to apply twice on every real page', () => {
    for (const page of pagesTheBrowserReceives()) {
      const shell = rewriteLegacyShell(page.text);
      assert.strictEqual(rewriteLegacyShell(shell), shell, `${page.label} (shell)`);
      const partial = rewriteLegacyPartial(page.partialName, page.text);
      assert.strictEqual(rewriteLegacyPartial(page.partialName, partial), partial, `${page.label} (partial)`);
    }
  });

  it('after the rewrite no page, partial, template or relay page names Google Fonts, its font host or the old site\'s assets', () => {
    for (const page of pagesTheBrowserReceives()) {
      assertTextLacks(rewriteLegacyShell(page.text), FORBIDDEN_HOSTS, `${page.label} after rewriteLegacyShell`);
      assertTextLacks(rewriteLegacyPartial(page.partialName, page.text), FORBIDDEN_HOSTS, `${page.label} after rewriteLegacyPartial`);
    }
  });
});

describe('page templates returned by HtmlService (the loadPage* functions)', () => {
  // server/shims/platform.js (makeHtmlService) hands every template through
  // rewriteLegacyDriveUrls only, so registration.html reaches the browser, through
  // loadPageRegistration, still naming Google Fonts and basaerbh.com/assets. That file is
  // outside the change that added these rewrites; once makeHtmlService calls
  // rewriteLegacyShell instead, this test passes and the `todo` marker should be removed.
  it('are rewritten too', { todo: 'server/shims/platform.js still calls rewriteLegacyDriveUrls: switch it to rewriteLegacyShell' }, () => {
    const htmlService = makeHtmlService(GAS_DIR);
    for (const templateName of ['registration', 'login', 'student', 'emp', 'homePage', 'adminDashboard', 'Iqrar', 'questions']) {
      const templateHtml = htmlService.createTemplateFromFile(templateName).evaluate().getContent();
      assertTextLacks(templateHtml, FORBIDDEN_HOSTS, `${templateName}.html as loadPage* returns it`);
    }
  });
});

describe('the QR scanner relay page (server/client/relay/qr-scan.html)', () => {
  // The page plays its scan beep from a sound hosting site, a third party. The sound should be
  // copied into server/client/site-assets/ like the old-site files and the page pointed at the
  // copy; the download was refused by the permission system of the session that made this
  // change, so it is still to do. Once qr-scan.html names a /site-assets/ file instead, this
  // test passes (the "every /site-assets/ file exists" test above then checks the copy) and the
  // `todo` marker should be removed.
  it('plays its beep from this server', { todo: 'the beep is still fetched from assets.mixkit.co: copy it to site-assets/sounds/ and point qr-scan.html at it' }, () => {
    assertTextLacks(rewriteLegacyShell(readPageSource(RELAY_DIR, 'qr-scan.html')), /assets\.mixkit\.co/, 'qr-scan.html');
  });
});

// ---- What the running server serves ------------------------------------------------------------

async function findFreePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A GET that sends the path exactly as given: fetch() would fold /fonts/%2e%2e/ into /.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: rawPath }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
  });
}

const IMMUTABLE_FOR_A_YEAR = 'public, max-age=31536000, immutable';

describe('the running server', () => {
  let serverProcess;
  let serverLog = '';
  let scratchDirectory;
  let port;
  let baseUrl;

  before(async () => {
    scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-assets-'));
    port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    const environment = Object.assign({}, process.env, {
      BASAER_DB: path.join(scratchDirectory, 'basaer.sqlite'),
      BASAER_KEYS: path.join(scratchDirectory, 'keys'),
      BASAER_FILES: path.join(scratchDirectory, 'files'),
      PORT: String(port),
      OUTBOUND_MODE: 'dry-run',
      NODE_ENV: 'production',
    });
    delete environment.BASAER_REBUILD; // the one-time build is what production serves
    serverProcess = spawn(process.execPath, ['server/index.js'], { cwd: ROOT_DIR, env: environment });
    serverProcess.stdout.on('data', (chunk) => { serverLog += chunk; });
    serverProcess.stderr.on('data', (chunk) => { serverLog += chunk; });

    const deadline = Date.now() + 30000;
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      try {
        const response = await fetch(`${baseUrl}/healthz`);
        healthy = response.ok && (await response.json()).ok === true;
      } catch (_) { /* not listening yet */ }
      if (!healthy) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(healthy, 'the server did not become healthy:\n' + serverLog);
  });

  after(async () => {
    if (serverProcess) {
      const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
      serverProcess.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    if (scratchDirectory) fs.rmSync(scratchDirectory, { recursive: true, force: true });
  });

  async function getText(urlPath) {
    const response = await fetch(baseUrl + urlPath);
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  it('serves a shell page that names no Google Fonts or old-site URL and links the local copies', async () => {
    const shell = await getText('/');
    assert.strictEqual(shell.status, 200);
    assertTextLacks(shell.text, FORBIDDEN_HOSTS, 'the shell page');
    // The shell is stricter than the other pages: its only other Google references were the Firebase
    // SDK scripts, which index.js drops because the firebase shim replaces them.
    assertTextLacks(shell.text, /https?:\/\/[a-z0-9.-]*(?:google|gstatic|firebase)/i, 'the shell page');
    assert.ok(shell.text.includes('<script src="/site-assets/js/basaer-tree.js"></script>'));
    const stylesheetLinks = Array.from(shell.text.matchAll(/href=["'](\/fonts\/[^"']+\.css)["']/g), (match) => match[1]);
    assert.ok(stylesheetLinks.length > 0, 'the shell links no local font stylesheet');
    for (const stylesheetLink of stylesheetLinks) {
      assert.strictEqual((await getText(stylesheetLink)).status, 200, stylesheetLink);
    }
  });

  it('serves partials that carry the rewritten font and old-site URLs, and none of the old ones', async () => {
    const shell = await getText('/');
    const partialPaths = Array.from(shell.text.matchAll(/(?:href|src)="(\/partials\/[^"]+)"/g), (match) => match[1]);
    assert.ok(partialPaths.length >= 10, 'expected the shell to reference its partials');
    let fontOrAssetReferencesSeen = 0;
    for (const partialPath of partialPaths) {
      const partial = await getText(partialPath);
      assert.strictEqual(partial.status, 200, partialPath);
      assertTextLacks(partial.text, FORBIDDEN_HOSTS, partialPath);
      // Whatever Google Fonts or old-site URL the partial's source names must be in the served
      // partial as its local replacement.
      const partialName = path.basename(partialPath).split('.')[0];
      const sourcePath = path.join(GAS_DIR, partialName + '.html');
      if (!fs.existsSync(sourcePath)) continue;
      const source = fs.readFileSync(sourcePath, 'utf8');
      const unusedIconFontUrls = new Set(UNUSED_ICON_FONT_STYLESHEET_URLS);
      for (const urlToken of [...tokensIn(source, GOOGLE_FONTS_URL_TOKEN_RE), ...tokensIn(source, OLD_SITE_ASSET_URL_TOKEN_RE)]) {
        if (unusedIconFontUrls.has(urlToken)) continue;
        const replacement = rewriteOldSiteAssetUrls(rewriteGoogleFontsUrls(urlToken));
        assert.ok(partial.text.includes(replacement), `${partialPath} should contain ${replacement} in place of ${urlToken}`);
        fontOrAssetReferencesSeen++;
      }
    }
    assert.ok(fontOrAssetReferencesSeen > 0, 'no partial named a Google Fonts or old-site URL: has the check gone stale?');
  });

  it('serves relay pages that name no Google Fonts URL and link the local font stylesheet', async () => {
    for (const [route, fileName] of [['/relay/google-signin', 'google-signin.html'], ['/relay/qr-scan', 'qr-scan.html']]) {
      const page = await getText(route);
      assert.strictEqual(page.status, 200, route);
      assert.match(page.headers.get('content-type'), /^text\/html/);
      assert.strictEqual(page.headers.get('cache-control'), 'no-store');
      assertTextLacks(page.text, FORBIDDEN_HOSTS, route);
      const source = readPageSource(RELAY_DIR, fileName);
      const googleFontsUrls = tokensIn(source, GOOGLE_FONTS_URL_TOKEN_RE);
      assert.ok(googleFontsUrls.length > 0, `${fileName} no longer names Google Fonts: update this test`);
      for (const googleFontsUrl of googleFontsUrls) {
        assert.ok(page.text.includes(rewriteGoogleFontsUrls(googleFontsUrl)), `${route} should link ${rewriteGoogleFontsUrls(googleFontsUrl)}`);
      }
    }
  });

  it('serves every font stylesheet as text/css and every font file as font/woff2, immutable for a year and byte for byte', async () => {
    for (const stylesheetName of FONT_STYLESHEET_NAMES) {
      const response = await fetch(`${baseUrl}/fonts/${stylesheetName}`);
      assert.strictEqual(response.status, 200, stylesheetName);
      assert.match(response.headers.get('content-type'), /^text\/css/, stylesheetName);
      assert.strictEqual(response.headers.get('cache-control'), IMMUTABLE_FOR_A_YEAR, stylesheetName);
      assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(await response.text(), fs.readFileSync(path.join(FONTS_DIR, stylesheetName), 'utf8'));
    }
    const fontFileNames = fs.readdirSync(FONT_FILES_DIR);
    assert.ok(fontFileNames.length > 0);
    for (const fontFileName of fontFileNames) {
      const response = await fetch(`${baseUrl}/fonts/files/${fontFileName}`);
      assert.strictEqual(response.status, 200, fontFileName);
      assert.strictEqual(response.headers.get('content-type'), 'font/woff2', fontFileName);
      assert.strictEqual(response.headers.get('cache-control'), IMMUTABLE_FOR_A_YEAR, fontFileName);
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(FONT_FILES_DIR, fontFileName))), fontFileName);
    }
  });

  it('serves the old-site script, font and logo under /site-assets/ with the right types, immutable for a year', async () => {
    const expectations = [
      ['js/basaer-tree.js', /^(?:application|text)\/javascript/],
      ['fonts/IBMPlexSansArabic-Regular.woff2', /^font\/woff2$/],
      ['images/logo-mark-white.png', /^image\/png$/],
    ];
    for (const [relativePath, contentTypePattern] of expectations) {
      const response = await fetch(`${baseUrl}/site-assets/${relativePath}`);
      assert.strictEqual(response.status, 200, relativePath);
      assert.match(response.headers.get('content-type'), contentTypePattern, relativePath);
      assert.strictEqual(response.headers.get('cache-control'), IMMUTABLE_FOR_A_YEAR, relativePath);
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(SITE_ASSETS_DIR, relativePath))), relativePath);
    }
  });

  it('never lists directories, never leaves them, and only answers GET and HEAD', async () => {
    for (const notServed of ['/fonts/', '/fonts', '/fonts/files', '/fonts/files/', '/site-assets/', '/site-assets/js', '/site-assets/js/',
      '/fonts/files/no-such-font.woff2', '/site-assets/js/no-such-file.js', '/fonts/.hidden', '/site-assets/.hidden']) {
      const response = await fetch(baseUrl + notServed, { redirect: 'manual' });
      assert.strictEqual(response.status, 404, `GET ${notServed}`);
    }
    for (const traversal of ['/fonts/%2e%2e/index.js', '/fonts/..%2findex.js', '/fonts/files/%2e%2e/%2e%2e/index.js', '/site-assets/%2e%2e/%2e%2e/index.js', '/fonts/%00']) {
      const response = await rawGet(port, traversal);
      assert.ok([400, 403, 404].includes(response.status), `GET ${traversal} answered ${response.status}`);
      assert.doesNotMatch(response.body, /require\(/, `GET ${traversal} must not return source code`);
    }
    const posted = await fetch(`${baseUrl}/fonts/lora-400.css`, { method: 'POST', body: 'x' });
    assert.strictEqual(posted.status, 404);
    const headRequest = await fetch(`${baseUrl}/fonts/lora-400.css`, { method: 'HEAD' });
    assert.strictEqual(headRequest.status, 200);
    assert.match(headRequest.headers.get('content-type'), /^text\/css/);
  });
});
