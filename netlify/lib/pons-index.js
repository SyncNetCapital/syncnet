'use strict';
/*
 * PONS V2 discovery index (server only): which canonical Pons V2 launches were LAUNCHED AGAINST a given pair token.
 *
 * Truth model: a child C belongs to the Pons V2 connections of root R exactly when a verified Pons V2 factory
 * (lib/syncnet-origins.js PONS_V2_STACKS) emitted TokenLaunched(token = C, …, pairToken = R). The indexed event IS the
 * evidence; nothing is inferred from tickers, names, websites or token self-claims. Graduation changes the launch's
 * state, never its membership. pairToken == address(0) (native ETH) is indexed under the sentinel root 'native',
 * never under WETH and never under an address.
 *
 * Storage (Upstash, via store.js sorted sets — no unbounded SMEMBERS anywhere):
 *   pons2:root:v1:<root>          ZSET  member "<stackId>:<token>"          score = block * 1e6 + logIndex
 *   pons2:cursor:v1:<stackId>     STRING {"block":n,"hash":"0x…","at":ms}   last fully indexed block of that stack
 *   pons2:journal:v1:<stackId>    ZSET  member "<root>|<stackId>:<token>"   score as above; only the last
 *                                        JOURNAL_BLOCKS blocks are kept — it exists so a reorg can be undone.
 * Scores are unique per launch (block, logIndex), so descending score = newest launch first, deterministically, and a
 * score is an exact, stable pagination cursor. Members are immutable launch identity only; names, symbols, logos and
 * phases are read lazily for the requested page and never stored.
 *
 * Writers: netlify/scripts/pons-backfill.js (offline, dry-run by default) seeds the cursor; the scheduled
 * pons-indexer function advances it incrementally. Visitors only read pages (readRootPage).
 */
const Core = require('../../lib/syncnet-core.js');
const Chain = require('../../lib/syncnet-chain.js');
const Origins = require('../../lib/syncnet-origins.js');

const SCORE_MUL = 1e6;
const CONFIRMATIONS = 120; // ~12 s of Robinhood Chain blocks behind head before a block is indexed
const REORG_REWIND = 2000; // blocks re-scanned after a cursor hash mismatch
const JOURNAL_BLOCKS = 20000; // journal retention (>> REORG_REWIND)
const MAX_BLOCKS_PER_RUN = 150000; // one scheduled run never scans more than this (never history)
const DEFAULT_CHUNK = 100000;
const MAX_CHUNK = 1000000;
const GROW_BELOW = 2500; // grow the getLogs window while a chunk returns fewer logs than this
const HEX32 = /^0x[0-9a-f]{64}$/;
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const hex = (n) => '0x' + Number(n).toString(16);
const isRootKey = (r) => r === Origins.PONS_NATIVE || (Chain.isAddr(r) && lc(r) === r && r !== Chain.ZERO);

const K = Object.freeze({
  root: (root) => `pons2:root:v1:${root}`,
  cursor: (stackId) => `pons2:cursor:v1:${stackId}`,
  journal: (stackId) => `pons2:journal:v1:${stackId}`,
  lock: 'pons2:lock:v1',
});

// ---------------------------------------------------------------- members
const stackById = (id) => Origins.PONS_V2_STACKS.find((s) => s.id === id) || null;
function scoreOf(launch) {
  if (!Number.isSafeInteger(launch.block) || launch.block < 0 || !Number.isSafeInteger(launch.logIndex) || launch.logIndex < 0 || launch.logIndex >= SCORE_MUL) throw new RangeError('launch position out of range');
  const s = launch.block * SCORE_MUL + launch.logIndex;
  if (!Number.isSafeInteger(s)) throw new RangeError('score out of range');
  return s;
}
const memberOf = (launch) => `${launch.stack}:${launch.token}`;
/** "<stackId>:<token>" -> {stack, factory, token} for a verified stack, else null. */
function parseMember(m) {
  const x = /^([a-z0-9]{1,8}):(0x[0-9a-f]{40})$/.exec(String(m || ''));
  const stack = x && stackById(x[1]);
  return stack ? { stack: stack.id, factory: stack.factory, token: x[2] } : null;
}
const blockOfScore = (score) => Math.floor(score / SCORE_MUL);

