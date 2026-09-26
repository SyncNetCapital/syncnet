'use strict';
/*
 * SyncNet Marketplace V1 — the persistent, signature-authenticated backend.
 *
 *   GET  /api/marketplace?view=config|listings|listing|passport|passports|deal|wallet
 *   POST /api/marketplace {action, ...fields, signature}
 *
 * Trust model (see MARKETPLACE_SECURITY.md):
 *  - every write is authorised by an EIP-712 signature (domain "SyncNet Marketplace" v1, chain 4663)
 *    verified SERVER-SIDE (ECDSA recovery; EIP-1271 for contract wallets via a live chain read);
 *  - claims about the project come from LIVE reads of the canonical factory of a SUPPORTED ORIGIN on Robinhood
 *    Chain (PAR, Pons V2 — lib/syncnet-origins.js): factory record, fee recipient, recipient code, pending
 *    overrides. Never from client-supplied fields; the origin itself is server-derived, never signed or supplied;
 *  - records are persisted in the durable store (Upstash). Without a durable store, or with
 *    SYNCNET_MARKETPLACE_DISABLED=true, every write fails CLOSED and reads answer with enabled:false;
 *  - per-wallet nonces (single use, 90 days), expiries and server-enforced status transitions give
 *    replay protection; record IDs are the EIP-712 digests themselves (deterministic, collision = duplicate);
 *  - NON-CUSTODIAL: this function never holds funds, never asks for approvals, never fakes settlement.
 *    ETH payments are verified from a submitted transaction hash against the chain (buyer -> seller,
 *    value >= agreed price); everything off-chain needs explicit both-party confirmation.
 * Passport operator history is APPEND-ONLY. Claims only establish the FIRST Passport or refresh the current operator;
 * the operator changes only through the two-signature Marketplace transfer. Historical 'operator-superseded' entries
 * (from the retired fee-recipient takeover rule) stay readable and are annotated as conferring no authority.
 */
const Core = require('../../lib/syncnet-core.js');
const Chain = require('../../lib/syncnet-chain.js');
const Market = require('../../lib/syncnet-market.js');
const Origins = require('../../lib/syncnet-origins.js');
const { json, publicError, tooManyRequests } = require('../lib/respond');
const { log, logError, hashId } = require('../lib/log');
const { getStore } = require('../lib/store');
const { clientIp, limit, limitAll } = require('../lib/ratelimit');
const { serverRpc } = require('../lib/chain-rpc');
const { readJsonBody, query, method: methodOf } = require('../lib/body');
const { verifyDigest } = require('../lib/sig-verify');
const { liveProject, feeRightOf } = require('../lib/live-project');

const FN = 'marketplace';
const K = {
  passport: (t) => `mp:passport:v1:${t}`,
  listing: (id) => `mp:listing:v1:${id}`,
  listingIndex: 'mp:listings:v1',
  offer: (id) => `mp:offer:v1:${id}`,
  offersOf: (l) => `mp:offers:v1:${l}`,
  deal: (id) => `mp:deal:v1:${id}`,
  nonce: (w, n) => `mp:nonce:v1:${w}:${n}`,
  wallet: (w) => `mp:wal:v1:${w}`,
  payTx: (h) => `mp:paytx:v1:${h}`,
};
const NONCE_TTL = 90 * 86400;
const MAX_LISTINGS = 400;
const MAX_OFFERS = 100;
const lc = Market.lc;
const now = () => Date.now();
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = () => new Date().toISOString();
const CLOSED = 'The Marketplace is not enabled on this deployment.';

function enabled(env) {
  const e = env || process.env;
  if (String(e.SYNCNET_MARKETPLACE_DISABLED || '').trim().toLowerCase() === 'true') return false;
  return true; // + durable store, checked against the live store below
}

// ---------------------------------------------------------------- storage helpers
async function getJson(store, key) {
  const raw = await store.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
const putJson = (store, key, value) => store.set(key, JSON.stringify(value));
async function consumeNonce(store, wallet, nonce) {
  const key = K.nonce(lc(wallet), lc(nonce));
  if (await store.get(key)) return false;
  await store.set(key, '1', { ttlSeconds: NONCE_TTL });
  return true;
}
async function indexWallet(store, wallet, ref) { await store.sadd(K.wallet(lc(wallet)), ref); }

// ---------------------------------------------------------------- signature verification (server-side, always)
// ECDSA recovery, then EIP-1271 for contract wallets via a live chain read (netlify/lib/sig-verify.js, shared).
async function verifySig(rpc, wallet, kind, message, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature) || signature.length > 8200) return false;
  let digest;
  try { digest = Market.digest(kind, message); } catch { return false; }
  return verifyDigest(rpc, wallet, digest, signature);
}

// ---------------------------------------------------------------- live origin reads: PAR, Pons V2 (never client-supplied)
// liveProject / feeRightOf live in netlify/lib/live-project.js (shared with Project Home); behaviour is unchanged.
const NOT_SUPPORTED = 'This address is not a PAR launch or a Pons V2 launch, so it cannot be claimed or listed.';
function unsupportedAnswer(live) {
  if (live.unsupported && live.unsupported.origin === 'PONS_V1') return publicError(422, 'unsupported_origin', 'PONS V1 DETECTED · This earlier Pons launch generation is not supported by the Marketplace.');
  return publicError(422, 'not_par', NOT_SUPPORTED);
}
/** Origin facts for records written before multi-origin support (always verified PAR launches). */
const originOf = (rec) => rec.origin || { launchpad: Origins.recordOrigin(rec), label: Origins.ORIGINS[Origins.recordOrigin(rec)].label, factory: rec.factory || null };

