'use strict';
// PAR launch history for the Map and the Builder: {count, indexed, launches, fetchedAt, stale, degraded}.
//  - module-level cache, fresh for 120 s; when a refresh fails the last good copy is served for up to 1 h
//    with stale:true, degraded:true; with no data at all the answer is a generic 503;
//  - single flight: concurrent invocations in one instance share one upstream refresh; a request waits at most
//    8 s for it (then answers stale, or 503 without data) so Netlify's 10 s limit never cuts it off;
//  - upstream: /launches/count, then pages of 500 (offsets 0..4500, so at most 5000 launches), at most 3
//    page requests in flight, 12 s timeout each, one retry with backoff on 429/5xx, redirects not followed;
//  - any query string -> 301 to /api/par-launches-all, so query strings cannot bypass the CDN cache;
//  - 60 requests per minute per client IP. Upstream error details are logged, never returned.
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');

const FN = 'par-launches-all';
const API = 'https://api.par.family';
const CANONICAL_PATH = '/api/par-launches-all';
const PAGE = 500;
const MAX_LAUNCHES = 5000;
const FRESH_MS = 120 * 1000;
const STALE_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 15 * 1000; // after a failed refresh, serve stale/503 without calling PAR again
const RESPONSE_BUDGET_MS = 8000; // longest a request waits for a refresh before answering stale / 503
const PAGE_CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RATE_LIMIT = Object.freeze({ bucket: 'par-launches-all', limit: 60, windowSeconds: 60 });
const OK_HEADERS = Object.freeze({
  'cache-control': 'public, max-age=30',
  'netlify-cdn-cache-control': 'public, s-maxage=120, stale-while-revalidate=600',
});
const REDIRECT_HEADERS = Object.freeze({
  location: CANONICAL_PATH,
  'cache-control': 'public, max-age=3600',
  'netlify-cdn-cache-control': 'public, s-maxage=86400',
});
const UNAVAILABLE = 'PAR launch history is temporarily unavailable.';

