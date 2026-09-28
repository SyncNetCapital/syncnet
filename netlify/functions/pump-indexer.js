'use strict';
/*
 * Scheduled Pump.fun (Solana, non-SOL quotes) incremental indexer (netlify.toml [functions."pump-indexer"]). No route.
 *
 *  - OFF unless SYNCNET_PUMP_DISCOVERY_ENABLED=true, a durable store exists and SYNCNET_SOLANA_RPC_URL is set.
 *  - Never scans history: without a checkpoint seeded by netlify/scripts/pump-backfill.js it does nothing.
 *  - Polls getSignaturesForAddress(mint authority) since the checkpoint (finalized), processes oldest -> newest, at
 *    most MAX_SIGNATURES_PER_RUN signatures per run in chunks of 50, 20 s budget; every chunk writes its verified
 *    relationships and then moves the checkpoint (compare-and-set, never to an older slot). Failed transactions and
 *    native-SOL launches are skipped; see netlify/lib/pump-launches.js for verification.
 *  - One run at a time (store lock, 55 s). Only sollaunch:v1:mainnet:PUMP_FUN:* keys are written — never PONS/PAR.
 */
const Index = require('../lib/solana-launch-index');
const Pump = require('../lib/pump-launches');
const { json } = require('../lib/respond');
const { log, logError } = require('../lib/log');
const { getStore } = require('../lib/store');
const { flags } = require('../lib/flags');
const { createSolanaRpc } = require('../lib/solana-rpc');

const FN = 'pump-indexer';
const BUDGET_MS = 20000;
const LOCK_SECONDS = 55;

async function handler(event = {}, deps = {}) {
  const env = deps.env || process.env;
  const store = deps.store || getStore();
  const gate = flags({ store, env });
  if (!gate.pumpDiscovery) return json(200, { ok: true, skipped: 'disabled' });
  const rpc = deps.rpc || createSolanaRpc({ env, timeoutMs: 8000, retries: 1 });
  if (!rpc) { log(FN, 'skipped', { reason: 'no-solana-rpc' }); return json(200, { ok: true, skipped: 'no-rpc' }); }
  const now = deps.now || Date.now;
  const lockKey = Index.K.lock(Pump.SOURCE);
  try {
    const locked = await store.cas({ expect: [[lockKey, null]], set: [[lockKey, String(now()), LOCK_SECONDS]] });
    if (!locked) return json(200, { ok: true, skipped: 'running' });
  } catch (err) {
    logError(FN, 'lock-failed', err);
    return json(503, { ok: false });
  }
  const started = now();
  let report;
  try {
    report = await Index.runIncremental({
      store, rpc, adapter: Pump.ADAPTER, now, deadline: started + (deps.budgetMs || BUDGET_MS),
      maxSignatures: deps.maxSignatures || Index.MAX_SIGNATURES_PER_RUN,
    });
    log(FN, 'indexed', { ...report, ms: now() - started });
  } catch (err) {
    logError(FN, 'run-failed', err);
    report = { source: Pump.SOURCE, status: 'failed' };
  }
  try { await store.del(lockKey); } catch { /* expires on its own */ }
  return json(200, { ok: report.status !== 'failed', report });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
