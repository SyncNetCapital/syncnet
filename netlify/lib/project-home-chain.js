'use strict';
// Targeted, bounded Robinhood Chain reads for Project Home payment verification. No log scans, ever: every read is
// addressed by a transaction hash, a block number or a block tag. Every call counts against a per-request budget, so
// no code path can loop against the RPC; any RPC failure throws and callers FAIL CLOSED (no state change).
const Core = require('../../lib/syncnet-core.js');

const CHAIN_HEX = '0x1237'; // 4663
const TRANSFER_TOPIC = Core.keccak256Utf8('Transfer(address,address,uint256)');
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/;
const QTY = /^0x[0-9a-f]{1,64}$/;

class ChainReadError extends Error {
  constructor(message, extra) { super(message); this.name = 'ChainReadError'; Object.assign(this, extra || {}); }
}

/** Wraps an rpc(method, params) with a hard call budget (default 10) for one request. */
function bounded(rpc, maxCalls) {
  let calls = 0;
  const limit = Number.isInteger(maxCalls) && maxCalls > 0 ? maxCalls : 10;
  const wrapped = async (method, params) => {
    calls += 1;
    if (calls > limit) throw new ChainReadError('rpc call budget exhausted', { budget: true });
    return rpc(method, params);
  };
  wrapped.calls = () => calls;
  return wrapped;
}

const qty = (v, what) => {
  const s = lc(v);
  if (!QTY.test(s)) throw new ChainReadError('malformed ' + what);
  return BigInt(s);
};

async function assertChain(rpc) {
  const id = lc(await rpc('eth_chainId', []));
  if (id !== CHAIN_HEX) throw new ChainReadError('wrong chain', { wrongChain: true, chainId: id });
}

async function blockNumber(rpc) { return qty(await rpc('eth_blockNumber', []), 'block number'); }

/** {number, hash, timestamp} for a tag ('safe' | 'finalized' | 'latest') or a block number (BigInt). null if unknown. */
async function block(rpc, ref) {
  const param = typeof ref === 'bigint' ? '0x' + ref.toString(16) : ref;
  const b = await rpc('eth_getBlockByNumber', [param, false]);
  if (!b) return null;
  const hash = lc(b.hash);
  if (!HASH.test(hash)) throw new ChainReadError('malformed block');
  return { number: qty(b.number, 'block number'), hash, timestamp: qty(b.timestamp, 'timestamp') };
}

async function receipt(rpc, txHash) {
  const r = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!r) return null;
  if (lc(r.transactionHash) !== lc(txHash)) throw new ChainReadError('receipt for another transaction');
  return r;
}

/**
 * Canonical-SYNC Transfer logs in a receipt that pay exactly `amount` to `sink`:
 * [{logIndex, from, amount}] sorted by logIndex. A log counts only if it was EMITTED BY the canonical token contract,
 * has the exact Transfer topic layout and has not been marked removed.
 */
function transfersTo(rcpt, { sync, sink, amount }) {
  const out = [];
  const want = BigInt(amount);
  for (const log of Array.isArray(rcpt && rcpt.logs) ? rcpt.logs : []) {
    if (!log || log.removed === true) continue;
    if (lc(log.address) !== lc(sync)) continue;
    const t = Array.isArray(log.topics) ? log.topics.map(lc) : [];
    if (t.length !== 3 || t[0] !== TRANSFER_TOPIC) continue;
    if (!/^0x0{24}[0-9a-f]{40}$/.test(t[1]) || !/^0x0{24}[0-9a-f]{40}$/.test(t[2])) continue;
    if ('0x' + t[2].slice(26) !== lc(sink)) continue;
    const data = lc(log.data);
    if (!/^0x[0-9a-f]{64}$/.test(data) || BigInt(data) !== want) continue;
    const idx = qty(log.logIndex, 'logIndex');
    if (lc(log.transactionHash || rcpt.transactionHash) !== lc(rcpt.transactionHash)) continue;
    if (log.blockHash && lc(log.blockHash) !== lc(rcpt.blockHash)) continue;
    out.push({ logIndex: Number(idx), from: '0x' + t[1].slice(26), amount: want });
  }
  return out.sort((a, b) => a.logIndex - b.logIndex);
}

module.exports = { CHAIN_HEX, TRANSFER_TOPIC, ChainReadError, bounded, assertChain, blockNumber, block, receipt, transfersTo };
