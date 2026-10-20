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
 *     'read'  - cached for the lifetime of the page (a reload starts empty).
 *               Key: name + '\u0000' + JSON.stringify(argsArray). The reply is
 *               stored as JSON text and parsed on every hit, so each caller gets
 *               its own copy to mutate. Hits are delivered asynchronously
 *               (setTimeout 0), like a network reply. Concurrent identical reads
 *               share one request. Only successful replies are cached.
 *     'live'  - never cached, never de-duplicated, never invalidates anything.
 *     'write' - never cached; once it succeeds the whole cache is cleared,
 *               before the success handler runs.
 *   Hook: window.__basaerRpcCache = { clear(), size(), enabled }. The auth shim
 *   calls clear() on sign-in and sign-out. Setting enabled = false bypasses the
 *   cache entirely (debug aid).
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
    size: function () { return resultCache.size; },
    enabled: true,
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

  // ---- Transport ------------------------------------------------------------

  function getIdToken() {
    try {
      if (window.firebase && firebase.auth && firebase.auth().currentUser) {
        return firebase.auth().currentUser.getIdToken();
      }
    } catch (e) { /* ignore */ }
    return Promise.resolve(null);
  }

  // Resolves with { res, body }; rejects on network errors and unparseable replies.
  function requestRpc(name, argsArray) {
    return getIdToken().then(function (token) {
      var headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'basaer',
      };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      return fetch('/api/rpc/' + encodeURIComponent(name), {
        method: 'POST',
        headers: headers,
        credentials: 'same-origin',
        body: JSON.stringify({ args: argsArray }),
      });
    }).then(function (res) {
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

    // 3. Send the request; every waiter gets its own parsed copy of the reply.
    pendingRequest = { waiters: [handlers] };
    inFlightRequests.set(cacheKey, pendingRequest);
    var generationAtSend = cacheGeneration;

    function finishRequest() {
      // A clear may already have replaced our entry with a newer request.
      if (inFlightRequests.get(cacheKey) === pendingRequest) inFlightRequests.delete(cacheKey);
    }

    requestRpc(name, argsArray).then(function (reply) {
      finishRequest();
      if (isSuccessfulReply(reply)) {
        var resultText = JSON.stringify(reply.body.result);
        if (generationAtSend === cacheGeneration) resultCache.set(cacheKey, resultText);
        pendingRequest.waiters.forEach(function (waiterHandlers) {
          deliverSuccess(name, waiterHandlers, parseResultText(resultText));
        });
      } else {
        var failureMessage = describeFailedReply(reply);
        pendingRequest.waiters.forEach(function (waiterHandlers) {
          deliverFailure(name, waiterHandlers, new Error(failureMessage), failureMessage);
        });
      }
    }, function (err) {
      finishRequest();
      pendingRequest.waiters.forEach(function (waiterHandlers) {
        deliverFailure(name, waiterHandlers, err);
      });
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