// ---------------------------------------------------------------- effective (computed) statuses
function listingStatus(l) {
  if (!l) return null;
  if (l.status === 'ACTIVE' && Number(l.expiry) <= nowSec()) return 'EXPIRED';
  return l.status;
}
function offerStatus(o, l) {
  if (!o) return null;
  if (o.status === 'PENDING') {
    if (Number(o.expiry) <= nowSec()) return 'EXPIRED';
    if (listingStatus(l) !== 'ACTIVE') return 'SUPERSEDED';
  }
  return o.status;
}
const publicListing = (l) => l && {
  id: l.id, token: l.token, seller: l.seller, price: l.price, currency: l.currency, terms: l.terms, termsHash: l.termsHash,
  status: listingStatus(l), expiry: l.expiry, createdAt: l.createdAt, cancelledAt: l.cancelledAt || null, dealId: l.dealId || null,
  snapshot: l.snapshot, feeRight: l.feeRight, operatorVerified: true, origin: originOf(l),
};
const publicOffer = (o, l) => o && { id: o.id, listingId: o.listingId, token: o.token, buyer: o.buyer, amount: o.amount, currency: o.currency, status: offerStatus(o, l), expiry: o.expiry, createdAt: o.createdAt, decidedAt: o.decidedAt || null };
// Historical 'operator-superseded' entries (retired fee-recipient takeover rule) are shown as history only. The
// annotation is added to the public VIEW; the stored record and its recordHash are computed from the untouched history.
const LEGACY_SUPERSESSION = 'Recorded under a retired rule that let the creator-fee recipient take over the Passport. Kept as history; it grants no authority today.';
const annotateHistory = (h) => (Array.isArray(h) ? h.map((e) => (e && e.type === 'operator-superseded' ? { ...e, legacy: true, note: LEGACY_SUPERSESSION } : e)) : h);
const publicPassport = (p) => p && { ...p, history: annotateHistory(p.history), launchpad: p.launchpad || Origins.recordOrigin(p), recordHash: Market.hashJson({ token: p.token, operator: p.operator, history: p.history }) };
function publicDeal(d) {
  if (!d) return null;
  return { ...d, completeHash: Market.completeHash(d), checklistState: Market.checklistState(d) };
}

