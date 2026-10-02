'use strict';
/*
 * Scheduled EARLY maintenance (netlify.toml [functions."early-snapshot"] schedule = "5 * * * *"; no public route).
 *
 *  1. Daily audience snapshot (docs §13.1, UTC): for every enrolled creator that has no snapshot for TODAY, read
 *     channels.list(statistics,snippet) in batches of 50. The first successful read of the day is THE snapshot; later
 *     runs of the same day never replace it, and a day that ended without one is never backfilled. Each snapshot is a
 *     signed `audience-snapshot` attestation queued for the daily bundle. Hidden counts are recorded as hidden.
 *     X creators (only when X is explicitly enabled) are read in batches of 100 through GET /2/users (public_metrics) and
 *     recorded as dated FOLLOWER counts; each attempt counts against the X daily request allowance, platforms are
 *     isolated (YouTube first; an X outage or exhausted allowance never blocks YouTube) and a missing figure is never guessed.
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
const { limit } = require('../lib/ratelimit');
const { earlyConfig, signer: makeSigner, platformEnabled } = require('../lib/early-config');
const Attest = require('../lib/early-attest');
const { makeYouTube } = require('../lib/early-youtube');
const Platforms = require('../lib/early-platforms');
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
  // X is read only when it is explicitly enabled AND its app-only credential exists; otherwise its creators are skipped (never failed)
  const xc = platformEnabled(cfg, 'x') ? (deps.x || Platforms.clientFor('x', env, deps.fetch)) : null;
  const report = { creators: 0, rotationsCompleted: 0, snapshots: 0, snapshotsSkipped: 0, snapshotFailures: 0, reconciled: 0, finalized: 0, invalidated: 0, timedOut: false, noSigner: !signer, noYouTube: !yt, noX: !xc, byPlatform: {} };
  const clients = { ...(yt ? { youtube: yt } : {}), ...(xc ? { x: xc } : {}) }; // platform -> its configured API client
  const tally = (platform, field) => { const p = report.byPlatform[platform] || (report.byPlatform[platform] = { snapshots: 0, failures: 0 }); p[field]++; };
  const xBudget = deps.xBudget || cfg.xBudget;
  const refOfCreator = (c) => { const p = c.platform || E.PLATFORM; return E.isExternalId(p, c.channelId) ? E.refOf(p, c.channelId) : null; };
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
      const ref = refOfCreator(c);
      if (!ref) { report.snapshotFailures++; continue; }
      if (!(await store.get(K.snap(ref, today)))) need.push(c); else report.snapshotsSkipped++;
    }
    // 1. snapshots, one platform at a time (its adapter's batch size); the first success of the day wins (cas expects the
    //    day's key absent). A platform with no adapter or no configured client is skipped, never guessed.
    //    YouTube goes first and every platform is isolated: one platform's outage, budget or error never blocks another.
    const order = [...new Set(need.map((c) => c.platform || E.PLATFORM))].sort((a, b) => (a === E.PLATFORM ? -1 : b === E.PLATFORM ? 1 : a < b ? -1 : 1));
    for (const platform of order) {
      const group = need.filter((c) => (c.platform || E.PLATFORM) === platform);
      const ad = Platforms.adapterOf(platform), client = clients[platform];
      if (!signer || !ad || !client) { log(FN, 'snapshots-skipped', { platform, reason: !signer ? 'no attestation signer' : !ad ? 'no adapter' : platform + ' not configured', pending: group.length }); continue; }
      for (let i = 0; i < group.length && now() <= deadline; i += ad.batchSize) {
        const batch = group.slice(i, i + ad.batchSize);
        let found;
        if (ad.metered) {
          // spend guard: every attempt (success or failure) is one metered API request against the global daily allowance
          const g = await limit(store, { bucket: 'early-x-api-day', id: 'snapshot', limit: xBudget.snapshotRequestsPerDay, windowSeconds: 86400, now });
          if (!g.allowed) { log(FN, 'budget-exhausted', { platform, pending: group.length - i }); report.budgetExhausted = true; break; }
        }
        try { found = await ad.fetchMany(client, batch.map((c) => c.channelId)); } catch (err) { logError(FN, platform + '-unavailable', err, { batch: batch.length }); report.snapshotFailures += batch.length; for (let n = 0; n < batch.length; n++) tally(platform, 'failures'); continue; }
        const t2 = Math.floor(now() / 1000), day = E.utcDate(t2);
        if (day !== today) { report.timedOut = true; break; } // the UTC day ended during the run: never record it as today's
        const bd = await Attest.bundleDateFor(store, t2);
        for (const c of batch) {
          const ch = found.get(c.channelId);
          if (!ch) { report.snapshotFailures++; tally(platform, 'failures'); continue; }
          try {
            const ref = refOfCreator(c);
            const snapRec = ad.dailySnapshot(c.channelId, ch, today, t2);
            if (!snapRec) { report.snapshotFailures++; tally(platform, 'failures'); continue; } // no audience figure returned: nothing is recorded
            const rec = Attest.build(signer, { type: 'audience-snapshot', subject: snapRec.subject, claims: snapRec.claims, issuedAt: t2, bundleDate: bd });
            const w = Attest.writesFor(rec);
            const ok = await store.cas({ expect: [[K.snap(ref, today), null]], set: [[K.snap(ref, today), JSON.stringify(rec)], ...w.set], sadd: [[K.snapDays(ref), today], ...w.sadd] });
            if (ok) { report.snapshots++; tally(platform, 'snapshots'); } else report.snapshotsSkipped++;
            // refresh mutable display metadata (never identity): title / avatar / handle
            const cr = await store.get(K.creator(c.creatorId));
            if (cr) { const cur = JSON.parse(cr); const display = ad.refreshDisplay(ch, cur.display); if (JSON.stringify(display) !== JSON.stringify(cur.display)) await store.cas({ expect: [[K.creator(c.creatorId), cr]], set: [[K.creator(c.creatorId), JSON.stringify({ ...cur, display, displayUpdatedAt: new Date(now()).toISOString() })]] }); }
          } catch (err) { logError(FN, 'snapshot-failed', err, { channel: hashId(c.channelId) }); report.snapshotFailures++; tally(platform, 'failures'); }
        }
      }
    }
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
