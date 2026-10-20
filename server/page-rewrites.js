'use strict';

// Serve-time edits to the legacy page scripts.
//
// gas/ stays byte-identical to the Apps Script project, so anything the
// self-hosted server has to change in what it serves is done here, when
// buildPartials() (server/index.js) loads each partial, and nowhere else.
//
// The two helper pages the legacy client opens as popups, Google sign-in and
// the QR scanner, used to be hosted on Firebase Hosting
// (https://basaerbh.com/google-signin-relay and /qr-scan-relay), outside this
// repository, and are gone. Our own versions live in server/client/relay/ and
// are served by this server (GET /relay/google-signin and GET /relay/qr-scan in
// server/index.js), so the client has to be pointed at them. A root-relative
// URL resolves against whichever origin served the app, so one build works on
// localhost, on a staging host and in production. Using the same origin is also
// what lets those pages call /exec without CORS and use the camera under the
// app's Permissions-Policy.

// Partial name (the argument of include("...") in gas/Main.html, i.e. the file
// name without ".html") -> the legacy URLs inside it and what replaces them.
// The URLs are matched without their quotes so a change of quote style in gas/
// cannot silently skip the rewrite.
const LEGACY_RELAY_URL_REWRITES = new Map([
  // gas/auth-js.html:  const AUTH_OAUTH_RELAY_URL = '...';  (startOAuthRelay opens it with ?provider=&verifyToken=)
  ['auth-js', [{ legacyUrl: 'https://basaerbh.com/google-signin-relay', ownUrl: '/relay/google-signin' }]],
  // gas/js.html:  var QR_SCAN_RELAY_URL_ = '...';  (openQrScannerPage opens it with ?t=&session=)
  ['js', [{ legacyUrl: 'https://basaerbh.com/qr-scan-relay', ownUrl: '/relay/qr-scan' }]],
]);

// Returns partialBody with the legacy relay URLs replaced by our own routes.
// Partials that name no legacy URL (everything except auth-js and js) come back
// unchanged. Safe to apply twice.
function rewriteLegacyRelayUrls(partialName, partialBody) {
  const rewrites = LEGACY_RELAY_URL_REWRITES.get(partialName);
  if (!rewrites) return partialBody;
  let rewrittenBody = partialBody;
  for (const { legacyUrl, ownUrl } of rewrites) {
    rewrittenBody = rewrittenBody.split(legacyUrl).join(ownUrl);
  }
  return rewrittenBody;
}

// Google Drive URLs built into the legacy pages and scripts: the academy logo,
// the default avatar, carousel images (thumbnail?id=<id>), the course-material
// viewer (file/d/<id>/view and /preview) and folder links. Every such file is
// imported into the local file store under its original Drive id
// (tools/import-drive-tree.js, tools/import-code-assets.js), so the URL
// prefixes are repointed at our own routes and the ids stay as they are:
//   https://drive.google.com/thumbnail?id=<id>&sz=w500  ->  /thumb?id=<id>&sz=w500
//   https://drive.google.com/file/d/<id>/view            ->  /files/<id>/view
//   https://drive.google.com/drive/folders/<id>          ->  /files/folder/<id>
// Prefix replacement is safe in both HTML attributes and JS string
// concatenations ('...thumbnail?id=' + logoId + '&sz=w1000').
const LEGACY_DRIVE_URL_PREFIXES = [
  ['https://drive.google.com/thumbnail?id=', '/thumb?id='],
  ['https://drive.google.com/file/d/', '/files/'],
  ['https://drive.google.com/drive/folders/', '/files/folder/'],
  // The admin's template screen links "edit in Google Docs" and embeds a Docs
  // preview iframe; templates are .docx in the local store, so /doc/<id>/edit
  // downloads the file and /doc/<id>/preview shows it converted to PDF.
  ['https://docs.google.com/document/d/', '/doc/'],
];

// Returns text with every legacy Drive URL prefix replaced. Safe to apply twice.
function rewriteLegacyDriveUrls(text) {
  let rewritten = text;
  for (const [legacyPrefix, ownPrefix] of LEGACY_DRIVE_URL_PREFIXES) {
    rewritten = rewritten.split(legacyPrefix).join(ownPrefix);
  }
  return rewritten;
}

