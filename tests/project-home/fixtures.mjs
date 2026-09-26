// Shared fixtures for the Project Home server suites: a controllable mock of the Robinhood Chain payment surface
// (chain id, head / safe / finalized tags, blocks, receipts with canonical-SYNC Transfer logs, reorgs, outages, 429)
// layered over the existing E2E harness chain (PAR / Pons factories, EIP-1271 Safe) for project resolution.
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { A, chain, resetChain, rpcHandle, signDigest, ROOT } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
export const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
export { A, chain, resetChain, signDigest, ROOT };

export const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
export const SINK = '0x5111c0000000000000000000000000000000beef'; // fixture sink (never deployed)
export const CONVERTER = '0xc0417e2700000000000000000000000000000c0e'; // fixture treasury converter (never deployed)
export const TREASURY_FIXTURE = '0x0000000000000000000000000000000000007ea5'; // fixture treasury wallet
export const OTHER_SINK = '0x5111c0000000000000000000000000000000dead';
export const TRANSFER = Core.keccak256Utf8('Transfer(address,address,uint256)');
export const lc = (v) => String(v == null ? '' : v).toLowerCase();
export const hex = (n) => '0x' + BigInt(n).toString(16);
export const pad = (a) => '0x' + '0'.repeat(24) + lc(a).slice(2);
export const rnd32 = () => '0x' + crypto.randomBytes(32).toString('hex');

