'use strict';
/*
 * SyncNet Economies V0 — signed, append-only curation on top of DERIVED Economy membership.
 *
 *   GET  /api/economies?view=config
 *   GET  /api/economies?view=economy&root=0x…     -> curator + the children the current curator recognizes
 *   POST /api/economies {action:'curate'|'claim-request', ...message, signature}
 *
 * Model (see docs/ECONOMIES.md):
 *  - Membership is NEVER stored: the Economy of R is every PAR launch with a market paired with R, derived by the
 *    page from /api/par-launches-all. This function stores only signed curation events.
 *  - Storage is append-only: one Redis SET per root (eco:cur:v1:<root>) whose members are the canonical JSON of
 *    each signed event. The only write is SADD (atomic). No read-modify-write, no nonce keys, no SET/DEL: the
 *    current state is folded at read time from the SIGNED issuedAt, so concurrent writes cannot lose each other
 *    and a replayed old event cannot override a newer one (lib/syncnet-economy.js fold()).
 *  - The curator of R is, in order: the Project Passport operator (mp:passport:v1:<R>, READ ONLY — never written
 *    here), else a reviewed entry in syncnet-economies.json. Nothing else (no symbol, no owner(), no body field).
 *    Events count only while their signer is the CURRENT curator; an operator change makes old ones inert.
 *  - A 'recognize' is accepted only if the child's live PAR factory record has a market paired with R.
 *  - Soft cap: at MAX_EVENTS_PER_ROOT stored events a root accepts no new recognitions (nor no-op revokes); a
 *    revoke of a currently recognized child is ALWAYS accepted, so a curator can always clean up.
 *  - Rollout gate: flags.js economyCuration (SYNCNET_ECONOMY_CURATION=true + durable store, kill switch
 *    SYNCNET_ECONOMIES_DISABLED). Reads work whenever a durable store exists.
 *  - Pending curator requests (eco:req:v1:<root>, incl. claimant + evidence URL) are NEVER served over HTTP: there is
 *    no maintainer-authenticated read in V0, so maintainers inspect them directly in the durable store.
 *  - The per-wallet write limit (and the global claim limit) is charged only AFTER the signature verified AND only
 *    for an actionable write: naming someone else's address, or replaying a public signed event (duplicate /
 *    stale / full, all no-ops), cannot exhaust their bucket. Pre-verification limits are per IP only.
 */
const Chain = require('../../lib/syncnet-chain.js');
const Economy = require('../../lib/syncnet-economy.js');
const GRANTS_FILE = require('../../syncnet-economies.json');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit, limitAll } = require('../lib/ratelimit');
const { flags } = require('../lib/flags');
const { serverRpc } = require('../lib/chain-rpc');
const { readJsonBody, query, method: methodOf } = require('../lib/body');
const { verifyDigest } = require('../lib/sig-verify');

const FN = 'economies';
const K = {
  curation: (root) => `eco:cur:v1:${root}`,
  requests: (root) => `eco:req:v1:${root}`,
  passport: (token) => `mp:passport:v1:${token}`, // Marketplace-owned: READ ONLY here
};
const lc = Economy.lc;
const nowSec = () => Math.floor(Date.now() / 1000);
const CLOSED = 'Economy curation is not enabled on this deployment.';
const UNAVAILABLE = 'Economies are temporarily unavailable.';

// ---------------------------------------------------------------- manual curator grants (git-reviewed file)
function loadGrants(file) {
  const out = new Map();
  for (const g of (file && Array.isArray(file.curators) ? file.curators : [])) {
    const since = Date.parse(g && g.since);
    if (!g || !Economy.isRootAddr(g.root) || !Economy.isAddr(g.curator) || !Number.isFinite(since)) continue;
    out.set(lc(g.root), { address: lc(g.curator), source: 'manual', since: Math.floor(since / 1000) });
  }
  return out;
}
const GRANTS = loadGrants(GRANTS_FILE);

/** {address, source:'passport'|'manual', since} or null. Store errors propagate (callers answer 503). */
async function resolveCurator(store, root, grants) {
  const raw = await store.get(K.passport(root));
  let p = null;
  try { p = raw ? JSON.parse(raw) : null; } catch { p = null; }
  if (p && Economy.isAddr(p.operator)) {
    const t = Date.parse(p.operatorSince);
    // an unreadable start time fails safe: only events signed from now on can count
    return { address: lc(p.operator), source: 'passport', since: Number.isFinite(t) ? Math.floor(t / 1000) : nowSec() };
  }
  return grants.get(root) || null;
}
const publicCurator = (c) => c && { address: c.address, source: c.source, since: new Date(c.since * 1000).toISOString() };
const publicEvent = (e) => ({ id: e.id, child: e.child, curator: e.curator, decision: e.decision, issuedAt: e.issuedAt, nonce: e.nonce, signature: e.signature });

// ---------------------------------------------------------------- signature verification (server-side, always)
async function verifySig(rpc, wallet, digest, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,8190}$/.test(signature)) return false;
  return verifyDigest(rpc, wallet, digest, signature); // ECDSA, then EIP-1271 (netlify/lib/sig-verify.js, shared)
}