// ---------------------------------------------------------------- log collection
/** Adds canonical launches from raw logs into `acc` ({seen:Set, launches:[], stats}). One bad log never throws. */
function collect(logs, acc) {
  const st = acc.stats;
  for (const log of Array.isArray(logs) ? logs : []) {
    st.logs += 1;
    try {
      if (!log || typeof log !== 'object') { st.rejected += 1; continue; }
      if (log.removed === true) { st.removed += 1; continue; }
      const launch = Origins.decodePonsV2Launch(log);
      if (!launch) { st.rejected += 1; continue; } // wrong emitter, wrong topic, malformed layout
      const id = launch.txHash + ':' + launch.logIndex;
      if (acc.seen.has(id)) { st.duplicates += 1; continue; }
      scoreOf(launch); // position must be representable
      acc.seen.add(id);
      acc.launches.push(launch);
    } catch {
      st.rejected += 1;
    }
  }
  return acc;
}
const newAcc = () => ({ seen: new Set(), launches: [], stats: { logs: 0, removed: 0, rejected: 0, duplicates: 0 } });

// ---------------------------------------------------------------- adaptive eth_getLogs
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (e) => /429|too many requests|rate limit/i.test(String((e && e.message) || '')) || (e && Number(e.code) === 429);

/**
 * Walks [from, to] in adaptive windows: eth_getLogs({address: factories, topics: [TokenLaunched]}). Any failure
 * (result-count limit, range limit, timeout, 429) halves the window and retries; a rate limit also backs off. A
 * window of one block that keeps failing throws. Windows grow again while results stay small.
 * hooks.before(from, to) runs before each window's getLogs (its value is passed on); hooks.onChunk(logs, from, to, pre)
 * consumes each window in order; hooks.deadline (ms timestamp) stops early. Returns {through, requests, chunks, shrinks}.
 */
async function scanLogs(rpc, { factories, from, to, chunk = DEFAULT_CHUNK, maxChunk = MAX_CHUNK, before, onChunk, deadline, sleep = defaultSleep, now = Date.now, maxFailures = 8 }) {
  const out = { through: from - 1, requests: 0, chunks: 0, shrinks: 0 };
  let size = Math.max(1, Math.min(chunk, maxChunk)), failures = 0, start = from;
  while (start <= to) {
    if (deadline && now() >= deadline) break;
    const end = Math.min(to, start + size - 1);
    let logs, pre;
    try {
      pre = before ? await before(start, end) : undefined;
      out.requests += 1;
      logs = await rpc('eth_getLogs', [{ address: factories, topics: [Origins.PONS_V2_TOKEN_LAUNCHED], fromBlock: hex(start), toBlock: hex(end) }]);
      if (!Array.isArray(logs)) throw new Error('eth_getLogs reply malformed');
    } catch (err) {
      if (err && err.reorg) throw err;
      failures += 1;
      if (size === 1 && failures > maxFailures) throw err;
      if (size > 1) { size = Math.max(1, Math.floor(size / 2)); out.shrinks += 1; }
      if (rateLimited(err) || size === 1) await sleep(Math.min(8000, 250 * 2 ** Math.min(failures, 5)));
      continue;
    }
    failures = 0;
    await onChunk(logs, start, end, pre);
    out.chunks += 1;
    out.through = end;
    start = end + 1;
    if (logs.length < GROW_BELOW) size = Math.min(maxChunk, size * 2);
  }
  return out;
}

// ---------------------------------------------------------------- writes
/** Sorted-set groups for a batch of launches: one ZADD group per root (+ the journal for recent blocks). */
function groupsFor(launches, { journalFrom = Infinity } = {}) {
  const roots = new Map(), journals = new Map();
  for (const l of launches) {
    if (!isRootKey(l.root)) continue;
    const score = scoreOf(l), member = memberOf(l);
    if (!roots.has(l.root)) roots.set(l.root, []);
    roots.get(l.root).push([score, member]);
    if (l.block >= journalFrom) {
      if (!journals.has(l.stack)) journals.set(l.stack, []);
      journals.get(l.stack).push([score, l.root + '|' + member]);
    }
  }
  return [...[...roots].map(([r, pairs]) => [K.root(r), pairs]), ...[...journals].map(([s, pairs]) => [K.journal(s), pairs])];
}
async function writeLaunches(store, launches, opts) {
  const groups = groupsFor(launches, opts);
  if (!groups.length) return { added: 0, commands: 0, requests: 0 };
  return store.zaddMany(groups);
}

