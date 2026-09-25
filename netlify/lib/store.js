'use strict';
// Small key-value adapter for rate limits, lockouts and shared counters.
//  - Upstash Redis REST when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or SYNCNET_UPSTASH_URL +
//    SYNCNET_UPSTASH_TOKEN) are set: durable and shared by every function instance.
//  - Otherwise an in-memory Map: per function instance only (durable:false), so limits are best effort.
// Any Upstash problem (network, 2 s timeout, HTTP error, {error} reply, unexpected shape) throws
// StoreUnavailable. Callers decide how to fail; ratelimit.limit() fails closed.
//
// Adapter: { durable, kind, incrWindow(key, ttlSeconds) -> number, get(key) -> string|null,
//            set(key, value, {ttlSeconds}?), del(key), sadd(key, member), smembers(key) -> string[] }

class StoreUnavailable extends Error {
  constructor(message, options) {
    super(message || 'Store unavailable');
    this.name = 'StoreUnavailable';
    this.code = 'STORE_UNAVAILABLE';
    if (options && options.cause !== undefined) this.cause = options.cause;
  }
}

const DEFAULT_TIMEOUT_MS = 2000;
const MEMORY_MAX_ENTRIES = 50000;
const MEMORY = new Map(); // module-level: shared by the singleton for the lifetime of the instance
let singleton = null;

function ttlSecondsOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.ceil(n)) : 0;
}

function upstashConfig(env) {
  const url = String(env.UPSTASH_REDIS_REST_URL || env.SYNCNET_UPSTASH_URL || '').trim();
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || env.SYNCNET_UPSTASH_TOKEN || '').trim();
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

