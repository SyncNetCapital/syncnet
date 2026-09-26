'use strict';
/*
 * SyncNet Project Home — activation payments, entitlement and signed site writes.
 *
 *   GET  /api/project-home?view=config
 *   GET  /api/project-home?view=status&token=0x…        entitlement, current site pointer, open intent
 *   GET  /api/project-home?view=intent&id=0x…
 *   GET  /api/project-home?view=revisions&token=0x…     immutable revision history (audit / recovery)
 *   GET  /api/project-home?view=revision&id=0x…
 *   GET  /api/project-home?view=activations             append-only activation registry export
 *   GET  /api/project-home?view=metrics                 truthful payment metrics (verified vs everything in the sink)
 *   POST /api/project-home {action:'intent'|'verify'|'reconcile'|'publish'|'unpublish', …}
 *
 * Economic model: PROJECT HOME ACTIVATION is priced at $49 USD (reviewed price version), paid ONLY in $SYNC at the
 * SYNCNET REFERENCE RATE (reviewed rate version — not an oracle), to the immutable SyncNetProjectHomeSink (60% burned
 * on settle(), 40% to the SyncNet protocol treasury). One-time, per token, non-refundable; bound to the TOKEN, never to
 * the payer. After activation every content operation is free.
 *
 * Trust model:
 *  - authority comes ONLY from the CURRENT Project Passport operator (mp:passport:v1:<token>, Marketplace-owned, READ
 *    ONLY here). Never from the payer, a holder, the deployer, the fee recipient, operatorAtActivation or socials;
 *  - every write is an EIP-712 signature in the "SyncNet Website" domain, verified server-side (ECDSA, then EIP-1271);
 *  - the client never supplies project facts, chain, token, sink, price, rate, amount or tag (extra fields → 400);
 *  - payments are verified from Robinhood Chain (4663) with targeted reads only; RPC failure → no state change;
 *  - the critical transitions are ONE atomic compare-and-set (store.cas: a fixed Lua script on Upstash). One chain
 *    payment log can activate at most one project, and a project at most once;
 *  - everything is CLOSED unless SYNCNET_PROJECT_HOME_ENABLED / _PAYMENTS_ENABLED and their prerequisites are set
 *    (netlify/lib/project-home-config.js). No refunds exist in the protocol.
 */
const crypto = require('crypto');
const Core = require('../../lib/syncnet-core.js');
const Chain = require('../../lib/syncnet-chain.js');
const Site = require('../../lib/syncnet-site.js');
const Pricing = require('../../lib/syncnet-project-home-pricing.js');
const PhChain = require('../lib/project-home-chain');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit, limitAll } = require('../lib/ratelimit');
const { serverRpc } = require('../lib/chain-rpc');
const { readJsonBody, query, method: methodOf } = require('../lib/body');
const { verifyDigest } = require('../lib/sig-verify');
const { liveProject, readPassport, passportKey } = require('../lib/live-project');
const { projectHomeConfig, CHAIN_ID, CANONICAL_SYNC } = require('../lib/project-home-config');

const FN = 'project-home';
const K = {
  intent: (id) => `site:intent:v1:${id}`,
  intentsOf: (t) => `site:intents:v1:${t}`,
  open: (t) => `site:open:v1:${t}`,
  amount: (wei) => `site:amt:v1:${wei}`,
  rate: (v) => `site:rate:v1:${v}`,
  price: (v) => `site:price:v1:${v}`,
  paylog: (h, i) => `site:paylog:v1:${h}:${i}`,
  entitlement: (t) => `site:entitlement:v1:${t}`,
  activation: (h, i) => `site:act:v1:${h}:${i}`,
  activations: 'site:acts:v1',
  activationsOf: (t) => `site:acts:v1:${t}`,
  audit: (t) => `site:audit:v1:${t}`,
  complimentary: 'site:comp:v1',
  cfg: (h) => `site:cfg:v1:${h}`,
  rev: (id) => `site:rev:v1:${id}`,
  cur: (t) => `site:cur:v1:${t}`,
  revs: (t) => `site:revs:v1:${t}`,
  nonce: (w, n) => `site:nonce:v1:${w}:${n}`,
  img: (cid) => `site:img:v1:${cid}`,
  passport: passportKey, // Marketplace-owned: READ ONLY (only ever an expectation in cas, never written)
};
const LOCK = Pricing.LOCK_SECONDS; // 30 minutes
const CLOCK_SKEW = 120; // tolerated difference between the server clock and block timestamps (seconds)
const AMOUNT_TTL = LOCK + 2 * CLOCK_SKEW + 600; // an exact amount stays reserved beyond any window it could match in
const INTENT_TTL = 90 * 86400; // unconsumed intents; activations are copied into the durable registry
const NONCE_TTL = 90 * 86400;
const MAX_REVISIONS = 200;
const MAX_EXPORT = 2000;
const PAID_STATES = new Set(['ACTIVE', 'FINALIZED']);
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isAddr = (v) => /^0x[0-9a-f]{40}$/.test(lc(v));
const isB32 = (v) => /^0x[0-9a-f]{64}$/.test(lc(v));
const isTx = isB32;
const CLOSED = 'Project Home is not enabled on this deployment.';
const PAY_CLOSED = 'Project Home activation payments are not open on this deployment.';
const UNAVAILABLE = 'Project Home is temporarily unavailable.';
const CHAIN_DOWN = 'Robinhood Chain could not be read right now. Nothing was changed. Try again.';

const bad = (message) => publicError(400, 'invalid_request', message || 'Invalid request.');
async function getJson(store, key) {
  const raw = await store.get(key);
  if (!raw) return { raw: null, value: null };
  try { return { raw, value: JSON.parse(raw) }; } catch { return { raw, value: null }; }
}
/** Rejects any body key outside `allowed` — clients cannot smuggle a price, rate, amount, sink, chain or tag. */
function onlyFields(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  return extra.length ? bad('Unexpected field: ' + extra[0].slice(0, 40) + '. The server derives it.') : null;
}

