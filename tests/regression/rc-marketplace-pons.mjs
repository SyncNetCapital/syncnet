// Marketplace × Pons V2 — browser walkthrough against the REAL /api/marketplace and the mock chain (exact Pons ABI):
//   CHECK PROJECT auto-detects PONS V2 / PAR / PONS V1 / unsupported → Pons deployer claims the Passport →
//   listing with the creator-fee right → LIVE PONS PROJECT badge + verified PAIR/STATUS → ALL/PAR/PONS filter →
//   pending protocol override disables the fee right → Deal Room fee transfer goes ONLY to the canonical Pons V2
//   factory with calldata bound to token + buyer → server re-read verifies it → Pons Project Page.
// Screenshots: set PONS_SHOTS=<dir>. Run: node tests/regression/rc-marketplace-pons.mjs
import { startServer, installRoutes, A, chain, resetChain, resetServer, signDigest, Core, ROOT } from '../e2e/harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));
const require = createRequire(import.meta.url);
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));

const PORT = 8953, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.PONS_SHOTS || '';
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const lc = (v) => String(v).toLowerCase();
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
const exp = (s) => Math.floor(Date.now() / 1000) + s;
const PONS = lc(A.PONS2), SELLER = lc(A.WALLET), BUYER = lc(A.WALLET2);
const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const api = async (body) => { const r = await mp._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.7.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250) }, body: JSON.stringify(body) }); return { status: r.statusCode, j: JSON.parse(r.body) }; };
const sign = (kind, m, as) => signDigest(as, Market.digest(kind, m));

const srv = await startServer(PORT);
resetChain(); resetServer();
const browser = await chromium.launch();
async function newCtx(account, width = 1280) {
  const c = await browser.newContext({ viewport: { width, height: 950 } });
  await installRoutes(c);
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e))); page.on('dialog', (d) => { page.__dialogs = (page.__dialogs || []).concat(d.message()); d.accept(); });
  if (account) await page.addInitScript((a) => { window.__mockAccount = a; }, account);
  return { c, page };
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const wait = (page, fn, arg, t = 20000) => page.waitForFunction(fn, arg, { timeout: t });
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
async function checkToken(page, token) {
  await page.fill('#mpToken', token); await page.click('#mpCheckProject');
  await wait(page, () => !/Reading the canonical/.test(document.getElementById('mpClaimStatus').textContent));
  return text(page, '#mpClaimStatus');
}

const S = await newCtx();
await S.page.goto(BASE + '/marketplace.html'); await S.page.waitForTimeout(800);
{
  const body = await S.page.evaluate(() => document.body.innerText);
  check('framing: SUPPORTED ORIGINS · PAR · PONS V2, no endorsement implied', /SUPPORTED ORIGINS · PAR · PONS V2/.test(body) && /No partnership with or endorsement/.test(body));
  check('framing: no "all projects" claim', !/all projects/i.test(body));
}

// ================================================================= detection (auto, never chosen)
{
  await S.page.click('#mpConnect'); await S.page.waitForTimeout(200);
  await S.page.click('[data-mp-view="sell"]');
  check('no launchpad selector exists — the user only pastes a token', !(await S.page.$('select#mpLaunchpad, [name="launchpad"]')));
  let st = await checkToken(S.page, A.USDG);
  check('3 random ERC-20 → UNSUPPORTED PROJECT', /UNSUPPORTED PROJECT/.test(st), st);
  st = await checkToken(S.page, A.PONS1);
  check('Pons V1 → PONS V1 DETECTED · not supported (no "yet")', /PONS V1 DETECTED/.test(st) && /not supported by the Marketplace/.test(st) && !/\byet\b/.test(st), st);
  st = await checkToken(S.page, A.PONS1_LEGACY);
  check('Pons V1 (LEGACY factory) → PONS V1 DETECTED · not supported, no claim step', /PONS V1 DETECTED/.test(st) && !/Evidence found/.test(st), st);
  st = await checkToken(S.page, A.CREATORLIVE);
  const parFacts = await text(S.page, '#mpClaimFacts');
  check('1 PAR project → DETECTED PAR, facts unchanged', /PAR · ON-CHAIN VERIFIED/.test(parFacts) && /EXISTS · multi factory/.test(parFacts) && /Evidence found/.test(st), parFacts.slice(0, 200));
  st = await checkToken(S.page, A.PONS2);
  const facts = await text(S.page, '#mpClaimFacts');
  check('2 Pons V2 project → DETECTED PONS V2 · ON-CHAIN VERIFIED', /PONS V2 · ON-CHAIN VERIFIED/.test(facts) && facts.includes(PONS_FACTORY), facts.slice(0, 200));
  check('2 verified Pons facts: pair USDG, BONDING CURVE, creator tax 2%', /USDG/.test(facts) && /BONDING CURVE/.test(facts) && /2%/.test(facts));
  check('5 deployer evidence names the Pons V2 factory record', /deployer \(Pons V2 factory record\)/.test(st), st);
  await shot(S.page, 'pons-01-detected');
}

