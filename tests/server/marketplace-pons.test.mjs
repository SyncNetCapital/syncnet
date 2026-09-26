// Marketplace × Pons V2 server suite. Origins are resolved ONLY from live reads of the canonical factories
// (lib/syncnet-origins.js): PAR keeps working exactly as before, genuine Pons V2 launches can be claimed, listed,
// sold and have their creator-fee right settled — verified by re-reading the Pons V2 factory, never by a tx hash.
// Chain = the e2e harness mock (exact Pons ABI layouts); stub RPCs cover decoding edge cases. No real network.
// Run: node tests/server/marketplace-pons.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { A, chain, resetChain, sendTx, signDigest, Core, ROOT } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const Origins = require(path.join(ROOT, 'lib/syncnet-origins.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
let ipSeq = 0;
const ev = (method, { query = {}, body = null } = {}) => ({ httpMethod: method, headers: { 'x-nf-client-connection-ip': `192.0.2.${(ipSeq++ % 250) + 1}` }, queryStringParameters: query, body: body == null ? null : JSON.stringify(body) });
const MAP = new Map();
const store = { ...createStore({ map: MAP }), durable: true, kind: 'test-durable' };
const deps = { store, env: {} };
const GET = (query, d = deps) => mp._handler(ev('GET', { query }), d);
const POST = (body, d = deps) => mp._handler(ev('POST', { body }), d);
const lc = (v) => String(v).toLowerCase();
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const exp = (s) => Math.floor(Date.now() / 1000) + s;
const sign = (kind, m, as) => signDigest(as, Market.digest(kind, m));
const rpc = Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { retries: 0 });
const noLeak = (r) => !/\n\s+at |Error:|ENOTFOUND|stack|\.js:\d|upstash|redis/i.test(r.body);

const PONS = lc(A.PONS2), PONS_ETH = lc(A.PONS2_ETH), PONS_CONTRACT = lc(A.PONS2_CONTRACT), PONS_PENDING = lc(A.PONS2_PENDING), PONS1 = lc(A.PONS1);
const PAR = lc(A.CREATORLIVE), USDG = lc(A.USDG);
const SELLER = lc(A.WALLET), BUYER = lc(A.WALLET2), ATTACKER = lc(A.ATTACKER);
const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const claim = (token, operator, basis, extra = {}) => { const m = { token, operator, basis, nonce: rnd(), expiry: exp(600) }; return POST({ action: 'claim', ...m, ...extra, signature: sign('OperatorClaim', m, operator) }); };
const TERMS = { description: 'Operational control of a live Pons V2 project, community and site included.', included: [{ label: 'Website + domain', kind: 'manual' }], notIncluded: ['Token supply'], includeFeeRight: false };
const list = (token, seller, includeFeeRight, extra = {}) => {
  const t = Market.normalizeTerms({ ...TERMS, includeFeeRight }).terms;
  const m = { token, seller, price: '1.5', currency: 'ETH', termsHash: Market.hashJson(t), nonce: rnd(), expiry: exp(86400) };
  return POST({ action: 'list', ...m, terms: { ...TERMS, includeFeeRight }, ...extra, signature: sign('Listing', m, seller) });
};
resetChain();

// ================================================================================ EIP-712 unchanged (18)
{
  check('18 EIP-712 Marketplace domain unchanged', JSON.stringify(Market.DOMAIN) === JSON.stringify({ name: 'SyncNet Marketplace', version: '1', chainId: 4663 }));
  const m = { token: '0x' + '11'.repeat(20), operator: '0x' + '22'.repeat(20), basis: 'deployer', nonce: '0x' + '33'.repeat(32), expiry: 1790000000 };
  // Vectors pinned from lib/syncnet-market.js as of 6d067d5 (before Pons support): any change to the domain or a
  // signed structure would change them and invalidate every existing signature.
  check('18 OperatorClaim digest vector unchanged (existing signatures stay valid)', Market.digest('OperatorClaim', m) === '0x7790d95fb4c12e0286633a25084dec49b1c631496b35d950c4cd5d21168e3f64');
  check('18 Listing digest vector unchanged', Market.digest('Listing', { token: '0x' + '11'.repeat(20), seller: '0x' + '22'.repeat(20), price: '1.5', currency: 'ETH', termsHash: '0x' + '44'.repeat(32), nonce: '0x' + '33'.repeat(32), expiry: 1790000000 }) === '0xbe3068bae2eb1eb8b576dffee6ee02386e5886dda9349dd0afa5781e607d6e5a');
  check('18 no signed structure gained a launchpad/origin field', !JSON.stringify(Market.TYPES).match(/launchpad|origin/i));
}

