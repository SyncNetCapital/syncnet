'use strict';
/*
 * SYNCNET REFERENCE RATE — automatic, server-side, per NEW payment intent. Not an oracle; never called one.
 *
 * Source: ONLY the canonical PAR SYNC/USDG market (PAR multi-market factory, SYNC market index 1, Uniswap v4 pool
 * 0xeaff358a…13792 on the PoolManager), read directly from Robinhood Chain (4663). No third-party price API.
 *
 * Algorithm (bounded: at most 9 RPC calls, all read-only):
 *   1. chain id must be 4663; read the latest block L (number, timestamp).
 *   2. at block L: factory.poolKeysFor(SYNC)[1] must be the reviewed key (currency0 USDG, currency1 SYNC, no hooks) and
 *      keccak256(abi.encode(key)) must equal factory.poolIdFor(SYNC, 1) AND the pinned canonical pool id.
 *   3. PoolManager.extsload(slot0) and extsload(liquidity) at L: sqrtPriceX96 > 0, the slot0 tick consistent with the
 *      price (±1), in-range liquidity >= MIN_LIQUIDITY.
 *   4. PoolManager.extsload(slot0) again at block L − LAG_BLOCKS (≈2 minutes earlier).
 *   5. mid (USD per SYNC, 1e18 fixed point) = 10^30 · 2^192 / sqrtPriceX96²  (USDG 6 decimals, SYNC 18).
 *   6. the two mids may differ by at most MAX_TWO_POINT_BPS; the LOWER one is used (more SYNC is charged, never less).
 *   7. rounded DOWN to 3 significant figures (the canary methodology: never below the observed mid → never undercharge).
 *   8. within the pricing library's hard bounds, and not more than MAX_JUMP_UP_BPS ABOVE the last accepted reference if
 *      that reference is younger than REF_MAX_AGE_S (Upstash `site:rateref:v1`, written only by accepted derivations).
 * Any failure throws RateUnavailable: no quote is issued. There is NO fallback to a manual or stale rate.
 */
const Core = require('../../lib/syncnet-core.js');
const Chain = require('../../lib/syncnet-chain.js');
const Pricing = require('../../lib/syncnet-project-home-pricing.js');
const PhChain = require('./project-home-chain');

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const CHAIN_ID = 4663;
const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ZERO = '0x0000000000000000000000000000000000000000';
const MULTI_FACTORY = lc(Chain.ROBINHOOD.multiFactory);
const POOL_MANAGER = lc(Chain.ROBINHOOD.poolManager);
const MARKET_INDEX = 1;
const POOL_ID = '0xeaff358aa176be51e27a562f77ba12265490af09813ff1f71a3f8d796cb13792'; // keccak256(abi.encode(PoolKey)) of market 1
const POOLS_SLOT = 6n; // Uniswap v4 PoolManager: mapping(PoolId => Pool.State) _pools
const LIQUIDITY_OFFSET = 3n;
const LAG_BLOCKS = 1200n; // ≈2 minutes on Robinhood Chain (≈0.1 s blocks); public RPC keeps ≈6 minutes of state
const MAX_TWO_POINT_BPS = 1000n; // the two reads may differ by at most 10 %
const MAX_JUMP_UP_BPS = 2500n; // at most +25 % above the last accepted reference younger than an hour
const REF_MAX_AGE_S = 3600;
const REF_TTL_S = 2 * 3600;
const MIN_LIQUIDITY = 10n ** 17n; // in-range liquidity floor (canary market: ≈9.1e17, locked by PAR)
const REF_KEY = 'site:rateref:v1';
const RATE_VERSION = 'AUTO';
const SEL = Object.freeze({
  poolKeysFor: Core.functionSelector('poolKeysFor(address)'),
  poolIdFor: Core.functionSelector('poolIdFor(address,uint256)'),
  extsload: Core.functionSelector('extsload(bytes32)'),
});

class RateUnavailable extends Error {
  constructor(code, detail) { super('reference rate unavailable: ' + code); this.name = 'RateUnavailable'; this.code = code; this.detail = detail || ''; }
}
const fail = (code, detail) => { throw new RateUnavailable(code, detail); };
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const tagOf = (n) => '0x' + n.toString(16);
const slot0Slot = () => BigInt(Core.keccak256('0x' + POOL_ID.slice(2) + word(POOLS_SLOT)));

