'use strict';
/*
 * GET /site-img/<cid> — same-origin delivery of Project Home images.
 *
 * Only CIDs recorded by the SyncNet image sanitizer (site:img:v1:<cid>, written by ipfs-upload after decode →
 * re-encode → pin) are served, and only if the bytes fetched from the pinning gateway hash to the SHA-256 recorded at
 * sanitisation time. Anything else is 404. The response is a raster image with an exact type (PNG or GIF), nosniff,
 * a deny-all CSP and sandbox, so the bytes can never execute as a document. Closed with Project Home.
 */
const crypto = require('crypto');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');
const { logError } = require('../lib/log');
const { projectHomeConfig } = require('../lib/project-home-config');

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;
const TYPES = new Set(['image/png', 'image/gif']);
const GATEWAY = 'https://gateway.pinata.cloud/ipfs/';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 3 * 1024 * 1024;
const BASE = Object.freeze({ 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer' });
const miss = (status) => ({ statusCode: status || 404, headers: { ...BASE, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: status === 503 ? 'unavailable' : 'not found' });

async function fetchVerified(doFetch, cid, rec) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(GATEWAY + cid, { redirect: 'error', signal: ctl.signal, headers: { accept: rec.type } });
    if (!res || res.status !== 200) return null;
    const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(len) && len > Math.min(MAX_BYTES, rec.bytes)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== rec.bytes || buf.length > MAX_BYTES) return null;
    return crypto.createHash('sha256').update(buf).digest('hex') === rec.sha256 ? buf : null;
  } finally { clearTimeout(timer); }
}

async function handler(event = {}, deps = {}) {
  if (String(event.httpMethod || 'GET').toUpperCase() !== 'GET') return miss(405);
  const store = deps.store || getStore();
  const cfg = projectHomeConfig({ env: deps.env || process.env, store });
  if (!cfg.siteEnabled) return miss(404);
  const m = /\/site-img\/([^/?#]+)$/.exec(String(event.path || event.rawUrl || ''));
  const cid = m ? m[1] : '';
  if (!CID.test(cid)) return miss(404);
  try {
    const rl = await limit(store, { bucket: 'ph-img', id: clientIp(event), limit: 120, windowSeconds: 60 });
    if (!rl.allowed) return miss(rl.reason === 'store-unavailable' ? 503 : 429);
    const raw = await store.get(`site:img:v1:${cid}`);
    let rec = null; try { rec = raw ? JSON.parse(raw) : null; } catch { rec = null; }
    if (!rec || !TYPES.has(rec.type) || !/^[0-9a-f]{64}$/.test(String(rec.sha256)) || !Number.isInteger(rec.bytes) || rec.bytes < 1 || rec.bytes > MAX_BYTES) return miss(404);
    const buf = await fetchVerified(deps.fetch || globalThis.fetch, cid, rec);
    if (!buf) return miss(404);
    return { statusCode: 200, headers: { ...BASE, 'content-type': rec.type, 'content-disposition': 'inline', 'cache-control': 'public, max-age=31536000, immutable' }, body: buf.toString('base64'), isBase64Encoded: true };
  } catch (err) {
    logError('site-img', 'failed', err, { cid });
    return miss(503);
  }
}

exports.handler = (event) => handler(event);
exports._handler = handler;