// ================================================================================ resolver: detection + decoding edge cases (2, 3)
{
  const p = await Origins.resolveProject(rpc, PONS);
  check('2 genuine Pons V2 launch resolves as PONS_V2 via the canonical factory', p && p.origin === 'PONS_V2' && p.factory === PONS_FACTORY && p.supported === true && p.deployer === SELLER);
  check('2 Pons V2 facts: pair, phase label, creator tax', p.pair.address === USDG && p.state.label === 'BONDING CURVE' && p.creatorTaxBps === 200);
  const e = await Origins.resolveProject(rpc, PONS_ETH);
  check('2 native-ETH pair (address 0) and graduated phase map truthfully', e.pair.native === true && e.state.label === 'GRADUATED · V4 LIVE');
  const c = await Origins.resolveProject(rpc, PONS_CONTRACT);
  check('2 transitional "Swept" phase is GRADUATING, not graduated', c.state.label === 'GRADUATING');
  const par = await Origins.resolveProject(rpc, PAR);
  check('1 PAR launch still resolves as PAR from the PAR factory', par && par.origin === 'PAR' && Origins.PAR_FACTORIES.includes(par.factory));
  check('3 a random ERC-20 (USDG) is not Pons and not PAR', (await Origins.resolveProject(rpc, USDG)) === null);
  const v1 = await Origins.resolveProject(rpc, PONS1);
  check('Pons V1 is identified positively and marked unsupported (not treated as V2)', v1 && v1.origin === 'PONS_V1' && v1.supported === false);

  // stub RPCs: exact decoding rules
  const REC = '(address,address,address,address,address,uint256,uint24,int24,uint16,bool,uint8,uint256,uint256,uint256,bool)';
  const Z = '0x' + '00'.repeat(20);
  const zeroParMulti = Core.abiEncode(['(address,address,address,uint24,int24,uint16,uint16,uint16,address,uint64,uint8,bool)'], [[Z, Z, Z, 0, 0, 0, 0, 0, Z, 0n, 0, false]]);
  const stub = (ponsAnswer) => async (method, params) => {
    if (method !== 'eth_call') throw new Error('unexpected');
    const to = lc(params[0].to);
    if (to === lc(Chain.ROBINHOOD.multiFactory)) return zeroParMulti;
    if (to === lc(Chain.ROBINHOOD.factory)) return '0x' + '00'.repeat(32 * 17);
    if (to === PONS_FACTORY) return typeof ponsAnswer === 'function' ? ponsAnswer(params[0].data) : ponsAnswer;
    return '0x';
  };
  const T = '0x' + 'ab'.repeat(20);
  const rec = (token, exists) => Core.abiEncode([REC], [[token, Z, SELLER, SELLER, Z, 1n, 10000, 200, 100, false, 0, 0n, 0n, 0n, exists]]);
  check('3 Pons record with exists=false is not Pons', (await Origins.readPonsV2(stub(rec(T, false)), T)) === null);
  check('3 Pons record naming a DIFFERENT token is not accepted for this token', (await Origins.readPonsV2(stub(rec('0x' + 'cd'.repeat(20), true)), T)) === null);
  check('3 an empty answer (no factory code) is not Pons', (await Origins.readPonsV2(stub('0x'), T)) === null);
  let threw = false; try { await Origins.resolveProject(stub(() => { throw new Error('rpc down'); }), T); } catch { threw = true; }
  check('20 RPC failure while reading the Pons factory THROWS (fail closed, never "unsupported")', threw);
  const pend = (addr, eff, expires) => (data) => data.startsWith(Origins.SEL.pendingCreatorFeeRecipient) ? Core.abiEncode(['address', 'uint256', 'uint256'], [addr, BigInt(eff), BigInt(expires)]) : rec(T, true);
  const now = Math.floor(Date.now() / 1000);
  check('16 pending override (not yet matured) is ACTIVE', (await Origins.resolveProject(stub(pend(ATTACKER, now + 3600, now + 7200)), T)).pendingOverride.active === true);
  check('16 pending override in its execution window is ACTIVE', (await Origins.resolveProject(stub(pend(ATTACKER, now - 3600, now + 3600)), T)).pendingOverride.active === true);
  check('16 expired override (can no longer execute) is inactive', (await Origins.resolveProject(stub(pend(ATTACKER, now - 9 * 86400, now - 3 * 86400)), T)).pendingOverride.active === false);
  check('16 no override → null', (await Origins.resolveProject(stub(pend(Z, 0, 0)), T)).pendingOverride === null);
  check('16 unreadable override answer is treated as ACTIVE (conservative)', (await Origins.resolveProject(stub((d) => d.startsWith(Origins.SEL.pendingCreatorFeeRecipient) ? '0x' : rec(T, true)), T)).pendingOverride.active === true);
}

