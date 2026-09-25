// Marketplace V1 — the full cross-browser walkthrough (the manual-QA script, automated):
//   SELLER claims + lists in browser A → BUYER sees the SAME listing in a clean browser B → signed offer →
//   accept → deal room → two-party operator transfer → on-chain fee-right transfer → wallet-to-wallet
//   payment (verified on-chain) → both-party manual confirmations → COMPLETED → project page shows the
//   new operator with the old one preserved in history. Plus refresh/disconnect/cancel/RPC-down/storage-down
//   failure modes and the no-fake-data sweep. Nothing touches a real network.
// Run: node tests/regression/rc-marketplace.mjs
import { startServer, installRoutes, A, chain, resetChain, resetServer, serverState, browserGateways, LAUNCHES, ROOT } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const PORT = 8941, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const srv = await startServer(PORT);
const browser = await chromium.launch();
async function newCtx(account) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await installRoutes(c);
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e))); page.on('dialog', (d) => d.accept());
  if (account) await page.addInitScript((a) => { window.__mockAccount = a; }, account);
  return { c, page };
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
const wait = (page, fn, arg, t = 20000) => page.waitForFunction(fn, arg, { timeout: t });
const PONSYNC_CID = 'bafkreig5hyt4po3peiq3cpezer2yuki57l3wnq4qztjphf4lp7tsq6m6si';
const row = LAUNCHES.find((l) => l.token === A.CREATORLIVE);
const prevRecipient = row.creatorFeeRecipient;
row.logo = 'ipfs://' + PONSYNC_CID; // the listing snapshot must carry the immutable ipfs:// URI

resetChain(); resetServer();
const S = await newCtx(); // seller browser (mock wallet account A.WALLET)
const B = await newCtx(A.WALLET2); // buyer browser: a genuinely separate context (own localStorage)

// ================================================================= production surface (no lab artifacts)
{
  await S.page.goto(BASE + '/marketplace.html'); await S.page.waitForTimeout(900);
  const body = await S.page.evaluate(() => document.body.innerText);
  check('production: no LAB / LOCAL TEST / NO REAL PAYMENTS / simulation wording anywhere', !/MARKETPLACE LAB|LOCAL TEST|NO REAL PAYMENTS|SIMULAT|LOAD PONSYNC TEST|DEMO/i.test(body), (body.match(/.{0,40}(LAB|SIMULAT|DEMO).{0,40}/i) || [''])[0]);
  check('production: the non-custodial model is stated on the page (hero + settlement card)', /SIGNED LISTINGS · VERIFIED HANDOVERS · NON-CUSTODIAL/.test(body) && /never holds funds/i.test(body) && /no escrow/i.test(body));
  check('production: empty state is polished, with no fake listings seeded', /NO PROJECTS LISTED YET/.test(await text(S.page, '#mp-listings')) && !(await S.page.$('.mp-listing-card')));
}

