'use strict';
/*
 * SYNC Proof public matching rule, server implementation (docs §13.2–13.3): bounded, targeted Robinhood Chain reads.
 *
 *   sweep(rpc, intent, {hintTx, chunk, budget}) -> {chain:{head, safe, finalized}, candidates:[…], deferred, calls}
 *
 * A candidate is a Transfer log emitted by the canonical token contract (rule 3) with from == sender, to == receiver
 * (4), value == amount (5), in a SUCCESSFUL transaction (2), in a block that is canonical now (6: block hash read by
 * number equals the receipt's block hash), on chain 4663 (1). Each candidate carries its window state (7:
 * in-window | late | early | out) and whether its block is at or below the `safe` / `finalized` tags (8).
 *
 * Search: the client's tx hash is only a HINT (checked first, cheaply). The sweep then walks eth_getLogs in chunks from
 * intent.createdBlock + 1 until the head or until the chunk's last block is past intent.expiry, so the in-window set is
 * complete before anything finalises. Late (recovery) transfers are found through the hint only. Every read counts
 * against a hard budget; exhausting it returns deferred:true (the caller answers 202 and the client retries). Any RPC
 * failure throws (callers fail closed).
 */
const E = require('../../lib/syncnet-early.js');
const PhChain = require('./project-home-chain');

const hex = (n) => '0x' + BigInt(n).toString(16);
const pad = (a) => '0x' + '0'.repeat(24) + E.lc(a).slice(2);

async function sweep(rpc, intent, options = {}) {
  const msg = intent.struct || intent.message || intent;
  const chunk = Number.isInteger(options.chunk) && options.chunk >= 100 ? options.chunk : 10000;
  const budget = Number.isInteger(options.budget) && options.budget > 0 ? options.budget : 24;
  const r = PhChain.bounded(rpc, budget);
  const want = { token: msg.token, sender: msg.sender, receiver: msg.receiver, amount: msg.amount };
  const blocks = new Map();
  const blockAt = async (n) => { const k = String(n); if (!blocks.has(k)) blocks.set(k, await PhChain.block(r, BigInt(n))); return blocks.get(k); };
  const out = { chain: { head: null, safe: null, finalized: null }, candidates: [], deferred: false, calls: 0 };
  const seen = new Set();

  await PhChain.assertChain(r);
  const head = await PhChain.block(r, 'latest');
  if (!head) throw new PhChain.ChainReadError('no head');
  out.chain.head = head.number.toString();
  const safe = await PhChain.block(r, 'safe');
  out.chain.safe = safe ? safe.number.toString() : null;
  let fin = null;
  try { fin = await PhChain.block(r, 'finalized'); } catch { fin = null; }
  out.chain.finalized = fin ? fin.number.toString() : null;

  async function consider(rcpt, fromHint) {
    if (!rcpt || E.lc(rcpt.status) !== '0x1') return;
    const matches = E.matchingTransfers(rcpt, want);
    if (!matches.length) return;
    const n = BigInt(rcpt.blockNumber);
    if (n <= BigInt(intent.createdBlock)) return; // mined before the signed intent was persisted: never a candidate
    const blk = await blockAt(n);
    if (!blk || blk.hash !== E.lc(rcpt.blockHash)) return; // not canonical right now (reorg in progress): not a candidate
    const state = E.windowState(msg, blk.timestamp);
    // Late (recovery) transfers are found through the fan's hint only, never incidentally by the sweep: the result must
    // not depend on the chunk size (docs §13.3).
    if (state !== 'in-window' && !fromHint) return;
    for (const m of matches) {
      const key = m.txHash + ':' + m.logIndex;
      if (seen.has(key)) continue;
      seen.add(key);
      out.candidates.push({
        txHash: m.txHash, logIndex: m.logIndex, from: m.from, to: m.to, value: m.value,
        blockNumber: n.toString(), blockHash: blk.hash, blockTimestamp: Number(blk.timestamp), state,
        safe: Boolean(safe && n <= safe.number), finalized: Boolean(fin && n <= fin.number),
      });
    }
  }

  try {
    if (E.isBytes32(options.hintTx)) {
      const rcpt = await PhChain.receipt(r, E.lc(options.hintTx));
      if (rcpt) await consider(rcpt, true);
    }
    // In-window sweep: createdBlock + 1 … head, stopping once a chunk's last block is past expiry.
    let from = BigInt(intent.createdBlock) + 1n;
    const expiry = BigInt(msg.expiry);
    while (from <= head.number) {
      const to = from + BigInt(chunk) - 1n < head.number ? from + BigInt(chunk) - 1n : head.number;
      const logs = await r('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: E.lc(msg.token), topics: [E.TRANSFER_TOPIC, pad(msg.sender), pad(msg.receiver)] }]);
      const txs = [...new Set((Array.isArray(logs) ? logs : []).map((l) => E.lc(l && l.transactionHash)).filter(E.isBytes32))];
      for (const h of txs) { if ([...seen].some((k) => k.startsWith(h + ':'))) continue; const rcpt = await PhChain.receipt(r, h); if (rcpt) await consider(rcpt, false); }
      const last = await blockAt(to);
      if (!last || last.timestamp > expiry) break;
      from = to + 1n;
    }
  } catch (err) {
    if (err && err.budget) { out.deferred = true; } else throw err;
  }
  out.calls = r.calls();
  out.candidates.sort((a, b) => (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex));
  return out;
}

/** Re-checks ONE named candidate right now (used before finalisation): canonical block, status, match, tags. */
async function recheck(rpc, intent, txHash, logIndex, options = {}) {
  const res = await sweep(rpc, intent, { hintTx: txHash, chunk: options.chunk, budget: options.budget || 12 });
  return { chain: res.chain, candidate: res.candidates.find((c) => c.txHash === E.lc(txHash) && c.logIndex === Number(logIndex)) || null, deferred: res.deferred };
}

module.exports = { sweep, recheck };