// ================================================================= claim + list (5, 9, 10)
let LISTING_ID = '';
{
  await S.page.click('#mpSignClaim');
  await wait(S.page, () => /recorded ✓/.test(document.getElementById('mpClaimStatus').textContent));
  check('5 Pons Passport claimed with one free signature (no transaction)', !(await S.page.evaluate(() => (window.__walletCalls || []).includes('eth_sendTransaction'))));
  await S.page.fill('#mpPrice', '1.2');
  await S.page.fill('#mpDescription', 'Live Pons V2 project with an engaged community and a working site, ready for a new operator.');
  await wait(S.page, () => !document.getElementById('mpIncludeFee').disabled);
  check('8 fee right offerable: the live Pons factory names the seller wallet', /YOUR WALLET IS THE RECIPIENT/.test(await text(S.page, '#mpFeeRowState')));
  await S.page.check('#mpIncludeFee');
  await S.page.click('#mpCreateListing');
  await wait(S.page, () => location.hash.startsWith('#listing=')); await S.page.waitForTimeout(700);
  LISTING_ID = await S.page.evaluate(() => location.hash.slice('#listing='.length));
  const d = await text(S.page, '#mpDetail');
  check('9/10 Pons listing shows LIVE PONS PROJECT, PAIR · USDG, STATUS · BONDING CURVE', /LIVE PONS PROJECT/.test(d) && /PAIR · USDG/.test(d) && /STATUS · BONDING CURVE/.test(d) && /CREATOR FEE TRANSFERABLE/.test(d), d.slice(0, 300));
  check('what is NOT sold names Pons reserves/liquidity and protocol control', /Bonding-curve reserves and locked Pons liquidity/.test(d) && /Pons protocol control/.test(d));
  await shot(S.page, 'pons-02-listing');
}

// ================================================================= pending override disables the fee right (16)
{
  await S.page.click('[data-mp-view="sell"]');
  await checkToken(S.page, A.PONS2_PENDING);
  const facts = await text(S.page, '#mpClaimFacts');
  check('16 pending override is shown with its recipient and window', /PONS PROTOCOL OVERRIDE/.test(facts) && facts.includes(lc(A.ATTACKER)), facts.slice(0, 300));
  await S.page.click('#mpSignClaim');
  await wait(S.page, () => /recorded ✓/.test(document.getElementById('mpClaimStatus').textContent));
  check('16 fee-right checkbox disabled and labelled ENCUMBERED', await S.page.$eval('#mpIncludeFee', (e) => e.disabled) && /ENCUMBERED/.test(await text(S.page, '#mpFeeRowState')));
}

