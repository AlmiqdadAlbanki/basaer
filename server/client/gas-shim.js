/*
 * Drop-in replacement for google.script.run.
 *
 * The Basaer client calls the server through google.script.run in ~230 places,
 * in these shapes:
 *     google.script.run.withSuccessHandler(fn).withFailureHandler(fn).serverFn(args)
 *     google.script.run.serverFn(args)                       // fire and forget
 *     var r = google.script.run.withSuccessHandler(fn); r[name](args)   // bracket name
 *
 * This shim reproduces all of them without touching a single call site: each
 * terminal method call turns into POST /api/rpc/<name> with the arguments as
 * JSON, and resolves the success or failure handler with the reply. If the
 * Firebase SDK is present and a user is signed in, the current ID token rides
 * along in the Authorization header so the server can identify the caller
 * (enforced from phase 3 onward).
 */
(function () {
  'use strict';

  var RESERVED = {
    withSuccessHandler: true,
    withFailureHandler: true,
    withUserObject: true,
  };

  function getIdToken() {
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.getIdToken();
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(null);
  }

  function invoke(name, args, onSuccess, onFailure, userObject) {
    getIdToken().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      return fetch('/api/rpc/' + encodeURIComponent(name), {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ args: Array.prototype.slice.call(args) }),
      });
    }).then(function (res) {
      return res.json().then(function (body) { return { res: res, body: body }; });
    }).then(function (p) {
      if (p.res.ok && p.body && p.body.ok) {
        if (onSuccess) onSuccess(p.body.result, userObject);
      } else {
        var msg = (p.body && p.body.error) || ('HTTP ' + p.res.status);
        var err = new Error(msg);
        if (onFailure) onFailure(err, userObject); else console.error('google.script.run ' + name + ':', msg);
      }
    }).catch(function (err) {
      if (onFailure) onFailure(err, userObject); else console.error('google.script.run ' + name + ':', err);
    });
  }

  function makeRunner(state) {
    var target = function () {};
    return new Proxy(target, {
      get: function (_t, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) { return makeRunner(Object.assign({}, state, { onSuccess: fn })); };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) { return makeRunner(Object.assign({}, state, { onFailure: fn })); };
        }
        if (prop === 'withUserObject') {
          return function (obj) { return makeRunner(Object.assign({}, state, { userObject: obj })); };
        }
        if (typeof prop !== 'string') return undefined;
        // Any other property is treated as a server function name.
        return function () {
          invoke(prop, arguments, state.onSuccess, state.onFailure, state.userObject);
        };
      },
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner({});

  // These are not used by the Basaer client (verified), but stub them so any
  // stray reference does not throw.
  window.google.script.host = window.google.script.host || {
    close: function () {},
    setHeight: function () {},
    setWidth: function () {},
    editor: { focus: function () {} },
    origin: '',
  };
  window.google.script.url = window.google.script.url || {
    getLocation: function (cb) { cb({ parameter: {}, parameters: {}, hash: '' }); },
  };
  window.google.script.history = window.google.script.history || {
    push: function () {}, replace: function () {}, setChangeHandler: function () {},
  };
})();
