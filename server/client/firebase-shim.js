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
 *   auth.setPersistence(type)                       -> remembers where to store the hint
 *   auth.onAuthStateChanged(cb)                      -> fires with the current user
 *   auth.signInWithCustomToken(token)                -> exchanges it at our server
 *   auth.currentUser.getIdToken(forceRefresh)        -> a short-lived access token
 *   auth.signOut()                                   -> ends the server session
 *
 * Session model (httpOnly cookie + short-lived in-memory access token):
 *
 *   - The session itself is an httpOnly cookie set by the server. Script can
 *     neither read nor steal it, so there is no long-lived credential in
 *     localStorage/sessionStorage any more.
 *   - The access token is a short-lived JWT handed out by the server. It lives
 *     only in a closure variable below (never in storage) and is replaced
 *     whenever it is missing or expires within 60 seconds, or when the caller
 *     asks for it with getIdToken(true). Refreshing is a POST to
 *     /api/auth/session; the browser sends the cookie and the server renews it.
 *     Concurrent refreshes share one request.
 *   - Storage holds only a non-secret hint, basaer_user = {"uid","cpr"}, in
 *     localStorage (persistence 'local') or sessionStorage (persistence
 *     'none'). It exists so auth.currentUser is non-null synchronously at page
 *     start when the user was signed in. On startup the hint's user is created
 *     immediately and the session is confirmed in the background: onAuthState-
 *     Changed listeners registered before that settles are called once with the
 *     user (cookie still good) or with null (no session; the hint is cleared).
 *   - A 401 from /api/auth/session at any time means the session is gone: we
 *     sign out locally (clear hint and access token, user = null, notify
 *     listeners) and the pending getIdToken() rejects with 'session expired'.
 *
 * The token the server returns from a login (verifyLoginCode etc.) is a
 * Firebase-style custom token minted with our local service-account key; we
 * trade it at POST /api/auth/exchange for the session cookie and a first access
 * token. POST /api/auth/logout clears the cookie.
 * firestore/functions/storage are inert stubs (the admin AI feature is out of
 * PoC scope and will return when production points at the real project).
 */