async function readCursor(store, stackId) {
  const raw = await store.get(K.cursor(stackId));
  if (!raw) return null;
  let c;
  try { c = JSON.parse(raw); } catch { return null; }
  return c && Number.isSafeInteger(c.block) && c.block >= 0 && HEX32.test(lc(c.hash)) ? { block: c.block, hash: lc(c.hash), at: Number(c.at) || 0 } : null;
}
const writeCursor = (store, stackId, block, hash, at) => store.set(K.cursor(stackId), JSON.stringify({ block, hash: lc(hash), at }));

async function blockHeader(rpc, n) {
  const b = await rpc('eth_getBlockByNumber', [hex(n), false]);
  if (!b || !HEX32.test(lc(b.hash)) || Number(b.number) !== n) throw new Error('block header unavailable');
  return { number: n, hash: lc(b.hash) };
}

/** Removes every journaled launch at or after `fromBlock` from its root set (reorg undo). Returns the count. */
async function undoFrom(store, stackId, fromBlock) {
  const jk = K.journal(stackId), min = String(fromBlock * SCORE_MUL);
  let undone = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const rows = await store.zrevrangeByScore(jk, '+inf', min, 500);
    if (!rows.length) break;
    const byRoot = new Map();
    for (const { member } of rows) {
      const i = member.indexOf('|');
      const root = member.slice(0, i), m = member.slice(i + 1);
      if (!isRootKey(root) || !parseMember(m)) continue;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(m);
    }
    for (const [root, ms] of byRoot) undone += await store.zrem(K.root(root), ms);
    await store.zrem(jk, rows.map((r) => r.member));
  }
  return undone;
}

/**
 * One incremental pass for every verified stack. Never scans history: a stack without a cursor (not backfilled yet)
 * is skipped. Per stack: cursor hash integrity (rewind REORG_REWIND blocks on mismatch, undoing journaled launches),
 * confirmation lag, bounded window, per-chunk header fetched BEFORE its logs, batched writes, then the cursor.
 * A failing stack is reported and never stops the others. Returns a per-stack report.
 */
async function runIncremental({ store, rpc, stacks = Origins.PONS_V2_STACKS, now = Date.now, confirmations = CONFIRMATIONS, maxBlocks = MAX_BLOCKS_PER_RUN, deadline, sleep }) {
  const report = [];
  let head = null;
  for (const stack of stacks) {
    const r = { stack: stack.id, status: 'ok', launches: 0, rejected: 0, removed: 0, duplicates: 0, rewound: 0, undone: 0 };
    report.push(r);
    try {
      let cur = await readCursor(store, stack.id);
      if (!cur) { r.status = 'not-backfilled'; continue; }
      if (head === null) head = Number(await rpc('eth_blockNumber', []));
      if (!Number.isSafeInteger(head) || head <= 0) throw new Error('head unavailable');
      const atCursor = await blockHeader(rpc, cur.block);
      if (atCursor.hash !== cur.hash) {
        const back = Math.max(stack.fromBlock - 1, cur.block - REORG_REWIND);
        r.undone = await undoFrom(store, stack.id, back + 1);
        const h = await blockHeader(rpc, back);
        await writeCursor(store, stack.id, back, h.hash, now());
        r.rewound = cur.block - back;
        cur = { block: back, hash: h.hash };
      }
      const safe = head - confirmations;
      if (cur.block >= safe) { r.status = 'current'; r.through = cur.block; continue; }
      const to = Math.min(safe, cur.block + maxBlocks);
      const scan = await scanLogs(rpc, {
        factories: [stack.factory], from: cur.block + 1, to, deadline, sleep, now,
        before: (_from, end) => blockHeader(rpc, end),
        onChunk: async (logs, _from, end, pre) => {
          for (const log of logs) {
            if (log && log.removed !== true && Number(log.blockNumber) === end && lc(log.blockHash) !== pre.hash) throw Object.assign(new Error('reorg while scanning'), { reorg: true });
          }
          const acc = collect(logs, newAcc());
          await writeLaunches(store, acc.launches, { journalFrom: 0 });
          await writeCursor(store, stack.id, end, pre.hash, now());
          r.launches += acc.launches.length; r.rejected += acc.stats.rejected; r.removed += acc.stats.removed; r.duplicates += acc.stats.duplicates;
        },
      });
      r.through = scan.through; r.requests = scan.requests;
      if (scan.through >= 0) await store.zremRangeByScore(K.journal(stack.id), '-inf', '(' + Math.max(0, scan.through - JOURNAL_BLOCKS) * SCORE_MUL);
    } catch (err) {
      r.status = 'failed';
      r.error = String((err && err.message) || err).slice(0, 160);
    }
  }
  return report;
}

