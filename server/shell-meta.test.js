'use strict';

// The served shell carries the title and favicon doGet sets in gas/code.js
// (setTitle / setFaviconUrl); Apps Script put them on its wrapper page, which
// no longer exists.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { legacyShellMeta } = require('./page-rewrites.js');

test('legacyShellMeta reads the title and the logo favicon from gas/code.js', () => {
  const codeSource = fs.readFileSync(path.join(__dirname, '..', 'gas', 'code.js'), 'utf8');
  const meta = legacyShellMeta(codeSource);
  assert.strictEqual(meta.title, 'بصائر للعلوم الشرعية');
  assert.ok(meta.faviconUrl.startsWith('/thumb?id=1iOIJNIzjaUi55iSEtqGzubUp7ZhDkdbX'), meta.faviconUrl);
  assert.ok(!meta.faviconUrl.includes('google.com'));
});

test('legacyShellMeta falls back when the code no longer sets them', () => {
  const meta = legacyShellMeta('function doGet() { return HtmlService.createHtmlOutput("x"); }');
  assert.strictEqual(meta.title, 'بصائر');
  assert.strictEqual(meta.faviconUrl, '/site-assets/favicon-96.png');
});
