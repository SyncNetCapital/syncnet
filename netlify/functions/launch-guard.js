'use strict';
// Duplicate and impersonation check before a launch (read-only, public, rate-limited).
//   GET /api/launch-guard?deployer=0x…&symbol=TICKER&name=Project
//   -> { ok, indexer: 'ok'|'unavailable',
//        sameDeployer: [{token, symbol, name, createdAt}]   PAR launches by this wallet with this ticker
//        sameSymbol:   [{token, symbol, name, deployer}]    other wallets' PAR launches with this ticker (max 20)
//        canonical:    {collision, matches: [{token, symbol, name}]}  confusable with a canonical SyncNet asset }
// Canonical identities come from syncnet-projects.json (registry.canonical === true) and are matched by a
// confusable-folded skeleton: the ticker "SYNC" or full-width "ＳＹＮＣ" collides with $SYNC, and a project name such as
// "SyncΝet" (Greek capital Nu) collides with the canonical name "SyncNet". Non-ASCII tickers are refused (400) anyway.
// The PAR indexer is secondary evidence: the builder also reads every candidate address on-chain.
// Indexer answers are cached 60 s per normalised key (single flight); 30 requests / minute / IP.
const Core = require('../../lib/syncnet-core.js');
const PROJECTS = require('../../syncnet-projects.json');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit } = require('../lib/ratelimit');
const { query, method: methodOf } = require('../lib/body');

const FN = 'launch-guard';
const INDEXER = 'https://api.par.family';
const TIMEOUT_MS = 4000;
const CACHE_MS = 60 * 1000;
const MAX_CACHE = 500;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UA = 'SyncNet/2.5 launch-guard (+https://syncnet.capital)';

const CANONICAL = (PROJECTS.projects || [])
  .filter((p) => p && p.registry && p.registry.canonical === true && ADDRESS.test(p.token || ''))
  .map((p) => ({ token: p.token.toLowerCase(), symbol: String(p.symbol || (p.profile && p.profile.name) || '').toUpperCase(), name: String(p.name || (p.profile && p.profile.name) || '') }));

const cache = new Map(); // key -> {at, rows}
const inflight = new Map();

function clean(v, max) {
  return Core.sanitizeForDisplay(String(v == null ? '' : v), { maxLength: max });
}

async function indexerRows(path, doFetch) {
  const key = path;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(INDEXER + path, { headers: { accept: 'application/json', 'user-agent': UA }, signal: ctl.signal, redirect: 'error' });
      if (!res.ok) throw new Error('indexer status ' + res.status);
      const text = await res.text();
      if (text.length > 4 * 1024 * 1024) throw new Error('indexer body too large');
      const j = JSON.parse(text);
      const rows = Array.isArray(j) ? j : Array.isArray(j && j.launches) ? j.launches : null;
      if (!rows) throw new Error('indexer shape');
      const out = rows.filter((r) => r && ADDRESS.test(String(r.token || ''))).slice(0, 500).map((r) => ({
        token: String(r.token).toLowerCase(),
        symbol: clean(r.symbol, 32).toUpperCase(),
        name: clean(r.name, 64),
        deployer: ADDRESS.test(String(r.deployer || '')) ? String(r.deployer).toLowerCase() : '',
        createdAt: Number.isFinite(Number(r.createdAt)) ? Number(r.createdAt) : String(r.createdAt || '').slice(0, 40),
      }));
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), rows: out });
      return out;
    } finally {
      clearTimeout(timer);
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

function canonicalMatches(symbol, name) {
  const sk = Core.confusableSkeleton(symbol);
  const nk = name ? Core.confusableSkeleton(name) : '';
  return CANONICAL.filter((c) => (sk && Core.confusableSkeleton(c.symbol) === sk) || (nk && c.name && Core.confusableSkeleton(c.name) === nk));
}

async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  if (method !== 'GET') return publicError(405, 'method_not_allowed', 'GET only.', { allow: 'GET' });
  const store = deps.store || getStore();
  const ip = clientIp(event);
  const rl = await limit(store, { bucket: 'launch-guard', id: ip, limit: 30, windowSeconds: 60 });
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);

  const deployer = query(event, 'deployer').trim();
  const symbol = Core.normalizeText(query(event, 'symbol')).normalize('NFKC').toUpperCase(); // full-width letters fold to ASCII
  const name = Core.normalizeText(query(event, 'name')).slice(0, 128);
  if (!ADDRESS.test(deployer) || !/^[A-Z0-9]{1,16}$/.test(symbol)) return publicError(400, 'invalid_request', 'Invalid request.');
  const wallet = deployer.toLowerCase();

  const matches = canonicalMatches(symbol, name);
  const doFetch = deps.fetch || globalThis.fetch;
  let indexer = 'ok';
  let mine = [];
  let bySymbol = [];
  try {
    [mine, bySymbol] = await Promise.all([
      indexerRows(`/launches?deployer=${wallet}&limit=500`, doFetch),
      indexerRows(`/launches?q=${encodeURIComponent(symbol)}&limit=100`, doFetch),
    ]);
  } catch (err) {
    indexer = 'unavailable';
    logError(FN, 'indexer-unavailable', err, {});
  }
  const sameDeployer = mine.filter((r) => r.symbol === symbol && (!r.deployer || r.deployer === wallet)).map(({ token, symbol: s, name: n, createdAt }) => ({ token, symbol: s, name: n, createdAt }));
  const sameSymbol = bySymbol.filter((r) => r.symbol === symbol && r.deployer !== wallet && !sameDeployer.some((x) => x.token === r.token)).slice(0, 20).map(({ token, symbol: s, name: n, deployer: d }) => ({ token, symbol: s, name: n, deployer: d }));
  log(FN, 'checked', { ip: hashId(ip), wallet: hashId(wallet), sameDeployer: sameDeployer.length, sameSymbol: sameSymbol.length, canonical: matches.length, indexer });
  return json(200, {
    ok: true,
    indexer,
    sameDeployer,
    sameSymbol,
    canonical: { collision: matches.length > 0, matches },
  });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { CANONICAL, canonicalMatches, cache };
