'use strict';

// Server-side cache of read-only RPC replies (policy kind 'read'), shared by
// every caller: the same function with the same arguments is computed once and
// answered from memory until the data changes.
//
// An entry is valid while
//   - the database's version stamp (Storage.versionStamp(): any sheet, file or
//     property write moves it) is still the one taken just BEFORE the reply was
//     computed — a write landing during the computation therefore invalidates
//     the entry at once — and
//   - it is younger than `ttlMs`: a reply that depends on the clock (exam
//     windows, "today" statistics) can be at most that stale.
// Concurrent identical requests share one computation. Memory is bounded by
// `maxEntries` and `maxBytes` (least recently used entries go first). Every
// entry carries an ETag (SHA-1 of the body), so a browser can revalidate its
// own copy with If-None-Match and get a bodiless 304 when nothing changed.

const crypto = require('crypto');

class RpcReadCache {
  constructor({ versionStamp, ttlMs = 60 * 1000, maxEntries = 500, maxBytes = 32 * 1024 * 1024, now = Date.now } = {}) {
    if (typeof versionStamp !== 'function') throw new Error('RpcReadCache needs a versionStamp() function');
    this.versionStamp = versionStamp;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map(); // key -> { bodyText, etag, bytes, storedAt, stamp }; Map order = recency
    this.inFlight = new Map(); // key -> Promise<entry> of a computation in progress
    this.bytes = 0;
    this.counts = { hits: 0, misses: 0, coalesced: 0, notModified: 0, evicted: 0 };
  }

  get enabled() {
    return this.ttlMs > 0;
  }

  // The valid entry for `key`, or null (an expired or outdated one is dropped).
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.storedAt >= this.ttlMs || entry.stamp !== this.versionStamp()) {
      this.delete_(key);
      return null;
    }
    // Re-insert so that the Map's order reflects recency (oldest first).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  // Keep a reply that was computed while the database was at `stamp`. A body
  // larger than the whole budget is returned but not kept.
  set(key, bodyText, stamp) {
    this.delete_(key);
    const bytes = Buffer.byteLength(bodyText);
    const entry = { bodyText, etag: etagOf(bodyText), bytes, storedAt: this.now(), stamp };
    if (bytes > this.maxBytes) return entry;
    this.entries.set(key, entry);
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete_(this.entries.keys().next().value);
      this.counts.evicted++;
    }
    return entry;
  }

  // The valid entry for `key`, computing it with `compute()` (-> body text) when
  // there is none. Identical concurrent calls wait for the same computation;
  // a failure reaches all of them and leaves nothing behind.
  async fetch(key, compute) {
    const cached = this.get(key);
    if (cached) {
      this.counts.hits++;
      return { entry: cached, hit: true };
    }
    let pending = this.inFlight.get(key);
    if (pending) {
      this.counts.coalesced++;
      return { entry: await pending, hit: true };
    }
    this.counts.misses++;
    pending = (async () => {
      const stampBefore = this.versionStamp();
      const bodyText = await compute();
      return this.set(key, bodyText, stampBefore);
    })();
    this.inFlight.set(key, pending);
    try {
      return { entry: await pending, hit: false };
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  stats() {
    return Object.assign({ enabled: this.enabled, entries: this.entries.size, bytes: this.bytes }, this.counts);
  }

  delete_(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

// A strong ETag of a reply body: the browser sends it back as If-None-Match.
function etagOf(bodyText) {
  return '"' + crypto.createHash('sha1').update(bodyText).digest('base64url') + '"';
}

module.exports = { RpcReadCache, etagOf };
