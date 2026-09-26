// Project Passport authority regression (PAR and Pons V2 follow the SAME rule).
//   Deployer / current wallet fee-recipient evidence may only ESTABLISH the first Passport. Once a Passport exists,
//   only its recognised operator may claim again (refresh); control changes only through the signed Marketplace
//   transfer (seller TransferIntent + buyer TransferAccept). The creator-fee right — held, retained, received,
//   transferred externally, or overridden by the launchpad — never moves operational control.
// Reproduces the retired takeover (seller sells the Passport, keeps the fee right, re-claims as fee recipient) and
// stress-tests the window between the Passport transfer and an included fee-right transfer. No real network.
// Run: node tests/server/passport-authority.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { A, chain, resetChain, sendTx, signDigest, LAUNCHES, ROOT } from '../e2e/harness.mjs';

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
const MAP = new Map();
const store = { ...createStore({ map: MAP }), durable: true, kind: 'test-durable' };
let ipSeq = 0;
const call = async (method, body, query) => { const r = await mp._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': `198.19.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}` }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: {} }); let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body }; };
const lc = (v) => String(v).toLowerCase();
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const exp = (s) => Math.floor(Date.now() / 1000) + s;
const sg = (k, m, a) => signDigest(a, Market.digest(k, m));
const W = lc(A.WALLET), W2 = lc(A.WALLET2), X = lc(A.ATTACKER), OWNER = lc(A.SAFE_OWNER);
const claim = (token, operator, basis) => { const m = { token, operator, basis, nonce: rnd(), expiry: exp(600) }; return call('POST', { action: 'claim', ...m, signature: sg('OperatorClaim', m, operator) }); };
const passportOf = async (token) => (await call('GET', null, { view: 'passport', token })).j.passport;
resetChain();

// ---- fixtures: every combination on BOTH origins (mutating the mock chain, never the code under test)
const catRow = (i) => LAUNCHES.find((l) => lc(l.token) === '0x8' + String(i).repeat(39));
const PAR_FR = '0x8' + '0'.repeat(39); catRow(0).creatorFeeRecipient = W2; // deployer OTHER_EOA, fee recipient W2 (wallet)
const PAR_SPLIT = '0x8' + '1'.repeat(39); catRow(1).deployer = W; catRow(1).creatorFeeRecipient = W2; // deployer W, recipient W2
const PAR_SAME = lc(A.CREATORLIVE); // deployer = recipient = W
const PAR_SALE = '0x8' + '2'.repeat(39); catRow(2).deployer = W; catRow(2).creatorFeeRecipient = W; // for the sale scenario
const PAR_DEAL = '0x8' + '3'.repeat(39); catRow(3).deployer = W; catRow(3).creatorFeeRecipient = W; // deal-window stress
const ponsAdd = (suffix, rec) => { const t = '0x7a110000000000000000000000000000000000' + suffix; chain.pons.set(t, { pairToken: lc(A.USDG), phase: 0, creatorTaxBps: 100, buyback: false, pending: null, ...rec }); return t; };
const PONS_FR = lc(A.PONS2_ETH); // deployer OTHER_EOA, recipient W2
const PONS_SPLIT = ponsAdd('10', { deployer: W, creatorFeeRecipient: W2 });
const PONS_SAME = lc(A.PONS2); // deployer = recipient = W
const PONS_SALE = ponsAdd('11', { deployer: W, creatorFeeRecipient: W });
const PONS_DEAL = ponsAdd('12', { deployer: W, creatorFeeRecipient: W });
const PONS_OVR = ponsAdd('13', { deployer: W, creatorFeeRecipient: W });
const setRecipient = (token, addr) => { if (chain.pons.has(token)) chain.pons.get(token).creatorFeeRecipient = addr; else LAUNCHES.find((l) => lc(l.token) === token).creatorFeeRecipient = addr; };
const rpc = Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { retries: 0 });

/** Full signed Marketplace sale of the Passport from `seller` to `buyer`. Returns {deal, listing}. */
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
  return { deal: D.j.deal, listing: L.j.listing };
}
async function feeTransfer(token, from, to) {
  const p = await Origins.resolveProject(rpc, token);
  const tx = Origins.feeTransferTx(p, token, to);
  return sendTx({ from, to: tx.to, value: '0x0', data: tx.data });
}

