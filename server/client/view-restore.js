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
 * or logout. The current view is written to the URL hash (bookmarkable), e.g.
 *   #v=data-page:emp-profile|data-emp-tab:security
 * and replayed once, after the role's main view has rendered, by clicking the
 * same elements again in order.
 */
(function () {
  'use strict';

  // Precedence: clicking a higher level clears everything below it.
  var LEVELS = ['data-page', 'data-bs-target', 'data-tab', 'data-emp-tab'];
  var MAIN_VIEWS = { loadPageStudent: 1, loadPageEmp: 1, loadPageAdminDashboard: 1 };
  var state = {};        // level -> value
  var restored = false;  // replay happens at most once per page load

  function readHash() {
    var m = /(?:^|[#&])v=([^&]*)/.exec(location.hash || '');
    var out = {};
    if (!m) return out;
    decodeURIComponent(m[1]).split('|').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
    });
    return out;
  }

  function writeHash() {
    var parts = [];
    LEVELS.forEach(function (k) { if (state[k]) parts.push(k + ':' + state[k]); });
    var hash = parts.length ? '#v=' + encodeURIComponent(parts.join('|')) : '';
    try { history.replaceState(null, '', location.pathname + location.search + hash); } catch (e) { /* ignore */ }
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
    writeHash();
  }, true);

  function waitFor(selector, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(poll, 100);
      })();
    });
  }

  function cssEscape(v) {
    return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  }

  // Replay the stored view by clicking each recorded element in order.
  async function replay(saved) {
    for (var i = 0; i < LEVELS.length; i++) {
      var k = LEVELS[i];
      if (!saved[k]) continue;
      var sel = '[' + k + '="' + cssEscape(saved[k]) + '"]';
      if (k === 'data-bs-target') sel = '[data-bs-toggle="tab"]' + sel;
      var el = await waitFor(sel, 8000);
      if (!el) return; // view no longer exists (different role, removed page): stop quietly
      el.click();
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }

  function onMainViewReady() {
    if (restored) return;
    restored = true;
    var saved = readHash();
    if (!Object.keys(saved).length) return;
    state = saved;
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
    clear: function () { state = {}; writeHash(); },
  };
})();
