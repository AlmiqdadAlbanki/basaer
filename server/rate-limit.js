'use strict';

// Dependency-free fixed-window rate limiter plus an Express middleware wrapper.
//
// Each key (an IP address, an email, ...) gets a counter that starts when its
// first hit arrives and resets once `windowMs` has elapsed. Counters live in an
// in-process Map, so the limit is per worker thread/process; use it as a cheap
// first line of defence in front of anything that is persisted (for example the
// SQLite-backed login lockout in auth/identity-service.js).
//
// Memory bound: an attacker can mint unlimited distinct keys, so the Map is
// capped at `maxKeys`. A counter is re-inserted into the Map whenever its window
// restarts, which keeps the Map ordered oldest-window-first; that lets the
// overflow handling drop expired counters (a prefix of the Map) and, if the Map
// is still too big, the oldest live ones, without ever scanning the whole Map.

class RateLimiter {
  // windowMs: length of one counting window in milliseconds.
  // max:      hits allowed per key within one window.
  // maxKeys:  upper bound on distinct keys tracked at once.
  // now:      clock returning epoch milliseconds (injectable for tests).
  constructor({ windowMs, max, maxKeys = 10000, now = Date.now } = {}) {
    if (!(windowMs > 0)) throw new Error('RateLimiter: windowMs must be a positive number');
    if (!(max > 0)) throw new Error('RateLimiter: max must be a positive number');
    if (!(maxKeys > 0)) throw new Error('RateLimiter: maxKeys must be a positive number');
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.now = now;
    this.counters = new Map(); // key -> { count, windowStart }
  }

  // Count one hit for `key`.
  // Returns { allowed, remaining, retryAfterSeconds }; retryAfterSeconds is 0
  // while allowed, otherwise the whole seconds until the key's window resets.
  hit(key) {
    const nowMs = this.now();
    let counter = this.counters.get(key);
    if (!counter || nowMs >= counter.windowStart + this.windowMs) {
      counter = { count: 0, windowStart: nowMs };
      // Delete before set so a restarted window moves to the end of the Map.
      this.counters.delete(key);
      this.counters.set(key, counter);
      if (this.counters.size > this.maxKeys) this.makeRoom_(nowMs);
    }
    counter.count += 1;
    const allowed = counter.count <= this.max;
    const remaining = Math.max(0, this.max - counter.count);
    const retryAfterSeconds = allowed
      ? 0
      : Math.max(1, Math.ceil((counter.windowStart + this.windowMs - nowMs) / 1000));
    return { allowed, remaining, retryAfterSeconds };
  }

  // Forget a key (for example after a successful login).
  reset(key) {
    this.counters.delete(key);
  }

  // Number of keys currently tracked.
  size() {
    return this.counters.size;
  }

  // Bring the Map back to `maxKeys`: first drop expired counters, then, if the
  // Map is still over the bound, drop the oldest live ones.
  makeRoom_(nowMs) {
    for (const [key, counter] of this.counters) {
      if (nowMs < counter.windowStart + this.windowMs) break; // the rest are newer
      this.counters.delete(key);
    }
    while (this.counters.size > this.maxKeys) {
      this.counters.delete(this.counters.keys().next().value);
    }
  }
}

// Express middleware factory.
//   limiter: a RateLimiter.
//   keyFn:   (req) => string. A falsy key skips limiting for that request.
//   message: error text for the 429 body (default 'too many requests').
function rateLimitMiddleware({ limiter, keyFn, message }) {
  if (!limiter || typeof limiter.hit !== 'function') throw new Error('rateLimitMiddleware: limiter is required');
  if (typeof keyFn !== 'function') throw new Error('rateLimitMiddleware: keyFn is required');
  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    if (!key) return next();
    const result = limiter.hit(key);
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: message || 'too many requests' });
    }
    return next();
  };
}

module.exports = { RateLimiter, rateLimitMiddleware };
