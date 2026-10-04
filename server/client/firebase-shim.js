/*
 * Minimal stand-in for the Firebase compat SDK, backed by our own server.
 *
 * We dropped the Firebase dependency (see the plan's auth decision). The gas
 * client still calls firebase.auth() in a handful of places; this shim covers
 * exactly that surface so none of the HTML has to change:
 *
 *   firebase.initializeApp(cfg)                     -> no-op
 *   firebase.auth()                                 -> our auth instance
 *   firebase.auth.Auth.Persistence.{LOCAL,NONE}     -> constants
 *   auth.setPersistence(type)                       -> remembers where to store
 *   auth.onAuthStateChanged(cb)                      -> fires with the current user
 *   auth.signInWithCustomToken(token)                -> exchanges it at our server
 *   auth.currentUser.getIdToken()                    -> our session token
 *   auth.signOut()                                   -> clears the session
 *
 * The token the server returns from a login (verifyLoginCode etc.) is a
 * Firebase-style custom token minted with our local service-account key; we
 * trade it at POST /api/auth/exchange for a session token we then hold.
 * firestore/functions/storage are inert stubs (the admin AI feature is out of
 * PoC scope and will return when production points at the real project).
 */
(function () {
  'use strict';

  var LS_KEY = 'basaer_session';
  var persistence = 'local'; // 'local' | 'none'

  function store(token) {
    try {
      if (persistence === 'none') { sessionStorage.setItem(LS_KEY, token); localStorage.removeItem(LS_KEY); }
      else { localStorage.setItem(LS_KEY, token); sessionStorage.removeItem(LS_KEY); }
    } catch (e) { /* storage blocked; stay in-memory */ }
  }
  function loadStored() {
    try { return localStorage.getItem(LS_KEY) || sessionStorage.getItem(LS_KEY) || null; } catch (e) { return null; }
  }
  function clearStored() {
    try { localStorage.removeItem(LS_KEY); sessionStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
  }

  function decodeJwt(token) {
    try {
      var p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return null; }
  }
  function userFromToken(token) {
    if (!token) return null;
    var payload = decodeJwt(token);
    if (!payload || !payload.cpr) return null;
    if (payload.exp && Date.now() / 1000 >= payload.exp) return null;
    var uid = payload.sub || ('u' + payload.cpr);
    return {
      uid: uid,
      _token: token,
      getIdToken: function () { return Promise.resolve(token); },
      getIdTokenResult: function () { return Promise.resolve({ token: token, claims: payload }); },
    };
  }

  function AuthInstance() {
    this._user = userFromToken(loadStored());
    this._listeners = [];
  }
  AuthInstance.prototype.setPersistence = function (type) {
    persistence = (type === 'none' || type === 'NONE') ? 'none' : 'local';
    return Promise.resolve();
  };
  AuthInstance.prototype.onAuthStateChanged = function (cb) {
    this._listeners.push(cb);
    var u = this._user;
    Promise.resolve().then(function () { try { cb(u); } catch (e) { console.error(e); } });
    var self = this;
    return function () { self._listeners = self._listeners.filter(function (f) { return f !== cb; }); };
  };
  AuthInstance.prototype._emit = function () {
    var u = this._user;
    this._listeners.forEach(function (cb) { try { cb(u); } catch (e) { console.error(e); } });
  };
  AuthInstance.prototype.signInWithCustomToken = function (customToken) {
    var self = this;
    return fetch('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customToken: customToken }),
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body.ok) throw new Error(body.error || ('exchange failed: ' + res.status));
        store(body.sessionToken);
        self._user = userFromToken(body.sessionToken);
        self._emit();
        return { user: self._user };
      });
    });
  };
  AuthInstance.prototype.signOut = function () {
    clearStored();
    // Forget the remembered view so the next user doesn't land in it.
    try { if (window.__basaerViewRestore) window.__basaerViewRestore.clear(); } catch (e) { /* ignore */ }
    this._user = null;
    this._emit();
    return Promise.resolve();
  };
  Object.defineProperty(AuthInstance.prototype, 'currentUser', {
    get: function () { return this._user; },
  });

  var authSingleton = null;
  function auth() {
    if (!authSingleton) authSingleton = new AuthInstance();
    return authSingleton;
  }
  auth.Auth = { Persistence: { LOCAL: 'local', NONE: 'none', SESSION: 'none' } };

  function inertStub(name) {
    var warn = function () { console.warn('[firebase-shim] ' + name + ' is not available in the self-hosted PoC'); };
    return new Proxy(function () { warn(); return inertStub(name); }, {
      get: function (_t, p) {
        if (p === 'then') return undefined;
        return function () { warn(); return inertStub(name); };
      },
      apply: function () { warn(); return inertStub(name); },
    });
  }

  window.firebase = {
    initializeApp: function () { return {}; },
    app: function () { return {}; },
    auth: auth,
    firestore: function () { return inertStub('firestore'); },
    functions: function () { return inertStub('functions'); },
    storage: function () { return inertStub('storage'); },
  };
  // firestore sometimes referenced as firebase.firestore.FieldValue etc.
  window.firebase.firestore.FieldValue = { serverTimestamp: function () { return null; } };
})();
