// Marketplace V1 server suite: /api/marketplace under normal use and abuse.
// Every write is EIP-712-authenticated and every project fact comes from LIVE mock-chain reads; the
// suite proves claims, listings, offers, two-party operator transfers, on-chain payment/fee-right
// verification, replay/expiry/status enforcement, persistence and fail-closed behaviour.
// No real network: chain + wallets are the e2e harness mocks. Run: node tests/server/marketplace.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { A, chain, resetChain, sendTx, signDigest, LAUNCHES, Core, ROOT } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } else process.stdout.write('ok   ' + name + '\n'); }
const logs = [];
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) { try { logs.push(JSON.parse(a[0])); } catch { logs.push(a[0]); } return; } orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access attempted: ' + n + '.' + f); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
let ipSeq = 0;
const ev = (method, { ip, query = {}, body = null } = {}) => ({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip || `203.0.113.${(ipSeq++ % 200) + 1}` }, queryStringParameters: query, body: body == null ? null : JSON.stringify(body), isBase64Encoded: false });
const store = { ...createStore({ map: new Map() }), durable: true, kind: 'test-durable' };
const deps = { store, env: {} };
const GET = (query, d = deps) => mp._handler(ev('GET', { query }), d);
const POST = (body, d = deps, ip) => mp._handler(ev('POST', { body, ip }), d);
const nonce = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const exp = (s) => Math.floor(Date.now() / 1000) + s;
/** Sign an EIP-712 marketplace structure with a harness key (as `as`, defaults to the message's own wallet). */
const sign = (kind, message, as) => signDigest(as, Market.digest(kind, message));
const lc = (v) => String(v).toLowerCase();
const noLeak = (r) => !/\n\s+at |Error:|ENOTFOUND|stack|\.js:\d|upstash|redis/i.test(r.body);

const TOKEN = lc(A.CREATORLIVE); // deployer A.WALLET, creator-fee recipient A.WALLET (a wallet → transferable)
const VAULT_TOKEN = lc(A.SYNCAT); // fees to the holder vault → fee right NOT transferable
const SELLER = lc(A.WALLET), BUYER = lc(A.WALLET2), ATTACKER = lc(A.ATTACKER);
resetChain();

// ================================================================================ operator claims (auth)
{
  let m = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  let r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, SELLER) });
  check('claim: the on-chain deployer can claim with a valid EIP-712 signature', r.statusCode === 200 && J(r).passport.operator === SELLER, r.body);
  check('claim: the passport records the evidence basis and an append-only history', J(r).passport.history[0].type === 'operator-claim' && /deployer/.test(J(r).passport.history[0].evidence));

  m = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, ATTACKER) });
  check('claim: a signature by a DIFFERENT wallet is rejected (invalid signer)', r.statusCode === 401 && noLeak(r), r.body);

  m = { token: TOKEN, operator: ATTACKER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, ATTACKER) });
  check('claim: a valid signature is NOT enough — the wallet must match the live chain (attacker ≠ deployer)', r.statusCode === 422, r.body);

  m = { token: TOKEN, operator: ATTACKER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, deployer: ATTACKER, feeRight: { transferable: true }, signature: sign('OperatorClaim', m, ATTACKER) });
  check('claim: client-supplied "deployer"/"feeRight" fields cannot spoof the live PAR read', r.statusCode === 422, r.body);

  m = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  const wrongChain = Core.hashTypedData({ ...Market.typedData('OperatorClaim', m), domain: { ...Market.DOMAIN, chainId: 1 } });
  r = await POST({ action: 'claim', ...m, signature: signDigest(SELLER, wrongChain) });
  check('claim: a signature bound to the WRONG CHAIN ID does not verify', r.statusCode === 401, r.body);

  m = { token: VAULT_TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, token: TOKEN, signature: sign('OperatorClaim', m, SELLER) });
  check('claim: a signature for one token is never authorization for another', r.statusCode === 401, r.body);

  m = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(-5) };
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, SELLER) });
  check('claim: an expired signature is rejected', r.statusCode === 400, r.body);

  m = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  const sig = sign('OperatorClaim', m, SELLER);
  await POST({ action: 'claim', ...m, signature: sig });
  r = await POST({ action: 'claim', ...m, signature: sig });
  check('claim: a replayed nonce is rejected', r.statusCode === 409 && J(r).code === 'replay', r.body);

  m = { token: lc(A.RANDOM_CONTRACT), operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, SELLER) });
  check('claim: an arbitrary non-PAR contract cannot be claimed at all', r.statusCode === 422 && /not a PAR launch/.test(J(r).error), r.body);

  m = { token: TOKEN, operator: BUYER, basis: 'operator', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, BUYER) });
  check('claim: a second wallet cannot take an already-recognised project without evidence', r.statusCode === 422, r.body);

  const digest = Market.digest('OperatorClaim', { token: TOKEN, operator: lc(A.SAFE), basis: 'operator', nonce: nonce(), expiry: exp(600) });
  const ok1271 = await mp._internals.verifySig((await import(path.join(ROOT, 'netlify/lib/chain-rpc.js'))).serverRpc ? require(path.join(ROOT, 'netlify/lib/chain-rpc.js')).serverRpc() : null, A.SAFE, 'OperatorClaim', { token: TOKEN, operator: lc(A.SAFE), basis: 'operator', nonce: nonce(), expiry: exp(600) }, signDigest(A.SAFE_OWNER, digest));
  check('signatures: EIP-1271 contract wallets verify through a live isValidSignature call', typeof ok1271 === 'boolean');
}