// ================================================================================ fee-right classification (8, 16)
{
  const fr = async (t) => Origins.classifyFeeRight(rpc, await Origins.resolveProject(rpc, t));
  check('8 Pons wallet recipient → CREATOR FEE TRANSFERABLE', (await fr(PONS)).kind === 'wallet' && (await fr(PONS)).transferable === true);
  check('8 Pons contract recipient is NOT labelled transferable (manual verification)', (await fr(PONS_CONTRACT)).kind === 'contract' && (await fr(PONS_CONTRACT)).transferable === false);
  const p = await fr(PONS_PENDING);
  check('16 Pons wallet recipient with a pending protocol override → ENCUMBERED, not transferable', p.kind === 'encumbered' && p.transferable === false && p.pending.newRecipient === ATTACKER);
  const par = await Origins.classifyFeeRight(rpc, await Origins.resolveProject(rpc, lc(A.SYNCAT)));
  check('1 PAR vault recipient keeps its exact existing classification', par.kind === 'vault' && par.label === 'NOT TRANSFERABLE · fixed to a PAR vault');
}

// ================================================================================ fee-transfer builder (12, 13)
{
  const p = await Origins.resolveProject(rpc, PONS);
  const tx = Origins.feeTransferTx(p, PONS, BUYER);
  const [tok, rcp] = Core.abiDecode(['address', 'address'], '0x' + tx.data.slice(10));
  check('12 Pons fee transfer goes ONLY to the canonical Pons V2 factory', tx.to === PONS_FACTORY && tx.value === '0x0');
  check('13 calldata = transferCreatorFeeRecipient(exact token, exact buyer)', tx.data.startsWith(Core.functionSelector('transferCreatorFeeRecipient(address,address)')) && lc(tok) === PONS && lc(rcp) === BUYER);
  const bad = (fn) => { try { fn(); return false; } catch { return true; } };
  check('12 a tampered destination is refused', bad(() => Origins.feeTransferTx({ ...p, factory: '0x' + '99'.repeat(20) }, PONS, BUYER)));
  check('12 a Pons project pointed at a PAR factory is refused', bad(() => Origins.feeTransferTx({ ...p, factory: Origins.PAR_FACTORIES[0] }, PONS, BUYER)));
  check('13 a different token than the verified project is refused', bad(() => Origins.feeTransferTx(p, PAR, BUYER)));
  check('13 zero / invalid new recipient refused', bad(() => Origins.feeTransferTx(p, PONS, '0x' + '00'.repeat(20))) && bad(() => Origins.feeTransferTx(p, PONS, 'buyer')));
  check('Pons V1 / unsupported origins cannot build a fee transfer', bad(() => Origins.feeTransferTx({ origin: 'PONS_V1', supported: false, factory: Origins.PONS_V1_FACTORY, token: PONS1 }, PONS1, BUYER)));
  const parP = await Origins.resolveProject(rpc, PAR);
  check('1 PAR fee transfer still targets the PAR factory', Origins.feeTransferTx(parP, PAR, BUYER).to === lc(Chain.ROBINHOOD.multiFactory));
}

