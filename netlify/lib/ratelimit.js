'use strict';
// Fixed-window rate limits on top of store.js. Keys: rl:<bucket>:<hashId(id)>:<windowIndex>, where
// windowIndex = floor(nowMs / (windowSeconds * 1000)). If the store is unavailable the limiter FAILS
// CLOSED: {allowed:false, reason:'store-unavailable', retryAfter:60}.
const { hashId, logError } = require('./log');

const BUCKET = /^[a-z0-9_-]{1,40}$/i;

function header(event, name) {
  const headers = (event && event.headers) || {};
  if (headers[name] !== undefined) return headers[name];
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) return headers[key];
  return undefined;
}

// Netlify sets x-nf-client-connection-ip itself; x-forwarded-for is only a fallback (e.g. local dev).
function clientIp(event) {
  const direct = String(header(event, 'x-nf-client-connection-ip') || '').trim();
  if (direct) return direct.slice(0, 64).toLowerCase();
  const first = String(header(event, 'x-forwarded-for') || '').split(',')[0].trim();
  if (first) return first.slice(0, 64).toLowerCase();
  return 'unknown';
}

function nowMs(now) {
  if (typeof now === 'function') return Number(now());
  if (Number.isFinite(now)) return now;
  return Date.now();
}

// limit(store, {bucket, id, limit, windowSeconds, now?}) -> {allowed, count, limit, retryAfter[, reason]}
// retryAfter is the number of seconds until the current window ends (0 while allowed).
async function limit(store, spec = {}) {
  const { bucket, id, windowSeconds } = spec;
  const max = spec.limit;
  if (typeof bucket !== 'string' || !BUCKET.test(bucket)) throw new TypeError('ratelimit: invalid bucket');
  if (!Number.isInteger(max) || max < 1) throw new TypeError('ratelimit: invalid limit');
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) throw new TypeError('ratelimit: invalid windowSeconds');
  const t = nowMs(spec.now);
  const windowMs = windowSeconds * 1000;
  const windowIndex = Math.floor(t / windowMs);
  const key = `rl:${bucket}:${hashId(id)}:${windowIndex}`;
  let count;
  try {
    count = Number(await store.incrWindow(key, windowSeconds));
    if (!Number.isFinite(count)) throw new Error('non-numeric counter');
  } catch (err) {
    logError('ratelimit', 'store-unavailable', err, { bucket });
    return { allowed: false, reason: 'store-unavailable', retryAfter: 60, count: null, limit: max };
  }
  if (count > max) {
    const retryAfter = Math.max(1, Math.ceil(((windowIndex + 1) * windowMs - t) / 1000));
    return { allowed: false, count, limit: max, retryAfter };
  }
  return { allowed: true, count, limit: max, retryAfter: 0 };
}

// Checks specs in order and stops at the first denial (later counters are not incremented).
async function limitAll(store, specs) {
  let last = { allowed: true, count: 0, limit: 0, retryAfter: 0 };
  for (const spec of specs || []) {
    const result = await limit(store, spec);
    if (!result.allowed) return { ...result, bucket: spec.bucket };
    last = result;
  }
  return last;
}

module.exports = { clientIp, limit, limitAll };