export const PRICING = {
  schema: 'syncnet.project-home.pricing.v1',
  prices: [{ priceVersion: 1, priceUsdCents: 3900 }, { priceVersion: 2, priceUsdCents: 4500 }],
  rates: [
    { rateVersion: 1, syncUsd: '0.00005', effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2027-06-01T00:00:00Z' },
    { rateVersion: 2, syncUsd: '0.0005', effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2027-06-01T00:00:00Z' },
  ],
};
export const ENV = {
  SYNCNET_PROJECT_HOME_ENABLED: 'true', SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: 'true', PROJECT_HOME_PRICE_VERSION: '1',
  PROJECT_HOME_PRICE_USD_CENTS: '3900', PROJECT_HOME_RATE_VERSION: '1', PROJECT_HOME_SINK_ADDRESS: SINK,
};

/** Controllable clock shared by the functions under test (ms). */
export const clock = { t: Math.floor(Date.now() / 1000) * 1000, // starts at real time: the real Marketplace code under test compares against Date.now()
   now() { return clock.t; }, advance(s) { clock.t += s * 1000; } };

/** Payment-chain state. Blocks advance one per second of clock time. */
export const pc = {
  chainHex: '0x1237', head: 1000n, safe: 990n, finalized: 900n, genesisTs: 0n, blocks: new Map(), receipts: new Map(),
  mode: 'ok', fail429: 0, calls: 0, sinkBalance: 0n, sinkTotals: { settled: 0n, burned: 0n, forwarded: 0n }, converterBalance: 0n, converterTotals: { converted: 0n, produced: 0n, delivered: 0n }, reorged: new Set(),
};
export function resetPc() {
  Object.assign(pc, { chainHex: '0x1237', head: 1000n, safe: 990n, finalized: 900n, blocks: new Map(), receipts: new Map(), mode: 'ok', fail429: 0, calls: 0, sinkBalance: 0n, sinkTotals: { settled: 0n, burned: 0n, forwarded: 0n }, converterBalance: 0n, converterTotals: { converted: 0n, produced: 0n, delivered: 0n }, reorged: new Set() });
  pc.genesisTs = BigInt(Math.floor(clock.t / 1000)) - pc.head;
}
resetPc();
const blockHash = (n, v = 0) => Core.keccak256Utf8('block|' + n + '|' + v);
export function blockAt(n) {
  const b = pc.blocks.get(n);
  return b || { number: n, hash: blockHash(n), timestamp: pc.genesisTs + n };
}
/** Advance the chain head with the clock (one block per second) and optionally move safe/finalized. */
export function mineTo(n) { pc.head = BigInt(n); }
export function setTags({ safe, finalized }) { if (safe !== undefined) pc.safe = BigInt(safe); if (finalized !== undefined) pc.finalized = BigInt(finalized); }

/**
 * Put a payment transaction on the mock chain. Returns {txHash, blockNumber}.
 * opts: amount (BigInt), to (sink), token (log emitter), from, status, blockNumber, timestamp, extraLogs, logs (override)
 */
export function pay(opts) {
  const n = BigInt(opts.blockNumber != null ? opts.blockNumber : pc.head + 1n);
  if (n > pc.head) pc.head = n;
  const b = { number: n, hash: blockHash(n), timestamp: opts.timestamp != null ? BigInt(opts.timestamp) : BigInt(Math.floor(clock.t / 1000)) }; // mined 'now' unless told otherwise
  pc.blocks.set(n, b);
  const txHash = opts.txHash || rnd32();
  const log = (i, o) => ({ address: lc(o.token || SYNC), topics: [TRANSFER, pad(o.from || A.WALLET2), pad(o.to || SINK)], data: '0x' + BigInt(o.amount).toString(16).padStart(64, '0'), logIndex: hex(i), transactionHash: txHash, blockHash: b.hash, blockNumber: hex(n), removed: false });
  const logs = opts.logs || [...(opts.extraLogs || []).map((o, i) => log(i, o)), log((opts.extraLogs || []).length, opts)];
  pc.receipts.set(txHash, { transactionHash: txHash, status: opts.status || '0x1', blockNumber: hex(n), blockHash: b.hash, logs });
  return { txHash, blockNumber: n };
}
/** Reorg: the block at `n` gets a new hash; the tx either disappears or is re-included at `reincludeAt`. */
export function reorg(n, { reincludeAt } = {}) {
  n = BigInt(n);
  const old = blockAt(n);
  const nb = { number: n, hash: blockHash(n, 1 + pc.reorged.size), timestamp: old.timestamp };
  pc.blocks.set(n, nb); pc.reorged.add(String(n));
  for (const [h, r] of [...pc.receipts]) {
    if (BigInt(r.blockNumber) !== n) continue;
    if (reincludeAt == null) { pc.receipts.delete(h); continue; }
    const m = BigInt(reincludeAt);
    const b2 = { number: m, hash: blockHash(m, 7), timestamp: pc.genesisTs + m };
    pc.blocks.set(m, b2); if (m > pc.head) pc.head = m;
    pc.receipts.set(h, { ...r, blockNumber: hex(m), blockHash: b2.hash, logs: r.logs.map((l) => ({ ...l, blockHash: b2.hash, blockNumber: hex(m) })) });
  }
}

const SEL = (sig) => Core.functionSelector(sig);
/** The rpc(method, params) injected into the functions. Payment methods are mocked here, the rest by the harness. */
export async function rpc(method, params = []) {
  pc.calls++;
  if (pc.mode === 'down') throw Object.assign(new Error('RPC HTTP 503'), { name: 'RpcError', transient: true });
  if (pc.fail429 > 0) { pc.fail429--; throw Object.assign(new Error('RPC HTTP 429'), { name: 'RpcError', transient: true }); }
  const q = (b) => ({ number: hex(b.number), hash: b.hash, timestamp: hex(b.timestamp), transactions: [] });
  switch (method) {
    case 'eth_chainId': return pc.chainHex;
    case 'eth_blockNumber': return hex(pc.head);
    case 'eth_getBlockByNumber': {
      const tag = params[0];
      if (tag === 'safe') return pc.mode === 'no-safe' ? null : q(blockAt(pc.safe));
      if (tag === 'finalized') { if (pc.mode === 'no-finalized') throw new Error('finalized unsupported'); return q(blockAt(pc.finalized)); }
      if (tag === 'latest') return q(blockAt(pc.head));
      const n = BigInt(tag);
      return n > pc.head ? null : q(blockAt(n));
    }
    case 'eth_getTransactionReceipt': return pc.receipts.get(lc(params[0])) || pc.receipts.get(params[0]) || null;
    case 'eth_call': {
      const to = lc(params[0].to), data = lc(params[0].data);
      const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
      if (to === SYNC && data.startsWith(SEL('balanceOf(address)')) && data.endsWith(lc(SINK).slice(2))) return word(pc.sinkBalance);
      if (to === SYNC && data.startsWith(SEL('balanceOf(address)')) && data.endsWith(lc(CONVERTER).slice(2))) return word(pc.converterBalance);
      if (to === SINK) {
        const v = data === SEL('totalSettledSync()') ? pc.sinkTotals.settled : data === SEL('totalBurnedSync()') ? pc.sinkTotals.burned : data === SEL('totalTreasurySyncForwarded()') ? pc.sinkTotals.forwarded : data === SEL('TREASURY_CONVERTER()') ? BigInt(CONVERTER) : null;
        if (v !== null) return word(v);
      }
      if (to === CONVERTER) {
        const v = data === SEL('totalSyncConverted()') ? pc.converterTotals.converted : data === SEL('totalUsdgFromConversions()') ? pc.converterTotals.produced : data === SEL('totalUsdgDelivered()') ? pc.converterTotals.delivered : data === SEL('TREASURY()') ? BigInt(TREASURY_FIXTURE) : null;
        if (v !== null) return word(v);
      }
      break;
    }
    default: break;
  }
  const out = rpcHandle({ jsonrpc: '2.0', id: 1, method, params });
  if (out.error) throw Object.assign(new Error(out.error.message), { name: 'RpcError', code: out.error.code, revert: out.error.code === 3 });
  return out.result;
}

export function signerFor(Site) {
  return (kind, message, who) => signDigest(who, Site.digest(kind, message));
}