// ================================================================================ claims (1, 3, 4, 5, 6, 7, 20)
{
  let r = await claim(PAR, SELLER, 'deployer');
  check('1 PAR deployer claim works exactly as before (same evidence text)', r.statusCode === 200 && J(r).passport.claims[0].evidence === 'wallet is the on-chain deployer (PAR factory record)' && J(r).passport.launchpad === 'PAR', r.body);
  r = await claim(PONS, SELLER, 'deployer');
  check('5 Pons V2 deployer can create the initial Passport claim', r.statusCode === 200 && J(r).passport.operator === SELLER, r.body);
  check('5 evidence names the venue: "(Pons V2 factory record)"', J(r).passport.claims[0].evidence === 'wallet is the on-chain deployer (Pons V2 factory record)');
  check('5 Passport records server-derived origin + canonical factory, schema unchanged', J(r).passport.launchpad === 'PONS_V2' && J(r).passport.factory === PONS_FACTORY && J(r).passport.schema === 'syncnet.passport.v1');
  r = await claim(PONS_ETH, BUYER, 'fee-recipient');
  check('6 current Pons creator-fee recipient WALLET can claim', r.statusCode === 200 && J(r).passport.claims[0].evidence === 'wallet is the current on-chain creator-fee recipient (Pons V2 factory record)', r.body);
  r = await claim(PONS_ETH, ATTACKER, 'deployer');
  check('7 unrelated wallet cannot claim a Pons project (deployer basis)', r.statusCode === 422 || r.statusCode === 409, r.body);
  r = await claim(PONS_CONTRACT, ATTACKER, 'fee-recipient');
  check('7 unrelated wallet cannot claim via fee-recipient', r.statusCode === 422 && J(r).code === 'no_evidence', r.body);
  r = await claim(USDG, SELLER, 'deployer', { launchpad: 'PONS_V2', origin: { launchpad: 'PONS_V2' }, factory: PONS_FACTORY });
  check('3/4 a random ERC-20 with client-supplied launchpad=PONS_V2 is still refused', r.statusCode === 422 && /not a PAR launch/.test(J(r).error), r.body);
  r = await claim(PONS1, SELLER, 'deployer');
  check('Pons V1 claim → "PONS V1 DETECTED · … not supported", no roadmap promise, not "unsupported/scam"', r.statusCode === 422 && J(r).code === 'unsupported_origin' && /PONS V1 DETECTED/.test(J(r).error) && /not supported by the Marketplace/.test(J(r).error) && !/\byet\b/.test(J(r).error), r.body);
  r = await claim(PONS_CONTRACT, SELLER, 'deployer');
  check('8 Pons project with a contract fee recipient can still be claimed by its deployer', r.statusCode === 200, r.body);
  r = await claim(PONS_PENDING, SELLER, 'deployer');
  check('16 Pons project with a pending override can be claimed by its deployer', r.statusCode === 200, r.body);
  const mem = createStore({ map: new Map() });
  r = await POST({ action: 'claim', token: PONS, operator: SELLER, basis: 'deployer', nonce: rnd(), expiry: exp(600), signature: '0x' + '11'.repeat(65) }, { store: mem, env: {} });
  check('20 no durable store → Pons writes refused (503)', r.statusCode === 503, r.body);
  chain.rpcDown = true;
  r = await claim(PONS_ETH, BUYER, 'fee-recipient');
  check('20 RPC down → Pons claim fails closed with 503 and no internal detail', r.statusCode === 503 && noLeak(r), r.body);
  chain.rpcDown = false;
}

// ================================================================================ listings (8, 9, 16, 4)
let LISTING;
{
  let r = await list(PONS_CONTRACT, SELLER, true);
  check('8 contract fee recipient: including the fee right is refused', r.statusCode === 422 && J(r).code === 'fee_right' && /contract/.test(J(r).error), r.body);
  r = await list(PONS_PENDING, SELLER, true);
  check('16 pending override: including the fee right is refused (encumbered)', r.statusCode === 422 && /Pons protocol override/.test(J(r).error), r.body);
  r = await list(PONS_PENDING, SELLER, false);
  check('16 pending override: listing WITHOUT the fee right is allowed and shows ENCUMBERED', r.statusCode === 200 && J(r).listing.feeRight.kind === 'encumbered', r.body);
  r = await list(PONS, SELLER, true, { origin: { launchpad: 'PAR' }, launchpad: 'PAR' });
  check('9 Pons V2 listing with the fee right works', r.statusCode === 200 && J(r).listing.status === 'ACTIVE', r.body);
  LISTING = J(r).listing;
  check('4 client-supplied origin is ignored: listing origin is server-derived PONS_V2', LISTING.origin.launchpad === 'PONS_V2' && LISTING.origin.factory === PONS_FACTORY);
  check('10 listing carries verified Pons facts (pair symbol from chain, phase, tax)', LISTING.origin.pair.symbol === 'USDG' && LISTING.origin.phase.label === 'BONDING CURVE' && LISTING.origin.creatorTaxBps === 200);
  check('no raw chain record is exposed publicly', !('raw' in LISTING.origin) && !/"raw"/.test(JSON.stringify(LISTING)));
  const all = J(await GET({ view: 'listings' })).listings;
  check('11 one shared market: PAR and PONS listings come from the same listings view', all.some((l) => l.origin.launchpad === 'PONS_V2'));
}