/** Live PAR factory read: is `child` a PAR launch with a market paired with `root`? true | false | throws. */
async function connectedOnChain(rpc, root, child) {
  const launch = await Chain.readLaunch(rpc, child);
  if (!launch) return false;
  const markets = await Chain.readMarkets(rpc, child, launch);
  return markets.some((m) => lc(m.pairToken) === root);
}

/** Per-wallet write limit. Call ONLY after `wallet`'s signature has verified. Returns a response when denied, else null. */
async function walletLimited(store, wallet) {
  const wl = await limit(store, { bucket: 'eco-wallet', id: wallet, limit: 120, windowSeconds: 3600 });
  if (wl.allowed) return null;
  return wl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(wl.retryAfter);
}

const bad = (message) => publicError(400, 'invalid_request', message || 'Invalid request.');
const skewOk = (t) => Math.abs(t - nowSec()) <= Economy.MAX_SKEW;

// =====================================================================================================================
async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  const store = deps.store || getStore();
  const env = deps.env || process.env;
  const gate = flags({ store, env });
  const ip = clientIp(event);
  const rpc = deps.rpc || serverRpc();
  const grants = deps.grants ? loadGrants(deps.grants) : GRANTS;
  const denied = (rl) => rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);

  if (method === 'GET') {
    const rl = await limit(store, { bucket: 'eco-read', id: ip, limit: 120, windowSeconds: 60 });
    if (!rl.allowed) return denied(rl);
    const view = query(event, 'view') || 'economy';
    if (view === 'config') return json(200, { curation: gate.economyCuration, durable: Boolean(store.durable), chainId: Economy.CHAIN_ID, maxSkew: Economy.MAX_SKEW });
    if (view !== 'economy') return bad('Unknown view.');
    const root = lc(query(event, 'root'));
    if (!Economy.isRootAddr(root)) return bad('Invalid root address.');
    if (!store.durable) return json(200, { curation: false, durable: false, root, curator: null, recognized: [] });
    try {
      const curator = await resolveCurator(store, root, grants);
      const folded = Economy.fold(await store.smembers(K.curation(root)), root, curator);
      return json(200, {
        curation: gate.economyCuration, durable: true, root, curator: publicCurator(curator),
        recognized: folded.recognized.map(publicEvent), events: folded.total, inert: folded.ignored,
      });
    } catch (err) {
      logError(FN, 'read-failed', err, { view });
      return publicError(503, 'unavailable', UNAVAILABLE);
    }
  }

  if (method !== 'POST') return publicError(405, 'method_not_allowed', 'GET or POST only.', { allow: 'GET, POST' });
  if (!gate.economyCuration) return publicError(503, 'closed', CLOSED);
  const rl = await limitAll(store, [
    { bucket: 'eco-write', id: ip, limit: 20, windowSeconds: 60 },
    { bucket: 'eco-write-h', id: ip, limit: 200, windowSeconds: 3600 },
  ]);
  if (!rl.allowed) return denied(rl);
  const b = readJsonBody(event, 8192);
  if (!b || typeof b.action !== 'string') return bad('A JSON body with an action is required.');
  try {
    if (b.action === 'curate') return await curate(b, { store, rpc, ip, grants });
    if (b.action === 'claim-request') return await claimRequest(b, { store, rpc, ip, grants });
    return bad('Unknown action.');
  } catch (err) {
    logError(FN, 'write-crashed', err, { action: String(b.action).slice(0, 24) });
    return publicError(503, 'unavailable', UNAVAILABLE);
  }
}

