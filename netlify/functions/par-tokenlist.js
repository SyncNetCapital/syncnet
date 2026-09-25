'use strict';
// PAR token list, fetched server-side and rebuilt from validated fields only.
// Replaces the same-origin proxy of https://par.family/tokenlist.json, which would have served whatever PAR
// returned (HTML included) under the SyncNet origin. Now:
//  - 8 s timeout, body streamed with a 5 MiB cap, redirects not followed;
//  - the body must parse as JSON with a top-level {tokens: [...]}; HTML or anything else -> generic 502;
//  - kept entries: integer chainId === 4663, 0x address (lower-cased), symbol 1-32 and name 1-96 characters
//    after stripping control/bidi/zero-width characters, integer decimals 0-36, logoURI only if https:// or
//    ipfs://. The output is built from scratch; unknown fields are never echoed;
//  - cached 10 min in module memory (if a refresh fails, the last good list is served for up to 1 h);
//  - any query string -> 301 to /api/par-tokenlist; 60 requests per minute per client IP.
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');

const FN = 'par-tokenlist';
const SOURCE = 'https://par.family/tokenlist.json';
const CANONICAL_PATH = '/api/par-tokenlist';
const CHAIN_ID = 4663;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const FRESH_MS = 10 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 15 * 1000;
const MAX_TOKENS = 20000;
const RATE_LIMIT = Object.freeze({ bucket: 'par-tokenlist', limit: 60, windowSeconds: 60 });
const OK_HEADERS = Object.freeze({ 'cache-control': 'public, max-age=300', 'netlify-cdn-cache-control': 'public, s-maxage=600' });
const REDIRECT_HEADERS = Object.freeze({
  location: CANONICAL_PATH,
  'cache-control': 'public, max-age=3600',
  'netlify-cdn-cache-control': 'public, s-maxage=86400',
});
const UNAVAILABLE = 'The PAR token list is temporarily unavailable.';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// C0/C1 controls, soft hyphen, bidi controls (U+061C, U+200E/F, U+202A-202E, U+2066-2069), zero-width and
// other invisible format characters, fillers, variation selectors and the tag block.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]|\udb40[\udc00-\udc7f\udd00-\uddef]/g;

let cache = null; // { list, fetchedAt }
let inflight = null;
let lastFailureAt = 0;
let generation = 0;

class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamError';
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(INVISIBLE, '').trim();
  const length = Array.from(text).length;
  return length >= 1 && length <= max ? text : null;
}

function cleanLogo(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  if (/^ipfs:\/\//i.test(value)) {
    const rest = value.slice(7);
    return /^[A-Za-z0-9][A-Za-z0-9._~/-]{0,511}$/.test(rest) ? `ipfs://${rest}` : null;
  }
  if (!/^https:\/\//i.test(value)) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname) return null;
  return u.href;
}

function cleanTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Returns {name, timestamp, tokens} built only from validated fields, or null if `j` is not a token list.
function buildList(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.tokens)) return null;
  const tokens = [];
  const seen = new Set();
  for (const t of j.tokens) {
    if (tokens.length >= MAX_TOKENS) break;
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    if (!Number.isInteger(t.chainId) || t.chainId !== CHAIN_ID) continue;
    if (typeof t.address !== 'string' || !ADDRESS.test(t.address)) continue;
    const address = t.address.toLowerCase();
    if (seen.has(address)) continue;
    const symbol = cleanText(t.symbol, 32);
    const name = cleanText(t.name, 96);
    if (!symbol || !name) continue;
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) continue;
    const token = { chainId: CHAIN_ID, address, symbol, name, decimals: t.decimals };
    const logo = cleanLogo(t.logoURI);
    if (logo) token.logoURI = logo;
    seen.add(address);
    tokens.push(token);
  }
  return { name: cleanText(j.name, 96) || 'PAR Token List', timestamp: cleanTimestamp(j.timestamp), tokens };
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
      if (size > maxBytes) throw new UpstreamError('response too large'); // stop pulling right here
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function fetchList(deps) {
  const doFetch = deps.fetch || ((...args) => globalThis.fetch(...args));
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await raceAbort(doFetch(SOURCE, {
      headers: { accept: 'application/json', 'user-agent': 'SyncNet/2 (+token list cache)' },
      redirect: 'manual',
      signal: ctl.signal,
    }), ctl.signal);
    if (!(res.status >= 200 && res.status < 300)) {
      if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
      throw new UpstreamError(`HTTP ${res.status}`);
    }
    const text = await readCapped(res, MAX_BYTES, ctl.signal);
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/^\ufeff/, ''));
    } catch {
      throw new UpstreamError(`not JSON (content-type ${String(res.headers.get('content-type') || 'none').slice(0, 60)})`);
    }
    const list = buildList(parsed);
    if (!list) throw new UpstreamError('not a token list');
    if (!list.tokens.length && parsed.tokens.length) throw new UpstreamError('no valid tokens in a non-empty list');
    return list;
  } catch (err) {
    if (ctl.signal.aborted) throw new UpstreamError(`timeout after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function startRefresh(deps, now) {
  if (!inflight) {
    const gen = generation;
    const started = Date.now();
    inflight = fetchList(deps)
      .then(
        (list) => {
          log(FN, 'refreshed', { tokens: list.tokens.length, ms: Date.now() - started });
          if (gen !== generation) return { list, fetchedAt: now() };
          cache = { list, fetchedAt: now() };
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
    inflight.catch(() => {});
  }
  return inflight;
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
  if (cache && t - cache.fetchedAt < FRESH_MS) return json(200, cache.list, OK_HEADERS);
  const backingOff = !inflight && lastFailureAt && t - lastFailureAt < FAILURE_BACKOFF_MS;
  if (!backingOff) {
    try {
      const fresh = await startRefresh(deps, now);
      return json(200, fresh.list, OK_HEADERS);
    } catch {
      // logged once in startRefresh
    }
  }
  if (cache && now() - cache.fetchedAt < STALE_MS) return json(200, cache.list, OK_HEADERS);
  return publicError(502, 'upstream_unavailable', UNAVAILABLE);
}

function _resetCache() {
  cache = null;
  inflight = null;
  lastFailureAt = 0;
  generation += 1;
}

exports.handler = (event) => handler(event);
exports._handler = handler; // tests inject {fetch, now, store, timeoutMs}
exports._resetCache = _resetCache;
exports._internals = { SOURCE, CHAIN_ID, MAX_BYTES, TIMEOUT_MS, FRESH_MS, RATE_LIMIT, OK_HEADERS, buildList, cleanText, cleanLogo };
