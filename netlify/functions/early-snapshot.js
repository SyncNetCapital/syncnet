'use strict';
/*
 * Scheduled EARLY maintenance (netlify.toml [functions."early-snapshot"] schedule = "5 * * * *"; no public route).
 *
 *  1. Daily audience snapshot (docs §13.1, UTC): for every enrolled creator that has no snapshot for TODAY, read
 *     channels.list(statistics,snippet) in batches of 50. The first successful read of the day is THE snapshot; later
 *     runs of the same day never replace it, and a day that ended without one is never backfilled. Each snapshot is a
 *     signed `audience-snapshot` attestation queued for the daily bundle. Hidden counts are recorded as hidden.
 *  2. Completes due wallet rotations (permissionless, same code path as any creator read).
 *  3. Reconciles young CONFIRMED receipts to FINALIZED / INVALIDATED_BY_REORG (the pending-finality index).
 *  Off unless SYNCNET_EARLY_ENABLED=true with a durable store and the attestation key configured. One run at a time
 *  (store lock), 20 s time budget; the hourly schedule catches up on anything left.
 */
const E = require('../../lib/syncnet-early.js');
const { json } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { serverRpc } = require('../lib/chain-rpc');
const { earlyConfig, signer: makeSigner } = require('../lib/early-config');
const Attest = require('../lib/early-attest');
const { makeYouTube } = require('../lib/early-youtube');
const early = require('./early');

const FN = 'early-snapshot';
const K = { ...early._internals.K, lock: 'early:snap-lock:v1', pendingFinal: 'early:pending-final:v1' };
const BUDGET_MS = 20000;
const LOCK_SECONDS = 120;
const MAX_CREATORS = 500;

