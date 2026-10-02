'use strict';
/*
 * Scheduled EARLY anchoring (netlify.toml: [functions."early-anchor"] schedule = "20,50 * * * *"; no public route).
 *
 *  For every UTC day D < today whose bundle is not built yet (bounded look-back), BUILD the bundle: freeze the sorted,
 *  de-duplicated leaf set from early:bundle-queue:v1:<D>, compute the Merkle root (docs §10), store early:bundle:v1:<D>.
 *  A rebuild must reproduce the stored root (bundle-root-mismatch is logged and the day is left alone).
 *  A day with NO attestation leaves is never built, anchored or submitted to OpenTimestamps: nothing is persisted for
 *  it, and any empty bundle record that already exists (an earlier version built them) is ignored by every step below.
 *  Then for every BUILT bundle without a confirmed Robinhood anchor: send the ONE server-signed transaction — a
 *  zero-value self-transfer from the registry anchor address carrying 'SYNC' ‖ 0x01 ‖ root ‖ date — after strict
 *  validation (netlify/lib/early-tx.js), never twice while a previous attempt is pending, never above the gas ceiling.
 *  Independently, submit the root to OpenTimestamps ("submitted at …; Bitcoin-verifiable later") and, for recent
 *  bundles, try an upgrade. Kill switches: SYNCNET_EARLY_ANCHOR_DISABLED (chain tx only), SYNCNET_EARLY_ENABLED.
 */
const E = require('../../lib/syncnet-early.js');
const { json } = require('../lib/respond');
const { log, logError } = require('../lib/log');
const { getStore } = require('../lib/store');
const { serverRpc } = require('../lib/chain-rpc');
const { earlyConfig, anchorSigner } = require('../lib/early-config');
const Attest = require('../lib/early-attest');
const Tx = require('../lib/early-tx');
const Ots = require('../lib/early-ots');
const PhChain = require('../lib/project-home-chain');

const FN = 'early-anchor';
const K = { ...Attest.K, lock: 'early:anchor-lock:v1' };
const LOCK_SECONDS = 240;
const BUDGET_MS = 25000;
const LOOKBACK_DAYS = 30;
const SCAN_DAYS = 120; // newest bundle records examined per run to find up to LOOKBACK_DAYS non-empty ones
const UPGRADE_DAYS = 14;
const PENDING_TX_WAIT_S = 3600; // an unconfirmed anchor tx is left alone for an hour before a new attempt

const prevDay = (d) => new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
async function getJson(store, key) { const raw = await store.get(key); if (!raw) return { raw: null, value: null }; try { return { raw, value: JSON.parse(raw) }; } catch { return { raw, value: null }; } }

/** True for a bundle with no leaves (or an unreadable record): such a bundle is never anchored, submitted or upgraded. */
const isEmptyBundle = (b) => !b || b.leafCount === 0 || !Array.isArray(b.leaves) || b.leaves.length === 0;

/**
 * Builds (freezes) the bundle for day D from its queue. Deterministic; idempotent.
 * A day with zero leaves persists NOTHING and returns {built:false, empty:true}; if a leaf is queued for it later, the
 * next run builds it then.
 */
async function buildBundle(store, d, nowIso) {
  const existing = await getJson(store, K.bundle(d));
  if (existing.value) {
    if (isEmptyBundle(existing.value)) return { built: false, empty: true, bundle: existing.value }; // legacy empty record: left as is, ignored
    const again = E.merkleRoot(E.sortLeaves(existing.value.leaves), d);
    if (again !== existing.value.root) { log(FN, 'bundle-root-mismatch', { date: d }); return { built: false, mismatch: true }; }
    return { built: false, bundle: existing.value };
  }
  const leaves = E.sortLeaves(await store.smembers(K.queue(d)));
  if (!leaves.length) return { built: false, empty: true };
  const root = E.merkleRoot(leaves, d);
  const bundle = { schema: E.SCHEMA.bundle, date: d, leafType: E.LEAF_ATTESTATION, leaves, leafCount: leaves.length, root, builtAt: nowIso, anchors: { robinhood: null, opentimestamps: null } };
  const ok = await store.cas({ expect: [[K.bundle(d), null]], set: [[K.bundle(d), JSON.stringify(bundle)]], sadd: [[K.bundles, d]] });
  if (!ok) return { built: false, bundle: (await getJson(store, K.bundle(d))).value };
  log(FN, 'bundle-built', { date: d, leaves: leaves.length, root });
  return { built: true, bundle };
}