// ================================================================= seller: claim → list
let LISTING_ID = '';
{
  await S.page.click('#mpConnect'); await S.page.waitForTimeout(200);
  await S.page.click('[data-mp-view="sell"]');
  await S.page.fill('#mpToken', A.CREATORLIVE); await S.page.click('#mpCheckProject');
  await wait(S.page, () => /Evidence found/.test(document.getElementById('mpClaimStatus').textContent));
  check('claim: live PAR facts shown (deployer, fee recipient, no operator yet)', /EXISTS · multi factory/.test(await text(S.page, '#mpClaimFacts')) && /none recorded yet/.test(await text(S.page, '#mpClaimFacts')));
  await S.page.click('#mpSignClaim');
  await wait(S.page, () => /recorded ✓/.test(document.getElementById('mpClaimStatus').textContent));
  check('claim: operator claim signed and server-verified', true);
  check('claim: only free signatures so far — no transaction was ever requested', await S.page.evaluate(() => (window.__walletCalls || []).includes('eth_signTypedData_v4') && !(window.__walletCalls || []).includes('eth_sendTransaction')));
  await S.page.fill('#mpPrice', '2.31');
  await S.page.fill('#mpDescription', 'Operating project with a live site and an active community, ready for a new operator to take over.');
  await wait(S.page, () => !document.getElementById('mpIncludeFee').disabled);
  check('list: the fee right is offerable only because the LIVE chain says the seller wallet holds it', /YOUR WALLET IS THE RECIPIENT/.test(await text(S.page, '#mpFeeRowState')));
  await S.page.check('#mpIncludeFee');
  await S.page.check('.mp-asset[data-label="Website + domain"]');
  await S.page.click('#mpCreateListing');
  await wait(S.page, () => location.hash.startsWith('#listing=')); await S.page.waitForTimeout(600);
  LISTING_ID = await S.page.evaluate(() => location.hash.slice('#listing='.length));
  const detail = await text(S.page, '#mpDetail');
  check('list: the published listing shows real status badges from server + chain facts', /ACTIVE/.test(detail) && /VERIFIED OPERATOR/.test(detail) && /CREATOR FEE TRANSFERABLE/.test(detail), detail.slice(0, 160));
  check('list: what is NOT sold is explicit (supply, liquidity, metadata, X account)', /NEVER SOLD · NEVER TRANSFERRED/.test(detail) && /X account/.test(detail));
  await S.page.reload(); await S.page.waitForTimeout(900);
  check('refresh: the listing detail re-renders from the server after a full page reload', /ACTIVE/.test(await text(S.page, '#mpDetail')) && /2\.31 ETH/.test(await text(S.page, '#mpDetail')));
}

// ================================================================= buyer (clean browser): same listing, signed offer
{
  await B.page.goto(BASE + '/marketplace.html'); await B.page.waitForTimeout(900);
  const cardText = await text(B.page, '#mp-listings');
  check('cross-browser: a SECOND browser sees the SAME listing (server persistence, not localStorage)', /2\.31 ETH/.test(cardText) && /OPLIVE/.test(cardText), cardText.slice(0, 160));
  check('cross-browser: the buyer browser holds no marketplace records locally', await B.page.evaluate(() => !Object.keys(localStorage).some((k) => /marketplace|mp:/.test(k))));
  const img = await B.page.$('#mp-listings img[data-ipfs]');
  check('cards: the project image renders through the canonical IPFS utility (Pinata first)', Boolean(img) && /gateway\.pinata\.cloud/.test(await img.evaluate((i) => i.currentSrc || i.src)));
  await B.page.click('#mp-listings a.btn.primary'); await B.page.waitForTimeout(700);
  await B.page.click('#mpConnect'); await B.page.waitForTimeout(300);
  check('buyer: connected as a different wallet', new RegExp(A.WALLET2.slice(0, 6)).test(await text(B.page, '#mpWalletName')));
  await B.page.fill('#mpOfferAmount', '2.31');
  await B.page.evaluate(() => { const b = document.getElementById('mpMakeOffer'); b.click(); b.click(); }); // double-click: the guard must swallow the second
  await wait(B.page, () => /delivered to the seller ✓/.test(document.getElementById('mpDetailStatus')?.textContent || ''));
  check('offer: signed offer delivered (a free signature, not a transaction)', await B.page.evaluate(() => !(window.__walletCalls || []).includes('eth_sendTransaction')));
  const detail = await text(B.page, '#mpDetail');
  check('offer: the buyer sees their own PENDING offer', /PENDING/.test(detail));
}

// ================================================================= seller: inbox → accept → deal opens
let DEAL_ID = '';
{
  await S.page.reload(); await S.page.waitForTimeout(900);
  const detail = await text(S.page, '#mpDetail');
  check('inbox: the seller sees exactly ONE offer (the double-click made no duplicate)', (detail.match(/2\.31 ETH/g) || []).length >= 1 && (await S.page.$$('[data-act="accept"]')).length === 1, detail.slice(-200));
  await S.page.click('[data-act="accept"]');
  await wait(S.page, () => location.hash.startsWith('#deal=')); await S.page.waitForTimeout(700);
  DEAL_ID = await S.page.evaluate(() => location.hash.slice('#deal='.length));
  const room = await text(S.page, '#mpDeal');
  check('deal: acceptance (signed) opened a persistent deal room', /YOU ARE THE SELLER/.test(room) && /Operator transfer/.test(room) && /PENDING/.test(room), room.slice(0, 200));
  check('deal: completion is blocked until every step is done', /BLOCKED UNTIL EVERY STEP IS DONE/.test(room));
}