// ---------------------------------------------------------------- signature (EIP-712 "SyncNet Website", ECDSA + EIP-1271)
async function verifySig(rpc, wallet, kind, message, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,8190}$/.test(signature)) return false;
  let digest;
  try { digest = Site.digest(kind, message); } catch { return false; }
  return verifyDigest(rpc, wallet, digest, signature);
}
function signedEnvelope(b, now) {
  const token = lc(b.token), operator = lc(b.operator), nonce = lc(b.nonce);
  const issuedAt = Number(b.issuedAt);
  if (!isAddr(token)) return { error: bad('Invalid token address.') };
  if (!isAddr(operator)) return { error: bad('Invalid operator address.') };
  if (!isB32(nonce)) return { error: bad('Invalid nonce.') };
  if (!Number.isSafeInteger(issuedAt) || Math.abs(issuedAt - Math.floor(now / 1000)) > Site.MAX_SKEW) {
    return { error: bad('issuedAt must be within ' + Site.MAX_SKEW + ' seconds of the current time. Check your device clock and sign again.') };
  }
  return { token, operator, nonce, issuedAt };
}

// ---------------------------------------------------------------- public views
const displayUsd = (cents) => (cents / 100).toFixed(2);
function publicIntent(i) {
  if (!i) return null;
  return {
    requestId: i.requestId, token: i.token, operatorAtRequest: i.operatorAtRequest, chainId: i.chainId, canonicalSync: i.canonicalSync, sink: i.sink,
    priceUsdCents: i.priceUsdCents, priceUsd: displayUsd(i.priceUsdCents), priceVersion: i.priceVersion,
    rateLabel: 'SYNCNET REFERENCE RATE', syncUsdReferenceRate: i.syncUsdReferenceRate, rateVersion: i.rateVersion, rateEffectiveAt: i.rateEffectiveAt,
    baseSyncAmount: i.baseSyncAmount, exactTaggedSyncAmount: i.exactTaggedSyncAmount, exactTaggedSyncDisplay: Pricing.formatUnits(i.exactTaggedSyncAmount),
    createdAt: i.createdAt, createdBlock: i.createdBlock, expiresAt: i.expiresAt, lockedUntil: i.expiresAt, status: i.status,
    observed: i.observed || null, consumedBy: i.consumedBy || null,
    split: { burnPercent: 60, treasuryPercent: 40, note: 'Paid SYNC is COMMITTED TO THE PROJECT HOME SINK. 60% is COMMITTED TO BURN and is burned only when the sink is settled; 40% goes to the SyncNet protocol treasury.' },
    refund: 'Non-refundable after successful activation. There is no refund mechanism.',
  };
}
function publicEntitlement(e) {
  if (!e) return null;
  return { ...e, label: e.kind === 'complimentary' ? 'COMPLIMENTARY' : 'PAID', countsAsRevenue: e.kind === 'paid', lifetime: 'ONE-TIME PROJECT HOME ACTIVATION · active for as long as SyncNet operates the Project Home service' };
}
const publicCur = (c) => c && { token: c.token, state: c.state, revisionId: c.revisionId || null, configHash: c.configHash || null, signer: c.signer, issuedAt: c.issuedAt, at: c.at };

// =====================================================================================================================
async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const rpc = deps.rpc || serverRpc({ retries: 2 });
  const ip = clientIp(event);
  const cfg = projectHomeConfig({ env, store, now, file: deps.pricingFile });
  const casOk = typeof store.cas === 'function';
  const denied = (rl) => (rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter));
  const ctx = { store, rpc, env, now, cfg, ip, random: deps.random || ((n) => crypto.randomBytes(n)) };

  if (method === 'GET') {
    const rl = await limit(store, { bucket: 'ph-read', id: ip, limit: 120, windowSeconds: 60 });
    if (!rl.allowed) return denied(rl);
    const view = query(event, 'view') || 'config';
    try {
      if (view === 'config') return json(200, configView(cfg));
      if (!cfg.siteEnabled) return json(200, { enabled: false, note: CLOSED });
      return await readView(view, event, ctx);
    } catch (err) {
      logError(FN, 'read-failed', err, { view: String(view).slice(0, 24) });
      return publicError(503, 'unavailable', UNAVAILABLE);
    }
  }

  if (method !== 'POST') return publicError(405, 'method_not_allowed', 'GET or POST only.', { allow: 'GET, POST' });
  if (!cfg.siteEnabled || !casOk) return publicError(503, 'closed', CLOSED);
  const rl = await limitAll(store, [
    { bucket: 'ph-write', id: ip, limit: 20, windowSeconds: 60 },
    { bucket: 'ph-write-h', id: ip, limit: 200, windowSeconds: 3600 },
  ]);
  if (!rl.allowed) return denied(rl);
  const b = readJsonBody(event, 16384);
  if (!b || typeof b.action !== 'string') return bad('A JSON body with an action is required.');
  try {
    if (b.action === 'intent') return await createIntent(b, ctx);
    if (b.action === 'verify') return await verifyPayment(b, ctx);
    if (b.action === 'reconcile') return await reconcile(b, ctx);
    if (b.action === 'publish') return await publish(b, ctx);
    if (b.action === 'unpublish') return await unpublish(b, ctx);
    return bad('Unknown action.');
  } catch (err) {
    logError(FN, 'write-crashed', err, { action: String(b.action).slice(0, 24) });
    return publicError(503, 'unavailable', UNAVAILABLE);
  }
}

