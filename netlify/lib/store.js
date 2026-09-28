'use strict';
// Small key-value adapter for rate limits, lockouts and shared counters.
//  - Upstash Redis REST when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or SYNCNET_UPSTASH_URL +
//    SYNCNET_UPSTASH_TOKEN) are set: durable and shared by every function instance.
//  - Otherwise an in-memory Map: per function instance only (durable:false), so limits are best effort.
// Any Upstash problem (network, 2 s timeout, HTTP error, {error} reply, unexpected shape) throws
// StoreUnavailable. Callers decide how to fail; ratelimit.limit() fails closed.
//
// Adapter: { durable, kind, incrWindow(key, ttlSeconds) -> number, get(key) -> string|null,
//            set(key, value, {ttlSeconds}?), del(key), sadd(key, member), smembers(key) -> string[],
//            cas({expect, set, sadd}) -> boolean,
//            zaddMany([[key, [[score, member], ...]], ...]) -> {added, commands, requests},
//            zrevrangeByScore(key, max, min, limit) -> [{member, score}], zcard(key) -> number,
//            zrem(key, members) -> number, zremRangeByScore(key, min, max) -> number }
//
// Sorted sets exist for bounded, ordered, paginated indexes (PONS V2 discovery): a reader never needs an unbounded
// SMEMBERS. zaddMany is command-efficient: ONE `ZADD key s1 m1 s2 m2 ...` per key (at most ZADD_CHUNK pairs per
// command) and all commands go out in pipelines of at most PIPELINE_MAX commands / PIPELINE_MAX_BYTES per request. Scores are
// non-negative safe integers; range bounds use Redis syntax ('+inf', '-inf', '123', '(123' = exclusive).
//
// cas() is the ONE multi-key atomic primitive (Project Home payment activation and site writes). It is a single
// fixed Lua script (EVAL) on Upstash — Redis runs a script atomically, with no other command interleaved — and a
// synchronous, await-free block in the in-memory adapter. Semantics, identical in both:
//   expect: [[key, value|null], ...]   every key must currently hold exactly `value` (null = must not exist);
//   set:    [[key, value, ttlSeconds?], ...]  written only if EVERY expectation holds;
//   sadd:   [[key, member], ...]              likewise.
// Returns true when the writes happened, false when an expectation failed (nothing written). Any store problem
// throws StoreUnavailable (callers fail closed). Keys and values are data (KEYS/ARGV), never script text.

class StoreUnavailable extends Error {
  constructor(message, options) {
    super(message || 'Store unavailable');
    this.name = 'StoreUnavailable';
    this.code = 'STORE_UNAVAILABLE';
    if (options && options.cause !== undefined) this.cause = options.cause;
  }
}

const DEFAULT_TIMEOUT_MS = 2000;
const CAS_MAX_OPS = 16;
const CAS_SCRIPT = [
  "local ne, ns, na = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])",
  "local a = 4",
  "for i = 1, ne do",
  "  local cur = redis.call('GET', KEYS[i])",
  "  local mode, want = ARGV[a], ARGV[a + 1]",
  "  a = a + 2",
  "  if mode == 'nil' then",
  "    if cur then return 0 end",
  "  elseif cur ~= want then return 0 end",
  "end",
  "for i = 1, ns do",
  "  local ttl = tonumber(ARGV[a + 1])",
  "  if ttl > 0 then redis.call('SET', KEYS[ne + i], ARGV[a], 'EX', ttl) else redis.call('SET', KEYS[ne + i], ARGV[a]) end",
  "  a = a + 2",
  "end",
  "for i = 1, na do",
  "  redis.call('SADD', KEYS[ne + ns + i], ARGV[a])",
  "  a = a + 1",
  "end",
  "return 1",
].join('\n');