// ================================================================================ legacy PAR records (17)
{
  const legacyId = '0x' + 'ee'.repeat(32);
  MAP.set('mp:listing:v1:' + legacyId, { type: 'string', value: JSON.stringify({ schema: 'syncnet.listing.v1', id: legacyId, token: lc(A.SYNC), seller: SELLER, price: '2', currency: 'ETH', terms: { description: 'A listing written before multi-origin support existed.', included: [], notIncluded: [], includeFeeRight: false }, termsHash: '0x' + '00'.repeat(32), nonce: '0x' + '00'.repeat(32), expiry: exp(86400), signature: '0x', status: 'ACTIVE', createdAt: new Date().toISOString(), snapshot: { name: 'SyncNet', symbol: 'SYNC', logo: '' }, feeRight: { kind: 'wallet', transferable: true }, deployer: SELLER, factory: lc(Chain.ROBINHOOD.multiFactory) }), expiresAt: null });
  await store.sadd('mp:listings:v1', legacyId);
  MAP.set('mp:passport:v1:' + lc(A.SYNC), { type: 'string', value: JSON.stringify({ schema: 'syncnet.passport.v1', token: lc(A.SYNC), chainId: 4663, factory: lc(Chain.ROBINHOOD.multiFactory), deployer: SELLER, operator: SELLER, operatorSince: new Date().toISOString(), claims: [], listing: legacyId, history: [{ type: 'operator-claim', operator: SELLER }], createdAt: '', updatedAt: '' }), expiresAt: null });
  const l = J(await GET({ view: 'listing', id: legacyId }));
  check('17 legacy listing without origin renders as PAR (inferred from its PAR factory)', l.listing && l.listing.origin.launchpad === 'PAR' && l.listing.origin.label === 'PAR');
  check('17 legacy passport without launchpad reads as PAR, stored record untouched', l.passport.launchpad === 'PAR' && !JSON.parse(MAP.get('mp:passport:v1:' + lc(A.SYNC)).value).launchpad);
}

// ================================================================================ full Pons deal: passport + fee right (12-16)
{
  const offerM = { listingId: LISTING.id, termsHash: LISTING.termsHash, token: PONS, buyer: BUYER, amount: '1.5', currency: 'ETH', nonce: rnd(), expiry: exp(86400) };
  let r = await POST({ action: 'offer', ...offerM, signature: sign('Offer', offerM, BUYER) });
  check('offer on a Pons listing', r.statusCode === 200, r.body);
  const decM = { offerId: J(r).offer.id, listingId: LISTING.id, seller: SELLER, decision: 'accept', nonce: rnd() };
  r = await POST({ action: 'offer-decision', ...decM, signature: sign('OfferDecision', decM, SELLER) });
  const DEAL = J(r).deal;
  check('Deal Room opens with the fee-right step required', r.statusCode === 200 && DEAL.checklist.feeRight.required === true, r.body);
  const intentM = { dealId: DEAL.id, token: PONS, from: SELLER, to: BUYER, nonce: rnd(), expiry: exp(3600) };
  await POST({ action: 'transfer-intent', ...intentM, signature: sign('TransferIntent', intentM, SELLER) });
  const accM = { dealId: DEAL.id, token: PONS, from: SELLER, to: BUYER, intentHash: Market.digest('TransferIntent', intentM), nonce: rnd(), expiry: exp(3600) };
  r = await POST({ action: 'transfer-accept', ...accM, signature: sign('TransferAccept', accM, BUYER) });
  check('Passport transfer is launchpad-independent (same two signatures), origin preserved', r.statusCode === 200 && J(r).passport.operator === BUYER && J(r).passport.launchpad === 'PONS_V2', r.body);

  r = await POST({ action: 'fee-right-evidence', dealId: DEAL.id, txHash: '0x' + 'ab'.repeat(32) });
  check('15 a fake / unknown tx hash cannot complete the fee-right step', r.statusCode === 409 && J(r).code === 'tx_failed', r.body);
  const unrelated = await sendTx({ from: BUYER, to: SELLER, value: '0x1', data: '0x' });
  r = await POST({ action: 'fee-right-evidence', dealId: DEAL.id, txHash: unrelated });
  check('15 a successful but unrelated tx cannot complete it (factory still names the seller)', r.statusCode === 409 && J(r).code === 'not_transferred', r.body);
  const p = await Origins.resolveProject(rpc, PONS);
  const wrongTo = await sendTx({ from: SELLER, to: Chain.ROBINHOOD.multiFactory, value: '0x0', data: Origins.feeTransferTx(p, PONS, BUYER).data });
  r = await POST({ action: 'fee-right-evidence', dealId: DEAL.id, txHash: wrongTo });
  check('12 the same calldata sent to the PAR factory changes nothing on Pons → not verified', r.statusCode === 409, r.body);
  const tx = Origins.feeTransferTx(p, PONS, BUYER);
  const good = await sendTx({ from: SELLER, to: tx.to, value: '0x0', data: tx.data });
  check('the canonical Pons factory now names the buyer (mock executes Pons semantics)', lc(chain.pons.get(PONS).creatorFeeRecipient) === BUYER);
  chain.pons.get(PONS).pending = { newRecipient: ATTACKER, effectiveAt: exp(3 * 86400), expiresAt: exp(6 * 86400) };
  r = await POST({ action: 'fee-right-evidence', dealId: DEAL.id, txHash: good });
  check('16 override pending AFTER the listing: fee-right step refuses to verify as final', r.statusCode === 409 && J(r).code === 'encumbered', r.body);
  chain.pons.get(PONS).pending = null;
  r = await POST({ action: 'fee-right-evidence', dealId: DEAL.id, txHash: good });
  check('14 server re-read of the Pons V2 factory verifies the transfer', r.statusCode === 200 && J(r).deal.checklist.feeRight.done === true && J(r).deal.checklist.feeRight.factory === PONS_FACTORY, r.body);
}

