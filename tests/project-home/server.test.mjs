// Project Home server suite: payment intents, verification, ATOMIC activation, finality/reorg, entitlement,
// signed site writes, Passport-transfer behaviour, the public renderer (/site/<token>), the image route and metrics.
// The functions under test are the real code; the chain, wallet keys and store are local fakes. No real network.
// Run: node tests/project-home/server.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  A, ROOT, Core, SYNC, SINK, OTHER_SINK, CONVERTER, TREASURY_FIXTURE, PRICING, ENV, DEPLOYMENT, clock, pc, resetPc, resetChain, pay, reorg, setTags, rpc, signDigest, lc, rnd32, hex, ratePool, resetRatePool,
} from './fixtures.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const Site = require(path.join(ROOT, 'lib/syncnet-site.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const Pricing = require(path.join(ROOT, 'lib/syncnet-project-home-pricing.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const ph = require(path.join(ROOT, 'netlify/functions/project-home.js'));
const siteFn = require(path.join(ROOT, 'netlify/functions/site.js'));
const imgFn = require(path.join(ROOT, 'netlify/functions/site-img.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));

const MAP = new Map();
const base = { ...createStore({ map: MAP, now: () => clock.now() }), durable: true, kind: 'test-durable' };
let storeMode = { failGet: false, failCas: false, beforeCas: null };
const store = {
  ...base,
  async get(k) { if (storeMode.failGet) throw Object.assign(new Error('Upstash down'), { name: 'StoreUnavailable' }); return base.get(k); },
  async cas(spec) {
    if (storeMode.failCas) throw Object.assign(new Error('Upstash down'), { name: 'StoreUnavailable' });
    if (storeMode.beforeCas) { const f = storeMode.beforeCas; storeMode.beforeCas = null; await f(spec); }
    return base.cas(spec);
  },
};
let ipSeq = 0;
const ip = () => `198.51.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
let envNow = { ...ENV };
let pricingNow = PRICING;
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body, headers: r.headers }; };
const api = async (method, body, query, over = {}) => parse(await ph._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: over.env || envNow, rpc: over.rpc || rpc, now: () => clock.now(), pricingFile: over.pricingFile || pricingNow, deploymentFile: over.deploymentFile || DEPLOYMENT, random: over.random }));
const market = async (body) => parse(await mp._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: {}, body: JSON.stringify(body) }, { store, env: {}, rpc }));
const site = async (p, over = {}) => siteFn._handler({ httpMethod: over.method || 'GET', path: p, headers: { 'x-nf-client-connection-ip': ip() } }, { store, env: over.env || envNow });
const nowSec = () => Math.floor(clock.now() / 1000);
const W = lc(A.WALLET), W2 = lc(A.WALLET2), X = lc(A.ATTACKER), SAFE = lc(A.SAFE);
const sig = (kind, message, who) => signDigest(who, Site.digest(kind, message));
const E18 = 10n ** 18n;

// --------------------------------------------------------------------------------------------- fixtures
resetChain(); resetPc();
const T1 = lc(A.CREATORLIVE); // PAR launch, deployer W; has an on-chain website field
const cat = (i) => '0x8' + String(i).repeat(39);
const [T2, T3, T4, T5, T6, T7] = [cat(0), cat(1), cat(2), cat(3), cat(4), cat(5)];
const T8 = lc(A.SYNCAT), T9 = lc(A.PONS2);
function seedPassport(token, operator) {
  MAP.set('mp:passport:v1:' + token, { type: 'string', value: JSON.stringify({ schema: 'syncnet.passport.v1', token, chainId: 4663, launchpad: 'PAR', operator, operatorSince: new Date(clock.now()).toISOString(), claims: [], listing: null, history: [{ type: 'operator-claim', operator }], createdAt: '', updatedAt: '' }), expiresAt: null });
}
for (const t of [T2, T4, T5, T6, T7, T8, T9]) seedPassport(t, W);
seedPassport(T3, SAFE); // contract-wallet operator (EIP-1271)

const request = (token, who = W, over = {}) => {
  const m = { token, operator: who, issuedAt: nowSec(), nonce: rnd32(), termsVersion: Site.TERMS_VERSION, ...over.message };
  const signature = over.signature || signDigest(over.signer || (who === SAFE ? A.SAFE_OWNER : who), over.digest || Site.digest('ActivationRequest', m));
  return api('POST', { action: 'intent', ...m, signature, ...over.extra }, null, over);
};
const verify = (requestId, txHash, over) => api('POST', { action: 'verify', requestId, txHash }, null, over);
const reconcile = (token, over) => api('POST', { action: 'reconcile', token }, null, over);
const status = async (token) => (await api('GET', null, { view: 'status', token })).j;
/** Pay an intent exactly, then make the block SAFE. */
function payIntent(intent, opts = {}) {
  const p = pay({ amount: BigInt(intent.exactTaggedSyncAmount), from: opts.from || W, ...opts });
  if (opts.safe !== false) setTags({ safe: p.blockNumber });
  return p;
}
async function activate(token, who = W) {
  const r = await request(token, who);
  if (r.s !== 201 && r.s !== 200) throw new Error('intent failed ' + r.body);
  const p = payIntent(r.j.intent);
  const v = await verify(r.j.intent.requestId, p.txHash);
  if (v.s !== 200) throw new Error('verify failed ' + v.body);
  return { intent: r.j.intent, tx: p.txHash, v };
}
const goodConfig = (token, over = {}) => Site.normalize({ token, headline: 'The synced home of this project', about: 'A short plain-text description.\n\nSecond paragraph.', socials: { x: 'syncnet', telegram: 'syncnet_chat' }, cta: { label: 'TRADE', url: 'https://app.example.org/trade?t=1' }, ...over }).config;
async function publishCfg(token, config, who = W, over = {}) {
  const configHash = over.configHash || Site.configHash(config);
  const m = { token, operator: who, configHash, issuedAt: over.issuedAt || nowSec(), nonce: over.nonce || rnd32() };
  const signature = over.signature || signDigest(who === SAFE ? A.SAFE_OWNER : who, over.digest || Site.digest('SitePublish', m));
  const body = { action: 'publish', token, operator: who, issuedAt: m.issuedAt, nonce: m.nonce, signature, ...(over.byHash ? { configHash } : { config }) };
  return api('POST', body, null, over);
}
async function unpublishSite(token, who = W, over = {}) {
  const m = { token, operator: who, issuedAt: over.issuedAt || nowSec(), nonce: over.nonce || rnd32() };
  return api('POST', { action: 'unpublish', ...m, signature: signDigest(who, Site.digest('SiteUnpublish', m)) }, null, over);
}

// ============================================================================================ A. gate / config
{
  const c = (await api('GET', null, { view: 'config' })).j;
  check('A01 config: payments open with full configuration', c.enabled === true && c.payments === true);
  check('A02 config: price is $39 USD, version 1', c.price.priceUsdCents === 3900 && c.price.priceUsd === '39.00' && c.price.priceVersion === 1);
  check('A03 config: SYNCNET REFERENCE RATE is automatic (canonical SYNC/USDG market), explicitly not an oracle', c.rate.label === 'SYNCNET REFERENCE RATE' && c.rate.mode === 'automatic' && /PAR SYNC\/USDG market/i.test(c.rate.source) && /not an on-chain oracle/.test(c.rate.note) && !/oracle price/i.test(JSON.stringify(c)) && !('rateVersion' in c.rate));
  check('A04 config: no indicative amount outside a quote, 30-minute lock, 60/40', c.quote === null && c.lockSeconds === 1800 && c.split.burnPercent === 60 && c.split.treasuryPercent === 40);
  check('A05 config: never says OFFICIAL WEBSITE', !/official website/i.test(JSON.stringify(c)));
  const closed = await api('POST', { action: 'intent' }, null, { env: {} });
  check('A06 SYNCNET_PROJECT_HOME_ENABLED unset → every write 503 closed', closed.s === 503 && closed.j.code === 'closed');
  const cfgClosed = (await api('GET', null, { view: 'config' }, { env: {} })).j;
  check('A07 default config view: disabled, payments disabled, no sink', cfgClosed.enabled === false && cfgClosed.payments === false && cfgClosed.sink === null);
  const noSink = await request(T2, W, { env: { ...ENV, PROJECT_HOME_SINK_ADDRESS: '' } });
  check('A08 missing sink address → intent 503 payments_closed', noSink.s === 503 && noSink.j.code === 'payments_closed');
  const payOff = await request(T2, W, { env: { ...ENV, SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: 'false' } });
  check('A09 payments flag off → intent 503', payOff.s === 503 && payOff.j.code === 'payments_closed');
  const noManualRate = (await api('GET', null, { view: 'config' }, { pricingFile: { ...PRICING, rates: [] }, env: (({ PROJECT_HOME_RATE_VERSION, ...e }) => e)(ENV) })).j;
  check('A10 no manual rate file entry and no PROJECT_HOME_RATE_VERSION → payments still open (automatic rate)', noManualRate.payments === true);
  // A13 the automatic rate FAILS CLOSED: no quote, no intent stored, no amount reserved
  for (const [label, mut] of [['RPC read fails', { down: true }], ['pool id ≠ canonical', { badPoolId: true }], ['pool key has hooks (not the reviewed route)', { badKey: true }], ['slot0 tick inconsistent with price', { badTick: true }], ['liquidity below floor', { liquidity: 10n ** 16n }], ['price moved >10 % within ≈2 minutes (volatile)', { lagged: '0.00006' }], ['price outside hard bounds', { usd: '5000000' }]]) {
    Object.assign(ratePool, mut);
    const f = await request(T2, W);
    check('A13 rate source: ' + label + ' → 503 rate_unavailable, no intent', f.s === 503 && f.j.code === 'rate_unavailable' && !MAP.has('site:open:v1:' + T2), f.body);
    resetRatePool();
  }
  const zeroRate = await request(T2, W, { pricingFile: { ...PRICING, rates: [{ ...PRICING.rates[0], syncUsd: '0' }] } });
  check('A11 zero rate in the pricing file → whole table invalid → 503', zeroRate.s === 503);
  const nonDurable = parse(await ph._handler({ httpMethod: 'POST', headers: {}, body: '{"action":"intent"}' }, { store: { ...createStore({ map: new Map() }) }, env: ENV, rpc, pricingFile: PRICING }));
  check('A12 no durable store → closed', nonDurable.s === 503);
}

// ============================================================================================ B. payment intents
let I1;
{
  const nonOp = await request(T1, W2);
  check('B01 non-operator (no Passport for T1 yet) cannot create an intent', nonOp.s === 403 && nonOp.j.code === 'not_operator');
  // Passport for T1 through the REAL Marketplace claim (deployer evidence)
  const cm = { token: T1, operator: W, basis: 'deployer', nonce: rnd32(), expiry: nowSec() + 600 };
  const claimed = parse(await mp._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: {}, body: JSON.stringify({ action: 'claim', ...cm, signature: signDigest(W, Market.digest('OperatorClaim', cm)) }) }, { store, env: {}, rpc }));
  check('B02 fixture: Marketplace claim establishes W as T1 operator', claimed.s === 200 && claimed.j.passport.operator === W, claimed.body);
  const wrongOp = await request(T1, W2);
  check('B03 a different wallet is refused (only the CURRENT operator)', wrongOp.s === 403);
  const head = pc.head;
  const r = await request(T1, W);
  I1 = r.j.intent;
  check('B04 operator creates an intent (201)', r.s === 201 && I1 && I1.status === 'OPEN', r.body);
  check('B05 intent records price $39 / v1 and the AUTOMATIC rate 0.00005 with its source (chain, market 1, pool id, block, time)', I1.priceUsdCents === 3900 && I1.priceVersion === 1 && I1.syncUsdReferenceRate === '0.00005' && I1.rateVersion === 'AUTO' && I1.rateEffectiveAt === I1.rateSource.derivedAt && I1.rateSource.chainId === 4663 && I1.rateSource.market === 1 && I1.rateSource.route === 'SYNC/USDG direct' && I1.rateSource.poolId === '0xeaff358aa176be51e27a562f77ba12265490af09813ff1f71a3f8d796cb13792' && I1.rateSource.block === head.toString() && Boolean(I1.rateSource.blockTimestamp));
  check('B06 base amount = exactly 780,000 SYNC (18 decimals)', I1.baseSyncAmount === (780000n * E18).toString());
  const ex = BigInt(I1.exactTaggedSyncAmount), bs = BigInt(I1.baseSyncAmount);
  check('B07 tagged amount > base, difference < 2e-6 SYNC, tag in the low 12 decimals', ex > bs && ex - bs < 2n * 10n ** 12n && ex % 10n ** 12n !== 0n);
  check('B08 intent binds chain 4663, canonical SYNC, configured sink, operatorAtRequest', I1.chainId === 4663 && I1.canonicalSync === SYNC && I1.sink === SINK && I1.operatorAtRequest === W);
  check('B09 rate locked for 30 minutes; createdBlock = chain head', Date.parse(I1.expiresAt) - Date.parse(I1.createdAt) <= 1800 * 1000 && Date.parse(I1.expiresAt) - Date.parse(I1.createdAt) > 1799 * 1000 && I1.createdBlock === head.toString());
  check('B10 intent is displayable (exact 18-decimal string) and states 60/40 and non-refundable', I1.exactTaggedSyncDisplay.startsWith('780000.000000') && /COMMITTED TO BURN/.test(I1.split.note) && /Non-refundable/.test(I1.refund));
  const again = await request(T1, W);
  check('B11 a second request while the first is open returns the SAME intent (no second amount)', again.s === 200 && again.j.reused === true && again.j.intent.requestId === I1.requestId && again.j.intent.exactTaggedSyncAmount === I1.exactTaggedSyncAmount);
  for (const [k, v] of [['priceUsdCents', 1], ['priceVersion', 9], ['syncUsdReferenceRate', '1'], ['rate', '1'], ['rateVersion', 2], ['baseSyncAmount', '1'], ['exactTaggedSyncAmount', '1'], ['amount', '1'], ['sink', X], ['chainId', 1], ['tag', '1'], ['canonicalSync', X], ['facts', {}], ['paymentToken', X]]) {
    const o = await request(T2, W, { extra: { [k]: v } });
    check('B12 client cannot supply/override ' + k + ' (400)', o.s === 400 && /Unexpected field/.test(o.j.error), o.body);
  }
  const badSig = await request(T2, W, { signer: A.ATTACKER });
  check('B13 signature by another wallet → 401', badSig.s === 401);
  const mMsg = { token: T2, operator: W, issuedAt: nowSec(), nonce: rnd32(), termsVersion: Site.TERMS_VERSION };
  const mktDigest = Core.hashTypedData({ ...Site.typedData('ActivationRequest', mMsg), domain: { ...Market.DOMAIN } });
  const cross = await request(T2, W, { message: mMsg, digest: mktDigest });
  check('B14 same struct signed in the Marketplace domain → 401 (no cross-domain replay)', cross.s === 401);
  const mMsg2 = { token: T2, operator: W, issuedAt: nowSec(), nonce: rnd32(), termsVersion: Site.TERMS_VERSION };
  const wrongChain = await request(T2, W, { message: mMsg2, digest: Core.hashTypedData({ ...Site.typedData('ActivationRequest', mMsg2), domain: { name: 'SyncNet Website', version: '1', chainId: 1 } }) });
  check('B15 wrong EIP-712 chainId → 401', wrongChain.s === 401);
  const skew = await request(T2, W, { message: { issuedAt: nowSec() - 1000 } });
  check('B16 issuedAt outside ±300 s → 400', skew.s === 400 && /issuedAt/.test(skew.j.error));
  const safeOp = await request(T3, SAFE);
  check('B17 EIP-1271 contract-wallet operator (Safe) can request', safeOp.s === 201, safeOp.body);
  const unsupported = await request(lc(A.RANDOM_CONTRACT), W);
  check('B18 not a supported launch → 403/422, never an intent', unsupported.s === 422 || unsupported.s === 403);
  // nonce replay: consume nonce on T4, let the intent expire, re-sign with the same nonce
  const N = rnd32();
  const first = await request(T4, W, { message: { nonce: N } });
  clock.advance(1900);
  const replay = await request(T4, W, { message: { nonce: N } });
  check('B19 nonce reuse → 409 replay', first.s === 201 && replay.s === 409 && replay.j.code === 'replay', replay.body);
  const fresh = await request(T4, W);
  check('B20 after expiry a NEW intent (new amount, new lock) can be created', fresh.s === 201 && fresh.j.intent.requestId !== first.j.intent.requestId);
}

// ---- rate / price versions
{
  const oldI = I1;
  ratePool.usd = '0.0005'; // SYNC ×10 on the canonical market
  const jumped = await request(T5, W);
  check('B20 a >25 % one-step rise vs the accepted reference (<1 h old) → 503 rate_unavailable (manipulation guard)', jumped.s === 503 && jumped.j.code === 'rate_unavailable');
  const refRow = JSON.parse(MAP.get('site:rateref:v1').value);
  check('B20b the accepted reference is the last accepted rate (0.00005), not the rejected one', refRow.rateUsdE18 === (5n * 10n ** 13n).toString());
  MAP.delete('site:rateref:v1'); // the reference ages out (1 h) — a real repricing is then accepted
  const v2 = await request(T5, W);
  check('B21 new intent after a real market move: automatic rate 0.0005 → 78,000 SYNC base', v2.s === 201 && v2.j.intent.baseSyncAmount === (78000n * E18).toString() && v2.j.intent.rateVersion === 'AUTO' && v2.j.intent.syncUsdReferenceRate === '0.0005');
  const keep = (await api('GET', null, { view: 'intent', id: oldI.requestId })).j.intent;
  check('B22 an existing intent keeps its locked rate and exact amount after the market moves', keep.syncUsdReferenceRate === '0.00005' && keep.exactTaggedSyncAmount === oldI.exactTaggedSyncAmount);
  ratePool.down = true;
  const reuse = await request(T5, W);
  check('B22b rate source down: an existing OPEN intent is still served unchanged (no new rate read needed)', reuse.s === 200 && reuse.j.reused === true && reuse.j.intent.requestId === v2.j.intent.requestId);
  resetRatePool(); // back to 0.00005 (a fall is always accepted: more SYNC is charged, never less)
  const p2 = await request(T6, W, { env: { ...ENV, PROJECT_HOME_PRICE_VERSION: '2', PROJECT_HOME_PRICE_USD_CENTS: '4500' } });
  check('B23 product price version 2 ($45, test fixture) is recorded on the intent', p2.s === 201 && p2.j.intent.priceUsdCents === 4500 && p2.j.intent.priceVersion === 2 && p2.j.intent.baseSyncAmount === (900000n * E18).toString());
  const envNoRate = (await api('GET', null, { view: 'config' }, { env: { ...ENV, PROJECT_HOME_RATE_VERSION: '99' } })).j;
  check('B24 PROJECT_HOME_RATE_VERSION is obsolete: an unknown value no longer closes payments', envNoRate.payments === true);
  check('B25 no manual rate snapshot keys are written any more', ![...MAP.keys()].some((k) => k.startsWith('site:rate:v1:')));
  const priceConflict = await request(T7, W, { pricingFile: { ...PRICING, prices: [{ priceVersion: 1, priceUsdCents: 100 }] }, env: { ...ENV, PROJECT_HOME_PRICE_USD_CENTS: '100' } });
  check('B26 priceVersion 1 reused with a different price → fail closed', priceConflict.s === 503);
  // tag collision: force the same tag twice for two intents with the same base
  const tagA = [0, 0, 0, 0, 42], tagB = [0, 0, 0, 0, 43];
  const seq = [tagA, tagA, tagB];
  const random = (n) => (n === 5 ? new Uint8Array(seq.shift() || tagB) : crypto.randomBytes(n));
  const a = await request(T7, W, { random });
  const b = await request(T8, W, { random });
  check('B27 an exact amount is never issued twice while reserved (collision → new tag)', a.s === 201 && b.s === 201 && a.j.intent.exactTaggedSyncAmount !== b.j.intent.exactTaggedSyncAmount && BigInt(b.j.intent.exactTaggedSyncAmount) % 10n ** 12n === 44n, a.body + b.body);
}

// ============================================================================================ C. verification
let ACT1;
{
  const nf = await verify(rnd32(), rnd32());
  check('C01 unknown requestId → 404', nf.s === 404);
  const bad = await verify('0x1234', rnd32());
  check('C02 malformed requestId → 400', bad.s === 400);
  const notMined = await verify(I1.requestId, rnd32());
  check('C03 unknown tx → 202 NOT_MINED (lock judged by block time)', notMined.s === 202 && notMined.j.status === 'NOT_MINED');
  const amt = BigInt(I1.exactTaggedSyncAmount);
  const failed = pay({ amount: amt, status: '0x0' }); setTags({ safe: failed.blockNumber });
  check('C04 failed transaction → 409 tx_failed', (await verify(I1.requestId, failed.txHash)).j.code === 'tx_failed');
  const wrongToken = pay({ amount: amt, token: A.FAKESYNC }); setTags({ safe: wrongToken.blockNumber });
  check('C05 Transfer emitted by a non-canonical token → 409', (await verify(I1.requestId, wrongToken.txHash)).j.code === 'no_matching_payment');
  const wrongSink = pay({ amount: amt, to: OTHER_SINK }); setTags({ safe: wrongSink.blockNumber });
  check('C06 transfer to another address → 409', (await verify(I1.requestId, wrongSink.txHash)).j.code === 'no_matching_payment');
  for (const [label, a] of [['exact - 1', amt - 1n], ['exact + 1', amt + 1n], ['base amount (untagged)', BigInt(I1.baseSyncAmount)]]) {
    const w = pay({ amount: a }); setTags({ safe: w.blockNumber });
    check('C07 wrong amount (' + label + ') → 409', (await verify(I1.requestId, w.txHash)).j.code === 'no_matching_payment');
  }
  const fakeTxHash = rnd32();
  const fake = pay({ amount: amt, txHash: fakeTxHash, logs: [
    { address: SYNC, topics: [Core.keccak256Utf8('Transfer(address,address,uint256)'), '0x' + '0'.repeat(24) + W.slice(2), '0x' + '0'.repeat(24) + SINK.slice(2), '0x' + amt.toString(16).padStart(64, '0')], data: '0x', logIndex: '0x0', transactionHash: fakeTxHash },
    { address: SYNC, topics: [Core.keccak256Utf8('Approval(address,address,uint256)'), '0x' + '0'.repeat(24) + W.slice(2), '0x' + '0'.repeat(24) + SINK.slice(2)], data: '0x' + amt.toString(16).padStart(64, '0'), logIndex: '0x1', transactionHash: fakeTxHash },
    { address: SYNC, topics: [Core.keccak256Utf8('Transfer(address,address,uint256)'), '0x' + '0'.repeat(24) + W.slice(2), '0x' + '0'.repeat(24) + SINK.slice(2)], data: '0x' + amt.toString(16).padStart(64, '0'), logIndex: '0x2', transactionHash: fakeTxHash, removed: true },
  ] });
  setTags({ safe: fake.blockNumber });
  check('C08 fake Transfer shapes (ERC-721 layout, Approval topic, removed log) → 409', (await verify(I1.requestId, fake.txHash)).j.code === 'no_matching_payment');
  const early = pay({ amount: amt, blockNumber: BigInt(I1.createdBlock) }); setTags({ safe: early.blockNumber });
  check('C09 payment mined at/before the intent block → 409 mined_before_intent', (await verify(I1.requestId, early.txHash)).j.code === 'mined_before_intent');
  // wrong chain
  const good = pay({ amount: amt, from: W2, timestamp: BigInt(Math.floor(Date.parse(I1.createdAt) / 1000) + 60) });
  pc.chainHex = '0x1';
  const wc = await verify(I1.requestId, good.txHash);
  check('C10 RPC on the wrong chain → 503, nothing changed', wc.s === 503 && !MAP.has('site:entitlement:v1:' + T1));
  pc.chainHex = '0x1237';
  // not yet SAFE
  setTags({ safe: good.blockNumber - 1n });
  const pending = await verify(I1.requestId, good.txHash);
  check('C11 mined but not SAFE → 202 PENDING_CONFIRMATION, no entitlement', pending.s === 202 && pending.j.status === 'PENDING_CONFIRMATION' && !MAP.has('site:entitlement:v1:' + T1));
  check('C12 the observed payment is recorded on the intent (recovery hint)', (await api('GET', null, { view: 'intent', id: I1.requestId })).j.intent.observed.txHash === good.txHash);
  // RPC outage + 429 (bounded)
  pc.mode = 'down';
  const down = await verify(I1.requestId, good.txHash);
  check('C13 RPC outage → 503, no state change', down.s === 503 && !MAP.has('site:entitlement:v1:' + T1));
  pc.mode = 'ok';
  pc.fail429 = 1000; const before = pc.calls;
  const limited = await verify(I1.requestId, good.txHash);
  check('C14 persistent 429 → 503 within a bounded number of RPC calls', limited.s === 503 && pc.calls - before <= 8, pc.calls - before);
  pc.fail429 = 0;
  let fetches = 0;
  const r429 = Chain.makeRpc('https://rpc.mainnet.chain.robinhood.com/', { retries: 2, fetch: async () => { fetches++; return new Response('Too Many Requests', { status: 429 }); } });
  const viaHttp = await verify(I1.requestId, good.txHash, { rpc: r429 });
  check('C15 real RPC client: 429 retried at most 2 times with backoff, then fail closed', viaHttp.s === 503 && fetches === 3, fetches);
  // SAFE → ACTIVE (a gift: payer W2 is not the operator)
  setTags({ safe: good.blockNumber, finalized: good.blockNumber - 50n });
  clock.advance(7200); // verified 2 h later — long after the 30-minute lock — but MINED inside it
  const ok = await verify(I1.requestId, good.txHash);
  ACT1 = ok.j.entitlement;
  check('C16 payment mined inside the lock but verified 2 h later → ACTIVE', ok.s === 200 && ok.j.status === 'ACTIVE', ok.body);
  check('C17 entitlement: kind paid, payer = gifting wallet, operatorAtActivation = history only', ACT1.kind === 'paid' && ACT1.payer === W2 && ACT1.operatorAtActivation === W && ACT1.token === T1);
  check('C18 entitlement records tx, logIndex, block number/hash, sink, SYNC, amounts, price/rate versions, requestId, safeAt', ACT1.txHash === good.txHash && ACT1.logIndex === 0 && ACT1.blockNumber === good.blockNumber.toString() && /^0x[0-9a-f]{64}$/.test(ACT1.blockHash) && ACT1.sink === SINK && ACT1.canonicalSync === SYNC && ACT1.exactAmount === I1.exactTaggedSyncAmount && ACT1.baseSyncAmount === I1.baseSyncAmount && ACT1.priceUsdCents === 3900 && ACT1.priceVersion === 1 && ACT1.syncUsdReferenceRate === '0.00005' && ACT1.rateVersion === 'AUTO' && ACT1.rateSource && ACT1.rateSource.poolId === '0xeaff358aa176be51e27a562f77ba12265490af09813ff1f71a3f8d796cb13792' && ACT1.requestId === I1.requestId && ACT1.safeAt && ACT1.finalizedAt === null);
  const reg = (await api('GET', null, { view: 'activations' })).j.activations;
  check('C19 activation registry has the record (token, requestId, tx, logIndex, amount, price/rate versions, block)', reg.length === 1 && reg[0].token === T1 && reg[0].requestId === I1.requestId && reg[0].txHash === good.txHash && reg[0].amount === I1.exactTaggedSyncAmount && reg[0].priceVersion === 1 && reg[0].rateVersion === 'AUTO' && Boolean(reg[0].rateSource && reg[0].rateSource.block) && reg[0].blockHash === ACT1.blockHash);
  check('C20 intent is CONSUMED and the log is claimed by this request', (await api('GET', null, { view: 'intent', id: I1.requestId })).j.intent.status === 'CONSUMED' && MAP.get(`site:paylog:v1:${good.txHash}:0`).value === I1.requestId);
  const idem = await verify(I1.requestId, good.txHash);
  check('C21 re-verifying the same payment is idempotent', idem.s === 200 && idem.j.idempotent === true);
  const dupIntent = await request(T1, W);
  check('C22 an activated project never gets a second intent', dupIntent.s === 409 && dupIntent.j.code === 'already_active');
  const passport = (await status(T1)).passport;
  check('C23 the payer gains no Passport authority (operator is still W)', passport.operator === W);
  globalThis.__goodTx = good.txHash;
}

// ---- same payment for a second project; duplicate activation; expiry edges
{
  // Force T7's open intent to carry T1's exact amount (as if a tag collision had slipped through): the claim still holds.
  const t7 = (await request(T7, W)).j.intent;
  const raw = JSON.parse(MAP.get('site:intent:v1:' + t7.requestId).value);
  raw.exactTaggedSyncAmount = I1.exactTaggedSyncAmount; raw.createdBlock = '1'; raw.createdAtSec = 1; raw.expiresAtSec = nowSec() + 10 ** 6;
  MAP.set('site:intent:v1:' + t7.requestId, { type: 'string', value: JSON.stringify(raw), expiresAt: null });
  const reuse = await verify(t7.requestId, globalThis.__goodTx);
  check('C24 one payment can never activate a second project (409 payment_already_used)', reuse.s === 409 && reuse.j.code === 'payment_already_used' && !MAP.has('site:entitlement:v1:' + T7));
  // late payment: mined after the lock
  const late = await request(T9, W);
  const lp = pay({ amount: BigInt(late.j.intent.exactTaggedSyncAmount), timestamp: BigInt(Math.floor(Date.parse(late.j.intent.expiresAt) / 1000) + 1) });
  setTags({ safe: lp.blockNumber });
  const lv = await verify(late.j.intent.requestId, lp.txHash);
  check('C25 payment mined 1 s after the lock expired → 409 mined_after_expiry, not consumed', lv.s === 409 && lv.j.code === 'mined_after_expiry' && !MAP.has(`site:paylog:v1:${lp.txHash}:0`) && !MAP.has('site:entitlement:v1:' + T9));
  const edge = pay({ amount: BigInt(late.j.intent.exactTaggedSyncAmount), timestamp: BigInt(Math.floor(Date.parse(late.j.intent.expiresAt) / 1000)) });
  setTags({ safe: edge.blockNumber });
  const ev = await verify(late.j.intent.requestId, edge.txHash);
  check('C26 payment mined exactly at the lock boundary → ACTIVE', ev.s === 200, ev.body);
  // duplicate project activation: two intents for T2 (first expired), both paid in time
  const i1 = (await request(T2, W)).j.intent;
  const p1 = pay({ amount: BigInt(i1.exactTaggedSyncAmount), timestamp: BigInt(i1.expiresAtSec || Math.floor(Date.parse(i1.expiresAt) / 1000)) - 5n });
  clock.advance(1900);
  const i2 = (await request(T2, W)).j.intent;
  check('C27 fixture: second intent for T2 after the first expired', i2 && i2.requestId !== i1.requestId);
  const p2 = pay({ amount: BigInt(i2.exactTaggedSyncAmount) });
  setTags({ safe: p2.blockNumber });
  const a2 = await verify(i2.requestId, p2.txHash);
  const a1 = await verify(i1.requestId, p1.txHash);
  check('C28 duplicate project activation refused: second payment not consumed', a2.s === 200 && a1.s === 409 && a1.j.code === 'already_active' && !MAP.has(`site:paylog:v1:${p1.txHash}:0`));
}

// ---- concurrency: identical verifications, and a race of two projects over one payment
{
  const i = (await request(T4, W)).j.intent; // T4 has an open intent from B20
  const p = payIntent(i);
  const many = await Promise.all(Array.from({ length: 12 }, () => verify(i.requestId, p.txHash)));
  const created = many.filter((r) => r.s === 200 && r.j.idempotent === false).length;
  check('C29 12 concurrent verifications of one payment: exactly one activation, all 200', created === 1 && many.every((r) => r.s === 200), many.map((r) => r.s + ':' + r.j.idempotent).join(','));
  check('C30 exactly one registry record for that payment', (await api('GET', null, { view: 'activations' })).j.activations.filter((a) => a.txHash === p.txHash).length === 1);
  // race: T5 and T6 intents share one exact amount (forced); one tx; concurrent verification of both
  const i5 = (await request(T5, W)).j.intent, i6 = (await request(T6, W)).j.intent;
  const amount = BigInt(i5.exactTaggedSyncAmount);
  for (const x of [i6]) { const r = JSON.parse(MAP.get('site:intent:v1:' + x.requestId).value); r.exactTaggedSyncAmount = amount.toString(); MAP.set('site:intent:v1:' + x.requestId, { type: 'string', value: JSON.stringify(r), expiresAt: null }); }
  const shared = pay({ amount });
  setTags({ safe: shared.blockNumber });
  const [r5, r6] = await Promise.all([verify(i5.requestId, shared.txHash), verify(i6.requestId, shared.txHash)]);
  const winners = [r5, r6].filter((r) => r.s === 200).length;
  check('C31 two projects racing for one payment: exactly one wins, the other 409 payment_already_used', winners === 1 && [r5, r6].some((r) => r.j.code === 'payment_already_used'), r5.body + ' | ' + r6.body);
  check('C32 only one of the two projects is entitled', [MAP.has('site:entitlement:v1:' + T5), MAP.has('site:entitlement:v1:' + T6)].filter(Boolean).length === 1);
  // store failure at the commit: nothing is written, and the payment stays verifiable (not lost)
  const i7 = JSON.parse(MAP.get('site:intent:v1:' + (await request(T7, W)).j.intent.requestId).value);
  i7.exactTaggedSyncAmount = (BigInt(i7.baseSyncAmount) + 777n).toString(); i7.createdBlock = pc.head.toString(); i7.createdAtSec = nowSec(); i7.expiresAtSec = nowSec() + 1800; i7.expiresAt = new Date((nowSec() + 1800) * 1000).toISOString(); i7.status = 'OPEN';
  MAP.set('site:intent:v1:' + i7.requestId, { type: 'string', value: JSON.stringify(i7), expiresAt: null });
  const p7 = pay({ amount: BigInt(i7.exactTaggedSyncAmount) }); setTags({ safe: p7.blockNumber });
  storeMode.failCas = true;
  const crash = await verify(i7.requestId, p7.txHash);
  storeMode.failCas = false;
  check('C33 durable store fails at the atomic commit → 503 and NO partial state', crash.s === 503 && !MAP.has('site:entitlement:v1:' + T7) && !MAP.has(`site:paylog:v1:${p7.txHash}:0`) && !MAP.has(`site:act:v1:${p7.txHash}:0`) && JSON.parse(MAP.get('site:intent:v1:' + i7.requestId).value).status === 'OPEN');
  const recovered = await verify(i7.requestId, p7.txHash);
  check('C34 retry after the crash activates (a valid payment is never lost)', recovered.s === 200 && recovered.j.status === 'ACTIVE');
  storeMode.failGet = true;
  const sDown = await verify(i7.requestId, p7.txHash);
  storeMode.failGet = false;
  check('C35 store read failure → 503', sDown.s === 503);
}

// ---- browser crash / reconciliation, finality, reorg
{
  await request(T3, SAFE); // (the earlier T3 quote expired while the clock moved on)
  const st = await status(T3);
  check('C36 after a browser crash the open intent (requestId, exact amount) is recoverable from status', st.openIntent && st.openIntent.requestId && st.intents.includes(st.openIntent.requestId));
  const p = payIntent(st.openIntent, { from: A.SAFE });
  const v = await verify(st.openIntent.requestId, p.txHash);
  check('C37 … and verifies later', v.s === 200 && v.j.status === 'ACTIVE');
  // finality
  const e = JSON.parse(MAP.get('site:entitlement:v1:' + T3).value);
  const r0 = await reconcile(T3);
  check('C38 reconcile before finality: unchanged ACTIVE', r0.s === 200 && r0.j.changed === false && r0.j.status === 'ACTIVE');
  setTags({ finalized: BigInt(e.blockNumber) });
  const r1 = await reconcile(T3);
  check('C39 reconcile once finalized → FINALIZED with finalizedAt', r1.j.status === 'FINALIZED' && r1.j.entitlement.finalizedAt);
  pc.mode = 'down';
  check('C40 reconcile with RPC down → 503, no change', (await reconcile(T1)).s === 503 && JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).status === 'ACTIVE');
  pc.mode = 'ok';
  const e1b = JSON.parse(MAP.get('site:entitlement:v1:' + T1).value);
  const savedHead = pc.head; pc.head = BigInt(e1b.blockNumber) - 1n;
  const lag = await reconcile(T1);
  pc.head = savedHead;
  check('C40b lagging RPC node that does not know the block → 503, never an invalidation', lag.s === 503 && JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).status === 'ACTIVE');
  let flip = 0;
  const flappy = async (method, params) => (method === 'eth_getBlockByNumber' && /^0x/.test(params[0]) && BigInt(params[0]) === BigInt(e1b.blockNumber) ? { number: params[0], hash: Core.keccak256Utf8('flap' + (flip++)), timestamp: '0x1' } : rpc(method, params));
  const fl = await reconcile(T1, { rpc: flappy });
  check('C40c two reads of the block disagree → 503, no invalidation', fl.s === 503 && JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).status === 'ACTIVE');
  // reorg of T1's SAFE payment
  const e1 = JSON.parse(MAP.get('site:entitlement:v1:' + T1).value);
  reorg(e1.blockNumber);
  const rr = await reconcile(T1);
  check('C41 SAFE payment removed by a reorg → INVALIDATED_BY_REORG (history kept)', rr.s === 200 && rr.j.status === 'INVALIDATED_BY_REORG' && MAP.has(`site:act:v1:${e1.txHash}:0`) && MAP.get(`site:paylog:v1:${e1.txHash}:0`).value === e1.requestId);
  const audit = [...MAP.get('site:audit:v1:' + T1).value].map((x) => JSON.parse(x).type);
  check('C42 audit trail has activated + invalidated-by-reorg', audit.includes('activated') && audit.includes('invalidated-by-reorg'));
  const pub = await publishCfg(T1, goodConfig(T1));
  check('C43 paid publication disabled while invalidated (409)', pub.s === 409 && pub.j.code === 'entitlement_invalidated');
  // re-inclusion of the same tx later: the SAME request re-activates, no second payment
  reorg(e1.blockNumber); // no receipt at old height anymore; now re-include
  const tx = e1.txHash;
  const r = { transactionHash: tx, status: '0x1', blockNumber: hex(pc.head + 3n), blockHash: Core.keccak256Utf8('re|' + tx), logs: [{ address: SYNC, topics: [Core.keccak256Utf8('Transfer(address,address,uint256)'), '0x' + '0'.repeat(24) + W2.slice(2), '0x' + '0'.repeat(24) + SINK.slice(2)], data: '0x' + BigInt(e1.exactAmount).toString(16).padStart(64, '0'), logIndex: '0x0', transactionHash: tx }] };
  const n = pc.head + 3n; pc.head = n;
  pc.blocks.set(n, { number: n, hash: r.blockHash, timestamp: BigInt(e1.blockTimestamp) + 3n });
  pc.receipts.set(tx, r); setTags({ safe: n });
  const re = await verify(e1.requestId, tx);
  check('C44 the re-included payment re-activates the same request (previous entitlement recorded)', re.s === 200 && re.j.entitlement.status === 'ACTIVE' && re.j.entitlement.previous && re.j.entitlement.previous.txHash === tx, re.body);
}

// ---- an observed (not yet SAFE) payment blocks new quotes, but not forever
{
  const T10 = lc(A.PONS2_ETH); seedPassport(T10, W);
  const iq = (await request(T10, W)).j.intent;
  const pp = pay({ amount: BigInt(iq.exactTaggedSyncAmount) }); setTags({ safe: pp.blockNumber - 1n });
  const pend = await verify(iq.requestId, pp.txHash);
  clock.advance(1900);
  const blocked = await request(T10, W);
  check('C45 a payment awaiting SAFE blocks a second quote for the project (duplicate-payment guard)', pend.j.status === 'PENDING_CONFIRMATION' && blocked.s === 409 && blocked.j.code === 'payment_pending', blocked.body);
  clock.advance(6 * 3600);
  const unblocked = await request(T10, W);
  check('C46 …for a bounded time only (a payment that never confirms cannot lock the project forever)', unblocked.s === 201, unblocked.body);
  setTags({ safe: pp.blockNumber });
  const late = await verify(iq.requestId, pp.txHash);
  check('C47 the original payment (mined inside its lock) still activates once SAFE', late.s === 200 && late.j.status === 'ACTIVE', late.body);
}

// ---- re-inclusion after a reorg, in a block later than the lock
{
  const T10 = lc(A.PONS2_ETH);
  const e = JSON.parse(MAP.get('site:entitlement:v1:' + T10).value);
  reorg(e.blockNumber);
  const inv = await reconcile(T10);
  const it = JSON.parse(MAP.get('site:intent:v1:' + e.requestId).value);
  const lateTs = BigInt(it.expiresAtSec) + 600n;
  const other = pay({ amount: BigInt(it.exactTaggedSyncAmount), timestamp: lateTs }); setTags({ safe: other.blockNumber });
  const otherV = await verify(e.requestId, other.txHash);
  check('C48 after a reorg, a DIFFERENT late payment still cannot use the expired lock', inv.j.status === 'INVALIDATED_BY_REORG' && otherV.s === 409 && otherV.j.code === 'mined_after_expiry', otherV.body);
  const tx = e.txHash, n = pc.head + 2n, h = Core.keccak256Utf8('reinc|' + tx);
  pc.blocks.set(n, { number: n, hash: h, timestamp: lateTs + 5n }); pc.head = n;
  pc.receipts.set(tx, { transactionHash: tx, status: '0x1', blockNumber: hex(n), blockHash: h, logs: [{ address: SYNC, topics: [Core.keccak256Utf8('Transfer(address,address,uint256)'), '0x' + '0'.repeat(24) + W.slice(2), '0x' + '0'.repeat(24) + SINK.slice(2)], data: '0x' + BigInt(e.exactAmount).toString(16).padStart(64, '0'), logIndex: '0x0', transactionHash: tx }] });
  setTags({ safe: n });
  const re = await verify(e.requestId, tx);
  check('C49 the SAME transaction re-included after the lock re-activates (it was broadcast in time)', re.s === 200 && re.j.status === 'ACTIVE' && re.j.entitlement.previous.txHash === tx, re.body);
}

// ============================================================================================ D. site writes + renderer
{
  const noEnt = await publishCfg(T8, goodConfig(T8));
  check('D01 publish without an activation → 402 activation_required', noEnt.s === 402 && noEnt.j.code === 'activation_required');
  const bad = await api('POST', { action: 'publish', token: T1, operator: W, issuedAt: nowSec(), nonce: rnd32(), signature: '0x' + '1'.repeat(130), config: { ...goodConfig(T1), html: '<script>' } });
  check('D02 unknown/forbidden config fields (html) → 400 invalid_config', bad.s === 400 && bad.j.code === 'invalid_config');
  const nonCanon = await api('POST', { action: 'publish', token: T1, operator: W, issuedAt: nowSec(), nonce: rnd32(), signature: '0x' + '1'.repeat(130), config: { ...goodConfig(T1), preset: 'dark' } });
  check('D03 non-canonical config → 400', nonCanon.s === 400);
  const cfg = goodConfig(T1);
  const byPayer = await publishCfg(T1, cfg, W2);
  check('D04 the payer (gift) cannot publish (403 not_operator)', byPayer.s === 403);
  const byX = await publishCfg(T1, cfg, X);
  check('D05 a random wallet cannot publish', byX.s === 403);
  const withImg = goodConfig(T1, { logoCid: 'b' + 'a'.repeat(58) });
  const unsan = await publishCfg(T1, withImg);
  check('D06 image CID that never passed the sanitizer → 422', unsan.s === 422 && unsan.j.code === 'image_not_sanitised');
  const imgBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  MAP.set('site:img:v1:' + withImg.logoCid, { type: 'string', value: JSON.stringify({ sha256: crypto.createHash('sha256').update(imgBytes).digest('hex'), type: 'image/png', width: 1, height: 1, bytes: imgBytes.length }), expiresAt: null });
  const p1 = await publishCfg(T1, withImg);
  check('D07 current operator + active entitlement + sanitised image → published', p1.s === 200 && p1.j.site.state === 'PUBLISHED' && p1.j.url === '/site/' + T1, p1.body);
  const pg = await site('/site/' + T1);
  check('D08 /site/<token> renders 200 with the authority label', pg.statusCode === 200 && pg.body.includes(Site.AUTHORITY_LABEL) && !/official website/i.test(pg.body));
  check('D09 verified facts rendered from the server: name, ticker, contract, origin, Passport', pg.body.includes('Operator Live') && pg.body.includes('$OPLIVE') && pg.body.includes(T1) && pg.body.includes('PAR') && pg.body.includes('Passport operator</dt><dd><code class="addr">' + W) && /paired with \$[A-Z]+ <code class="addr">0x[0-9a-f]{40}<\/code>/.test(pg.body));
  check('D10 on-chain website field shown truthfully, separately and NOT as a link', pg.body.includes('On-chain website field') && pg.body.includes('oplive.example') && !pg.body.includes('href="https://oplive.example'));
  check('D11 operator links clickable for the current operator', pg.body.includes('href="https://app.example.org/trade?t&#61;1"') && pg.body.includes('href="https://x.com/syncnet"'));
  const csp = pg.headers['content-security-policy'];
  check('D12 CSP: default-src none, hashed style only, same-origin images, no scripts/frames/forms', /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/.test(csp) && !/script-src|unsafe/.test(csp), csp);
  const styleHash = "'sha256-" + crypto.createHash('sha256').update(Site.STYLESHEET).digest('base64') + "'";
  check('D13 the inline stylesheet matches the CSP hash exactly', csp.includes(styleHash) && pg.body.includes('<style>' + Site.STYLESHEET + '</style>'));
  check('D14 security headers: nosniff, DENY, no-referrer, no-store', pg.headers['x-content-type-options'] === 'nosniff' && pg.headers['x-frame-options'] === 'DENY' && pg.headers['referrer-policy'] === 'no-referrer' && pg.headers['cache-control'] === 'no-store');
  check('D15 zero JavaScript, no inline style attributes, no event handlers', !/<script|javascript:|\son[a-z]+=|\sstyle=/i.test(pg.body));
  check('D16 image served same-origin through /site-img/<cid>', pg.body.includes('src="/site-img/' + withImg.logoCid + '"'));
  const upper = await site('/site/' + A.SYNCAT);
  check('D17 non-lowercase token → 301 to /site/<lowercase>', /[A-F]/.test(A.SYNCAT) && upper.statusCode === 301 && upper.headers.location === '/site/' + lc(A.SYNCAT));
  check('D18 unpublished / unknown token → 404', (await site('/site/' + T8)).statusCode === 404 && (await site('/site/0x1234')).statusCode === 404 && (await site('/site/' + T1 + '/../x')).statusCode === 404);
  const viaRewrite = await siteFn._handler({ httpMethod: 'GET', path: '/.netlify/functions/site', queryStringParameters: { token: T1 }, headers: {} }, { store, env: envNow });
  check('D18b Netlify rewrite form (/.netlify/functions/site?token=) renders the same page', viaRewrite.statusCode === 200 && viaRewrite.body.includes(Site.AUTHORITY_LABEL));
  const badRewrite = await siteFn._handler({ httpMethod: 'GET', path: '/.netlify/functions/site', queryStringParameters: { token: '<script>' }, headers: {} }, { store, env: envNow });
  check('D18c hostile ?token= → 404, never reflected', badRewrite.statusCode === 404 && !badRewrite.body.includes('<script>'));
  check('D19 kill switch: Project Home disabled → /site is 404', (await site('/site/' + T1, { env: {} })).statusCode === 404);
  check('D20 HEAD works without a body', (await site('/site/' + T1, { method: 'HEAD' })).body === '');
  // images
  const img = await imgFn._handler({ httpMethod: 'GET', path: '/site-img/' + withImg.logoCid, headers: {} }, { store, env: envNow, fetch: async () => new Response(imgBytes, { status: 200, headers: { 'content-type': 'image/png' } }) });
  check('D21 /site-img serves the sanitised bytes (hash-verified) as image/png with a sandbox CSP', img.statusCode === 200 && img.headers['content-type'] === 'image/png' && img.isBase64Encoded && Buffer.from(img.body, 'base64').equals(imgBytes) && /sandbox/.test(img.headers['content-security-policy']));
  const tampered = Buffer.from(imgBytes); tampered[tampered.length - 1] ^= 1;
  const img2 = await imgFn._handler({ httpMethod: 'GET', path: '/site-img/' + withImg.logoCid, headers: {} }, { store, env: envNow, fetch: async () => new Response(tampered, { status: 200 }) });
  check('D22 gateway returns different bytes → 404 (never served)', img2.statusCode === 404);
  const img3 = await imgFn._handler({ httpMethod: 'GET', path: '/site-img/b' + 'c'.repeat(58), headers: {} }, { store, env: envNow, fetch: async () => new Response(imgBytes, { status: 200 }) });
  check('D23 CID not on the sanitizer allowlist → 404', img3.statusCode === 404);
  const img5 = await imgFn._handler({ httpMethod: 'GET', path: '/.netlify/functions/site-img', queryStringParameters: { cid: withImg.logoCid }, headers: {} }, { store, env: envNow, fetch: async () => new Response(imgBytes, { status: 200 }) });
  check('D23b image route works in the Netlify rewrite form (?cid=)', img5.statusCode === 200);
  const img4 = await imgFn._handler({ httpMethod: 'GET', path: '/site-img/' + withImg.logoCid, headers: {} }, { store, env: {}, fetch: async () => new Response(imgBytes, { status: 200 }) });
  check('D24 image route closed when Project Home is disabled', img4.statusCode === 404);
  // nonce reuse, issuedAt regression, cross-domain replay, wrong chain
  const n = rnd32();
  const e1 = await publishCfg(T1, goodConfig(T1, { headline: 'Edit one' }), W, { nonce: n, issuedAt: nowSec() + 1 });
  const e2 = await publishCfg(T1, goodConfig(T1, { headline: 'Edit two' }), W, { nonce: n, issuedAt: nowSec() + 2 });
  check('D25 edits are free; nonce reuse → 409 replay', e1.s === 200 && e2.s === 409 && e2.j.code === 'replay', e1.body + e2.body);
  const reg = await publishCfg(T1, goodConfig(T1, { headline: 'Older' }), W, { issuedAt: nowSec() - 10 });
  check('D26 issuedAt regression (older than the current revision) → 409 stale_issued_at', reg.s === 409 && reg.j.code === 'stale_issued_at');
  const cfgX = goodConfig(T1, { headline: 'Cross domain' });
  const m = { token: T1, operator: W, configHash: Site.configHash(cfgX), issuedAt: nowSec() + 3, nonce: rnd32() };
  const crossDigest = Core.hashTypedData({ ...Site.typedData('SitePublish', m), domain: { ...Market.DOMAIN } });
  check('D27 SitePublish signed in the Marketplace domain → 401', (await publishCfg(T1, cfgX, W, { ...m, digest: crossDigest })).s === 401);
  const chainDigest = Core.hashTypedData({ ...Site.typedData('SitePublish', m), domain: { ...Site.DOMAIN, chainId: 46630 } });
  check('D28 SitePublish for another chainId → 401', (await publishCfg(T1, cfgX, W, { ...m, digest: chainDigest })).s === 401);
  const listingSig = signDigest(W, Market.digest('ListingCancel', { listingId: rnd32(), seller: W, nonce: rnd32() }));
  check('D29 a real Marketplace signature pasted into a site write → 401', (await publishCfg(T1, cfgX, W, { signature: listingSig })).s === 401);
  // unpublish / restore
  const up = await unpublishSite(T1, W, { issuedAt: nowSec() + 5 });
  check('D30 unpublish → tombstone; site 404; entitlement untouched', up.s === 200 && up.j.site.state === 'UNPUBLISHED' && (await site('/site/' + T1)).statusCode === 404 && JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).status === 'ACTIVE');
  const revs = (await api('GET', null, { view: 'revisions', token: T1 })).j.revisions;
  check('D31 revision history survives unpublish', revs.length >= 2);
  const restoreHash = revs[revs.length - 1].configHash;
  const rs = await publishCfg(T1, null, W, { byHash: true, configHash: restoreHash, issuedAt: nowSec() + 6 });
  check('D32 restore an earlier revision by configHash with a NEW signature (no payment)', rs.s === 200 && rs.j.kind === 'restore' && (await site('/site/' + T1)).statusCode === 200, rs.body);
  // EIP-1271 publisher
  const safeCfg = goodConfig(T3);
  const sp = await publishCfg(T3, safeCfg, SAFE);
  check('D33 EIP-1271 contract-wallet operator publishes', sp.s === 200, sp.body);
}

// ============================================================================================ E. Passport transfer
{
  // Sell T1's Passport W -> W2 through the real Marketplace (two signatures).
  const sg = (k, mm, a) => signDigest(a, Market.digest(k, mm));
  const exp = (s) => nowSec() + s;
  const t = Market.normalizeTerms({ description: 'Operational control of this project, fee right NOT included.', included: [], notIncluded: [], includeFeeRight: false }).terms;
  const lm = { token: T1, seller: W, price: '1', currency: 'USD', termsHash: Market.hashJson(t), nonce: rnd32(), expiry: exp(86400) };
  const L = await market({ action: 'list', ...lm, terms: t, signature: sg('Listing', lm, W) });
  const om = { listingId: L.j.listing.id, termsHash: L.j.listing.termsHash, token: T1, buyer: W2, amount: '1', currency: 'USD', nonce: rnd32(), expiry: exp(86400) };
  const O = await market({ action: 'offer', ...om, signature: sg('Offer', om, W2) });
  const dm = { offerId: O.j.offer.id, listingId: L.j.listing.id, seller: W, decision: 'accept', nonce: rnd32() };
  const D = await market({ action: 'offer-decision', ...dm, signature: sg('OfferDecision', dm, W) });
  const im = { dealId: D.j.deal.id, token: T1, from: W, to: W2, nonce: rnd32(), expiry: exp(3600) };
  await market({ action: 'transfer-intent', ...im, signature: sg('TransferIntent', im, W) });
  const am = { dealId: D.j.deal.id, token: T1, from: W, to: W2, intentHash: Market.digest('TransferIntent', im), nonce: rnd32(), expiry: exp(3600) };
  const acc = await market({ action: 'transfer-accept', ...am, signature: sg('TransferAccept', am, W2) });
  check('E01 fixture: Passport of T1 transferred W → W2 via the Marketplace', acc.s === 200 && acc.j.passport.operator === W2, acc.body);
  const pg = await site('/site/' + T1);
  check('E02 site stays up, labelled PUBLISHED BY PREVIOUS OPERATOR · AWAITING CONFIRMATION', pg.statusCode === 200 && pg.body.includes(Site.PREVIOUS_LABEL) && !pg.body.includes(Site.AUTHORITY_LABEL));
  check('E03 every operator-authored external link is NON-CLICKABLE (no href at all)', !/href=/.test(pg.body) && pg.body.includes('every operator link disabled until the current Passport operator adopts this site'));
  check('E04 text and verified facts remain visible; new operator shown; page noindex', pg.body.includes('Operator Live') && pg.body.includes('Passport operator</dt><dd><code class="addr">' + W2) && pg.body.includes('Awaiting confirmation') && pg.body.includes('noindex'));
  check('E05 entitlement survives the transfer unchanged (no second payment)', JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).status === 'ACTIVE');
  const old1 = await publishCfg(T1, goodConfig(T1, { headline: 'old operator edit' }), W, { issuedAt: nowSec() + 20 });
  const old2 = await unpublishSite(T1, W, { issuedAt: nowSec() + 21 });
  const cur = JSON.parse(MAP.get('site:cur:v1:' + T1).value);
  const old3 = await publishCfg(T1, null, W, { byHash: true, configHash: cur.configHash, issuedAt: nowSec() + 22 });
  check('E06 the old operator fails EVERY site write immediately (publish, unpublish, restore)', old1.s === 403 && old2.s === 403 && old3.s === 403);
  const adopt = await publishCfg(T1, null, W2, { byHash: true, configHash: cur.configHash, issuedAt: nowSec() + 23 });
  check('E07 the new operator ADOPTS the exact current config with a new signature, free', adopt.s === 200 && adopt.j.kind === 'adopt', adopt.body);
  const pg2 = await site('/site/' + T1);
  check('E08 after adoption: authority label back, links clickable again', pg2.body.includes(Site.AUTHORITY_LABEL) && /href="https:\/\/x\.com\/syncnet"/.test(pg2.body) && !pg2.body.includes(Site.PREVIOUS_LABEL));
  check('E09 adoption did not touch the entitlement or create a payment', JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).requestId === ACT1.requestId || JSON.parse(MAP.get('site:entitlement:v1:' + T1).value).status === 'ACTIVE');
  // publish / transfer race: the Passport changes between the authority read and the atomic commit
  storeMode.beforeCas = async () => { const p = JSON.parse(MAP.get('mp:passport:v1:' + T1).value); p.operator = X; MAP.set('mp:passport:v1:' + T1, { type: 'string', value: JSON.stringify(p), expiresAt: null }); };
  const race = await publishCfg(T1, goodConfig(T1, { headline: 'racing the transfer' }), W2, { issuedAt: nowSec() + 30 });
  check('E10 publish racing a Passport transfer is rejected atomically (409 conflict, nothing written)', race.s === 409 && race.j.code === 'conflict' && JSON.parse(MAP.get('site:cur:v1:' + T1).value).signer === W2 && !JSON.stringify(JSON.parse(MAP.get('site:cur:v1:' + T1).value)).includes('racing'));
  const pg3 = await site('/site/' + T1);
  check('E11 …and render-time authority immediately disables the links for the new operator X', pg3.body.includes(Site.PREVIOUS_LABEL) && !/href=/.test(pg3.body));
  const p = JSON.parse(MAP.get('mp:passport:v1:' + T1).value); p.operator = W2; MAP.set('mp:passport:v1:' + T1, { type: 'string', value: JSON.stringify(p), expiresAt: null });
  // Passport disappears entirely (should never happen): fail closed
  const saved = MAP.get('mp:passport:v1:' + T3); MAP.delete('mp:passport:v1:' + T3);
  const noPass = await site('/site/' + T3);
  check('E12 no Passport at render time → not operator-verified, links disabled', noPass.statusCode === 200 && !noPass.body.includes(Site.AUTHORITY_LABEL) && !/href=/.test(noPass.body));
  MAP.set('mp:passport:v1:' + T3, saved);
}

// ============================================================================================ F. metrics, complimentary, reorg render
{
  await ph._internals.grantComplimentary(store, T8, { reason: 'internal test', grantedBy: 'ops' });
  const ce = JSON.parse(MAP.get('site:entitlement:v1:' + T8).value);
  check('F01 complimentary entitlement is labelled COMPLIMENTARY', ce.kind === 'complimentary' && ce.label === 'COMPLIMENTARY');
  const cp = await publishCfg(T8, goodConfig(T8));
  check('F02 a complimentary entitlement permits publication', cp.s === 200);
  let threw = false; try { await ph._internals.grantComplimentary(store, T1, { reason: 'x', grantedBy: 'y' }); } catch { threw = true; }
  check('F03 complimentary never overwrites an existing entitlement', threw);
  const acts = (await api('GET', null, { view: 'activations' })).j.activations;
  const paid = acts.reduce((s, a) => s + BigInt(a.exactTaggedSyncAmount), 0n);
  const settled = paid - 10n ** 18n, burned = (settled * 60n) / 100n, forwarded = settled - burned;
  pc.sinkTotals = { settled, burned, forwarded };
  pc.sinkBalance = 10n ** 18n + 5n * 10n ** 18n; // 1 SYNC of paid funds not yet settled + 5 SYNC unsolicited
  const converted = forwarded / 2n; // half of the forwarded treasury share already converted
  pc.converterBalance = forwarded - converted + 3n * 10n ** 18n; // the rest awaits conversion + 3 SYNC sent straight to the converter
  pc.converterTotals = { converted, produced: 12_345_678n, delivered: 12_345_678n + 100n }; // real USDG (6 dp) incl. 100 units sent directly
  const mt = (await api('GET', null, { view: 'metrics' })).j;
  check('F04 metrics: activations counted from the registry (complimentary excluded)', mt.projectHomesActivated === acts.length && mt.complimentaryEntitlements === 1);
  check('F05 metrics: SYNC paid for verified activations = registry sum', mt.syncPaidForVerifiedActivations === paid.toString());
  check('F06 metrics: sink stage from the contract — in sink, actually burned, forwarded to converter; unsolicited 5 SYNC isolated', mt.sink.syncActuallyBurned === burned.toString() && mt.sink.syncCurrentlyInSink === pc.sinkBalance.toString() && mt.sink.syncForwardedToTreasuryConverter === forwarded.toString() && mt.sink.unattributedInflow === (5n * 10n ** 18n).toString(), JSON.stringify(mt.sink));
  check('F06b metrics: converter stage read via the sink\'s immutable TREASURY_CONVERTER — awaiting, converted, real USDG out, delivered', mt.converter.address === CONVERTER && mt.converter.treasury === TREASURY_FIXTURE && mt.converter.syncAwaitingConversion === pc.converterBalance.toString() && mt.converter.syncActuallyConverted === converted.toString() && mt.converter.usdgFromConversions === '12345678' && mt.converter.usdgDeliveredToTreasury === '12345778' && mt.converter.usdgDecimals === 6, JSON.stringify(mt.converter));
  check('F06c metrics: SYNC sent straight to the converter is isolated as unsolicited (3 SYNC)', mt.converter.unsolicitedSyncInflow === (3n * 10n ** 18n).toString());
  check('F06d metrics never derive USDG from the reference rate (no $15.60, no usd estimate)', !/15\.6|usdEstimate|expectedUsdg|usdValue/i.test(JSON.stringify(mt)) && mt.notes.some((n) => /ACTUAL DEX EXECUTION RATE/.test(n) && /not the SYNCNET REFERENCE RATE/.test(n)));
  check('F07 metrics wording: committed ≠ burned; unsolicited transfers are not activation payments', mt.notes.some((n) => /COMMITTED TO BURN/.test(n)) && mt.notes.some((n) => /unsolicited/.test(n)));
  check('F08 metrics: rate version used per activation', Object.keys(mt.activationsByRateVersion).length >= 1);
  // reorg invalidation hides a published site and is excluded from metrics
  const e3 = JSON.parse(MAP.get('site:entitlement:v1:' + T3).value);
  const inv = { ...e3, status: 'INVALIDATED_BY_REORG' };
  MAP.set('site:entitlement:v1:' + T3, { type: 'string', value: JSON.stringify(inv), expiresAt: null });
  const pgInv = await site('/site/' + T3);
  check('F09 invalidated entitlement → site unavailable (503), nothing operator-authored shown', pgInv.statusCode === 503 && !pgInv.body.includes('The synced home'));
  const mt2 = (await api('GET', null, { view: 'metrics' })).j;
  check('F10 invalidated activation excluded from verified metrics', mt2.projectHomesActivated === mt.projectHomesActivated - 1);
  MAP.set('site:entitlement:v1:' + T3, { type: 'string', value: JSON.stringify(e3), expiresAt: null });
  pc.mode = 'down';
  const mt3 = (await api('GET', null, { view: 'metrics' })).j;
  check('F11 metrics with RPC down: registry figures still served, sink marked unavailable (never guessed)', mt3.sink.unavailable === true && mt3.syncPaidForVerifiedActivations === paid.toString());
  pc.mode = 'ok';
  storeMode.failGet = true;
  const sDown = await site('/site/' + T1);
  storeMode.failGet = false;
  check('F12 store failure at render → 503, nothing rendered', sDown.statusCode === 503 && !sDown.body.includes('Operator Live'));
}

// ============================================================================================ H. activation is independent of settlement / conversion
{
  const TH = lc(A.PONS2_CONTRACT); seedPassport(TH, W);
  const cfg = (await api('GET', null, { view: 'config' })).j;
  check('H01 config: 60% burned, 40% converted to USDG for the SyncNet treasury; reference rate ≠ execution rate', cfg.split.treasuryAsset === 'USDG' && /converted to USDG/.test(cfg.split.note) && /actual DEX execution rate \(not the SyncNet reference rate\)/.test(cfg.split.note) && /does not depend/.test(cfg.split.note));
  // Any read of the sink or the converter now throws: activation and publication must not care.
  let touched = 0;
  const strict = async (method, params) => { if (method === 'eth_call' && [SINK, CONVERTER].includes(lc(params[0].to))) { touched++; throw new Error('sink/converter unavailable'); } return rpc(method, params); };
  const r = await request(TH, W, { rpc: strict });
  const p = payIntent(r.j.intent);
  const v = await verify(r.j.intent.requestId, p.txHash, { rpc: strict });
  check('H02 a SAFE payment activates while the sink is unsettled and the converter unreachable', r.s === 201 && v.s === 200 && v.j.status === 'ACTIVE' && touched === 0, v.body);
  const pub = await publishCfg(TH, goodConfig(TH), W, { rpc: strict });
  check('H03 …and the project can publish immediately (no conversion, no settlement required)', pub.s === 200 && touched === 0, pub.body);
  check('H04 the customer payment is ONE canonical SYNC transfer to the sink (no approval, no burn, no USDG transaction)', pc.receipts.get(p.txHash).logs.length === 1 && pc.receipts.get(p.txHash).logs[0].address === SYNC);
  const mtDown = (await api('GET', null, { view: 'metrics' }, { rpc: strict })).j;
  check('H05 metrics with the sink unreachable: registry figures served, sink/converter marked unavailable, never guessed', mtDown.sink.unavailable === true && mtDown.projectHomesActivated >= 1);
}

// ============================================================================================ T. Terms of Use version signed in the ActivationRequest
{
  const TT = T6;
  for (const k of [...MAP.keys()]) if (k.startsWith('site:') && k.includes(TT)) MAP.delete(k); // clean slate for this project (Passport kept)
  const noTerms = await request(TT, W, { message: { termsVersion: undefined }, signature: '0x' + '11'.repeat(65) }); // field absent from the body
  check('T01 missing termsVersion → 400 terms_version, no intent', noTerms.s === 400 && noTerms.j.code === 'terms_version' && !MAP.has('site:open:v1:' + TT), noTerms.body);
  const old = await request(TT, W, { message: { termsVersion: '2026-09-23' } });
  check('T02 old/unknown termsVersion (signed and sent) → 400 terms_version', old.s === 400 && old.j.code === 'terms_version' && !MAP.has('site:open:v1:' + TT), old.body);
  const mOld = { token: TT, operator: W, issuedAt: nowSec(), nonce: rnd32(), termsVersion: '2026-09-23' };
  const forged = await request(TT, W, { message: { ...mOld, termsVersion: Site.TERMS_VERSION }, digest: Site.digest('ActivationRequest', mOld) });
  check('T03 body claims the current version but the wallet signed another → 401 (the version is inside the signature)', forged.s === 401 && !MAP.has('site:open:v1:' + TT), forged.body);
  const q = await request(TT, W);
  const stored = JSON.parse(MAP.get('site:intent:v1:' + q.j.intent.requestId).value);
  check('T04 current termsVersion → quote; stored in the intent and in its signed request digest; exposed in the public quote', q.s === 201 && stored.termsVersion === Site.TERMS_VERSION && q.j.intent.termsVersion === Site.TERMS_VERSION && stored.request.digest === Site.digest('ActivationRequest', { token: TT, operator: W, issuedAt: stored.request.issuedAt, nonce: stored.request.nonce, termsVersion: Site.TERMS_VERSION }), q.body);
  const p = payIntent(q.j.intent);
  const v = await verify(q.j.intent.requestId, p.txHash);
  const ent = JSON.parse(MAP.get('site:entitlement:v1:' + TT).value);
  const actRec = JSON.parse(MAP.get('site:act:v1:' + p.txHash + ':' + v.j.entitlement.logIndex).value);
  check('T05 termsVersion copied to the entitlement and the activation record', v.s === 200 && ent.termsVersion === Site.TERMS_VERSION && actRec.termsVersion === Site.TERMS_VERSION, v.body);
  const st = await status(TT);
  const acts = (await api('GET', null, { view: 'activations' })).j.activations;
  check('T06 public status and activations views carry termsVersion + receipt data (payer, sink, tx, block, amount display, rate, requestId)', st.entitlement.termsVersion === Site.TERMS_VERSION && acts.some((a) => a.token === TT && a.termsVersion === Site.TERMS_VERSION) && st.entitlement.payer && st.entitlement.sink && st.entitlement.txHash === p.txHash && st.entitlement.blockNumber && st.entitlement.exactSyncDisplay === q.j.intent.exactTaggedSyncDisplay && st.entitlement.syncUsdReferenceRate && st.entitlement.requestId === q.j.intent.requestId);
  // legacy quote (issued before termsVersion existed): re-signing records the acceptance on the SAME quote
  const TL = T7;
  for (const k of [...MAP.keys()]) if (k.startsWith('site:') && k.includes(TL)) MAP.delete(k);
  const lq = await request(TL, W);
  const lraw = JSON.parse(MAP.get('site:intent:v1:' + lq.j.intent.requestId).value);
  delete lraw.termsVersion;
  MAP.set('site:intent:v1:' + lq.j.intent.requestId, { type: 'string', value: JSON.stringify(lraw), expiresAt: null });
  check('T07 a legacy open quote is exposed with termsVersion null', (await status(TL)).openIntent.termsVersion === null);
  const re = await request(TL, W);
  const up = JSON.parse(MAP.get('site:intent:v1:' + lq.j.intent.requestId).value);
  check('T08 re-signing a legacy open quote records the current Terms on it (same quote, same amount, earlier request kept)', re.s === 200 && re.j.reused === true && re.j.intent.requestId === lq.j.intent.requestId && re.j.intent.exactTaggedSyncAmount === lq.j.intent.exactTaggedSyncAmount && up.termsVersion === Site.TERMS_VERSION && up.request.operator === W && up.earlierRequest && up.earlierRequest.nonce !== up.request.nonce, re.body);
  const same = await request(TL, W);
  check('T09 a quote already carrying the current Terms is reused unchanged', same.s === 200 && same.j.reused === true && JSON.parse(MAP.get('site:intent:v1:' + lq.j.intent.requestId).value).request.nonce === up.request.nonce);
  // a legacy quote PAID without re-signing still activates (a payment is never lost) and says the Terms were not recorded
  const lraw2 = { ...up }; delete lraw2.termsVersion;
  MAP.set('site:intent:v1:' + lq.j.intent.requestId, { type: 'string', value: JSON.stringify(lraw2), expiresAt: null });
  const lp = payIntent(lq.j.intent);
  const lv = await verify(lq.j.intent.requestId, lp.txHash);
  check('T10 a legacy quote paid without Terms still activates; entitlement termsVersion is null (not invented)', lv.s === 200 && JSON.parse(MAP.get('site:entitlement:v1:' + TL).value).termsVersion === null, lv.body);
}

// ============================================================================================ S. SyncNet ops suspension
{
  const Susp = require(path.join(ROOT, 'netlify/lib/project-home-suspension.js'));
  const T = T8; // complimentary entitlement, published by the current operator W (F01/F02)
  const live0 = await site('/site/' + T);
  check('S00 fixture: the Project Home is live before suspension', live0.statusCode === 200 && live0.body.includes(Site.AUTHORITY_LABEL));
  // nothing over HTTP can suspend or reinstate — not an unauthenticated caller, not the Passport operator
  const m = { token: T, operator: W, issuedAt: nowSec(), nonce: rnd32() };
  const viaHttp = [
    await api('POST', { action: 'suspend', token: T, category: 'abuse', actor: 'x' }),
    await api('POST', { action: 'reinstate', token: T, actor: 'x' }),
    await api('POST', { action: 'suspend', ...m, signature: signDigest(W, Site.digest('SiteUnpublish', m)) }),
    await api('GET', null, { view: 'suspend', token: T }),
  ];
  check('S01 no HTTP action or view can suspend/reinstate (unauthenticated or operator-signed → 400, nothing written)', viaHttp.every((r) => r.s === 400) && !MAP.has(Susp.K.suspension(T)), viaHttp.map((r) => r.s).join());
  const fnSrc = fs.readdirSync(path.join(ROOT, 'netlify/functions')).map((f) => fs.readFileSync(path.join(ROOT, 'netlify/functions', f), 'utf8')).join('\n');
  check('S02 no Netlify function calls suspend()/reinstate() (ops CLI only; no route exists)', !/\.(suspend|reinstate)\(/.test(fnSrc) && !/\bsuspend\(|reinstate\(/.test(fnSrc));
  let bad = [];
  for (const [label, f] of [['no actor', () => Susp.suspend(store, T, { category: 'abuse' })], ['unknown category', () => Susp.suspend(store, T, { category: 'spam!', actor: 'ops:a' })], ['bad token', () => Susp.suspend(store, '0x12', { category: 'abuse', actor: 'ops:a' })], ['reinstate while not suspended', () => Susp.reinstate(store, T, { actor: 'ops:a' })]]) {
    try { await f(); bad.push(label); } catch { /* refused */ }
  }
  check('S03 invalid ops calls are refused (actor required, fixed categories, reinstate needs a suspension)', bad.length === 0 && !MAP.has(Susp.K.suspension(T)), bad.join());
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'netlify/ops/project-home-suspension.mjs'), 'suspend', T, '--category', 'abuse', '--actor', 'ops:x'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  check('S04 ops CLI refuses to run without the durable production store (fail closed)', cli.status === 2 && /no durable store/.test(cli.stderr), cli.stderr);

  // suspend: snapshot everything that is NOT suspension state, suspend, compare
  const skip = (k) => k === Susp.K.index || k.startsWith('site:suspension:') || k.startsWith('site:audit:') || k.startsWith('rl:') || /^ph-|ratelimit|:rl:/.test(k);
  // durable records only: TTL-bound locks/counters (e.g. an expiring open-quote lock of another project) may lapse meanwhile
  const snap = () => JSON.stringify([...MAP.entries()].filter(([k, v]) => !skip(k) && !v.expiresAt).map(([k, v]) => [k, v.value instanceof Set ? [...v.value].sort() : v.value]).sort());
  const auditBefore = (await store.smembers('site:audit:v1:' + T)).length;
  const before = snap();
  await Susp.suspend(store, T, { category: 'abuse', note: 'PRIVATE-NOTE phishing report #12', actor: 'ops:alice', now: () => clock.now() });
  const pg = await site('/site/' + T);
  check('S05 suspended Project Home is not publicly served (neutral 503 page)', pg.statusCode === 503 && pg.body.includes('This Project Home is currently unavailable.') && !pg.body.includes('The synced home of this project'));
  check('S06 the public page exposes no note, actor or category', !/PRIVATE-NOTE|ops:alice|abuse/i.test(pg.body));
  const st = await status(T);
  check('S07 status view: SUSPENDED + public category only (no note, no actor)', st.suspension && st.suspension.status === 'SUSPENDED' && st.suspension.category === 'abuse' && !/PRIVATE-NOTE|ops:alice/.test(JSON.stringify(st)), JSON.stringify(st.suspension));
  check('S08 homes view reports "suspended" (never "live")', (await api('GET', null, { view: 'homes', tokens: T })).j.homes[T].state === 'suspended');
  const revId = st.site.revisionId;
  const rv = await api('GET', null, { view: 'revision', id: revId });
  check('S09 revision content is not served while suspended; the revision list (history) still is', rv.s === 403 && !rv.body.includes('synced home') && (await api('GET', null, { view: 'revisions', token: T })).j.revisions.length >= 1);
  const pub = await publishCfg(T, goodConfig(T, { headline: 'Trying to publish around the suspension' }));
  const readopt = await publishCfg(T, null, W, { byHash: true, configHash: st.site.configHash });
  check('S10 operator publish / restore cannot bypass the suspension (403 suspended, pointer unchanged)', pub.s === 403 && pub.j.code === 'suspended' && readopt.s === 403 && JSON.parse(MAP.get('site:cur:v1:' + T).value).revisionId === revId, pub.body);
  const q = await request(T, W);
  check('S11 no activation quote is issued for a suspended Project Home', q.s === 403 && q.j.code === 'suspended', q.body);
  // a suspension landing between publish's reads and its commit is caught atomically
  await Susp.reinstate(store, T, { actor: 'ops:alice', now: () => clock.now() });
  storeMode.beforeCas = async () => { await Susp.suspend(store, T, { category: 'security', actor: 'ops:bob', now: () => clock.now() }); };
  clock.advance(2);
  const race = await publishCfg(T, goodConfig(T, { headline: 'Racing the suspension' }));
  check('S12 a suspension committed during publish aborts the publish (atomic expectation)', race.s === 409 && JSON.parse(MAP.get('site:cur:v1:' + T).value).revisionId === revId && (await site('/site/' + T)).statusCode === 503, race.body);
  const after = snap();
  check('S13 entitlement, payments, activations, revisions and Passport are untouched by suspension', after === before, JSON.parse(after).filter((e) => !before.includes(JSON.stringify(e))).map((e) => e[0]).join(' ') + ' | removed: ' + JSON.parse(before).filter((e) => !after.includes(JSON.stringify(e))).map((e) => e[0]).join(' '));
  // fail closed: a record that cannot be parsed counts as suspended
  const good = MAP.get(Susp.K.suspension(T));
  MAP.set(Susp.K.suspension(T), { type: 'string', value: '{not json', expiresAt: null });
  const corrupt = await site('/site/' + T);
  check('S14 unreadable suspension record → treated as suspended (fail closed)', corrupt.statusCode === 503 && (await publishCfg(T, goodConfig(T, { headline: 'Corrupt record attempt' }))).j.code === 'suspended');
  MAP.set(Susp.K.suspension(T), good);
  // the operator's own unpublish still works while suspended and is a separate state
  clock.advance(2);
  const un = await unpublishSite(T);
  check('S15 operator unpublish is separate and still allowed while suspended', un.s === 200 && JSON.parse(MAP.get('site:cur:v1:' + T).value).state === 'UNPUBLISHED');
  // reinstatement
  await Susp.reinstate(store, T, { actor: 'ops:carol', note: 'reviewed, content removed by operator', now: () => clock.now() });
  const st2 = await status(T);
  check('S16 reinstated: no suspension in the status view; the entitlement is still valid', st2.suspension === null && st2.entitlement && st2.entitlement.status === 'ACTIVE');
  clock.advance(2);
  const again = await publishCfg(T, goodConfig(T, { headline: 'Back after review' }));
  const pg2 = await site('/site/' + T);
  check('S17 after reinstatement the operator can publish again without a new activation fee, and it is served', again.s === 200 && pg2.statusCode === 200 && pg2.body.includes('Back after review'), again.body);
  // audit trail
  const h = await Susp.history(store, T);
  check('S18 append-only ops audit: every suspend/reinstate kept, in order, with actor, category, note and time', h.map((e) => e.type).join() === 'ops-suspend,ops-reinstate,ops-suspend,ops-reinstate' && h[0].actor === 'ops:alice' && h[0].note.startsWith('PRIVATE-NOTE') && h[0].category === 'abuse' && h[2].actor === 'ops:bob' && h[3].actor === 'ops:carol' && h.every((e) => e.at && e.token === T), JSON.stringify(h.map((e) => [e.type, e.actor, e.seq])));
  check('S19 pre-existing audit events (complimentary, publish) are retained', (await store.smembers('site:audit:v1:' + T)).length >= auditBefore + 4 && (await store.smembers(Susp.K.index)).includes(T));
  check('S20 the Passport operator is still W and unchanged by moderation', JSON.parse(MAP.get('mp:passport:v1:' + T).value).operator === W);
}

// ============================================================================================ B. FREE BETA (dormant paid system untouched)
{
  const Susp = require(path.join(ROOT, 'netlify/lib/project-home-suspension.js'));
  const BETA = { ...ENV, SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: 'false', SYNCNET_PROJECT_HOME_FREE_BETA: 'true' };
  const PAID = { ...ENV, SYNCNET_PROJECT_HOME_FREE_BETA: 'false' };
  const reset = (t) => { for (const k of [...MAP.keys()]) if (k.startsWith('site:') && k.includes(t)) MAP.delete(k); };
  const entOf = (t) => (MAP.get('site:entitlement:v1:' + t) || {}).value || null;
  const tick = () => clock.advance(2);
  const cfgV = async (env) => (await api('GET', null, { view: 'config' }, { env })).j;
  const TB = T4, TN = T5;
  reset(TB); reset(TN);

  // --- configuration
  const cb = await cfgV(BETA);
  check('BETA01 beta config: enabled, freeBeta, payments OFF, mode free-beta, no sink, no quote', cb.enabled === true && cb.freeBeta === true && cb.payments === false && cb.mode === 'free-beta' && cb.sink === null && cb.quote === null, JSON.stringify(cb).slice(0, 200));
  const both = { ...ENV, SYNCNET_PROJECT_HOME_FREE_BETA: 'true' };
  const cc = await cfgV(both);
  const cPub = await publishCfg(TN, goodConfig(TN), W, { env: both });
  const cQ = await request(TN, W, { env: both });
  check('BETA02 conflicting config (beta AND payments true) fails closed: no free publish, no paid quote', cc.freeBeta === false && cc.payments === false && cc.mode === 'closed' && cPub.s === 402 && cQ.s === 503 && cQ.j.code === 'payments_closed' && !entOf(TN), cPub.body + cQ.body);
  const bad = { ...ENV, SYNCNET_PROJECT_HOME_FREE_BETA: 'yes' };
  const bc = await cfgV(bad);
  const bQ = await request(TN, W, { env: bad });
  tick();
  const bPub = await publishCfg(TN, goodConfig(TN), W, { env: bad });
  check('BETA03 invalid FREE_BETA value fails closed for BOTH paths (payments not silently opened)', bc.freeBeta === false && bc.payments === false && bQ.s === 503 && bPub.s === 402 && !entOf(TN));
  const off = { ...BETA, SYNCNET_PROJECT_HOME_ENABLED: 'false' };
  const oc = await cfgV(off);
  tick();
  const oPub = await publishCfg(TN, goodConfig(TN), W, { env: off });
  check('BETA04 beta flag without SYNCNET_PROJECT_HOME_ENABLED → Project Home stays closed', oc.enabled === false && oc.freeBeta === false && oPub.s === 503 && !entOf(TN));

  // --- no entitlement from reads, quotes, or unauthorised publishes
  await api('GET', null, { view: 'status', token: TB }, { env: BETA });
  await api('GET', null, { view: 'homes', tokens: TB }, { env: BETA });
  await api('GET', null, { view: 'revisions', token: TB }, { env: BETA });
  const bq = await request(TB, W, { env: BETA });
  check('BETA05 viewing status/homes/revisions and asking for a quote create NO entitlement; no quote exists in beta', !entOf(TB) && bq.s === 503 && bq.j.code === 'payments_closed' && !MAP.has('site:open:v1:' + TB));
  tick();
  const np = await publishCfg(TB, goodConfig(TB), X, { env: BETA });
  const bs = await publishCfg(TB, goodConfig(TB), W, { env: BETA, signer: X, signature: signDigest(X, Site.digest('SitePublish', { token: TB, operator: W, configHash: Site.configHash(goodConfig(TB)), issuedAt: nowSec(), nonce: rnd32() })) });
  check('BETA06 a non-operator (or a bad signature) cannot create a beta entitlement', np.s === 403 && np.j.code === 'not_operator' && bs.s === 401 && !entOf(TB), np.body + bs.body);
  // atomicity: a failed commit leaves no entitlement
  storeMode.failCas = true; tick();
  const failed = await publishCfg(TB, goodConfig(TB), W, { env: BETA });
  storeMode.failCas = false;
  check('BETA07 store fails at the commit → 503, no entitlement, no revision (atomic with the publish)', failed.s === 503 && !entOf(TB) && !MAP.has('site:cur:v1:' + TB));

  // --- first beta publish
  tick();
  const actsBefore = (await store.smembers('site:acts:v1')).length;
  const first = await publishCfg(TB, goodConfig(TB, { headline: 'Free beta home' }), W, { env: BETA });
  const be = JSON.parse(entOf(TB));
  check('BETA08 current operator publishes for free during beta', first.s === 200 && first.j.kind === 'publish', first.body);
  check('BETA09 the first publish atomically created a durable FREE BETA entitlement bound to the token', be.kind === 'beta' && be.label === 'FREE BETA' && be.status === 'ACTIVE' && be.token === TB && be.firstRevisionId === first.j.site.revisionId && (await store.smembers('site:beta:v1')).includes(TB) && (await store.smembers('site:audit:v1:' + TB)).some((m) => JSON.parse(m).type === 'beta-activated'));
  check('BETA10 no fake payment: no payer, tx, amount, price, rate, quote or block; not in the paid activation registry', ['payer', 'txHash', 'logIndex', 'exactAmount', 'baseSyncAmount', 'priceUsdCents', 'syncUsdReferenceRate', 'requestId', 'blockNumber', 'sink', 'termsVersion'].every((k) => !(k in be)) && (await store.smembers('site:acts:v1')).length === actsBefore);
  const stB = (await api('GET', null, { view: 'status', token: TB }, { env: BETA })).j;
  const mt = (await api('GET', null, { view: 'metrics' }, { env: BETA })).j;
  check('BETA11 public status: FREE BETA, zero revenue; metrics count it separately, never as paid activation', stB.entitlement.label === 'FREE BETA' && stB.entitlement.countsAsRevenue === false && stB.entitlement.exactSyncDisplay === null && mt.freeBetaEntitlements >= 1, JSON.stringify({ label: stB.entitlement && stB.entitlement.label, rev: stB.entitlement && stB.entitlement.countsAsRevenue, disp: stB.entitlement && stB.entitlement.exactSyncDisplay, fb: mt.freeBetaEntitlements, acts: mt.projectHomesActivated }));
  const pg = await site('/site/' + TB, { env: BETA });
  check('BETA12 the free-beta home is served publicly, operator-verified', pg.statusCode === 200 && pg.body.includes('Free beta home') && pg.body.includes(Site.AUTHORITY_LABEL));
  check('BETA13 homes view distinguishes the kind (beta) and shows it live', (await api('GET', null, { view: 'homes', tokens: TB }, { env: BETA })).j.homes[TB].kind === 'beta');
  // edit, unpublish, republish/restore: the same entitlement is reused
  tick(); const ed = await publishCfg(TB, goodConfig(TB, { headline: 'Edited in beta' }), W, { env: BETA });
  tick(); const un = await unpublishSite(TB, W, { env: BETA });
  tick(); const rs = await publishCfg(TB, null, W, { env: BETA, byHash: true, configHash: Site.configHash(goodConfig(TB, { headline: 'Edited in beta' })) });
  check('BETA14 edit, unpublish and restore work for free and reuse the SAME entitlement (no second grant)', ed.s === 200 && un.s === 200 && rs.s === 200 && rs.j.kind === 'restore' && entOf(TB) === JSON.stringify(be), [ed.s, un.s, rs.s].join());
  // Passport transfer → the new operator controls / adopts
  const pk = 'mp:passport:v1:' + TB; const pass = JSON.parse(MAP.get(pk).value);
  MAP.set(pk, { type: 'string', value: JSON.stringify({ ...pass, operator: W2 }), expiresAt: null });
  const staleOld = await publishCfg(TB, goodConfig(TB, { headline: 'Old operator' }), W, { env: BETA });
  tick(); const adopt = await publishCfg(TB, null, W2, { env: BETA, byHash: true, configHash: Site.configHash(goodConfig(TB, { headline: 'Edited in beta' })) });
  check('BETA15 after a Passport transfer the new operator adopts the beta home; the old one is refused; the entitlement stays with the token', staleOld.s === 403 && adopt.s === 200 && adopt.j.kind === 'adopt' && entOf(TB) === JSON.stringify(be), adopt.body);

  // --- grandfathering: beta OFF, payments ON
  tick(); const gf = await publishCfg(TB, goodConfig(TB, { headline: 'After the beta' }), W2, { env: PAID });
  const gq = await request(TB, W2, { env: PAID });
  check('BETA16 beta ended (payments on): the beta project keeps publishing for free and is never quoted', gf.s === 200 && gq.s === 409 && gq.j.code === 'already_active' && entOf(TB) === JSON.stringify(be), gf.body + gq.body);
  const closedEnv = { ...ENV, SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: 'false' };
  tick(); const gc = await publishCfg(TB, goodConfig(TB, { headline: 'Both off' }), W2, { env: closedEnv });
  check('BETA17 beta AND payments off: beta entitlements still publish (grandfathered)', gc.s === 200 && entOf(TB) === JSON.stringify(be));
  reset(T2);
  tick(); const up = await publishCfg(T2, goodConfig(T2), W, { env: PAID });
  const uq = await request(T2, W, { env: PAID });
  check('BETA18 beta off, payments on: an unentitled project must use the paid activation (402, then a paid quote at the configured price)', up.s === 402 && up.j.code === 'activation_required' && uq.s === 201 && uq.j.intent.priceUsdCents === (await cfgV(PAID)).price.priceUsdCents && !entOf(T2), up.body + uq.body);

  // --- existing paid / complimentary entitlements are never replaced
  const paidRaw = entOf(T6);
  tick(); const pp = await publishCfg(T6, goodConfig(T6, { headline: 'Paid, during beta' }), W, { env: BETA });
  check('BETA19 a PAID entitlement is reused as is during beta (never downgraded or rewritten)', pp.s === 200 && entOf(T6) === paidRaw && JSON.parse(paidRaw).kind === 'paid', pp.body);
  const compRaw = entOf(T8);
  tick(); const cp = await publishCfg(T8, goodConfig(T8, { headline: 'Complimentary, during beta' }), W, { env: BETA });
  check('BETA20 a COMPLIMENTARY entitlement is reused as is during beta', cp.s === 200 && entOf(T8) === compRaw && JSON.parse(compRaw).kind === 'complimentary', cp.body);
  // a paid entitlement landing concurrently is never overwritten by a beta grant
  reset(TN); tick();
  storeMode.beforeCas = async () => { MAP.set('site:entitlement:v1:' + TN, { type: 'string', value: JSON.stringify({ token: TN, kind: 'paid', status: 'ACTIVE', txHash: '0x' + 'ab'.repeat(32) }), expiresAt: null }); };
  const race = await publishCfg(TN, goodConfig(TN), W, { env: BETA });
  check('BETA21 an entitlement created concurrently makes the beta publish fail (atomic expectation), never overwritten', race.s === 409 && JSON.parse(entOf(TN)).kind === 'paid');
  MAP.delete('site:entitlement:v1:' + TN);

  // --- suspension applies to beta homes
  await Susp.suspend(store, TB, { category: 'abuse', actor: 'ops:test', now: () => clock.now() });
  const sp = await site('/site/' + TB, { env: BETA });
  tick(); const spPub = await publishCfg(TB, goodConfig(TB, { headline: 'Bypass?' }), W2, { env: BETA });
  check('BETA22 SyncNet suspension blocks a free-beta home (not served, operator cannot publish around it); entitlement untouched', sp.statusCode === 503 && spPub.s === 403 && spPub.j.code === 'suspended' && entOf(TB) === JSON.stringify(be));
  await Susp.reinstate(store, TB, { actor: 'ops:test', now: () => clock.now() });
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/project-home.js'), 'utf8');
  check('BETA23 the paid system stays intact: intent/verify/reconcile/receipt/Terms-version code paths unchanged in behaviour', /async function createIntent\(/.test(src) && /async function verifyPayment\(/.test(src) && /b\.termsVersion !== Site\.TERMS_VERSION/.test(src) && /exactSyncDisplay/.test(src));
}

// ============================================================================================ G. source-level invariants
{
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/project-home.js'), 'utf8');
  const passportRefs = [...src.matchAll(/\[K\.passport\(token\),\s*(\w+)\]/g)].map((m) => m[1]);
  check('G01 project-home never WRITES the Passport (only an expectation inside cas)', passportRefs.length === 4 && passportRefs.every((x) => x === 'pRaw') && !/set:\s*\[[^\n]*K\.passport/.test(src) && !/store\.set\(/.test(src), passportRefs.join());
  check('G02 the only store mutations are atomic cas() calls', (src.match(/store\.(set|del|sadd)\(/g) || []).length === 0);
  check('G03 no unbounded log scans (eth_getLogs never used)', !/eth_getLogs|getLogs/.test(src) && !/eth_getLogs/.test(fs.readFileSync(path.join(ROOT, 'netlify/lib/project-home-chain.js'), 'utf8')));
  check('G04 no refund logic exists', !/refund\s*\(|action === 'refund'/.test(src));
  check('G05 operatorAtActivation is never used for authority', !/operatorAtActivation\s*===|===\s*[a-z.]*operatorAtActivation/.test(src));
  const verifySrc = src.slice(src.indexOf('async function verifyPayment('), src.indexOf('async function recordObserved('));
  const publishSrc = src.slice(src.indexOf('async function publish('), src.indexOf('async function unpublish('));
  check('G07 verification and publication never reference USDG, the converter or settlement', !/usdg|converter|settle\(|totalSettled|convert\(/i.test(verifySrc + publishSrc));
  check('G06 no fixed-SYNC product price anywhere', !/1_?000_?000n?\s*\*\s*E18|ACTIVATION_SYNC|priceSync/.test(src));
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/project-home/server.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} project-home server checks passed`);
process.exit(failures ? 1 : 0);
