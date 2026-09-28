// PONS V2 discovery · decoding, adaptive scanning, reorg handling, sorted-set storage (memory + Upstash REST emulation).
// No real network: stub JSON-RPC and the harness Upstash emulation (upstash.mock). Run: node tests/unit/pons-discovery.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT, serverState } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; console.log('FAIL', name, String(detail).slice(0, 300)); } else console.log('ok  ', name); }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);

const Origins = require(path.join(ROOT, 'lib/syncnet-origins.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const Index = require(path.join(ROOT, 'netlify/lib/pons-index.js'));
const Store = require(path.join(ROOT, 'netlify/lib/store.js'));
const Backfill = require(path.join(ROOT, 'netlify/scripts/pons-backfill.js'));

const F = Origins.PONS_V2_FACTORY, TOPIC = Origins.PONS_V2_TOKEN_LAUNCHED, ZERO = Chain.ZERO;
const STACK = Origins.PONS_V2_STACKS[0];
const USDG = Chain.ROBINHOOD.usdg, WETH = Chain.ROBINHOOD.weth;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const addr = (i, p = 'a') => '0x' + p.repeat(32) + (i >>> 0).toString(16).padStart(8, '0');
const H = (n, fork = '') => '0x' + (fork ? fork.repeat(8) : '') + n.toString(16).padStart(fork ? 56 : 64, '0');
function logFor({ token, pair = USDG, block, logIndex = 0, tx, address = F, removed, topic = TOPIC, hash, cfg = 1, thr = 10n ** 20n }) {
  return { address, topics: [topic, pad(token), pad(addr(block, 'c')), pad(addr(7, 'd'))], data: '0x' + pad(pair).slice(2) + word(cfg) + word(thr),
    blockNumber: '0x' + block.toString(16), blockHash: hash || H(block), transactionHash: tx || H(block * 1000 + logIndex, 'e'), logIndex: '0x' + logIndex.toString(16), ...(removed === undefined ? {} : { removed }) };
}
/** Stub RPC over a list of logs: result-count and range limits, 429s, per-block hashes. */
function stubChain({ logs = [], head = STACK.fromBlock + 100000, limit = 10000, maxRange = Infinity, rate = 0, fork = null } = {}) {
  const st = { getLogs: 0, calls: [], rate };
  const hashOf = (n) => (fork && n >= fork.from ? H(n, fork.tag) : H(n));
  const rpc = async (method, params) => {
    st.calls.push(method);
    if (method === 'eth_blockNumber') return '0x' + st.head.toString(16);
    if (method === 'eth_getBlockByNumber') { const n = Number(params[0]); return n > st.head ? null : { number: '0x' + n.toString(16), hash: hashOf(n) }; }
    if (method === 'eth_getLogs') {
      st.getLogs++;
      if (st.rate > 0) { st.rate--; throw Object.assign(new Error('Too Many Requests'), { code: 429 }); }
      const q = params[0], from = Number(q.fromBlock), to = Number(q.toBlock);
      if (st.failFactory && q.address.includes(st.failFactory)) throw new Error('upstream failure');
      if (to - from + 1 > maxRange) throw new Error('block range too large');
      const out = st.logs.filter((l) => { const b = Number(l.blockNumber); return b >= from && b <= to && q.address.map((x) => x.toLowerCase()).includes(l.address.toLowerCase()) && l.topics[0] === q.topics[0]; });
      if (out.length > limit) throw new Error('logs matched by query exceeds limit of ' + limit);
      return out;
    }
    throw new Error('unexpected ' + method);
  };
  st.head = head; st.logs = logs;
  return { rpc, st };
}
const noSleep = async () => {};
const mem = () => Store.createStore({ env: {} });
const upstash = () => serverState.upstash.clear() || Store.createStore({ env: { UPSTASH_REDIS_REST_URL: 'https://upstash.mock', UPSTASH_REDIS_REST_TOKEN: 't' } });

// ================================================================= decoding
{
  const T = addr(1), B = STACK.fromBlock + 10;
  const d = Origins.decodePonsV2Launch(logFor({ token: T, block: B, logIndex: 3, cfg: 7, thr: 5n }));
  check('canonical TokenLaunched decodes with every preserved fact', d && d.token === T && d.pairToken === USDG && d.root === USDG && d.curve === addr(B, 'c') && d.deployer === addr(7, 'd')
    && d.launchConfigId === '7' && d.graduationThreshold === '5' && d.block === B && d.logIndex === 3 && d.factory === F && d.stack === STACK.id && /^0x[0-9a-f]{64}$/.test(d.blockHash) && /^0x[0-9a-f]{64}$/.test(d.txHash), JSON.stringify(d));
  check('event from a non-canonical emitter (same topic/layout) is ignored', Origins.decodePonsV2Launch(logFor({ token: T, block: B, address: addr(9, 'f') })) === null);
  check('event emitted by the token itself (self-claim) is ignored', Origins.decodePonsV2Launch(logFor({ token: T, block: B, address: T })) === null);
  check('wrong topic is ignored', Origins.decodePonsV2Launch(logFor({ token: T, block: B, topic: '0x' + '11'.repeat(32) })) === null);
  check('removed log is ignored', Origins.decodePonsV2Launch(logFor({ token: T, block: B, removed: true })) === null);
  const bad = logFor({ token: T, block: B }); bad.data = bad.data.slice(0, 130);
  check('malformed data layout is ignored', Origins.decodePonsV2Launch(bad) === null);
  const dirty = logFor({ token: T, block: B }); dirty.data = '0x' + 'ff'.repeat(12) + dirty.data.slice(26);
  check('pairToken word with non-zero high bytes is ignored (never truncated into an address)', Origins.decodePonsV2Launch(dirty) === null);
  const n = Origins.decodePonsV2Launch(logFor({ token: T, block: B, pair: ZERO }));
  check('zero pairToken maps to the native sentinel, never WETH', n && n.native === true && n.root === Origins.PONS_NATIVE && n.root !== WETH.toLowerCase() && n.pairToken === ZERO);
  check('native sentinel is not an address (cannot become /project/0x000…)', !Chain.isAddr(Origins.PONS_NATIVE));
}

// ================================================================= collect: dedupe, removed, bad logs
{
  const B = STACK.fromBlock + 20;
  const good = logFor({ token: addr(2), block: B, logIndex: 0 });
  const acc = Index.collect([good, good, { ...good }, logFor({ token: addr(3), block: B, logIndex: 1, removed: true }), logFor({ token: addr(4), block: B, logIndex: 2, address: addr(5, 'f') }), null, 42, { topics: 'x' }, logFor({ token: addr(6), block: B, logIndex: 3 })], Index.newAcc());
  check('duplicate txHash+logIndex collected once', acc.launches.filter((l) => l.token === addr(2)).length === 1 && acc.stats.duplicates === 2);
  check('removed / wrong-factory / garbage logs counted, never thrown', acc.stats.removed === 1 && acc.stats.rejected === 4 && acc.launches.length === 2, JSON.stringify(acc.stats));
}

// ================================================================= adaptive getLogs
{
  const logs = [];
  for (let i = 0; i < 60; i++) logs.push(logFor({ token: addr(100 + i), block: STACK.fromBlock + 1 + i * 37, logIndex: i % 3 }));
  const { rpc, st } = stubChain({ logs, limit: 7, maxRange: 500, rate: 2 });
  const acc = Index.newAcc();
  const scan = await Index.scanLogs(rpc, { factories: [F], from: STACK.fromBlock, to: STACK.fromBlock + 3000, chunk: 100000, sleep: noSleep, onChunk: async (l) => Index.collect(l, acc) });
  check('adaptive scan: range / result-limit / 429 errors shrink the window and every launch is still found', acc.launches.length === 60 && scan.through === STACK.fromBlock + 3000 && scan.shrinks > 0, JSON.stringify({ n: acc.launches.length, scan }));
  check('adaptive scan counts its requests', scan.requests === st.getLogs && st.getLogs > 1);
  const { rpc: dead } = stubChain({ logs, limit: 0 });
  const acc2 = Index.newAcc();
  let threw = false; try { await Index.scanLogs(dead, { factories: [F], from: STACK.fromBlock, to: STACK.fromBlock + 3000, sleep: noSleep, onChunk: async (l) => Index.collect(l, acc2) }); } catch { threw = true; }
  check('a single block that keeps failing throws (never silently skipped)', threw);
}

// ================================================================= storage primitives
for (const [label, mk] of [['memory', mem], ['upstash', upstash]]) {
  const s = mk();
  serverState.zcommands = [];
  const pairs = Array.from({ length: 2500 }, (_, i) => [i * 10, 'm' + String(i).padStart(5, '0')]);
  const w = await s.zaddMany([['z:a', pairs], ['z:b', [[5, 'x']]], ['z:c', []]]);
  check(`${label}: zaddMany batches (2500 members = 3 ZADD commands, 1 request)`, w.added === 2501 && w.commands === 4 && w.requests === 1, JSON.stringify(w));
  const again = await s.zaddMany([['z:a', pairs.slice(0, 10)]]);
  check(`${label}: re-adding the same members is idempotent`, again.added === 0 && (await s.zcard('z:a')) === 2500);
  const top = await s.zrevrangeByScore('z:a', '+inf', '-inf', 3);
  check(`${label}: zrevrangeByScore is score-descending and bounded`, top.map((r) => r.score).join() === '24990,24980,24970');
  const next = await s.zrevrangeByScore('z:a', '(24970', '-inf', 2);
  check(`${label}: exclusive upper bound paginates exactly`, next.map((r) => r.member).join() === 'm02496,m02495');
  let threw = false; try { await s.zrevrangeByScore('z:a', '+inf', '-inf', 5000); } catch { threw = true; }
  check(`${label}: a range larger than ${Store.ZRANGE_MAX} is refused (no unbounded reads)`, threw);
  threw = false; try { await s.zaddMany([['z:a', [[-1, 'neg']]]]); } catch { threw = true; }
  check(`${label}: negative / non-integer scores refused`, threw);
  check(`${label}: zrem + zremRangeByScore`, (await s.zrem('z:a', ['m00000', 'nope'])) === 1 && (await s.zremRangeByScore('z:a', '-inf', '(100')) === 9 && (await s.zcard('z:a')) === 2490);
  if (label === 'upstash') {
    const many = await s.zaddMany(Array.from({ length: 150 }, (_, i) => ['k:' + i, [[1, 'a']]]));
    check('upstash: 150 keys = 150 commands in 2 pipeline requests (PIPELINE_MAX 100)', many.commands === 150 && many.requests === 2, JSON.stringify(many));
    const big = Array.from({ length: 30 }, (_, k) => ['root:' + k, Array.from({ length: 1000 }, (_, i) => [74000000000000 + i, 'v2a:0x' + String(k).padStart(4, '0') + String(i).padStart(36, '0')])]);
    const plan = Store.zaddPlan(big);
    const sizes = plan.requests.map((idx) => Buffer.byteLength(JSON.stringify(idx.map((i) => plan.commands[i]))));
    const wb = await s.zaddMany(big);
    check('upstash: pipelines are also bounded by body size (<= 512 KiB each), same plan as the estimate', wb.commands === 30 && wb.requests === plan.requests.length && plan.requests.length > 1 && sizes.every((b) => b <= Store.PIPELINE_MAX_BYTES), JSON.stringify({ wb, sizes }));
  }
}

// ================================================================= index writes, roots, ordering, pages
{
  const s = upstash();
  const B = STACK.fromBlock + 1000;
  const launches = Index.collect([
    logFor({ token: addr(10), block: B, logIndex: 0 }), logFor({ token: addr(11), block: B, logIndex: 5 }), logFor({ token: addr(12), block: B + 1, logIndex: 0 }),
    logFor({ token: addr(13), block: B + 2, logIndex: 0, pair: addr(1, 'b') }), logFor({ token: addr(14), block: B + 3, logIndex: 1, pair: ZERO }),
  ], Index.newAcc()).launches;
  const w = await Index.writeLaunches(s, launches);
  check('pairToken becomes the Economy root key (one ZADD per root)', w.commands === 3 && (await s.zcard(Index.K.root(USDG))) === 3 && (await s.zcard(Index.K.root(addr(1, 'b')))) === 1, JSON.stringify(w));
  check('multiple roots stay separate', (await Index.readRootPage(s, addr(1, 'b'))).items.map((i) => i.token).join() === addr(13));
  check('native pair indexed under the sentinel only, never under WETH or 0x0', (await s.zcard(Index.K.root('native'))) === 1 && (await s.zcard(Index.K.root(WETH.toLowerCase()))) === 0 && (await s.zcard(Index.K.root(ZERO))) === 0);
  const p = await Index.readRootPage(s, USDG, { limit: 2 });
  check('deterministic order: launch block desc, then logIndex desc', p.items.map((i) => i.token).join() === [addr(12), addr(11)].join() && p.items[0].launchBlock === B + 1 && p.total === 3 && p.nextCursor);
  const p2 = await Index.readRootPage(s, USDG, { limit: 2, cursor: p.nextCursor });
  check('second page continues exactly, no overlap, then ends', p2.items.map((i) => i.token).join() === addr(10) && p2.nextCursor === null);
  check('members are compact immutable identity (stack:token), attributable to their factory', p.items.every((i) => i.factory === F && i.stack === STACK.id));
  await Index.writeLaunches(s, launches);
  check('re-writing the same launches is idempotent', (await s.zcard(Index.K.root(USDG))) === 3);
}
{
  const s = mem();
  const logs = [];
  for (let i = 0; i < 5000; i++) logs.push(logFor({ token: addr(20000 + i), block: STACK.fromBlock + 1 + Math.floor(i / 3), logIndex: i % 3 }));
  await Index.writeLaunches(s, Index.collect(logs, Index.newAcc()).launches);
  const calls = [];
  const spy = new Proxy(s, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { calls.push([k, a]); return t[k](...a); } : t[k]) });
  const page = await Index.readRootPage(spy, USDG, { limit: 500 });
  check('large root (5000): a page is capped at 50 and reads only ZREVRANGEBYSCORE LIMIT 51 + ZCARD', page.items.length === 50 && page.total === 5000 && calls.every(([k]) => k === 'zrevrangeByScore' || k === 'zcard') && calls.find(([k]) => k === 'zrevrangeByScore')[1][3] === 51, JSON.stringify(calls.map((c) => c[0])));
  check('large root: SMEMBERS is never used', !calls.some(([k]) => k === 'smembers'));
  let seen = new Set(), cur = null, pages = 0;
  do { const pg = await Index.readRootPage(s, USDG, { limit: 50, cursor: cur }); pg.items.forEach((i) => seen.add(i.token)); cur = pg.nextCursor; pages++; } while (cur && pages < 200);
  check('walking every page yields all 5000 exactly once (no silent truncation)', seen.size === 5000 && pages === 100);
}