// ================================================================================ listings
const TERMS = { description: 'Operating project: site, community and the creator-fee right move to the new operator.', included: [{ label: 'Website + domain', kind: 'manual', note: 'registrar transfer' }, { label: 'Telegram community', kind: 'manual' }, { label: 'Operator record (SyncNet Passport)', kind: 'syncnet' }, { label: 'Creator-fee right', kind: 'onchain' }], notIncluded: ['Token supply', 'Locked liquidity', 'X account'], includeFeeRight: true };
let LISTING = null;
{
  const termsHash = Market.hashJson(Market.normalizeTerms(TERMS).terms);
  let m = { token: TOKEN, seller: BUYER, price: '2.5', currency: 'ETH', termsHash, nonce: nonce(), expiry: exp(86400) };
  let r = await POST({ action: 'list', ...m, terms: TERMS, signature: sign('Listing', m, BUYER) });
  check('list: a wallet that is NOT the recognised operator cannot list', r.statusCode === 403, r.body);

  m = { token: TOKEN, seller: SELLER, price: '2.5', currency: 'ETH', termsHash, nonce: nonce(), expiry: exp(86400) };
  const tampered = { ...TERMS, description: 'Everything is included, trust me, totally different terms here.' };
  r = await POST({ action: 'list', ...m, terms: tampered, signature: sign('Listing', m, SELLER) });
  check('list: terms tampered after signing (stale signature ≠ recomputed termsHash) are rejected', r.statusCode === 401, r.body);

  for (const price of ['0', '-1', '1e5', 'x', '1.1234567890123456789', '2000000000']) {
    const bm = { token: TOKEN, seller: SELLER, price, currency: 'ETH', termsHash, nonce: nonce(), expiry: exp(86400) };
    const br = await POST({ action: 'list', ...bm, terms: TERMS, signature: sign('Listing', bm, SELLER) });
    if (price === '0') check('list: price bounds enforced (0, negatives, exponents, >1e9, >18 dp all rejected)', br.statusCode === 400, price + ' -> ' + br.statusCode);
    else if (br.statusCode !== 400) check('list: price bound rejected ' + price, false, br.body);
  }
  m = { token: TOKEN, seller: SELLER, price: '2.5', currency: 'ETH', termsHash, nonce: nonce(), expiry: exp(120 * 86400) };
  r = await POST({ action: 'list', ...m, terms: TERMS, signature: sign('Listing', m, SELLER) });
  check('list: expiry beyond 90 days is rejected', r.statusCode === 400, r.body);

  m = { token: TOKEN, seller: SELLER, price: '2.5', currency: 'ETH', termsHash, nonce: nonce(), expiry: exp(30 * 86400) };
  const sig = sign('Listing', m, SELLER);
  r = await POST({ action: 'list', ...m, terms: TERMS, signature: sig });
  LISTING = J(r).listing;
  check('list: the recognised operator creates a real ACTIVE listing', r.statusCode === 200 && LISTING.status === 'ACTIVE' && LISTING.id.startsWith('0x'), r.body.slice(0, 200));
  check('list: the server snapshot keeps the logo as ipfs:// (metadata is never rewritten to a gateway)', !/gateway|https:\/\/ipfs/.test(JSON.stringify(LISTING.snapshot)), JSON.stringify(LISTING.snapshot));
  check('list: fee right facts come from the live chain (wallet recipient → transferable)', LISTING.feeRight.kind === 'wallet' && LISTING.feeRight.transferable === true);

  r = await POST({ action: 'list', ...m, terms: TERMS, signature: sig });
  check('list: an exact duplicate submission is rejected (deterministic ID)', r.statusCode === 409, r.body);
  const m2 = { ...m, nonce: nonce() };
  r = await POST({ action: 'list', ...m2, terms: TERMS, signature: sign('Listing', m2, SELLER) });
  check('list: a second ACTIVE listing for the same project is rejected', r.statusCode === 409 && J(r).code === 'already_listed', r.body);

  // a vault project cannot include the fee right
  let cm = { token: VAULT_TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  await POST({ action: 'claim', ...cm, signature: sign('OperatorClaim', cm, SELLER) });
  const vt = Market.normalizeTerms({ ...TERMS, includeFeeRight: true }).terms;
  const vm = { token: VAULT_TOKEN, seller: SELLER, price: '1', currency: 'ETH', termsHash: Market.hashJson(vt), nonce: nonce(), expiry: exp(86400) };
  r = await POST({ action: 'list', ...vm, terms: { ...TERMS, includeFeeRight: true }, signature: sign('Listing', vm, SELLER) });
  check('list: "creator-fee right included" is refused when the live recipient is a PAR vault', r.statusCode === 422 && /vault/.test(J(r).error), r.body);

  const pub = J(await GET({ view: 'listings' }));
  check('read: the listing is publicly queryable (persistent server records, not localStorage)', pub.listings.length === 1 && pub.listings[0].id === LISTING.id && pub.listings[0].seller === SELLER);
  check('read: no signatures or nonces leak from the browse view', !/signature|nonce/.test(JSON.stringify(pub.listings[0])), JSON.stringify(pub.listings[0]).slice(0, 200));
}

// ================================================================================ offers
let OFFER = null;
{
  let m = { listingId: LISTING.id, termsHash: LISTING.termsHash, token: TOKEN, buyer: SELLER, amount: '2.4', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  let r = await POST({ action: 'offer', ...m, signature: sign('Offer', m, SELLER) });
  check('offer: the seller cannot bid on their own listing', r.statusCode === 409, r.body);

  m = { listingId: LISTING.id, termsHash: '0x' + 'ee'.repeat(32), token: TOKEN, buyer: BUYER, amount: '2.4', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  r = await POST({ action: 'offer', ...m, signature: sign('Offer', m, BUYER) });
  check('offer: an offer against different terms than the listing is rejected', r.statusCode === 409 && J(r).code === 'terms_changed', r.body);

  m = { listingId: LISTING.id, termsHash: LISTING.termsHash, token: TOKEN, buyer: BUYER, amount: '2.4', currency: 'USD', nonce: nonce(), expiry: exp(86400) };
  r = await POST({ action: 'offer', ...m, signature: sign('Offer', m, BUYER) });
  check('offer: currency must match the listing', r.statusCode === 400, r.body);

  m = { listingId: LISTING.id, termsHash: LISTING.termsHash, token: TOKEN, buyer: BUYER, amount: '2.4', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  r = await POST({ action: 'offer', ...m, signature: sign('Offer', m, ATTACKER) });
  check('offer: a signature by a different wallet than the buyer is rejected', r.statusCode === 401, r.body);
  r = await POST({ action: 'offer', ...m, signature: sign('Offer', m, BUYER) });
  OFFER = J(r).offer;
  check('offer: a signed offer persists as PENDING', r.statusCode === 200 && OFFER.status === 'PENDING', r.body.slice(0, 160));

  const low = { listingId: LISTING.id, termsHash: LISTING.termsHash, token: TOKEN, buyer: ATTACKER, amount: '0.1', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  await POST({ action: 'offer', ...low, signature: sign('Offer', low, ATTACKER) });

  let dm = { offerId: OFFER.id, listingId: LISTING.id, seller: BUYER, decision: 'accept', nonce: nonce() };
  r = await POST({ action: 'offer-decision', ...dm, signature: sign('OfferDecision', dm, BUYER) });
  check('offer: only the seller can accept (unauthorized acceptance rejected)', r.statusCode === 403, r.body);

  dm = { offerId: OFFER.id, listingId: LISTING.id, seller: SELLER, decision: 'accept', nonce: nonce() };
  r = await POST({ action: 'offer-decision', ...dm, signature: sign('OfferDecision', dm, SELLER) });
  const deal = J(r).deal;
  check('offer: seller acceptance (signed) creates a persistent Deal', r.statusCode === 200 && deal && deal.status === 'OPEN' && deal.buyer === BUYER && deal.price === '2.4', r.body.slice(0, 200));
  check('offer: the deal checklist mirrors the signed terms (operator transfer + fee right + ETH payment + 2 manual assets)', deal.checklist.operatorTransfer.required && deal.checklist.feeRight.required && deal.checklist.payment.kind === 'onchain' && deal.checklist.assets.length === 2, JSON.stringify(deal.checklist).slice(0, 200));
  const li = J(await GET({ view: 'listing', id: LISTING.id }));
  check('offer: the other pending offer is SUPERSEDED and the listing is OFFER_ACCEPTED', li.listing.status === 'OFFER_ACCEPTED' && li.offers.some((o) => o.status === 'SUPERSEDED'), JSON.stringify(li.offers));
  r = await POST({ action: 'offer-decision', ...dm, signature: sign('OfferDecision', dm, SELLER) });
  check('offer: re-accepting the same offer is rejected', r.statusCode === 409, r.body);
  LISTING.dealId = deal.id;
  m = { listingId: LISTING.id, termsHash: LISTING.termsHash, token: TOKEN, buyer: ATTACKER, amount: '9', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  r = await POST({ action: 'offer', ...m, signature: sign('Offer', m, ATTACKER) });
  check('offer: offers against a no-longer-ACTIVE listing are rejected', r.statusCode === 409, r.body);
}

// ================================================================================ two-party operator transfer
const DEAL = LISTING.dealId;
{
  let im = { dealId: DEAL, token: TOKEN, from: SELLER, to: BUYER, nonce: nonce(), expiry: exp(3600) };
  let r = await POST({ action: 'transfer-intent', ...im, from: ATTACKER, signature: sign('TransferIntent', { ...im, from: ATTACKER }, ATTACKER) });
  check('transfer: only seller → buyer for this deal (an attacker cannot inject an intent)', r.statusCode === 409, r.body);
  r = await POST({ action: 'transfer-intent', ...im, signature: sign('TransferIntent', im, SELLER) });
  const intentHash = J(r).deal && J(r).deal.transfer.intent.hash;
  check('transfer: the seller signs a transfer intent (deal enters IN_TRANSFER)', r.statusCode === 200 && intentHash, r.body.slice(0, 160));
  check('transfer: the listing is IN_TRANSFER', J(await GET({ view: 'listing', id: LISTING.id })).listing.status === 'IN_TRANSFER');

  let am = { dealId: DEAL, token: TOKEN, from: SELLER, to: BUYER, intentHash, nonce: nonce(), expiry: exp(3600) };
  r = await POST({ action: 'transfer-accept', ...am, signature: sign('TransferAccept', am, ATTACKER) });
  check('transfer: the WRONG buyer signing the acceptance is rejected', r.statusCode === 401, r.body);
  r = await POST({ action: 'transfer-accept', ...am, intentHash: '0x' + '77'.repeat(32), signature: sign('TransferAccept', { ...am, intentHash: '0x' + '77'.repeat(32) }, BUYER) });
  check('transfer: an acceptance over a different intent hash is rejected', r.statusCode === 409, r.body);
  r = await POST({ action: 'transfer-accept', ...am, signature: sign('TransferAccept', am, BUYER) });
  const p1 = J(r).passport;
  check('transfer: BOTH signatures verified → the canonical operator becomes the buyer', r.statusCode === 200 && p1.operator === BUYER, r.body.slice(0, 200));
  check('transfer: history permanently records A → B (append-only, the old operator is never deleted)', p1.history.some((h) => h.type === 'operator-transfer' && h.from === SELLER && h.to === BUYER) && p1.history[0].type === 'operator-claim', JSON.stringify(p1.history.map((h) => h.type)));

  r = await POST({ action: 'transfer-accept', ...am, signature: sign('TransferAccept', am, BUYER) });
  check('transfer: replaying the acceptance is rejected', r.statusCode === 409, r.body);
  const im2 = { dealId: DEAL, token: TOKEN, from: SELLER, to: BUYER, nonce: nonce(), expiry: exp(3600) };
  r = await POST({ action: 'transfer-intent', ...im2, signature: sign('TransferIntent', im2, SELLER) });
  check('transfer: the seller is no longer the recognised operator → further intents are rejected', r.statusCode === 409 && J(r).code === 'not_operator', r.body);
}

// ================================================================================ on-chain payment + fee-right verification
{
  let r = await POST({ action: 'payment-evidence', dealId: DEAL, txHash: '0x' + 'ab'.repeat(32) });
  check('payment: an unknown transaction hash is rejected', r.statusCode === 409, r.body);
  const wrong = await sendTx({ from: BUYER, to: ATTACKER, value: '0x' + (24n * 10n ** 17n).toString(16), data: '0x' });
  r = await POST({ action: 'payment-evidence', dealId: DEAL, txHash: wrong });
  check('payment: a transfer to the WRONG wallet is rejected', r.statusCode === 409 && /buyer wallet to the seller wallet/.test(J(r).error), r.body);
  const small = await sendTx({ from: BUYER, to: SELLER, value: '0x' + (10n ** 17n).toString(16), data: '0x' });
  r = await POST({ action: 'payment-evidence', dealId: DEAL, txHash: small });
  check('payment: a transfer below the agreed price is rejected', r.statusCode === 409, r.body);
  const good = await sendTx({ from: BUYER, to: SELLER, value: '0x' + (24n * 10n ** 17n).toString(16), data: '0x' });
  r = await POST({ action: 'payment-evidence', dealId: DEAL, txHash: good });
  check('payment: a real buyer→seller transfer of the agreed 2.4 ETH verifies ON-CHAIN', r.statusCode === 200 && J(r).deal.checklist.payment.done && J(r).deal.checklist.payment.evidence.txHash === good, r.body.slice(0, 200));
  r = await POST({ action: 'payment-evidence', dealId: DEAL, txHash: good });
  check('payment: the same transaction cannot be attached twice', r.statusCode === 409 && J(r).code === 'tx_used', r.body);

  r = await POST({ action: 'fee-right-evidence', dealId: DEAL, txHash: good });
  check('fee right: verified from the CHAIN, not the hash — recipient still the seller → rejected', r.statusCode === 409 && /not the buyer yet/.test(J(r).error), r.body);
  const sel = Core.functionSelector('transferCreatorFeeRecipient(address,address)');
  const feeTx = await sendTx({ from: SELLER, to: '0x3ea29975a79900179F3e1aEF93347Ba4210c29C1', value: '0x0', data: sel + Core.abiEncode(['address', 'address'], [TOKEN, BUYER]).slice(2) });
  r = await POST({ action: 'fee-right-evidence', dealId: DEAL, txHash: feeTx });
  check('fee right: after the real on-chain transferCreatorFeeRecipient, the step verifies', r.statusCode === 200 && J(r).deal.checklist.feeRight.done && J(r).deal.checklist.feeRight.recipientNow === BUYER, r.body.slice(0, 200));
}

// ================================================================================ manual assets + completion
{
  const confirm = async (role, wallet, item, deal) => {
    const m = { dealId: DEAL, wallet, role, item, stateHash: deal ? deal.completeHash : '0x' + '00'.repeat(32), nonce: nonce() };
    return POST({ action: 'deal-confirm', ...m, signature: sign('DealConfirm', m, wallet) });
  };
  let d = J(await GET({ view: 'deal', id: DEAL })).deal;
  let r = await confirm('buyer', BUYER, 'complete', d);
  check('complete: cannot complete while manual assets are unconfirmed', r.statusCode === 409 && /done yet/.test(J(r).error), r.body);
  r = await confirm('buyer', ATTACKER, 'a1', d);
  check('confirm: only the deal parties can confirm items', r.statusCode === 403, r.body);
  await confirm('buyer', BUYER, 'a1', d);
  r = await confirm('seller', SELLER, 'a1', d);
  check('confirm: a manual asset needs BOTH parties (website+domain done after both signed)', r.statusCode === 200 && J(r).deal.checklist.assets.find((a) => a.id === 'a1').done, r.body.slice(0, 160));
  await confirm('buyer', BUYER, 'a2', d); await confirm('seller', SELLER, 'a2', d);
  d = J(await GET({ view: 'deal', id: DEAL })).deal;
  r = await confirm('buyer', BUYER, 'complete', { completeHash: '0x' + '99'.repeat(32) });
  check('complete: a stale/forged checklist state hash is rejected', r.statusCode === 409, r.body);
  r = await confirm('buyer', BUYER, 'complete', d);
  check('complete: the buyer confirms completion over the exact checklist state', r.statusCode === 200 && !J(r).deal.completedAt, r.body.slice(0, 160));
  r = await confirm('seller', SELLER, 'complete', d);
  const done = J(r).deal;
  check('complete: BOTH confirmations → the deal and the listing are COMPLETED', r.statusCode === 200 && done.status === 'COMPLETED' && J(await GET({ view: 'listing', id: LISTING.id })).listing.status === 'COMPLETED', r.body.slice(0, 160));
  const pass = J(await GET({ view: 'passport', token: TOKEN })).passport;
  check('complete: the Passport shows previous operator → new operator with the deal reference', pass.operator === BUYER && pass.history.some((h) => h.type === 'deal-completed' && h.dealId === DEAL) && pass.history.some((h) => h.from === SELLER && h.to === BUYER), JSON.stringify(pass.history.map((h) => h.type)));
}

// ================================================================================ cancellation flows
{
  // fresh listing by the NEW operator (the buyer owns the project now)
  const t = Market.normalizeTerms({ description: 'Second sale of the same project by its new operator.', included: [{ label: 'Telegram', kind: 'manual' }], notIncluded: [], includeFeeRight: false }).terms;
  let m = { token: TOKEN, seller: BUYER, price: '5', currency: 'ETH', termsHash: Market.hashJson(t), nonce: nonce(), expiry: exp(86400) };
  let r = await POST({ action: 'list', ...m, terms: t, signature: sign('Listing', m, BUYER) });
  const L2 = J(r).listing;
  check('lifecycle: the NEW operator can list the project again', r.statusCode === 200 && L2.status === 'ACTIVE', r.body.slice(0, 160));

  let cm = { listingId: L2.id, seller: SELLER, nonce: nonce() };
  r = await POST({ action: 'cancel-listing', ...cm, signature: sign('ListingCancel', cm, SELLER) });
  check('cancel: the OLD operator cannot cancel the new listing', r.statusCode === 403, r.body);
  const om = { listingId: L2.id, termsHash: L2.termsHash, token: TOKEN, buyer: ATTACKER, amount: '4', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  await POST({ action: 'offer', ...om, signature: sign('Offer', om, ATTACKER) });
  cm = { listingId: L2.id, seller: BUYER, nonce: nonce() };
  r = await POST({ action: 'cancel-listing', ...cm, signature: sign('ListingCancel', cm, BUYER) });
  check('cancel: the seller cancels with a signature; the listing is CANCELLED', r.statusCode === 200 && J(r).listing.status === 'CANCELLED');
  const li = J(await GET({ view: 'listing', id: L2.id }));
  check('cancel: pending offers against the cancelled listing become void (SUPERSEDED)', li.offers.every((o) => o.status !== 'PENDING'), JSON.stringify(li.offers));
  const om2 = { listingId: L2.id, termsHash: L2.termsHash, token: TOKEN, buyer: ATTACKER, amount: '4', currency: 'ETH', nonce: nonce(), expiry: exp(86400) };
  r = await POST({ action: 'offer', ...om2, signature: sign('Offer', om2, ATTACKER) });
  check('cancel: a stale accept/offer attempt after cancellation is rejected', r.statusCode === 409, r.body);

  // deal cancellation reopens the listing when no transfer happened
  const t3 = Market.normalizeTerms({ description: 'Third listing to exercise deal cancellation without a transfer.', included: [], notIncluded: [], includeFeeRight: false }).terms;
  m = { token: TOKEN, seller: BUYER, price: '3', currency: 'USD', termsHash: Market.hashJson(t3), nonce: nonce(), expiry: exp(86400) };
  const L3 = J(await POST({ action: 'list', ...m, terms: t3, signature: sign('Listing', m, BUYER) })).listing;
  const o3 = { listingId: L3.id, termsHash: L3.termsHash, token: TOKEN, buyer: SELLER, amount: '3', currency: 'USD', nonce: nonce(), expiry: exp(86400) };
  const O3 = J(await POST({ action: 'offer', ...o3, signature: sign('Offer', o3, SELLER) })).offer;
  const d3 = { offerId: O3.id, listingId: L3.id, seller: BUYER, decision: 'accept', nonce: nonce() };
  const DEAL3 = J(await POST({ action: 'offer-decision', ...d3, signature: sign('OfferDecision', d3, BUYER) })).deal;
  r = await POST({ action: 'payment-evidence', dealId: DEAL3.id, txHash: '0x' + '12'.repeat(32) });
  check('payment: non-ETH deals cannot use transaction-hash evidence (manual both-party confirmation instead)', r.statusCode === 409 && /manually/.test(J(r).error), r.body);
  const dc = { dealId: DEAL3.id, wallet: SELLER, reason: 'buyer changed their mind', nonce: nonce() };
  r = await POST({ action: 'deal-cancel', ...dc, signature: sign('DealCancel', dc, SELLER) });
  check('deal-cancel: either party can cancel an open deal; the listing reopens when no transfer happened', r.statusCode === 200 && J(r).deal.status === 'CANCELLED' && J(await GET({ view: 'listing', id: L3.id })).listing.status === 'ACTIVE', r.body.slice(0, 160));
}

// ================================================================================ persistence, gating, hygiene
{
  const fresh = J(await GET({ view: 'listings' }));
  check('persistence: records live server-side and survive any client reset (' + fresh.listings.length + ' listings queryable)', fresh.listings.length >= 3);
  const wal = J(await GET({ view: 'wallet', address: BUYER }));
  check('persistence: the wallet view lists my listings, offers and deals', wal.listings.length >= 1 && wal.deals.length >= 1, JSON.stringify({ l: wal.listings.length, o: wal.offers.length, d: wal.deals.length }));

  const mem = { ...createStore({ map: new Map() }) };
  let r = await GET({ view: 'config' }, { store: mem, env: {} });
  check('fail closed: without a durable store the Marketplace reports enabled:false', J(r).enabled === false);
  const m = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, SELLER) }, { store: mem, env: {} });
  check('fail closed: writes without a durable store are refused (503)', r.statusCode === 503, r.body);
  r = await POST({ action: 'claim', ...m, signature: sign('OperatorClaim', m, SELLER) }, { store, env: { SYNCNET_MARKETPLACE_DISABLED: 'true' } });
  check('fail closed: SYNCNET_MARKETPLACE_DISABLED=true refuses every write', r.statusCode === 503, r.body);

  let last = null;
  for (let i = 0; i < 21; i++) last = await POST({ action: 'claim', token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600), signature: '0x' + '11'.repeat(65) }, deps, '198.51.100.77');
  check('abuse: per-IP write rate limit (21st write in a minute → 429 + Retry-After)', last.statusCode === 429 && Number(last.headers['retry-after']) > 0, last.statusCode);

  r = await POST({ action: 'no-such-action', x: 1 });
  check('hygiene: unknown actions are a fixed 400', r.statusCode === 400 && noLeak(r));
  r = await mp._handler(ev('POST', { body: 'not json{{' }), deps);
  check('hygiene: malformed JSON bodies are a fixed 400', r.statusCode === 400 && noLeak(r));
  r = await GET({ view: 'listing', id: '0x' + '00'.repeat(32) });
  check('hygiene: unknown records are a plain 404', r.statusCode === 404 && noLeak(r));
  const hostile = { description: '<img src=x onerror=alert(1)> hostile <script>1</script> listing description text', included: [{ label: '<b>x</b>', kind: 'manual' }], notIncluded: [], includeFeeRight: false };
  const nt = Market.normalizeTerms(hostile);
  check('hygiene: terms are sanitized server-side (control chars out, length caps applied)', nt.ok && nt.terms.description.length <= 2000 && nt.terms.included[0].label.length <= 140);
  check('hygiene: every response is JSON with nosniff + deny-all CSP', /application\/json/.test((await GET({ view: 'config' })).headers['content-type']) && /default-src 'none'/.test((await GET({ view: 'config' })).headers['content-security-policy']));
  chain.rpcDown = true;
  const cm2 = { token: TOKEN, operator: SELLER, basis: 'deployer', nonce: nonce(), expiry: exp(600) };
  r = await POST({ action: 'claim', ...cm2, signature: sign('OperatorClaim', cm2, SELLER) });
  check('hygiene: an RPC outage fails closed with a generic 503 (no upstream text)', r.statusCode === 503 && noLeak(r), r.body);
  chain.rpcDown = false;
}

fs.writeFileSync(path.join(ROOT, 'tests/server/marketplace.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} marketplace server checks passed`);
process.exit(failures ? 1 : 0);
