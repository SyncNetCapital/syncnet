'use strict';
/*
 * PUMP_FUN adapter for the generic Solana launch index (netlify/lib/solana-launch-index.js). Server only.
 *
 * verify(rpc, sigInfos) turns finalized signatures (from getSignaturesForAddress, oldest first or newest first — order
 * is preserved) into verified NON-SOL relationships  quote_mint (root) —LAUNCHED_AGAINST→ mint (child):
 *   - signatures whose status carries an error are skipped without fetching; a fetched transaction with meta.err is
 *     skipped too (failed transactions never count);
 *   - transactions are fetched (getTransaction, finalized, maxSupportedTransactionVersion 1) with bounded concurrency;
 *   - CreateEvents must pass lib/syncnet-pump.js extractCreateEvents (self-CPI provenance + parent create);
 *   - native-SOL quotes are ignored (V0 indexes non-SOL launches only);
 *   - each remaining launch's BondingCurve is read (getMultipleAccounts, finalized) and checked by verifyLaunch.
 * `processed` is the number of leading signatures fully handled: an RPC failure stops there, so a caller never
 * advances past a signature it could not evaluate.
 */
const Pump = require('../../lib/syncnet-pump.js');

const SOURCE = 'PUMP_FUN';
const RELATIONSHIP = 'LAUNCHED_AGAINST';
const CONCURRENCY = 8;

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

async function verify(rpc, sigInfos, { concurrency = CONCURRENCY } = {}) {
  const list = Array.isArray(sigInfos) ? sigInfos : [];
  const stats = { signatures: list.length, failedTx: 0, creates: 0, skipped: {}, rejected: {} };
  const txs = new Array(list.length);
  let stop = list.length;
  // Fetch in order-preserving windows; the first failure (error or missing tx) marks the stop index.
  for (let i = 0; i < list.length && i < stop; i += concurrency) {
    const idx = [];
    for (let j = i; j < Math.min(list.length, i + concurrency); j++) idx.push(j);
    const res = await Promise.all(idx.map(async (j) => {
      if (list[j].err) return { j, failed: true };
      try {
        const tx = await rpc.getTransaction(list[j].signature);
        return tx ? { j, tx } : { j, missing: true };
      } catch {
        return { j, missing: true };
      }
    }));
    for (const x of res) {
      if (x.missing) { stop = Math.min(stop, x.j); continue; }
      txs[x.j] = x;
    }
  }
  const candidates = [];
  for (let j = 0; j < stop; j++) {
    const x = txs[j];
    if (x.failed) { stats.failedTx += 1; bump(stats.skipped, 'failed-tx'); continue; }
    const ex = Pump.extractCreateEvents(x.tx);
    if (ex.failed) { stats.failedTx += 1; bump(stats.skipped, 'failed-tx'); continue; }
    for (let k = 0; k < ex.rejected; k++) bump(stats.rejected, 'provenance');
    for (const ev of ex.events) {
      stats.creates += 1;
      if (ev.slot !== list[j].slot) { bump(stats.rejected, 'slot-mismatch'); continue; }
      if (!Pump.isNonSolQuote(ev)) { bump(stats.skipped, ev.quoteMint === Pump.NATIVE_SOL ? 'sol-quote' : 'bad-quote'); continue; }
      candidates.push({ ev, signature: list[j].signature, slot: list[j].slot });
    }
  }
  const relationships = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const part = candidates.slice(i, i + 100);
    let accounts;
    try {
      accounts = await rpc.getMultipleAccounts(part.map((c) => c.ev.bondingCurve));
    } catch {
      // Curves unreadable: nothing from here on is evaluated; stop before the first affected signature.
      const firstSig = part[0].signature;
      const cut = list.findIndex((s) => s.signature === firstSig);
      stop = Math.min(stop, cut < 0 ? 0 : cut);
      break;
    }
    part.forEach((c, k) => {
      const v = Pump.verifyLaunch(c.ev, accounts[k]);
      if (!v.ok) { bump(stats.rejected, v.reason); return; }
      relationships.push({ source: SOURCE, relationship: RELATIONSHIP, rootMint: c.ev.quoteMint, childMint: c.ev.mint, launchSlot: c.slot, launchSignature: c.signature });
    });
  }
  const kept = new Set(list.slice(0, stop).map((s) => s.signature));
  return { processed: stop, relationships: relationships.filter((r) => kept.has(r.launchSignature)), stats };
}

/** Candidate signature sources. Mint authority: every Pump create. QuoteControl: every non-SOL create (and its trades). */
const ADDRESSES = Object.freeze({ 'mint-authority': Pump.MINT_AUTHORITY, 'quote-control': Pump.QUOTE_CONTROL });

const ADAPTER = Object.freeze({ source: SOURCE, relationship: RELATIONSHIP, address: Pump.MINT_AUTHORITY, verify });

module.exports = { SOURCE, RELATIONSHIP, ADAPTER, ADDRESSES, verify };