// ================================================================= one shared market + filter (11), PAR listing (1)
{
  let r = await api((() => { const m = { token: lc(A.CREATORLIVE), operator: SELLER, basis: 'deployer', nonce: rnd(), expiry: exp(600) }; return { action: 'claim', ...m, signature: sign('OperatorClaim', m, SELLER) }; })());
  const t = Market.normalizeTerms({ description: 'A PAR project listed next to Pons ones in the same market.', included: [], notIncluded: [], includeFeeRight: false }).terms;
  const lm = { token: lc(A.CREATORLIVE), seller: SELLER, price: '3', currency: 'ETH', termsHash: Market.hashJson(t), nonce: rnd(), expiry: exp(86400) };
  r = await api({ action: 'list', ...lm, terms: t, signature: sign('Listing', lm, SELLER) });
  check('setup: a PAR listing in the same market', r.status === 200, JSON.stringify(r.j).slice(0, 200));
  await S.page.goto(BASE + '/marketplace.html'); await S.page.waitForTimeout(1200);
  const cards = async () => S.page.$$eval('#mp-listings .mp-listing-card', (xs) => xs.map((x) => x.innerText));
  let all = await cards();
  check('11 ALL shows PAR and PONS listings together', all.some((c) => /LIVE PONS PROJECT/.test(c)) && all.some((c) => /LIVE PAR PROJECT/.test(c)), all.length);
  await S.page.click('[data-mp-origin="PAR"]'); await S.page.waitForTimeout(600);
  let only = await cards();
  check('11 PAR filter shows only PAR', only.length > 0 && only.every((c) => /LIVE PAR PROJECT/.test(c)));
  await S.page.click('[data-mp-origin="PONS_V2"]'); await S.page.waitForTimeout(600);
  only = await cards();
  check('11 PONS filter shows only Pons', only.length > 0 && only.every((c) => /LIVE PONS PROJECT/.test(c)));
  check('11 filter state is announced (aria-pressed)', await S.page.$eval('[data-mp-origin="PONS_V2"]', (e) => e.getAttribute('aria-pressed') === 'true'));
  await shot(S.page, 'pons-03-browse-pons-filter');
  await S.page.click('[data-mp-origin="ALL"]'); await S.page.waitForTimeout(400);
}

// ================================================================= deal: fee right goes ONLY to the Pons factory (12-14)
{
  const lst = (await mp._handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { view: 'listing', id: LISTING_ID } }));
  const L = JSON.parse(lst.body).listing;
  const om = { listingId: L.id, termsHash: L.termsHash, token: PONS, buyer: BUYER, amount: '1.2', currency: 'ETH', nonce: rnd(), expiry: exp(86400) };
  let r = await api({ action: 'offer', ...om, signature: sign('Offer', om, BUYER) });
  const dm = { offerId: r.j.offer.id, listingId: L.id, seller: SELLER, decision: 'accept', nonce: rnd() };
  r = await api({ action: 'offer-decision', ...dm, signature: sign('OfferDecision', dm, SELLER) });
  const DEAL = r.j.deal.id;
  await S.page.goto(BASE + '/marketplace.html#deal=' + DEAL); await S.page.waitForTimeout(1200);
  const room = await text(S.page, '#mpDeal');
  check('Deal Room names the PONS V2 factory for the fee-right step', /PONS V2’s own/.test(room) && /to the PONS V2 factory/.test(room), room.slice(0, 300));
  const before = chain.sent.length;
  await S.page.click('[data-act="fee-send"]');
  await wait(S.page, () => /Verified: the PONS V2 factory now names the buyer/.test(document.getElementById('mpDeal').textContent), null, 25000);
  const sent = chain.sent.slice(before);
  const tx = sent[sent.length - 1];
  const [tok, rcp] = Core.abiDecode(['address', 'address'], '0x' + String(tx.data).slice(10));
  check('12 exactly one wallet transaction, sent to the canonical Pons V2 factory', sent.length === 1 && lc(tx.to) === PONS_FACTORY && BigInt(tx.value || 0) === 0n, JSON.stringify(sent).slice(0, 300));
  check('13 calldata = transferCreatorFeeRecipient(deal token, deal buyer)', String(tx.data).startsWith(Core.functionSelector('transferCreatorFeeRecipient(address,address)')) && lc(tok) === PONS && lc(rcp) === BUYER);
  check('12 the confirmation shown to the seller names the Pons V2 factory address', (S.page.__dialogs || []).some((m) => m.includes('PONS V2 factory ' + PONS_FACTORY)));
  check('14 server re-read verified it: CREATOR-FEE RIGHT step VERIFIED ON-CHAIN', /VERIFIED ON-CHAIN/.test(await text(S.page, '#mpDeal')) && lc(chain.pons.get(PONS).creatorFeeRecipient) === BUYER);
  check('19 no approval / permit was ever requested from the wallet', !(await S.page.evaluate(() => (window.__walletCalls || []).some((m) => /approve|permit/i.test(m)))));
  await shot(S.page, 'pons-04-deal-fee-verified');
}