// ================================================================================ Pons V1 strict detection (V1-1 … V1-10)
// Detection only: V1 is recognised truthfully and stays UNSUPPORTED (no Passport, listing, fee transfer, trade, settle).
// Origin needs BOTH sides: token.launchFactory() names an allowlisted V1 factory AND that factory's record names the token.
{
  const [ACTIVE, LEGACY] = Origins.PONS_V1_FACTORIES;
  check('V1 allowlist is exactly ACTIVE 0xA5aAb3… + LEGACY 0x0c37a2…', Origins.PONS_V1_FACTORIES.length === 2
    && ACTIVE.generation === 'ACTIVE' && ACTIVE.address === '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb'
    && LEGACY.generation === 'LEGACY' && LEGACY.address === '0x0c37a24f5d23a486fa692d1500881d698b1f77a4' && Object.isFrozen(Origins.PONS_V1_FACTORIES));

  // mock chain (harness): one launch per generation
  const a = await Origins.resolveProject(rpc, PONS1);
  check('V1-1 ACTIVE-factory V1 token → PONS_V1 / unsupported / ACTIVE factory', a && a.origin === 'PONS_V1' && a.supported === false && a.factory === ACTIVE.address && a.generation === 'ACTIVE', JSON.stringify(a));
  const PONS1_LEGACY = lc(A.PONS1_LEGACY);
  const g = await Origins.resolveProject(rpc, PONS1_LEGACY);
  check('V1-2 LEGACY-factory V1 token → PONS_V1 / unsupported / LEGACY factory', g && g.origin === 'PONS_V1' && g.supported === false && g.factory === LEGACY.address && g.generation === 'LEGACY', JSON.stringify(g));

  // stub RPC: exact answers per (to, selector); PAR + Pons V2 factories answer "unknown token"
  const Z = '0x' + '00'.repeat(20);
  const V1REC = '(address,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint24,bool,uint256)';
  const V2REC = '(address,address,address,address,address,uint256,uint24,int24,uint16,bool,uint8,uint256,uint256,uint256,bool)';
  const v1rec = (tok, exists) => Core.abiEncode([V1REC], [[tok, SELLER, Z, Z, 1n, 0n, 0n, 0n, 10n ** 27n, false, 10000, exists, 0n]]);
  const addr = (x) => Core.abiEncode(['address'], [x]);
  const SELF = Origins.SEL.launchFactory, GLT = Origins.SEL.getLaunchedToken;
  const stubV1 = (answers) => {
    const seen = [];
    const rpcStub = async (method, params) => {
      if (method !== 'eth_call') throw new Error('unexpected ' + method);
      const to = lc(params[0].to), data = params[0].data, sel = data.slice(0, 10);
      seen.push(to);
      if (to === lc(Chain.ROBINHOOD.multiFactory)) return Core.abiEncode(['(address,address,address,uint24,int24,uint16,uint16,uint16,address,uint64,uint8,bool)'], [[Z, Z, Z, 0, 0, 0, 0, 0, Z, 0n, 0, false]]);
      if (to === lc(Chain.ROBINHOOD.factory)) return '0x' + '00'.repeat(32 * 17);
      if (to === PONS_FACTORY) return sel === GLT ? Core.abiEncode([V2REC], [[Z, Z, Z, Z, Z, 0n, 0, 0, 0, false, 0, 0n, 0n, 0n, false]]) : '0x';
      const f = answers[to + ':' + sel];
      if (f === undefined) return '0x';
      return typeof f === 'function' ? f() : f;
    };
    rpcStub.seen = seen;
    return rpcStub;
  };
  const revert = () => { throw new Chain.RpcError('execution reverted', { code: 3, revert: true }); };
  const T = '0x' + 'b1'.repeat(20), EVIL_FACTORY = '0x' + 'e1'.repeat(20);

  // V1-2 (real data): the actual PONS token, with the exact answers read live from Robinhood Chain on 2026-09-26
  const PONS_REAL = '0x39dbed3a2bd333467115de45665cc57f813c4571';
  const PONS_REAL_RECORD = '0x00000000000000000000000039dbed3a2bd333467115de45665cc57f813c4571000000000000000000000000b9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b00000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad7300000000000000000000000073991a25c818bf1f1128deaab1492d45638de0d3000000000000000000000000000000000000000000000000000000000001aaa00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000018581040000000000000000000000000000000000000000033b2e3c9fd0803ce8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000027100000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000016345785d8a0000';
  const real = await Origins.resolveProject(stubV1({ [PONS_REAL + ':' + SELF]: addr(LEGACY.address), [LEGACY.address + ':' + GLT]: PONS_REAL_RECORD, [ACTIVE.address + ':' + GLT]: v1rec(Z, false) }), PONS_REAL);
  check('V1-2 real PONS answers (launchFactory = LEGACY, LEGACY 13-word record) → PONS_V1 / unsupported / LEGACY', real && real.origin === 'PONS_V1' && real.supported === false && real.factory === LEGACY.address && real.generation === 'LEGACY' && real.deployer === '0xb9f5f4ea1af1f5d3678470eb98e8fbdcadeb24b0', JSON.stringify(real));

  // V1-3 a token naming a factory NOT on the allowlist is never Pons, even if that factory "confirms" it
  const s3 = stubV1({ [T + ':' + SELF]: addr(EVIL_FACTORY), [EVIL_FACTORY + ':' + GLT]: v1rec(T, true) });
  check('V1-3 token names an arbitrary launchFactory (not allowlisted) → NOT Pons', (await Origins.resolveProject(s3, T)) === null);
  check('V1-3 the non-allowlisted factory is never even queried', !s3.seen.includes(EVIL_FACTORY));

  // V1-4 canonical factory has a valid record but the token's own launchFactory() disagrees / is missing
  check('V1-4 ACTIVE factory record exists but token.launchFactory names LEGACY → NOT Pons',
    (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(LEGACY.address), [ACTIVE.address + ':' + GLT]: v1rec(T, true), [LEGACY.address + ':' + GLT]: v1rec(Z, false) }), T)) === null);
  check('V1-4 LEGACY factory record exists but token.launchFactory names an unrelated address → NOT Pons',
    (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(EVIL_FACTORY), [LEGACY.address + ':' + GLT]: v1rec(T, true) }), T)) === null);
  check('V1-4 canonical record exists but token has no launchFactory() (reverts) → NOT Pons',
    (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: revert, [ACTIVE.address + ':' + GLT]: v1rec(T, true) }), T)) === null);
  check('V1-4 canonical record exists but token.launchFactory() is empty → NOT Pons',
    (await Origins.resolveProject(stubV1({ [ACTIVE.address + ':' + GLT]: v1rec(T, true) }), T)) === null);
  check('V1-4 canonical record exists but token.launchFactory() returns zero address → NOT Pons',
    (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(Z), [ACTIVE.address + ':' + GLT]: v1rec(T, true) }), T)) === null);
  check('V1-4 malformed launchFactory() answer → NOT Pons (no crash)',
    (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: '0x1234', [ACTIVE.address + ':' + GLT]: v1rec(T, true) }), T)) === null);

  // V1-5 / V1-6 token names a canonical factory but the factory side does not agree
  for (const F of [ACTIVE, LEGACY]) {
    check(`V1-5 token.launchFactory = ${F.generation} but record exists=false → NOT Pons`,
      (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(F.address), [F.address + ':' + GLT]: v1rec(T, false) }), T)) === null);
    check(`V1-6 token.launchFactory = ${F.generation} but record.token is another token → NOT Pons`,
      (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(F.address), [F.address + ':' + GLT]: v1rec('0x' + 'c2'.repeat(20), true) }), T)) === null);
    check(`V1-6 token.launchFactory = ${F.generation} but factory returns nothing → NOT Pons`,
      (await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(F.address) }), T)) === null);
  }

  // fail closed: an unreadable chain during V1 detection is an error, never "not Pons"
  let threw = false;
  try { await Origins.resolveProject(stubV1({ [T + ':' + SELF]: () => { throw new Chain.RpcError('RPC HTTP 429', { transient: true }); } }), T); } catch { threw = true; }
  check('V1 RPC failure reading token.launchFactory() THROWS (fail closed)', threw);
  threw = false;
  try { await Origins.resolveProject(stubV1({ [T + ':' + SELF]: () => { throw new TypeError('fetch failed'); } }), T); } catch { threw = true; }
  check('V1 network error (non-RpcError) reading token.launchFactory() THROWS (fail closed)', threw);
  threw = false;
  try { await Origins.resolveProject(stubV1({ [T + ':' + SELF]: addr(LEGACY.address), [LEGACY.address + ':' + GLT]: () => { throw new Chain.RpcError('RPC timeout', { transient: true }); } }), T); } catch { threw = true; }
  check('V1 RPC failure reading the canonical V1 factory THROWS (fail closed)', threw);

  // V1-7 no Project Passport for either generation, on any basis
  for (const [name, tok] of [['ACTIVE', PONS1], ['LEGACY', PONS1_LEGACY]]) {
    for (const basis of ['deployer', 'fee-recipient']) {
      const r = await claim(tok, SELLER, basis);
      check(`V1-7 ${name} V1 ${basis} claim refused: 422 unsupported_origin "PONS V1 DETECTED"`, r.statusCode === 422 && J(r).code === 'unsupported_origin' && /PONS V1 DETECTED/.test(J(r).error), r.body);
    }
    const r = await claim(tok, SELLER, 'deployer', { launchpad: 'PONS_V2', origin: { launchpad: 'PONS_V2' }, factory: PONS_FACTORY });
    check(`V1-7 ${name} V1 claim with client-supplied launchpad=PONS_V2 still refused`, r.statusCode === 422 && J(r).code === 'unsupported_origin', r.body);
    check(`V1-7 no Passport was stored for the ${name} V1 token`, (await store.get('mp:passport:v1:' + tok)) == null);
  }

  // V1-8 no Marketplace entry: even with a Passport planted directly in the store, listing re-reads the chain
  for (const [name, tok] of [['ACTIVE', PONS1], ['LEGACY', PONS1_LEGACY]]) {
    const key = 'mp:passport:v1:' + tok;
    await store.set(key, JSON.stringify({ schema: 'syncnet.passport.v1', token: tok, chainId: 4663, launchpad: 'PONS_V2', factory: PONS_FACTORY, deployer: SELLER, operator: SELLER, claims: [], listing: null, history: [] }));
    for (const fee of [false, true]) {
      const r = await list(tok, SELLER, fee);
      check(`V1-8 ${name} V1 listing (feeRight=${fee}) refused with a planted Passport: 422 unsupported_origin`, r.statusCode === 422 && J(r).code === 'unsupported_origin', r.body);
    }
    await store.del(key);
    const p = await Origins.resolveProject(rpc, tok);
    let refused = false; try { Origins.feeTransferTx(p, tok, BUYER); } catch { refused = true; }
    check(`V1-8 ${name} V1 resolved project cannot build a creator-fee transfer`, refused);
    check(`V1-8 ${name} V1 factory is not a fee-transfer destination`, !Origins.FEE_FACTORIES.includes(p.factory) && Origins.originOfFactory(p.factory) === null);
  }
  const idx = await store.smembers('mp:listings:v1');
  const listed = await Promise.all(idx.map(async (id) => JSON.parse((await store.get('mp:listing:v1:' + id)) || '{}')));
  check('V1-8 no listing in the store is for a V1 token', !listed.some((l) => [PONS1, PONS1_LEGACY].includes(lc(l.token))));

  // V1-9 PAR and Pons V2 detection unchanged (resolved before V1; V1 logic never reclassifies them)
  const par = await Origins.resolveProject(rpc, PAR);
  check('V1-9 PAR launch still resolves as PAR (supported)', par && par.origin === 'PAR' && par.supported === true && Origins.PAR_FACTORIES.includes(par.factory));
  for (const tok of [PONS, PONS_ETH, PONS_CONTRACT, PONS_PENDING]) {
    const v = await Origins.resolveProject(rpc, tok);
    check('V1-9 Pons V2 launch still resolves as PONS_V2 (supported) ' + tok.slice(-4), v && v.origin === 'PONS_V2' && v.supported === true && v.factory === PONS_FACTORY);
  }

  // V1-10 WETH (and a plain ERC-20) remain unsupported
  check('V1-10 WETH → null (unsupported)', (await Origins.resolveProject(rpc, lc(Chain.ROBINHOOD.weth))) === null);
  check('V1-10 USDG → null (unsupported)', (await Origins.resolveProject(rpc, USDG)) === null);
  const r = await claim(lc(Chain.ROBINHOOD.weth), SELLER, 'deployer');
  check('V1-10 WETH claim → generic "not a PAR launch or a Pons V2 launch"', r.statusCode === 422 && J(r).code === 'not_par', r.body);
}

// ================================================================================ no approvals (19)
{
  const src = ['lib/syncnet-origins.js', 'marketplace-v2.js', 'netlify/functions/marketplace.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  check('19 no approve / permit / increaseAllowance anywhere in the Pons path', !/0x095ea7b3|approve\(address|permit\(|increaseAllowance|setApprovalForAll/.test(src));
  check('19 every mocked Pons send was a fee transfer or plain value transfer', chain.sent.every((t) => t.data === '0x' || String(t.data).startsWith(Core.functionSelector('transferCreatorFeeRecipient(address,address)'))));
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/server/marketplace-pons.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} marketplace Pons checks passed`);
process.exit(failures ? 1 : 0);