for (const [O, T] of [['PAR', { FR: PAR_FR, SPLIT: PAR_SPLIT, SAME: PAR_SAME, SALE: PAR_SALE, DEAL: PAR_DEAL }], ['PONS_V2', { FR: PONS_FR, SPLIT: PONS_SPLIT, SAME: PONS_SAME, SALE: PONS_SALE, DEAL: PONS_DEAL }]]) {
  // 1. fee recipient can establish the FIRST Passport
  let r = await claim(T.FR, W2, 'fee-recipient');
  check(`${O} 1 current wallet fee recipient establishes the FIRST Passport`, r.s === 200 && r.j.passport.operator === W2 && r.j.passport.launchpad === O, r.body);
  // 2. deployer can establish the FIRST Passport
  r = await claim(T.SAME, W, 'deployer');
  check(`${O} 2 deployer establishes the FIRST Passport`, r.s === 200 && r.j.passport.operator === W, r.body);
  // 3. existing operator can refresh (with its original evidence basis, or as operator)
  r = await claim(T.SAME, W, 'operator');
  check(`${O} 3 existing operator refreshes (basis operator)`, r.s === 200 && r.j.passport.history.at(-1).type === 'operator-claim-refresh', r.body);
  r = await claim(T.SAME, W, 'deployer');
  check(`${O} 3 existing operator refreshes (basis deployer) without changing anything`, r.s === 200 && r.j.passport.operator === W, r.body);
  // 4. a different DEPLOYER cannot supersede the existing operator
  r = await claim(T.SPLIT, W2, 'fee-recipient');
  check(`${O} setup: fee recipient W2 establishes the Passport where W is deployer`, r.s === 200, r.body);
  r = await claim(T.SPLIT, W, 'deployer');
  check(`${O} 4 a different deployer cannot supersede the operator (409 operator_exists)`, r.s === 409 && r.j.code === 'operator_exists' && (await passportOf(T.SPLIT)).operator === W2, r.body);
  // 5. a different FEE RECIPIENT cannot supersede the existing operator
  setRecipient(T.SAME, X);
  r = await claim(T.SAME, X, 'fee-recipient');
  check(`${O} 5 a new on-chain fee recipient cannot supersede the operator`, r.s === 409 && r.j.code === 'operator_exists' && (await passportOf(T.SAME)).operator === W, r.body);
  check(`${O} 5 the refusal writes no history (no operator-superseded)`, !(await passportOf(T.SAME)).history.some((h) => h.type === 'operator-superseded'));
  setRecipient(T.SAME, W);

  // 6. the exploit: seller sells the Passport only, keeps the fee right, then tries to take it back
  r = await claim(T.SALE, W, 'deployer');
  await sellPassport(T.SALE, W, W2, false);
  check(`${O} 8 buyer is operator after the signed Marketplace transfer`, (await passportOf(T.SALE)).operator === W2);
  check(`${O} 6 seller still holds the fee right on-chain (not sold)`, lc((await Origins.resolveProject(rpc, T.SALE)).creatorFeeRecipient) === W);
  for (const basis of ['fee-recipient', 'deployer', 'operator']) {
    r = await claim(T.SALE, W, basis);
    check(`${O} 6 seller cannot reclaim the Passport (basis ${basis})`, (r.s === 409 || r.s === 422) && (await passportOf(T.SALE)).operator === W2, r.body);
  }
  // 7. seller later moves the fee right elsewhere: the new recipient still cannot take the Passport
  const h = await feeTransfer(T.SALE, W, X);
  check(`${O} 7 setup: seller transferred the fee right on-chain to a third wallet`, Boolean(h) && lc((await Origins.resolveProject(rpc, T.SALE)).creatorFeeRecipient) === X);
  r = await claim(T.SALE, X, 'fee-recipient');
  check(`${O} 7 the new fee recipient cannot take the Passport`, r.s === 409 && (await passportOf(T.SALE)).operator === W2, r.body);
  r = await claim(T.SALE, W2, 'operator');
  check(`${O} 8 buyer remains operator and can refresh`, r.s === 200 && r.j.passport.operator === W2, r.body);
  const hist = (await passportOf(T.SALE)).history.map((x) => x.type);
  check(`${O} 8 history is exactly claim → listed → operator-transfer → buyer refresh (no supersession)`, hist.includes('operator-transfer') && !hist.includes('operator-superseded') && hist.at(-1) === 'operator-claim-refresh', hist.join(','));

  // DURING A DEAL: Passport transferred, included fee-right transfer not yet done — seller still the fee recipient
  await claim(T.DEAL, W, 'deployer');
  const { deal } = await sellPassport(T.DEAL, W, W2, true);
  check(`${O} deal-window setup: buyer operator, fee-right step still pending, seller still recipient`, (await passportOf(T.DEAL)).operator === W2 && deal.checklist.feeRight.required === true && lc((await Origins.resolveProject(rpc, T.DEAL)).creatorFeeRecipient) === W);
  for (const basis of ['fee-recipient', 'deployer']) {
    r = await claim(T.DEAL, W, basis);
    check(`${O} deal window: seller cannot reclaim using still-current ${basis} status`, r.s === 409 && (await passportOf(T.DEAL)).operator === W2, r.body);
  }
  const fh = await feeTransfer(T.DEAL, W, W2);
  r = await call('POST', { action: 'fee-right-evidence', dealId: deal.id, txHash: fh });
  check(`${O} deal window: the included fee right then completes normally`, r.s === 200 && r.j.deal.checklist.feeRight.done === true, r.body);
  r = await claim(T.DEAL, W, 'deployer');
  check(`${O} after the deal: seller (deployer) still cannot reclaim`, r.s === 409 && (await passportOf(T.DEAL)).operator === W2, r.body);
}