// ---- Google Fonts ---------------------------------------------------------------------
//
// The pages name web fonts on Google Fonts. A stylesheet URL there (fonts.googleapis.com)
// answers with CSS that points at the font files on fonts.gstatic.com, so using it makes
// every visitor's browser contact Google and tell it which page is being read. Both the
// stylesheets and the files they name are served from this server instead:
//   server/client/fonts/<name>.css           the stylesheet exactly as Google answered a current
//                                            Chrome (woff2 files, one @font-face per unicode-range
//                                            subset), except that each src: url(...) names the local file
//   server/client/fonts/files/<name>.woff2   the font files, named <family>-<weight>-<subset>
// GET /fonts/* in server/index.js serves both. The fonts are open source (OFL/Apache).
//
// To add or refresh one: fetch its stylesheet URL with a current browser User-Agent (Google
// answers other agents with other formats and without the unicode-range subsets), download
// every woff2 the CSS names, save the CSS with the src URLs changed, and list the URL below.
// server/self-hosted-assets.test.js fails for a Google Fonts URL in any page that is not listed.
//
// Each URL is matched as a whole, query string included, because the query string chooses
// the families, weights and styles the local CSS has to contain. gas/ writes the same URL with
// a plain & inside scripts and with &amp; inside HTML attributes; both spellings are matched.
const GOOGLE_FONTS_STYLESHEET_REWRITES = [
  // gas/Main.html
  { googleUrl: 'https://fonts.googleapis.com/css2?family=Markazi+Text:wght@400..700&family=Readex+Pro:wght@160..700&display=swap', ownUrl: '/fonts/markazi-text-400-to-700--readex-pro-160-to-700.css' },
  { googleUrl: 'https://fonts.googleapis.com/css2?family=Lora&display=swap', ownUrl: '/fonts/lora-400.css' },
  // The older "css" API (not "css2"): weight 400 only, and no font-display.
  { googleUrl: 'https://fonts.googleapis.com/css?family=Tajawal', ownUrl: '/fonts/tajawal-400.css' },
  { googleUrl: 'https://fonts.googleapis.com/css2?family=Readex+Pro:wght@200;400;600;700&display=swap', ownUrl: '/fonts/readex-pro-200-400-600-700.css' },
  { googleUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Readex+Pro:wght@500;600;700&display=swap', ownUrl: '/fonts/ibm-plex-sans-arabic-400-500-600-700--readex-pro-500-600-700.css' },
  // gas/style-css.html (an @import)
  { googleUrl: 'https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,300..900;1,300..900&display=swap', ownUrl: '/fonts/rubik-300-to-900-with-italic.css' },
  // gas/registration.html and server/client/relay/google-signin.html
  { googleUrl: 'https://fonts.googleapis.com/css2?family=Tajawal:wght@300;400;500;700;800&display=swap', ownUrl: '/fonts/tajawal-300-400-500-700-800.css' },
  // server/client/relay/qr-scan.html
  { googleUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap', ownUrl: '/fonts/ibm-plex-sans-arabic-400-500-600-700.css' },
  // gas/export-js.html (the print windows of the report exports)
  { googleUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700&display=swap', ownUrl: '/fonts/ibm-plex-sans-arabic-400-600-700.css' },
  // gas/admin-js.html asks for 800 as well, but IBM Plex Sans Arabic has no 800: Google answered
  // with the 400, 600 and 700 faces only, so the same local file is the exact equivalent.
  { googleUrl: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;600;700;800&display=swap', ownUrl: '/fonts/ibm-plex-sans-arabic-400-600-700.css' },
];

// gas/Main.html also links the stylesheets of two icon fonts, Material Icons and Material
// Symbols Outlined. No page uses either (no element has a material-icons or
// material-symbols-* class and no CSS names the font families: the icons come from Bootstrap
// Icons and Font Awesome), so a browser never even downloads the font files. Copying them
// would add about 4 MB to the repository for nothing (the Symbols font alone is 4.0 MB, the
// Icons font 128 KB), so the two <link> elements are dropped when a page is served.
// server/self-hosted-assets.test.js fails if a page starts using either font, which is the
// moment to self-host it as the others are.
const UNUSED_ICON_FONT_STYLESHEET_URLS = [
  'https://fonts.googleapis.com/icon?family=Material+Icons',
  'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200',
];

const OWN_URL_BY_GOOGLE_FONTS_URL_SPELLING = new Map();
for (const { googleUrl, ownUrl } of GOOGLE_FONTS_STYLESHEET_REWRITES) {
  OWN_URL_BY_GOOGLE_FONTS_URL_SPELLING.set(googleUrl, ownUrl);
  OWN_URL_BY_GOOGLE_FONTS_URL_SPELLING.set(googleUrl.replace(/&/g, '&amp;'), ownUrl);
}

// A Google Fonts URL as it appears in text: up to the quote, bracket, space or backslash that
// ends it. Taking the whole token and then looking it up (instead of replacing known URLs
// wherever they occur) means a URL that merely starts like a known one, say with an extra
// &text=... parameter, is left alone instead of being cut in half.
const GOOGLE_FONTS_URL_TOKEN_RE = /https:\/\/fonts\.googleapis\.com\/[^\s"'<>()\\]*/g;

// A <link> element with the indentation before it and the line break after it, so that removing
// one that stands on its own line leaves no blank line behind. The indentation is bounded to keep
// the scan linear.
const LINK_ELEMENT_RE = /[ \t]{0,40}<link\b[^>]*>(?:\r?\n)?/gi;
const FONT_HOST_ORIGIN_RE = /^(?:https?:)?\/\/fonts\.(?:googleapis|gstatic)\.com\/?$/i;

function hrefOfLinkElement(linkElement) {
  const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(linkElement);
  if (!hrefMatch) return '';
  return (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3]).replace(/&amp;/g, '&');
}

// <link rel="preconnect" href="https://fonts.googleapis.com"> (and the same for fonts.gstatic.com)
// tells the browser to open a connection to Google before any stylesheet asks for it. With the
// stylesheets local the hint would only reveal the visit for nothing, so it goes too.
function isFontHostConnectionHint(linkElement) {
  return /\brel\s*=\s*["']?(?:preconnect|dns-prefetch)\b/i.test(linkElement)
    && FONT_HOST_ORIGIN_RE.test(hrefOfLinkElement(linkElement));
}

function isUnusedIconFontStylesheet(linkElement) {
  return UNUSED_ICON_FONT_STYLESHEET_URLS.includes(hrefOfLinkElement(linkElement));
}

// Returns text with every Google Fonts stylesheet URL pointing at the local copy of that
// stylesheet, the connection hints to Google's font hosts removed, and the <link> elements of
// the unused icon fonts removed. A Google Fonts URL that is not in the table is left as it is
// (and the self-hosted-assets test then reports it). Safe to apply twice.
function rewriteGoogleFontsUrls(text) {
  const withoutLinksNotNeededLocally = text.replace(LINK_ELEMENT_RE, (linkElement) => (
    isFontHostConnectionHint(linkElement) || isUnusedIconFontStylesheet(linkElement) ? '' : linkElement
  ));
  return withoutLinksNotNeededLocally.replace(
    GOOGLE_FONTS_URL_TOKEN_RE,
    (urlToken) => OWN_URL_BY_GOOGLE_FONTS_URL_SPELLING.get(urlToken) || urlToken
  );
}

// ---- Files from the old Firebase-hosted site ---------------------------------------------
//
// Some pages load a script, a font and a logo from the old public website, which is a separate
// site and is going away: https://coming-soon-basaer.web.app/assets/... (its Firebase Hosting
// address) and https://basaerbh.com/assets/... (the same files under the production domain).
//   js/basaer-tree.js                       gas/Main.html: draws the Arabic mind-map images (BasaerTree)
//   fonts/IBMPlexSansArabic-Regular.woff2   gas/admin-js.html: handed to BasaerTree, which embeds it in the image
//   images/logo-mark-white.png              gas/registration.html: the watermark of the registration form
// These three files were copied byte for byte from that site's assets folder into
// server/client/site-assets/, below the same sub-folders, and GET /site-assets/* in
// server/index.js serves them. Only files that pages reference were copied: the rest of that
// folder is marketing material for the public site. (Serving the font from our own origin also
// means BasaerTree's fetch() of it no longer needs the old site's CORS headers.)
const OLD_SITE_ASSET_URL_PREFIXES = [
  ['https://coming-soon-basaer.web.app/assets/', '/site-assets/'],
  ['https://basaerbh.com/assets/', '/site-assets/'],
];

// Returns text with the old site's asset URL prefixes replaced by /site-assets/. Safe to
// apply twice.
function rewriteOldSiteAssetUrls(text) {
  let rewritten = text;
  for (const [oldSitePrefix, ownPrefix] of OLD_SITE_ASSET_URL_PREFIXES) {
    rewritten = rewritten.split(oldSitePrefix).join(ownPrefix);
  }
  return rewritten;
}

// ---- Combined rewriters ---------------------------------------------------------------

// Everything that applies to any text the browser receives, whichever page or script it is:
// Drive URLs, Google Fonts, and the old site's assets. Used for the shell page (gas/Main.html)
// and the relay pages, and inside rewriteLegacyPartial for every partial.
function rewriteLegacyShell(html) {
  return rewriteOldSiteAssetUrls(rewriteGoogleFontsUrls(rewriteLegacyDriveUrls(html)));
}

// Everything a served partial needs: relay URLs (per partial) plus the rewrites common to all text.
function rewriteLegacyPartial(partialName, partialBody) {
  return rewriteLegacyShell(rewriteLegacyRelayUrls(partialName, partialBody));
}

module.exports = {
  rewriteLegacyRelayUrls, rewriteLegacyDriveUrls, rewriteGoogleFontsUrls, rewriteOldSiteAssetUrls,
  rewriteLegacyShell, rewriteLegacyPartial,
  LEGACY_RELAY_URL_REWRITES, LEGACY_DRIVE_URL_PREFIXES,
  GOOGLE_FONTS_STYLESHEET_REWRITES, UNUSED_ICON_FONT_STYLESHEET_URLS, OLD_SITE_ASSET_URL_PREFIXES,
};