async function handler(event = {}, deps = {}) {
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const cfg = earlyConfig({ env, store, now, keysFile: deps.keysFile, assetsFile: deps.assetsFile });
  if (!cfg.enabled) return json(200, { ok: true, skipped: 'disabled' });
  const signer = cfg.attestation.configured ? makeSigner(env, cfg) : null;
  const rpc = deps.rpc || serverRpc({ timeoutMs: 8000, retries: 1 });
  const yt = deps.youtube || (cfg.youtube.configured ? makeYouTube({ fetch: deps.fetch, apiKey: env.SYNCNET_YOUTUBE_API_KEY }) : null);
  try {
    const locked = await store.cas({ expect: [[K.lock, null]], set: [[K.lock, String(now()), LOCK_SECONDS]] });
    if (!locked) return json(200, { ok: true, skipped: 'running' });
  } catch (err) { logError(FN, 'lock-failed', err); return json(503, { ok: false }); }
  const started = now();
  const deadline = started + (deps.budgetMs || BUDGET_MS);
  const report = { creators: 0, rotationsCompleted: 0, snapshots: 0, snapshotsSkipped: 0, snapshotFailures: 0, reconciled: 0, finalized: 0, invalidated: 0, timedOut: false, noSigner: !signer, noYouTube: !yt };
  const ctx = { store, rpc, env, now, cfg, signer, event: {} };
  try {
    const t = Math.floor(now() / 1000), today = E.utcDate(t);
    const ids = (await store.smembers(K.creators)).slice(0, MAX_CREATORS);
    report.creators = ids.length;
    const need = [];
    for (const cid of ids) {
      if (now() > deadline) { report.timedOut = true; break; }
      const cr = await store.get(K.creator(cid));
      let c = null; try { c = cr ? JSON.parse(cr) : null; } catch { c = null; }
      if (!c) continue;
      if (c.status === 'ROTATION_PENDING' && signer) { const before = c.status; const after = await early._internals.maybeCompleteRotation(ctx, { raw: cr, value: c }); if (after && after.status !== before) report.rotationsCompleted++; }
      if (!(await store.get(K.snap(c.channelId, today)))) need.push(c); else report.snapshotsSkipped++;
    }
    // 1. snapshots: batches of 50 ids; the first success of the day wins (cas expects the day's key absent)
    if (signer && yt) {
      for (let i = 0; i < need.length && now() <= deadline; i += 50) {
        const batch = need.slice(i, i + 50);
        let found;
        try { found = await yt.channelsById(batch.map((c) => c.channelId)); } catch (err) { logError(FN, 'youtube-unavailable', err, { batch: batch.length }); report.snapshotFailures += batch.length; continue; }
        const t2 = Math.floor(now() / 1000), day = E.utcDate(t2);
        if (day !== today) { report.timedOut = true; break; } // the UTC day ended during the run: never record it as today's
        const bd = await Attest.bundleDateFor(store, t2);
        for (const c of batch) {
          const ch = found.get(c.channelId);
          if (!ch) { report.snapshotFailures++; continue; }
          try {
            const rec = Attest.build(signer, { type: 'audience-snapshot', subject: { channelId: c.channelId }, claims: { channelId: c.channelId, dateUTC: today, title: E.clean(ch.title, 80), subscriberCount: ch.hidden ? null : ch.subscriberCount, hiddenSubscriberCount: Boolean(ch.hidden), fetchedAt: t2, source: 'youtube-data-api-v3 channels.list statistics' }, issuedAt: t2, bundleDate: bd });
            const w = Attest.writesFor(rec);
            const ok = await store.cas({ expect: [[K.snap(c.channelId, today), null]], set: [[K.snap(c.channelId, today), JSON.stringify(rec)], ...w.set], sadd: [[K.snapDays(c.channelId), today], ...w.sadd] });
            if (ok) report.snapshots++; else report.snapshotsSkipped++;
            // refresh mutable display metadata (never identity): title / avatar / handle
            const cr = await store.get(K.creator(c.creatorId));
            if (cr) { const cur = JSON.parse(cr); const display = { title: E.clean(ch.title, 80), avatarUrl: ch.avatarUrl || cur.display.avatarUrl, handle: E.clean(ch.handle, 40) || cur.display.handle }; if (JSON.stringify(display) !== JSON.stringify(cur.display)) await store.cas({ expect: [[K.creator(c.creatorId), cr]], set: [[K.creator(c.creatorId), JSON.stringify({ ...cur, display, displayUpdatedAt: new Date(now()).toISOString() })]] }); }
          } catch (err) { logError(FN, 'snapshot-failed', err, { channel: hashId(c.channelId) }); report.snapshotFailures++; }
        }
      }
    } else if (need.length) log(FN, 'snapshots-skipped', { reason: !signer ? 'no attestation signer' : 'youtube not configured', pending: need.length });
    // 3. finality reconciliation of young receipts (pending-finality index: score = block number)
    let pending = [];
    try { pending = await store.zrevrangeByScore(K.pendingFinal, '+inf', '-inf', 200); } catch (err) { logError(FN, 'pending-index', err, {}); }
    for (const { member: receiptId } of pending) {
      if (now() > deadline) { report.timedOut = true; break; }
      const r = await early._handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: JSON.stringify({ action: 'reconcile', receiptId }) }, { store, env, rpc, now, keysFile: deps.keysFile, assetsFile: deps.assetsFile, internal: true });
      let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; }
      if (r.statusCode === 200 && j.status !== 'CONFIRMED') { report.reconciled++; if (j.status === 'FINALIZED') report.finalized++; if (j.status === 'INVALIDATED_BY_REORG') report.invalidated++; try { await store.zrem(K.pendingFinal, [receiptId]); } catch { /* next run */ } }
      if (r.statusCode === 404) { try { await store.zrem(K.pendingFinal, [receiptId]); } catch { /* next run */ } }
    }
  } catch (err) {
    logError(FN, 'run-failed', err, {});
  } finally {
    try { await store.del(K.lock); } catch { /* expires on its own */ }
  }
  log(FN, 'run', { ...report, ms: now() - started });
  return json(200, { ok: true, report });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K };
