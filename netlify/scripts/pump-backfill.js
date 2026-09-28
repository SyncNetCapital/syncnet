#!/usr/bin/env node
'use strict';
/*
 * Pump.fun NON-SOL historical backfill (Solana mainnet) — OFFLINE, operator-run, DRY-RUN BY DEFAULT.
 *
 *   node netlify/scripts/pump-backfill.js                          # dry run: bounded scan + report, writes nothing
 *   node netlify/scripts/pump-backfill.js --out=/tmp/pump.jsonl    # dry run + every verified relationship (JSON lines)
 *   node netlify/scripts/pump-backfill.js --write --confirm-store-host=<upstash host>
 *                                                                  # writes relationships + progress + checkpoint to
 *                                                                  # UPSTASH_REDIS_REST_URL/TOKEN (host must match)
 * Options:
 *   --from-slot=N          oldest slot to cover (default: Pump NON_SOL_START_SLOT, the first non-SOL launch)
 *   --max-signatures=N     signatures examined by this run (default 5000); a write run resumes where it stopped
 *   --candidates=mint-authority|quote-control
 *                          signature history walked (default mint-authority: every Pump create). quote-control walks
 *                          QuoteControl, which every non-SOL create_v2 references (far fewer signatures).
 *   --before=<signature>   dry run: resume a previous dry run below this signature
 *   --catch-up             write: walk back only to the stored checkpoint's slot (after an indexer backlog)
 *   --restart              write: discard an unfinished run's progress and start again from the newest signature
 *   --json                 machine-readable report
 * RPC: SYNCNET_SOLANA_RPC_URL only (never printed). Every read is finalized; getTransaction uses
 * maxSupportedTransactionVersion 1. Signatures are walked newest -> oldest in pages of 1,000 and verified in chunks of
 * 100 (netlify/lib/pump-launches.js). Writes are idempotent. The stored checkpoint only ever moves forward.
 */
const Pump = require('../../lib/syncnet-pump.js');
const Index = require('../lib/solana-launch-index');
const Launches = require('../lib/pump-launches');
const { createStore } = require('../lib/store');
const { createSolanaRpc } = require('../lib/solana-rpc');

const CHUNK = 100;

function parseArgs(argv) {
  const a = { write: false, maxSignatures: 5000, candidates: 'mint-authority', fromSlot: Pump.NON_SOL_START_SLOT };
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error('Unknown argument: ' + arg);
    const [, k, v] = m;
    if (k === 'write') a.write = true;
    else if (k === 'dry-run') a.dryRun = true;
    else if (k === 'json') a.json = true;
    else if (k === 'catch-up') a.catchUp = true;
    else if (k === 'restart') a.restart = true;
    else if (k === 'from-slot' && /^\d{1,15}$/.test(v || '')) a.fromSlot = Number(v);
    else if (k === 'max-signatures' && /^\d{1,9}$/.test(v || '') && Number(v) > 0) a.maxSignatures = Number(v);
    else if (k === 'candidates' && Launches.ADDRESSES[v]) a.candidates = v;
    else if (k === 'before' && Index.isSignature(v)) a.before = v;
    else if (['out', 'confirm-store-host'].includes(k) && v) a[k] = v;
    else throw new Error('Invalid argument: ' + arg);
  }
  if (a.write && a.dryRun) throw new Error('--write and --dry-run are mutually exclusive.');
  if (!a.write && (a.catchUp || a.restart)) throw new Error('--catch-up and --restart only apply to --write.');
  if (a.write && a.before) throw new Error('--before is for dry runs; a write run resumes from its stored progress.');
  return a;
}

function openStore(args, env) {
  const target = String(env.UPSTASH_REDIS_REST_URL || env.SYNCNET_UPSTASH_URL || '');
  let host = '';
  try { host = new URL(target).hostname; } catch { host = ''; }
  if (!host) throw new Error('--write needs UPSTASH_REDIS_REST_URL/TOKEN in the environment.');
  if (args['confirm-store-host'] !== host) throw new Error('--write needs --confirm-store-host=<the exact store host> to proceed.');
  const store = createStore({ env, timeoutMs: 20000 });
  if (!store.durable) throw new Error('The configured store is not durable.');
  return store;
}

