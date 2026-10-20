'use strict';

// Tests for the fixed-window rate limiter and its Express middleware. A fake
// clock drives the window logic; the middleware is exercised with minimal
// request/response objects, no Express needed.

const { test } = require('node:test');
const assert = require('node:assert');
const { RateLimiter, rateLimitMiddleware } = require('./rate-limit.js');

function makeFakeClock(startMs = 1000000) {
  const clock = { currentMs: startMs, now: () => clock.currentMs };
  clock.advance = (ms) => { clock.currentMs += ms; };
  return clock;
}

function makeFakeResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { response.headers[name] = value; },
    status(code) { response.statusCode = code; return response; },
    json(payload) { response.body = payload; return response; },
  };
  return response;
}

test('counts hits within a window and blocks past max', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 3, now: clock.now });
  assert.deepStrictEqual(limiter.hit('a'), { allowed: true, remaining: 2, retryAfterSeconds: 0 });
  assert.deepStrictEqual(limiter.hit('a'), { allowed: true, remaining: 1, retryAfterSeconds: 0 });
  assert.deepStrictEqual(limiter.hit('a'), { allowed: true, remaining: 0, retryAfterSeconds: 0 });
  clock.advance(20000);
  const blocked = limiter.hit('a');
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.remaining, 0);
  assert.strictEqual(blocked.retryAfterSeconds, 40);
});

test('keys are counted independently', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 1, now: clock.now });
  assert.strictEqual(limiter.hit('a').allowed, true);
  assert.strictEqual(limiter.hit('a').allowed, false);
  assert.strictEqual(limiter.hit('b').allowed, true);
});

test('the counter resets once the window has elapsed', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 2, now: clock.now });
  limiter.hit('a');
  limiter.hit('a');
  assert.strictEqual(limiter.hit('a').allowed, false);
  clock.advance(59999);
  assert.strictEqual(limiter.hit('a').allowed, false);
  clock.advance(1);
  assert.deepStrictEqual(limiter.hit('a'), { allowed: true, remaining: 1, retryAfterSeconds: 0 });
});

test('retryAfterSeconds rounds up to whole seconds and is at least 1', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 10000, max: 1, now: clock.now });
  limiter.hit('a');
  clock.advance(500);
  assert.strictEqual(limiter.hit('a').retryAfterSeconds, 10); // 9.5s left
  clock.advance(9499);
  assert.strictEqual(limiter.hit('a').retryAfterSeconds, 1); // 1ms left
});

test('reset forgets a key and size reports tracked keys', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 1, now: clock.now });
  limiter.hit('a');
  limiter.hit('b');
  assert.strictEqual(limiter.size(), 2);
  assert.strictEqual(limiter.hit('a').allowed, false);
  limiter.reset('a');
  assert.strictEqual(limiter.size(), 1);
  assert.strictEqual(limiter.hit('a').allowed, true);
});

test('at maxKeys, expired counters are swept before anything live is evicted', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 1000, max: 5, maxKeys: 3, now: clock.now });
  limiter.hit('old1');
  limiter.hit('old2');
  clock.advance(1000); // old1 and old2 expire
  limiter.hit('live1');
  assert.strictEqual(limiter.size(), 3);
  limiter.hit('live2'); // over the bound: sweeps the two expired keys
  assert.strictEqual(limiter.size(), 2);
  assert.strictEqual(limiter.counters.has('old1'), false);
  assert.strictEqual(limiter.counters.has('old2'), false);
  assert.strictEqual(limiter.counters.has('live1'), true);
  assert.strictEqual(limiter.counters.has('live2'), true);
});

test('at maxKeys with no expired counters, the oldest key is evicted', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 5, maxKeys: 3, now: clock.now });
  limiter.hit('first');
  clock.advance(1);
  limiter.hit('second');
  clock.advance(1);
  limiter.hit('third');
  clock.advance(1);
  limiter.hit('fourth');
  assert.strictEqual(limiter.size(), 3);
  assert.strictEqual(limiter.counters.has('first'), false);
  assert.deepStrictEqual([...limiter.counters.keys()], ['second', 'third', 'fourth']);
});

test('key flooding never grows the map beyond maxKeys', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 5, maxKeys: 50, now: clock.now });
  for (let keyNumber = 0; keyNumber < 1000; keyNumber++) {
    limiter.hit('flood-' + keyNumber);
    assert.ok(limiter.size() <= 50);
  }
  assert.strictEqual(limiter.size(), 50);
});

test('constructor rejects invalid settings', () => {
  assert.throws(() => new RateLimiter({ max: 1 }), /windowMs/);
  assert.throws(() => new RateLimiter({ windowMs: 1000 }), /max/);
  assert.throws(() => new RateLimiter({ windowMs: 1000, max: 1, maxKeys: 0 }), /maxKeys/);
});

test('middleware passes allowed requests through and sets X-RateLimit-Remaining', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 2, now: clock.now });
  const middleware = rateLimitMiddleware({ limiter, keyFn: (request) => request.ip });
  const response = makeFakeResponse();
  let nextCalls = 0;
  middleware({ ip: '1.2.3.4' }, response, () => { nextCalls += 1; });
  assert.strictEqual(nextCalls, 1);
  assert.strictEqual(response.headers['X-RateLimit-Remaining'], '1');
  assert.strictEqual(response.body, undefined);
});

test('middleware answers 429 with Retry-After and the JSON error once over the limit', () => {
  const clock = makeFakeClock();
  const limiter = new RateLimiter({ windowMs: 60000, max: 1, now: clock.now });
  const middleware = rateLimitMiddleware({ limiter, keyFn: (request) => request.ip, message: 'slow down' });
  middleware({ ip: '1.2.3.4' }, makeFakeResponse(), () => {});
  clock.advance(15000);

  const response = makeFakeResponse();
  let nextCalls = 0;
  middleware({ ip: '1.2.3.4' }, response, () => { nextCalls += 1; });
  assert.strictEqual(nextCalls, 0);
  assert.strictEqual(response.statusCode, 429);
  assert.deepStrictEqual(response.body, { ok: false, error: 'slow down' });
  assert.strictEqual(response.headers['Retry-After'], '45');
  assert.strictEqual(response.headers['X-RateLimit-Remaining'], '0');
});

test('middleware uses the default message when none is given', () => {
  const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
  const middleware = rateLimitMiddleware({ limiter, keyFn: () => 'k' });
  middleware({}, makeFakeResponse(), () => {});
  const response = makeFakeResponse();
  middleware({}, response, () => {});
  assert.strictEqual(response.statusCode, 429);
  assert.deepStrictEqual(response.body, { ok: false, error: 'too many requests' });
});

test('middleware skips limiting when keyFn returns a falsy key', () => {
  const limiter = new RateLimiter({ windowMs: 60000, max: 1 });
  const middleware = rateLimitMiddleware({ limiter, keyFn: () => '' });
  for (let call = 0; call < 5; call++) {
    const response = makeFakeResponse();
    let nextCalls = 0;
    middleware({}, response, () => { nextCalls += 1; });
    assert.strictEqual(nextCalls, 1);
    assert.strictEqual(response.statusCode, 200);
  }
  assert.strictEqual(limiter.size(), 0);
});

test('middleware requires a limiter and a keyFn', () => {
  assert.throws(() => rateLimitMiddleware({ keyFn: () => 'k' }), /limiter/);
  assert.throws(() => rateLimitMiddleware({ limiter: new RateLimiter({ windowMs: 1, max: 1 }) }), /keyFn/);
});
