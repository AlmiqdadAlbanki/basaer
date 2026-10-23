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
 * (enforced from phase 3 onward). Every request also carries
 * 'X-Requested-With: basaer' (part of the server's CSRF check).
 *
 * Result cache (in memory, transparent to call sites)
 *   The server injects window.__basaerRpcKinds = { functionName: 'read' | 'live' | 'write' }
 *   before this script runs. A missing object or entry counts as 'write'.
 *     'read'  - cached for the lifetime of the page. Key: name + '\u0000' +
 *               JSON.stringify(argsArray). The reply is stored as JSON text and
 *               parsed on every hit, so each caller gets its own copy to mutate.
 *               Hits are delivered asynchronously (setTimeout 0), like a network
 *               reply. Concurrent identical reads share one request. Only
 *               successful replies are cached.
 *     'live'  - never cached, never de-duplicated, never invalidates anything.
 *     'write' - never cached; once it succeeds the whole cache is cleared,
 *               before the success handler runs.
 *   Across reloads (IndexedDB): every successful 'read' reply is also kept with
 *   the ETag the server sent. A kept copy is never used on its own: the next
 *   identical read sends If-None-Match, and the server answers a bodiless 304
 *   when the data is unchanged — only then is the copy used. So a reload
 *   downloads only what changed since the last visit. Copies belong to the
 *   signed-in user and are forgotten on sign-in and sign-out.
 *   Hook: window.__basaerRpcCache = { clear(), forget(), size(), enabled,
 *   setPersistence() }. The auth shim calls forget() on sign-in and sign-out.
 *   Setting enabled = false bypasses the cache entirely (debug aid).
 */
(function () {
  'use strict';

  var RESERVED = {
    withSuccessHandler: true,
    withFailureHandler: true,
    withUserObject: true,
  };

  // ---- Result cache ---------------------------------------------------------

  var resultCache = new Map();      // cacheKey -> JSON text of the successful result
  var inFlightRequests = new Map(); // cacheKey -> { waiters: [handlers, ...] }
  // Bumped on every clear so a read that was already on the wire when the cache
  // was cleared (by a write, sign-in or sign-out) does not store its now
  // possibly stale reply.
  var cacheGeneration = 0;

  function clearCachedResults() {
    resultCache.clear();
    inFlightRequests.clear(); // later identical reads must not join a pre-clear request
    cacheGeneration += 1;
  }

  var rpcCacheHook = {
    clear: clearCachedResults,
    // Sign-in / sign-out: the in-memory cache and the kept copies of the previous user go.
    forget: function () { clearCachedResults(); return forgetPersisted(); },
    size: function () { return resultCache.size; },
    enabled: true,
    // Tests replace the IndexedDB layer with an in-memory one of the same promise API.
    setPersistence: function (implementation) { persistence = implementation; },
  };
  window.__basaerRpcCache = rpcCacheHook;

  // Anything the server did not explicitly classify as 'read' or 'live' is a write.
  function getRpcKind(name) {
    var rpcKinds = window.__basaerRpcKinds;
    if (rpcKinds && typeof rpcKinds === 'object' &&
        Object.prototype.hasOwnProperty.call(rpcKinds, name)) {
      var declaredKind = rpcKinds[name];
      if (declaredKind === 'read' || declaredKind === 'live') return declaredKind;
    }
    return 'write';
  }

  function buildCacheKey(name, argsArray) {
    try {
      return name + '\u0000' + JSON.stringify(argsArray);
    } catch (e) {
      // Unserializable arguments: skip the cache; the request path reports the error.
      return null;
    }
  }

  function parseResultText(resultText) {
    return resultText === undefined ? undefined : JSON.parse(resultText);
  }

  // ---- Kept copies (IndexedDB) ----------------------------------------------
  // See the header: a copy is only ever used after the server said 304 for it.
  // Without IndexedDB (private windows, old browsers) reads simply download.

  var PERSIST_DB_NAME = 'basaer-rpc-reads';
  var PERSIST_STORE = 'reads';
  var PERSIST_MAX_ENTRIES = 400;

  function makeIndexedDbPersistence() {
    var indexedDbApi;
    try { indexedDbApi = window.indexedDB; } catch (e) { return null; }
    if (!indexedDbApi) return null;
    var databasePromise = null;

    function open() {
      if (databasePromise) return databasePromise;
      databasePromise = new Promise(function (resolve) {
        var request;
        try { request = indexedDbApi.open(PERSIST_DB_NAME, 1); } catch (e) { resolve(null); return; }
        request.onupgradeneeded = function () {
          var db = request.result;
          if (!db.objectStoreNames.contains(PERSIST_STORE)) {
            db.createObjectStore(PERSIST_STORE, { keyPath: 'key' }).createIndex('storedAt', 'storedAt');
          }
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { resolve(null); };
        request.onblocked = function () { resolve(null); };
      });
      return databasePromise;
    }

    // Runs `work(store, done)` in a transaction; resolves with what `done` was given
    // (null on any failure, which callers treat as "no copy").
    function withStore(mode, work) {
      return open().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          var transaction;
          try { transaction = db.transaction(PERSIST_STORE, mode); } catch (e) { resolve(null); return; }
          var outcome = null;
          transaction.oncomplete = function () { resolve(outcome); };
          transaction.onerror = function () { resolve(null); };
          transaction.onabort = function () { resolve(null); };
          work(transaction.objectStore(PERSIST_STORE), function (value) { outcome = value; });
        });
      }).catch(function () { return null; });
    }

    return {
      get: function (key) {
        return withStore('readonly', function (store, done) {
          var request = store.get(key);
          request.onsuccess = function () { done(request.result || null); };
        });
      },
      set: function (key, value) {
        return withStore('readwrite', function (store, done) {
          store.put(Object.assign({ key: key }, value));
          // Keep the store bounded: beyond the cap, the oldest copies go.
          var countRequest = store.count();
          countRequest.onsuccess = function () {
            var excess = countRequest.result - PERSIST_MAX_ENTRIES;
            if (excess <= 0) { done(true); return; }
            var cursorRequest = store.index('storedAt').openCursor();
            cursorRequest.onsuccess = function () {
              var cursor = cursorRequest.result;
              if (!cursor || excess <= 0) { done(true); return; }
              cursor.delete();
              excess -= 1;
              cursor.continue();
            };
          };
        });
      },
      clear: function () {
        return withStore('readwrite', function (store, done) { store.clear(); done(true); });
      },
    };
  }

  var persistence = makeIndexedDbPersistence();

  // Copies are keyed by the signed-in user (the auth shim's basaer_user hint) so
  // that nothing of one user is ever offered for another on a shared computer.
  function userScope() {
    try {
      var hint = JSON.parse(localStorage.getItem('basaer_user') || sessionStorage.getItem('basaer_user') || 'null');
      return hint && hint.cpr ? String(hint.cpr) : 'anon';
    } catch (e) { return 'anon'; }
  }

  function persistedKey(cacheKey) { return userScope() + '\u0001' + cacheKey; }

  function readPersisted(cacheKey) {
    if (!persistence) return Promise.resolve(null);
    return persistence.get(persistedKey(cacheKey)).then(function (entry) {
      return entry && typeof entry.etag === 'string' && typeof entry.resultText === 'string' ? entry : null;
    }, function () { return null; });
  }

  function writePersisted(cacheKey, etag, resultText) {
    if (!persistence || !etag) return;
    persistence.set(persistedKey(cacheKey), { etag: etag, resultText: resultText, storedAt: Date.now() })
      .catch(function () { /* a copy that could not be kept is just downloaded next time */ });
  }

  function forgetPersisted() {
    if (!persistence) return Promise.resolve(null);
    return persistence.clear().catch(function () { return null; });
  }

  // ---- Transport ------------------------------------------------------------

  function getIdToken() {
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.getIdToken();
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(null);
  }

  // Resolves with { res, body } — or { res, notModified: true } for a bodiless
  // 304; rejects on network errors and unparseable replies. `extraHeaders`
  // carries If-None-Match when a kept copy exists.
  function requestRpc(name, argsArray, extraHeaders) {
    return getIdToken().then(function (token) {
      var headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'basaer',
      };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      if (extraHeaders) Object.keys(extraHeaders).forEach(function (h) { headers[h] = extraHeaders[h]; });
      return fetch('/api/rpc/' + encodeURIComponent(name), {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: JSON.stringify({ args: argsArray }),
      });
    }).then(function (res) {
      if (res.status === 304) return { res: res, body: null, notModified: true };
      return res.json().then(function (body) { return { res: res, body: body }; });
    });
  }

  function isSuccessfulReply(reply) {
    return reply.res.ok && reply.body && reply.body.ok;
  }

  function describeFailedReply(reply) {
    return (reply.body && reply.body.error) || ('HTTP ' + reply.res.status);
  }

  // ---- Handler delivery -----------------------------------------------------

  // loggedValue is what console.error prints when there is no failure handler
  // (defaults to err itself).
  function deliverFailure(name, handlers, err, loggedValue) {
    if (!handlers.onFailure) {
      console.error('google.script.run ' + name + ':', loggedValue === undefined ? err : loggedValue);
      return;
    }
    try {
      handlers.onFailure(err, handlers.userObject);
    } catch (handlerError) {
      console.error('google.script.run ' + name + ': failure handler threw:', handlerError);
    }
  }

  // An exception thrown by the success handler is routed to the failure handler,
  // exactly as when the handler ran inside the promise chain.
  function deliverSuccess(name, handlers, result) {
    try {
      if (handlers.onSuccess) handlers.onSuccess(result, handlers.userObject);
    } catch (err) {
      deliverFailure(name, handlers, err);
    }
  }

  // ---- Cached reads ---------------------------------------------------------

  function invokeCacheableRead(name, argsArray, cacheKey, handlers) {
    // 1. Cache hit: answer from the stored JSON text, asynchronously.
    if (resultCache.has(cacheKey)) {
      var cachedResultText = resultCache.get(cacheKey);
      setTimeout(function () {
        deliverSuccess(name, handlers, parseResultText(cachedResultText));
      }, 0);
      return;
    }

    // 2. The same read is already on the wire: wait for that reply.
    var pendingRequest = inFlightRequests.get(cacheKey);
    if (pendingRequest) {
      pendingRequest.waiters.push(handlers);
      return;
    }

    // 3. Send the request — with If-None-Match when a kept copy exists, so an
    //    unchanged reply costs a bodiless 304 — and give every waiter its own
    //    parsed copy of the result.
    pendingRequest = { waiters: [handlers] };
    inFlightRequests.set(cacheKey, pendingRequest);
    var generationAtSend = cacheGeneration;

    function finishRequest() {
      // A clear may already have replaced our entry with a newer request.
      if (inFlightRequests.get(cacheKey) === pendingRequest) inFlightRequests.delete(cacheKey);
    }

    function settleWith(resultText, etag) {
      if (generationAtSend === cacheGeneration) resultCache.set(cacheKey, resultText);
      writePersisted(cacheKey, etag, resultText); // after a 304 this just renews the copy's age
      pendingRequest.waiters.forEach(function (waiterHandlers) {
        deliverSuccess(name, waiterHandlers, parseResultText(resultText));
      });
    }

    function failWith(err, loggedValue) {
      pendingRequest.waiters.forEach(function (waiterHandlers) {
        deliverFailure(name, waiterHandlers, err, loggedValue);
      });
    }

    function settleWithReply(reply) {
      if (isSuccessfulReply(reply)) {
        settleWith(JSON.stringify(reply.body.result), reply.res.headers.get('ETag'));
      } else {
        var failureMessage = describeFailedReply(reply);
        failWith(new Error(failureMessage), failureMessage);
      }
    }

    readPersisted(cacheKey).then(function (persisted) {
      return requestRpc(name, argsArray, persisted ? { 'If-None-Match': persisted.etag } : null).then(function (reply) {
        if (reply.notModified && persisted) {
          finishRequest();
          settleWith(persisted.resultText, persisted.etag);
        } else if (reply.notModified) {
          // 304 but the copy is gone (forgotten meanwhile): ask again plainly.
          return requestRpc(name, argsArray).then(function (plainReply) {
            finishRequest();
            settleWithReply(plainReply);
          });
        } else {
          finishRequest();
          settleWithReply(reply);
        }
      });
    }).catch(function (err) {
      finishRequest();
      failWith(err);
    });
  }

  // ---- Entry point ----------------------------------------------------------

  function invoke(name, args, onSuccess, onFailure, userObject) {
    var argsArray = Array.prototype.slice.call(args);
    var handlers = { onSuccess: onSuccess, onFailure: onFailure, userObject: userObject };
    var rpcKind = getRpcKind(name);

    if (rpcKind === 'read' && rpcCacheHook.enabled) {
      var cacheKey = buildCacheKey(name, argsArray);
      if (cacheKey !== null) {
        invokeCacheableRead(name, argsArray, cacheKey, handlers);
        return;
      }
    }

    // 'live' and 'write' calls (and every call while the cache is disabled).
    requestRpc(name, argsArray).then(function (reply) {
      if (isSuccessfulReply(reply)) {
        // Clear before the handler runs so a handler that re-reads gets fresh data.
        if (rpcKind === 'write') clearCachedResults();
        deliverSuccess(name, handlers, reply.body.result);
      } else {
        var failureMessage = describeFailedReply(reply);
        deliverFailure(name, handlers, new Error(failureMessage), failureMessage);
      }
    }).catch(function (err) {
      deliverFailure(name, handlers, err);
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