/** Sets up (or resumes) a write run's progress record; seeds/advances the checkpoint to the head signature. */
async function prepareWrite(store, rpc, args, address, now) {
  const prev = await Index.readBackfill(store, Launches.SOURCE);
  if (prev && prev.done !== true && !args.restart) {
    if (prev.address !== address || prev.fromSlot !== args.fromSlot) throw new Error('An unfinished backfill with other settings exists (candidates/from-slot); rerun with the same settings or --restart.');
    return prev;
  }
  // The indexer's head (mint authority) is read FIRST, then this walk's head: every launch up to the indexer's
  // starting point is then at or below the walk's head, whatever the candidate address.
  const [indexerHead] = await rpc.getSignaturesForAddress(Launches.ADAPTER.address, { limit: 1 });
  const [head] = address === Launches.ADAPTER.address ? [indexerHead] : await rpc.getSignaturesForAddress(address, { limit: 1 });
  if (!head || !Index.isSignature(head.signature) || !indexerHead || !Index.isSignature(indexerHead.signature)) throw new Error('No signatures for the candidate address.');
  const { raw, checkpoint } = await Index.readCheckpoint(store, Launches.SOURCE);
  if (args.catchUp && !checkpoint) throw new Error('--catch-up needs an existing checkpoint.');
  const state = {
    address, headSignature: head.signature, headSlot: head.slot, fromSlot: args.fromSlot,
    // catch-up stops below the checkpoint's slot (slot-based, so it works for either candidate address)
    stopSlot: args.catchUp ? checkpoint.slot : null, before: null, scanned: 0, done: false, at: now(),
  };
  await Index.writeBackfill(store, Launches.SOURCE, state);
  // The indexer may follow new launches from its head on while this run fills the history below it.
  if (!checkpoint || checkpoint.slot < indexerHead.slot) {
    if (!(await Index.advanceCheckpoint(store, Launches.SOURCE, { signature: indexerHead.signature, slot: indexerHead.slot, at: now() }, raw))) throw new Error('Checkpoint changed concurrently; rerun.');
  }
  return state;
}

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const args = parseArgs(argv);
  const now = deps.now || Date.now;
  const t0 = now();
  const rpc = deps.rpc || createSolanaRpc({ env, timeoutMs: 30000, retries: 3 });
  if (!rpc) throw new Error('SYNCNET_SOLANA_RPC_URL (https) is required.');
  const address = Launches.ADDRESSES[args.candidates];
  const store = args.write ? (deps.store || openStore(args, env)) : null;
  const prevDone = store ? await Index.readBackfill(store, Launches.SOURCE) : null;
  const state = store
    ? await prepareWrite(store, rpc, args, address, now)
    : { address, fromSlot: args.fromSlot, stopSlot: null, before: args.before || null, scanned: 0, done: false };

  const out = args.out ? require('fs').createWriteStream(args.out) : null;
  const totals = { signatures: 0, failedTx: 0, creates: 0, skipped: {}, rejected: {}, verified: 0, written: 0 };
  const perRoot = new Map();
  let oldestSlot = null, scannedThisRun = 0, incomplete = false;
  while (!state.done && scannedThisRun < args.maxSignatures) {
    const page = await rpc.getSignaturesForAddress(address, { limit: 1000, before: state.before || undefined });
    let portion = page, reachedEnd = page.length < 1000;
    const floor = Math.max(state.fromSlot, Number.isSafeInteger(state.stopSlot) ? state.stopSlot : 0);
    const stopAt = page.findIndex((s) => s.slot < floor);
    if (stopAt >= 0) { portion = page.slice(0, stopAt); reachedEnd = true; }
    portion = portion.slice(0, args.maxSignatures - scannedThisRun);
    const pageFinished = portion.length === page.slice(0, stopAt >= 0 ? stopAt : page.length).length;
    for (let i = 0; i < portion.length; i += CHUNK) {
      const part = portion.slice(i, i + CHUNK);
      const v = await Launches.verify(rpc, part);
      totals.signatures += v.processed; totals.failedTx += v.stats.failedTx; totals.creates += v.stats.creates;
      for (const [k, n] of Object.entries(v.stats.skipped)) totals.skipped[k] = (totals.skipped[k] || 0) + n;
      for (const [k, n] of Object.entries(v.stats.rejected)) totals.rejected[k] = (totals.rejected[k] || 0) + n;
      totals.verified += v.relationships.length;
      for (const r of v.relationships) {
        perRoot.set(r.rootMint, (perRoot.get(r.rootMint) || 0) + 1);
        if (out) out.write(JSON.stringify(r) + '\n');
      }
      if (store && v.relationships.length) totals.written += (await Index.writeRelationships(store, v.relationships)).added;
      if (v.processed > 0) {
        const last = part[v.processed - 1];
        state.before = last.signature; oldestSlot = last.slot;
        state.scanned = (state.scanned || 0) + v.processed; scannedThisRun += v.processed;
        state.at = now();
        if (store) await Index.writeBackfill(store, Launches.SOURCE, state);
      }
      if (v.processed < part.length) { incomplete = true; break; }
    }
    if (incomplete) break;
    if (reachedEnd && pageFinished) {
      state.done = true; state.at = now();
      if (store) await Index.writeBackfill(store, Launches.SOURCE, state);
    }
    if (!page.length) break;
  }
  if (out) await new Promise((r) => out.end(r));
  return {
    mode: store ? 'WRITE' : 'DRY-RUN',
    source: Launches.SOURCE,
    candidates: args.candidates,
    fromSlot: state.fromSlot,
    headSlot: state.headSlot || null,
    resumed: Boolean(store && prevDone && prevDone.done !== true && !args.restart),
    oldestSlotReached: oldestSlot,
    resumeBefore: state.done ? null : state.before,
    done: state.done,
    incomplete,
    ...totals,
    distinctRoots: perRoot.size,
    topRoots: [...perRoot].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 15).map(([root, count]) => ({ root, count })),
    rpcRequests: rpc.stats ? rpc.stats.requests : null,
    runtimeSeconds: Math.round((now() - t0) / 100) / 10,
  };
}

if (require.main === module) {
  main().then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error('pump-backfill: ' + String((e && e.message) || e).slice(0, 300)); process.exit(1); });
}

module.exports = { main, parseArgs };