// Validates a cas() spec; returns normalized arrays or throws TypeError (programming error, not an outage).
function casSpec(spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const expect = Array.isArray(s.expect) ? s.expect : [];
  const set = Array.isArray(s.set) ? s.set : [];
  const sadd = Array.isArray(s.sadd) ? s.sadd : [];
  if (expect.length + set.length + sadd.length > CAS_MAX_OPS || set.length + sadd.length === 0) throw new TypeError('cas: invalid operation count');
  const key = (k) => { if (typeof k !== 'string' || !k || k.length > 512) throw new TypeError('cas: invalid key'); return k; };
  return {
    expect: expect.map(([k, v]) => [key(k), v === null ? null : String(v)]),
    set: set.map(([k, v, ttl]) => [key(k), String(v), ttlSecondsOf(ttl)]),
    sadd: sadd.map(([k, m]) => [key(k), String(m)]),
  };
}
const ZADD_CHUNK = 1000;
const PIPELINE_MAX = 100;
const PIPELINE_MAX_BYTES = 512 * 1024; // request-body bound per pipeline HTTP request (Upstash request-size limits)
const ZRANGE_MAX = 1000;
const zkey = (k) => { if (typeof k !== 'string' || !k || k.length > 512) throw new TypeError('zset: invalid key'); return k; };
const zmember = (m) => { if (typeof m !== 'string' || !m || m.length > 256) throw new TypeError('zset: invalid member'); return m; };
const zscore = (n) => { if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('zset: invalid score'); return n; };
const zbound = (b) => { const v = String(b); if (!/^(\+inf|-inf|\(?\d{1,16})$/.test(v)) throw new TypeError('zset: invalid bound'); return v; };
const zlimit = (n) => { if (!Number.isInteger(n) || n < 1 || n > ZRANGE_MAX) throw new TypeError('zset: invalid limit'); return n; };
// [[key, [[score, member]...]]...] -> [[key, [[score, member]...]]...] validated, empty groups dropped.
function zaddGroups(groups) {
  if (!Array.isArray(groups)) throw new TypeError('zaddMany: groups must be an array');
  return groups.map(([k, pairs]) => {
    if (!Array.isArray(pairs)) throw new TypeError('zaddMany: pairs must be an array');
    return [zkey(k), pairs.map(([sc, m]) => [zscore(sc), zmember(m)])];
  }).filter(([, pairs]) => pairs.length);
}
/**
 * The exact write plan of zaddMany (shared by both adapters and by capacity estimates): one ZADD per key per
 * ZADD_CHUNK members, packed into pipeline requests of at most PIPELINE_MAX commands and PIPELINE_MAX_BYTES of body
 * (a single larger command travels alone). -> {commands: [[...cmd]], requests: [[cmdIndex...]], bytes}
 */
function zaddPlan(groups) {
  const commands = [];
  for (const [k, pairs] of zaddGroups(groups)) {
    for (let i = 0; i < pairs.length; i += ZADD_CHUNK) {
      const cmd = ['ZADD', k];
      for (const [sc, m] of pairs.slice(i, i + ZADD_CHUNK)) cmd.push(String(sc), m);
      commands.push(cmd);
    }
  }
  const requests = [];
  let cur = [], curBytes = 2, bytes = 0;
  commands.forEach((cmd, i) => {
    const b = Buffer.byteLength(JSON.stringify(cmd)) + 1;
    bytes += b;
    if (cur.length && (cur.length >= PIPELINE_MAX || curBytes + b > PIPELINE_MAX_BYTES)) { requests.push(cur); cur = []; curBytes = 2; }
    cur.push(i); curBytes += b;
  });
  if (cur.length) requests.push(cur);
  return { commands, requests, bytes };
}
// Parses a validated bound into a predicate on a score.
function boundTest(b, upper) {
  if (b === '+inf') return () => true;
  if (b === '-inf') return () => upper ? false : true;
  const ex = b.startsWith('('), n = Number(ex ? b.slice(1) : b);
  return upper ? (s) => (ex ? s < n : s <= n) : (s) => (ex ? s > n : s >= n);
}
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
    async cas(spec) {
      const c = casSpec(spec);
      const keys = [...c.expect.map((e) => e[0]), ...c.set.map((e) => e[0]), ...c.sadd.map((e) => e[0])];
      const args = [String(c.expect.length), String(c.set.length), String(c.sadd.length)];
      for (const [, v] of c.expect) args.push(v === null ? 'nil' : 'eq', v === null ? '' : v);
      for (const [, v, ttl] of c.set) args.push(v, String(ttl));
      for (const [, m] of c.sadd) args.push(m);
      const result = await command('EVAL', CAS_SCRIPT, String(keys.length), ...keys, ...args);
      const n = Number(result);
      if (n !== 0 && n !== 1) throw new StoreUnavailable('Upstash EVAL reply malformed');
      return n === 1;
    },
    async zaddMany(groups) {
      const plan = zaddPlan(groups);
      let added = 0;
      for (const idx of plan.requests) {
        const replies = await pipeline(idx.map((i) => plan.commands[i]));
        for (const r of replies) { const n = Number(r); if (!Number.isInteger(n)) throw new StoreUnavailable('Upstash ZADD reply malformed'); added += n; }
      }
      return { added, commands: plan.commands.length, requests: plan.requests.length };
    },
    async zrevrangeByScore(key, max, min, limit) {
      const flat = await command('ZREVRANGEBYSCORE', zkey(key), zbound(max), zbound(min), 'WITHSCORES', 'LIMIT', '0', String(zlimit(limit)));
      if (!Array.isArray(flat) || flat.length % 2) throw new StoreUnavailable('Upstash ZREVRANGEBYSCORE reply malformed');
      const out = [];
      for (let i = 0; i < flat.length; i += 2) {
        const score = Number(flat[i + 1]);
        if (!Number.isSafeInteger(score)) throw new StoreUnavailable('Upstash ZREVRANGEBYSCORE score malformed');
        out.push({ member: String(flat[i]), score });
      }
      return out;
    },
    async zcard(key) {
      const n = Number(await command('ZCARD', zkey(key)));
      if (!Number.isInteger(n) || n < 0) throw new StoreUnavailable('Upstash ZCARD reply malformed');
      return n;
    },
    async zrem(key, members) {
      const list = (Array.isArray(members) ? members : []).map(zmember);
      if (!list.length) return 0;
      let removed = 0;
      for (let i = 0; i < list.length; i += ZADD_CHUNK) removed += Number(await command('ZREM', zkey(key), ...list.slice(i, i + ZADD_CHUNK))) || 0;
      return removed;
    },
    async zremRangeByScore(key, min, max) {
      return Number(await command('ZREMRANGEBYSCORE', zkey(key), zbound(min), zbound(max))) || 0;
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
    // Synchronous from the first check to the last write (no await): atomic within this process, like the script.
    async cas(spec) {
      const c = casSpec(spec);
      for (const [k, want] of c.expect) {
        const entry = live(k);
        if (entry && entry.type !== 'string') throw wrongType(k);
        const cur = entry ? entry.value : null;
        if (want === null ? cur !== null : cur !== want) return false;
      }
      for (const [k] of c.sadd) { const e = live(k); if (e && e.type !== 'set') throw wrongType(k); }
      for (const [k] of c.set) { const e = live(k); if (e && e.type !== 'string') throw wrongType(k); }
      for (const [k, v, ttl] of c.set) put(k, { type: 'string', value: v, expiresAt: ttl ? clock() + ttl * 1000 : null });
      for (const [k, m] of c.sadd) {
        let entry = live(k);
        if (!entry) { entry = { type: 'set', value: new Set(), expiresAt: null }; put(k, entry); }
        entry.value.add(m);
      }
      return true;
    },
    async zaddMany(groups) {
      const valid = zaddGroups(groups);
      for (const [k] of valid) { const e = live(k); if (e && e.type !== 'zset') throw wrongType(k); }
      const plan = zaddPlan(valid);
      let added = 0;
      for (const [k, pairs] of valid) {
        let entry = live(k);
        if (!entry) { entry = { type: 'zset', value: new Map(), expiresAt: null }; put(k, entry); }
        for (const [sc, m] of pairs) { if (!entry.value.has(m)) added += 1; entry.value.set(m, sc); }
      }
      return { added, commands: plan.commands.length, requests: plan.requests.length };
    },
    async zrevrangeByScore(key, max, min, limit) {
      const hi = boundTest(zbound(max), true), lo = boundTest(zbound(min), false), n = zlimit(limit);
      const entry = live(zkey(key));
      if (!entry) return [];
      if (entry.type !== 'zset') throw wrongType(key);
      return [...entry.value].filter(([, sc]) => hi(sc) && lo(sc))
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
        .slice(0, n).map(([member, score]) => ({ member, score }));
    },
    async zcard(key) {
      const entry = live(zkey(key));
      if (!entry) return 0;
      if (entry.type !== 'zset') throw wrongType(key);
      return entry.value.size;
    },
    async zrem(key, members) {
      const list = (Array.isArray(members) ? members : []).map(zmember);
      const entry = live(zkey(key));
      if (!entry) return 0;
      if (entry.type !== 'zset') throw wrongType(key);
      let removed = 0;
      for (const m of list) if (entry.value.delete(m)) removed += 1;
      return removed;
    },
    async zremRangeByScore(key, min, max) {
      const lo = boundTest(zbound(min), false), hi = boundTest(zbound(max), true);
      const entry = live(zkey(key));
      if (!entry) return 0;
      if (entry.type !== 'zset') throw wrongType(key);
      let removed = 0;
      for (const [m, sc] of [...entry.value]) if (lo(sc) && hi(sc)) { entry.value.delete(m); removed += 1; }
      return removed;
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

module.exports = { getStore, createStore, StoreUnavailable, _resetForTests, CAS_SCRIPT, ZADD_CHUNK, PIPELINE_MAX, PIPELINE_MAX_BYTES, ZRANGE_MAX, zaddPlan };
