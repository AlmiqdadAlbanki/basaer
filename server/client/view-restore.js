/*
 * Keep the user's place across a page refresh.
 *
 * The app is a single page with no URL routing: navigation only mutates
 * in-memory state, so any refresh restarts at the home view (the live Apps
 * Script site behaves the same). This script adds that missing piece without
 * touching the app's code.
 *
 * It only ever records clicks on the app's pure-navigation elements, which all
 * carry one of four stable markers:
 *   [data-page]                             staff / admin sidebar pages
 *   [data-bs-toggle="tab"][data-bs-target]  student-portal Bootstrap tabs
 *   [data-tab], [data-emp-tab]              sub-tabs inside a page
 * Nothing else is recorded, so a refresh can never replay a save, send, delete
 * or logout. The current view is written to the URL and replayed once, after
 * the role's main view has rendered, by clicking the same elements again in
 * order.
 *
 * The two top levels live in the path and the lower levels in the hash, so the
 * address bar (and a bookmark) reads like a real location, e.g.
 *   /app/p/students#v=data-emp-tab:security
 *   data-page "X"              -> /app/p/X
 *   data-bs-target "#Y"        -> /app/p/Y   (the "#" is dropped; replay adds it back)
 *   data-tab, data-emp-tab     -> #v=data-tab:...|data-emp-tab:...
 *   nothing recorded           -> /app       (no hash)
 * The server serves the same page for "/app" and any "/app/p/*" path, so a refresh
 * or a pasted link lands on the app instead of a 404 ("/" is the public website, and
 * the app's old "/p/*" paths redirect to "/app/p/*"). Only the first segment
 * after /app/p/ is meaningful and any other path is ignored. A path alone cannot
 * say whether X is a data-page or a Bootstrap tab id, so replay tries
 * [data-page="X"] first and then the tab with data-bs-target="#X".
 * The URL is updated with history.replaceState (never pushState) so the back
 * button does not walk through tabs, and location.search is left untouched
 * (the app appends ?logout=1 on logout and reads it at startup). Old-style
 * bookmarks that carry data-page: / data-bs-target: inside the hash are still
 * honoured on read.
 */
