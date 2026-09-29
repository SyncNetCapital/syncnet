'use strict';
/*
 * SyncNet SYNC Proof / EARLY — the one API function (docs/sync-proof-early-spec.md §16).
 *
 *   GET  /api/early?view=config|keys|creator|manifest|resolve|intent|receipt|mine|card|bundle|me
 *   POST /api/early {action, …}   count-me-in | count-me-in-withdraw | intent-draft | intent-store | verify |
 *                                 finalize | reconcile | session | card-create | card-event | creator-link |
 *                                 creator-manifest | creator-pause | creator-resume | rotation-cancel
 *
 * Invariants enforced here (never elsewhere):
 *  - money moves only fan wallet → creator wallet (a standard ERC-20 transfer the client sends itself); this function
 *    never holds, routes, fees, swaps or refunds anything and never sends a transaction;
 *  - every write is an EIP-712 signature in the "SyncNet SYNC Proof" domain (ECDSA, then EIP-1271), or a session that
 *    was itself issued from such a signature / from the YouTube OAuth callback;
 *  - the client never supplies receiver, token identity, chain, window or creatorId for an intent: the server drafts
 *    the exact typed data, the fan signs it, the server persists it, and only then is the transfer enabled;
 *  - a receipt is created ONLY by the public matching rule (netlify/lib/early-match.js): exactly one in-window
 *    candidate at SAFE finalises deterministically; two or more → AMBIGUOUS and the fan must sign SupportFinalize;
 *    a late transfer (≤ 24 h after expiry) needs the same signature (recovery). No admin path sets a receipt;
 *  - every critical transition is ONE store.cas (atomic); the loser of a race re-reads and answers from the truth;
 *  - privacy: intents, receipts and Count me in signals are private; nothing lists a wallet's relationships without a
 *    fresh wallet-signed session; creator pages show no supporter data; unknown and unclaimed channels answer alike;
 *  - everything is CLOSED unless SYNCNET_EARLY_ENABLED=true with a durable store (netlify/lib/early-config.js).
 */
const crypto = require('crypto');
const Core = require('../../lib/syncnet-core.js');
const E = require('../../lib/syncnet-early.js');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit, limitAll } = require('../lib/ratelimit');
const { serverRpc } = require('../lib/chain-rpc');
const { readJsonBody, query, method: methodOf, header } = require('../lib/body');
const { verifyDigest } = require('../lib/sig-verify');
const PhChain = require('../lib/project-home-chain');
const { earlyConfig, signer: makeSigner } = require('../lib/early-config');
const Session = require('../lib/early-session');
const Attest = require('../lib/early-attest');
const Match = require('../lib/early-match');

const FN = 'early';
const K = {
  creator: (cid) => `early:creator:v1:${cid}`,
  creators: 'early:creators:v1',
  manifest: (h) => `early:manifest:v1:${h}`,
  manifestsOf: (cid) => `early:manifests:v1:${cid}`,
  cmi: (ch, fan) => `early:cmi:v1:${ch}:${fan}`,
  cmiSet: (ch) => `early:cmi-set:v1:${ch}`,
  cmiOf: (fan) => `early:cmi-of:v1:${fan}`,
  draft: (id) => `early:draft:v1:${id}`,
  intent: (id) => `early:intent:v1:${id}`,
  open: (t) => `early:open:v1:${t.sender}:${t.receiver}:${t.token}:${t.amount}`,
  tupleLast: (t) => `early:tuple-last:v1:${t.sender}:${t.receiver}:${t.token}:${t.amount}`,
  intentsOf: (w) => `early:intents-of:v1:${w}`,
  nonce: (w, n) => `early:nonce:v1:${w}:${n}`,
  oauth: (sid) => `early:oauth:v1:${sid}`,
  receipt: (id) => `early:receipt:v1:${id}`,
  txlog: (h, i) => `early:txlog:v1:${h}:${i}`,
  receiptsOf: (w) => `early:receipts-of:v1:${w}`,
  receiptsOfCreator: (cid) => `early:receipts-of-creator:v1:${cid}`,
  card: (s) => `early:card:v1:${s}`,
  cardOf: (r) => `early:card-of:v1:${r}`,
  metric: (name, d) => `early:metrics:v1:${name}:${d}`,
  visit: (s, ipHash, hour) => `early:visit:v1:${s}:${ipHash}:${hour}`,
  resolve: (h) => `early:yt:resolve:v1:${h}`,
  snap: (ch, d) => `early:snap:v1:${ch}:${d}`,
  snapDays: (ch) => `early:snap-days:v1:${ch}`,
  pendingFinal: 'early:pending-final:v1', // zset: CONFIRMED receipts awaiting finality (score = block number)
  ...Attest.K,
};
const C = E.CONST;
const NONCE_TTL = 90 * 86400;
const INTENT_TTL = 90 * 86400;
const METRIC_TTL = 400 * 86400;
const CMI_WITHDRAWN_TTL = 30 * 86400;
const MAX_SIGNALS_COUNTED = 2000;
const lc = E.lc;
const CLOSED = 'EARLY is not enabled on this deployment.';
const WRITES_CLOSED = 'EARLY writes are paused on this deployment. Existing receipts can still be verified.';
const UNAVAILABLE = 'EARLY is temporarily unavailable.';
const CHAIN_DOWN = 'Robinhood Chain could not be read right now. Nothing was changed. Try again.';
const ATT_DOWN = 'SyncNet cannot issue attestations on this deployment right now, so creator changes are paused. Nothing was changed.';
const bad = (m) => publicError(400, 'invalid_request', m || 'Invalid request.');
const nowSec = (now) => Math.floor(now() / 1000);
const iso = (ms) => new Date(ms).toISOString();

async function getJson(store, key) {
  const raw = await store.get(key);
  if (!raw) return { raw: null, value: null };
  try { return { raw, value: JSON.parse(raw) }; } catch { return { raw, value: null }; }
}
function onlyFields(b, allowed) {
  const extra = Object.keys(b).filter((k) => !allowed.includes(k));
  return extra.length ? bad('Unexpected field: ' + extra[0].slice(0, 40) + '. The server derives it.') : null;
}
async function verifySig(rpc, wallet, kind, message, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,8190}$/.test(signature)) return false;
  let digest;
  try { digest = E.digest(kind, message); } catch { return false; }
  return verifyDigest(rpc, wallet, digest, signature);
}
const skewOk = (issuedAt, now) => E.isUnix(issuedAt) && Math.abs(Number(issuedAt) - nowSec(now)) <= C.MAX_SKEW_S;
async function bump(store, name, now) { try { await store.incrWindow(K.metric(name, E.utcDate(nowSec(now))), METRIC_TTL); } catch (err) { logError(FN, 'metric-failed', err, { name }); } }
const random32 = (random) => '0x' + Buffer.from(random(32)).toString('hex');

// ---------------------------------------------------------------- public shapes (never supporter data)
const publicManifest = (m) => m && { manifestHash: m.manifestHash, creatorId: m.creatorId, channelId: m.channelId, manifestVersion: m.struct.manifestVersion, receivingWallet: m.struct.receivingWallet, acceptedAssets: m.acceptedAssets, previousManifestHash: m.struct.previousManifestHash, status: m.status, effectiveAt: m.effectiveAt, supersededAt: m.supersededAt, supersededBy: m.supersededBy, typedData: E.typedData('CreatorManifest', m.struct), signature: m.signature, attestations: m.attestationIds || [] };
function publicCreator(c, m) {
  if (!c) return { onEarly: false };
  const rot = c.status === 'ROTATION_PENDING' && c.rotation ? { pending: true, effectiveAt: c.rotation.effectiveAt, since: c.rotation.startedAt } : null;
  return {
    onEarly: true, creatorId: c.creatorId, channelId: c.channelId, platform: E.PLATFORM, display: c.display,
    status: c.paused ? 'PAUSED' : c.status, paused: Boolean(c.paused), joinedAt: c.joinedAt,
    currentManifest: m ? { manifestHash: m.manifestHash, manifestVersion: m.struct.manifestVersion, receivingWallet: m.struct.receivingWallet, acceptedAssets: m.acceptedAssets, effectiveAt: m.effectiveAt } : null,
    rotation: rot, acceptsSupport: !c.paused && c.status !== 'VERIFYING' && Boolean(m && m.status === 'ACTIVE'),
  };
}
const publicIntent = (i) => i && { intentId: i.intentId, status: i.status, typedData: E.typedData('SupportIntent', i.struct), signature: i.signature, digest: i.digest, createdBlock: i.createdBlock, storedAt: i.storedAt, observed: i.observed || null, candidates: i.candidates || null, receiptId: i.receiptId || null, closedAt: i.closedAt || null, closeReason: i.closeReason || null, tx: { to: i.struct.token, data: E.transferCalldata(i.struct.receiver, i.struct.amount), value: '0x0' } };
const publicSignal = (s, creator) => s && { channelId: s.struct.channelId, status: s.status === 'ACTIVE' && Number(s.struct.expiry) * 1000 <= Date.now() ? 'EXPIRED' : s.status === 'ACTIVE' && creator && creator.joinedAt ? 'FROZEN' : s.status, createdAt: s.createdAt, renewedAt: s.renewedAt || [], expiry: s.struct.expiry, creatorOnEarly: Boolean(creator), creatorId: creator ? creator.creatorId : null };

