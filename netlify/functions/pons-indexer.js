'use strict';
/*
 * Scheduled PONS V2 incremental indexer (netlify.toml [functions."pons-indexer"] schedule). No public route.
 *
 *  - OFF unless SYNCNET_PONS_DISCOVERY_ENABLED=true and a durable store exists.
 *  - Never scans history: a stack whose cursor has not been seeded by netlify/scripts/pons-backfill.js is skipped.
 *  - One run at a time (store lock, 55 s), at most MAX_BLOCKS_PER_RUN blocks per stack, 20 s time budget; every
 *    completed chunk writes its launches and then its cursor, so an interrupted run resumes where it stopped.
 *  - Confirmation lag, cursor blockHash integrity, reorg rewind + journal undo: see netlify/lib/pons-index.js.
 *  - Only the PONS keys (pons2:*) are written. PAR data is never read or written here.
 */
const Index = require('../lib/pons-index');
const { json } = require('../lib/respond');
const { log, logError } = require('../lib/log');
const { getStore } = require('../lib/store');
const { flags } = require('../lib/flags');
const { serverRpc } = require('../lib/chain-rpc');

const FN = 'pons-indexer';
const BUDGET_MS = 20000;
const LOCK_SECONDS = 55;

async function handler(event = {}, deps = {}) {
  const store = deps.store || getStore();
  const gate = flags({ store, env: deps.env || process.env });
  if (!gate.ponsDiscovery) return json(200, { ok: true, skipped: 'disabled' });
  const now = deps.now || Date.now;
  try {
    const locked = await store.cas({ expect: [[Index.K.lock, null]], set: [[Index.K.lock, String(now()), LOCK_SECONDS]] });
    if (!locked) return json(200, { ok: true, skipped: 'running' });
  } catch (err) {
    logError(FN, 'lock-failed', err);
    return json(503, { ok: false });
  }
  const started = now();
  const report = await Index.runIncremental({
    store, rpc: deps.rpc || serverRpc({ timeoutMs: 8000, retries: 0 }), now,
    deadline: started + (deps.budgetMs || BUDGET_MS), sleep: deps.sleep,
  });
  for (const r of report) {
    if (r.status === 'failed') logError(FN, 'stack-failed', new Error(r.error), { stack: r.stack });
    else log(FN, 'indexed', { ...r, ms: now() - started });
  }
  try { await store.del(Index.K.lock); } catch { /* expires on its own */ }
  return json(200, { ok: report.every((r) => r.status !== 'failed'), report });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