// ================================================================= Project Page for Pons (extended, not hidden)
{
  const P = await newCtx(BUYER);
  await P.page.goto(BASE + '/project/' + PONS + '#details'); await P.page.waitForTimeout(3000);
  const card = await text(P.page, '#tokenCard');
  check('Project Page: PONS V2 LAUNCH · FACTORY RECORD ON-CHAIN (not "not a PAR launch")', /PONS V2 LAUNCH · FACTORY RECORD ON-CHAIN/.test(card) && !/NOT VERIFIED AS A PAR LAUNCH/.test(card), card.slice(0, 300));
  check('Project Page: origin, pair, status, contract, Passport operator shown', /PONS V2 · ON-CHAIN VERIFIED/.test(card) && /USDG/.test(card) && /BONDING CURVE/.test(card) && card.includes(PONS) && /SYNCNET OPERATOR/.test(card));
  check('Project Page: the listing is linked with its real status (in a deal → OFFER ACCEPTED, not "for sale")', /LISTING · OFFER ACCEPTED/.test(card) && !/FOR SALE/.test(card) && Boolean(await P.page.$('#tokenCard a[href^="/marketplace.html#listing="]')));
  check('Project Page: no PAR analytics or PAR builder action for Pons', !/Direct markets · read from the PAR factory/.test(card) && !(await P.page.$('#tokenCard a[href^="/build.html?with="]')));
  check('J Project Page: no PAR-indexer-derived market/project counts for Pons', !/using this contract as a market/i.test(card) && !/PAR launches using/i.test(card) && !/\(indexer\)/i.test(card) && !/NETWORK HUB/.test(card), card.slice(0, 400));
  check('Project Page: no page errors', P.page.__errors.length === 0, P.page.__errors.join(' | '));
  await shot(P.page, 'pons-05-project-page');
  await P.page.goto(BASE + '/project/' + lc(A.CREATORLIVE) + '#details'); await P.page.waitForTimeout(2500);
  check('1 PAR Project Page unchanged (PAR LAUNCH · FACTORY RECORD ON-CHAIN)', /PAR LAUNCH · FACTORY RECORD ON-CHAIN/.test(await text(P.page, '#tokenCard')));
  check('J PAR Project Page keeps its indexer facts (Projects using this token as a market)', /Projects using this token as a market/i.test(await text(P.page, '#tokenCard')));
  for (const [tok, re, name] of [[A.PONS1, /PONS V1 LAUNCH · FACTORY RECORD ON-CHAIN/, 'ACTIVE'], [A.PONS1_LEGACY, /PONS V1 LAUNCH · LEGACY FACTORY RECORD ON-CHAIN/, 'LEGACY']]) {
    await P.page.goto(BASE + '/project/' + lc(tok) + '#details'); await P.page.waitForTimeout(2500);
    const v1card = await text(P.page, '#tokenCard');
    check(`Project Page: Pons V1 (${name}) recognised truthfully, not "not a PAR launch"`, re.test(v1card) && !/NOT VERIFIED AS A PAR LAUNCH/.test(v1card) && !/could not verify this contract as a PAR launch/.test(v1card), v1card.slice(0, 300));
    check(`Project Page: Pons V1 (${name}) explains it is recognised but not supported (no Passport / listing)`, /earlier-generation Pons launch/.test(v1card) && /does not support this launch generation/.test(v1card) && (name === 'LEGACY') === /legacy Pons V1 factory/.test(v1card), v1card.slice(0, 400));
    check(`Project Page: Pons V1 (${name}) offers no Passport / listing / PAR builder action`, !/SYNCNET OPERATOR VERIFIED/.test(v1card) && !(await P.page.$('#tokenCard a[href^="/marketplace.html#listing="]')) && !(await P.page.$('#tokenCard a[href^="/build.html?with="]')), v1card.slice(0, 300));
  }
  await P.c.close();
}
check('no page errors in the seller browser', S.page.__errors.length === 0, S.page.__errors.join(' | '));

// ================================================================= mobile
{
  const M = await newCtx(null, 390);
  await M.page.goto(BASE + '/marketplace.html'); await M.page.waitForTimeout(1200);
  const over = await M.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('mobile 390px: marketplace with filter + Pons cards has no horizontal overflow', over <= 1, 'overflow ' + over);
  await shot(M.page, 'pons-06-mobile');
  await M.c.close();
}

await S.c.close(); await browser.close(); srv.close();
const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-marketplace-pons.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} marketplace Pons walkthrough checks passed`);
process.exit(failures ? 1 : 0);