let cache = null; // { count, launches, fetchedAt }
let inflight = null; // shared refresh promise
let lastFailureAt = 0;
let generation = 0; // bumped by _resetCache so a refresh that started earlier cannot write afterwards

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    if (status) this.status = status;
  }
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new UpstreamError('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new UpstreamError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCapped(res, maxBytes, signal) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new UpstreamError('response too large');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await raceAbort(res.text(), signal);
    if (Buffer.byteLength(text) > maxBytes) throw new UpstreamError('response too large');
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new UpstreamError('response too large');
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function backoffMs(res) {
  const retryAfter = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(2000, retryAfter * 1000);
  return 250 + Math.floor(Math.random() * 250);
}

// GET + JSON.parse with a per-request timeout and one retry (with backoff) on 429/5xx.
async function getJson(url, ctx) {
  for (let attempt = 0; ; attempt += 1) {
    if (ctx.signal.aborted) throw new UpstreamError('aborted');
    const ctl = new AbortController();
    const onParentAbort = () => ctl.abort();
    ctx.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), ctx.timeoutMs);
    let res;
    try {
      res = await raceAbort(ctx.fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'SyncNet/2 (+launch history cache)' },
        redirect: 'manual',
        signal: ctl.signal,
      }), ctl.signal);
      if (res.status >= 200 && res.status < 300) return JSON.parse(await readCapped(res, MAX_RESPONSE_BYTES, ctl.signal));
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
    } catch (err) {
      if (ctl.signal.aborted && !ctx.signal.aborted) throw new UpstreamError(`timeout after ${ctx.timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onParentAbort);
    }
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= 1) throw new UpstreamError(`HTTP ${res.status}`, res.status);
    await raceAbort(ctx.sleep(backoffMs(res)), ctx.signal);
  }
}

function countOf(body) {
  const raw = body && typeof body === 'object' ? (body.launched ?? body.count ?? body.total) : body;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === 'string' && /^\d{1,9}$/.test(raw)) return Number(raw);
  return null;
}

function rowsOf(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['launches', 'items', 'data', 'rows', 'results']) if (body && Array.isArray(body[key])) return body[key];
  return null; // unexpected shape: treated as a failed refresh, never as "no launches"
}

async function refresh(deps) {
  const started = Date.now();
  const ctl = new AbortController();
  const ctx = {
    fetch: deps.fetch || ((...args) => globalThis.fetch(...args)),
    signal: ctl.signal,
    timeoutMs: Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : REQUEST_TIMEOUT_MS,
    sleep: typeof deps.sleep === 'function' ? deps.sleep : defaultSleep,
  };
  try {
    let count = null;
    try {
      count = countOf(await getJson(`${API}/launches/count`, ctx));
    } catch (err) {
      logError(FN, 'count-failed', err); // pages are still walked until a short page
    }
    const target = count === null ? MAX_LAUNCHES : Math.min(count, MAX_LAUNCHES);
    const pages = Math.max(1, Math.ceil(target / PAGE));
    const results = new Array(pages);
    let next = 0;
    let lastPage = pages - 1;
    const worker = async () => {
      while (next <= lastPage && !ctl.signal.aborted) {
        const i = next;
        next += 1;
        const rows = rowsOf(await getJson(`${API}/launches?orderBy=createdAt&orderDirection=desc&limit=${PAGE}&offset=${i * PAGE}`, ctx));
        if (!rows) throw new UpstreamError('unexpected launches payload');
        results[i] = rows;
        if (rows.length < PAGE && i < lastPage) lastPage = i; // a short page is the end of the history
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, pages) }, worker));

    const launches = [];
    const seen = new Set();
    for (let i = 0; i <= lastPage && launches.length < MAX_LAUNCHES; i += 1) {
      for (const row of results[i] || []) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const address = [row.token, row.tokenAddress, row.address].find((v) => typeof v === 'string' && v);
        const key = address ? address.toLowerCase() : JSON.stringify([row.createdAt, row.symbol, row.name, row.deployer]);
        if (seen.has(key)) continue;
        seen.add(key);
        launches.push(row);
        if (launches.length >= MAX_LAUNCHES) break;
      }
    }
    if (count && !launches.length) throw new UpstreamError('count > 0 but no launch rows');
    log(FN, 'refreshed', { count, indexed: launches.length, pages: lastPage + 1, ms: Date.now() - started });
    return { count: count || launches.length, launches };
  } catch (err) {
    ctl.abort(); // stop the other page workers
    throw err;
  }
}

function startRefresh(deps, now) {
  if (!inflight) {
    const gen = generation;
    inflight = refresh(deps)
      .then(
        (data) => {
          if (gen !== generation) return { ...data, fetchedAt: now() };
          cache = { ...data, fetchedAt: now() };
          lastFailureAt = 0;
          return cache;
        },
        (err) => {
          if (gen === generation) lastFailureAt = now();
          logError(FN, 'refresh-failed', err);
          throw err;
        },
      )
      .finally(() => {
        if (gen === generation) inflight = null;
      });
    inflight.catch(() => {}); // a caller may stop waiting (response budget); never an unhandled rejection
  }
  return inflight;
}

// Resolves with the promise's value, or with null once `ms` elapse first.
function waitAtMost(promise, ms) {
  if (!Number.isFinite(ms)) return promise;
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })])
    .finally(() => clearTimeout(timer));
}

function hasQuery(event) {
  for (const key of ['queryStringParameters', 'multiValueQueryStringParameters']) {
    const q = event[key];
    if (q && typeof q === 'object' && Object.keys(q).length) return true;
  }
  if (typeof event.rawQuery === 'string' && event.rawQuery.replace(/^\?/, '') !== '') return true;
  if (typeof event.rawUrl === 'string') {
    try {
      return new URL(event.rawUrl).search.length > 1;
    } catch {
      return false;
    }
  }
  return false;
}

function ok(entry, stale) {
  return json(200, {
    count: entry.count,
    indexed: entry.launches.length,
    launches: entry.launches,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
    stale,
    degraded: stale,
  }, OK_HEADERS);
}

async function handler(event = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  if (String(event.httpMethod || 'GET').toUpperCase() !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });

  const ip = clientIp(event);
  const rl = await limit(deps.store || getStore(), { ...RATE_LIMIT, id: ip, now: now() });
  if (!rl.allowed) {
    log(FN, 'rate-limited', { ip: hashId(ip), reason: rl.reason || 'limit' });
    return tooManyRequests(rl.retryAfter);
  }
  if (hasQuery(event)) return json(301, { location: CANONICAL_PATH }, REDIRECT_HEADERS);

  const t = now();
  if (cache && t - cache.fetchedAt < FRESH_MS) return ok(cache, false);
  const backingOff = !inflight && lastFailureAt && t - lastFailureAt < FAILURE_BACKOFF_MS;
  if (!backingOff) {
    try {
      // Answer (stale or 503) before Netlify's 10 s function limit would cut the invocation off; the shared
      // refresh keeps running and later invocations join it.
      const budget = Number(deps.budgetMs) > 0 ? Number(deps.budgetMs) : RESPONSE_BUDGET_MS;
      const fresh = await waitAtMost(startRefresh(deps, now), budget);
      if (fresh) return ok(fresh, false);
      log(FN, 'refresh-slow', { budgetMs: budget, stale: Boolean(cache) });
    } catch {
      // logged once in startRefresh
    }
  }
  if (cache && now() - cache.fetchedAt < STALE_MS) return ok(cache, true);
  return json(503, { error: UNAVAILABLE, degraded: true }, { 'retry-after': '30' });
}

function _resetCache() {
  cache = null;
  inflight = null;
  lastFailureAt = 0;
  generation += 1;
}

exports.handler = (event) => handler(event);
exports._handler = handler; // tests inject {fetch, now, store, sleep, timeoutMs, budgetMs}
exports._resetCache = _resetCache;
exports._internals = { API, PAGE, MAX_LAUNCHES, FRESH_MS, STALE_MS, PAGE_CONCURRENCY, REQUEST_TIMEOUT_MS, RESPONSE_BUDGET_MS, RATE_LIMIT, OK_HEADERS };