/** Decodes a packed Uniswap v4 slot0 word: sqrtPriceX96 (160) | tick (int24) | protocolFee (24) | lpFee (24). */
function decodeSlot0(hex) {
  if (!/^0x[0-9a-f]{64}$/i.test(String(hex || ''))) fail('malformed_slot0');
  const w = BigInt(hex);
  const sqrtPriceX96 = w & ((1n << 160n) - 1n);
  let tick = Number((w >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick, lpFee: Number((w >> 208n) & 0xffffffn) };
}
/** USD per whole SYNC ×1e18 from sqrtPriceX96 (currency0 = USDG 6 dec, currency1 = SYNC 18 dec). */
function midRateE18(sqrtPriceX96) {
  if (sqrtPriceX96 <= 0n) fail('zero_price');
  return ((10n ** 30n) << 192n) / (sqrtPriceX96 * sqrtPriceX96);
}
/** The slot0 tick must match the price: tick = floor(log_1.0001(sqrtP² / 2^192)), ±1 for float rounding. */
function tickConsistent(s) {
  const p = Number(s.sqrtPriceX96) / 2 ** 96;
  const t = Math.floor(Math.log(p * p) / Math.log(1.0001));
  return Number.isFinite(t) && Math.abs(t - s.tick) <= 1;
}
/** Round DOWN to 3 significant figures (never above the observed mid). */
function floor3(e18) {
  const s = e18.toString();
  if (s.length <= 3) return e18;
  return BigInt(s.slice(0, 3) + '0'.repeat(s.length - 3));
}
const bpsDiff = (a, b) => ((a > b ? a - b : b - a) * 10000n) / (a < b ? a : b);

async function call(r, to, data, blockTag) {
  let out;
  try { out = await r('eth_call', [{ to, data }, blockTag]); } catch (err) { fail(err && err.budget ? 'rpc_budget' : 'rpc_failed', err && err.message); }
  if (typeof out !== 'string' || !/^0x[0-9a-f]*$/i.test(out) || out.length < 66) fail('malformed_read', to);
  return lc(out);
}

/**
 * deriveReferenceRate({rpc, store, now}) -> {rateVersion:'AUTO', syncUsdReferenceRate, rateUsdE18, rateEffectiveAt, source}
 * Throws RateUnavailable (never returns a partial or fallback rate).
 */
async function deriveReferenceRate({ rpc, store, now = Date.now }) {
  const r = PhChain.bounded(rpc, 9);
  let head;
  try { await PhChain.assertChain(r); head = await PhChain.block(r, 'latest'); } catch (err) { fail(err && err.wrongChain ? 'wrong_chain' : 'rpc_failed', err && err.message); }
  if (!head) fail('no_head');
  const at = tagOf(head.number);
  // 2. the canonical market, verified through the PAR factory's own records and the pinned pool id
  const keysHex = await call(r, MULTI_FACTORY, SEL.poolKeysFor + word(SYNC), at);
  let keys;
  try { keys = Core.abiDecode(['(address,address,uint24,int24,address)[]'], keysHex)[0]; } catch { fail('malformed_pool_keys'); }
  const k = keys && keys[MARKET_INDEX];
  if (!k || lc(k[0]) !== USDG || lc(k[1]) !== SYNC || lc(k[4]) !== ZERO) fail('not_canonical_market', 'pool key of market 1');
  const keyId = lc(Core.keccak256(Core.abiEncode(['address', 'address', 'uint24', 'int24', 'address'], [k[0], k[1], BigInt(k[2]), BigInt(k[3]), k[4]])));
  const factoryId = await call(r, MULTI_FACTORY, SEL.poolIdFor + word(SYNC) + word(MARKET_INDEX), at);
  if (keyId !== POOL_ID || factoryId !== POOL_ID) fail('not_canonical_market', 'pool id');
  // 3. price + liquidity at L
  const s0 = slot0Slot();
  const now0 = decodeSlot0(await call(r, POOL_MANAGER, SEL.extsload + word(s0), at));
  const liquidity = BigInt(await call(r, POOL_MANAGER, SEL.extsload + word(s0 + LIQUIDITY_OFFSET), at)) & ((1n << 128n) - 1n);
  if (!tickConsistent(now0)) fail('inconsistent_slot0', 'latest');
  if (liquidity < MIN_LIQUIDITY) fail('thin_liquidity', liquidity.toString());
  // 4. price ≈2 minutes earlier
  const lagNumber = head.number > LAG_BLOCKS ? head.number - LAG_BLOCKS : 1n;
  const prev0 = decodeSlot0(await call(r, POOL_MANAGER, SEL.extsload + word(s0), tagOf(lagNumber)));
  if (!tickConsistent(prev0)) fail('inconsistent_slot0', 'lagged');
  // 5–7. two-point mid, conservative pick, 3-significant-figure floor
  const midLatest = midRateE18(now0.sqrtPriceX96), midLagged = midRateE18(prev0.sqrtPriceX96);
  if (bpsDiff(midLatest, midLagged) > MAX_TWO_POINT_BPS) fail('volatile', `latest ${midLatest} vs lagged ${midLagged}`);
  const mid = midLatest < midLagged ? midLatest : midLagged;
  const rateE18 = floor3(mid);
  if (rateE18 < Pricing.MIN_RATE_E18 || rateE18 > Pricing.MAX_RATE_E18) fail('out_of_bounds', rateE18.toString());
  // 8. one-step jump guard against the last accepted reference (short-lived, server-written only)
  const nowMs = now();
  let refRaw = null, ref = null;
  try { refRaw = await store.get(REF_KEY); ref = refRaw ? JSON.parse(refRaw) : null; } catch { fail('store_unavailable'); }
  if (ref && /^\d+$/.test(String(ref.rateUsdE18)) && nowMs - Date.parse(ref.at) < REF_MAX_AGE_S * 1000) {
    const prevRef = BigInt(ref.rateUsdE18);
    if (rateE18 > prevRef && bpsDiff(rateE18, prevRef) > MAX_JUMP_UP_BPS) fail('jump', `${rateE18} vs accepted ${prevRef}`);
  }
  const derivedAt = new Date(nowMs).toISOString();
  const source = {
    kind: 'canonical-par-market', label: 'SYNCNET REFERENCE RATE', chainId: CHAIN_ID, factory: MULTI_FACTORY, poolManager: POOL_MANAGER,
    market: MARKET_INDEX, route: 'SYNC/USDG direct', poolId: POOL_ID,
    block: head.number.toString(), blockTimestamp: new Date(Number(head.timestamp) * 1000).toISOString(), laggedBlock: lagNumber.toString(),
    midUsdE18Latest: midLatest.toString(), midUsdE18Lagged: midLagged.toString(), liquidity: liquidity.toString(), lpFee: now0.lpFee,
    method: 'min(two-point pool mid) floored to 3 significant figures', derivedAt,
  };
  // Record the accepted reference (best effort; a lost race only means the next derivation compares to the other one).
  try { await store.cas({ expect: [[REF_KEY, refRaw]], set: [[REF_KEY, JSON.stringify({ rateUsdE18: rateE18.toString(), block: source.block, at: derivedAt }), REF_TTL_S]] }); } catch { fail('store_unavailable'); }
  return { rateVersion: RATE_VERSION, syncUsdReferenceRate: Pricing.formatRate(rateE18), rateUsdE18: rateE18.toString(), rateEffectiveAt: derivedAt, source };
}

module.exports = {
  deriveReferenceRate, RateUnavailable, decodeSlot0, midRateE18, floor3, tickConsistent,
  CONSTANTS: Object.freeze({ CHAIN_ID, SYNC, USDG, MULTI_FACTORY, POOL_MANAGER, MARKET_INDEX, POOL_ID, POOLS_SLOT, LIQUIDITY_OFFSET, LAG_BLOCKS, MAX_TWO_POINT_BPS, MAX_JUMP_UP_BPS, REF_MAX_AGE_S, MIN_LIQUIDITY, REF_KEY, RATE_VERSION }),
  _slot0Slot: slot0Slot,
};