async function anchorOnChain(store, rpc, signer, b, now) {
  const cur = await getJson(store, K.bundle(b.date));
  const bundle = cur.value;
  if (isEmptyBundle(bundle)) return 'empty'; // defence in depth: an empty bundle is never anchored
  const r = PhChain.bounded(rpc, 8);
  await PhChain.assertChain(r);
  const rh = bundle.anchors.robinhood;
  if (rh && rh.status === 'confirmed') return 'already';
  if (rh && rh.status === 'sent') {
    const rcpt = await PhChain.receipt(r, rh.txHash);
    if (rcpt) {
      const blk = await PhChain.block(r, BigInt(rcpt.blockNumber));
      const next = { ...bundle, anchors: { ...bundle.anchors, robinhood: { ...rh, status: E.lc(rcpt.status) === '0x1' ? 'confirmed' : 'failed', blockNumber: BigInt(rcpt.blockNumber).toString(), blockHash: E.lc(rcpt.blockHash), blockTimestamp: blk ? Number(blk.timestamp) : null, confirmedAt: new Date(now()).toISOString() } } };
      await store.cas({ expect: [[K.bundle(b.date), cur.raw]], set: [[K.bundle(b.date), JSON.stringify(next)]] });
      log(FN, next.anchors.robinhood.status === 'confirmed' ? 'anchor-confirmed' : 'anchor-tx-failed', { date: b.date, tx: rh.txHash });
      return next.anchors.robinhood.status;
    }
    if (now() - Date.parse(rh.sentAt) < PENDING_TX_WAIT_S * 1000) return 'pending';
    // the earlier broadcast never mined within an hour: a new attempt (same nonce would replace; we read the nonce again)
  }
  const nonce = BigInt(await r('eth_getTransactionCount', [signer.address, 'pending']));
  const quotedGasPrice = BigInt(await r('eth_gasPrice', []));
  // the latest block's base fee, when the RPC reports one (best effort): the quote can lag it by the time we broadcast
  let baseFee = 0n;
  try { const head = await r('eth_getBlockByNumber', ['latest', false]); if (head && /^0x[0-9a-fA-F]{1,32}$/.test(String(head.baseFeePerGas || ''))) baseFee = BigInt(head.baseFeePerGas); } catch { baseFee = 0n; }
  // max(quote, base fee) + 50 % headroom; THROWS above the 5 gwei ceiling (fail closed, nothing recorded, retried next run)
  const gasPrice = Tx.anchorGasPrice(quotedGasPrice, baseFee);
  const data = E.anchorCalldata(bundle.root, b.date);
  let estimate = 60000n;
  try { estimate = BigInt(await r('eth_estimateGas', [{ from: signer.address, to: signer.address, value: '0x0', data }])); } catch { estimate = 60000n; }
  const gasLimit = estimate + estimate / 5n; // 20 % headroom, still capped by early-tx.js
  const tx = Tx.anchorTransaction({ signer, chainId: E.CHAIN_ID, nonce, gasPrice, gasLimit, root: bundle.root, date: b.date });
  const marked = { ...bundle, anchors: { ...bundle.anchors, robinhood: { status: 'sent', txHash: tx.hash, from: signer.address, nonce: nonce.toString(), gasPrice: gasPrice.toString(), quotedGasPrice: quotedGasPrice.toString(), baseFee: baseFee.toString(), gasLimit: gasLimit.toString(), sentAt: new Date(now()).toISOString(), attempts: ((rh && rh.attempts) || 0) + 1 } } };
  // write-ahead: the attempt is recorded BEFORE the broadcast, so a crash can never lead to a second send
  const ok = await store.cas({ expect: [[K.bundle(b.date), cur.raw]], set: [[K.bundle(b.date), JSON.stringify(marked)]] });
  if (!ok) return 'conflict';
  const sent = await r('eth_sendRawTransaction', [tx.raw]);
  if (E.lc(sent) !== E.lc(tx.hash)) log(FN, 'anchor-hash-mismatch', { date: b.date, expected: tx.hash, got: String(sent).slice(0, 70) });
  log(FN, 'anchor-sent', { date: b.date, tx: tx.hash, nonce: nonce.toString(), gasLimit: gasLimit.toString() });
  return 'sent';
}

async function submitOts(store, fetchImpl, b, now, calendars) {
  const cur = await getJson(store, K.bundle(b.date));
  const bundle = cur.value;
  if (isEmptyBundle(bundle)) return 'empty'; // defence in depth: an empty bundle is never submitted to OpenTimestamps
  if (bundle.anchors.opentimestamps && bundle.anchors.opentimestamps.proof) return 'already';
  const res = await Ots.submit(bundle.root, { fetch: fetchImpl, calendars, now });
  const ots = { submittedAt: res.submittedAt, calendars: res.calendars, proof: res.proof, status: Ots.status(bundle.root, res.proof), note: 'Submitted to OpenTimestamps at submittedAt; becomes Bitcoin-verifiable later (typically within hours). Not Bitcoin-anchored yet unless status says so.' };
  await store.cas({ expect: [[K.bundle(b.date), cur.raw]], set: [[K.bundle(b.date), JSON.stringify({ ...bundle, anchors: { ...bundle.anchors, opentimestamps: ots } })]] });
  log(FN, res.proof ? 'ots-submitted' : 'ots-failed', { date: b.date, ok: res.calendars.filter((c) => c.ok).length });
  return res.proof ? 'submitted' : 'failed';
}
async function upgradeOts(store, fetchImpl, b, now) {
  const cur = await getJson(store, K.bundle(b.date));
  const bundle = cur.value;
  if (isEmptyBundle(bundle)) return 'skip';
  const o = bundle.anchors.opentimestamps;
  if (!o || !o.proof || o.status === 'bitcoin-verifiable') return 'skip';
  const up = await Ots.upgrade(bundle.root, o.proof, { fetch: fetchImpl });
  if (!up.upgraded) return 'pending';
  const next = { ...o, proof: up.proof, status: up.bitcoin ? 'bitcoin-verifiable' : 'submitted', upgradedAt: new Date(now()).toISOString(), bitcoinHeights: Ots.bitcoinHeights(bundle.root, up.proof) };
  await store.cas({ expect: [[K.bundle(b.date), cur.raw]], set: [[K.bundle(b.date), JSON.stringify({ ...bundle, anchors: { ...bundle.anchors, opentimestamps: next } })]] });
  log(FN, 'ots-upgraded', { date: b.date, bitcoin: up.bitcoin });
  return next.status;
}