(function () {
  'use strict';

  // Precedence: clicking a higher level clears everything below it.
  var LEVELS = ['data-page', 'data-bs-target', 'data-tab', 'data-emp-tab'];
  var MAIN_VIEWS = { loadPageStudent: 1, loadPageEmp: 1, loadPageAdminDashboard: 1 };
  // Where the server serves the app; it is also the address when nothing is recorded,
  // because "/" is the public website, not the app.
  var APP_PATH = '/app';
  var PATH_PREFIX = APP_PATH + '/p/';
  var state = {};        // level -> value
  var restored = false;  // replay happens at most once per page load

  function decode(s) {
    try { return decodeURIComponent(s); } catch (e) { return ''; }
  }

  function readHash() {
    var m = /(?:^|[#&])v=([^&]*)/.exec(location.hash || '');
    var out = {};
    if (!m) return out;
    decode(m[1]).split('|').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return out;
  }

  // First segment after /app/p/, decoded ('' for "/app" and for any unknown path).
  function readPath() {
    var m = /^\/app\/p\/([^\/]+)/.exec(location.pathname || '');
    return m ? decode(m[1]) : '';
  }

  // Path (page or tab id) merged with the hash levels. The path value is kept
  // under "path" because it is not yet known whether it is a data-page or a tab.
  function readState() {
    var out = readHash();
    var top = readPath();
    if (top) {
      delete out['data-page']; // the path is the page; ignore a stale old-style entry
      out.path = top;
    }
    return out;
  }

  function writeUrl() {
    // Top level goes into the path: the page, else the Bootstrap tab id.
    // A tab id that cannot be a path ('#' missing or nothing after it) stays in the hash.
    var topLevel = null;
    var topValue = '';
    if (state['data-page']) {
      topLevel = 'data-page';
      topValue = state['data-page'];
    } else if (/^#./.test(state['data-bs-target'] || '')) {
      topLevel = 'data-bs-target';
      topValue = state['data-bs-target'].slice(1);
    }
    // Everything else goes into the hash. A tab inside a page (both data-page
    // and data-bs-target set) cannot share the path, so it uses the old-style entry.
    var parts = [];
    LEVELS.forEach(function (k) { if (state[k] && k !== topLevel) parts.push(k + ':' + state[k]); });
    var path = topLevel ? PATH_PREFIX + encodeURIComponent(topValue) : APP_PATH;
    var hash = parts.length ? '#v=' + encodeURIComponent(parts.join('|')) : '';
    try { history.replaceState(null, '', path + location.search + hash); } catch (e) { /* ignore */ }
  }

  function markerOf(el) {
    for (var i = 0; i < LEVELS.length; i++) {
      var k = LEVELS[i];
      if (!el.hasAttribute(k)) continue;
      if (k === 'data-bs-target' && el.getAttribute('data-bs-toggle') !== 'tab') continue;
      return { level: k, value: el.getAttribute(k) };
    }
    return null;
  }

  // Record navigation clicks (capture phase: runs even if the app stops propagation).
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-page],[data-bs-target],[data-tab],[data-emp-tab]') : null;
    if (!el) return;
    var mk = markerOf(el);
    if (!mk) return;
    var idx = LEVELS.indexOf(mk.level);
    for (var i = idx + 1; i < LEVELS.length; i++) delete state[LEVELS[i]];
    state[mk.level] = mk.value;
    writeUrl();
  }, true);

  // Resolves with the first match, trying the selectors in the order given
  // (a plain string is a single selector).
  function waitFor(selectors, timeoutMs) {
    if (typeof selectors === 'string') selectors = [selectors];
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i]);
          if (el) return resolve(el);
        }
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(poll, 100);
      })();
    });
  }

  function cssEscape(v) {
    return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  }

  function selectorFor(level, value) {
    var sel = '[' + level + '="' + cssEscape(value) + '"]';
    if (level === 'data-bs-target') sel = '[data-bs-toggle="tab"]' + sel;
    return sel;
  }

  // Replay the stored view by clicking each recorded element in order.
  // The steps are built up front: every click re-records into `state` and
  // clears the levels below it, so replay must not read from the live state.
  async function replay(saved) {
    var steps = []; // each step: candidate selectors, tried in order
    if (saved.path) {
      steps.push([selectorFor('data-page', saved.path), selectorFor('data-bs-target', '#' + saved.path)]);
    }
    LEVELS.forEach(function (k) {
      if (saved[k]) steps.push([selectorFor(k, saved[k])]);
    });
    for (var i = 0; i < steps.length; i++) {
      var el = await waitFor(steps[i], 8000);
      if (!el) return; // view no longer exists (different role, removed page): stop quietly
      el.click();
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }

  function onMainViewReady() {
    if (restored) return;
    restored = true;
    var saved = readState();
    if (!Object.keys(saved).length) return;
    // Give the view's own setup callback a moment to finish painting first.
    setTimeout(function () { replay(saved); }, 300);
  }

  // Hook the app's page loader so we know when a role's main view has rendered.
  // Registered on DOMContentLoaded (this script is in <head>, so it registers —
  // and therefore runs — before the app's own DOMContentLoaded bootstrap).
  document.addEventListener('DOMContentLoaded', function () {
    var original = window.loadPage;
    if (typeof original !== 'function') return;
    window.loadPage = function (options) {
      if (options && MAIN_VIEWS[options.func]) {
        var cb = options.callback;
        options = Object.assign({}, options, {
          callback: function () {
            var r = typeof cb === 'function' ? cb.apply(this, arguments) : undefined;
            onMainViewReady();
            return r;
          },
        });
      }
      return original.call(this, options);
    };
  });

  // Expose a tiny hook so the auth shim can clear the stored view on logout.
  window.__basaerViewRestore = {
    clear: function () { state = {}; writeUrl(); },
  };
})();
