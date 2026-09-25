'use strict';
// Image pinning for token logos. Never pins the bytes a user sent: every image is decoded, checked and
// re-encoded server-side (../lib/image-sanitize.js), which strips EXIF/XMP/comments and anything else that is
// not pixels.
//
//   GET  /api/ipfs-upload -> {public}  whether wallet-signed public uploads are open (server-side gate)
//   POST /api/ipfs-upload  header x-syncnet-upload-session: <session>
//        body {type: 'image/png'|'image/gif', data: <base64>, name?}
//        -> {cid, uri, type, width, height, bytes, pins: {primary, secondary}}
//
// Who may upload:
//   - founder sessions (issued by /api/canary-auth after the server-side operator key check);
//   - wallet sessions (issued by /api/upload-auth after a wallet signature) ONLY while public uploads are open.
//   There is no anonymous path and no raw-key header.
// Limits (durable store; fail closed if it is unavailable):
//   founder: 60 / hour / session;  wallet: 5 / hour and 20 / day per wallet, 20 / hour per IP;
//   all public uploads together: 300 / hour.  Input <= 3 MB, PNG <= 1024x1024, GIF <= 512x512 and 120 frames.
// SYNCNET_UPLOADS_DISABLED=true stops every upload immediately (kill switch).
// Pinning: PINATA_JWT (use a key scoped to pinFileToIPFS only). Optional redundant pin through any IPFS
// Pinning Service API endpoint: SYNCNET_PIN_SECONDARY_URL + SYNCNET_PIN_SECONDARY_TOKEN.
// Errors sent to the browser are fixed sentences; causes are logged server-side with hashed identifiers.
const crypto = require('crypto');
const uploadSession = require('../lib/upload-session');
const { sanitizeImage, ImageRejected } = require('../lib/image-sanitize');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limitAll } = require('../lib/ratelimit');
const { flags } = require('../lib/flags');
const { readJsonBody, header, method: methodOf } = require('../lib/body');

const FN = 'ipfs-upload';
const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_BODY_CHARS = Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 4096;
const TYPES = new Set(['image/png', 'image/gif']);
const PINATA_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const PIN_TIMEOUT_MS = 20000;
const SECONDARY_TIMEOUT_MS = 8000;
const CLOSED = 'Image uploads are not open on this deployment.';
const PAUSED = 'Image uploads are paused on this deployment. Try again later.';
const PIN_FAILED = 'The image could not be pinned right now. Retrying is safe.';
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;