// Resolves/rejects with `promise`, or rejects as soon as `signal` aborts (even if the promise ignores it).
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new StoreUnavailable('Upstash request timed out'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new StoreUnavailable('Upstash request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

function upstashAdapter({ url, token, fetchImpl, timeoutMs }) {
  const secure = /^https:\/\//i.test(url);

  async function call(path, body) {
    // The bearer token is never sent over plain http.
    if (!secure) throw new StoreUnavailable('Upstash URL must use https');
    const doFetch = fetchImpl || globalThis.fetch;
    if (typeof doFetch !== 'function') throw new StoreUnavailable('fetch is not available');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    let data;
    try {
      res = await raceAbort(doFetch(url + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: 'error',
      }), ctl.signal);
      if (!res || !res.ok) throw new StoreUnavailable(`Upstash HTTP ${res ? res.status : 'no response'}`);
      data = await raceAbort(res.json(), ctl.signal);
    } catch (err) {
      if (err instanceof StoreUnavailable) throw err;
      throw new StoreUnavailable(ctl.signal.aborted ? 'Upstash request timed out' : 'Upstash request failed', { cause: err });
    } finally {
      clearTimeout(timer);
    }
    return data;
  }

  function unwrap(reply) {
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw new StoreUnavailable('Upstash reply malformed');
    if (reply.error !== undefined) throw new StoreUnavailable('Upstash command error', { cause: String(reply.error).slice(0, 200) });
    if (!('result' in reply)) throw new StoreUnavailable('Upstash reply malformed');
    return reply.result;
  }

  async function command(...args) {
    return unwrap(await call('', args));
  }

  async function pipeline(commands) {
    const replies = await call('/pipeline', commands);
    if (!Array.isArray(replies) || replies.length !== commands.length) throw new StoreUnavailable('Upstash pipeline reply malformed');
    return replies.map(unwrap);
  }

  return {
    durable: true,
    kind: 'upstash',
    async incrWindow(key, ttlSeconds) {
      const ttl = ttlSecondsOf(ttlSeconds) || 1;
      const [count] = await pipeline([['INCR', key], ['EXPIRE', key, ttl, 'NX']]);
      const n = Number(count);
      if (!Number.isInteger(n)) throw new StoreUnavailable('Upstash INCR reply malformed');
      return n;
    },
    async get(key) {
      const value = await command('GET', key);
      return value === null || value === undefined ? null : String(value);
    },
    async set(key, value, options) {
      const ttl = ttlSecondsOf(options && options.ttlSeconds);
      if (ttl) await command('SET', key, String(value), 'EX', ttl);
      else await command('SET', key, String(value));
    },
    async del(key) {
      return Number(await command('DEL', key)) || 0;
    },
    async sadd(key, member) {
      return Number(await command('SADD', key, String(member))) || 0;
    },
    async smembers(key) {
      const members = await command('SMEMBERS', key);
      if (!Array.isArray(members)) throw new StoreUnavailable('Upstash SMEMBERS reply malformed');
      return members.map(String);
    },
  };
}

function memoryAdapter({ map, now }) {
  const clock = typeof now === 'function' ? now : Date.now;

  function live(key) {
    const entry = map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= clock()) {
      map.delete(key);
      return null;
    }
    return entry;
  }
  function put(key, entry) {
    if (!map.has(key) && map.size >= MEMORY_MAX_ENTRIES) {
      const t = clock();
      for (const [k, e] of map) if (e.expiresAt !== null && e.expiresAt <= t) map.delete(k);
      while (map.size >= MEMORY_MAX_ENTRIES) map.delete(map.keys().next().value); // oldest first
    }
    map.set(key, entry);
  }
  function wrongType(key) {
    return new TypeError(`WRONGTYPE ${key}`);
  }

  return {
    durable: false,
    kind: 'memory',
    async incrWindow(key, ttlSeconds) {
      const ttl = ttlSecondsOf(ttlSeconds) || 1;
      const entry = live(key);
      if (!entry) {
        put(key, { type: 'string', value: '1', expiresAt: clock() + ttl * 1000 });
        return 1;
      }
      if (entry.type !== 'string') throw wrongType(key);
      const n = (parseInt(entry.value, 10) || 0) + 1;
      entry.value = String(n);
      if (entry.expiresAt === null) entry.expiresAt = clock() + ttl * 1000; // EXPIRE ... NX
      return n;
    },
    async get(key) {
      const entry = live(key);
      if (!entry) return null;
      if (entry.type !== 'string') throw wrongType(key);
      return entry.value;
    },
    async set(key, value, options) {
      const ttl = ttlSecondsOf(options && options.ttlSeconds);
      put(key, { type: 'string', value: String(value), expiresAt: ttl ? clock() + ttl * 1000 : null });
    },
    async del(key) {
      const existed = live(key) !== null;
      map.delete(key);
      return existed ? 1 : 0;
    },
    async sadd(key, member) {
      let entry = live(key);
      if (!entry) {
        entry = { type: 'set', value: new Set(), expiresAt: null };
        put(key, entry);
      }
      if (entry.type !== 'set') throw wrongType(key);
      const m = String(member);
      if (entry.value.has(m)) return 0;
      entry.value.add(m);
      return 1;
    },
    async smembers(key) {
      const entry = live(key);
      if (!entry) return [];
      if (entry.type !== 'set') throw wrongType(key);
      return [...entry.value];
    },
  };
}

// createStore({env, fetch, timeoutMs, now, map}) always builds a new adapter (tests use it directly).
function createStore(options = {}) {
  const env = options.env || process.env;
  const cfg = upstashConfig(env);
  if (cfg) return upstashAdapter({ ...cfg, fetchImpl: options.fetch, timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS });
  return memoryAdapter({ map: options.map || new Map(), now: options.now });
}

// getStore() returns the per-instance singleton (built from process.env on first use).
// getStore({env, fetch, ...}) replaces the singleton, so tests can point every function at a fake.
function getStore(options) {
  if (options && typeof options === 'object' && Object.keys(options).length) {
    singleton = createStore({ map: MEMORY, ...options });
    return singleton;
  }
  if (!singleton) singleton = createStore({ map: MEMORY });
  return singleton;
}

function _resetForTests() {
  singleton = null;
  MEMORY.clear();
}

module.exports = { getStore, createStore, StoreUnavailable, _resetForTests };