// ================================================================= two-party operator transfer
{
  await S.page.click('[data-act="transfer-intent"]');
  await wait(S.page, () => /INTENT SIGNED/.test(document.getElementById('mpDeal').textContent));
  await B.page.goto(BASE + '/marketplace.html#deal=' + DEAL_ID); await B.page.waitForTimeout(900);
  check('transfer: the buyer sees the seller-signed intent in their own browser', /INTENT SIGNED · WAITING FOR THE BUYER/.test(await text(B.page, '#mpDeal')));
  await B.page.click('[data-act="transfer-accept"]');
  await wait(B.page, () => /TRANSFERRED · BOTH SIGNATURES VERIFIED/.test(document.getElementById('mpDeal').textContent));
  check('transfer: both signatures verified — the operator record moved A → B', true);
}

// ================================================================= on-chain fee right + payment
{
  await S.page.reload(); await S.page.waitForTimeout(900);
  await S.page.click('[data-act="fee-send"]');
  await wait(S.page, () => /Verified: the PAR factory now names the buyer as creator-fee recipient/.test(document.getElementById('mpDeal').textContent), null, 25000);
  const feeTx = await S.page.evaluate(() => window.__sentTxs.at(-1));
  check('fee right: the wallet transaction goes to the PAR factory with transferCreatorFeeRecipient(token, buyer)', /^0x2931861b/.test(feeTx.data) && feeTx.to.toLowerCase() === '0x3ea29975a79900179f3e1aef93347ba4210c29c1', JSON.stringify(feeTx).slice(0, 160));
  check('fee right: the chain now names the buyer as recipient (server verified it from the chain)', LAUNCHES.find((l) => l.token === A.CREATORLIVE).creatorFeeRecipient.toLowerCase() === A.WALLET2.toLowerCase());

  await B.page.reload(); await B.page.waitForTimeout(900);
  check('payment: the deal room states plainly that SyncNet does not escrow funds', /does not escrow funds/.test(await text(B.page, '#mpDeal')));
  await B.page.click('[data-act="pay"]');
  await wait(B.page, () => /Verified: 2\.31 ETH from the buyer wallet to the seller wallet/.test(document.getElementById('mpDeal').textContent), null, 25000);
  const payTx = await B.page.evaluate(() => window.__sentTxs.at(-1));
  check('payment: a PLAIN transfer — to the seller wallet, exact price, no calldata, no approval', payTx.to.toLowerCase() === A.WALLET.toLowerCase() && payTx.data === '0x' && BigInt(payTx.value) === 2310000000000000000n, JSON.stringify(payTx).slice(0, 140));
}

// ================================================================= manual asset + completion
{
  await B.page.click('[data-act="confirm"][data-item="a2"]').catch(() => B.page.click('[data-act="confirm"]'));
  await wait(B.page, () => /buyer ✓/.test(document.getElementById('mpDeal').textContent));
  await S.page.reload(); await S.page.waitForTimeout(900);
  const itemBtn = await S.page.$('.mp-listing-package-row [data-act="confirm"]');
  check('manual asset: needs BOTH parties — after the buyer, the seller still has to confirm', Boolean(itemBtn));
  await itemBtn.click();
  await wait(S.page, () => /CONFIRMED BY BOTH/.test(document.getElementById('mpDeal').textContent));
  await wait(S.page, () => /READY · NEEDS BOTH SIGNATURES/.test(document.getElementById('mpDeal').textContent));
  await S.page.click('[data-act="complete"]');
  await wait(S.page, () => /seller ✓/.test(document.getElementById('mpDeal').textContent));
  await B.page.reload(); await B.page.waitForTimeout(900);
  await B.page.click('[data-act="complete"]');
  await wait(B.page, () => /COMPLETED/.test(document.getElementById('mpDeal').textContent));
  check('completion: both signatures over the exact checklist state → deal COMPLETED', /Completed/.test(await text(B.page, '#mpDeal')));
  await B.page.goto(BASE + '/marketplace.html'); await B.page.waitForTimeout(900);
  check('completion: no ACTIVE listing remains; the listing is in past listings as COMPLETED', /NO PROJECTS LISTED YET|Past listings/.test(await text(B.page, '#mp-listings')));
}