async function withTimeout(ms, fn) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pinPrimary(buffer, type, meta, env, doFetch) {
  const ext = type === 'image/gif' ? 'gif' : 'png';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), `syncnet-${meta.sha256.slice(0, 16)}.${ext}`);
  form.append('pinataMetadata', JSON.stringify({ name: `syncnet-${meta.sha256.slice(0, 16)}`, keyvalues: { source: meta.scope, subject: meta.subject, sha256: meta.sha256 } }));
  form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
  const res = await withTimeout(PIN_TIMEOUT_MS, (signal) => doFetch(PINATA_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.PINATA_JWT}` }, body: form, signal }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.IpfsHash !== 'string' || !CID.test(data.IpfsHash)) {
    const err = new Error(`pinata status ${res.status}`);
    err.code = 'PIN_PRIMARY';
    throw err;
  }
  return data.IpfsHash;
}

// IPFS Pinning Service API: POST {endpoint}/pins {cid, name}. Redundancy is best effort and reported honestly.
async function pinSecondary(cid, name, env, doFetch) {
  const url = String(env.SYNCNET_PIN_SECONDARY_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.SYNCNET_PIN_SECONDARY_TOKEN || '').trim();
  if (!url || !token) return 'not-configured';
  if (!/^https:\/\//i.test(url)) return 'not-configured';
  try {
    const res = await withTimeout(SECONDARY_TIMEOUT_MS, (signal) => doFetch(`${url}/pins`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ cid, name }), signal }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`secondary status ${res.status}`);
    const status = String(data.status || 'queued');
    return ['queued', 'pinning', 'pinned'].includes(status) ? status : 'failed';
  } catch (err) {
    logError(FN, 'secondary-pin-failed', err, { cid });
    return 'failed';
  }
}

async function handler(event = {}, deps = {}) {
  const env = deps.env || process.env;
  const method = methodOf(event);
  const store = deps.store || getStore();
  const gate = flags({ env, store });
  if (method === 'GET' || method === 'HEAD') return json(200, { public: gate.publicUploads });
  if (method !== 'POST') return publicError(405, 'method_not_allowed', 'POST only.', { allow: 'GET, POST' });
  if (gate.uploadsKilled) return publicError(503, 'paused', PAUSED);
  if (!String(env.PINATA_JWT || '').trim()) {
    log(FN, 'misconfigured', { problem: 'PINATA_JWT is not set' });
    return publicError(503, 'unavailable', CLOSED);
  }

  // 1) session: founder always; wallet only while public uploads are open
  const scopes = gate.publicUploads ? ['founder', 'wallet'] : ['founder'];
  const session = uploadSession.verify(header(event, 'x-syncnet-upload-session'), { scope: scopes });
  const ip = clientIp(event);
  const ipHash = hashId(ip);
  if (!session) {
    log(FN, 'denied', { ip: ipHash, reason: header(event, 'x-syncnet-upload-session') ? 'invalid-or-expired-session' : 'no-session' });
    return publicError(401, 'denied', CLOSED);
  }
  const subject = session.scope === 'wallet' ? session.subject : `founder:${session.sid}`;

  // 2) rate limits and quotas (fail closed)
  const specs = session.scope === 'wallet'
    ? [
      { bucket: 'up-ip', id: ip, limit: 20, windowSeconds: 3600 },
      { bucket: 'up-wallet-h', id: subject, limit: 5, windowSeconds: 3600 },
      { bucket: 'up-wallet-d', id: subject, limit: 20, windowSeconds: 86400 },
      { bucket: 'up-public', id: 'all', limit: 300, windowSeconds: 3600 },
    ]
    : [{ bucket: 'up-founder', id: subject, limit: 60, windowSeconds: 3600 }];
  const rl = await limitAll(store, specs);
  if (!rl.allowed) {
    log(FN, 'rate-limited', { ip: ipHash, subject: hashId(subject), bucket: rl.bucket || '', reason: rl.reason || 'limit' });
    return tooManyRequests(rl.retryAfter);
  }

  // 3) payload
  const body = readJsonBody(event, MAX_BODY_CHARS);
  if (!body) return publicError(400, 'invalid_request', 'That image could not be accepted. Use a PNG or GIF up to 3 MB.');
  const type = String(body.type || '').toLowerCase();
  if (!TYPES.has(type)) return publicError(400, 'unsupported_type', 'Only PNG and GIF images are accepted.');
  const data = String(body.data || '');
  if (!data || data.length > MAX_BODY_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return publicError(400, 'invalid_request', 'That image could not be accepted.');
  const input = Buffer.from(data, 'base64');
  if (input.length < 1 || input.length > MAX_INPUT_BYTES) return publicError(400, 'too_large', 'The image file is too large (3 MB maximum).');

  // 4) decode + re-encode (strips all metadata)
  let clean;
  try {
    clean = sanitizeImage(input, { declaredType: type });
  } catch (err) {
    if (err instanceof ImageRejected) {
      log(FN, 'rejected', { subject: hashId(subject), code: err.code, bytes: input.length });
      return publicError(400, String(err.code || 'rejected').toLowerCase(), err.message);
    }
    logError(FN, 'sanitize-failed', err, { subject: hashId(subject) });
    return publicError(400, 'invalid_image', 'The image file is damaged or invalid.');
  }
  const sha256 = crypto.createHash('sha256').update(clean.buffer).digest('hex');

  // 5) pin
  const doFetch = deps.fetch || globalThis.fetch;
  let cid;
  try {
    cid = await pinPrimary(clean.buffer, clean.type, { sha256, scope: session.scope, subject: hashId(subject) }, env, doFetch);
  } catch (err) {
    logError(FN, 'pin-failed', err, { subject: hashId(subject) });
    return publicError(502, 'pin_failed', PIN_FAILED);
  }
  const secondary = await pinSecondary(cid, `syncnet-${sha256.slice(0, 16)}`, env, doFetch);
  log(FN, 'pinned', { scope: session.scope, subject: hashId(subject), ip: ipHash, cid, type: clean.type, bytesIn: input.length, bytesOut: clean.buffer.length, width: clean.width, height: clean.height, secondary });
  return json(200, {
    cid,
    uri: `ipfs://${cid}`,
    type: clean.type,
    width: clean.width,
    height: clean.height,
    bytes: clean.buffer.length,
    pins: { primary: 'pinned', secondary },
  });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