// ================================================================= incremental indexer: cursor, lag, reorg, isolation
{
  const s = upstash();
  const base = STACK.fromBlock + 5000;
  const { rpc, st } = stubChain({ head: base + 1000, logs: [logFor({ token: addr(30), block: base + 10 })] });
  let rep = await Index.runIncremental({ store: s, rpc, sleep: noSleep });
  check('no cursor (not backfilled): the indexer never scans history', rep[0].status === 'not-backfilled' && st.getLogs === 0);
  await Index.writeCursor(s, STACK.id, base, H(base), Date.now());
  st.logs.push(logFor({ token: addr(31), block: base + 1000 - 5 })); // inside the confirmation lag
  rep = await Index.runIncremental({ store: s, rpc, sleep: noSleep });
  const cur = await Index.readCursor(s, STACK.id);
  check('incremental run indexes confirmed blocks and advances the cursor to head - CONFIRMATIONS', rep[0].status === 'ok' && rep[0].launches === 1 && cur.block === base + 1000 - Index.CONFIRMATIONS && cur.hash === H(cur.block), JSON.stringify(rep));
  check('confirmation lag: a launch in the last CONFIRMATIONS blocks is not indexed yet', !(await Index.readRootPage(s, USDG)).items.some((i) => i.token === addr(31)));
  rep = await Index.runIncremental({ store: s, rpc, sleep: noSleep });
  check('re-run with nothing new is idempotent', rep[0].status === 'current' && (await s.zcard(Index.K.root(USDG))) === 1, JSON.stringify(rep) + ' ' + (await s.zcard(Index.K.root(USDG))));
  // Reorg: blocks >= base + 900 get new hashes; the launch at base+950 disappears, a new one appears at base+960.
  st.logs.push(logFor({ token: addr(32), block: base + 950 }));
  st.head = base + 1100;
  await Index.runIncremental({ store: s, rpc, sleep: noSleep });
  check('before reorg: the launch at base+950 is indexed', (await Index.readRootPage(s, USDG)).items.some((i) => i.token === addr(32)));
  const { rpc: rpc2, st: st2 } = stubChain({ head: base + 1100, fork: { from: base + 900, tag: 'f' }, logs: [logFor({ token: addr(30), block: base + 10 }), logFor({ token: addr(33), block: base + 960, hash: H(base + 960, 'f') })] });
  rep = await Index.runIncremental({ store: s, rpc: rpc2, sleep: noSleep });
  const after = (await Index.readRootPage(s, USDG)).items.map((i) => i.token);
  check('reorg: cursor hash mismatch rewinds, undoes the orphaned launch and indexes the new chain', rep[0].rewound > 0 && rep[0].undone >= 1 && !after.includes(addr(32)) && after.includes(addr(33)) && after.includes(addr(30)), JSON.stringify({ rep, after }));
  check('reorg: the cursor now carries the new chain hash', (await Index.readCursor(s, STACK.id)).hash === H((await Index.readCursor(s, STACK.id)).block, 'f'));
  check('reorg: getLogs used for the rescan only', st2.getLogs >= 1);
  // Isolation: a failing stack does not stop another stack.
  const bogus = { id: 'zz', factory: addr(99, 'f'), fromBlock: STACK.fromBlock };
  await Index.writeCursor(s, 'zz', base, H(base), Date.now());
  const { rpc: rpc3, st: st3 } = stubChain({ head: base + 3000, fork: { from: base + 900, tag: 'f' } });
  st3.failFactory = bogus.factory;
  rep = await Index.runIncremental({ store: s, rpc: rpc3, stacks: [bogus, STACK], sleep: noSleep });
  check('one failing stack is reported and the other still advances', rep[0].status === 'failed' && rep[1].status === 'ok', JSON.stringify(rep));
}

