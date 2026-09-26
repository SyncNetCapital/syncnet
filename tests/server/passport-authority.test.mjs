// Project Passport authority regression (security fix).
//   Deployer / current wallet fee-recipient evidence may only ESTABLISH the first Passport. Once a Passport exists,
//   only its recognised operator may claim again (refresh); control changes only through the signed Marketplace
//   transfer (seller TransferIntent + buyer TransferAccept). Holding, keeping or receiving the creator-fee right never
//   moves operational control. Reproduces the retired takeover (seller sells the Passport, keeps the fee right,
//   re-claims as fee recipient) and the window between the Passport transfer and an included fee-right transfer.
// Mock chain = e2e harness. No real network. Run: node tests/server/passport-authority.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { A, resetChain, sendTx, signDigest, LAUNCHES, Core, ROOT } from '../e2e/harness.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));
const MAP = new Map();
const store = { ...createStore({ map: MAP }), durable: true, kind: 'test-durable' };
let ipSeq = 0;
const call = async (method, body, query) => { const r = await mp._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': `198.19.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: {} }); let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body }; };
const lc = (v) => String(v).toLowerCase();
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const exp = (s) => Math.floor(Date.now() / 1000) + s;
const sg = (k, m, a) => signDigest(a, Market.digest(k, m));
const W = lc(A.WALLET), W2 = lc(A.WALLET2), X = lc(A.ATTACKER), OWNER = lc(A.SAFE_OWNER);
const claim = (token, operator, basis, nonce = rnd()) => { const m = { token, operator, basis, nonce, expiry: exp(600) }; return call('POST', { action: 'claim', ...m, signature: sg('OperatorClaim', m, operator) }); };
const passportOf = async (token) => (await call('GET', null, { view: 'passport', token })).j.passport;
const FACTORY = lc(Chain.ROBINHOOD.multiFactory);
resetChain();

// fixtures on the mock chain (PAR launches): deployer / fee-recipient combinations
const row = (i) => LAUNCHES.find((l) => lc(l.token) === '0x8' + String(i).repeat(39));
const T_FR = '0x8' + '0'.repeat(39); row(0).creatorFeeRecipient = W2; // deployer OTHER_EOA, recipient W2 (wallet)
const T_SPLIT = '0x8' + '1'.repeat(39); row(1).deployer = W; row(1).creatorFeeRecipient = W2;
const T_SAME = lc(A.CREATORLIVE); // deployer = recipient = W
const T_SALE = '0x8' + '2'.repeat(39); row(2).deployer = W; row(2).creatorFeeRecipient = W;
const T_DEAL = '0x8' + '3'.repeat(39); row(3).deployer = W; row(3).creatorFeeRecipient = W;
const T_NONCE = '0x8' + '4'.repeat(39); row(4).deployer = W; row(4).creatorFeeRecipient = W;
const setRecipient = (t, a) => { LAUNCHES.find((l) => lc(l.token) === t).creatorFeeRecipient = a; };
const recipientOf = async (t) => lc((await Chain.readLaunch(Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { retries: 0 }), t)).creatorFeeRecipient);
const feeTransfer = (t, from, to) => sendTx({ from, to: FACTORY, value: '0x0', data: Core.functionSelector('transferCreatorFeeRecipient(address,address)') + Core.abiEncode(['address', 'address'], [t, to]).slice(2) });

async function sellPassport(token, seller, buyer, includeFeeRight) {
  const t = Market.normalizeTerms({ description: 'Operational control of this project' + (includeFeeRight ? ' with the creator-fee right.' : ', creator-fee right NOT included.'), included: [], notIncluded: [], includeFeeRight }).terms;
  const lm = { token, seller, price: '1', currency: 'USD', termsHash: Market.hashJson(t), nonce: rnd(), expiry: exp(86400) };
  const L = await call('POST', { action: 'list', ...lm, terms: t, signature: sg('Listing', lm, seller) });
  if (L.s !== 200) throw new Error('list failed ' + L.body);
  const om = { listingId: L.j.listing.id, termsHash: L.j.listing.termsHash, token, buyer, amount: '1', currency: 'USD', nonce: rnd(), expiry: exp(86400) };
  const O = await call('POST', { action: 'offer', ...om, signature: sg('Offer', om, buyer) });
  const dm = { offerId: O.j.offer.id, listingId: L.j.listing.id, seller, decision: 'accept', nonce: rnd() };
  const D = await call('POST', { action: 'offer-decision', ...dm, signature: sg('OfferDecision', dm, seller) });
  const im = { dealId: D.j.deal.id, token, from: seller, to: buyer, nonce: rnd(), expiry: exp(3600) };
  await call('POST', { action: 'transfer-intent', ...im, signature: sg('TransferIntent', im, seller) });
  const am = { dealId: D.j.deal.id, token, from: seller, to: buyer, intentHash: Market.digest('TransferIntent', im), nonce: rnd(), expiry: exp(3600) };
  const acc = await call('POST', { action: 'transfer-accept', ...am, signature: sg('TransferAccept', am, buyer) });
  if (acc.s !== 200) throw new Error('transfer-accept failed ' + acc.body);
  return { deal: D.j.deal };
}