// ---------------------------------------------------------------- reads (visitor path: bounded, paginated)
const PAGE_MAX = 50;
const PAGE_DEFAULT = 24;
const STALE_MS = 30 * 60 * 1000;

/** Coverage of every verified stack: [{stack, factory, fromBlock, throughBlock|null, at|null}]. */
async function coverage(store) {
  return Promise.all(Origins.PONS_V2_STACKS.map(async (s) => {
    const c = await readCursor(store, s.id);
    return { stack: s.id, factory: s.factory, fromBlock: s.fromBlock, throughBlock: c ? c.block : null, at: c ? c.at : null };
  }));
}

/** One page of root R's Pons V2 children, newest launch first. `cursor` = the last score of the previous page. */
async function readRootPage(store, root, { cursor = null, limit = PAGE_DEFAULT } = {}) {
  if (!isRootKey(root)) throw new TypeError('invalid root');
  const n = Math.max(1, Math.min(PAGE_MAX, Number(limit) || PAGE_DEFAULT));
  const max = cursor == null ? '+inf' : '(' + cursor;
  const key = K.root(root);
  const [rows, total] = await Promise.all([store.zrevrangeByScore(key, max, '-inf', n + 1), store.zcard(key)]);
  const page = rows.slice(0, n);
  const items = [];
  for (const r of page) {
    const m = parseMember(r.member);
    if (m) items.push({ token: m.token, stack: m.stack, factory: m.factory, launchBlock: blockOfScore(r.score) });
  }
  return { total, items, nextCursor: rows.length > n && page.length ? String(page[page.length - 1].score) : null };
}

