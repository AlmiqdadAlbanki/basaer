'use strict';

// The academy's public website (the marketing pages that were on Firebase Hosting at
// basaerbh.com) is served by this server from server/client/site/: / is the home page,
// /platform the header bar with the app framed from /app, /student-guide the guide, /assets/*
// the site's files. The app's shell moved from / and /p/* to /app and /app/p/*.
//
// The first half checks the copied files. The second half boots the real server on a spare
// port, with a throwaway database, and checks what a browser receives at each of those paths.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { rewriteGoogleFontsUrls } = require('./page-rewrites.js');

const SERVER_DIR = __dirname;
const ROOT_DIR = path.join(SERVER_DIR, '..');
const SITE_DIR = path.join(SERVER_DIR, 'client', 'site');
const FONTS_DIR = path.join(SERVER_DIR, 'client', 'fonts');
const SITE_PAGES = ['index.html', 'platform.html', 'student-guide.html'];
const SITE_STYLESHEET = path.join('assets', 'css', 'style.css');

// What no page of the site may name once served: Google Analytics, Google Fonts and its font
// host, the Firebase SDK, and the Apps Script web app the platform page used to frame.
const GOOGLE_HOSTS = /googletagmanager|gstatic|googleapis|firebase|script\.google/i;
const GOOGLE_FONTS_URL_TOKEN_RE = /https:\/\/fonts\.googleapis\.com\/[^\s"'<>()\\]*/g;

// Files the pages name that were not in the Firebase Hosting export, so they answer 404 here
// (they answer 404 on basaerbh.com itself too: the live home page shows the same broken
// lecturer photos). If one turns up, copy it into server/client/site/assets/ and take it off
// this list.
const NAMED_BUT_MISSING_FROM_THE_EXPORT = new Set([
  'assets/images/lecturer-temp-1.png', // the five lecturer photos on the home page
  'assets/images/lecturer-temp-2.png',
  'assets/images/lecturer-temp-3.png',
  'assets/images/lecturer-temp-4.png',
  'assets/images/lecturer-temp-5.png',
]);

function readSiteFile(relativePath) {
  return fs.readFileSync(path.join(SITE_DIR, relativePath), 'utf8');
}

// assert.doesNotMatch(page, ...) would print the whole page as the failing value; this names
// what was found instead. The pattern must not be global.
function assertTextLacks(text, pattern, label) {
  const found = pattern.exec(text);
  assert.strictEqual(found ? found[0] : null, null, `${label} still contains ${found ? JSON.stringify(found[0]) : ''}`);
}

// ---- The copied files --------------------------------------------------------------------------

describe('the website files in server/client/site/', () => {
  it('has the pages, the PDF and the root files, and none of the pages that were left out', () => {
    for (const fileName of [...SITE_PAGES, 'student-guide.pdf', 'favicon.ico', 'robots.txt', 'sitemap.xml', SITE_STYLESHEET]) {
      assert.ok(fs.existsSync(path.join(SITE_DIR, fileName)), `${fileName} is missing`);
    }
    // The relay pages live in server/client/relay/; the FCM service worker waits for a Web Push port.
    for (const leftOut of ['google-signin-relay.html', 'qr-scan-relay.html', 'firebase-messaging-sw.js', 'README.txt']) {
      assert.ok(!fs.existsSync(path.join(SITE_DIR, leftOut)), `${leftOut} must not be copied`);
    }
  });

  it('the pages link the clean paths, not the old .html file names', () => {
    for (const pageName of SITE_PAGES) {
      const linkedHtmlFiles = Array.from(readSiteFile(pageName).matchAll(/(?:href|src)\s*=\s*["']([^"']*\.html)\b/g), (match) => match[1]);
      assert.deepStrictEqual(linkedHtmlFiles, [], `${pageName} links .html files`);
    }
  });

  it('every file a page or the stylesheet names relatively exists, apart from the known gaps of the export', () => {
    const referencesChecked = [];
    for (const pageName of SITE_PAGES) {
      for (const match of readSiteFile(pageName).matchAll(/(?:href|src|srcset)\s*=\s*["'](assets\/[^"'?#\s]+)/g)) referencesChecked.push([pageName, match[1]]);
    }
    for (const match of readSiteFile(SITE_STYLESHEET).matchAll(/url\(\s*["']?\.\.\/([^"')?#]+)/g)) referencesChecked.push([SITE_STYLESHEET, 'assets/' + match[1]]);
    assert.ok(referencesChecked.length > 20, 'found almost no asset reference: has the search pattern gone stale?');
    for (const [referrer, assetPath] of referencesChecked) {
      if (NAMED_BUT_MISSING_FROM_THE_EXPORT.has(assetPath)) continue;
      assert.ok(fs.existsSync(path.join(SITE_DIR, ...assetPath.split('/'))), `${referrer} names ${assetPath}, which does not exist`);
    }
    for (const missingPath of NAMED_BUT_MISSING_FROM_THE_EXPORT) {
      assert.ok(!fs.existsSync(path.join(SITE_DIR, ...missingPath.split('/'))), `${missingPath} exists now: take it off NAMED_BUT_MISSING_FROM_THE_EXPORT`);
    }
  });

  it('every Google Fonts URL in the pages and the stylesheet is mapped to a local stylesheet that exists', () => {
    let urlsChecked = 0;
    for (const relativePath of [...SITE_PAGES, SITE_STYLESHEET]) {
      for (const urlToken of readSiteFile(relativePath).match(GOOGLE_FONTS_URL_TOKEN_RE) || []) {
        const rewritten = rewriteGoogleFontsUrls(urlToken);
        assert.match(rewritten, /^\/fonts\/[a-z0-9-]+\.css$/, `${relativePath}: ${urlToken} is not in GOOGLE_FONTS_STYLESHEET_REWRITES (page-rewrites.js)`);
        assert.ok(fs.existsSync(path.join(FONTS_DIR, path.basename(rewritten))), `${relativePath}: ${rewritten} does not exist`);
        urlsChecked++;
      }
    }
    assert.ok(urlsChecked >= 2, 'expected the guide and the stylesheet to name Google Fonts: update this test');
  });

  it('platform.html frames /app and has no push-notification parts left', () => {
    const platformPage = readSiteFile('platform.html');
    assert.ok(platformPage.includes('<iframe id="platform-frame" src="/app"'));
    assertTextLacks(platformPage, /fcm-|serviceWorker|saveFcmToken|VAPID/i, 'platform.html');
    assertTextLacks(platformPage, GOOGLE_HOSTS, 'platform.html');
    assert.ok(platformPage.includes('frame.src = frame.src;'), 'the reload link reloads the frame');
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

// A GET that sends the path exactly as given: fetch() would percent-encode < > " in the query
// and fold /assets/%2e%2e/ into /.
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: rawPath }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
  });
}

// The website is edited in place (no content hashes in its file names), so its files are
// cached for an hour, not for a year like the app's hashed partials.
const SITE_FILE_CACHE_CONTROL = 'public, max-age=3600';
const SHELL_TITLE = '<title>بصائر للعلوم الشرعية</title>';

// The opening tag of the platform page's iframe, up to the end of its src attribute.
function platformFrameStart(pageHtml) {
  const match = /<iframe id="platform-frame" src="[^"]*"/.exec(pageHtml);
  return match ? match[0] : null;
}

describe('the running server', () => {
  let serverProcess;
  let serverLog = '';
  let scratchDirectory;
  let port;
  let baseUrl;

  before(async () => {
    scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'basaer-site-'));
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
    const response = await fetch(baseUrl + urlPath, { redirect: 'manual' });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  function assertServedPage(page, label) {
    assert.strictEqual(page.status, 200, label);
    assert.match(page.headers.get('content-type'), /^text\/html/, label);
    assert.strictEqual(page.headers.get('cache-control'), 'no-store', label);
  }

  it('serves the home page at /, without Google Analytics or any other Google host', async () => {
    const home = await getText('/');
    assertServedPage(home, '/');
    assert.ok(home.text.includes('<title>بصائر للعلوم الشرعية</title>'), 'the home page title');
    assert.ok(home.text.includes('<meta property="og:site_name" content="بصائر"/>'), 'the home page, not the app shell (which has the same title)');
    assert.ok(!home.text.includes('/partials/'), 'not the app shell');
    assertTextLacks(home.text, GOOGLE_HOSTS, '/');
    assert.ok(home.text.includes('href="/platform"') && home.text.includes('href="/student-guide"'));
  });

  it('serves the platform page with the app framed from /app, and no Google host', async () => {
    const platform = await getText('/platform');
    assertServedPage(platform, '/platform');
    assert.ok(platform.text.includes('<iframe id="platform-frame" src="/app" '), platformFrameStart(platform.text));
    assertTextLacks(platform.text, GOOGLE_HOSTS, '/platform');
    assertTextLacks(platform.text, /fcm-/, '/platform');
    assert.ok(platform.text.includes('<title>منصة بصائر التعليمية</title>'));
  });

  it('hands the query string /platform was asked with on to the framed app', async () => {
    assert.strictEqual(platformFrameStart((await getText('/platform?logout=1')).text), '<iframe id="platform-frame" src="/app?logout=1"');
    assert.strictEqual(platformFrameStart((await getText('/platform?logout=1&t=5')).text), '<iframe id="platform-frame" src="/app?logout=1&amp;t=5"');
    assert.strictEqual(platformFrameStart((await getText('/platform?')).text), '<iframe id="platform-frame" src="/app"');
  });

  it('shows the app\'s view in its own address: /platform/p/<view> frames /app/p/<view>', async () => {
    assert.strictEqual(platformFrameStart((await getText('/platform/p/students')).text), '<iframe id="platform-frame" src="/app/p/students"');
    assert.strictEqual(platformFrameStart((await getText('/platform/p/students?logout=1')).text), '<iframe id="platform-frame" src="/app/p/students?logout=1"');
    assert.strictEqual(platformFrameStart((await getText('/platform/p/%D8%B7%D9%84%D8%A7%D8%A8')).text), '<iframe id="platform-frame" src="/app/p/%D8%B7%D9%84%D8%A7%D8%A8"');
    // Deeper or odd paths fall back to the plain page (view-restore reads one segment only).
    for (const oddPath of ['/platform/p/students/extra', '/platform/p/', '/platform/p']) {
      const response = await fetch(`${baseUrl}${oddPath}?x=1`, { redirect: 'manual' });
      assert.strictEqual(response.status, 301, oddPath);
      assert.strictEqual(response.headers.get('location'), '/platform?x=1', oddPath);
    }
    // The frame reports its view to the page above (view-restore.js) and the page mirrors it.
    assert.ok(readSiteFile('platform.html').includes("event.data.type !== 'basaer:view-path'"), 'platform.html listens for the view path');
    assert.ok(fs.readFileSync(path.join(__dirname, 'client', 'view-restore.js'), 'utf8').includes("type: 'basaer:view-path'"), 'view-restore.js reports it');
  });

  it('sends a top-level visit to /app back under /platform, but serves the frame\'s own request', async () => {
    for (const [appPath, platformPath] of [['/app', '/platform'], ['/app/p/students', '/platform/p/students'], ['/app?logout=1', '/platform?logout=1']]) {
      const topLevel = await fetch(`${baseUrl}${appPath}`, { redirect: 'manual', headers: { 'Sec-Fetch-Dest': 'document' } });
      assert.strictEqual(topLevel.status, 302, appPath);
      assert.strictEqual(topLevel.headers.get('location'), platformPath, appPath);
      const framed = await fetch(`${baseUrl}${appPath}`, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
      assert.strictEqual(framed.status, 200, appPath);
      assert.ok((await framed.text()).includes(SHELL_TITLE), appPath);
    }
  });

  it('never lets the query string out of the iframe\'s src attribute', async () => {
    // fetch() percent-encodes < > and quotes in a query; the raw request sends them as they are.
    const viaFetch = await getText('/platform?x=<script>alert(1)</script>');
    const viaRawRequest = await rawGet(port, '/platform?x=<script>alert(1)</script>&q="onload="alert(2)&s=\'');
    // In a replacement string, String.replace would expand $& and $` into page text around the match.
    const viaReplacementPatterns = await getText('/platform?a=$&b=$`');
    for (const [label, pageHtml] of [['fetch', viaFetch.text], ['raw', viaRawRequest.body], ['$-patterns', viaReplacementPatterns.text]]) {
      const frameStart = platformFrameStart(pageHtml);
      assert.ok(frameStart && frameStart.startsWith('<iframe id="platform-frame" src="/app?'), `${label}: ${frameStart}`);
      const srcValue = frameStart.slice('<iframe id="platform-frame" src="'.length, -1);
      assert.doesNotMatch(srcValue, /[<>"']/, `${label}: ${srcValue}`);
      assert.ok(pageHtml.includes(`${frameStart} title="منصة بصائر التعليمية" allow="clipboard-write"></iframe>`), `${label}: the tag is intact`);
      assert.strictEqual((pageHtml.match(/<iframe\b/g) || []).length, 1, `${label}: one iframe`);
      assertTextLacks(pageHtml, /<script>alert/, label);
    }
    assert.strictEqual(viaRawRequest.status, 200);
    assert.strictEqual(platformFrameStart(viaFetch.text), '<iframe id="platform-frame" src="/app?x=%3Cscript%3Ealert(1)%3C/script%3E"');
    assert.strictEqual(platformFrameStart(viaRawRequest.body), '<iframe id="platform-frame" src="/app?x=%3Cscript%3Ealert(1)%3C/script%3E&amp;q=%22onload=%22alert(2)&amp;s=%27"');
    assert.strictEqual(platformFrameStart(viaReplacementPatterns.text), '<iframe id="platform-frame" src="/app?a=$&amp;b=$`"');
  });

  it('serves the app shell at /app and /app/p/*, frameable by the platform page (same origin)', async () => {
    for (const shellPath of ['/app', '/app/p/students', '/app/p/students?logout=1']) {
      const shell = await getText(shellPath);
      assertServedPage(shell, shellPath);
      assert.ok(shell.text.includes(SHELL_TITLE), shellPath);
      assert.ok(shell.text.includes('<script src="/partials/view-restore.'), `${shellPath} is the app shell`);
      // /platform frames /app from the same origin, which both headers allow (and nothing else).
      assert.strictEqual(shell.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.match(shell.headers.get('content-security-policy'), /(?:^|;\s*)frame-ancestors 'self'(?:;|$)/);
    }
  });

  it('redirects the app\'s old /p/* paths to /app/p/*, and the old file names to the clean paths', async () => {
    const expectedRedirects = [
      ['/p/students', '/app/p/students'],
      ['/p/students?x=1#ignored', '/app/p/students?x=1'],
      ['/index.html', '/'],
      ['/platform.html', '/platform'],
      ['/platform.html?logout=1', '/platform?logout=1'],
      ['/platform/', '/platform'],
      ['/platform/?logout=1', '/platform?logout=1'],
      ['/student-guide.html', '/student-guide'],
      ['/student-guide/', '/student-guide'],
    ];
    for (const [oldPath, newPath] of expectedRedirects) {
      const response = await fetch(baseUrl + oldPath, { redirect: 'manual' });
      assert.strictEqual(response.status, 301, oldPath);
      assert.strictEqual(response.headers.get('location'), newPath, oldPath);
    }
  });

  it('serves the student guide with the local Tajawal stylesheet and no Google font host, and its PDF', async () => {
    const guide = await getText('/student-guide');
    assertServedPage(guide, '/student-guide');
    assertTextLacks(guide.text, /fonts\.googleapis\.com|fonts\.gstatic\.com/, '/student-guide');
    assert.ok(guide.text.includes('<link href="/fonts/tajawal-400-500-700-800.css" rel="stylesheet">'));
    assert.strictEqual((await getText('/fonts/tajawal-400-500-700-800.css')).status, 200);
    assert.ok(guide.text.includes('href="/platform"') && guide.text.includes('href="/"'));

    const pdf = await fetch(`${baseUrl}/student-guide.pdf`);
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(Buffer.from(await pdf.arrayBuffer()).equals(fs.readFileSync(path.join(SITE_DIR, 'student-guide.pdf'))));
  });

  it('serves the site stylesheet with its Google Fonts @import pointed at the local copy', async () => {
    const stylesheet = await getText('/assets/css/style.css');
    assert.strictEqual(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
    assert.strictEqual(stylesheet.headers.get('cache-control'), SITE_FILE_CACHE_CONTROL);
    assert.ok(stylesheet.text.startsWith("@import url('/fonts/tajawal-400-500-700-800.css');"), stylesheet.text.slice(0, 120));
    assertTextLacks(stylesheet.text, /googleapis|gstatic/, '/assets/css/style.css');
    assert.strictEqual(stylesheet.text, rewriteGoogleFontsUrls(readSiteFile(SITE_STYLESHEET)), 'only the font URL differs from the file');
  });

  it('serves the other site files byte for byte under /assets/, cached for an hour', async () => {
    for (const [relativePath, contentTypePattern] of [
      ['assets/js/app.js', /^(?:application|text)\/javascript/],
      ['assets/data/fatawa.json', /^application\/json/],
      ['assets/images/logo-color.png', /^image\/png$/],
      ['assets/images/hero-basair.jpg', /^image\/jpeg$/],
      ['assets/fonts/IBMPlexSansArabic-Regular.woff2', /^font\/woff2$/],
    ]) {
      const response = await fetch(`${baseUrl}/${relativePath}`);
      assert.strictEqual(response.status, 200, relativePath);
      assert.match(response.headers.get('content-type'), contentTypePattern, relativePath);
      assert.strictEqual(response.headers.get('cache-control'), SITE_FILE_CACHE_CONTROL, relativePath);
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(SITE_DIR, ...relativePath.split('/')))), relativePath);
    }
  });

  it('serves /favicon.ico, /robots.txt and /sitemap.xml', async () => {
    for (const [rootFile, contentTypePattern] of [['favicon.ico', /^image\//], ['robots.txt', /^text\/plain/], ['sitemap.xml', /xml/]]) {
      const response = await fetch(`${baseUrl}/${rootFile}`);
      assert.strictEqual(response.status, 200, rootFile);
      assert.match(response.headers.get('content-type'), contentTypePattern, rootFile);
      assert.ok(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(SITE_DIR, rootFile))), rootFile);
    }
  });

  it('does not serve the files that were left out, lists no directory and never leaves the site folder', async () => {
    for (const notServed of ['/firebase-messaging-sw.js', '/google-signin-relay.html', '/qr-scan-relay.html', '/README.txt',
      '/assets', '/assets/', '/assets/css/', '/assets/images', '/assets/no-such-file.css', '/site/index.html', '/client/site/index.html']) {
      const response = await fetch(baseUrl + notServed, { redirect: 'manual' });
      assert.strictEqual(response.status, 404, `GET ${notServed}`);
    }
    for (const traversal of ['/assets/%2e%2e/index.html', '/assets/..%2f..%2f..%2findex.js', '/assets/css/%2e%2e/%2e%2e/%2e%2e/%2e%2e/index.js']) {
      const response = await rawGet(port, traversal);
      assert.ok([400, 403, 404].includes(response.status), `GET ${traversal} answered ${response.status}`);
      // Neither server source nor the site's own pages (index.html sits next to assets/).
      assert.doesNotMatch(response.body, /require\(|og:site_name/, `GET ${traversal} must not return a file from outside assets/`);
    }
  });
});
