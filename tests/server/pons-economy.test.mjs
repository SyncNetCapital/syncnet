// PONS V2 discovery server suite: GET /api/pons-economy (bounded pages, enrichment, isolation, size budget), the
// scheduled pons-indexer gate, Economy curation of PONS children (LIVE factory proof only — never the index), and
// PONS V2 root curator routing (existing Project Passport, never the generic manual request). Mock chain = the e2e
// harness (exact Pons V2 ABI, Multicall3). No real network. Run: node tests/server/pons-economy.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { A, chain, resetChain, signDigest, ROOT } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const { flags } = require(path.join(ROOT, 'netlify/lib/flags.js'));
const Origins = require(path.join(ROOT, 'lib/syncnet-origins.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const Economy = require(path.join(ROOT, 'lib/syncnet-economy.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const Index = require(path.join(ROOT, 'netlify/lib/pons-index.js'));
const api = require(path.join(ROOT, 'netlify/functions/pons-economy.js'));
const indexer = require(path.join(ROOT, 'netlify/functions/pons-indexer.js'));
const eco = require(path.join(ROOT, 'netlify/functions/economies.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));
const par = require(path.join(ROOT, 'netlify/functions/par-launches-all.js'));

const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
let ipSeq = 0;
const ev = (method, { query = {}, body = null } = {}) => ({ httpMethod: method, headers: { 'x-nf-client-connection-ip': `203.0.113.${(ipSeq++ % 250) + 1}` }, queryStringParameters: query, body: body == null ? null : JSON.stringify(body) });
const lc = (v) => String(v).toLowerCase();
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const nowSec = () => Math.floor(Date.now() / 1000);
const noLeak = (r) => !/\n\s+at |Error:|ENOTFOUND|stack|\.js:\d|upstash|redis/i.test(r.body);
const rpc = Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { retries: 0 });

const MAP = new Map();
const store = { ...createStore({ map: MAP }), durable: true, kind: 'test-durable' };
const ON = { SYNCNET_PONS_DISCOVERY_ENABLED: 'true', SYNCNET_ECONOMY_CURATION: 'true' };
const OFF = { SYNCNET_ECONOMY_CURATION: 'true' };
const deps = { store, env: ON, rpc };
const PAGE = (query, d = deps) => api._handler(ev('GET', { query }), d);

const USDG = lc(A.USDG), NET = lc(A.NET), SYNC = lc(A.SYNC);
const PONS2 = lc(A.PONS2), PONS2_ETH = lc(A.PONS2_ETH), PONS2_CONTRACT = lc(A.PONS2_CONTRACT), PONS2_PENDING = lc(A.PONS2_PENDING), PONS1 = lc(A.PONS1);
const STACK = Origins.PONS_V2_STACKS[0];
const OPERATOR = lc(A.WALLET), ATTACKER = lc(A.ATTACKER);
let seq = 0;
/** A canonical launch fact exactly as decodePonsV2Launch would produce it (the index only ever stores these). */
const fact = (token, root, block) => ({ token: lc(token), root, stack: STACK.id, factory: STACK.factory, block: block || STACK.fromBlock + 1000 + seq, logIndex: seq++ % 7 });
const synth = (i) => '0x7a2' + i.toString(16).padStart(37, '0');
resetChain();

// ================================================================================ gate: identical to main when OFF
{
  check('flags: PONS discovery is OFF by default', flags({ env: {}, store: { durable: true } }).ponsDiscovery === false);
  check('flags: SYNCNET_PONS_DISCOVERY_ENABLED=true + durable store opens it', flags({ env: ON, store: { durable: true } }).ponsDiscovery === true);
  check('flags: without a durable store it stays closed (fail closed)', flags({ env: ON, store: { durable: false } }).ponsDiscovery === false);
  check('flags: only the exact value "true"', flags({ env: { SYNCNET_PONS_DISCOVERY_ENABLED: '1' }, store: { durable: true } }).ponsDiscovery === false);
  const before = MAP.size;
  const r = await PAGE({ root: USDG }, { ...deps, env: OFF });
  check('OFF: /api/pons-economy answers 404 {enabled:false} and touches nothing', r.statusCode === 404 && J(r).enabled === false && MAP.size === before);
  const ix = await indexer._handler({}, { store, env: OFF, rpc });
  check('OFF: the scheduled indexer does nothing', J(ix).skipped === 'disabled');
  check('GET only', (await api._handler(ev('POST', { body: {} }), deps)).statusCode === 405);
}

// ================================================================================ input validation
{
  for (const [q, why] of [[{}, 'missing root'], [{ root: '0x123' }, 'short root'], [{ root: Chain.ZERO }, 'zero root (native ETH is never served)'], [{ root: 'native' }, 'sentinel root'], [{ root: USDG, limit: 'abc' }, 'non-numeric limit'], [{ root: USDG, limit: '0' }, 'limit 0'], [{ root: USDG, cursor: '-5' }, 'negative cursor'], [{ root: USDG, cursor: '99999999999999999' }, 'unsafe cursor']]) {
    const r = await PAGE(q);
    check('invalid input rejected: ' + why, r.statusCode === 400 && noLeak(r), r.body);
  }
}

// ================================================================================ pages
{
  const r0 = await PAGE({ root: '0x' + '42'.repeat(20) });
  const b0 = J(r0);
  check('0 children: 200, total 0, no items, no cursor', r0.statusCode === 200 && b0.total === 0 && b0.items.length === 0 && b0.nextCursor === null && b0.source === 'PONS_V2' && b0.relationship === 'LAUNCHED_AGAINST');
  check('not indexed yet: stale, indexedThroughBlock null', b0.stale === true && b0.indexedThroughBlock === null);

  await Index.writeLaunches(store, [fact(PONS2, USDG), fact(PONS2_PENDING, USDG), fact(PONS2_CONTRACT, NET), fact(PONS2_ETH, 'native')]);
  await Index.writeCursor(store, STACK.id, STACK.fromBlock + 5000, '0x' + 'ab'.repeat(32), Date.now());
  const r1 = await PAGE({ root: USDG });
  const b1 = J(r1);
  const alpha = b1.items.find((i) => i.token === PONS2);
  check('1 page: both USDG children, newest launch first', r1.statusCode === 200 && b1.total === 2 && b1.items.map((i) => i.token).join() === [PONS2_PENDING, PONS2].join() && b1.nextCursor === null, r1.body);
  check('enrichment: live phase + metadata for the page (PONS · BONDING CURVE, $PALPHA)', alpha && alpha.phase === 0 && alpha.phaseLabel === 'PONS · BONDING CURVE' && alpha.symbol === 'PALPHA' && alpha.name === 'Pons Alpha' && alpha.verified === true && alpha.source === 'PONS_V2' && alpha.factory === STACK.factory, JSON.stringify(alpha));
  check('coverage metadata: indexedThroughBlock + fresh', b1.indexedThroughBlock === STACK.fromBlock + 5000 && b1.stale === false && b1.coverage[0].factory === STACK.factory && b1.coverage[0].fromBlock === STACK.fromBlock);
  const net = J(await PAGE({ root: NET })).items[0];
  check('phase 1 is PONS · CURVE CLOSED · POOL PENDING (never "graduated")', net.phaseLabel === 'PONS · CURVE CLOSED · POOL PENDING', JSON.stringify(net));
  check('native-ETH launches are indexed but never served (zero root refused, not under WETH)', J(await PAGE({ root: lc(Chain.ROBINHOOD.weth) })).total === 0 && (await PAGE({ root: Chain.ZERO })).statusCode === 400 && (await store.zcard(Index.K.root('native'))) === 1);

  // many children: pagination, hard max 50, no overlap, never silently truncated
  const R = '0x' + '5e'.repeat(20);
  const many = Array.from({ length: 123 }, (_, i) => fact(synth(i), R, STACK.fromBlock + 2000 + i));
  await Index.writeLaunches(store, many);
  const big = J(await PAGE({ root: R, limit: '500' }));
  check('limit is capped at 50', big.items.length === 50 && big.total === 123 && big.nextCursor);
  const def = J(await PAGE({ root: R }));
  check('default page size 24', def.items.length === 24);
  const seen = new Set(); let cur = null, pages = 0;
  do { const b = J(await PAGE(cur ? { root: R, limit: '50', cursor: cur } : { root: R, limit: '50' })); b.items.forEach((i) => seen.add(i.token)); cur = b.nextCursor; pages++; } while (cur && pages < 10);
  check('multiple pages: every child exactly once, 3 pages of 50/50/23', seen.size === 123 && pages === 3);
  check('ordering: launch block descending', big.items[0].launchBlock === STACK.fromBlock + 2122 && big.items[49].launchBlock === STACK.fromBlock + 2073);

  // one broken token never fails the page
  chain.brokenTokens = new Set([PONS2]);
  Index._resetCache();
  const br = await PAGE({ root: USDG });
  const brItem = J(br).items.find((i) => i.token === PONS2), okItem = J(br).items.find((i) => i.token === PONS2_PENDING);
  check('one broken token: page is 200, the broken token degrades to address + PONS provenance', br.statusCode === 200 && brItem && brItem.symbol === '' && brItem.name === '' && brItem.source === 'PONS_V2' && okItem.symbol === 'PPEND', br.body);
  chain.brokenTokens = new Set();
  chain.multicallDown = true; Index._resetCache();
  const md = await PAGE({ root: USDG });
  check('enrichment outage: page still 200 with addresses + PONS provenance, phase unknown', md.statusCode === 200 && J(md).items.length === 2 && J(md).items.every((i) => i.phase === null && i.source === 'PONS_V2'), md.body);
  chain.multicallDown = false; Index._resetCache();

  // a forged / corrupted index entry is never presented as verified
  await Index.writeLaunches(store, [fact(PONS2_CONTRACT, USDG, STACK.fromBlock + 4000)]); // live record says NET, not USDG
  const forged = J(await PAGE({ root: USDG })).items.find((i) => i.token === PONS2_CONTRACT);
  check('index entry contradicted by the live factory record: no phase, verified=false', forged && forged.verified === false && forged.phase === null && forged.phaseLabel === null, JSON.stringify(forged));

  // size budget with adversarial metadata
  const HUGE = '0x' + '6f'.repeat(20);
  const huge = Array.from({ length: 60 }, (_, i) => fact(synth(1000 + i), HUGE, STACK.fromBlock + 3000 + i));
  await Index.writeLaunches(store, huge);
  const r = await PAGE({ root: HUGE, limit: '50' });
  check('response stays under the fixed size budget (64 KiB)', r.statusCode === 200 && Buffer.byteLength(r.body) < api._internals.MAX_BODY_BYTES, String(Buffer.byteLength(r.body)));
}

// ================================================================================ failure isolation from PAR
{
  const broken = new Proxy(store, { get: (t, k) => (String(k).startsWith('z') ? async () => { throw new Error('index down'); } : t[k]) });
  const r = await PAGE({ root: USDG }, { ...deps, store: broken });
  check('index read failure: 503 with a fixed, leak-free message', r.statusCode === 503 && /temporarily unavailable/.test(J(r).error) && noLeak(r), r.body);
  par._resetCache();
  const p = await par._handler(ev('GET'), { store: { ...createStore({ map: new Map() }), durable: true } });
  check('PAR history endpoint is unaffected by a PONS failure (separate function, no PONS dependency)', p.statusCode === 200 && Array.isArray(J(p).launches));
  const src = require('node:fs').readFileSync(path.join(ROOT, 'netlify/functions/par-launches-all.js'), 'utf8');
  check('par-launches-all has no PONS code path', !/\bpons|pons-index|pons2:/i.test(src));
}

// ================================================================================ scheduled indexer (ON)
{
  const s2 = { ...createStore({ map: new Map() }), durable: true };
  const r = J(await indexer._handler({}, { store: s2, env: ON, rpc }));
  check('indexer ON without a backfilled cursor: never scans history', r.report && r.report[0].status === 'not-backfilled');
  await s2.set(Index.K.lock, 'x', { ttlSeconds: 55 });
  check('indexer: an overlapping run is skipped (store lock)', J(await indexer._handler({}, { store: s2, env: ON, rpc })).skipped === 'running');
}

// ================================================================================ Economy curation of PONS children
const grants = { curators: [{ root: USDG, curator: OPERATOR, since: '2026-01-01T00:00:00Z' }, { root: NET, curator: OPERATOR, since: '2026-01-01T00:00:00Z' }] };
const ECO = (body, env = ON) => eco._handler(ev('POST', { body }), { store, env, rpc, grants });
const curation = (fields) => { const m = { root: USDG, child: PONS2, curator: OPERATOR, decision: 'recognize', issuedAt: nowSec(), nonce: rnd(), ...fields }; return { action: 'curate', ...m, signature: signDigest(m.curator, Economy.digest('EconomyCuration', m)) }; };
{
  let r = await ECO(curation({}), OFF);
  check('OFF: a PONS child cannot be recognized (behaviour identical to main: PAR-only)', r.statusCode === 422 && J(r).code === 'not_connected', r.body);
  r = await ECO(curation({}));
  check('ON: PONS child recognized when the LIVE canonical factory proves pairToken == root', r.statusCode === 200 && J(r).recognized === true, r.body);
  r = await ECO(curation({ root: NET }));
  check('ON: same PONS child under a different root is refused (live pairToken != root)', r.statusCode === 422, r.body);
  // Forged index record: PONS2_CONTRACT is indexed under USDG above, but its live record says NET.
  r = await ECO(curation({ child: PONS2_CONTRACT }));
  check('ON: a forged/corrupted discovery index record cannot authorize recognition', r.statusCode === 422 && J(r).code === 'not_connected', r.body);
  r = await ECO(curation({ root: NET, child: PONS2_CONTRACT }));
  check('ON: …while the true root (live record) can recognize it', r.statusCode === 200, r.body);
  r = await ECO(curation({ child: PONS2_ETH }));
  check('ON: a native-ETH PONS launch can never be recognized under an address root', r.statusCode === 422, r.body);
  r = await ECO(curation({ child: PONS1 }));
  check('ON: PONS V1 child is not accepted (V1 out of scope)', r.statusCode === 422, r.body);
  const seenKeys = [];
  const spy = new Proxy(store, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { seenKeys.push(String(a[0])); return t[k](...a); } : t[k]) });
  r = await eco._handler(ev('POST', { body: curation({ child: PONS2_PENDING }) }), { store: spy, env: ON, rpc, grants });
  check('ON: recognition never reads the discovery index (pons2:*)', r.statusCode === 200 && !seenKeys.some((k) => k.startsWith('pons2:')), seenKeys.join(','));
  chain.rpcDown = true;
  r = await ECO(curation({ child: synth(77) }));
  chain.rpcDown = false;
  check('ON: chain unreadable during the relationship check -> 503 (fail closed)', r.statusCode === 503, r.body);
  // Index outage / wipe does not invalidate stored recognitions.
  for (const k of [...MAP.keys()]) if (k.startsWith('pons2:')) MAP.delete(k);
  const view = J(await eco._handler(ev('GET', { query: { view: 'economy', root: USDG } }), { store, env: ON, rpc, grants }));
  check('stored recognitions survive a PONS index outage / wipe', view.recognized.map((e) => e.child).includes(PONS2), JSON.stringify(view.recognized));
  // PAR path unchanged
  const parChild = lc(A.SYNCAT);
  r = await eco._handler(ev('POST', { body: curation({ root: SYNC, child: parChild }) }), { store, env: ON, rpc, grants: { curators: [{ root: SYNC, curator: OPERATOR, since: '2026-01-01T00:00:00Z' }] } });
  check('PAR child recognition unchanged with PONS ON', r.statusCode === 200, r.body);
}

// ================================================================================ PONS V2 root curator routing
{
  const req = (root, env = ON) => { const m = { root, claimant: ATTACKER, evidenceUrl: 'https://example.org/proof', issuedAt: nowSec(), nonce: rnd() }; return eco._handler(ev('POST', { body: { action: 'claim-request', ...m, signature: signDigest(ATTACKER, Economy.digest('EconomyClaimRequest', m)) } }), { store, env, rpc, grants: { curators: [] } }); };
  let r = await req(PONS2_PENDING);
  check('ON: a PONS V2 root without a Passport is sent to the Project Passport claim (409 use_passport_claim), not the manual request', r.statusCode === 409 && J(r).code === 'use_passport_claim' && /PONS V2/.test(J(r).error), r.body);
  r = await req(PONS2_PENDING, OFF);
  check('OFF: claim-request behaviour for a PONS V2 root is unchanged from main', !(r.statusCode === 409 && J(r).code === 'use_passport_claim'), r.body);
  r = await req(PONS1);
  check('ON: PONS V1 root behaviour unchanged (not routed to the Passport claim)', J(r).code !== 'use_passport_claim', r.body);
  chain.rpcDown = true; r = await req(PONS2_PENDING); chain.rpcDown = false;
  check('ON: chain unreadable while classifying a root -> 503', r.statusCode === 503, r.body);
  // PONS V2 root WITH a Passport: its operator is the curator through the existing mp:passport:v1 mechanism.
  const m = { token: PONS2, operator: OPERATOR, basis: 'deployer', nonce: rnd(), expiry: nowSec() + 600 };
  const c = await mp._handler(ev('POST', { body: { action: 'claim', ...m, signature: signDigest(OPERATOR, Market.digest('OperatorClaim', m)) } }), { store, env: {} });
  check('existing Marketplace claim of a PONS V2 Passport still works', c.statusCode === 200, c.body);
  const view = J(await eco._handler(ev('GET', { query: { view: 'economy', root: PONS2 } }), { store, env: ON, rpc, grants: { curators: [] } }));
  check('PONS V2 root with a Passport: curator = Passport operator (source passport), nothing new added', view.curator && view.curator.address === OPERATOR && view.curator.source === 'passport', JSON.stringify(view));
  r = await req(PONS2);
  check('PONS V2 root with a Passport: claim-request refused (has_curator)', r.statusCode === 409 && J(r).code === 'has_curator', r.body);
}

console.log(`\n${results.length - failures}/${results.length} pons economy server checks passed`);
process.exit(failures ? 1 : 0);