// =====================================================================================================================
async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const rpc = deps.rpc || serverRpc({ retries: 2 });
  const ip = clientIp(event);
  const cfg = earlyConfig({ env, store, now, assetsFile: deps.assetsFile, keysFile: deps.keysFile });
  const ctx = { store, rpc, env, now, cfg, ip, ipHash: hashId(ip), random: deps.random || ((n) => crypto.randomBytes(n)), youtube: deps.youtube || null, signer: cfg.attestation.configured ? makeSigner(env, cfg) : null, event };
  const denied = (rl) => (rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter));

  if (method === 'GET') {
    const rl = await limit(store, { bucket: 'early-read', id: ip, limit: 120, windowSeconds: 60, now });
    if (!rl.allowed) return denied(rl);
    const view = query(event, 'view') || 'config';
    try {
      if (view === 'config') return json(200, configView(cfg));
      if (!cfg.enabled) return json(200, { enabled: false, note: CLOSED });
      return await readView(view, ctx);
    } catch (err) {
      logError(FN, 'read-failed', err, { view: String(view).slice(0, 24) });
      return publicError(503, 'unavailable', UNAVAILABLE);
    }
  }
  if (method !== 'POST') return publicError(405, 'method_not_allowed', 'GET or POST only.', { allow: 'GET, POST' });
  if (!cfg.enabled || typeof store.cas !== 'function') return publicError(503, 'closed', CLOSED);
  const rl = await limitAll(store, [{ bucket: 'early-write', id: ip, limit: 20, windowSeconds: 60, now }, { bucket: 'early-write-h', id: ip, limit: 200, windowSeconds: 3600, now }]);
  if (!rl.allowed) return denied(rl);
  const b = readJsonBody(event, 16384);
  if (!b || typeof b.action !== 'string') return bad('A JSON body with an action is required.');
  const a = b.action;
  const READ_ONLY_ACTIONS = new Set(['verify', 'reconcile', 'session']); // no new relationship is created by these
  if (!cfg.writesEnabled && !READ_ONLY_ACTIONS.has(a)) return publicError(503, 'writes_closed', WRITES_CLOSED);
  try {
    if (a === 'count-me-in') return await countMeIn(b, ctx);
    if (a === 'count-me-in-withdraw') return await countMeInWithdraw(b, ctx);
    if (a === 'intent-draft') return await intentDraft(b, ctx);
    if (a === 'intent-store') return await intentStore(b, ctx);
    if (a === 'verify') return await verify(b, ctx);
    if (a === 'finalize') return await finalize(b, ctx);
    if (a === 'reconcile') return await reconcile(b, ctx);
    if (a === 'session') return await session(b, ctx);
    if (a === 'card-create') return await cardCreate(b, ctx);
    if (a === 'card-event') return await cardEvent(b, ctx);
    if (a === 'creator-link') return await creatorLink(b, ctx);
    if (a === 'creator-manifest') return await creatorManifest(b, ctx);
    if (a === 'creator-pause' || a === 'creator-resume') return await creatorPause(b, ctx, a === 'creator-pause');
    if (a === 'rotation-cancel') return await rotationCancel(b, ctx);
    return bad('Unknown action.');
  } catch (err) {
    // Any chain read problem (RPC error/timeout, malformed answer, budget) is an outage: nothing was changed.
    if (err && (err.name === 'ChainReadError' || err.name === 'RpcError' || err.chain === true)) { logError(FN, 'chain-unavailable', err, { action: a }); return publicError(503, 'chain_unavailable', CHAIN_DOWN); }
    logError(FN, 'write-crashed', err, { action: String(a).slice(0, 24) });
    return publicError(503, 'unavailable', UNAVAILABLE);
  }
}

function configView(cfg) {
  return {
    enabled: cfg.enabled, writes: cfg.writesEnabled, chainId: cfg.chainId, domain: E.DOMAIN,
    assets: cfg.assets ? [...cfg.assets.values()] : [], intentWindowSeconds: C.INTENT_WINDOW_S, recoveryGraceSeconds: C.RECOVERY_GRACE_S,
    rotationCooldownSeconds: C.ROTATION_COOLDOWN_S, attestations: cfg.attestation.configured, anchoring: cfg.anchorEnabled, oauth: cfg.oauth.configured, resolver: cfg.youtube.configured,
    matchingRule: E.SCHEMA.matching, receiptSchema: E.SCHEMA.receipt, keys: '/api/early?view=keys',
    product: 'EARLY · I WAS THERE WHEN.', model: 'Money moves directly from the fan wallet to the creator wallet. SyncNet never receives, holds, routes or refunds funds and takes no fee.',
  };
}

// ---------------------------------------------------------------- sessions (header x-syncnet-early-session)
const sessionOf = (ctx, scope) => Session.verify(header(ctx.event, 'x-syncnet-early-session'), { scope, now: ctx.now, env: ctx.env });

// ---------------------------------------------------------------- creator helpers
async function loadCreator(store, creatorId) { return getJson(store, K.creator(creatorId)); }
async function loadManifest(store, h) { return getJson(store, K.manifest(h)); }
/** Completes a due rotation (permissionless; any read may trigger it). Returns the (possibly updated) creator record. */
async function maybeCompleteRotation(ctx, cr) {
  const { store, now, signer } = ctx;
  const c = cr.value;
  if (!c || c.status !== 'ROTATION_PENDING' || !c.rotation || nowSec(now) < Number(c.rotation.effectiveAt)) return c;
  if (!signer) { log(FN, 'rotation-blocked-no-signer', { creatorId: c.creatorId }); return c; }
  const oldM = await loadManifest(store, c.currentManifestHash), newM = await loadManifest(store, c.pendingManifestHash);
  if (!oldM.value || !newM.value || newM.value.status !== 'PENDING') return c;
  const t = nowSec(now), at = Number(c.rotation.effectiveAt), bd = await Attest.bundleDateFor(store, t);
  const attId = Attest.build(signer, { type: 'creator-identity', subject: { creatorId: c.creatorId, channelId: c.channelId }, claims: { platform: E.PLATFORM, channelId: c.channelId, receivingWallet: newM.value.struct.receivingWallet, manifestHash: newM.value.manifestHash, manifestVersion: newM.value.struct.manifestVersion, verifiedAt: c.rotation.startedAt, method: 'google-oauth2 youtube.readonly channels.mine' }, issuedAt: t, bundleDate: bd });
  const attNew = Attest.build(signer, { type: 'creator-manifest', subject: { creatorId: c.creatorId, manifestHash: newM.value.manifestHash }, claims: { manifestVersion: newM.value.struct.manifestVersion, previousManifestHash: newM.value.struct.previousManifestHash, status: 'ACTIVE', effectiveAt: at, supersededAt: null, at: t }, issuedAt: t, bundleDate: bd });
  const attOld = Attest.build(signer, { type: 'creator-manifest', subject: { creatorId: c.creatorId, manifestHash: oldM.value.manifestHash }, claims: { manifestVersion: oldM.value.struct.manifestVersion, previousManifestHash: oldM.value.struct.previousManifestHash, status: 'SUPERSEDED', effectiveAt: oldM.value.effectiveAt, supersededAt: at, supersededBy: newM.value.manifestHash, at: t }, issuedAt: t, bundleDate: bd });
  const next = { ...c, status: 'ACTIVE', currentManifestHash: newM.value.manifestHash, pendingManifestHash: null, rotation: { ...c.rotation, completedAt: t }, rotations: [...(c.rotations || []), { from: oldM.value.manifestHash, to: newM.value.manifestHash, at }] };
  const oldNext = { ...oldM.value, status: 'SUPERSEDED', supersededAt: at, supersededBy: newM.value.manifestHash, attestationIds: [...(oldM.value.attestationIds || []), attOld.id] };
  const newNext = { ...newM.value, status: 'ACTIVE', effectiveAt: at, identityAttestationId: attId.id, attestationIds: [...(newM.value.attestationIds || []), attNew.id] };
  const w = [attId, attNew, attOld].map(Attest.writesFor);
  const ok = await store.cas({
    expect: [[K.creator(c.creatorId), cr.raw], [K.manifest(oldM.value.manifestHash), oldM.raw], [K.manifest(newM.value.manifestHash), newM.raw]],
    set: [[K.creator(c.creatorId), JSON.stringify(next)], [K.manifest(oldM.value.manifestHash), JSON.stringify(oldNext)], [K.manifest(newM.value.manifestHash), JSON.stringify(newNext)], ...w.flatMap((x) => x.set)],
    sadd: w.flatMap((x) => x.sadd),
  });
  if (ok) { log(FN, 'rotation-completed', { creatorId: c.creatorId, version: newM.value.struct.manifestVersion }); return next; }
  return (await loadCreator(store, c.creatorId)).value;
}
async function creatorByChannel(ctx, channelId) {
  const cr = await loadCreator(ctx.store, E.creatorIdOf(channelId));
  return maybeCompleteRotation(ctx, cr);
}