// EIP-712 unchanged: vectors pinned from lib/syncnet-market.js at 6d067d5 (any change would invalidate signatures)
{
  check('EIP-712 domain unchanged', JSON.stringify(Market.DOMAIN) === JSON.stringify({ name: 'SyncNet Marketplace', version: '1', chainId: 4663 }));
  check('EIP-712 OperatorClaim digest vector unchanged', Market.digest('OperatorClaim', { token: '0x' + '11'.repeat(20), operator: '0x' + '22'.repeat(20), basis: 'deployer', nonce: '0x' + '33'.repeat(32), expiry: 1790000000 }) === '0x7790d95fb4c12e0286633a25084dec49b1c631496b35d950c4cd5d21168e3f64');
  check('EIP-712 Listing digest vector unchanged', Market.digest('Listing', { token: '0x' + '11'.repeat(20), seller: '0x' + '22'.repeat(20), price: '1.5', currency: 'ETH', termsHash: '0x' + '44'.repeat(32), nonce: '0x' + '33'.repeat(32), expiry: 1790000000 }) === '0xbe3068bae2eb1eb8b576dffee6ee02386e5886dda9349dd0afa5781e607d6e5a');
}

// first Passport, refresh, no supersession
{
  let r = await claim(T_FR, W2, 'fee-recipient');
  check('first Passport via the current wallet creator-fee recipient', r.s === 200 && r.j.passport.operator === W2 && r.j.passport.claims[0].evidence === 'wallet is the current on-chain creator-fee recipient', r.body);
  r = await claim(T_SAME, W, 'deployer');
  check('first Passport via the on-chain deployer (evidence text unchanged)', r.s === 200 && r.j.passport.operator === W && r.j.passport.claims[0].evidence === 'wallet is the on-chain deployer (PAR factory record)', r.body);
  r = await claim(T_SAME, W, 'operator');
  check('current operator refresh (basis operator)', r.s === 200 && r.j.passport.history.at(-1).type === 'operator-claim-refresh', r.body);
  r = await claim(T_SAME, W, 'deployer');
  check('current operator refresh with its deployer evidence', r.s === 200 && r.j.passport.operator === W, r.body);
  r = await claim(T_SPLIT, W2, 'fee-recipient');
  r = await claim(T_SPLIT, W, 'deployer');
  check('a different deployer cannot reclaim an existing Passport (409 operator_exists)', r.s === 409 && r.j.code === 'operator_exists' && (await passportOf(T_SPLIT)).operator === W2, r.body);
  setRecipient(T_SAME, X);
  r = await claim(T_SAME, X, 'fee-recipient');
  check('a new creator-fee recipient cannot reclaim an existing Passport (409)', r.s === 409 && r.j.code === 'operator_exists' && (await passportOf(T_SAME)).operator === W, r.body);
  check('refusals write nothing (no operator-superseded entry)', !(await passportOf(T_SAME)).history.some((h) => h.type === 'operator-superseded'));
  setRecipient(T_SAME, W);
}

// the exploit: sell the Passport only, keep the fee right, try to take it back
{
  await claim(T_SALE, W, 'deployer');
  await sellPassport(T_SALE, W, W2, false);
  check('buyer is operator after the signed Marketplace transfer', (await passportOf(T_SALE)).operator === W2);
  check('seller still holds the (unsold) fee right on-chain', (await recipientOf(T_SALE)) === W);
  for (const basis of ['fee-recipient', 'deployer', 'operator']) {
    const r = await claim(T_SALE, W, basis);
    check(`seller who kept the fee right cannot reclaim (basis ${basis})`, (r.s === 409 || r.s === 422) && (await passportOf(T_SALE)).operator === W2, r.body);
  }
  await feeTransfer(T_SALE, W, X);
  check('setup: seller later moved the fee right to a third wallet', (await recipientOf(T_SALE)) === X);
  let r = await claim(T_SALE, X, 'fee-recipient');
  check('the new fee recipient cannot take the Passport either', r.s === 409 && (await passportOf(T_SALE)).operator === W2, r.body);
  r = await claim(T_SALE, W2, 'operator');
  check('buyer remains operator and can refresh', r.s === 200 && r.j.passport.operator === W2, r.body);
  const hist = (await passportOf(T_SALE)).history.map((h) => h.type);
  check('history: operator-transfer present, no operator-superseded', hist.includes('operator-transfer') && !hist.includes('operator-superseded'), hist.join(','));
}