// ================================================================= backfill (dry-run default)
{
  check('backfill: dry-run is the default (no --write)', Backfill.parseArgs([]).write === false);
  let threw = false; try { Backfill.parseArgs(['--write', '--dry-run']); } catch { threw = true; }
  check('backfill: --write and --dry-run are mutually exclusive', threw);
  threw = false; try { await Backfill.main(['--write'], { UPSTASH_REDIS_REST_URL: 'https://prod.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't', SYNCNET_RPC_URL: 'https://rpc.invalid' }); } catch (e) { threw = /confirm-store-host/.test(e.message); }
  check('backfill: --write without --confirm-store-host=<exact host> refuses before any RPC or write', threw);
  const logs = [];
  for (let i = 0; i < 40; i++) logs.push(logFor({ token: addr(40000 + i), block: STACK.fromBlock + 1 + i * 11, logIndex: 0, pair: i % 4 === 0 ? ZERO : i % 4 === 1 ? addr(2, 'b') : USDG }));
  logs.push(logFor({ token: addr(40000), block: STACK.fromBlock + 1, removed: true }));
  const { rpc } = stubChain({ logs, limit: 9 });
  const r = await Backfill.scanStack(rpc, STACK, { to: STACK.fromBlock + 2000, chunk: 500, sleep: noSleep });
  const sum = Backfill.summarize(r.launches, { to: STACK.fromBlock + 2000 });
  check('backfill scan: every launch from the deployment block, removed ignored', r.launches.length === 40 && r.stats.removed === 1);
  check('backfill summary: distinct roots, native count, per-root counts, USDG count', sum.distinctRoots === 3 && sum.nativeEth === 10 && sum.usdg === 20 && sum.topRoots[0].root === USDG.toLowerCase(), JSON.stringify(sum.topRoots));
  check('backfill estimate uses the batched design (one ZADD per root chunk + journal + cursor)', sum.estimate.zaddCommands <= 5 && sum.estimate.httpRequests === 2 && sum.estimate.upstashCommands === sum.estimate.zaddCommands + 1, JSON.stringify(sum.estimate));
}

console.log(`\n${results.length - failures} passed, ${failures} failed`);
console.log(`${results.length - failures}/${results.length} pons discovery checks passed`);
process.exit(failures ? 1 : 0);