// ---------------------------------------------------------------- GET views
async function readView(view, ctx) {
  const { store, cfg, now } = ctx;
  if (view === 'keys') return json(200, { enabled: true, registry: cfg.registry, note: 'Public key ids and addresses only. Attestations are valid only when their bundle root is anchored; see docs/early/PROTOCOL.md.' });
  if (view === 'creator') {
    let channelId = query(ctx.event, 'channelId');
    const cid = lc(query(ctx.event, 'creatorId'));
    if (!channelId && E.isBytes32(cid)) { const c = (await loadCreator(store, cid)).value; channelId = c ? c.channelId : ''; if (!channelId) return json(200, { onEarly: false }); }
    if (!E.isChannelId(channelId)) return bad('Invalid channel id.');
    const c = await creatorByChannel(ctx, channelId);
    if (!c) return json(200, { onEarly: false }); // identical for unknown and unclaimed channels; no signal reads on this path
    const m = (await loadManifest(store, c.currentManifestHash)).value;
    return json(200, publicCreator(c, m));
  }
  if (view === 'manifest') {
    const h = lc(query(ctx.event, 'manifestHash'));
    if (!E.isBytes32(h)) return bad('Invalid manifest hash.');
    const m = (await loadManifest(store, h)).value;
    if (!m) return publicError(404, 'not_found', 'Manifest not found.');
    const atts = [];
    for (const id of m.attestationIds || []) { const a = await Attest.read(store, id); if (a) atts.push({ ...a, inclusion: await Attest.inclusion(store, a) }); }
    if (m.identityAttestationId) { const a = await Attest.read(store, m.identityAttestationId); if (a) atts.push({ ...a, inclusion: await Attest.inclusion(store, a) }); }
    return json(200, { enabled: true, manifest: { ...publicManifest(m), attestations: atts } });
  }
  if (view === 'resolve') return resolveView(ctx);
  if (view === 'intent') {
    const id = lc(query(ctx.event, 'intent'));
    if (!E.isBytes32(id)) return bad('Invalid intent id.');
    const i = (await getJson(store, K.intent(id))).value;
    if (!i) return publicError(404, 'not_found', 'Intent not found.');
    return json(200, { enabled: true, intent: publicIntent(i) });
  }
  if (view === 'receipt') {
    const iid = lc(query(ctx.event, 'intent')), rid = lc(query(ctx.event, 'receiptId'));
    let r = null;
    if (E.isBytes32(rid)) r = (await getJson(store, K.receipt(rid))).value;
    else if (E.isBytes32(iid)) { const i = (await getJson(store, K.intent(iid))).value; if (i && i.receiptId) r = (await getJson(store, K.receipt(i.receiptId))).value; }
    else return bad('Provide intent or receiptId.');
    if (!r) return publicError(404, 'not_found', 'Receipt not found.');
    return json(200, { enabled: true, receipt: await receiptDocument(ctx, r) });
  }
  if (view === 'mine') {
    const s = sessionOf(ctx, 'fan');
    if (!s) return publicError(401, 'session', 'A fan session is required (sign in with your wallet).');
    const w = s.wallet;
    const intents = [], receipts = [], signals = [];
    for (const id of (await store.smembers(K.intentsOf(w))).slice(0, 200)) { const i = (await getJson(store, K.intent(id))).value; if (i) intents.push(publicIntent(i)); }
    for (const id of (await store.smembers(K.receiptsOf(w))).slice(0, 200)) { const r = (await getJson(store, K.receipt(id))).value; if (r) receipts.push(await receiptSummary(ctx, r)); }
    for (const ch of (await store.smembers(K.cmiOf(w))).slice(0, 200)) { const sg = (await getJson(store, K.cmi(ch, w))).value; if (sg) signals.push(publicSignal(sg, (await loadCreator(store, E.creatorIdOf(ch))).value)); }
    return json(200, { enabled: true, wallet: w, intents, receipts, signals });
  }
  if (view === 'card') return cardView(ctx);
  if (view === 'bundle') {
    const d = query(ctx.event, 'date');
    if (!E.isDate(d)) return bad('Invalid date.');
    const b = (await getJson(store, K.bundle(d))).value;
    if (!b) { const pending = (await store.smembers(K.queue(d))).length; return json(200, { enabled: true, date: d, built: false, pendingLeaves: pending }); }
    return json(200, { enabled: true, date: d, built: true, bundle: b });
  }
  if (view === 'me') {
    const s = sessionOf(ctx, 'creator');
    if (!s) return publicError(401, 'session', 'A creator session is required.');
    const c = await creatorByChannel(ctx, s.channelId);
    const link = (await getJson(store, K.oauth(s.sid))).value;
    const manifests = [];
    if (c) for (const h of (await store.smembers(K.manifestsOf(c.creatorId))).slice(0, 50)) { const m = (await loadManifest(store, h)).value; if (m) manifests.push(publicManifest(m)); }
    manifests.sort((a, b2) => a.manifestVersion - b2.manifestVersion);
    const signalsNow = c ? null : await countSignals(store, s.channelId, nowSec(now));
    return json(200, { enabled: true, channelId: s.channelId, linkWallet: s.wallet, linkFresh: Boolean(link), display: link ? { title: link.title, avatarUrl: link.avatarUrl, handle: link.handle } : c ? c.display : null, creator: c ? { ...publicCreator(c, manifests.find((m) => m.manifestHash === c.currentManifestHash) && (await loadManifest(store, c.currentManifestHash)).value), signalsWaitingAtJoin: c.signalsWaitingAtJoin, rotation: c.rotation || null, oauthSeen: c.oauthSeen || [] } : null, signalsWaiting: signalsNow, manifests, signalsNote: 'Signed interest signals are counted as records, not as people.' });
  }
  return bad('Unknown view.');
}