function configView(cfg) {
  const out = {
    enabled: cfg.siteEnabled, payments: cfg.paymentsEnabled, chainId: CHAIN_ID, canonicalSync: CANONICAL_SYNC, sink: cfg.sink,
    product: 'PROJECT HOME · ONE-TIME ACTIVATION', lockSeconds: LOCK, domain: Site.DOMAIN,
    split: { burnPercent: 60, treasuryPercent: 40 }, refund: 'Non-refundable after successful activation.',
    price: cfg.price ? { priceUsdCents: cfg.price.priceUsdCents, priceUsd: displayUsd(cfg.price.priceUsdCents), priceVersion: cfg.price.priceVersion } : null,
    rate: cfg.rate ? { label: 'SYNCNET REFERENCE RATE', syncUsdReferenceRate: cfg.rate.syncUsdReferenceRate, rateVersion: cfg.rate.rateVersion, updatedAt: cfg.rate.rateEffectiveAt, expiresAt: cfg.rate.rateExpiresAt, note: 'A server-controlled reference rate reviewed by SyncNet. It is not an on-chain oracle.' } : null,
    quote: null,
  };
  if (cfg.price && cfg.rate) {
    try {
      const base = Pricing.baseSyncWei(cfg.price.priceUsdCents, BigInt(cfg.rate.rateUsdE18));
      out.quote = { baseSyncAmount: base.toString(), approxSync: Pricing.displaySync(base), note: 'Indicative. The exact amount is locked in a payment intent for 30 minutes.' };
    } catch { out.quote = null; }
  }
  return out;
}

// ---------------------------------------------------------------- GET views
async function readView(view, event, { store, rpc, cfg }) {
  if (view === 'status') {
    const token = lc(query(event, 'token'));
    if (!isAddr(token)) return bad('Invalid token address.');
    const [ent, cur, open, passport] = await Promise.all([getJson(store, K.entitlement(token)), getJson(store, K.cur(token)), store.get(K.open(token)), readPassport(store, token)]);
    const intent = open ? (await getJson(store, K.intent(open))).value : null;
    const recent = (await store.smembers(K.intentsOf(token))).slice(0, 20);
    return json(200, {
      enabled: true, token, entitlement: publicEntitlement(ent.value), site: publicCur(cur.value), openIntent: publicIntent(intent),
      intents: recent, passport: passport ? { operator: lc(passport.operator), operatorSince: passport.operatorSince || null } : null,
    });
  }
  if (view === 'intent') {
    const id = lc(query(event, 'id'));
    if (!isB32(id)) return bad('Invalid intent id.');
    const i = (await getJson(store, K.intent(id))).value;
    return i ? json(200, { enabled: true, intent: publicIntent(i) }) : publicError(404, 'not_found', 'Intent not found.');
  }
  if (view === 'revisions') {
    const token = lc(query(event, 'token'));
    if (!isAddr(token)) return bad('Invalid token address.');
    const ids = (await store.smembers(K.revs(token))).slice(0, MAX_REVISIONS);
    const revs = (await Promise.all(ids.map((id) => getJson(store, K.rev(id))))).map((r) => r.value).filter(Boolean)
      .map((r) => ({ id: r.id, configHash: r.configHash, signer: r.signer, issuedAt: r.issuedAt, publishedAt: r.publishedAt, kind: r.kind || 'publish' }))
      .sort((a, b) => b.issuedAt - a.issuedAt);
    return json(200, { enabled: true, token, revisions: revs });
  }
  if (view === 'revision') {
    const id = lc(query(event, 'id'));
    if (!isB32(id)) return bad('Invalid revision id.');
    const r = (await getJson(store, K.rev(id))).value;
    return r ? json(200, { enabled: true, revision: r }) : publicError(404, 'not_found', 'Revision not found.');
  }
  if (view === 'activations') return json(200, { enabled: true, activations: await loadActivations(store) });
  if (view === 'metrics') return json(200, { enabled: true, ...(await metrics(store, rpc, cfg)) });
  return bad('Unknown view.');
}

async function loadActivations(store) {
  const ids = (await store.smembers(K.activations)).slice(0, MAX_EXPORT);
  const rows = (await Promise.all(ids.map((id) => { const [h, i] = id.split(':'); return getJson(store, K.activation(h, i)); }))).map((r) => r.value).filter(Boolean);
  return rows.sort((a, b) => (BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : BigInt(a.blockNumber) > BigInt(b.blockNumber) ? 1 : a.logIndex - b.logIndex));
}

/**
 * Truthful metrics. VERIFIED activation payments come from the registry (complimentary never counted; activations
 * later invalidated by a reorg excluded). Sink figures come from the sink contract itself; tokens in the sink are
 * COMMITTED, and only totalBurned (executed SYNC.burn) is BURNED. Unattributed inflow is derived only when possible.
 */
async function metrics(store, rpc, cfg) {
  const acts = await loadActivations(store);
  const ents = new Map();
  for (const a of acts) if (!ents.has(a.token)) ents.set(a.token, (await getJson(store, K.entitlement(a.token))).value);
  const valid = acts.filter((a) => { const e = ents.get(a.token); return !(e && e.status === 'INVALIDATED_BY_REORG' && e.txHash === a.txHash && e.logIndex === a.logIndex); });
  const paidSum = valid.reduce((s, a) => s + BigInt(a.exactTaggedSyncAmount), 0n);
  const byRate = {};
  for (const a of valid) byRate[a.rateVersion] = (byRate[a.rateVersion] || 0) + 1;
  const out = {
    projectHomesActivated: valid.length,
    syncPaidForVerifiedActivations: paidSum.toString(),
    activationsByRateVersion: byRate,
    complimentaryEntitlements: (await store.smembers(K.complimentary)).length, // never revenue, never burn
    sink: null,
    notes: [
      'SYNC in the sink is COMMITTED TO THE PROJECT HOME SINK; 60% of it is COMMITTED TO BURN until settle() executes.',
      'BURNED counts only SYNC destroyed by SYNC.burn() inside settle() (the sink contract totalBurned).',
      'The sink settles ALL SYNC it receives, including unsolicited transfers; those are not Project Home activation payments.',
    ],
  };
  if (!cfg.sink) return out;
  try {
    const call = async (sig) => BigInt(await Chain.ethCall(rpc, cfg.sink, Core.functionSelector(sig)));
    const balance = BigInt(await Chain.ethCall(rpc, CANONICAL_SYNC, Chain.SEL.balanceOf + Core.abiEncode(['address'], [cfg.sink]).slice(2)));
    const [settled, burned, treasury] = [await call('totalSettled()'), await call('totalBurned()'), await call('totalTreasury()')];
    const received = settled + balance;
    out.sink = {
      address: cfg.sink, currentlyCommittedInSink: balance.toString(), totalSettled: settled.toString(), totalBurnedBySink: burned.toString(),
      totalSentToTreasury: treasury.toString(), totalReceivedBySink: received.toString(),
      unattributedInflow: received >= paidSum ? (received - paidSum).toString() : null,
      unattributedNote: received >= paidSum ? 'SYNC received by the sink that is not a verified Project Home activation payment (unsolicited transfers, late or unverified payments).' : 'Not derivable right now (verified payments exceed the observed sink inflow).',
    };
  } catch (err) {
    logError(FN, 'metrics-chain-unavailable', err, {});
    out.sink = { address: cfg.sink, unavailable: true };
  }
  return out;
}