(function () {
  'use strict';

  var HINT_KEY = 'basaer_user';
  var LEGACY_SESSION_KEY = 'basaer_session'; // old long-lived token; only ever deleted now
  var ACCESS_TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
  var persistence = 'local'; // 'local' | 'none'

  // The short-lived access token and when it expires (epoch ms). Memory only.
  var accessToken = null;
  var accessTokenExpiresAt = 0;
  // The one shared /api/auth/session request, while it is running.
  var refreshInFlight = null;
  // Bumped on every sign-in/sign-out so a response to a request that began
  // under an earlier session can be recognised and discarded.
  var sessionEpoch = 0;

  function storeHint(identity) {
    var json = JSON.stringify({ uid: identity.uid, cpr: identity.cpr });
    try {
      if (persistence === 'none') { sessionStorage.setItem(HINT_KEY, json); localStorage.removeItem(HINT_KEY); }
      else { localStorage.setItem(HINT_KEY, json); sessionStorage.removeItem(HINT_KEY); }
    } catch (e) { /* storage blocked; the user just won't survive a reload */ }
  }
  function readHintFrom(storage) {
    try {
      var raw = storage.getItem(HINT_KEY);
      if (!raw) return null;
      var hint = JSON.parse(raw);
      if (!hint || typeof hint.uid !== 'string' || !hint.uid) return null;
      return { uid: hint.uid, cpr: hint.cpr };
    } catch (e) { return null; }
  }
  function loadHint() {
    var hint = null;
    try { hint = readHintFrom(localStorage); } catch (e) { /* ignore */ }
    if (hint) return hint;
    try { return readHintFrom(sessionStorage); } catch (e) { return null; }
  }
  function clearHint() {
    try { localStorage.removeItem(HINT_KEY); sessionStorage.removeItem(HINT_KEY); } catch (e) { /* ignore */ }
  }
  // Sessions from before the cookie model left a long-lived JWT in storage;
  // never read it, just make sure it is gone.
  function clearLegacySessionToken() {
    try { localStorage.removeItem(LEGACY_SESSION_KEY); sessionStorage.removeItem(LEGACY_SESSION_KEY); } catch (e) { /* ignore */ }
  }

  function clearRpcCache() {
    try { if (window.__basaerRpcCache) window.__basaerRpcCache.clear(); } catch (e) { /* ignore */ }
  }

  function decodeJwt(token) {
    try {
      var p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return null; }
  }

  function rememberAccessToken(body) {
    accessToken = body.accessToken;
    var expiresAt = body.accessTokenExpiresAt;
    if (typeof expiresAt !== 'number' || !isFinite(expiresAt)) {
      var payload = decodeJwt(accessToken);
      expiresAt = (payload && payload.exp) ? payload.exp * 1000 : 0;
    }
    accessTokenExpiresAt = expiresAt;
  }
  function forgetAccessToken() {
    accessToken = null;
    accessTokenExpiresAt = 0;
  }
  function hasFreshAccessToken() {
    return !!accessToken && (accessTokenExpiresAt - Date.now()) > ACCESS_TOKEN_REFRESH_MARGIN_MS;
  }

  // POST to one of our /api/auth endpoints. Resolves { ok, status, body } for
  // any HTTP answer (body is {} if it wasn't JSON); rejects only on a network
  // failure. The cookie rides along automatically via same-origin credentials.
  function postAuth(path, payload, keepAlive) {
    var init = {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'basaer' },
    };
    if (payload !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }
    if (keepAlive) init.keepalive = true;
    return fetch(path, init).then(function (res) {
      return res.json().then(
        function (body) { return { ok: res.ok, status: res.status, body: body || {} }; },
        function () { return { ok: res.ok, status: res.status, body: {} }; }
      );
    });
  }

  function AuthInstance() {
    var self = this;
    this._user = null;
    this._listeners = [];
    // False only while the startup session check is outstanding.
    this._settled = false;
    clearLegacySessionToken();

    var hint = loadHint();
    if (!hint) {
      this._settled = true;
      return;
    }
    // Signed in as far as the page can tell; confirm with the server now.
    this._user = this._makeUser(hint);
    this._refreshSession().then(
      function () {
        if (self._settled) return; // a sign-in/out already decided it
        self._settled = true;
        self._emit();
      },
      function () {
        // 401 has already signed out locally; this covers network/server errors.
        if (!self._settled) self._signOutLocally();
      }
    );
  }
  AuthInstance.prototype._makeUser = function (identity) {
    var self = this;
    return {
      uid: identity.uid,
      cpr: identity.cpr,
      getIdToken: function (forceRefresh) { return self._getAccessToken(!!forceRefresh); },
      getIdTokenResult: function (forceRefresh) {
        return self._getAccessToken(!!forceRefresh).then(function (token) {
          return { token: token, claims: decodeJwt(token) || {} };
        });
      },
    };
  };
  AuthInstance.prototype._getAccessToken = function (forceRefresh) {
    if (!forceRefresh && hasFreshAccessToken()) return Promise.resolve(accessToken);
    return this._refreshSession();
  };
  // Ask the server for a fresh access token using the session cookie. Returns
  // the shared in-flight promise (resolving to the token) if one is running.
  AuthInstance.prototype._refreshSession = function () {
    var self = this;
    if (refreshInFlight) return refreshInFlight;
    var epochAtStart = sessionEpoch;
    var request = postAuth('/api/auth/session').then(function (result) {
      if (epochAtStart !== sessionEpoch) {
        // Someone signed in or out while this was in flight; don't let the
        // old answer overwrite the newer state. Use whatever the new state has.
        if (hasFreshAccessToken()) return accessToken;
        throw new Error('session expired');
      }
      if (result.status === 401) {
        self._signOutLocally();
        throw new Error('session expired');
      }
      var body = result.body;
      if (!result.ok || !body.ok || !body.accessToken) {
        throw new Error('session refresh failed: ' + result.status);
      }
      if (self._user && body.user && body.user.uid && body.user.uid !== self._user.uid) {
        // The cookie now belongs to someone else (another tab signed in); this
        // tab's user no longer has a session.
        self._signOutLocally();
        throw new Error('session expired');
      }
      rememberAccessToken(body);
      return accessToken;
    });
    refreshInFlight = request;
    var release = function () { if (refreshInFlight === request) refreshInFlight = null; };
    request.then(release, release);
    return request;
  };
  // Drop the signed-in state without telling the server (its session is
  // already gone, or about to be).
  AuthInstance.prototype._signOutLocally = function () {
    var hadUser = !!this._user;
    sessionEpoch++;
    refreshInFlight = null;
    clearHint();
    forgetAccessToken();
    clearRpcCache();
    this._user = null;
    this._settled = true;
    if (hadUser) this._emit();
  };
  AuthInstance.prototype.setPersistence = function (type) {
    persistence = (type === 'none' || type === 'NONE') ? 'none' : 'local';
    return Promise.resolve();
  };
  AuthInstance.prototype.onAuthStateChanged = function (cb) {
    this._listeners.push(cb);
    // While the startup check is pending, _emit() will call us when it settles.
    if (this._settled) {
      var u = this._user;
      Promise.resolve().then(function () { try { cb(u); } catch (e) { console.error(e); } });
    }
    var self = this;
    return function () { self._listeners = self._listeners.filter(function (f) { return f !== cb; }); };
  };
  AuthInstance.prototype._emit = function () {
    var u = this._user;
    this._listeners.forEach(function (cb) { try { cb(u); } catch (e) { console.error(e); } });
  };
  AuthInstance.prototype.signInWithCustomToken = function (customToken) {
    var self = this;
    return postAuth('/api/auth/exchange', { customToken: customToken }).then(function (result) {
      var body = result.body;
      if (!result.ok || !body.ok || !body.user || !body.accessToken) {
        throw new Error(body.error || ('exchange failed: ' + result.status));
      }
      sessionEpoch++;
      refreshInFlight = null;
      rememberAccessToken(body);
      var identity = { uid: body.user.uid, cpr: body.user.cpr };
      storeHint(identity);
      self._user = self._makeUser(identity);
      self._settled = true;
      clearRpcCache();
      self._emit();
      return { user: self._user };
    });
  };
  AuthInstance.prototype.signOut = function () {
    // Start the server-side logout first, but don't let its outcome gate the
    // local sign-out: the UI flips immediately, as it always did.
    var loggedOut = postAuth('/api/auth/logout', undefined, true).then(function () {}, function () { /* ignore */ });
    // Forget the remembered view so the next user doesn't land in it.
    try { if (window.__basaerViewRestore) window.__basaerViewRestore.clear(); } catch (e) { /* ignore */ }
    var hadUser = !!this._user;
    this._signOutLocally(); // clears hint, access token and RPC cache; emits if there was a user
    if (!hadUser) this._emit(); // signOut() always notifies, as it always did
    // Resolve once the cookie is really cleared, so a sign-in or page reload
    // that follows can't race the logout request.
    return loggedOut;
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