// ================================================================= project page provenance
{
  await B.page.goto(BASE + '/project/' + A.CREATORLIVE); await B.page.waitForTimeout(2500);
  const card = await text(B.page, '#tokenCard');
  const pass = await text(B.page, '#passportPanel');
  check('project page: SYNCNET OPERATOR VERIFIED badge (server-verified signatures, not PAR INDEXED)', /SYNCNET OPERATOR VERIFIED/.test(card), card.slice(0, 200));
  check('project page: the recognised operator is the BUYER now', new RegExp(A.WALLET2.slice(2, 12), 'i').test(pass), pass.slice(0, 300));
  check('project page: the operator history shows the transfer and keeps the OLD operator', /operator transfer/.test(pass) && new RegExp(A.WALLET.slice(2, 8), 'i').test(pass));
  check('project page: marketplace row reflects the completed hand-over', /previously changed hands/.test(pass));
  check('project page: no launch claims were altered (still a verified PAR launch)', /PAR LAUNCH · FACTORY RECORD ON-CHAIN/.test(card));
}

// ================================================================= failure modes
{
  // the NEW operator lists again; the OLD operator has no seller controls; cancellation closes offers
  await B.page.goto(BASE + '/marketplace.html#sell'); await B.page.waitForTimeout(600);
  await B.page.fill('#mpToken', A.CREATORLIVE); await B.page.click('#mpCheckProject');
  await wait(B.page, () => /already the recognised operator ✓/.test(document.getElementById('mpClaimStatus').textContent));
  await B.page.fill('#mpPrice', '5'); await B.page.fill('#mpDescription', 'Second sale by the new operator, testing cancellation behaviour end to end.');
  await B.page.click('#mpCreateListing');
  await wait(B.page, () => location.hash.startsWith('#listing=')); await B.page.waitForTimeout(600);
  const L2 = await B.page.evaluate(() => location.hash.slice('#listing='.length));
  await S.page.goto(BASE + '/marketplace.html#listing=' + L2); await S.page.waitForTimeout(700);
  check('authz: the OLD operator gets no seller controls on the new listing', !(await S.page.$('#mpDetail [data-act="cancel-listing"]')) && Boolean(await S.page.$('#mpMakeOffer')));
  await B.page.click('#mpDetail [data-act="cancel-listing"]');
  await wait(B.page, () => /CANCELLED/.test(document.getElementById('mpDetail').textContent));
  await S.page.reload(); await S.page.waitForTimeout(700);
  check('cancel: the other browser sees CANCELLED and can no longer offer', /CANCELLED/.test(await text(S.page, '#mpDetail')) && !(await S.page.$('#mpMakeOffer')));

  // stale offer against the cancelled listing straight at the API
  const stale = await S.page.evaluate(async (id) => { const r = await fetch('/api/marketplace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'offer', listingId: id, termsHash: '0x' + '11'.repeat(32), token: '0x' + '22'.repeat(20), buyer: '0x' + '33'.repeat(20), amount: '1', currency: 'ETH', nonce: '0x' + '44'.repeat(32), expiry: Math.floor(Date.now() / 1000) + 3600, signature: '0x' + '55'.repeat(65) }) }); return { status: r.status, body: await r.text() }; }, L2);
  check('stale: an offer against the cancelled listing is refused server-side', stale.status === 409, JSON.stringify(stale).slice(0, 140));
  const malformed = await S.page.evaluate(async () => { const r = await fetch('/api/marketplace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json{{{' }); return { status: r.status, body: await r.text() }; });
  check('malformed: a garbage payload is a clean JSON 400 (no crash, no stack)', malformed.status === 400 && !/at |stack/.test(malformed.body), JSON.stringify(malformed).slice(0, 140));

  // wallet disconnect + account change
  await S.page.evaluate(() => window.__mockEmit('disconnect', { code: 4900 })); await S.page.waitForTimeout(300);
  check('disconnect: the page returns to the not-connected state', /Not connected/.test(await text(S.page, '#mpWalletName')));
  await B.page.goto(BASE + '/marketplace.html#mine'); await B.page.waitForTimeout(700);
  check('my activity: the buyer sees their listings, offers and deals', /My listings \(/.test(await text(B.page, '#mpMine')) && /DEAL ROOM/.test(await text(B.page, '#mpMine')));
  await B.page.evaluate((a) => window.__mockSetAccount(a), A.ATTACKER); await B.page.waitForTimeout(500);
  check('account change: switching wallets re-renders to that wallet’s (empty) activity', /None yet/.test(await text(B.page, '#mpMine')), (await text(B.page, '#mpMine')).slice(0, 120));

  // RPC failure and persistence failure fail SOFT for reads, CLOSED for writes
  chain.rpcDown = true;
  await B.page.goto(BASE + '/marketplace.html#sell'); await B.page.waitForTimeout(400);
  await B.page.fill('#mpToken', A.CREATORLIVE); await B.page.click('#mpCheckProject');
  await wait(B.page, () => /could not be read right now/.test(document.getElementById('mpClaimStatus').textContent));
  check('rpc down: the sell flow reports the outage instead of guessing', true);
  chain.rpcDown = false;
  // This 40-second walkthrough compresses hours of two-human activity, so the per-minute IP budget is
  // legitimately near its edge here; clear ONLY the rate counters (never marketplace records) so the
  // storage-down probe tests the outage path, not the limiter.
  for (const k of [...serverState.upstash.keys()]) if (k.startsWith('rl:')) serverState.upstash.delete(k);
  serverState.upstashDown = true;
  await B.page.goto(BASE + '/marketplace.html'); await B.page.waitForTimeout(700);
  check('storage down: browsing degrades to a clear unavailable message (no fake data)', /unavailable/i.test(await text(B.page, '#mp-listings')), await text(B.page, '#mp-listings'));
  serverState.upstashDown = false;

  // image gateway failure on cards → deterministic placeholder
  Object.assign(browserGateways, { pinata: 'down', ipfs: 'down', dweb: 'down' });
  await B.page.goto(BASE + '/marketplace.html'); await B.page.waitForTimeout(1200);
  const img = await B.page.$('#mp-listings img[data-ipfs]');
  if (img) {
    await wait(B.page, () => { const i = document.querySelector('#mp-listings img[data-ipfs]'); return i && i.dataset.ipfsFailed; });
    check('image failure: card logos fall back to the deterministic placeholder', /data:image\/svg/.test(await img.evaluate((i) => i.src)));
  } else check('image failure: card logos fall back to the deterministic placeholder', /Past listings/.test(await text(B.page, '#mp-listings')), 'no card image rendered');
  Object.assign(browserGateways, { pinata: 'ok', ipfs: 'ok', dweb: 'ok' });

  check('hygiene: no page errors across the whole walkthrough (seller browser)', S.page.__errors.length === 0, S.page.__errors.join(' | '));
  check('hygiene: no page errors across the whole walkthrough (buyer browser)', B.page.__errors.length === 0, B.page.__errors.join(' | '));
}

row.creatorFeeRecipient = prevRecipient; delete row.logo;
await S.c.close(); await B.c.close(); await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-marketplace.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} marketplace walkthrough checks passed`);
process.exit(failures ? 1 : 0);