// ---------------------------------------------------------------- immutable price / rate snapshots (fail closed)
async function snapshot(store, key, identity) {
  const value = Site.canonicalJson(identity);
  if (await store.cas({ expect: [[key, null]], set: [[key, value]] })) return true;
  const existing = await store.get(key);
  if (existing === value) return true;
  log(FN, 'version-conflict', { key }); // the same version number now means different values: refuse everything
  return false;
}

// ---------------------------------------------------------------- 1. payment intent (current Passport operator only)
async function createIntent(b, { store, rpc, cfg, now, random }) {
  const extra = onlyFields(b, ['action', 'token', 'operator', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  if (!cfg.paymentsEnabled) return publicError(503, 'payments_closed', PAY_CLOSED);
  const env = signedEnvelope(b, now());
  if (env.error) return env.error;
  const { token, operator, nonce, issuedAt } = env;
  if (!(await verifySig(rpc, operator, 'ActivationRequest', { token, operator, issuedAt, nonce }, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this request.');
  let live;
  try { live = await liveProject(rpc, token); } catch (err) { logError(FN, 'chain-unavailable', err, { token }); return publicError(503, 'chain_unavailable', CHAIN_DOWN); }
  if (!live.launch) return publicError(422, 'not_supported', 'This address is not a supported project (PAR or Pons V2 launch) on Robinhood Chain.');
  const pRaw = await store.get(K.passport(token));
  let passport = null; try { passport = pRaw ? JSON.parse(pRaw) : null; } catch { passport = null; }
  if (!passport || lc(passport.operator) !== operator) return publicError(403, 'not_operator', 'Only the current Project Passport operator can request a Project Home activation.');
  const ent = await getJson(store, K.entitlement(token));
  if (ent.value && (PAID_STATES.has(ent.value.status) || ent.value.status === 'PENDING_CONFIRMATION')) return publicError(409, 'already_active', 'This project already has a Project Home activation. It never has to be paid again.');
  // One open intent per token: an unexpired one is returned as is (same amount, same lock) — never a second amount.
  // A payment already seen on-chain for ANY recent intent blocks a new quote (aggressive duplicate-payment prevention).
  for (const id of (await store.smembers(K.intentsOf(token))).slice(0, 50)) {
    const i = (await getJson(store, K.intent(id))).value;
    if (i && i.observed && (i.status === 'OPEN' || i.status === 'REORGED')) return publicError(409, 'payment_pending', 'A payment for this project is awaiting confirmation. Verify it before requesting a new quote.');
  }
  const openRaw = await store.get(K.open(token));
  if (openRaw) {
    const existing = (await getJson(store, K.intent(openRaw))).value;
    if (existing && existing.status === 'OPEN' && now() < Date.parse(existing.expiresAt)) return json(200, { ok: true, reused: true, intent: publicIntent(existing) });
  }
  const price = cfg.price, rate = cfg.rate;
  if (!(await snapshot(store, K.price(price.priceVersion), Pricing.priceIdentity(price))) || !(await snapshot(store, K.rate(rate.rateVersion), Pricing.rateIdentity(rate)))) {
    return publicError(503, 'config_conflict', PAY_CLOSED);
  }
  let createdBlock;
  try {
    const r = PhChain.bounded(rpc, 3);
    await PhChain.assertChain(r);
    createdBlock = await PhChain.blockNumber(r);
  } catch (err) { logError(FN, 'chain-unavailable', err, { token }); return publicError(503, 'chain_unavailable', CHAIN_DOWN); }
  let base;
  try { base = Pricing.baseSyncWei(price.priceUsdCents, BigInt(rate.rateUsdE18)); } catch (err) { logError(FN, 'pricing-failed', err, {}); return publicError(503, 'config_invalid', PAY_CLOSED); }
  const createdAtMs = now();
  const createdAtSec = Math.floor(createdAtMs / 1000);
  const request = { issuedAt, nonce, signature: b.signature, digest: Site.digest('ActivationRequest', { token, operator, issuedAt, nonce }) };
  for (let attempt = 0; attempt < 6; attempt++) {
    const tag = Pricing.randomTag(random);
    const exact = Pricing.taggedAmount(base, tag);
    const requestId = '0x' + Buffer.from(random(32)).toString('hex');
    const intent = {
      schema: 'syncnet.project-home.intent.v1', requestId, token, operatorAtRequest: operator, chainId: CHAIN_ID, canonicalSync: CANONICAL_SYNC, sink: cfg.sink,
      priceUsdCents: price.priceUsdCents, priceVersion: price.priceVersion,
      syncUsdReferenceRate: rate.syncUsdReferenceRate, rateUsdE18: rate.rateUsdE18, rateVersion: rate.rateVersion, rateEffectiveAt: rate.rateEffectiveAt,
      baseSyncAmount: base.toString(), exactTaggedSyncAmount: exact.toString(), tag: tag.toString(),
      createdAt: new Date(createdAtMs).toISOString(), createdAtSec, createdBlock: createdBlock.toString(),
      expiresAt: new Date((createdAtSec + LOCK) * 1000).toISOString(), expiresAtSec: createdAtSec + LOCK,
      status: 'OPEN', request,
    };
    const ok = await store.cas({
      expect: [[K.amount(exact.toString()), null], [K.open(token), openRaw], [K.nonce(operator, nonce), null], [K.entitlement(token), ent.raw], [K.passport(token), pRaw]],
      set: [[K.amount(exact.toString()), requestId, AMOUNT_TTL], [K.intent(requestId), JSON.stringify(intent), INTENT_TTL], [K.open(token), requestId, LOCK], [K.nonce(operator, nonce), '1', NONCE_TTL]],
      sadd: [[K.intentsOf(token), requestId]],
    });
    if (ok) {
      log(FN, 'intent-created', { token, operator: hashId(operator), rateVersion: rate.rateVersion, priceVersion: price.priceVersion });
      return json(201, { ok: true, reused: false, intent: publicIntent(intent) });
    }
    if (await store.get(K.nonce(operator, nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    if (!(await store.get(K.amount(exact.toString())))) return publicError(409, 'conflict', 'The project changed while the quote was being created. Try again.');
    // amount collision (astronomically rare): draw a new tag
  }
  return publicError(503, 'unavailable', UNAVAILABLE);
}

// ---------------------------------------------------------------- 2. verification + ATOMIC activation
async function verifyPayment(b, { store, rpc, cfg, now, env }) {
  const extra = onlyFields(b, ['action', 'requestId', 'txHash']);
  if (extra) return extra;
  // Verification does not depend on the CURRENT rate (the intent carries its own), but it needs the payment switch
  // and the same sink. A kill switch pauses it; a payment mined in time stays verifiable when it reopens.
  if (!cfg.siteEnabled || String(env.SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED || '').trim().toLowerCase() !== 'true' || !cfg.sink) return publicError(503, 'payments_closed', PAY_CLOSED);
  const requestId = lc(b.requestId), txHash = lc(b.txHash);
  if (!isB32(requestId)) return bad('Invalid requestId.');
  if (!isTx(txHash)) return bad('Invalid transaction hash.');
  const it = await getJson(store, K.intent(requestId));
  const intent = it.value;
  if (!intent) return publicError(404, 'not_found', 'Payment intent not found.');
  if (intent.sink !== cfg.sink || intent.canonicalSync !== CANONICAL_SYNC || intent.chainId !== CHAIN_ID) return publicError(409, 'config_changed', 'This intent was issued for a different payment configuration.');
  const token = intent.token;
  // Idempotent fast path: this exact request already activated with this transaction.
  const entNow = await getJson(store, K.entitlement(token));
  if (entNow.value && entNow.value.requestId === requestId && entNow.value.txHash === txHash && PAID_STATES.has(entNow.value.status)) {
    return json(200, { ok: true, idempotent: true, status: entNow.value.status, entitlement: publicEntitlement(entNow.value) });
  }
  if (intent.status !== 'OPEN' && intent.status !== 'REORGED') return publicError(409, 'intent_closed', 'This payment intent is ' + intent.status + '.');

  const r = PhChain.bounded(rpc, 8);
  let rcpt, blk, safe, fin = null, matches = [], receiptHeight = 0n;
  try {
    await PhChain.assertChain(r);
    rcpt = await PhChain.receipt(r, txHash);
    if (!rcpt) return json(202, { ok: false, status: 'NOT_MINED', message: 'The transaction is not mined yet. Verify again shortly — the rate lock is judged by the block time, not by when you verify.' });
    if (lc(rcpt.status) !== '0x1') return publicError(409, 'tx_failed', 'That transaction failed on-chain. Nothing was paid.');
    matches = PhChain.transfersTo(rcpt, { sync: CANONICAL_SYNC, sink: intent.sink, amount: intent.exactTaggedSyncAmount });
    if (!matches.length) return publicError(409, 'no_matching_payment', 'That transaction has no canonical $SYNC transfer of the exact amount to the Project Home sink.');
    const height = BigInt(rcpt.blockNumber);
    receiptHeight = height;
    blk = await PhChain.block(r, height);
    if (!blk || blk.hash !== lc(rcpt.blockHash)) return json(202, { ok: false, status: 'REORG_IN_PROGRESS', message: 'The block is being reorganised. Verify again shortly.' });
    if (!(height > BigInt(intent.createdBlock)) || blk.timestamp < BigInt(intent.createdAtSec - CLOCK_SKEW)) return publicError(409, 'mined_before_intent', 'That payment was mined before this payment intent existed.');
    if (blk.timestamp > BigInt(intent.expiresAtSec)) {
      log(FN, 'mined-after-expiry', { token, requestId: requestId.slice(0, 18) });
      return publicError(409, 'mined_after_expiry', 'That payment was mined after the 30-minute rate lock expired, so it cannot activate at the locked rate. It is not refundable by the protocol.');
    }
    safe = await PhChain.block(r, 'safe');
    if (!safe || safe.number < height) {
      await recordObserved(store, it, txHash, height);
      return json(202, { ok: false, status: 'PENDING_CONFIRMATION', message: 'Payment found. Waiting for the SAFE confirmation state on Robinhood Chain.' });
    }
    try { fin = await PhChain.block(r, 'finalized'); } catch { fin = null; } // optional: activation needs SAFE only
  } catch (err) {
    logError(FN, 'chain-unavailable', err, { requestId: requestId.slice(0, 18) });
    return publicError(503, 'chain_unavailable', CHAIN_DOWN);
  }

  // Pick the first matching log not already claimed by another request.
  let pick = null, paylogRaw = null;
  for (const m of matches) {
    const raw = await store.get(K.paylog(txHash, m.logIndex));
    if (raw === null || raw === requestId) { pick = m; paylogRaw = raw; break; }
  }
  if (!pick) return publicError(409, 'payment_already_used', 'That payment has already activated a Project Home.');
  if (entNow.value && (PAID_STATES.has(entNow.value.status) || entNow.value.status === 'PENDING_CONFIRMATION')) {
    return publicError(409, 'already_active', 'This project already has an active Project Home activation. This payment was not consumed.');
  }
  const at = new Date(now()).toISOString();
  const finalized = Boolean(fin && fin.number >= receiptHeight && blk.hash === lc(rcpt.blockHash));
  const entitlement = {
    schema: 'syncnet.project-home.entitlement.v1', token, status: finalized ? 'FINALIZED' : 'ACTIVE', kind: 'paid', chainId: CHAIN_ID,
    txHash, logIndex: pick.logIndex, blockNumber: receiptHeight.toString(), blockHash: blk.hash, blockTimestamp: Number(blk.timestamp),
    payer: pick.from, sink: intent.sink, canonicalSync: CANONICAL_SYNC,
    exactAmount: intent.exactTaggedSyncAmount, baseSyncAmount: intent.baseSyncAmount,
    priceUsdCents: intent.priceUsdCents, priceVersion: intent.priceVersion,
    syncUsdReferenceRate: intent.syncUsdReferenceRate, rateUsdE18: intent.rateUsdE18, rateVersion: intent.rateVersion, rateEffectiveAt: intent.rateEffectiveAt,
    requestId, activatedAt: at, safeAt: at, finalizedAt: finalized ? at : null,
    operatorAtActivation: intent.operatorAtRequest, // HISTORY ONLY — never authority
    previous: entNow.value && entNow.value.status === 'INVALIDATED_BY_REORG' ? { txHash: entNow.value.txHash, logIndex: entNow.value.logIndex, invalidatedAt: entNow.value.invalidatedAt } : null,
  };
  const activation = {
    schema: 'syncnet.project-home.activation.v1', token, requestId, txHash, logIndex: pick.logIndex, payer: pick.from,
    amount: intent.exactTaggedSyncAmount, exactTaggedSyncAmount: intent.exactTaggedSyncAmount, baseSyncAmount: intent.baseSyncAmount,
    priceUsdCents: intent.priceUsdCents, priceVersion: intent.priceVersion, syncUsdReferenceRate: intent.syncUsdReferenceRate, rateVersion: intent.rateVersion,
    rateEffectiveAt: intent.rateEffectiveAt, blockNumber: receiptHeight.toString(), blockHash: blk.hash, blockTimestamp: Number(blk.timestamp),
    sink: intent.sink, activatedAt: at, operatorAtActivation: intent.operatorAtRequest, kind: 'paid',
  };
  const consumed = { ...intent, status: 'CONSUMED', consumedBy: { txHash, logIndex: pick.logIndex, at } };
  const auditEvent = JSON.stringify({ type: 'activated', token, requestId, txHash, logIndex: pick.logIndex, status: entitlement.status, at });
  // THE critical transition — all-or-nothing: claim the log, create the entitlement, consume the intent, register.
  const ok = await store.cas({
    expect: [[K.paylog(txHash, pick.logIndex), paylogRaw], [K.entitlement(token), entNow.raw], [K.intent(requestId), it.raw]],
    set: [
      [K.paylog(txHash, pick.logIndex), requestId],
      [K.entitlement(token), JSON.stringify(entitlement)],
      [K.intent(requestId), JSON.stringify(consumed)],
      [K.activation(txHash, pick.logIndex), JSON.stringify(activation)],
    ],
    sadd: [[K.activations, txHash + ':' + pick.logIndex], [K.activationsOf(token), txHash + ':' + pick.logIndex], [K.audit(token), auditEvent]],
  });
  if (!ok) {
    // Someone else changed one of the keys between our reads and the commit. Re-read and answer from the truth.
    const e2 = (await getJson(store, K.entitlement(token))).value;
    if (e2 && e2.requestId === requestId && e2.txHash === txHash && PAID_STATES.has(e2.status)) return json(200, { ok: true, idempotent: true, status: e2.status, entitlement: publicEntitlement(e2) });
    const claimedBy = await store.get(K.paylog(txHash, pick.logIndex));
    if (claimedBy && claimedBy !== requestId) return publicError(409, 'payment_already_used', 'That payment has already activated a Project Home.');
    if (e2 && PAID_STATES.has(e2.status)) return publicError(409, 'already_active', 'This project already has an active Project Home activation. This payment was not consumed.');
    return publicError(409, 'conflict', 'The activation state changed during verification. Verify again.');
  }
  log(FN, 'activated', { token, requestId: requestId.slice(0, 18), status: entitlement.status, rateVersion: intent.rateVersion });
  return json(200, { ok: true, idempotent: false, status: entitlement.status, entitlement: publicEntitlement(entitlement) });
}

async function recordObserved(store, it, txHash, height) {
  if (!it.value || it.value.observed) return;
  const next = { ...it.value, observed: { txHash, blockNumber: height.toString(), at: new Date().toISOString() } };
  try { await store.cas({ expect: [[K.intent(it.value.requestId), it.raw]], set: [[K.intent(it.value.requestId), JSON.stringify(next), INTENT_TTL]] }); } catch { /* hint only */ }
}

// ---------------------------------------------------------------- 3. finality / reorg reconciliation (permissionless)
async function reconcile(b, { store, rpc, now }) {
  const extra = onlyFields(b, ['action', 'token']);
  if (extra) return extra;
  const token = lc(b.token);
  if (!isAddr(token)) return bad('Invalid token address.');
  const ent = await getJson(store, K.entitlement(token));
  const e = ent.value;
  if (!e) return publicError(404, 'not_found', 'No entitlement for this project.');
  if (e.kind !== 'paid' || e.status === 'FINALIZED' || e.status === 'INVALIDATED_BY_REORG') return json(200, { ok: true, changed: false, status: e.status, entitlement: publicEntitlement(e) });
  const r = PhChain.bounded(rpc, 5);
  let canonical, rcpt, fin;
  try {
    await PhChain.assertChain(r);
    canonical = await PhChain.block(r, BigInt(e.blockNumber));
    if (!canonical || canonical.hash !== e.blockHash) rcpt = await PhChain.receipt(r, e.txHash);
    else fin = await PhChain.block(r, 'finalized');
  } catch (err) {
    logError(FN, 'chain-unavailable', err, { token });
    return publicError(503, 'chain_unavailable', CHAIN_DOWN);
  }
  const at = new Date(now()).toISOString();
  let next = null, event = null;
  if (!canonical || canonical.hash !== e.blockHash) {
    if (rcpt && lc(rcpt.blockHash) === e.blockHash) return publicError(503, 'chain_inconsistent', CHAIN_DOWN); // node views disagree: change nothing
    // The SAFE payment is no longer in the canonical chain: keep every record, mark the entitlement invalidated,
    // reopen the SAME intent for re-verification (a re-included transaction can reactivate it; nothing is deleted).
    next = { ...e, status: 'INVALIDATED_BY_REORG', invalidatedAt: at, invalidation: { canonicalHashAtHeight: canonical ? canonical.hash : null, receiptBlockHash: rcpt ? lc(rcpt.blockHash) : null } };
    event = { type: 'invalidated-by-reorg', token, txHash: e.txHash, logIndex: e.logIndex, blockHash: e.blockHash, at };
  } else if (fin && fin.number >= BigInt(e.blockNumber)) {
    next = { ...e, status: 'FINALIZED', finalizedAt: at };
    event = { type: 'finalized', token, txHash: e.txHash, logIndex: e.logIndex, at };
  }
  if (!next) return json(200, { ok: true, changed: false, status: e.status, entitlement: publicEntitlement(e) });
  const it = await getJson(store, K.intent(e.requestId));
  const set = [[K.entitlement(token), JSON.stringify(next)]];
  const expect = [[K.entitlement(token), ent.raw]];
  if (next.status === 'INVALIDATED_BY_REORG' && it.value) {
    expect.push([K.intent(e.requestId), it.raw]);
    set.push([K.intent(e.requestId), JSON.stringify({ ...it.value, status: 'REORGED', reorgedAt: at })]);
  }
  const ok = await store.cas({ expect, set, sadd: [[K.audit(token), JSON.stringify(event)]] });
  if (!ok) return publicError(409, 'conflict', 'The entitlement changed during reconciliation. Try again.');
  log(FN, event.type, { token });
  return json(200, { ok: true, changed: true, status: next.status, entitlement: publicEntitlement(next) });
}

// ---------------------------------------------------------------- 4. site writes: publish / edit / restore / adopt
async function projectFacts(rpc, token) {
  const live = await liveProject(rpc, token);
  if (!live.launch) return null;
  let markets = [];
  if (live.launch.origin === 'PAR') {
    const raw = await Chain.readMarkets(rpc, token, live.launch);
    markets = raw.slice(0, 5).map((m) => ({ pairToken: lc(m.pairToken), symbol: '' }));
  } else if (live.origin && live.origin.pair) {
    markets = [{ pairToken: lc(live.origin.pair.address), symbol: Core.sanitizeForDisplay(String(live.origin.pair.symbol || ''), { maxLength: 16 }) }];
  }
  for (const m of markets) {
    if (!m.symbol && isAddr(m.pairToken) && !/^0x0{40}$/.test(m.pairToken)) {
      const md = await Chain.readTokenMetadata(rpc, m.pairToken).catch(() => null);
      m.symbol = md && md.symbol ? Core.sanitizeForDisplay(String(md.symbol), { maxLength: 16 }) : '';
    }
  }
  const website = live.meta && live.meta.socials ? String(live.meta.socials.website || '') : '';
  return {
    token, name: live.snapshot.name, symbol: live.snapshot.symbol, decimals: live.meta ? live.meta.decimals : null,
    origin: { launchpad: live.origin.launchpad, label: live.origin.label, factory: lc(live.origin.factory) },
    deployer: lc(live.launch.deployer), markets,
    onchainWebsite: Core.sanitizeForDisplay(website, { maxLength: 200 }),
    readAt: new Date().toISOString(),
  };
}

async function publish(b, { store, rpc, now }) {
  const extra = onlyFields(b, ['action', 'token', 'operator', 'issuedAt', 'nonce', 'signature', 'config', 'configHash']);
  if (extra) return extra;
  const env = signedEnvelope(b, now());
  if (env.error) return env.error;
  const { token, operator, nonce, issuedAt } = env;
  if ((b.config === undefined) === (b.configHash === undefined)) return bad('Send either a config (new content) or a configHash (restore / adopt an existing config).');
  let config, configHash, cfgRaw = null;
  if (b.config !== undefined) {
    const v = Site.validate(b.config);
    if (!v.ok) return publicError(400, 'invalid_config', 'The site config is invalid: ' + v.errors.slice(0, 3).map((e) => e.field + ' ' + e.code).join('; ') + '.');
    config = b.config; configHash = v.configHash;
  } else {
    configHash = lc(b.configHash);
    if (!isB32(configHash)) return bad('Invalid configHash.');
    const c = await getJson(store, K.cfg(configHash));
    if (!c.value) return publicError(404, 'not_found', 'No stored config has that hash.');
    config = c.value; cfgRaw = c.raw;
  }
  if (config.token !== token) return bad('The config belongs to a different token.');
  const message = { token, operator, configHash, issuedAt, nonce };
  if (!(await verifySig(rpc, operator, 'SitePublish', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this publication.');
  // WRITE-TIME AUTHORITY: the signer must be the CURRENT Passport operator (and still be, atomically, at commit).
  const pRaw = await store.get(K.passport(token));
  let passport = null; try { passport = pRaw ? JSON.parse(pRaw) : null; } catch { passport = null; }
  if (!passport || lc(passport.operator) !== operator) return publicError(403, 'not_operator', 'Only the current Project Passport operator can publish this Project Home.');
  // ENTITLEMENT (payment) is separate from the SIGNATURE (content): both are required.
  const ent = await getJson(store, K.entitlement(token));
  if (!ent.value) return publicError(402, 'activation_required', 'This project has no Project Home activation yet. Preview and editing are free; publishing needs the one-time activation.');
  if (ent.value.status === 'INVALIDATED_BY_REORG') return publicError(409, 'entitlement_invalidated', 'The activation payment was removed by a chain reorganisation. Publication is disabled until it is reconciled.');
  if (!PAID_STATES.has(ent.value.status)) return publicError(402, 'activation_pending', 'The activation payment is not confirmed yet.');
  for (const cid of [config.logoCid, config.heroCid].filter(Boolean)) {
    if (!(await store.get(K.img(cid)))) return publicError(422, 'image_not_sanitised', 'Images must be uploaded through the SyncNet image sanitizer first.');
  }
  const cur = await getJson(store, K.cur(token));
  if (cur.value && Number(cur.value.issuedAt) >= issuedAt) return publicError(409, 'stale_issued_at', 'A newer site change is already recorded. Sign again.');
  let facts;
  try { facts = await projectFacts(rpc, token); } catch (err) { logError(FN, 'chain-unavailable', err, { token }); return publicError(503, 'chain_unavailable', CHAIN_DOWN); }
  if (!facts) return publicError(422, 'not_supported', 'This address is not a supported project (PAR or Pons V2 launch).');
  const id = Site.digest('SitePublish', message);
  const at = new Date(now()).toISOString();
  const adopting = Boolean(cur.value && cur.value.configHash === configHash && cur.value.signer !== operator);
  const revision = {
    schema: 'syncnet.site.revision.v1', id, kind: b.config !== undefined ? 'publish' : adopting ? 'adopt' : 'restore',
    token, configHash, config, facts, signer: operator, signature: b.signature, issuedAt, nonce, publishedAt: at,
    entitlement: { kind: ent.value.kind, status: ent.value.status, txHash: ent.value.txHash || null },
  };
  const pointer = { schema: 'syncnet.site.current.v1', token, state: 'PUBLISHED', revisionId: id, configHash, signer: operator, issuedAt, at };
  const ok = await store.cas({
    expect: [[K.passport(token), pRaw], [K.entitlement(token), ent.raw], [K.cur(token), cur.raw], [K.nonce(operator, nonce), null], [K.rev(id), null], ...(cfgRaw ? [[K.cfg(configHash), cfgRaw]] : [])],
    set: [[K.cfg(configHash), Site.canonicalJson(config)], [K.rev(id), JSON.stringify(revision)], [K.cur(token), JSON.stringify(pointer)], [K.nonce(operator, nonce), '1', NONCE_TTL]],
    sadd: [[K.revs(token), id], [K.audit(token), JSON.stringify({ type: revision.kind, token, revisionId: id, signer: operator, at })]],
  });
  if (!ok) {
    if (await store.get(K.nonce(operator, nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    return publicError(409, 'conflict', 'The project changed while publishing (for example, a Passport transfer). Reload and sign again.');
  }
  log(FN, 'published', { token, kind: revision.kind, signer: hashId(operator) });
  return json(200, { ok: true, kind: revision.kind, site: publicCur(pointer), url: '/site/' + token });
}

async function unpublish(b, { store, rpc, now }) {
  const extra = onlyFields(b, ['action', 'token', 'operator', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  const env = signedEnvelope(b, now());
  if (env.error) return env.error;
  const { token, operator, nonce, issuedAt } = env;
  const message = { token, operator, issuedAt, nonce };
  if (!(await verifySig(rpc, operator, 'SiteUnpublish', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this request.');
  const pRaw = await store.get(K.passport(token));
  let passport = null; try { passport = pRaw ? JSON.parse(pRaw) : null; } catch { passport = null; }
  if (!passport || lc(passport.operator) !== operator) return publicError(403, 'not_operator', 'Only the current Project Passport operator can unpublish this Project Home.');
  const cur = await getJson(store, K.cur(token));
  if (!cur.value || cur.value.state !== 'PUBLISHED') return publicError(409, 'not_published', 'This Project Home is not published.');
  if (Number(cur.value.issuedAt) >= issuedAt) return publicError(409, 'stale_issued_at', 'A newer site change is already recorded. Sign again.');
  const at = new Date(now()).toISOString();
  // Tombstone: history, revisions and the entitlement are untouched; the last revision stays restorable.
  const pointer = { schema: 'syncnet.site.current.v1', token, state: 'UNPUBLISHED', revisionId: cur.value.revisionId, configHash: cur.value.configHash, signer: operator, issuedAt, at, signature: b.signature, nonce };
  const ok = await store.cas({
    expect: [[K.passport(token), pRaw], [K.cur(token), cur.raw], [K.nonce(operator, nonce), null]],
    set: [[K.cur(token), JSON.stringify(pointer)], [K.nonce(operator, nonce), '1', NONCE_TTL]],
    sadd: [[K.audit(token), JSON.stringify({ type: 'unpublish', token, signer: operator, digest: Site.digest('SiteUnpublish', message), at })]],
  });
  if (!ok) {
    if (await store.get(K.nonce(operator, nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    return publicError(409, 'conflict', 'The project changed while unpublishing. Reload and sign again.');
  }
  log(FN, 'unpublished', { token, signer: hashId(operator) });
  return json(200, { ok: true, site: publicCur(pointer) });
}

// ---------------------------------------------------------------- ops-only helper (never reachable over HTTP)
/**
 * Complimentary entitlement for testing/administration. Explicitly labelled COMPLIMENTARY; never counted as activation
 * revenue, burn or treasury. There is no HTTP route to this function and no automatic grant for any project.
 */
async function grantComplimentary(store, token, { reason, grantedBy, now } = {}) {
  const t = lc(token);
  if (!isAddr(t) || !reason || !grantedBy) throw new Error('grantComplimentary: token, reason and grantedBy are required');
  const at = new Date(now ? now() : Date.now()).toISOString();
  const e = { schema: 'syncnet.project-home.entitlement.v1', token: t, status: 'ACTIVE', kind: 'complimentary', label: 'COMPLIMENTARY', chainId: CHAIN_ID, reason: String(reason).slice(0, 200), grantedBy: String(grantedBy).slice(0, 80), activatedAt: at, operatorAtActivation: null };
  const ok = await store.cas({ expect: [[K.entitlement(t), null]], set: [[K.entitlement(t), JSON.stringify(e)]], sadd: [[K.complimentary, t], [K.audit(t), JSON.stringify({ type: 'complimentary', token: t, at })]] });
  if (!ok) throw new Error('grantComplimentary: an entitlement already exists');
  return e;
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, LOCK, CLOCK_SKEW, AMOUNT_TTL, verifySig, projectFacts, grantComplimentary, publicIntent, metrics, snapshot };
