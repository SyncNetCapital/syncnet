'use strict';
/*
 * GET /api/pons-economy?root=0x…&cursor=…&limit=…   — one bounded page of the canonical PONS V2 launches that were
 * LAUNCHED AGAINST `root` (their factory TokenLaunched event names root as pairToken). Newest launch first.
 *
 *  - OFF unless SYNCNET_PONS_DISCOVERY_ENABLED=true and a durable store exists: then 404 {enabled:false} and nothing
 *    else runs (the pages hide their PONS sections, exactly as before the feature existed).
 *  - root: mandatory non-zero contract address. The native-ETH index ('native') is never served here.
 *  - limit: default 24, hard maximum 50. cursor: the opaque value of the previous page's nextCursor.
 *  - Reads are ZREVRANGEBYSCORE ... LIMIT n+1 and ZCARD on the root's sorted set (netlify/lib/pons-index.js): no
 *    request ever touches the complete PONS history, and there is no endpoint that returns it.
 *  - Only the requested page is enriched (one Multicall3 eth_call: live factory record -> phase, name/symbol/logo);
 *    a broken token degrades to contract address + PONS V2 provenance. An enrichment outage never fails the page.
 *  - Completely separate from PAR (/api/par-launches-all): a PONS failure is a 503 here and nowhere else.
 */
const Economy = require('../../lib/syncnet-economy.js');
const Index = require('../lib/pons-index');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { logError } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');
const { flags } = require('../lib/flags');
const { serverRpc } = require('../lib/chain-rpc');
const { query, method: methodOf } = require('../lib/body');

const FN = 'pons-economy';
const UNAVAILABLE = 'PONS discovery is temporarily unavailable.';
const OFF = 'PONS discovery is not enabled on this deployment.';
const ENRICH_BUDGET_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;
const OK_HEADERS = Object.freeze({ 'cache-control': 'public, max-age=30', 'netlify-cdn-cache-control': 'public, s-maxage=60, stale-while-revalidate=300' });

const waitAtMost = (p, ms, fallback) => { let t; return Promise.race([p, new Promise((r) => { t = setTimeout(() => r(fallback), ms); })]).finally(() => clearTimeout(t)); };

async function handler(event = {}, deps = {}) {
  const method = methodOf(event) || 'GET';
  if (method !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });
  const store = deps.store || getStore();
  const gate = flags({ store, env: deps.env || process.env });
  if (!gate.ponsDiscovery) return json(404, { enabled: false, error: OFF, code: 'disabled' }, { 'cache-control': 'public, max-age=60' });
  const rl = await limit(store, { bucket: 'pons-eco', id: clientIp(event), limit: 60, windowSeconds: 60 });
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);

  const root = Economy.lc(query(event, 'root'));
  if (!Economy.isRootAddr(root)) return publicError(400, 'invalid_request', 'root must be a token contract address (0x followed by 40 hex characters).');
  const rawLimit = query(event, 'limit');
  if (rawLimit && !/^\d{1,4}$/.test(rawLimit)) return publicError(400, 'invalid_request', 'limit must be a whole number.');
  const n = rawLimit ? Number(rawLimit) : Index.PAGE_DEFAULT;
  if (n < 1) return publicError(400, 'invalid_request', 'limit must be at least 1.');
  const rawCursor = query(event, 'cursor');
  if (rawCursor && !(/^\d{1,16}$/.test(rawCursor) && Number.isSafeInteger(Number(rawCursor)))) return publicError(400, 'invalid_request', 'Invalid cursor.');

  let page, cov;
  try {
    [page, cov] = await Promise.all([
      Index.readRootPage(store, root, { cursor: rawCursor || null, limit: Math.min(n, Index.PAGE_MAX) }),
      Index.coverage(store),
    ]);
  } catch (err) {
    logError(FN, 'read-failed', err);
    return publicError(503, 'unavailable', UNAVAILABLE);
  }
  const bare = page.items.map((it) => ({ token: it.token, source: 'PONS_V2', factory: it.factory, stack: it.stack, launchBlock: it.launchBlock, phase: null, phaseLabel: null, name: '', symbol: '', logo: '', verified: false }));
  let items = bare;
  if (page.items.length) {
    try {
      const rpc = deps.rpc || serverRpc({ retries: 0 });
      items = await waitAtMost(Index.enrich(rpc, root, page.items, { now: deps.now }), deps.enrichBudgetMs || ENRICH_BUDGET_MS, bare);
    } catch (err) {
      logError(FN, 'enrich-failed', err);
      items = bare;
    }
  }
  const now = (deps.now || Date.now)();
  const indexed = cov.filter((c) => c.throughBlock !== null);
  const body = {
    enabled: true, source: 'PONS_V2', relationship: 'LAUNCHED_AGAINST', root, total: page.total, items, nextCursor: page.nextCursor,
    indexedThroughBlock: indexed.length === cov.length && cov.length ? Math.min(...indexed.map((c) => c.throughBlock)) : null,
    indexedAt: indexed.length ? new Date(Math.min(...indexed.map((c) => c.at || 0))).toISOString() : null,
    stale: indexed.length !== cov.length || indexed.some((c) => !c.at || now - c.at > Index.STALE_MS),
    coverage: cov.map((c) => ({ stack: c.stack, factory: c.factory, fromBlock: c.fromBlock, throughBlock: c.throughBlock })),
  };
  // Fixed size budget: names/symbols/logos are already capped; logos are the first thing dropped if ever exceeded.
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) body.items = body.items.map((it) => ({ ...it, logo: '' }));
  return json(200, body, OK_HEADERS);
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { MAX_BODY_BYTES, ENRICH_BUDGET_MS };