// ---------------------------------------------------------------- page-scoped enrichment
// Per-instance cache (never stored): immutable metadata for a day; phase by how final it is.
const META_TTL = 24 * 3600 * 1000;
const PHASE_TTL = [60 * 1000, 5 * 60 * 1000, 24 * 3600 * 1000, 24 * 3600 * 1000];
const CACHE_MAX = 5000;
const cache = new Map();
function cacheGet(token) { const v = cache.get(token); if (v) { cache.delete(token); cache.set(token, v); } return v || null; }
function cachePut(token, v) { cache.delete(token); cache.set(token, v); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

const AGG3 = Core.functionSelector('aggregate3((address,bool,bytes)[])');
const STR_SEL = { name: Chain.SEL.name, symbol: Chain.SEL.symbol, logo: Chain.SEL.logo };
function decodeString(h) {
  try { return h && h !== '0x' ? String(Core.abiDecode(['string'], h)[0] || '') : ''; } catch { return ''; }
}
const cleanName = (v) => Core.sanitizeForDisplay(v, { maxLength: 64 });
const cleanSymbol = (v) => { const s = Core.sanitizeForDisplay(v, { maxLength: 24 }).replace(/^\$/, '').toUpperCase(); return s.length <= 16 ? s : ''; };
const cleanLogo = (v) => { const s = String(v || '').trim(); return /^(https:\/\/|ipfs:\/\/)[^\s"'<>\\`]{1,500}$/.test(s) ? s : ''; };

/** Multicall3.aggregate3 with allowFailure: [{ok, data}] in call order. Throws when the batch itself fails. */
async function multicall(rpc, calls) {
  if (!calls.length) return [];
  const data = AGG3 + Core.abiEncode(['(address,bool,bytes)[]'], [calls.map((c) => [c.to, true, c.data])]).slice(2);
  const res = await Chain.ethCall(rpc, Chain.ROBINHOOD.multicall3, data);
  const out = Core.abiDecode(['(bool,bytes)[]'], res)[0];
  if (!Array.isArray(out) || out.length !== calls.length) throw new Error('multicall reply malformed');
  return out.map(([ok, d]) => ({ ok: ok === true, data: d }));
}

/**
 * Adds {name, symbol, logo, phase, phaseLabel, verified} to page items, in ONE Multicall3 eth_call for everything the
 * cache does not hold. The live factory record must still name the item's root as pairToken (`verified`); a phase is
 * reported only then. Any failure (batch or single token) degrades to contract address + Pons provenance.
 */
async function enrich(rpc, root, items, { now = Date.now } = {}) {
  const t = now();
  const calls = [], plan = [];
  for (const it of items) {
    const c = cacheGet(it.token) || {};
    const needMeta = !(c.metaAt && t - c.metaAt < META_TTL);
    const needPhase = !(c.phaseAt && t - c.phaseAt < (PHASE_TTL[c.phase] || PHASE_TTL[0]) && c.root === root);
    const p = { it, c, idx: {} };
    if (needPhase) { p.idx.rec = calls.length; calls.push(Origins.ponsV2RecordCall(it.token, it.factory)); }
    if (needMeta) for (const k of ['name', 'symbol', 'logo']) { p.idx[k] = calls.length; calls.push({ to: it.token, data: STR_SEL[k] }); }
    plan.push(p);
  }
  let res = null;
  try { res = await multicall(rpc, calls); } catch { res = null; }
  return plan.map(({ it, c, idx }) => {
    const e = { ...c };
    if (res) {
      try {
        if (idx.name !== undefined) {
          e.name = res[idx.name].ok ? cleanName(decodeString(res[idx.name].data)) : '';
          e.symbol = res[idx.symbol].ok ? cleanSymbol(decodeString(res[idx.symbol].data)) : '';
          e.logo = res[idx.logo].ok ? cleanLogo(decodeString(res[idx.logo].data)) : '';
          e.metaAt = t;
        }
        if (idx.rec !== undefined) {
          const rec = res[idx.rec].ok ? Origins.decodePonsV2Record(res[idx.rec].data, it.token, it.factory) : null;
          if (rec && rec.pairToken === (root === Origins.PONS_NATIVE ? Chain.ZERO : root)) { e.phase = rec.phase; e.phaseAt = t; e.root = root; }
          else { e.phase = undefined; e.phaseAt = 0; e.root = undefined; }
        }
      } catch { /* this token degrades to address + provenance */ }
      cachePut(it.token, e);
    }
    const verified = Number.isInteger(e.phase) && e.root === root;
    const ph = verified ? Origins.phaseOf(e.phase) : null;
    return {
      token: it.token, source: 'PONS_V2', factory: it.factory, stack: it.stack, launchBlock: it.launchBlock,
      phase: verified ? e.phase : null, phaseLabel: ph ? 'PONS · ' + ph.label : null,
      name: e.name || '', symbol: e.symbol || '', logo: e.logo || '', verified,
    };
  });
}
function _resetCache() { cache.clear(); }

module.exports = {
  K, SCORE_MUL, CONFIRMATIONS, REORG_REWIND, JOURNAL_BLOCKS, MAX_BLOCKS_PER_RUN, PAGE_MAX, PAGE_DEFAULT, STALE_MS,
  isRootKey, scoreOf, memberOf, parseMember, blockOfScore, collect, newAcc, scanLogs, groupsFor, writeLaunches,
  readCursor, writeCursor, blockHeader, undoFrom, runIncremental, coverage, readRootPage, enrich, multicall, _resetCache,
};
