#!/usr/bin/env node
'use strict';
/*
 * PONS V2 historical backfill — OFFLINE, operator-run, DRY-RUN BY DEFAULT. Never run by a visitor or a function.
 *
 *   node netlify/scripts/pons-backfill.js                       # dry run: scan + report, writes nothing
 *   node netlify/scripts/pons-backfill.js --out=/tmp/pons.jsonl # dry run + every decoded launch fact as JSON lines
 *   node netlify/scripts/pons-backfill.js --write --confirm-store-host=<upstash host>
 *                                                               # writes the root index + cursor to the configured
 *                                                               # UPSTASH_REDIS_REST_URL/TOKEN (host must match)
 * Options: --rpc=https://…  (default SYNCNET_RPC_URL or the public Robinhood RPC) · --stack=v2a · --from=N · --to=N
 *          --chunk=N (initial getLogs window) · --top=N (roots in the report) · --json (machine-readable report)
 *
 * Scan: TokenLaunched logs of each verified stack's factory from its verified deployment block to head - CONFIRMATIONS,
 * in adaptive eth_getLogs windows (halved on any range / result-limit / rate-limit error, grown while small). Removed
 * logs are ignored, logs are deduplicated by txHash + logIndex, and only logs whose emitter is the verified factory are
 * decoded (lib/syncnet-origins.js decodePonsV2Launch). Relationships come from the event only — never from tickers.
 * Write: one ZADD per root per 1000 launches, pipelined 100 commands per request (store.js zaddMany), then the cursor.
 */
const Chain = require('../../lib/syncnet-chain.js');
const Origins = require('../../lib/syncnet-origins.js');
const Index = require('../lib/pons-index');
const { createStore, zaddPlan } = require('../lib/store');
const { rpcUrl } = require('../lib/chain-rpc');

const USDG = Chain.ROBINHOOD.usdg;
const REDIS_ZSET_ENTRY_OVERHEAD = 80; // rough bytes per sorted-set entry (skiplist node + dict entry + sds headers)

function parseArgs(argv) {
  const a = { write: false, dryRun: false };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error('Unknown argument: ' + arg);
    const [, k, v] = m;
    if (k === 'write') a.write = true;
    else if (k === 'dry-run') a.dryRun = true;
    else if (k === 'json') a.json = true;
    else if (['rpc', 'stack', 'out', 'confirm-store-host'].includes(k) && v) a[k] = v;
    else if (['from', 'to', 'chunk', 'top'].includes(k) && /^\d+$/.test(v || '')) a[k] = Number(v);
    else throw new Error('Invalid argument: ' + arg);
  }
  if (a.write && a.dryRun) throw new Error('--write and --dry-run are mutually exclusive.');
  return a;
}

/** Counting wrapper: every JSON-RPC request is counted (retries included). */
function countingRpc(url, fetchImpl) {
  const stats = { requests: 0 };
  const inner = Chain.makeRpc(url, { timeoutMs: 30000, retries: 1, fetch: fetchImpl ? (...x) => { stats.requests += 1; return fetchImpl(...x); } : (...x) => { stats.requests += 1; return globalThis.fetch(...x); } });
  const rpc = (m, p) => inner(m, p);
  rpc.stats = stats;
  return rpc;
}

/** Scans one stack; returns {launches, stats, scan, from, to, toHeader}. Writes nothing. */
async function scanStack(rpc, stack, { from, to, chunk, onProgress, sleep } = {}) {
  const acc = Index.newAcc();
  const toHeader = await Index.blockHeader(rpc, to);
  const start = Math.max(stack.fromBlock, from || 0);
  const scan = await Index.scanLogs(rpc, {
    factories: [stack.factory], from: start, to, chunk, sleep,
    onChunk: async (logs, a, b) => { Index.collect(logs, acc); if (onProgress) onProgress(b, acc.launches.length); },
  });
  acc.launches.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
  return { launches: acc.launches, stats: acc.stats, scan, from: start, to, toHeader };
}

/** Storage + command estimate of writing `launches` with the actual batched design (store.js zaddPlan). */
function estimate(launches, to) {
  const groups = Index.groupsFor(launches, { journalFrom: to - Index.JOURNAL_BLOCKS });
  const plan = zaddPlan(groups);
  const rawBytes = groups.reduce((n, [k, pairs]) => n + k.length + pairs.reduce((m, [, mem]) => m + mem.length + 8, 0), 0);
  const entries = groups.reduce((n, [, pairs]) => n + pairs.length, 0);
  return {
    sortedSetEntries: entries,
    zaddCommands: plan.commands.length,
    cursorSets: 1,
    upstashCommands: plan.commands.length + 1,
    httpRequests: plan.requests.length + 1,
    requestBodyBytes: plan.bytes,
    rawBytes,
    approxRedisBytes: rawBytes + entries * REDIS_ZSET_ENTRY_OVERHEAD,
  };
}