// during a deal: Passport transferred, included fee-right transfer not yet completed
{
  await claim(T_DEAL, W, 'deployer');
  const { deal } = await sellPassport(T_DEAL, W, W2, true);
  check('deal window setup: buyer operator, fee-right step pending, seller still recipient', (await passportOf(T_DEAL)).operator === W2 && deal.checklist.feeRight.required && (await recipientOf(T_DEAL)) === W);
  for (const basis of ['fee-recipient', 'deployer']) {
    const r = await claim(T_DEAL, W, basis);
    check(`deal window: seller cannot reclaim with still-current ${basis} status`, r.s === 409 && (await passportOf(T_DEAL)).operator === W2, r.body);
  }
  const h = await feeTransfer(T_DEAL, W, W2);
  const r = await call('POST', { action: 'fee-right-evidence', dealId: deal.id, txHash: h });
  check('deal window: the included fee right then settles normally (unchanged behaviour)', r.s === 200 && r.j.deal.checklist.feeRight.done === true, r.body);
}

// a rejected takeover does not consume the nonce
{
  await claim(T_NONCE, W, 'deployer');
  await sellPassport(T_NONCE, W, W2, false);
  const N = rnd();
  const r = await claim(T_NONCE, W, 'fee-recipient', N);
  check('rejected takeover answers 409 operator_exists', r.s === 409 && r.j.code === 'operator_exists', r.body);
  check('rejected takeover did not consume the nonce (no nonce record written)', !MAP.has(`mp:nonce:v1:${W}:${N}`));
  const t = Market.normalizeTerms({ description: 'Another project of the same wallet, listed with the same nonce.', included: [], notIncluded: [], includeFeeRight: false }).terms;
  await claim(T_SAME, W, 'operator');
  const lm = { token: T_SAME, seller: W, price: '2', currency: 'USD', termsHash: Market.hashJson(t), nonce: N, expiry: exp(86400) };
  const L = await call('POST', { action: 'list', ...lm, terms: t, signature: sg('Listing', lm, W) });
  check('the same nonce is still usable for a later legitimate action', L.s === 200, L.body);
}

// unrelated behaviour unchanged
{
  let r = await claim(lc(A.SYNCAT), W, 'fee-recipient');
  check('PAR vault fee recipient still gives no claim (422 no_evidence)', r.s === 422 && r.j.code === 'no_evidence', r.body);
  r = await claim(lc(A.SYNC), X, 'deployer');
  check('unrelated wallet still 422 no_evidence', r.s === 422 && r.j.code === 'no_evidence', r.body);
  r = await claim(lc(A.USDG), W, 'deployer');
  check('non-PAR token still 422 not_par', r.s === 422 && /not a PAR launch/.test(r.j.error), r.body);
  const m = { token: T_SAME, operator: W, basis: 'operator', nonce: rnd(), expiry: exp(600) };
  r = await call('POST', { action: 'claim', ...m, signature: sg('OperatorClaim', m, X) });
  check('signature check still first (401 for a wrong signer)', r.s === 401, r.body);
}

// historical records stay readable; legacy supersession grants nothing
{
  const T = lc(A.PONS);
  const legacy = { schema: 'syncnet.passport.v1', token: T, chainId: 4663, factory: FACTORY, deployer: W, operator: OWNER, operatorSince: '2026-09-20T00:00:00.000Z', claims: [], listing: null,
    history: [{ type: 'operator-claim', operator: W, basis: 'deployer', at: '2026-09-19T00:00:00.000Z' }, { type: 'operator-superseded', from: W, to: OWNER, basis: 'fee-recipient', evidence: 'wallet is the current on-chain creator-fee recipient', at: '2026-09-20T00:00:00.000Z' }], createdAt: '', updatedAt: '' };
  const raw = JSON.stringify(legacy);
  MAP.set('mp:passport:v1:' + T, { type: 'string', value: raw, expiresAt: null });
  const p = await passportOf(T);
  const sup = p.history.find((h) => h.type === 'operator-superseded');
  check('historical record readable: operator as recorded, full history present', p.operator === OWNER && p.history.length === 2);
  check('historical operator-superseded entry annotated as granting no authority', sup.legacy === true && /grants no authority/.test(sup.note));
  check('stored record untouched (no rewrite, no migration)', MAP.get('mp:passport:v1:' + T).value === raw);
  check('recordHash still over the untouched stored history', p.recordHash === Market.hashJson({ token: T, operator: OWNER, history: legacy.history }));
}

// source-level guarantees
{
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/marketplace.js'), 'utf8');
  check('no code path writes an operator-superseded entry', !/type: 'operator-superseded'/.test(src));
  check('existing-operator refusal precedes nonce consumption', src.indexOf('if (passport && lc(passport.operator) !== operator)') > 0 && src.indexOf('if (passport && lc(passport.operator) !== operator)') < src.indexOf("if (!(await consumeNonce(store, operator, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');\n    const claim ="));
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/server/passport-authority.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} passport authority checks passed`);
process.exit(failures ? 1 : 0);
