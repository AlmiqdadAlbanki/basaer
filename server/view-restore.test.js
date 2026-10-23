'use strict';

// client/view-restore.js, run against a small fake DOM: which clicks it records as the
// user's place (the newer sidebars' data-route buttons, not the <section data-page>
// page containers), what it writes to the address, what it tells the /platform page
// above, and that a saved page is replayed by clicking the matching button.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'client', 'view-restore.js'), 'utf8');

// Enough of the DOM for the script: elements with attributes, parents, click(), and
// selector matching for the shapes the script uses: `tag[attr="v"]`, `[attr]`, `a,b`.
function makeElement(tag, attrs = {}, parent = null) {
  const el = {
    tagName: tag.toUpperCase(), attrs, parent, clicks: 0,
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    matches(selector) {
      return selector.split(',').some((single) => {
        const tagMatch = /^([a-z]+)?/.exec(single.trim());
        if (tagMatch[1] && tagMatch[1].toUpperCase() !== el.tagName) return false;
        const attrRe = /\[([\w-]+)(?:="([^"]*)")?\]/g;
        let m;
        while ((m = attrRe.exec(single))) {
          if (!el.hasAttribute(m[1])) return false;
          if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
        }
        return true;
      });
    },
    closest(selector) { for (let node = el; node; node = node.parent) if (node.matches(selector)) return node; return null; },
    click() { el.clicks++; },
  };
  return el;
}

function boot({ pathname = '/app', framed = true } = {}) {
  const elements = [];
  const listeners = {};
  const document = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    querySelector: (selector) => elements.find((el) => el.matches(selector)) || null,
  };
  const written = [];
  const messages = [];
  const sandbox = {
    document,
    location: { pathname, search: '', hash: '', origin: 'http://localhost:3000' },
    history: { replaceState: (_s, _t, url) => written.push(url) },
    setTimeout, clearTimeout, Date, Promise, Object, encodeURIComponent, decodeURIComponent, String, RegExp, Array,
  };
  sandbox.window = sandbox;
  sandbox.parent = framed ? { postMessage: (data, origin) => messages.push({ data, origin }) } : sandbox;
  vm.runInNewContext(SCRIPT, sandbox);
  const click = (el) => listeners.click.forEach((fn) => fn({ target: el }));
  const domReady = () => (listeners.DOMContentLoaded || []).forEach((fn) => fn());
  return { sandbox, elements, written, messages, click, domReady };
}

test('a data-route sidebar button becomes /app/p/<route> and is reported to the page above', () => {
  const { elements, written, messages, click } = boot();
  const dashboard = makeElement('section', { 'data-page': 'dashboard' });
  const attendanceButton = makeElement('button', { 'data-route': 'attendance' }, dashboard);
  elements.push(dashboard, attendanceButton);
  click(attendanceButton);
  assert.deepStrictEqual(written, ['/app/p/attendance']);
  // The message object is created inside the vm context (another Object prototype), so
  // compare its JSON, not its identity.
  assert.strictEqual(JSON.stringify(messages), JSON.stringify([{ data: { type: 'basaer:view-path', path: '/app/p/attendance' }, origin: 'http://localhost:3000' }]));
});

test('a click inside a <section data-page> container is not a navigation', () => {
  const { elements, written, click } = boot();
  const students = makeElement('section', { 'data-page': 'students' });
  const someText = makeElement('span', {}, students);
  elements.push(students, someText);
  click(someText);
  assert.deepStrictEqual(written, [], 'nothing written');
});

test('an older a[data-page] link is still a page, and a sub-tab goes into the hash below it', () => {
  const { elements, written, click } = boot();
  const pageLink = makeElement('a', { 'data-page': 'reports' });
  const subTab = makeElement('button', { 'data-tab': 'monthly' });
  elements.push(pageLink, subTab);
  click(pageLink);
  click(subTab);
  assert.deepStrictEqual(written, ['/app/p/reports', '/app/p/reports#v=' + encodeURIComponent('data-tab:monthly')]);
  // Another page clears the sub-tab.
  const otherRoute = makeElement('button', { 'data-route': 'exams' });
  elements.push(otherRoute);
  click(otherRoute);
  assert.strictEqual(written[written.length - 1], '/app/p/exams');
});

test('a saved /app/p/<route> is replayed by clicking the data-route button once the main view is ready', async () => {
  const { sandbox, elements, domReady } = boot({ pathname: '/app/p/attendance' });
  const dashboard = makeElement('section', { 'data-page': 'attendance' }); // the container: must not be "clicked"
  const attendanceButton = makeElement('button', { 'data-route': 'attendance' });
  elements.push(dashboard, attendanceButton);
  let appCallbackRuns = 0;
  sandbox.loadPage = (options) => { options.callback(); }; // the app's loader, called by the app
  domReady(); // view-restore wraps window.loadPage here
  sandbox.loadPage({ func: 'loadPageAdminDashboard', callback: () => { appCallbackRuns++; } });
  assert.strictEqual(appCallbackRuns, 1, 'the app\'s own callback still runs');
  await new Promise((resolve) => setTimeout(resolve, 900)); // replay waits 300 ms, polls every 100 ms, pauses 250 ms per step
  assert.strictEqual(attendanceButton.clicks, 1, 'the sidebar button was clicked');
  assert.strictEqual(dashboard.clicks, 0);
});

test('outside the /platform frame nothing is posted', () => {
  const { elements, written, messages, click } = boot({ framed: false });
  const button = makeElement('button', { 'data-route': 'staff' });
  elements.push(button);
  click(button);
  assert.deepStrictEqual(written, ['/app/p/staff']);
  assert.deepStrictEqual(messages, []);
});