async function handler(event = {}, deps = {}) {
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const cfg = earlyConfig({ env, store, now, keysFile: deps.keysFile, assetsFile: deps.assetsFile });
  if (!cfg.enabled) return json(200, { ok: true, skipped: 'disabled' });
  const rpc = deps.rpc || serverRpc({ timeoutMs: 8000, retries: 1 });
  const signer = cfg.anchorEnabled ? anchorSigner(env, cfg) : null;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const calendars = deps.calendars;
  try {
    const locked = await store.cas({ expect: [[K.lock, null]], set: [[K.lock, String(now()), LOCK_SECONDS]] });
    if (!locked) return json(200, { ok: true, skipped: 'running' });
  } catch (err) { logError(FN, 'lock-failed', err); return json(503, { ok: false }); }
  const started = now(), deadline = started + (deps.budgetMs || BUDGET_MS);
  const report = { built: [], anchored: {}, ots: {}, upgraded: {}, skippedEmpty: 0, anchorDisabled: !signer, errors: [] };
  try {
    const today = E.utcDate(Math.floor(now() / 1000));
    // 1. build every unbuilt day before today (bounded look-back), oldest first
    const days = [];
    for (let d = prevDay(today), i = 0; i < LOOKBACK_DAYS; d = prevDay(d), i++) days.unshift(d);
    for (const d of days) {
      if (now() > deadline) break;
      const b = await buildBundle(store, d, new Date(now()).toISOString());
      if (b.built) report.built.push(d);
    }
    // 2. anchor + OTS for built bundles without a confirmed anchor / a proof (newest first). Empty bundle records (left by
    //    an earlier version) are filtered out BEFORE the window is applied, so they can neither be anchored/submitted nor
    //    crowd a real bundle out of the newest-LOOKBACK_DAYS window.
    const dates = (await store.smembers(K.bundles)).sort().reverse().slice(0, SCAN_DAYS);
    const built = [];
    for (const d of dates) {
      if (now() > deadline || built.length >= LOOKBACK_DAYS) break;
      const b = (await getJson(store, K.bundle(d))).value;
      if (!b) continue;
      if (isEmptyBundle(b)) { report.skippedEmpty++; continue; }
      built.push(b);
    }
    for (const b of built) {
      if (now() > deadline) break;
      const d = b.date;
      if (signer && !(b.anchors.robinhood && b.anchors.robinhood.status === 'confirmed')) {
        try { report.anchored[d] = await anchorOnChain(store, rpc, signer, b, now); } catch (err) { logError(FN, 'anchor-failed', err, { date: d }); report.anchored[d] = 'error'; report.errors.push('anchor ' + d); }
      }
      if (!(b.anchors.opentimestamps && b.anchors.opentimestamps.proof)) {
        try { report.ots[d] = await submitOts(store, fetchImpl, b, now, calendars); } catch (err) { logError(FN, 'ots-submit-failed', err, { date: d }); report.ots[d] = 'error'; }
      }
    }
    // 3. OTS upgrades for recent bundles
    for (const b of built.slice(0, UPGRADE_DAYS)) {
      if (now() > deadline) break;
      try { const s = await upgradeOts(store, fetchImpl, b, now); if (s !== 'skip') report.upgraded[b.date] = s; } catch (err) { logError(FN, 'ots-upgrade-failed', err, { date: b.date }); }
    }
  } catch (err) {
    logError(FN, 'run-failed', err, {});
    report.errors.push('run');
  } finally {
    try { await store.del(K.lock); } catch { /* expires */ }
  }
  log(FN, 'run', { built: report.built.length, anchored: Object.keys(report.anchored).length, ms: now() - started, anchorDisabled: report.anchorDisabled });
  return json(200, { ok: report.errors.length === 0, report });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, buildBundle, anchorOnChain, submitOts, upgradeOts, isEmptyBundle };