function summarize(launches, { to, top = 15 }) {
  const perRoot = new Map();
  for (const l of launches) perRoot.set(l.root, (perRoot.get(l.root) || 0) + 1);
  return {
    launches: launches.length,
    distinctRoots: perRoot.size,
    nativeEth: perRoot.get(Origins.PONS_NATIVE) || 0,
    usdg: perRoot.get(USDG) || 0,
    topRoots: [...perRoot].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top).map(([root, count]) => ({ root, count })),
    perRoot: Object.fromEntries([...perRoot].sort((a, b) => b[1] - a[1])),
    estimate: estimate(launches, to),
    // The native-ETH index is never served in this version; this is what storing only address roots would cost.
    estimateWithoutNative: estimate(launches.filter((l) => !l.native), to),
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const t0 = Date.now();
  const url = args.rpc || rpcUrl(env);
  if (!/^https:\/\//.test(url)) throw new Error('--rpc must be an https URL.');
  const stacks = Origins.PONS_V2_STACKS.filter((s) => !args.stack || s.id === args.stack);
  if (!stacks.length) throw new Error('Unknown stack: ' + args.stack);

  let store = null;
  if (args.write) {
    const target = String(env.UPSTASH_REDIS_REST_URL || env.SYNCNET_UPSTASH_URL || '');
    let host = '';
    try { host = new URL(target).hostname; } catch { host = ''; }
    if (!host) throw new Error('--write needs UPSTASH_REDIS_REST_URL/TOKEN in the environment.');
    if (args['confirm-store-host'] !== host) throw new Error('--write needs --confirm-store-host=' + host + ' (the exact store host) to proceed.');
    store = createStore({ env, timeoutMs: 20000 });
    if (!store.durable) throw new Error('The configured store is not durable.');
  }

  const rpc = countingRpc(url);
  const head = Number(await rpc('eth_blockNumber', []));
  const to = Math.min(args.to || Infinity, head - Index.CONFIRMATIONS);
  const out = args.out ? require('fs').createWriteStream(args.out) : null;
  const report = { mode: args.write ? 'WRITE' : 'DRY-RUN', rpc: url.replace(/\/\/([^/]*@)/, '//'), head, to, stacks: [] };
  let all = [];
  for (const stack of stacks) {
    const code = await Chain.getCode(rpc, stack.factory);
    if (!code || code === '0x') throw new Error('No code at the verified factory ' + stack.factory);
    const r = await scanStack(rpc, stack, {
      from: args.from, to, chunk: args.chunk,
      onProgress: args.json ? null : (b, n) => process.stderr.write(`\r${stack.id} through block ${b} · ${n} launches   `),
    });
    if (!args.json) process.stderr.write('\n');
    if (out) for (const l of r.launches) out.write(JSON.stringify(l) + '\n');
    report.stacks.push({ id: stack.id, factory: stack.factory, fromBlock: r.from, deployBlock: stack.fromBlock, hook: stack.hook, throughBlock: r.to, throughHash: r.toHeader.hash, getLogsRequests: r.scan.requests, windowShrinks: r.scan.shrinks, ...r.stats, launches: r.launches.length });
    all = all.concat(r.launches);
    if (store) {
      const prev = await Index.readCursor(store, stack.id);
      const w = await Index.writeLaunches(store, r.launches, { journalFrom: to - Index.JOURNAL_BLOCKS });
      if (!prev || prev.block < r.to) await Index.writeCursor(store, stack.id, r.to, r.toHeader.hash, Date.now());
      report.stacks[report.stacks.length - 1].written = { ...w, cursorMoved: !prev || prev.block < r.to };
    }
  }
  if (out) await new Promise((r) => out.end(r));
  Object.assign(report, summarize(all, { to, top: args.top || 15 }));
  report.rpcRequests = rpc.stats.requests;
  report.runtimeSeconds = Math.round((Date.now() - t0) / 100) / 10;
  return report;
}

function print(report, json) {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  const { perRoot, ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
}

if (require.main === module) {
  main().then((r) => print(r, process.argv.includes('--json'))).catch((e) => { console.error('pons-backfill: ' + (e && e.message)); process.exit(1); });
}

module.exports = { main, parseArgs, scanStack, summarize, estimate, countingRpc };
