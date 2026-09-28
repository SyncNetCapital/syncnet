'use strict';
/*
 * GET /api/pump-economy?root=<SOLANA_MINT>&cursor=…&limit=…   — one bounded page of the verified Pump.fun launches
 * (Solana mainnet) that were LAUNCHED AGAINST `root`, i.e. whose canonical CreateEvent and BondingCurve both name
 * `root` as quote_mint. Newest launch first (slot, then a deterministic in-slot order).
 *
 *  - OFF unless SYNCNET_PUMP_DISCOVERY_ENABLED=true and a durable store exists: 404 {enabled:false}, nothing else runs.
 *  - root: a base58 Solana mint, case preserved (never lowercased). Native SOL (111…1) is not served in V0.
 *  - limit: default 24, hard maximum 50. cursor: the previous page's nextCursor, verbatim.
 *  - Reads only the root's sorted set (netlify/lib/solana-launch-index.js): bounded ZREVRANGEBYSCORE + ZCARD.
 *  - Items are identity + provenance only (mint, launchSlot, launchSignature, source). No metadata is fetched.
 *  - Independent of PONS/PAR: a failure here is a 503 here and nowhere else.
 */
const Assets = require('../../lib/syncnet-assets.js');
const Index = require('../lib/solana-launch-index');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { logError } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');
const { flags } = require('../lib/flags');
const { query, method: methodOf } = require('../lib/body');

const FN = 'pump-economy';
const SOURCE = 'PUMP_FUN';
const RELATIONSHIP = 'LAUNCHED_AGAINST';
const UNAVAILABLE = 'Pump discovery is temporarily unavailable.';
const OFF = 'Pump discovery is not enabled on this deployment.';
const STALE_MS = 15 * 60 * 1000;
// Fixed response budget: 50 items × (~44 + ~88 + fixed fields) is well below this; anything larger is trimmed.
const MAX_BODY_BYTES = 32 * 1024;
const OK_HEADERS = Object.freeze({ 'cache-control': 'public, max-age=30', 'netlify-cdn-cache-control': 'public, s-maxage=60, stale-while-revalidate=300' });

async function handler(event = {}, deps = {}) {
  const method = methodOf(event) || 'GET';
  if (method !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });
  const store = deps.store || getStore();
  const gate = flags({ store, env: deps.env || process.env });
  if (!gate.pumpDiscovery) return json(404, { enabled: false, error: OFF, code: 'disabled' }, { 'cache-control': 'public, max-age=60' });
  const rl = await limit(store, { bucket: 'pump-eco', id: clientIp(event), limit: 60, windowSeconds: 60 });
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);

  const root = query(event, 'root').trim();
  if (Assets.isNativeSol(root)) return publicError(400, 'invalid_request', 'Native SOL is not served by this version.');
  if (!Assets.isSolanaMint(root)) return publicError(400, 'invalid_request', 'root must be a Solana token mint address (base58, exact case).');
  const rawLimit = query(event, 'limit');
  if (rawLimit && !/^\d{1,4}$/.test(rawLimit)) return publicError(400, 'invalid_request', 'limit must be a whole number.');
  const n = rawLimit ? Number(rawLimit) : Index.PAGE_DEFAULT;
  if (n < 1) return publicError(400, 'invalid_request', 'limit must be at least 1.');
  const rawCursor = query(event, 'cursor');
  if (rawCursor && !Index.parseCursor(rawCursor)) return publicError(400, 'invalid_request', 'Invalid cursor.');

  let page, cov;
  try {
    [page, cov] = await Promise.all([
      Index.readRootPage(store, { source: SOURCE, relationship: RELATIONSHIP, rootMint: root, cursor: rawCursor || null, limit: Math.min(n, Index.PAGE_MAX) }),
      Index.coverage(store, SOURCE),
    ]);
  } catch (err) {
    logError(FN, 'read-failed', err);
    return publicError(503, 'unavailable', UNAVAILABLE);
  }
  const now = (deps.now || Date.now)();
  const body = {
    enabled: true,
    chain: Index.CHAIN_LABEL,
    chainId: Index.CHAIN,
    source: SOURCE,
    relationship: RELATIONSHIP,
    root: { mint: root, assetId: Assets.formatAssetId({ chain: Index.CHAIN, address: root }) },
    total: page.total,
    items: page.items.map((it) => ({
      mint: it.childMint,
      assetId: Assets.formatAssetId({ chain: Index.CHAIN, address: it.childMint }),
      source: SOURCE,
      launchSlot: it.launchSlot,
      launchSignature: it.launchSignature,
    })),
    nextCursor: page.nextCursor,
    indexedThroughSlot: cov.indexedThroughSlot,
    indexedAt: cov.indexedAt ? new Date(cov.indexedAt).toISOString() : null,
    historyComplete: cov.historyComplete,
    historyFromSlot: cov.historyFromSlot,
    stale: !cov.indexedAt || now - cov.indexedAt > STALE_MS || !cov.historyComplete,
  };
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) { body.items = body.items.map(({ assetId, ...rest }) => rest); }
  return json(200, body, OK_HEADERS);
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { MAX_BODY_BYTES, STALE_MS };
