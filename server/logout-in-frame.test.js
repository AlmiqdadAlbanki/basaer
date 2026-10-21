'use strict';

// Logging out from inside the /platform frame must bring the top window back to
// /platform (the page with the website's header bar), not to the bare /app page,
// and the ?logout=1 jump itself must stay as the gas code wrote it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { rewriteLegacyPartial, rewriteLogoutRedirect } = require('./page-rewrites.js');

test('the served auth-js partial sends a framed logout to /platform and a direct one to /app', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gas', 'auth-js.html'), 'utf8');
  assert.ok(source.includes("const baseUrl = window.location.href.split('?')[0];"),
    'gas/auth-js.html performLogout changed shape: update rewriteLogoutRedirect in page-rewrites.js');
  const served = rewriteLegacyPartial('auth-js', source);
  assert.ok(!served.includes("window.location.href.split('?')[0]"), 'the app-URL jump is gone');
  assert.ok(served.includes("const baseUrl = window.top === window ? '/app' : '/platform';"));
  assert.ok(served.includes("window.top.location = baseUrl + '?logout=1&t=' + Date.now();"), 'the ?logout=1 jump is untouched');
});

test('text without the logout line is returned unchanged', () => {
  assert.strictEqual(rewriteLogoutRedirect('var unrelated = 1;'), 'var unrelated = 1;');
});
