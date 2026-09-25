'use strict';
// Founder unlock: POST {key} -> 200 {ok:true, uploadSession, uploadSessionTtl} | 401 {error:'Access denied.'}.
//  - refuses to operate unless SYNCNET_CANARY_KEY has at least 32 characters (503, reason logged server side);
//  - the key is compared as HMAC-SHA256 digests with crypto.timingSafeEqual: fixed length, constant time,
//    no early exit on a length mismatch;
//  - limits: 5 attempts per IP per 15 min; 10 failures from one IP within the hour -> that IP is locked out
//    for 1 h; 100 failures in total within the hour -> every attempt gets 429 until the hour ends
//    (a success never resets that counter). Lockouts apply before the key is even looked at;
//  - success issues a 2 h founder session (upload-session.js); IPs are only logged hashed.
const crypto = require('crypto');
const uploadSession = require('../lib/upload-session');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');

const FN = 'canary-auth';
const MIN_KEY_LENGTH = 32;
const SESSION_TTL_SECONDS = 2 * 60 * 60;
const ATTEMPTS = Object.freeze({ bucket: 'canary-attempt', limit: 5, windowSeconds: 15 * 60 });
const IP_FAILURES = Object.freeze({ limit: 10, windowSeconds: 60 * 60, lockSeconds: 60 * 60 });
const GLOBAL_FAILURES = Object.freeze({ limit: 100, windowSeconds: 60 * 60 });
const MAX_BODY_CHARS = 4096;
const UNAVAILABLE = 'Live launch access is not available on this deployment.';
const DENIED = 'Access denied.';

// Per-instance key used only to turn both values into fixed-length digests before comparing them.
const COMPARE_KEY = crypto.randomBytes(32);
function digest(value) {
  return crypto.createHmac('sha256', COMPARE_KEY).update(String(value), 'utf8').digest();
}
function keysMatch(given, expected) {
  const a = digest(typeof given === 'string' ? given : '');
  const b = digest(expected);
  return crypto.timingSafeEqual(a, b); // always 32 vs 32 bytes, whatever was typed
}

const hourIndex = (ms) => Math.floor(ms / (GLOBAL_FAILURES.windowSeconds * 1000));
const ipFailKey = (ipHash, w) => `ca:fail:ip:${ipHash}:${w}`;
const globalFailKey = (w) => `ca:fail:global:${w}`;
const lockKey = (ipHash) => `ca:lock:${ipHash}`;

async function recordFailure(store, ipHash, t) {
  const w = hourIndex(t);
  try {
    const ipFails = await store.incrWindow(ipFailKey(ipHash, w), IP_FAILURES.windowSeconds);
    if (ipFails >= IP_FAILURES.limit) {
      await store.set(lockKey(ipHash), String(t + IP_FAILURES.lockSeconds * 1000), { ttlSeconds: IP_FAILURES.lockSeconds });
      log(FN, 'ip-locked', { ip: ipHash, failures: ipFails, lockSeconds: IP_FAILURES.lockSeconds });
    }
    const globalFails = await store.incrWindow(globalFailKey(w), GLOBAL_FAILURES.windowSeconds);
    if (globalFails === GLOBAL_FAILURES.limit) log(FN, 'global-lockout', { failures: globalFails });
  } catch (err) {
    logError(FN, 'store-unavailable', err, { ip: ipHash, stage: 'record-failure' });
  }
}

function readBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(String(event.body || ''), 'base64').toString('utf8') : String(event.body || '');
  if (raw.length > MAX_BODY_CHARS) return null;
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function handler(event = {}, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  if (String(event.httpMethod || '').toUpperCase() !== 'POST') return publicError(405, 'method_not_allowed', 'POST only.', { allow: 'POST' });

  // Public messages never name environment variables or explain how access is configured.
  const expected = process.env.SYNCNET_CANARY_KEY || '';
  if (expected.length < MIN_KEY_LENGTH) {
    log(FN, 'misconfigured', {
      problem: expected ? `SYNCNET_CANARY_KEY is too short (${expected.length} < ${MIN_KEY_LENGTH} characters); refusing to operate` : 'SYNCNET_CANARY_KEY is not set',
    });
    return publicError(503, 'unavailable', UNAVAILABLE);
  }

  const store = deps.store || getStore();
  const ip = clientIp(event);
  const ipHash = hashId(ip);
  const t = now();

  // 1) lockouts (reads only; a locked-out attempt is not evaluated and not counted)
  try {
    const w = hourIndex(t);
    const globalFails = Number(await store.get(globalFailKey(w))) || 0;
    if (globalFails >= GLOBAL_FAILURES.limit) {
      log(FN, 'blocked-global-lockout', { ip: ipHash, failures: globalFails });
      return tooManyRequests(Math.ceil(((w + 1) * GLOBAL_FAILURES.windowSeconds * 1000 - t) / 1000));
    }
    const lockedUntil = Number(await store.get(lockKey(ipHash))) || 0;
    if (lockedUntil > t) {
      log(FN, 'blocked-ip-locked', { ip: ipHash });
      return tooManyRequests(Math.ceil((lockedUntil - t) / 1000));
    }
  } catch (err) {
    logError(FN, 'store-unavailable', err, { ip: ipHash, stage: 'lockout-check' });
    return tooManyRequests(60); // fail closed
  }

  // 2) attempt budget (fails closed if the store is unavailable)
  const rl = await limit(store, { ...ATTEMPTS, id: ip, now: t });
  if (!rl.allowed) {
    log(FN, 'rate-limited', { ip: ipHash, reason: rl.reason || 'limit' });
    return tooManyRequests(rl.retryAfter);
  }

  // 3) the key itself
  const body = readBody(event);
  if (!body) return publicError(400, 'invalid_request', 'Invalid request.');
  if (!keysMatch(body.key, expected)) {
    await recordFailure(store, ipHash, t);
    log(FN, 'denied', { ip: ipHash });
    return publicError(401, 'denied', DENIED);
  }

  // 4) founder session for image uploads ('' when SYNCNET_UPLOAD_KEY is missing or shorter than 32 chars)
  const token = uploadSession.issue({ scope: 'founder', subject: '-', ttlSeconds: SESSION_TTL_SECONDS, now: t });
  if (!token) log(FN, 'upload-session-unavailable', { problem: 'SYNCNET_UPLOAD_KEY missing or shorter than 32 characters' });
  log(FN, 'granted', { ip: ipHash, uploadSession: Boolean(token) });
  return json(200, { ok: true, uploadSession: token || null, uploadSessionTtl: token ? SESSION_TTL_SECONDS : 0 });
}

exports.handler = (event) => handler(event);
exports._handler = handler; // tests inject {store, now}
exports._internals = { MIN_KEY_LENGTH, ATTEMPTS, IP_FAILURES, GLOBAL_FAILURES, SESSION_TTL_SECONDS, keysMatch };