// ---------------------------------------------------------------- curate: recognize / revoke one child
async function curate(b, { store, rpc, ip, grants }) {
  const checked = Economy.curationMessage(b);
  if (!checked.ok) return bad('Invalid or missing field: ' + checked.field + '.');
  const msg = checked.message;
  if (!skewOk(msg.issuedAt)) return bad('issuedAt must be within ' + Economy.MAX_SKEW + ' seconds of the current time. Check your device clock and sign again.');
  const curator = await resolveCurator(store, msg.root, grants);
  if (!curator) return publicError(403, 'no_curator', 'This root has no curator yet. For a PAR launch, its deployer or creator-fee recipient can claim the Project Passport in the Marketplace.');
  if (msg.curator !== curator.address) return publicError(403, 'not_curator', 'Only the current curator of this root can recognize or revoke projects.');
  if (!Economy.counts(msg, curator)) return publicError(409, 'before_curatorship', 'This signature predates the current curatorship. Sign again.');
  const id = Economy.digest('EconomyCuration', msg);
  if (!(await verifySig(rpc, curator.address, id, b.signature))) {
    log(FN, 'bad-signature', { ip: hashId(ip), root: msg.root });
    return publicError(401, 'bad_signature', 'The signature does not verify for this curation.');
  }
  // Curation events are public, so any valid signature can be replayed by anyone. Duplicate / stale / full
  // outcomes write nothing and are answered BEFORE the wallet bucket is charged, so replays cannot exhaust it.
  const members = await store.smembers(K.curation(msg.root));
  const { latest } = Economy.latestByChild(members, msg.root, curator);
  const current = latest.get(msg.child) || null;
  const recognizedNow = Boolean(current && current.decision === 'recognize');
  if (current && current.id === id) return json(200, { ok: true, duplicate: true, id, recognized: recognizedNow });
  // Advisory only (check-then-act): the fold is order-independent, so a race here cannot corrupt state.
  if (current && Economy.newer(current, { issuedAt: msg.issuedAt, id })) return publicError(409, 'stale', 'A newer decision for this project already exists. Reload and sign again.');
  // Soft cap. Below it every non-stale event is stored (so the fold always reflects the curator's latest SIGNED
  // intent, whatever the arrival order). At the cap, only a revoke that actually removes a recognition is still
  // accepted — a curator can always clean up. Since each such revoke needs a recognition stored before the cap,
  // the set stays bounded (~2x the cap).
  const full = members.length >= Economy.MAX_EVENTS_PER_ROOT;
  if (full && !(msg.decision === 'revoke' && recognizedNow)) {
    return publicError(409, 'full', 'This Economy has reached its curation-event limit. Revoking a current recognition still works; new recognitions are paused.');
  }
  // Actionable write (it can add a new event): only now is the curator's wallet bucket charged.
  const limited = await walletLimited(store, curator.address);
  if (limited) return limited;
  if (msg.decision === 'recognize') {
    let ok;
    try { ok = await connectedOnChain(rpc, msg.root, msg.child); } catch (err) {
      logError(FN, 'chain-unavailable', err, { root: msg.root });
      return publicError(503, 'unavailable', 'Robinhood Chain could not be read right now. Try again.');
    }
    if (!ok) return publicError(422, 'not_connected', 'This project has no on-chain PAR market paired with this root, so it cannot be recognized.');
  }
  const added = await store.sadd(K.curation(msg.root), Economy.member('EconomyCuration', msg, b.signature));
  log(FN, msg.decision === 'recognize' ? 'recognized' : 'revoked', { root: msg.root, child: msg.child, curator: hashId(curator.address) });
  return json(200, { ok: true, duplicate: added === 0, id, recognized: msg.decision === 'recognize' });
}

// ---------------------------------------------------------------- claim request (roots with no provable curator)
async function claimRequest(b, { store, rpc, ip, grants }) {
  // Only the per-IP limit applies before verification; the global bucket counts verified requests only, so
  // invalid requests from many IPs cannot exhaust it and block legitimate claimants.
  const rl = await limit(store, { bucket: 'eco-claim', id: ip, limit: 5, windowSeconds: 3600 });
  if (!rl.allowed) return rl.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(rl.retryAfter);
  const checked = Economy.claimRequestMessage(b);
  if (!checked.ok) return bad('Invalid or missing field: ' + checked.field + '.');
  const msg = checked.message;
  if (!skewOk(msg.issuedAt)) return bad('issuedAt must be within ' + Economy.MAX_SKEW + ' seconds of the current time.');
  if (await resolveCurator(store, msg.root, grants)) return publicError(409, 'has_curator', 'This root already has a curator.');
  let launch, code;
  try { [launch, code] = await Promise.all([Chain.readLaunch(rpc, msg.root), Chain.getCode(rpc, msg.root)]); } catch (err) {
    logError(FN, 'chain-unavailable', err, { root: msg.root });
    return publicError(503, 'unavailable', 'Robinhood Chain could not be read right now. Try again.');
  }
  if (launch) return publicError(409, 'use_passport_claim', 'This root is a PAR launch: its curator is proven on-chain by claiming the Project Passport in the Marketplace, not by a manual request.');
  if (!code || code === '0x') return publicError(422, 'not_contract', 'This address is not a contract on Robinhood Chain.');
  const id = Economy.digest('EconomyClaimRequest', msg);
  if (!(await verifySig(rpc, msg.claimant, id, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this request.');
  // An exact duplicate or a full root writes nothing, so it is answered before any authenticated quota is charged.
  const members = await store.smembers(K.requests(msg.root));
  if (members.some((m) => { const r = Economy.parseMember(m, 'EconomyClaimRequest'); return r && r.id === id; })) return json(200, { ok: true, duplicate: true, id, status: 'PENDING' });
  if (members.length >= Economy.MAX_REQUESTS_PER_ROOT) return publicError(409, 'full', 'This root already has the maximum number of pending requests.');
  const limited = await walletLimited(store, msg.claimant);
  if (limited) return limited;
  const all = await limit(store, { bucket: 'eco-claim-all', id: 'all', limit: 50, windowSeconds: 3600 });
  if (!all.allowed) return all.reason === 'store-unavailable' ? publicError(503, 'unavailable', UNAVAILABLE) : tooManyRequests(all.retryAfter);
  await store.sadd(K.requests(msg.root), Economy.member('EconomyClaimRequest', msg, b.signature));
  log(FN, 'claim-requested', { root: msg.root, claimant: hashId(msg.claimant) });
  return json(200, { ok: true, id, status: 'PENDING', note: 'A request grants nothing until SyncNet reviews it and a curator entry is committed.' });
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, loadGrants, resolveCurator, verifySig, connectedOnChain };