// 9. Pons protocol override — pending or executed — never changes the Passport operator
{
  await claim(PONS_OVR, W, 'deployer');
  chain.pons.get(PONS_OVR).pending = { newRecipient: X, effectiveAt: exp(3 * 86400), expiresAt: exp(6 * 86400) };
  let r = await claim(PONS_OVR, X, 'fee-recipient');
  check('9 pending Pons override: the proposed recipient has no claim', (r.s === 409 || r.s === 422) && (await passportOf(PONS_OVR)).operator === W, r.body);
  chain.pons.get(PONS_OVR).pending = null; chain.pons.get(PONS_OVR).creatorFeeRecipient = X; // override executed on-chain
  r = await claim(PONS_OVR, X, 'fee-recipient');
  check('9 executed Pons override: the new on-chain recipient cannot take the Passport', r.s === 409 && (await passportOf(PONS_OVR)).operator === W, r.body);
  r = await claim(PONS_OVR, W, 'operator');
  check('9 the recognised operator keeps control and can refresh after the override', r.s === 200 && r.j.passport.operator === W, r.body);
}

// 10. unrelated PAR behaviour unchanged
{
  let r = await claim(lc(A.SYNCAT), W, 'fee-recipient');
  check('10 PAR vault fee recipient still gives no claim (422)', r.s === 422 && r.j.code === 'no_evidence', r.body);
  r = await claim(lc(A.SYNC), X, 'deployer');
  check('10 unrelated wallet still gets 422 no_evidence (not operator_exists)', r.s === 422 && r.j.code === 'no_evidence', r.body);
  r = await claim(lc(A.USDG), W, 'deployer');
  check('10 non-launch token still 422 not_par', r.s === 422 && /not a PAR launch/.test(r.j.error), r.body);
  const m = { token: PAR_SAME, operator: W, basis: 'operator', nonce: rnd(), expiry: exp(600) };
  r = await call('POST', { action: 'claim', ...m, signature: sg('OperatorClaim', m, X) });
  check('10 signature checks still come first (401 for a wrong signer)', r.s === 401, r.body);
}

// 11. historical records (including legacy operator-superseded entries) stay readable, grant nothing new
{
  const T = lc(A.PONS2_CONTRACT);
  const legacy = { schema: 'syncnet.passport.v1', token: T, chainId: 4663, factory: Origins.PONS_V2_FACTORY, deployer: W, operator: OWNER, operatorSince: '2026-09-20T00:00:00.000Z', claims: [], listing: null,
    history: [{ type: 'operator-claim', operator: W, basis: 'deployer', at: '2026-09-19T00:00:00.000Z' }, { type: 'operator-superseded', from: W, to: OWNER, basis: 'fee-recipient', evidence: 'wallet is the current on-chain creator-fee recipient', at: '2026-09-20T00:00:00.000Z' }], createdAt: '', updatedAt: '' };
  const raw = JSON.stringify(legacy);
  MAP.set('mp:passport:v1:' + T, { type: 'string', value: raw, expiresAt: null });
  const p = await passportOf(T);
  const sup = p.history.find((h) => h.type === 'operator-superseded');
  check('11 legacy record readable: operator as recorded, both history entries present', p.operator === OWNER && p.history.length === 2);
  check('11 legacy operator-superseded entry is annotated as conferring no authority', sup.legacy === true && /grants no authority/.test(sup.note));
  check('11 the stored record is untouched (no rewrite, no migration)', MAP.get('mp:passport:v1:' + T).value === raw);
  check('11 recordHash is still computed over the untouched stored history', p.recordHash === Market.hashJson({ token: T, operator: OWNER, history: legacy.history }));
  const r = await claim(T, W, 'deployer');
  check('11 the superseded former operator gains nothing from the legacy entry (409)', r.s === 409 && (await passportOf(T)).operator === OWNER, r.body);
}

// source-level guarantee: the takeover branch no longer exists
{
  const src = fs.readFileSync(path.join(ROOT, 'netlify/functions/marketplace.js'), 'utf8');
  check('no code path writes an operator-superseded entry anymore', !/type: 'operator-superseded'/.test(src));
  check('existing-operator refusal happens before the nonce is consumed', src.indexOf("if (passport && lc(passport.operator) !== operator)") < src.indexOf("if (!(await consumeNonce(store, operator, b.nonce))) return publicError(409, 'replay', 'This nonce was already used.');\n    const claim ="));
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/server/passport-authority.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} passport authority checks passed`);
process.exit(failures ? 1 : 0);