async function resolveView(ctx) {
  const { store, youtube, ip, now } = ctx;
  const rl = await limitAll(store, [{ bucket: 'early-resolve', id: ip, limit: 20, windowSeconds: 60, now }, { bucket: 'early-resolve-d', id: ip, limit: 200, windowSeconds: 86400, now }]);
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);
  const input = String(query(ctx.event, 'yt') || '').trim();
  if (!input || input.length > 200) return bad('Provide a YouTube channel URL, handle or channel id.');
  if (!youtube) return publicError(503, 'resolver_unavailable', 'The YouTube resolver is not configured on this deployment.');
  const key = K.resolve(crypto.createHash('sha256').update(input.toLowerCase(), 'utf8').digest('hex'));
  const cached = (await getJson(store, key)).value;
  if (cached) return json(200, { enabled: true, ...cached, cached: true });
  let ch;
  try { ch = await youtube.resolve(input); } catch (err) { logError(FN, 'resolve-failed', err, {}); return publicError(503, 'resolver_unavailable', 'YouTube could not be reached right now.'); }
  if (!ch || !E.isChannelId(ch.channelId)) return publicError(404, 'not_found', 'No YouTube channel was found for that input.');
  const out = { channelId: ch.channelId, title: E.clean(ch.title, 80), avatarUrl: /^https:\/\/[^\s"'<>]{1,300}$/.test(String(ch.avatarUrl || '')) ? ch.avatarUrl : '', handle: E.clean(ch.handle, 40) };
  await store.set(key, JSON.stringify(out), { ttlSeconds: 3600 });
  return json(200, { enabled: true, ...out, cached: false });
}

// ---------------------------------------------------------------- receipts (documents assembled at read time)
async function attestationWithProof(store, id) {
  if (!id) return null;
  const a = await Attest.read(store, id);
  return a ? { ...a, inclusion: await Attest.inclusion(store, a) } : null;
}
async function receiptContext(ctx, r) {
  const { store } = ctx;
  const m = (await loadManifest(store, r.manifestHash)).value;
  const earlyDate = E.utcDate(r.fact.blockTimestamp);
  const snap = m ? (await getJson(store, K.snap(m.channelId, earlyDate))).value : null;
  const identity = m ? await attestationWithProof(store, m.identityAttestationId) : null;
  let manifestAtt = null;
  if (m) for (const id of m.attestationIds || []) { const a = await Attest.read(store, id); if (a && a.claims.status === 'ACTIVE') manifestAtt = { ...a, inclusion: await Attest.inclusion(store, a) }; }
  const snapAtt = snap ? { ...snap, inclusion: await Attest.inclusion(store, snap) } : null;
  const audience = !snap ? { state: 'unavailable' } : snap.claims.hiddenSubscriberCount || snap.claims.subscriberCount == null ? { state: 'hidden' } : { state: 'approximate', value: snap.claims.subscriberCount, display: E.formatAudience(snap.claims.subscriberCount), asOf: snap.claims.fetchedAt };
  const titleThen = snap && snap.claims.title ? snap.claims.title : identity && identity.claims.title ? identity.claims.title : (m && m.display && m.display.title) || '';
  return { manifest: m, context: { earlyDate, creatorTitleThen: titleThen, audienceThen: audience }, attestations: [identity, manifestAtt, snapAtt].filter(Boolean) };
}
async function receiptDocument(ctx, r) {
  const { manifest: m, context, attestations } = await receiptContext(ctx, r);
  const anchors = [...new Set(attestations.map((a) => a.bundleDate))];
  const anchorInfo = [];
  for (const d of anchors) { const b = (await getJson(ctx.store, K.bundle(d))).value; anchorInfo.push({ bundleDate: d, root: b ? b.root : null, built: Boolean(b), robinhood: b && b.anchors ? b.anchors.robinhood || null : null, opentimestamps: b && b.anchors ? b.anchors.opentimestamps || null : null }); }
  return {
    schema: E.SCHEMA.receipt, receiptId: r.receiptId, matchingRule: E.SCHEMA.matching, mode: r.mode, status: r.status,
    fact: { chainId: E.CHAIN_ID, txHash: r.fact.txHash, logIndex: r.fact.logIndex, blockNumber: r.fact.blockNumber, blockHash: r.fact.blockHash, blockTimestamp: r.fact.blockTimestamp, transfer: r.fact.transfer, confirmation: { policy: 'safe-then-finalized', safeAt: r.confirmation.safeAt, finalizedAt: r.confirmation.finalizedAt || null } },
    intent: r.intent, finalize: r.finalize || null,
    creatorManifest: m ? { typedData: E.typedData('CreatorManifest', m.struct), acceptedAssets: m.acceptedAssets, signature: m.signature, manifestHash: m.manifestHash } : null,
    attestations, anchors: anchorInfo,
    ordering: { createdBlock: r.ordering.createdBlock, storedAt: r.ordering.storedAt, note: 'SyncNet-recorded: the signed intent was persisted at this block, before the transfer was enabled. Not independently verifiable.' },
    context, privacy: r.privacy, invalidated: r.invalidated || null, issuedAt: r.issuedAt,
    keys: '/api/early?view=keys', verify: 'docs/early/verify-receipt.mjs',
  };
}
async function receiptSummary(ctx, r) {
  const { context } = await receiptContext(ctx, r);
  return { receiptId: r.receiptId, intentId: r.intentId, creatorId: r.creatorId, status: r.status, mode: r.mode, earlyDate: context.earlyDate, creatorTitleThen: context.creatorTitleThen, audienceThen: context.audienceThen, txHash: r.fact.txHash, token: r.fact.transfer.token, value: r.fact.transfer.value, cardShareId: (await ctx.store.get(K.cardOf(r.receiptId))) || null };
}

// ---------------------------------------------------------------- Count me in (private, free, non-binding)
async function countSignals(store, channelId, t) {
  const fans = (await store.smembers(K.cmiSet(channelId))).slice(0, MAX_SIGNALS_COUNTED);
  let n = 0;
  for (const f of fans) { const s = (await getJson(store, K.cmi(channelId, f))).value; if (s && s.status === 'ACTIVE' && Number(s.struct.expiry) > t) n++; }
  return n;
}
async function countMeIn(b, ctx) {
  const { store, rpc, now } = ctx;
  const extra = onlyFields(b, ['action', 'channelId', 'fan', 'issuedAt', 'expiry', 'nonce', 'signature']);
  if (extra) return extra;
  if (!E.isChannelId(b.channelId)) return bad('Invalid channel id.');
  const fan = lc(b.fan), nonce = lc(b.nonce);
  if (!E.isAddr(fan) || !E.isBytes32(nonce)) return bad('Invalid wallet or nonce.');
  if (!skewOk(b.issuedAt, now)) return bad('issuedAt must be within ' + C.MAX_SKEW_S + ' seconds of the current time. Check your device clock and sign again.');
  const issuedAt = Number(b.issuedAt);
  if (Number(b.expiry) !== issuedAt + C.CMI_TTL_S) return bad('expiry must be issuedAt + ' + C.CMI_TTL_S + ' seconds.');
  const struct = { schema: E.SCHEMA.countMeIn, platform: E.PLATFORM, channelId: b.channelId, fan, issuedAt, expiry: issuedAt + C.CMI_TTL_S, nonce };
  if (!(await verifySig(rpc, fan, 'CountMeIn', struct, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this signal.');
  const cur = await getJson(store, K.cmi(b.channelId, fan));
  if (cur.value && cur.value.nonce === nonce) return json(200, { ok: true, idempotent: true, signal: publicSignal(cur.value, (await loadCreator(store, E.creatorIdOf(b.channelId))).value) });
  const wl = await limitAll(store, [{ bucket: 'early-cmi-w', id: fan, limit: 20, windowSeconds: 86400, now }, { bucket: 'early-cmi-ch', id: b.channelId, limit: 500, windowSeconds: 86400, now }]);
  if (!wl.allowed) return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
  const at = iso(now());
  const rec = cur.value && cur.value.status === 'ACTIVE'
    ? { ...cur.value, struct, signature: b.signature, nonce, renewedAt: [...(cur.value.renewedAt || []), at].slice(-10) }
    : { schema: E.SCHEMA.countMeIn, struct, signature: b.signature, nonce, status: 'ACTIVE', createdAt: at, renewedAt: [] };
  const ok = await store.cas({ expect: [[K.cmi(b.channelId, fan), cur.raw], [K.nonce(fan, nonce), null]], set: [[K.cmi(b.channelId, fan), JSON.stringify(rec), C.CMI_TTL_S + 86400], [K.nonce(fan, nonce), '1', NONCE_TTL]], sadd: [[K.cmiSet(b.channelId), fan], [K.cmiOf(fan), b.channelId]] });
  if (!ok) return (await store.get(K.nonce(fan, nonce))) ? publicError(409, 'replay', 'This nonce was already used.') : publicError(409, 'conflict', 'The signal changed while it was being recorded. Try again.');
  await bump(store, cur.value ? 'count_me_in_renewed' : 'count_me_in_signals', now);
  log(FN, 'count-me-in', { channel: hashId(b.channelId), fan: hashId(fan), renewed: Boolean(cur.value) });
  return json(cur.value ? 200 : 201, { ok: true, signal: publicSignal(rec, (await loadCreator(store, E.creatorIdOf(b.channelId))).value), note: 'Free, private and non-binding. It reserves nothing and confers no EARLY status.' });
}
async function countMeInWithdraw(b, ctx) {
  const { store, rpc, now } = ctx;
  const extra = onlyFields(b, ['action', 'channelId', 'fan', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  if (!E.isChannelId(b.channelId)) return bad('Invalid channel id.');
  const fan = lc(b.fan), nonce = lc(b.nonce);
  if (!E.isAddr(fan) || !E.isBytes32(nonce) || !skewOk(b.issuedAt, now)) return bad('Invalid wallet, nonce or issuedAt.');
  const struct = { schema: E.SCHEMA.countMeInWithdraw, channelId: b.channelId, fan, issuedAt: Number(b.issuedAt), nonce };
  if (!(await verifySig(rpc, fan, 'CountMeInWithdraw', struct, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify.');
  const cur = await getJson(store, K.cmi(b.channelId, fan));
  if (!cur.value) return publicError(404, 'not_found', 'No signal to withdraw.');
  if (cur.value.status === 'WITHDRAWN') return json(200, { ok: true, idempotent: true });
  const wl = await limit(store, { bucket: 'early-cmi-w', id: fan, limit: 20, windowSeconds: 86400, now });
  if (!wl.allowed) return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
  const rec = { ...cur.value, status: 'WITHDRAWN', withdrawnAt: iso(now()), withdraw: { struct, signature: b.signature } };
  const ok = await store.cas({ expect: [[K.cmi(b.channelId, fan), cur.raw], [K.nonce(fan, nonce), null]], set: [[K.cmi(b.channelId, fan), JSON.stringify(rec), CMI_WITHDRAWN_TTL], [K.nonce(fan, nonce), '1', NONCE_TTL]] });
  if (!ok) return publicError(409, 'conflict', 'The signal changed. Try again.');
  await bump(store, 'count_me_in_withdrawn', now);
  return json(200, { ok: true, signal: publicSignal(rec, null) });
}

// ---------------------------------------------------------------- Support intents
const tupleOf = (m) => ({ sender: m.sender, receiver: m.receiver, token: m.token, amount: m.amount });
async function intentDraft(b, ctx) {
  const { store, cfg, now, random, ip } = ctx;
  const extra = onlyFields(b, ['action', 'manifestHash', 'sender', 'token', 'amount']);
  if (extra) return extra;
  const rl = await limit(store, { bucket: 'early-draft-ip', id: ip, limit: 10, windowSeconds: 60, now });
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);
  const manifestHash = lc(b.manifestHash), sender = lc(b.sender), token = lc(b.token), amount = String(b.amount == null ? '' : b.amount);
  if (!E.isBytes32(manifestHash) || !E.isAddr(sender) || !E.isAddr(token)) return bad('Invalid manifest hash, sender or token.');
  if (!E.isRawAmount(amount)) return bad('amount must be a positive raw integer (token base units).');
  const m = (await loadManifest(store, manifestHash)).value;
  if (!m) return publicError(404, 'not_found', 'Manifest not found.');
  const c = await maybeCompleteRotation(ctx, await loadCreator(store, m.creatorId));
  if (!c) return publicError(409, 'manifest_not_active', 'This creator is not active on EARLY.');
  if (m.status !== 'ACTIVE' || c.currentManifestHash !== manifestHash) return publicError(409, 'manifest_not_active', 'This manifest is not the creator’s current one. Reload the creator page.', { 'x-early-current-manifest': c.currentManifestHash || '' });
  if (c.paused) return publicError(409, 'creator_paused', 'This creator has paused support for now.');
  if (sender === m.struct.receivingWallet) return bad('The sender cannot be the creator’s receiving wallet.');
  const asset = m.acceptedAssets.find((a) => a.token === token);
  if (!asset || !cfg.assets || !cfg.assets.has(token)) return publicError(422, 'asset_not_accepted', 'This creator does not accept that asset.');
  if (BigInt(amount) < BigInt(asset.minAmount)) return publicError(422, 'below_minimum', 'The amount is below this creator’s minimum for that asset.');
  const t = nowSec(now);
  let expiryCap = Infinity;
  if (c.status === 'ROTATION_PENDING' && c.rotation) {
    if (Number(c.rotation.effectiveAt) - t <= C.ROTATION_DRAFT_FREEZE_S) return publicError(409, 'rotation_imminent', 'This creator’s receiving wallet changes within the hour. Try again after it takes effect.');
    expiryCap = Number(c.rotation.effectiveAt);
  }
  const tuple = { sender, receiver: m.struct.receivingWallet, token, amount };
  if (await store.get(K.open(tuple))) return publicError(409, 'intent_open', 'You already have an open support intent for this exact creator, asset and amount. Finish or wait for it to expire.', { 'x-early-open-intent': (await store.get(K.open(tuple))) || '' });
  const last = Number(await store.get(K.tupleLast(tuple))) || 0;
  const notBefore = Math.max(t - C.INTENT_NOT_BEFORE_SLACK_S, last + 1);
  if (notBefore > t) return publicError(409, 'tuple_cooldown', 'A previous intent for this exact amount is still winding down. Try again in a minute.');
  const expiry = Math.min(notBefore + C.INTENT_WINDOW_S, expiryCap);
  if (expiry - t < 600) return publicError(409, 'rotation_imminent', 'Not enough time before this creator’s wallet change. Try again later.');
  const intentId = random32(random);
  const struct = { schema: E.SCHEMA.intent, intentId, manifestHash, creatorId: m.creatorId, chainId: E.CHAIN_ID, sender, receiver: m.struct.receivingWallet, token, amount, notBefore, expiry, privacy: E.PRIVACY_PRIVATE };
  const draft = { schema: 'syncnet.early.draft.v1', intentId, struct, status: 'DRAFT', createdAt: iso(now()) };
  const ok = await store.cas({ expect: [[K.draft(intentId), null]], set: [[K.draft(intentId), JSON.stringify(draft), C.DRAFT_TTL_S]] });
  if (!ok) return publicError(503, 'unavailable', UNAVAILABLE);
  await bump(store, 'intents_drafted', now);
  return json(201, { ok: true, intentId, typedData: E.typedData('SupportIntent', struct), expiresAt: expiry, draftTtlSeconds: C.DRAFT_TTL_S, asset: cfg.assets.get(token), human: E.formatUnits(amount, cfg.assets.get(token).decimals), note: 'Sign this intent first. The transfer is enabled only after SyncNet has stored your signed intent.' });
}
async function intentStore(b, ctx) {
  const { store, rpc, now } = ctx;
  const extra = onlyFields(b, ['action', 'intentId', 'signature']);
  if (extra) return extra;
  const intentId = lc(b.intentId);
  if (!E.isBytes32(intentId)) return bad('Invalid intent id.');
  const existing = await getJson(store, K.intent(intentId));
  if (existing.value) return json(200, { ok: true, idempotent: true, intent: publicIntent(existing.value) });
  const dr = await getJson(store, K.draft(intentId));
  const d = dr.value;
  if (!d || d.status !== 'DRAFT') return publicError(404, 'draft_missing', 'This draft has expired or does not exist. Start again.');
  const s = d.struct;
  if (!(await verifySig(rpc, s.sender, 'SupportIntent', s, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this intent.');
  const wl = await limit(store, { bucket: 'early-draft-w', id: s.sender, limit: 30, windowSeconds: 3600, now });
  if (!wl.allowed) return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
  const t = nowSec(now);
  if (t > Number(s.expiry) - 300) return publicError(409, 'draft_late', 'This draft is too close to its expiry. Start again.');
  // The manifest must still be the creator's current ACTIVE one at persist time (a rotation may have completed).
  const m = (await loadManifest(store, s.manifestHash)).value;
  const c = m ? (await loadCreator(store, m.creatorId)).value : null;
  if (!m || !c || m.status !== 'ACTIVE' || c.currentManifestHash !== s.manifestHash || c.paused) return publicError(409, 'manifest_not_active', 'The creator changed while you were signing. Reload and start again.');
  let createdBlock;
  try { const r = PhChain.bounded(rpc, 3); await PhChain.assertChain(r); createdBlock = (await PhChain.blockNumber(r)).toString(); }
  catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { chain: true }); }
  const tuple = tupleOf(s);
  const intent = { schema: E.SCHEMA.intent, intentId, struct: s, signature: b.signature, digest: E.digest('SupportIntent', s), status: 'OPEN', createdBlock, storedAt: iso(now()), creatorId: s.creatorId, manifestHash: s.manifestHash };
  const ok = await store.cas({
    expect: [[K.draft(intentId), dr.raw], [K.open(tuple), null], [K.intent(intentId), null]],
    set: [[K.intent(intentId), JSON.stringify(intent), INTENT_TTL], [K.open(tuple), intentId, Number(s.expiry) - t + C.MAX_SKEW_S], [K.draft(intentId), JSON.stringify({ ...d, status: 'STORED' }), 120], [K.tupleLast(tuple), String(s.expiry), 30 * 86400]],
    sadd: [[K.intentsOf(s.sender), intentId]],
  });
  if (!ok) {
    const again = (await getJson(store, K.intent(intentId))).value;
    if (again) return json(200, { ok: true, idempotent: true, intent: publicIntent(again) });
    if (await store.get(K.open(tuple))) return publicError(409, 'intent_open', 'Another intent for this exact amount was stored meanwhile.');
    return publicError(409, 'conflict', 'The draft changed while it was being stored. Try again.');
  }
  await bump(store, 'intents_stored', now);
  log(FN, 'intent-stored', { intent: intentId.slice(0, 18), creatorId: s.creatorId.slice(0, 18), sender: hashId(s.sender) });
  return json(201, { ok: true, intent: publicIntent(intent), note: 'Stored. You can now send the transfer from your own wallet directly to the creator’s verified wallet.' });
}

// ---------------------------------------------------------------- verification (public rule, idempotent, permissionless)
async function setIntentState(store, it, patch) {
  const next = { ...it.value, ...patch };
  const ok = await store.cas({ expect: [[K.intent(it.value.intentId), it.raw]], set: [[K.intent(it.value.intentId), JSON.stringify(next), INTENT_TTL]] });
  return ok ? next : null;
}
const candidateView = (c) => ({ txHash: c.txHash, logIndex: c.logIndex, blockNumber: c.blockNumber, blockTimestamp: c.blockTimestamp, state: c.state, safe: c.safe, finalized: c.finalized });
async function verify(b, ctx) {
  const { store, rpc, cfg, now, ip } = ctx;
  const extra = onlyFields(b, ['action', 'intentId', 'txHash']);
  if (extra) return extra;
  const rl = await limit(store, { bucket: 'early-verify', id: ip, limit: 30, windowSeconds: 60, now });
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);
  const intentId = lc(b.intentId), hint = b.txHash === undefined ? '' : lc(b.txHash);
  if (!E.isBytes32(intentId)) return bad('Invalid intent id.');
  if (hint && !E.isBytes32(hint)) return bad('Invalid transaction hash.');
  const it = await getJson(store, K.intent(intentId));
  const i = it.value;
  if (!i) return publicError(404, 'not_found', 'Intent not found.');
  if (i.status === 'CONSUMED') { const r = (await getJson(store, K.receipt(i.receiptId))).value; return json(200, { ok: true, idempotent: true, status: r ? r.status : 'CONSUMED', receiptId: i.receiptId, receipt: r ? await receiptSummary(ctx, r) : null }); }
  if (i.status === 'CLOSED') return json(200, { ok: false, status: 'CLOSED', reason: i.closeReason, message: 'This intent expired without a matching transfer and its recovery window has passed. Any transfer made is still the creator’s, but it cannot become an EARLY receipt.' });
  let res;
  try { res = await Match.sweep(rpc, i, { hintTx: hint || (i.observed && i.observed.txHash) || '', chunk: cfg.getLogsChunk, budget: 24 }); }
  catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { chain: true }); }
  if (res.deferred) return json(202, { ok: false, status: 'VERIFY_DEFERRED', message: 'The chain read budget for one check was reached. Verify again in a moment.' });
  const t = nowSec(now);
  const inWindow = res.candidates.filter((c) => c.state === 'in-window'), late = res.candidates.filter((c) => c.state === 'late');
  if (inWindow.length >= 2) {
    const next = await setIntentState(store, it, { status: 'AMBIGUOUS', candidates: inWindow.map(candidateView), ambiguousAt: iso(now()) });
    return json(200, { ok: false, status: 'AMBIGUOUS', needsFinalize: true, candidates: inWindow.map(candidateView), intent: publicIntent(next || i), message: 'More than one transfer matches this intent. Choose the one you meant and sign once to finalise it. The other transfer stays a direct gift to the creator without a receipt.' });
  }
  if (inWindow.length === 1) {
    const c = inWindow[0];
    if (!c.safe) { const next = await setIntentState(store, it, { observed: { txHash: c.txHash, logIndex: c.logIndex, blockNumber: c.blockNumber, at: iso(now()) }, status: i.status === 'AMBIGUOUS' ? 'OPEN' : i.status }); return json(202, { ok: false, status: 'PENDING_CONFIRMATION', candidate: candidateView(c), intent: publicIntent(next || i), message: 'Transfer found. Waiting for Robinhood Chain to mark its block SAFE.' }); }
    return finalise(ctx, it, c, 'auto', null);
  }
  if (t <= Number(i.struct.expiry) + C.MAX_SKEW_S) return json(202, { ok: false, status: i.observed ? 'PENDING_CONFIRMATION' : 'WAITING', intent: publicIntent(i), message: 'No matching transfer yet. Send the exact amount to the creator’s verified wallet, then verify again.' });
  if (late.length) {
    const next = await setIntentState(store, it, { status: 'RECOVERY_AVAILABLE', candidates: late.map(candidateView), recoveryAt: iso(now()) });
    return json(200, { ok: false, status: 'RECOVERY_AVAILABLE', needsFinalize: true, candidates: late.map(candidateView), intent: publicIntent(next || i), message: 'Your transfer was mined after the intent expired. Sign once to bind it to this intent (recovery). The EARLY date stays the transfer’s block time.' });
  }
  if (t > Number(i.struct.expiry) + C.RECOVERY_GRACE_S) { const next = await setIntentState(store, it, { status: 'CLOSED', closedAt: iso(now()), closeReason: 'expired_unmatched' }); await bump(store, 'intents_expired_unmatched', now); return json(200, { ok: false, status: 'CLOSED', intent: publicIntent(next || i), message: 'This intent expired without a matching transfer.' }); }
  const next = i.status === 'EXPIRED' ? i : await setIntentState(store, it, { status: 'EXPIRED', expiredAt: iso(now()) });
  return json(200, { ok: false, status: 'EXPIRED', intent: publicIntent(next || i), message: 'This intent has expired with no matching transfer. If you sent it late, paste the transaction hash to recover it within 24 hours.' });
}

async function finalize(b, ctx) {
  const { store, rpc, cfg, now } = ctx;
  const extra = onlyFields(b, ['action', 'intentId', 'txHash', 'logIndex', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  const intentId = lc(b.intentId), txHash = lc(b.txHash), nonce = lc(b.nonce), logIndex = Number(b.logIndex);
  if (!E.isBytes32(intentId) || !E.isBytes32(txHash) || !E.isBytes32(nonce) || !Number.isInteger(logIndex) || logIndex < 0 || logIndex > 100000) return bad('Invalid intent id, transaction hash, log index or nonce.');
  if (!skewOk(b.issuedAt, now)) return bad('issuedAt must be within ' + C.MAX_SKEW_S + ' seconds of the current time.');
  const it = await getJson(store, K.intent(intentId));
  const i = it.value;
  if (!i) return publicError(404, 'not_found', 'Intent not found.');
  if (i.status === 'CONSUMED') return json(200, { ok: true, idempotent: true, receiptId: i.receiptId });
  if (!['AMBIGUOUS', 'RECOVERY_AVAILABLE', 'EXPIRED', 'REORGED'].includes(i.status)) return publicError(409, 'not_finalizable', 'This intent does not need a finalisation signature (' + i.status + '). Use verify.');
  const struct = { schema: E.SCHEMA.finalize, intentId, txHash, logIndex, issuedAt: Number(b.issuedAt), nonce };
  if (!(await verifySig(rpc, i.struct.sender, 'SupportFinalize', struct, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for the intent’s sender.');
  if (await store.get(K.nonce(i.struct.sender, nonce))) return publicError(409, 'replay', 'This nonce was already used.');
  let re;
  try { re = await Match.recheck(rpc, i, txHash, logIndex, { chunk: cfg.getLogsChunk }); }
  catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { chain: true }); }
  if (re.deferred) return json(202, { ok: false, status: 'VERIFY_DEFERRED' });
  const c = re.candidate;
  if (!c) return publicError(409, 'no_match', 'That transaction does not match this intent under the public rule (token, sender, receiver, exact amount, successful, canonical).');
  const mode = c.state === 'in-window' ? 'ambiguous-finalized' : c.state === 'late' ? 'recovery-finalized' : null;
  if (!mode) return publicError(409, 'out_of_window', 'That transfer is outside the intent window and its 24-hour recovery grace.');
  if (mode === 'ambiguous-finalized' && i.status !== 'AMBIGUOUS' && i.status !== 'REORGED') {
    // an in-window unique match never needs a signature; the fan is steering — refuse and let verify decide
    return publicError(409, 'not_finalizable', 'This intent is not ambiguous; verify it instead (no signature needed).');
  }
  if (!c.safe) return json(202, { ok: false, status: 'PENDING_CONFIRMATION', candidate: candidateView(c) });
  return finalise(ctx, it, c, mode, { typedData: E.typedData('SupportFinalize', struct), signature: b.signature, digest: E.digest('SupportFinalize', struct), nonce });
}

/** THE critical transition: claim (txHash, logIndex), consume the intent, create the receipt — one cas. */
async function finalise(ctx, it, c, mode, fin) {
  const { store, now } = ctx;
  const i = it.value;
  const receiptId = E.receiptIdOf(E.CHAIN_ID, c.txHash, c.logIndex);
  const claim = await store.get(K.txlog(c.txHash, c.logIndex));
  if (claim !== null && claim !== i.intentId) return publicError(409, 'transfer_already_used', 'That transfer already belongs to another receipt.');
  const rc = await getJson(store, K.receipt(receiptId));
  if (rc.value && rc.value.status !== 'INVALIDATED_BY_REORG') return json(200, { ok: true, idempotent: true, receiptId, status: rc.value.status });
  const at = iso(now());
  const receipt = {
    schema: E.SCHEMA.receipt, receiptId, intentId: i.intentId, creatorId: i.creatorId, manifestHash: i.manifestHash, mode, status: c.finalized ? 'FINALIZED' : 'CONFIRMED',
    fact: { chainId: E.CHAIN_ID, txHash: c.txHash, logIndex: c.logIndex, blockNumber: c.blockNumber, blockHash: c.blockHash, blockTimestamp: c.blockTimestamp, transfer: { token: i.struct.token, from: c.from, to: c.to, value: c.value } },
    confirmation: { safeAt: at, finalizedAt: c.finalized ? at : null },
    intent: { typedData: E.typedData('SupportIntent', i.struct), signature: i.signature, digest: i.digest },
    finalize: fin ? { typedData: fin.typedData, signature: fin.signature, digest: fin.digest } : null,
    ordering: { createdBlock: i.createdBlock, storedAt: i.storedAt },
    privacy: { state: E.PRIVACY_PRIVATE, revealed: [] }, issuedAt: at,
    previous: rc.value ? { txHash: rc.value.fact.txHash, invalidatedAt: rc.value.invalidatedAt } : null,
  };
  const consumed = { ...i, status: 'CONSUMED', receiptId, consumedAt: at, candidates: null };
  // The tuple is released at the transfer's block time: a new same-amount intent may start after it (disjoint windows).
  const tuple = tupleOf(i.struct);
  const set = [[K.txlog(c.txHash, c.logIndex), i.intentId], [K.intent(i.intentId), JSON.stringify(consumed), INTENT_TTL], [K.receipt(receiptId), JSON.stringify(receipt)], [K.open(tuple), '', 1], [K.tupleLast(tuple), String(c.blockTimestamp), 30 * 86400]];
  if (fin) set.push([K.nonce(i.struct.sender, fin.nonce), '1', NONCE_TTL]);
  const expect = [[K.txlog(c.txHash, c.logIndex), claim], [K.intent(i.intentId), it.raw], [K.receipt(receiptId), rc.raw]];
  if (fin) expect.push([K.nonce(i.struct.sender, fin.nonce), null]);
  const ok = await store.cas({ expect, set, sadd: [[K.receiptsOf(i.struct.sender), receiptId], [K.receiptsOfCreator(i.creatorId), receiptId]] });
  if (!ok) {
    const again = (await getJson(store, K.intent(i.intentId))).value;
    if (again && again.status === 'CONSUMED') return json(200, { ok: true, idempotent: true, receiptId: again.receiptId });
    const who = await store.get(K.txlog(c.txHash, c.logIndex));
    if (who && who !== i.intentId) return publicError(409, 'transfer_already_used', 'That transfer already belongs to another receipt.');
    return publicError(409, 'conflict', 'The intent changed during verification. Verify again.');
  }
  await bump(store, 'receipts_confirmed', now);
  if (receipt.status === 'FINALIZED') await bump(store, 'receipts_finalized', now);
  else { try { await store.zaddMany([[K.pendingFinal, [[Number(c.blockNumber), receiptId]]]]); } catch (err) { logError(FN, 'pending-index', err, {}); } } // the scheduled job reconciles it; the UI can too
  await bump(store, 'receipts_mode_' + mode.replace(/-/g, '_'), now);
  log(FN, 'receipt', { receipt: receiptId.slice(0, 18), mode, status: receipt.status, creatorId: i.creatorId.slice(0, 18) });
  return json(200, { ok: true, status: receipt.status, receiptId, mode, receipt: await receiptSummary(ctx, receipt), message: receipt.status === 'FINALIZED' ? 'Support verified and final.' : 'Support verified. Finalising (about 15 minutes on Robinhood Chain); your EARLY card unlocks then.' });
}

/** Finality / reorg reconciliation (permissionless). Mirrors Project Home: two agreeing reads before invalidating. */
async function reconcile(b, ctx) {
  const { store, rpc, now } = ctx;
  const extra = onlyFields(b, ['action', 'intentId', 'receiptId']);
  if (extra) return extra;
  let receiptId = lc(b.receiptId);
  if (!E.isBytes32(receiptId)) { const iid = lc(b.intentId); if (!E.isBytes32(iid)) return bad('Provide intentId or receiptId.'); const i = (await getJson(store, K.intent(iid))).value; receiptId = i && i.receiptId; }
  if (!E.isBytes32(receiptId || '')) return publicError(404, 'not_found', 'No receipt for this intent.');
  const rc = await getJson(store, K.receipt(receiptId));
  const r = rc.value;
  if (!r) return publicError(404, 'not_found', 'Receipt not found.');
  if (r.status !== 'CONFIRMED') return json(200, { ok: true, changed: false, status: r.status });
  const x = PhChain.bounded(rpc, 6);
  let canonical, rcpt = null, confirm = null, fin = null;
  try {
    await PhChain.assertChain(x);
    canonical = await PhChain.block(x, BigInt(r.fact.blockNumber));
    if (!canonical) return publicError(503, 'chain_unavailable', CHAIN_DOWN);
    if (canonical.hash !== r.fact.blockHash) { rcpt = await PhChain.receipt(x, r.fact.txHash); confirm = await PhChain.block(x, BigInt(r.fact.blockNumber)); }
    else fin = await PhChain.block(x, 'finalized').catch(() => null);
  } catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { chain: true }); }
  const at = iso(now());
  if (canonical.hash !== r.fact.blockHash) {
    if ((rcpt && lc(rcpt.blockHash) === r.fact.blockHash) || !confirm || confirm.hash !== canonical.hash) return publicError(503, 'chain_inconsistent', CHAIN_DOWN);
    const next = { ...r, status: 'INVALIDATED_BY_REORG', invalidatedAt: at, invalidated: { canonicalHashAtHeight: canonical.hash, receiptBlockHash: rcpt ? lc(rcpt.blockHash) : null } };
    const it = await getJson(store, K.intent(r.intentId));
    const set = [[K.receipt(receiptId), JSON.stringify(next)]], expect = [[K.receipt(receiptId), rc.raw]];
    if (it.value) { expect.push([K.intent(r.intentId), it.raw]); set.push([K.intent(r.intentId), JSON.stringify({ ...it.value, status: 'REORGED', reorgedAt: at, receiptId: null, priorReceiptId: receiptId }), INTENT_TTL]); }
    const ok = await store.cas({ expect, set });
    if (!ok) return publicError(409, 'conflict', 'The receipt changed during reconciliation. Try again.');
    log(FN, 'receipt-invalidated-by-reorg', { receipt: receiptId.slice(0, 18) });
    return json(200, { ok: true, changed: true, status: 'INVALIDATED_BY_REORG' });
  }
  if (!fin || fin.number < BigInt(r.fact.blockNumber)) return json(200, { ok: true, changed: false, status: r.status });
  const next = { ...r, status: 'FINALIZED', confirmation: { ...r.confirmation, finalizedAt: at } };
  const ok = await store.cas({ expect: [[K.receipt(receiptId), rc.raw]], set: [[K.receipt(receiptId), JSON.stringify(next)]] });
  if (!ok) return publicError(409, 'conflict', 'The receipt changed during reconciliation. Try again.');
  await bump(store, 'receipts_finalized', now);
  return json(200, { ok: true, changed: true, status: 'FINALIZED' });
}

// ---------------------------------------------------------------- fan session + cards
async function session(b, ctx) {
  const { store, rpc, now, env } = ctx;
  const extra = onlyFields(b, ['action', 'wallet', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  const wallet = lc(b.wallet), nonce = lc(b.nonce);
  if (!E.isAddr(wallet) || !E.isBytes32(nonce) || !skewOk(b.issuedAt, now)) return bad('Invalid wallet, nonce or issuedAt.');
  const struct = { schema: E.SCHEMA.session, wallet, issuedAt: Number(b.issuedAt), nonce };
  if (!(await verifySig(rpc, wallet, 'EarlySession', struct, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify.');
  const wl = await limit(store, { bucket: 'early-session', id: wallet, limit: 10, windowSeconds: 3600, now });
  if (!wl.allowed) return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
  const ok = await store.cas({ expect: [[K.nonce(wallet, nonce), null]], set: [[K.nonce(wallet, nonce), '1', NONCE_TTL]] });
  if (!ok) return publicError(409, 'replay', 'This nonce was already used.');
  const token = Session.issue({ scope: 'fan', wallet, now, env });
  if (!token) return publicError(503, 'unavailable', UNAVAILABLE);
  return json(200, { ok: true, session: token, ttlSeconds: Session.TTL.fan, scope: 'fan' });
}
async function cardCreate(b, ctx) {
  const { store, now, random } = ctx;
  const extra = onlyFields(b, ['action', 'receiptId']);
  if (extra) return extra;
  const s = sessionOf(ctx, 'fan');
  if (!s) return publicError(401, 'session', 'A fan session is required.');
  const receiptId = lc(b.receiptId);
  if (!E.isBytes32(receiptId)) return bad('Invalid receipt id.');
  const r = (await getJson(store, K.receipt(receiptId))).value;
  if (!r || lc(r.fact.transfer.from) !== s.wallet) return publicError(404, 'not_found', 'Receipt not found for this wallet.');
  if (r.status !== 'FINALIZED') return publicError(409, 'not_final', 'Cards can be made once the transfer is FINALIZED on Robinhood Chain.');
  const existing = await store.get(K.cardOf(receiptId));
  if (existing) return json(200, { ok: true, idempotent: true, shareId: existing, url: '/labs/early/v/' + existing });
  const wl = await limit(store, { bucket: 'early-card', id: s.wallet, limit: 20, windowSeconds: 86400, now });
  if (!wl.allowed) return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
  const shareId = random32(random);
  const card = { schema: 'syncnet.early.card.v1', shareId, receiptId, revealed: [], createdAt: iso(now()), suspended: false };
  const ok = await store.cas({ expect: [[K.cardOf(receiptId), null], [K.card(shareId), null]], set: [[K.cardOf(receiptId), shareId], [K.card(shareId), JSON.stringify(card)]] });
  if (!ok) { const again = await store.get(K.cardOf(receiptId)); return again ? json(200, { ok: true, idempotent: true, shareId: again, url: '/labs/early/v/' + again }) : publicError(409, 'conflict', 'Try again.'); }
  await bump(store, 'cards_generated', now);
  return json(201, { ok: true, shareId, url: '/labs/early/v/' + shareId, defaults: { wallet: 'hidden', identity: 'hidden', amount: 'hidden', transaction: 'hidden' } });
}
async function cardEvent(b, ctx) {
  const { store, now } = ctx;
  const extra = onlyFields(b, ['action', 'shareId', 'event']);
  if (extra) return extra;
  const s = sessionOf(ctx, 'fan');
  if (!s) return publicError(401, 'session', 'A fan session is required.');
  const shareId = lc(b.shareId);
  if (!E.isBytes32(shareId) || b.event !== 'link_copied') return bad('Invalid share id or event.');
  const card = (await getJson(store, K.card(shareId))).value;
  const r = card ? (await getJson(store, K.receipt(card.receiptId))).value : null;
  if (!r || lc(r.fact.transfer.from) !== s.wallet) return publicError(404, 'not_found', 'Card not found.');
  await bump(store, 'share_links_copied', now);
  return json(200, { ok: true });
}
async function cardView(ctx) {
  const { store, now, ipHash, ip } = ctx;
  const rl = await limit(store, { bucket: 'early-card-view', id: ip, limit: 60, windowSeconds: 60, now });
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);
  const shareId = lc(query(ctx.event, 'shareId'));
  if (!E.isBytes32(shareId)) return bad('Invalid share id.');
  const card = (await getJson(store, K.card(shareId))).value;
  if (!card || card.suspended) return publicError(404, 'not_found', 'Card not found.');
  const r = (await getJson(store, K.receipt(card.receiptId))).value;
  if (!r || r.status !== 'FINALIZED') return publicError(404, 'not_found', 'Card not found.');
  const { manifest: m, context, attestations } = await receiptContext(ctx, r);
  // one visit per (card, ip, hour): "verification-page visits", never "shares"
  try { if (await store.cas({ expect: [[K.visit(shareId, ipHash, Math.floor(nowSec(now) / 3600)), null]], set: [[K.visit(shareId, ipHash, Math.floor(nowSec(now) / 3600)), '1', 3600]] })) await bump(store, 'verification_page_visits', now); } catch (err) { logError(FN, 'visit-metric', err, {}); }
  const revealed = Array.isArray(card.revealed) ? card.revealed : [];
  return json(200, {
    enabled: true, shareId, card: {
      headline: 'EARLY', line: 'I WAS THERE WHEN.', creator: context.creatorTitleThen, creatorChannelId: m ? m.channelId : null, creatorId: r.creatorId,
      supportedOn: context.earlyDate, audienceThen: context.audienceThen, verified: 'SYNC Proof verified',
      revealed, wallet: revealed.includes('transaction') ? r.fact.transfer.from : null, amount: revealed.includes('transaction') ? { token: r.fact.transfer.token, value: r.fact.transfer.value } : null,
      transaction: revealed.includes('transaction') ? { chainId: E.CHAIN_ID, txHash: r.fact.txHash, logIndex: r.fact.logIndex } : null,
    },
    verification: {
      what: 'SyncNet holds a fan-signed support intent and matched it to exactly one successful on-chain transfer to this creator’s verified wallet on this date, under the public rule ' + E.SCHEMA.matching + '.',
      independentlyVerifiable: revealed.includes('transaction') ? ['transfer', 'fan signature', 'creator manifest', 'attestations'] : ['creator identity attestation', 'creator manifest attestation', 'audience snapshot attestation'],
      notShown: revealed.includes('transaction') ? [] : ['supporter wallet', 'amount', 'transaction (hidden by the holder; without it the transfer itself cannot be independently checked)'],
      attestations, receiptSchema: E.SCHEMA.receipt, keys: '/api/early?view=keys',
    },
  });
}

// ---------------------------------------------------------------- creator: link (OAuth start), manifest, pause, rotation
async function creatorLink(b, ctx) {
  const { store, rpc, cfg, now, env } = ctx;
  const extra = onlyFields(b, ['action', 'wallet', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  const wallet = lc(b.wallet), nonce = lc(b.nonce);
  if (!E.isAddr(wallet) || !E.isBytes32(nonce) || !skewOk(b.issuedAt, now)) return bad('Invalid wallet, nonce or issuedAt.');
  const struct = { schema: E.SCHEMA.creatorLink, wallet, issuedAt: Number(b.issuedAt), nonce };
  if (!(await verifySig(rpc, wallet, 'CreatorLinkRequest', struct, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify.');
  if (!cfg.oauth.configured || !cfg.sessions.configured) return publicError(503, 'oauth_unavailable', 'Creator onboarding is not open on this deployment.');
  const ok = await store.cas({ expect: [[K.nonce(wallet, nonce), null]], set: [[K.nonce(wallet, nonce), '1', NONCE_TTL]] });
  if (!ok) return publicError(409, 'replay', 'This nonce was already used.');
  const state = Session.issue({ scope: 'state', wallet, now, env });
  if (!state) return publicError(503, 'unavailable', UNAVAILABLE);
  return json(200, { ok: true, startUrl: '/api/early-youtube-auth?start=' + encodeURIComponent(state), ttlSeconds: Session.TTL.state, scope: 'https://www.googleapis.com/auth/youtube.readonly' });
}
async function freshLink(store, s) {
  const link = (await getJson(store, K.oauth(s.sid)));
  return link.value && link.value.channelId === s.channelId && lc(link.value.wallet) === s.wallet ? link : { raw: null, value: null };
}
async function creatorManifest(b, ctx) {
  const { store, rpc, cfg, now, signer } = ctx;
  const extra = onlyFields(b, ['action', 'creatorId', 'channelId', 'receivingWallet', 'acceptedAssets', 'acceptedAssetsHash', 'manifestVersion', 'previousManifestHash', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  const s = sessionOf(ctx, 'creator');
  if (!s) return publicError(401, 'session', 'A creator session (YouTube sign-in) is required.');
  if (!signer) return publicError(503, 'attestation_unavailable', ATT_DOWN);
  if (!E.isChannelId(b.channelId) || b.channelId !== s.channelId) return publicError(403, 'channel_mismatch', 'The manifest must name the YouTube channel you signed in with.');
  const creatorId = E.creatorIdOf(b.channelId);
  if (lc(b.creatorId) !== creatorId) return bad('creatorId must be derived from the channel id.');
  const wallet = lc(b.receivingWallet), nonce = lc(b.nonce), prev = lc(b.previousManifestHash);
  if (!E.isAddr(wallet) || !E.isBytes32(nonce) || !E.isBytes32(prev) || !skewOk(b.issuedAt, now)) return bad('Invalid wallet, nonce, previous hash or issuedAt.');
  const version = Number(b.manifestVersion);
  if (!Number.isInteger(version) || version < 1 || version > 1000) return bad('Invalid manifest version.');
  const na = E.normalizeAcceptedAssets(b.acceptedAssets, cfg.assets);
  if (!na.ok) return publicError(400, 'asset_not_allowed', 'Accepted assets: ' + na.error + '.');
  if (lc(b.acceptedAssetsHash) !== na.hash) return bad('acceptedAssetsHash does not match the accepted assets list.');
  const struct = { schema: E.SCHEMA.manifest, creatorId, platform: E.PLATFORM, channelId: b.channelId, chainId: E.CHAIN_ID, receivingWallet: wallet, acceptedAssetsHash: na.hash, manifestVersion: version, previousManifestHash: prev, issuedAt: Number(b.issuedAt), nonce };
  if (!(await verifySig(rpc, wallet, 'CreatorManifest', struct, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for the receiving wallet.');
  const link = await freshLink(store, s);
  if (!link.value) return publicError(403, 'reverify', 'Fresh YouTube verification is required (sign in with YouTube again).');
  const wl = await limit(store, { bucket: 'early-creator-w', id: b.channelId, limit: 20, windowSeconds: 86400, now });
  if (!wl.allowed) return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
  const manifestHash = E.digest('CreatorManifest', struct);
  const t = nowSec(now), at = iso(now()), bd = await Attest.bundleDateFor(store, t);
  const cr = await loadCreator(store, creatorId);
  const c = await maybeCompleteRotation(ctx, cr);
  const cr2 = c === cr.value ? cr : await loadCreator(store, creatorId);
  if (await getJson(store, K.manifest(manifestHash)).then((x) => x.value)) return publicError(409, 'duplicate', 'This exact manifest already exists.');
  const display = { title: E.clean(link.value.title, 80), avatarUrl: link.value.avatarUrl || '', handle: E.clean(link.value.handle, 40) };
  const oauthSeen = [...new Set([...(c ? c.oauthSeen || [] : []), Number(link.value.at)])].slice(-30);
  const consumedLink = JSON.stringify({ ...link.value, consumedBy: manifestHash });

  if (!c) {
    if (version !== 1 || prev !== E.ZERO32) return bad('The first manifest must be version 1 with a zero previous hash.');
    const signals = await countSignals(store, b.channelId, t);
    const attId = Attest.build(signer, { type: 'creator-identity', subject: { creatorId, channelId: b.channelId }, claims: { platform: E.PLATFORM, channelId: b.channelId, receivingWallet: wallet, manifestHash, manifestVersion: 1, verifiedAt: Number(link.value.at), method: 'google-oauth2 youtube.readonly channels.mine', title: display.title }, issuedAt: t, bundleDate: bd });
    const attM = Attest.build(signer, { type: 'creator-manifest', subject: { creatorId, manifestHash }, claims: { manifestVersion: 1, previousManifestHash: E.ZERO32, status: 'ACTIVE', effectiveAt: t, supersededAt: null, at: t }, issuedAt: t, bundleDate: bd });
    const manifest = { schema: E.SCHEMA.manifest, struct, acceptedAssets: na.assets, signature: b.signature, signer: wallet, manifestHash, creatorId, channelId: b.channelId, status: 'ACTIVE', effectiveAt: t, supersededAt: null, supersededBy: null, identityAttestationId: attId.id, attestationIds: [attM.id], createdAt: at };
    const creator = { schema: 'syncnet.early.creator.v1', creatorId, channelId: b.channelId, platform: E.PLATFORM, status: 'ACTIVE', paused: false, currentManifestHash: manifestHash, pendingManifestHash: null, display, displayUpdatedAt: at, joinedAt: t, signalsWaitingAtJoin: signals, rotation: null, rotations: [], oauthSeen, createdAt: at };
    const w = [attId, attM].map(Attest.writesFor);
    const ok = await store.cas({
      expect: [[K.creator(creatorId), null], [K.manifest(manifestHash), null], [K.nonce(wallet, nonce), null], [K.oauth(s.sid), link.raw]],
      set: [[K.creator(creatorId), JSON.stringify(creator)], [K.manifest(manifestHash), JSON.stringify(manifest)], [K.nonce(wallet, nonce), '1', NONCE_TTL], [K.oauth(s.sid), consumedLink, 300], ...w.flatMap((x) => x.set)],
      sadd: [[K.manifestsOf(creatorId), manifestHash], [K.creators, creatorId], ...w.flatMap((x) => x.sadd)],
    });
    if (!ok) return (await store.get(K.nonce(wallet, nonce))) ? publicError(409, 'replay', 'This nonce was already used.') : publicError(409, 'conflict', 'This channel was claimed meanwhile. Reload.');
    await enrolmentSnapshot(ctx, b.channelId, link.value, t, bd);
    await bump(store, 'creators_claimed', now);
    if (signals > 0) await bump(store, 'claims_with_signals_waiting', now);
    log(FN, 'creator-activated', { creatorId: creatorId.slice(0, 18), signals });
    return json(201, { ok: true, creator: { ...publicCreator(creator, manifest), signalsWaitingAtJoin: signals }, manifest: publicManifest(manifest), signalsNote: signals === 1 ? '1 signed interest signal was waiting when you joined.' : signals + ' signed interest signals were waiting when you joined.' });
  }

  // ---- rotation (new receiving wallet): fresh OAuth (checked above) + new wallet signature + 48 h cooldown
  const cur = (await loadManifest(store, c.currentManifestHash)).value;
  if (!cur) return publicError(503, 'unavailable', UNAVAILABLE);
  if (c.status === 'ROTATION_PENDING') return publicError(409, 'rotation_pending', 'A receiving-wallet change is already pending. Cancel it first or wait for it to take effect.');
  if (version !== cur.struct.manifestVersion + 1 || prev !== cur.manifestHash) return publicError(409, 'stale_manifest', 'A new manifest must be version ' + (cur.struct.manifestVersion + 1) + ' and reference the current manifest hash ' + cur.manifestHash + '.', { 'x-early-current-manifest': cur.manifestHash });
  if (wallet === cur.struct.receivingWallet) return publicError(409, 'same_wallet', 'The new receiving wallet must differ from the current one. To change accepted assets only, this pilot requires a new wallet version too; contact SyncNet.');
  const lock = c.rotation && c.rotation.lockedUntil && Number(c.rotation.lockedUntil) > t;
  if (lock) {
    // Locked after a current-wallet cancel: the OAuth holder needs two verified sessions ≥ 24 h apart, the later one now.
    const since = Number(c.rotation.lockedAt || 0);
    const earlier = oauthSeen.some((x) => x >= since && Number(link.value.at) - x >= 86400);
    if (!earlier) return publicError(409, 'rotation_locked', 'The current wallet cancelled a change recently. To change the wallet anyway, sign in with YouTube again at least 24 hours after your last sign-in; the change then takes 48 hours.');
  }
  const effectiveAt = t + C.ROTATION_COOLDOWN_S;
  const attM = Attest.build(signer, { type: 'creator-manifest', subject: { creatorId, manifestHash }, claims: { manifestVersion: version, previousManifestHash: prev, status: 'PENDING', effectiveAt, supersededAt: null, at: t }, issuedAt: t, bundleDate: bd });
  const manifest = { schema: E.SCHEMA.manifest, struct, acceptedAssets: na.assets, signature: b.signature, signer: wallet, manifestHash, creatorId, channelId: b.channelId, status: 'PENDING', effectiveAt, supersededAt: null, supersededBy: null, identityAttestationId: null, attestationIds: [attM.id], createdAt: at };
  const creator = { ...c, status: 'ROTATION_PENDING', pendingManifestHash: manifestHash, display, displayUpdatedAt: at, oauthSeen, rotation: { ...(c.rotation || {}), startedAt: t, effectiveAt, newWallet: wallet, pendingManifestHash: manifestHash, cancelledBy: null, cancelledAt: null, completedAt: null } };
  const w = Attest.writesFor(attM);
  const ok = await store.cas({
    expect: [[K.creator(creatorId), cr2.raw], [K.manifest(manifestHash), null], [K.nonce(wallet, nonce), null], [K.oauth(s.sid), link.raw]],
    set: [[K.creator(creatorId), JSON.stringify(creator)], [K.manifest(manifestHash), JSON.stringify(manifest)], [K.nonce(wallet, nonce), '1', NONCE_TTL], [K.oauth(s.sid), consumedLink, 300], ...w.set],
    sadd: [[K.manifestsOf(creatorId), manifestHash], ...w.sadd],
  });
  if (!ok) return (await store.get(K.nonce(wallet, nonce))) ? publicError(409, 'replay', 'This nonce was already used.') : publicError(409, 'conflict', 'The creator changed meanwhile. Reload.');
  await bump(store, 'rotations_started', now);
  log(FN, 'rotation-started', { creatorId: creatorId.slice(0, 18), version });
  return json(201, { ok: true, creator: publicCreator(creator, cur), pendingManifest: publicManifest(manifest), effectiveAt, warning: 'Your receiving wallet changes on ' + new Date(effectiveAt * 1000).toISOString() + '. Until then support goes to your current wallet. Your current wallet can cancel this change.' });
}
/** The join-day audience snapshot, from the OAuth link record (a YouTube value read at that moment), if none exists yet. */
async function enrolmentSnapshot(ctx, channelId, link, t, bd) {
  const { store, signer } = ctx;
  const d = E.utcDate(t);
  try {
    if (await store.get(K.snap(channelId, d))) return;
    const rec = Attest.build(signer, { type: 'audience-snapshot', subject: { channelId }, claims: { channelId, dateUTC: d, title: E.clean(link.title, 80), subscriberCount: link.hiddenSubscriberCount || link.subscriberCount == null ? null : Number(link.subscriberCount), hiddenSubscriberCount: Boolean(link.hiddenSubscriberCount), fetchedAt: Number(link.at), source: 'youtube-data-api-v3 channels.list statistics (oauth link, enrolment)' }, issuedAt: t, bundleDate: bd });
    const w = Attest.writesFor(rec);
    await store.cas({ expect: [[K.snap(channelId, d), null]], set: [[K.snap(channelId, d), JSON.stringify(rec)], ...w.set], sadd: [[K.snapDays(channelId), d], ...w.sadd] });
  } catch (err) { logError(FN, 'enrolment-snapshot-failed', err, { channel: hashId(channelId) }); }
}
async function creatorPause(b, ctx, pause) {
  const { store, now } = ctx;
  const extra = onlyFields(b, ['action']);
  if (extra) return extra;
  const s = sessionOf(ctx, 'creator');
  if (!s) return publicError(401, 'session', 'A creator session is required.');
  const cr = await loadCreator(store, E.creatorIdOf(s.channelId));
  if (!cr.value) return publicError(404, 'not_found', 'This channel is not on EARLY yet.');
  if (Boolean(cr.value.paused) === pause) return json(200, { ok: true, idempotent: true, paused: pause });
  const ok = await store.cas({ expect: [[K.creator(cr.value.creatorId), cr.raw]], set: [[K.creator(cr.value.creatorId), JSON.stringify({ ...cr.value, paused: pause, pausedAt: pause ? iso(now()) : null })]] });
  if (!ok) return publicError(409, 'conflict', 'Try again.');
  log(FN, pause ? 'creator-paused' : 'creator-resumed', { creatorId: cr.value.creatorId.slice(0, 18) });
  return json(200, { ok: true, paused: pause });
}
async function rotationCancel(b, ctx) {
  const { store, rpc, now } = ctx;
  const extra = onlyFields(b, ['action', 'creatorId', 'pendingManifestHash', 'issuedAt', 'nonce', 'signature']);
  if (extra) return extra;
  const creatorId = lc(b.creatorId), pending = lc(b.pendingManifestHash);
  if (!E.isBytes32(creatorId) || !E.isBytes32(pending)) return bad('Invalid creator id or manifest hash.');
  const cr = await loadCreator(store, creatorId);
  const c = cr.value;
  if (!c) return publicError(404, 'not_found', 'Creator not found.');
  if (c.status !== 'ROTATION_PENDING' || !c.rotation || c.rotation.pendingManifestHash !== pending) return publicError(409, 'no_rotation', 'There is no pending change with that manifest hash.');
  const t = nowSec(now), at = iso(now());
  let by = null, nonce = null, wallet = null;
  const s = sessionOf(ctx, 'creator');
  if (s && s.channelId === c.channelId && b.signature === undefined) by = 'creator-session';
  else {
    nonce = lc(b.nonce);
    if (!E.isBytes32(nonce) || !skewOk(b.issuedAt, now)) return bad('Invalid nonce or issuedAt.');
    const cur = (await loadManifest(store, c.currentManifestHash)).value;
    wallet = cur ? cur.struct.receivingWallet : null;
    if (!wallet) return publicError(503, 'unavailable', UNAVAILABLE);
    const struct = { schema: E.SCHEMA.rotationCancel, creatorId, pendingManifestHash: pending, issuedAt: Number(b.issuedAt), nonce };
    if (!(await verifySig(rpc, wallet, 'RotationCancel', struct, b.signature))) return publicError(401, 'bad_signature', 'Only the current receiving wallet (or a creator session) can cancel.');
    if (c.rotation.lastCancelBy === wallet && t - Number(c.rotation.lastCancelAt || 0) < C.ROTATION_CANCEL_REPEAT_S) return publicError(409, 'cancel_repeat', 'This wallet already cancelled a change recently; it cannot cancel again for 30 days. The channel owner can still change the wallet after two YouTube sign-ins 24 hours apart.');
    by = 'current-wallet';
  }
  const pm = await loadManifest(store, pending);
  if (!pm.value) return publicError(503, 'unavailable', UNAVAILABLE);
  const rotation = { ...c.rotation, cancelledBy: by, cancelledAt: t, ...(by === 'current-wallet' ? { lockedUntil: t + C.ROTATION_LOCK_S, lockedAt: t, lastCancelBy: wallet, lastCancelAt: t } : {}) };
  const creator = { ...c, status: 'ACTIVE', pendingManifestHash: null, rotation };
  const set = [[K.creator(creatorId), JSON.stringify(creator)], [K.manifest(pending), JSON.stringify({ ...pm.value, status: 'CANCELLED', cancelledAt: t, cancelledBy: by })]];
  const expect = [[K.creator(creatorId), cr.raw], [K.manifest(pending), pm.raw]];
  if (nonce) { expect.push([K.nonce(wallet, nonce), null]); set.push([K.nonce(wallet, nonce), '1', NONCE_TTL]); }
  const ok = await store.cas({ expect, set });
  if (!ok) return publicError(409, 'conflict', 'The creator changed meanwhile. Reload.');
  log(FN, 'rotation-cancelled', { creatorId: creatorId.slice(0, 18), by });
  return json(200, { ok: true, cancelledBy: by, locked: by === 'current-wallet', at });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, publicCreator, publicIntent, receiptDocument, countSignals, maybeCompleteRotation, enrolmentSnapshot, finalise };