async function loadListings(store) {
  const ids = (await store.smembers(K.listingIndex)).slice(0, MAX_LISTINGS);
  const rows = await Promise.all(ids.map((id) => getJson(store, K.listing(id))));
  return rows.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ---------------------------------------------------------------- field guards
function bad(message) { return publicError(400, 'invalid_request', message || 'Invalid request.'); }
function expiryOk(v, maxSeconds) { const n = Number(v); return Number.isInteger(n) && n > nowSec() && n <= nowSec() + maxSeconds ? n : null; }
function requireFields(b, spec) {
  for (const [name, check] of Object.entries(spec)) if (!check(b[name])) return name;
  return null;
}
const isAddr = Market.isAddr, isB32 = Market.isBytes32;

// =====================================================================================================================
async function handler(event = {}, deps = {}) {
  const method = methodOf(event);
  const store = deps.store || getStore();
  const ip = clientIp(event);
  const rpc = deps.rpc || serverRpc();
  const env = deps.env || process.env;
  const on = enabled(env) && Boolean(store.durable);

  // The limiter fails CLOSED when the store is down — answer honestly (outage, not "too many requests").
  const denied = (rl) => rl.reason === 'store-unavailable'
    ? publicError(503, 'unavailable', 'The Marketplace is temporarily unavailable.')
    : tooManyRequests(rl.retryAfter);

  if (method === 'GET') {
    const rl = await limit(store, { bucket: 'mp-read', id: ip, limit: 120, windowSeconds: 60 });
    if (!rl.allowed) return denied(rl);
    const view = query(event, 'view') || 'listings';
    try {
      if (view === 'config') return json(200, { enabled: on, durable: Boolean(store.durable) });
      if (!store.durable) return json(200, { enabled: false, durable: false, listings: [], note: CLOSED });
      if (view === 'listings') {
        const status = String(query(event, 'status') || '').toUpperCase();
        const rows = (await loadListings(store)).map(publicListing).filter((l) => !status || l.status === status);
        return json(200, { enabled: on, listings: rows });
      }
      if (view === 'listing') {
        const l = await getJson(store, K.listing(lc(query(event, 'id'))));
        if (!l) return publicError(404, 'not_found', 'Listing not found.');
        const offerIds = (await store.smembers(K.offersOf(l.id))).slice(0, MAX_OFFERS);
        const offers = (await Promise.all(offerIds.map((id) => getJson(store, K.offer(id))))).filter(Boolean)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((o) => publicOffer(o, l));
        const deal = l.dealId ? publicDeal(await getJson(store, K.deal(l.dealId))) : null;
        const passport = publicPassport(await getJson(store, K.passport(l.token)));
        return json(200, { enabled: on, listing: publicListing(l), offers, deal, passport });
      }
      if (view === 'passport') {
        const token = lc(query(event, 'token'));
        if (!isAddr(token)) return bad('Invalid token address.');
        const p = await getJson(store, K.passport(token));
        const listing = p && p.listing ? publicListing(await getJson(store, K.listing(p.listing))) : null;
        return json(200, { enabled: on, passport: publicPassport(p), listing: listing && listing.status === 'ACTIVE' ? listing : listing });
      }
      if (view === 'passports') {
        // Batch, read-only: the Passport (sync / control state) of up to 100 projects, for Explore and My Projects.
        const tokens = [...new Set(String(query(event, 'tokens') || '').toLowerCase().split(',').filter(isAddr))].slice(0, 100);
        const rows = await Promise.all(tokens.map((t) => getJson(store, K.passport(t))));
        const passports = {};
        tokens.forEach((t, i) => { const p = rows[i]; if (p && isAddr(p.operator)) passports[t] = { operator: lc(p.operator), operatorSince: p.operatorSince || null, launchpad: p.launchpad || Origins.recordOrigin(p), listing: p.listing || null }; });
        return json(200, { enabled: on, passports });
      }
      if (view === 'deal') {
        const d = await getJson(store, K.deal(lc(query(event, 'id'))));
        if (!d) return publicError(404, 'not_found', 'Deal not found.');
        const l = await getJson(store, K.listing(d.listingId));
        return json(200, { enabled: on, deal: publicDeal(d), listing: publicListing(l) });
      }
      if (view === 'wallet') {
        const w = lc(query(event, 'address'));
        if (!isAddr(w)) return bad('Invalid wallet address.');
        const refs = (await store.smembers(K.wallet(w))).slice(0, 300);
        const listings = [], offers = [], deals = [], passports = [];
        for (const ref of refs) {
          const [t, id] = ref.split(':');
          if (t === 'P') { const p = await getJson(store, K.passport(lc(id))); if (p && lc(p.operator) === w) passports.push({ token: lc(p.token || id), operator: lc(p.operator), operatorSince: p.operatorSince || null, launchpad: p.launchpad || Origins.recordOrigin(p), listing: p.listing || null }); }
          if (t === 'L') { const l = await getJson(store, K.listing(id)); if (l) listings.push(publicListing(l)); }
          if (t === 'O') { const o = await getJson(store, K.offer(id)); if (o) { const l = await getJson(store, K.listing(o.listingId)); offers.push(publicOffer(o, l)); } }
          if (t === 'D') { const d = await getJson(store, K.deal(id)); if (d) deals.push(publicDeal(d)); }
        }
        return json(200, { enabled: on, listings, offers, deals, passports }); // passports: only those this wallet CURRENTLY operates
      }
      return bad('Unknown view.');
    } catch (err) {
      logError(FN, 'read-failed', err, { view });
      return publicError(503, 'unavailable', 'The Marketplace is temporarily unavailable.');
    }
  }

  if (method !== 'POST') return publicError(405, 'method_not_allowed', 'GET or POST only.', { allow: 'GET, POST' });
  if (!on) return publicError(503, 'closed', CLOSED);
  const rl = await limitAll(store, [
    { bucket: 'mp-write', id: ip, limit: 20, windowSeconds: 60 },
    { bucket: 'mp-write-h', id: ip, limit: 200, windowSeconds: 3600 },
  ]);
  if (!rl.allowed) return denied(rl);
  const b = readJsonBody(event, 32768);
  if (!b || typeof b.action !== 'string') return bad('A JSON body with an action is required.');

  try {
    const wallet = lc(b.operator || b.seller || b.buyer || b.from || b.wallet || (b.action === 'transfer-accept' ? b.to : ''));
    if (isAddr(wallet)) {
      const wl = await limit(store, { bucket: 'mp-wallet', id: wallet, limit: 120, windowSeconds: 3600 });
      if (!wl.allowed) return denied(wl);
    }
    const out = await write(b, { store, rpc, ip });
    return out;
  } catch (err) {
    logError(FN, 'write-crashed', err, { action: b.action });
    return publicError(503, 'unavailable', 'The Marketplace is temporarily unavailable.');
  }
}

// =====================================================================================================================
async function write(b, ctx) {
  const { store, rpc, ip } = ctx;
  const action = b.action;

  // ---------------------------------------------------------------- operator claim (F)
  if (action === 'claim') {
    const missing = requireFields(b, { token: isAddr, operator: isAddr, basis: (v) => Market.CLAIM_BASES.includes(v), nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const expiry = expiryOk(b.expiry, Market.MAX_EXPIRY.claim);
    if (!expiry) return bad('The claim expiry must be in the future (at most 1 hour ahead).');
    const token = lc(b.token), operator = lc(b.operator);
    const message = { token, operator, basis: b.basis, nonce: lc(b.nonce), expiry };
    if (!(await verifySig(rpc, operator, 'OperatorClaim', message, b.signature))) { log(FN, 'claim-bad-sig', { ip: hashId(ip), token }); return publicError(401, 'bad_signature', 'The signature does not verify for this claim.'); }
    let live;
    try { live = await liveProject(rpc, token); } catch (err) { logError(FN, 'chain-unavailable', err, { token }); return publicError(503, 'unavailable', 'Robinhood Chain could not be read right now. Try again.'); }
    if (!live.launch) return unsupportedAnswer(live);
    const passport = await getJson(store, K.passport(token));
    // conservative evidence rules — the wallet must PROVE an on-chain / recognised relationship, read from the
    // canonical factory of the token's verified origin (PAR texts are unchanged; other origins name their venue)
    const isPar = live.launch.origin === 'PAR';
    const venue = Origins.ORIGINS[live.launch.origin].venue;
    const feeRecipientWallet = live.feeRight.kind === 'wallet' || live.feeRight.kind === 'encumbered'; // a directly controlled wallet either way
    let evidence = '';
    if (b.basis === 'deployer' && operator === lc(live.launch.deployer)) evidence = 'wallet is the on-chain deployer (' + venue + ')';
    else if (b.basis === 'fee-recipient' && operator === lc(live.launch.creatorFeeRecipient) && feeRecipientWallet) evidence = 'wallet is the current on-chain creator-fee recipient' + (isPar ? '' : ' (' + venue + ')');
    else if (b.basis === 'operator' && passport && lc(passport.operator) === operator) evidence = 'wallet is the already-recognised SyncNet operator';
    if (!evidence) return publicError(422, 'no_evidence', 'This wallet could not prove a claimable relationship (deployer, current fee-recipient wallet, or recognised operator).');
    // PASSPORT AUTHORITY (same rule for every origin): deployer / fee-recipient evidence can only ESTABLISH the first
    // Passport. Once a Passport exists, only its recognised operator may claim again (refresh). Operational control
    // then changes ONLY through the signed Marketplace transfer (seller TransferIntent + buyer TransferAccept);
    // holding or receiving the creator-fee right on-chain never moves it. Refused before the nonce is consumed.
    if (passport && lc(passport.operator) !== operator) {
      log(FN, 'claim-refused-operator-exists', { token, basis: b.basis });
      return publicError(409, 'operator_exists', 'An operator is already recognised for this project. Operational control changes only through a Marketplace Passport transfer signed by the current operator and the new one; creator-fee rights do not transfer it.');
    }
    if (!(await consumeNonce(store, operator, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    const claim = { id: Market.digest('OperatorClaim', message), operator, basis: b.basis, evidence, signature: b.signature, nonce: lc(b.nonce), expiry, at: iso() };
    let p = passport;
    if (!p) {
      p = { schema: 'syncnet.passport.v1', token, chainId: Market.CHAIN_ID, launchpad: live.launch.origin, factory: lc(live.launch.factory), deployer: lc(live.launch.deployer), operator, operatorSince: iso(), claims: [claim], listing: null, history: [{ type: 'operator-claim', operator, basis: b.basis, evidence, claimId: claim.id, at: claim.at }], createdAt: iso(), updatedAt: iso() };
    } else if (lc(p.operator) === operator) {
      p.claims = [...(p.claims || []), claim].slice(-20);
      p.history = [...p.history, { type: 'operator-claim-refresh', operator, basis: b.basis, claimId: claim.id, at: claim.at }];
      p.updatedAt = iso();
    } else {
      return publicError(409, 'operator_exists', 'An operator is already recognised for this project.'); // unreachable: refused above
    }
    await putJson(store, K.passport(token), p);
    await indexWallet(store, operator, 'P:' + token);
    log(FN, 'claimed', { token, operator: hashId(operator), basis: b.basis });
    return json(200, { ok: true, passport: publicPassport(p) });
  }

  // ---------------------------------------------------------------- create listing (I)
  if (action === 'list') {
    const missing = requireFields(b, { token: isAddr, seller: isAddr, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const price = Market.checkAmount(b.price);
    if (!price) return bad('The asking price must be a positive number (at most 1,000,000,000, 18 decimals).');
    if (!Market.CURRENCIES.includes(b.currency)) return bad('Currency must be one of ' + Market.CURRENCIES.join(', ') + '.');
    const expiry = expiryOk(b.expiry, Market.MAX_EXPIRY.listing);
    if (!expiry) return bad('The listing expiry must be in the future (at most 90 days ahead).');
    const t = Market.normalizeTerms(b.terms);
    if (!t.ok) return bad('Listing terms: ' + t.error + '.');
    const token = lc(b.token), seller = lc(b.seller);
    const passport = await getJson(store, K.passport(token));
    if (!passport || lc(passport.operator) !== seller) return publicError(403, 'not_operator', 'Only the recognised operator can list this project. Claim it first.');
    let live;
    try { live = await liveProject(rpc, token); } catch (err) { logError(FN, 'chain-unavailable', err, { token }); return publicError(503, 'unavailable', 'Robinhood Chain could not be read right now. Try again.'); }
    if (!live.launch) return unsupportedAnswer(live);
    if (t.terms.includeFeeRight && !(live.feeRight.transferable && live.feeRight.recipient === seller)) {
      return publicError(422, 'fee_right', 'The creator-fee right cannot be included: ' + (live.feeRight.kind === 'vault' ? 'it is fixed to a PAR vault.' : live.feeRight.kind === 'contract' ? 'the current recipient is a contract.' : live.feeRight.kind === 'encumbered' ? 'a Pons protocol override of the creator-fee recipient is pending, so the right cannot be handed over cleanly.' : 'the seller wallet is not the current on-chain recipient.'));
    }
    const termsHash = Market.hashJson(t.terms);
    const message = { token, seller, price, currency: b.currency, termsHash, nonce: lc(b.nonce), expiry };
    if (!(await verifySig(rpc, seller, 'Listing', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this listing.');
    const id = Market.digest('Listing', message);
    if (await getJson(store, K.listing(id))) return publicError(409, 'duplicate', 'This exact listing already exists.');
    const rows = await loadListings(store);
    if (rows.some((l) => l.token === token && listingStatus(l) === 'ACTIVE')) return publicError(409, 'already_listed', 'This project already has an active listing. Cancel it first.');
    if (rows.length >= MAX_LISTINGS) return publicError(503, 'full', 'The Marketplace is at capacity right now.');
    if (!(await consumeNonce(store, seller, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    const listing = {
      schema: 'syncnet.listing.v1', id, token, seller, price, currency: b.currency, terms: t.terms, termsHash,
      nonce: lc(b.nonce), expiry, signature: b.signature, status: 'ACTIVE', createdAt: iso(),
      snapshot: live.snapshot, feeRight: live.feeRight, deployer: lc(live.launch.deployer), factory: lc(live.launch.factory),
      origin: live.origin, // server-derived from the live factory read; never part of any signature
    };
    await putJson(store, K.listing(id), listing);
    await store.sadd(K.listingIndex, id);
    await indexWallet(store, seller, 'L:' + id);
    passport.listing = id; passport.history = [...passport.history, { type: 'listed', listingId: id, at: listing.createdAt }]; passport.updatedAt = iso();
    await putJson(store, K.passport(token), passport);
    log(FN, 'listed', { token, seller: hashId(seller), id: id.slice(0, 18) });
    return json(200, { ok: true, listing: publicListing(listing) });
  }

  // ---------------------------------------------------------------- cancel listing (I)
  if (action === 'cancel-listing') {
    const missing = requireFields(b, { listingId: isB32, seller: isAddr, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const l = await getJson(store, K.listing(lc(b.listingId)));
    if (!l) return publicError(404, 'not_found', 'Listing not found.');
    if (lc(b.seller) !== l.seller) return publicError(403, 'not_seller', 'Only the seller can cancel this listing.');
    if (listingStatus(l) !== 'ACTIVE' && listingStatus(l) !== 'EXPIRED') return publicError(409, 'not_active', 'Only an active listing can be cancelled (this one is ' + listingStatus(l) + ').');
    const message = { listingId: l.id, seller: l.seller, nonce: lc(b.nonce) };
    if (!(await verifySig(rpc, l.seller, 'ListingCancel', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this cancellation.');
    if (!(await consumeNonce(store, l.seller, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    l.status = 'CANCELLED'; l.cancelledAt = iso(); l.cancelSignature = b.signature;
    await putJson(store, K.listing(l.id), l);
    const p = await getJson(store, K.passport(l.token));
    if (p) { if (p.listing === l.id) p.listing = null; p.history = [...p.history, { type: 'listing-cancelled', listingId: l.id, at: l.cancelledAt }]; p.updatedAt = iso(); await putJson(store, K.passport(l.token), p); }
    log(FN, 'listing-cancelled', { id: l.id.slice(0, 18) });
    return json(200, { ok: true, listing: publicListing(l) });
  }

  // ---------------------------------------------------------------- make an offer (J)
  if (action === 'offer') {
    const missing = requireFields(b, { listingId: isB32, termsHash: isB32, token: isAddr, buyer: isAddr, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const amount = Market.checkAmount(b.amount);
    if (!amount) return bad('The offer amount must be a positive number.');
    const l = await getJson(store, K.listing(lc(b.listingId)));
    if (!l) return publicError(404, 'not_found', 'Listing not found.');
    if (listingStatus(l) !== 'ACTIVE') return publicError(409, 'not_active', 'This listing is ' + listingStatus(l) + ' — offers are closed.');
    if (lc(b.termsHash) !== l.termsHash) return publicError(409, 'terms_changed', 'The offer was made against different terms than this listing.');
    if (lc(b.token) !== l.token) return bad('The offer names a different project than the listing.');
    if (b.currency !== l.currency) return bad('Offers must use the listing currency (' + l.currency + ').');
    const buyer = lc(b.buyer);
    if (buyer === l.seller) return publicError(409, 'self_offer', 'The seller cannot make an offer on their own listing.');
    const expiry = expiryOk(b.expiry, Market.MAX_EXPIRY.offer);
    if (!expiry) return bad('The offer expiry must be in the future (at most 30 days ahead).');
    const message = { listingId: l.id, termsHash: l.termsHash, token: l.token, buyer, amount, currency: l.currency, nonce: lc(b.nonce), expiry };
    if (!(await verifySig(rpc, buyer, 'Offer', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this offer.');
    const id = Market.digest('Offer', message);
    if (await getJson(store, K.offer(id))) return publicError(409, 'duplicate', 'This exact offer already exists.');
    if (!(await consumeNonce(store, buyer, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    const offer = { schema: 'syncnet.offer.v1', id, listingId: l.id, token: l.token, buyer, amount, currency: l.currency, termsHash: l.termsHash, nonce: lc(b.nonce), expiry, signature: b.signature, status: 'PENDING', createdAt: iso() };
    await putJson(store, K.offer(id), offer);
    await store.sadd(K.offersOf(l.id), id);
    await indexWallet(store, buyer, 'O:' + id);
    log(FN, 'offer', { listing: l.id.slice(0, 18), buyer: hashId(buyer) });
    return json(200, { ok: true, offer: publicOffer(offer, l) });
  }

  // ---------------------------------------------------------------- accept / reject an offer (J)
  if (action === 'offer-decision') {
    const missing = requireFields(b, { offerId: isB32, listingId: isB32, seller: isAddr, decision: (v) => v === 'accept' || v === 'reject', nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const l = await getJson(store, K.listing(lc(b.listingId)));
    const o = await getJson(store, K.offer(lc(b.offerId)));
    if (!l || !o || o.listingId !== l.id) return publicError(404, 'not_found', 'Offer not found for this listing.');
    if (lc(b.seller) !== l.seller) return publicError(403, 'not_seller', 'Only the seller can decide on offers.');
    if (o.status !== 'PENDING') return publicError(409, 'decided', 'This offer is already ' + o.status + '.');
    const message = { offerId: o.id, listingId: l.id, seller: l.seller, decision: b.decision, nonce: lc(b.nonce) };
    if (!(await verifySig(rpc, l.seller, 'OfferDecision', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this decision.');
    if (b.decision === 'accept') {
      if (listingStatus(l) !== 'ACTIVE') return publicError(409, 'not_active', 'This listing is ' + listingStatus(l) + '.');
      if (Number(o.expiry) <= nowSec()) return publicError(409, 'expired', 'This offer has expired and cannot be accepted.');
    }
    if (!(await consumeNonce(store, l.seller, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    o.decidedAt = iso(); o.decisionSignature = b.signature;
    if (b.decision === 'reject') {
      o.status = 'REJECTED';
      await putJson(store, K.offer(o.id), o);
      return json(200, { ok: true, offer: publicOffer(o, l) });
    }
    o.status = 'ACCEPTED';
    const dealId = Core.keccak256Utf8('syncnet-deal|' + l.id + '|' + o.id);
    const manualAssets = (l.terms.included || []).filter((a) => a.kind === 'manual').map((a) => ({ id: a.id, label: a.label, confirmations: {}, done: false }));
    const deal = {
      schema: 'syncnet.deal.v1', id: dealId, listingId: l.id, offerId: o.id, token: l.token, seller: l.seller, buyer: o.buyer,
      price: o.amount, currency: o.currency, termsHash: l.termsHash, status: 'OPEN', createdAt: iso(),
      checklist: {
        operatorTransfer: { required: true, done: false },
        feeRight: { required: l.terms.includeFeeRight === true, recipient: l.feeRight ? l.feeRight.recipient : null, done: false, txHash: null },
        payment: { required: Market.toWei(o.amount) > 0n || Number(o.amount) > 0, kind: o.currency === 'ETH' ? 'onchain' : 'manual', done: false, evidence: null, confirmations: {} },
        assets: manualAssets,
      },
      transfer: { intent: null, accept: null },
      confirmations: { complete: {} },
    };
    l.status = 'OFFER_ACCEPTED'; l.dealId = dealId;
    // every other pending offer on this listing is superseded (stale acceptances are impossible from here on)
    const otherIds = await store.smembers(K.offersOf(l.id));
    for (const oid of otherIds) {
      if (lc(oid) === o.id) continue;
      const other = await getJson(store, K.offer(oid));
      if (other && other.status === 'PENDING') { other.status = 'SUPERSEDED'; await putJson(store, K.offer(oid), other); }
    }
    await putJson(store, K.offer(o.id), o);
    await putJson(store, K.listing(l.id), l);
    await putJson(store, K.deal(dealId), deal);
    await indexWallet(store, l.seller, 'D:' + dealId);
    await indexWallet(store, o.buyer, 'D:' + dealId);
    log(FN, 'offer-accepted', { listing: l.id.slice(0, 18), deal: dealId.slice(0, 18) });
    return json(200, { ok: true, offer: publicOffer(o, l), deal: publicDeal(deal) });
  }

  // ---------------------------------------------------------------- operator transfer (G): intent by A…
  if (action === 'transfer-intent') {
    const missing = requireFields(b, { dealId: isB32, token: isAddr, from: isAddr, to: isAddr, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const d = await getJson(store, K.deal(lc(b.dealId)));
    if (!d) return publicError(404, 'not_found', 'Deal not found.');
    if (d.status !== 'OPEN') return publicError(409, 'closed', 'This deal is ' + d.status + '.');
    const from = lc(b.from), to = lc(b.to);
    if (from !== d.seller || to !== d.buyer || lc(b.token) !== d.token) return publicError(409, 'mismatch', 'The transfer must go from the deal seller to the deal buyer for this project.');
    const p = await getJson(store, K.passport(d.token));
    if (!p || lc(p.operator) !== from) return publicError(409, 'not_operator', 'The seller is no longer the recognised operator of this project.');
    const expiry = expiryOk(b.expiry, Market.MAX_EXPIRY.transfer);
    if (!expiry) return bad('The transfer intent expiry must be in the future (at most 7 days ahead).');
    const message = { dealId: d.id, token: d.token, from, to, nonce: lc(b.nonce), expiry };
    if (!(await verifySig(rpc, from, 'TransferIntent', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this transfer intent.');
    if (!(await consumeNonce(store, from, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    d.transfer.intent = { hash: Market.digest('TransferIntent', message), from, to, nonce: lc(b.nonce), expiry, signature: b.signature, at: iso() };
    await putJson(store, K.deal(d.id), d);
    const l = await getJson(store, K.listing(d.listingId));
    if (l && l.status === 'OFFER_ACCEPTED') { l.status = 'IN_TRANSFER'; await putJson(store, K.listing(l.id), l); }
    return json(200, { ok: true, deal: publicDeal(d) });
  }

  // ---------------------------------------------------------------- …accepted by B: the canonical operator changes
  if (action === 'transfer-accept') {
    const missing = requireFields(b, { dealId: isB32, token: isAddr, from: isAddr, to: isAddr, intentHash: isB32, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const d = await getJson(store, K.deal(lc(b.dealId)));
    if (!d) return publicError(404, 'not_found', 'Deal not found.');
    if (d.status !== 'OPEN') return publicError(409, 'closed', 'This deal is ' + d.status + '.');
    const intent = d.transfer && d.transfer.intent;
    if (!intent) return publicError(409, 'no_intent', 'The seller has not signed a transfer intent yet.');
    if (Number(intent.expiry) <= nowSec()) return publicError(409, 'expired', 'The transfer intent has expired. Ask the seller to sign a new one.');
    const from = lc(b.from), to = lc(b.to);
    if (from !== intent.from || to !== intent.to || lc(b.token) !== d.token || lc(b.intentHash) !== lc(intent.hash)) return publicError(409, 'mismatch', 'The acceptance does not match the signed transfer intent.');
    const expiry = expiryOk(b.expiry, Market.MAX_EXPIRY.transfer);
    if (!expiry) return bad('The acceptance expiry must be in the future (at most 7 days ahead).');
    const message = { dealId: d.id, token: d.token, from, to, intentHash: lc(intent.hash), nonce: lc(b.nonce), expiry };
    if (!(await verifySig(rpc, to, 'TransferAccept', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for the buyer.');
    const p = await getJson(store, K.passport(d.token));
    if (!p || lc(p.operator) !== from) return publicError(409, 'not_operator', 'The seller is no longer the recognised operator of this project.');
    if (!(await consumeNonce(store, to, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    const at = iso();
    const acceptHash = Market.digest('TransferAccept', message);
    d.transfer.accept = { hash: acceptHash, from, to, nonce: lc(b.nonce), expiry, signature: b.signature, at };
    d.checklist.operatorTransfer.done = true; d.checklist.operatorTransfer.at = at;
    p.operator = to; p.operatorSince = at;
    p.history = [...p.history, { type: 'operator-transfer', from, to, at, dealId: d.id, listingId: d.listingId, intentHash: lc(intent.hash), acceptHash }];
    p.updatedAt = at;
    await putJson(store, K.deal(d.id), d);
    await putJson(store, K.passport(d.token), p);
    await indexWallet(store, to, 'P:' + d.token);
    log(FN, 'operator-transferred', { token: d.token, from: hashId(from), to: hashId(to), deal: d.id.slice(0, 18) });
    return json(200, { ok: true, deal: publicDeal(d), passport: publicPassport(p) });
  }

  // ---------------------------------------------------------------- fee-right transfer evidence (L): on-chain, verified
  if (action === 'fee-right-evidence') {
    const missing = requireFields(b, { dealId: isB32, txHash: (v) => /^0x[0-9a-fA-F]{64}$/.test(String(v || '')) });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const d = await getJson(store, K.deal(lc(b.dealId)));
    if (!d) return publicError(404, 'not_found', 'Deal not found.');
    if (!d.checklist.feeRight.required) return publicError(409, 'not_required', 'This deal does not include the creator-fee right.');
    let launch, tx;
    try { launch = await Origins.resolveProject(rpc, d.token); tx = await Chain.readTx(rpc, lc(b.txHash)); } catch (err) { logError(FN, 'chain-unavailable', err, {}); return publicError(503, 'unavailable', 'Robinhood Chain could not be read right now.'); }
    if (!tx.receipt || tx.receipt.status !== '0x1') return publicError(409, 'tx_failed', 'That transaction has not succeeded on-chain.');
    // Authoritative condition: a FRESH read of the token's canonical factory names the buyer. The hash is only a pointer.
    if (!launch || !launch.supported || lc(launch.creatorFeeRecipient) !== d.buyer) return publicError(409, 'not_transferred', 'The on-chain creator-fee recipient is not the buyer yet. The transfer is verified from the chain, not from the transaction hash alone.');
    if (launch.origin === 'PONS_V2' && launch.pendingOverride && launch.pendingOverride.active) {
      return publicError(409, 'encumbered', 'The buyer is the recipient now, but a Pons protocol override of the creator-fee recipient is pending and would supersede it. This step cannot be verified as final until the override is cancelled or expires.');
    }
    d.checklist.feeRight.done = true; d.checklist.feeRight.txHash = lc(b.txHash); d.checklist.feeRight.verifiedAt = iso(); d.checklist.feeRight.recipientNow = lc(launch.creatorFeeRecipient);
    d.checklist.feeRight.factory = lc(launch.factory);
    await putJson(store, K.deal(d.id), d);
    log(FN, 'fee-right-verified', { deal: d.id.slice(0, 18) });
    return json(200, { ok: true, deal: publicDeal(d) });
  }

  // ---------------------------------------------------------------- payment evidence (K): ETH, verified on-chain
  if (action === 'payment-evidence') {
    const missing = requireFields(b, { dealId: isB32, txHash: (v) => /^0x[0-9a-fA-F]{64}$/.test(String(v || '')) });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const d = await getJson(store, K.deal(lc(b.dealId)));
    if (!d) return publicError(404, 'not_found', 'Deal not found.');
    const pay = d.checklist.payment;
    if (!pay.required) return publicError(409, 'not_required', 'This deal has no payment step.');
    if (pay.kind !== 'onchain') return publicError(409, 'manual_payment', 'This deal is priced in ' + d.currency + ': payment is confirmed manually by both parties, not by transaction hash.');
    const txHash = lc(b.txHash);
    if (await store.get(K.payTx(txHash))) return publicError(409, 'tx_used', 'That transaction is already attached to another deal.');
    let tx;
    try { tx = await Chain.readTx(rpc, txHash); } catch (err) { logError(FN, 'chain-unavailable', err, {}); return publicError(503, 'unavailable', 'Robinhood Chain could not be read right now.'); }
    if (!tx.tx || !tx.receipt) return publicError(409, 'tx_unknown', 'That transaction is not mined yet.');
    if (tx.receipt.status !== '0x1') return publicError(409, 'tx_failed', 'That transaction reverted.');
    const need = Market.toWei(d.price);
    const paid = BigInt(tx.tx.value || 0);
    if (lc(tx.tx.from) !== d.buyer || lc(tx.tx.to) !== d.seller || paid < need) {
      return publicError(409, 'tx_mismatch', 'The payment must be a plain transfer from the buyer wallet to the seller wallet for at least the agreed price.');
    }
    pay.done = true; pay.evidence = { txHash, valueWei: paid.toString(), block: tx.receipt.blockNumber, verifiedAt: iso() };
    await store.set(K.payTx(txHash), d.id);
    await putJson(store, K.deal(d.id), d);
    log(FN, 'payment-verified', { deal: d.id.slice(0, 18) });
    return json(200, { ok: true, deal: publicDeal(d) });
  }

  // ---------------------------------------------------------------- deal confirmations (M/N)
  if (action === 'deal-confirm') {
    const missing = requireFields(b, { dealId: isB32, wallet: isAddr, role: (v) => v === 'buyer' || v === 'seller', item: (v) => typeof v === 'string' && v.length <= 24, stateHash: isB32, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const d = await getJson(store, K.deal(lc(b.dealId)));
    if (!d) return publicError(404, 'not_found', 'Deal not found.');
    if (d.status !== 'OPEN') return publicError(409, 'closed', 'This deal is ' + d.status + '.');
    const wallet = lc(b.wallet);
    if ((b.role === 'buyer' && wallet !== d.buyer) || (b.role === 'seller' && wallet !== d.seller)) return publicError(403, 'not_party', 'Only the deal buyer or seller can confirm.');
    const message = { dealId: d.id, wallet, role: b.role, item: b.item, stateHash: lc(b.stateHash), nonce: lc(b.nonce) };
    if (!(await verifySig(rpc, wallet, 'DealConfirm', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this confirmation.');
    if (!(await consumeNonce(store, wallet, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    const at = iso();
    if (b.item === 'complete') {
      const pending = [];
      if (!d.checklist.operatorTransfer.done) pending.push('operator transfer');
      if (d.checklist.feeRight.required && !d.checklist.feeRight.done) pending.push('creator-fee right');
      if (d.checklist.payment.required && !d.checklist.payment.done) pending.push('payment');
      for (const a of d.checklist.assets) if (!a.done) pending.push(a.label);
      if (pending.length) return publicError(409, 'incomplete', 'Not everything in this deal is done yet: ' + pending.slice(0, 4).join('; ') + '.');
      if (lc(b.stateHash) !== Market.completeHash(d)) return publicError(409, 'stale_state', 'The deal state changed since you reviewed it. Reload and confirm again.');
      d.confirmations.complete[b.role] = { wallet, at, signature: b.signature };
      if (d.confirmations.complete.buyer && d.confirmations.complete.seller) {
        d.status = 'COMPLETED'; d.completedAt = at;
        const l = await getJson(store, K.listing(d.listingId));
        if (l) { l.status = 'COMPLETED'; await putJson(store, K.listing(l.id), l); }
        const p = await getJson(store, K.passport(d.token));
        if (p) { if (p.listing === d.listingId) p.listing = null; p.history = [...p.history, { type: 'deal-completed', dealId: d.id, listingId: d.listingId, buyer: d.buyer, seller: d.seller, price: d.price, currency: d.currency, at }]; p.updatedAt = at; await putJson(store, K.passport(d.token), p); }
        log(FN, 'deal-completed', { deal: d.id.slice(0, 18) });
      }
      await putJson(store, K.deal(d.id), d);
      return json(200, { ok: true, deal: publicDeal(d) });
    }
    if (b.item === 'payment') {
      if (!d.checklist.payment.required || d.checklist.payment.kind !== 'manual') return publicError(409, 'not_manual', 'Payment for this deal is verified on-chain, not by manual confirmation.');
      d.checklist.payment.confirmations[b.role] = { wallet, at, signature: b.signature };
      if (d.checklist.payment.confirmations.buyer && d.checklist.payment.confirmations.seller) d.checklist.payment.done = true;
      await putJson(store, K.deal(d.id), d);
      return json(200, { ok: true, deal: publicDeal(d) });
    }
    const asset = d.checklist.assets.find((a) => a.id === b.item);
    if (!asset) return publicError(404, 'no_item', 'That checklist item does not exist on this deal.');
    asset.confirmations[b.role] = { wallet, at, signature: b.signature };
    if (asset.confirmations.buyer && asset.confirmations.seller) asset.done = true;
    await putJson(store, K.deal(d.id), d);
    return json(200, { ok: true, deal: publicDeal(d) });
  }

  // ---------------------------------------------------------------- cancel a deal
  if (action === 'deal-cancel') {
    const missing = requireFields(b, { dealId: isB32, wallet: isAddr, reason: (v) => typeof v === 'string' && v.length <= 300, nonce: isB32, signature: (v) => typeof v === 'string' });
    if (missing) return bad('Invalid or missing field: ' + missing + '.');
    const d = await getJson(store, K.deal(lc(b.dealId)));
    if (!d) return publicError(404, 'not_found', 'Deal not found.');
    if (d.status !== 'OPEN') return publicError(409, 'closed', 'This deal is ' + d.status + '.');
    const wallet = lc(b.wallet);
    if (wallet !== d.buyer && wallet !== d.seller) return publicError(403, 'not_party', 'Only the deal buyer or seller can cancel.');
    const message = { dealId: d.id, wallet, reason: Market.clean(b.reason, 300), nonce: lc(b.nonce) };
    if (!(await verifySig(rpc, wallet, 'DealCancel', message, b.signature))) return publicError(401, 'bad_signature', 'The signature does not verify for this cancellation.');
    if (!(await consumeNonce(store, wallet, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');
    const at = iso();
    d.status = 'CANCELLED'; d.cancelledAt = at; d.cancelledBy = wallet === d.buyer ? 'buyer' : 'seller'; d.cancelReason = message.reason;
    const l = await getJson(store, K.listing(d.listingId));
    if (l) {
      // an operator transfer is never unwound; without one, the listing simply reopens
      l.status = d.checklist.operatorTransfer.done ? 'CANCELLED' : 'ACTIVE';
      if (!d.checklist.operatorTransfer.done) delete l.dealId;
      await putJson(store, K.listing(l.id), l);
    }
    const o = await getJson(store, K.offer(d.offerId));
    if (o) { o.status = 'DEAL_CANCELLED'; await putJson(store, K.offer(o.id), o); }
    const p = await getJson(store, K.passport(d.token));
    if (p) { p.history = [...p.history, { type: 'deal-cancelled', dealId: d.id, by: d.cancelledBy, at }]; p.updatedAt = at; await putJson(store, K.passport(d.token), p); }
    log(FN, 'deal-cancelled', { deal: d.id.slice(0, 18), by: d.cancelledBy });
    return json(200, { ok: true, deal: publicDeal(d) });
  }

  return bad('Unknown action.');
}

exports.handler = (event) => handler(event);
exports._handler = handler;
exports._internals = { K, listingStatus, offerStatus, feeRightOf, verifySig, liveProject };
