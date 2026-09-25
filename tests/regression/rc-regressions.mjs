// SyncNet V2.5 RC — the 20 required regression tests (R01–R20) plus R21 final review = wallet request, R22 two-tab race,
// R23 imported evidence stays neutral, R24 wallet disconnect, R25 hostile-HTML metadata, R26/R27 (IPFS hotfix: the
// server-side /api/ipfs-check decides the metadata preflight) and R28 (Pinata gateway when public gateways 429), driven through the
// real pages with the stateful PAR mock, the real Netlify functions and a signing mock wallet (tests/e2e/harness.mjs).
// Nothing touches a real network and nothing is broadcast anywhere. Run: node tests/regression/rc-regressions.mjs
import { startServer, installRoutes, A, chain, resetChain, resetServer, setFlags, serverState, minePending, FOUNDER_KEY, Core, Chain, ROOT, TEST_CID, cidFor } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const PORT = 8935, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 500) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
async function test(name, fn) { if (only && !only.test(name)) return; console.log('\n# ' + name); resetChain(); resetServer(); try { await fn(); } catch (e) { failures++; results.push({ name: name + ' (exception)', ok: false, detail: String(e.stack || e).slice(0, 800) }); console.log('FAIL (exception)', name, e.stack || e); } }
const srv = await startServer(PORT);
const browser = await chromium.launch();
async function newPage(opts = {}) { const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts }); await installRoutes(c); const page = await c.newPage(); page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e))); page.on('dialog', (d) => d.accept()); return { c, page }; }
const txt = (page, id) => page.textContent('#' + id);
const waitText = (page, id, re, timeout = 30000) => page.waitForFunction(([i, s]) => new RegExp(s).test(document.getElementById(i)?.textContent || ''), [id, re.source], { timeout });
const recordsOf = (page, ns = 'syncnet_') => page.evaluate((ns) => JSON.parse(localStorage.getItem(ns + 'launch_records_v1') || '[]'), ns);
const POST = new Set(['BROADCAST_ATTEMPTED', 'BROADCAST_UNKNOWN', 'TX_HASH_RECEIVED', 'MINED', 'ONCHAIN_VERIFIED', 'INDEXER_PENDING', 'FULLY_VERIFIED', 'FAILED_POST_BROADCAST']);
const calls = (page, m) => page.evaluate((m) => (window.__walletCalls || []).filter((x) => x === m).length, m);

async function founder(page, { url = '/build.html?live=canary' } = {}) {
  await page.goto(BASE + url);
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
}
async function project(page, { name = 'Regression Test', symbol = 'REGT', description = 'Regression', fee = 'holders', quotes = ['SYNC'], logo = 'ipfs://' + TEST_CID, recipient = '', tax = '100' } = {}) {
  await page.click('#tab-1'); await page.evaluate(() => { document.querySelector('#panel-1 details.technical-details').open = true; }); await page.fill('#logo', logo);
  await page.fill('#name', name); await page.fill('#symbol', symbol); await page.fill('#description', description);
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2');
  for (const q of quotes) {
    if (q === 'SYNC' || q === 'USDG') { await page.click(`[data-preset="${q}"]`); await waitText(page, 'assetStatus', new RegExp(q + ' ready')); }
    else { await page.fill('#customAsset', q); await page.click('#checkAdd'); await waitText(page, 'assetStatus', /ready|NOT the canonical|not currently eligible|No contract/); }
  }
  await page.click('#tab-3'); await page.click(`[data-tax="${tax}"]`); await page.check(`input[name="feeMode"][value="${fee}"]`);
  if (fee === 'creator' && recipient) await page.fill('#creatorRecipient', recipient);
  await page.click('#tab-4');
}
async function connect(page) { if (!/…/.test(await txt(page, 'walletName'))) { await page.click('#connectWallet'); await page.click('#providerList button'); } }
/** Runs one simulation and waits until the page is idle again (button restored), so no stale status is ever read. */
async function simulate(page) {
  await page.evaluate(() => { window.__simSeq = (window.__simSeq || 0) + 1; document.getElementById('simStatus').dataset.seen = ''; });
  await page.click('#runSimulation');
  await page.waitForFunction(() => { const b = document.getElementById('runSimulation'); const s = document.getElementById('simStatus').textContent; return !/SIMULATING/.test(b.textContent) && /SIMULATION PASSED|No transaction was sent/.test(s); }, null, { timeout: 45000 });
  return txt(page, 'simStatus');
}
async function guardDone(page) { await waitText(page, 'checkDuplicate', /PASS|BLOCKED|EXISTS|WARN/, 20000); await page.waitForFunction(() => !/SIMULATING/.test(document.getElementById('runSimulation').textContent)); return txt(page, 'checkDuplicate'); }
async function sign(page) { await page.click('#signIntent'); await page.waitForFunction(() => !/SIGNING/.test(document.getElementById('checkIntentSignature').textContent)); return txt(page, 'checkIntentSignature'); }
async function confirm(page, phrase) { await page.check('#finalAck'); await page.fill('#liveConfirm', phrase); }
async function ready(page, opts = {}) { await founder(page); await project(page, opts); await connect(page); const sim = await simulate(page); await guardDone(page); await sign(page); await confirm(page, opts.symbol || 'REGT'); return sim; }
async function launchAndWait(page, re = /LIVE LAUNCH CONFIRMED|VERIFICATION NEEDS|Nothing was sent|treated as SENT|REVERTED|No token at the predicted|No receipt/, timeout = 60000) { await page.click('#launchLive'); await waitText(page, 'liveStatus', re, timeout); return txt(page, 'liveStatus'); }

// ======================================================================================= R01
await test('R01 wallet broadcasts but the provider throws → SyncNet detects and recovers the launch', async () => {
  const { c, page } = await newPage();
  await ready(page);
  chain.sendMode = 'error-after-broadcast';
  const live = await launchAndWait(page, /LIVE LAUNCH CONFIRMED|VERIFICATION NEEDS|No token at the predicted/, 90000);
  const recs = await recordsOf(page); const r = recs.find((x) => POST.has(x.state));
  check('R01 the launch was really broadcast (mock chain has the token)', chain.tokens.size === 1);
  check('R01 page reports the launch as executed, never as "not sent"', /LIVE LAUNCH CONFIRMED/.test(live) && !/Nothing was sent|No transaction was sent/.test(live), live.slice(0, 200));
  check('R01 record resolved from the chain to a verified state', r && ['ONCHAIN_VERIFIED', 'FULLY_VERIFIED', 'INDEXER_PENDING'].includes(r.state), r && r.state);
  check('R01 history shows BROADCAST_UNKNOWN before the chain resolved it', r && r.history.some((h) => h.state === 'BROADCAST_UNKNOWN'), r && r.history.map((h) => h.state).join(' → '));
  check('R01 transaction hash recovered from the indexer and confirmed on-chain', r && /^0x[0-9a-f]{64}$/.test(r.txHash || ''), r && r.txHash);
  check('R01 only ONE eth_sendTransaction', (await calls(page, 'eth_sendTransaction')) === 1);
  await c.close();
});

// ======================================================================================= R02
await test('R02 reload during wallet confirmation → prepared state survives and blocks a second launch', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Reload Test', symbol: 'RELD' });
  await page.evaluate(() => { window.__mockSendHook = () => new Promise(() => {}); }); // wallet popup open forever
  await page.click('#launchLive');
  await page.waitForFunction(() => (window.__walletCalls || []).includes('eth_sendTransaction'), null, { timeout: 20000 });
  const before = (await recordsOf(page)).find((r) => r.state === 'BROADCAST_ATTEMPTED');
  check('R02 record written BEFORE the wallet request (state BROADCAST_ATTEMPTED)', Boolean(before));
  const need = ['predicted', 'recordHash', 'salt', 'deployer', 'intentJson', 'intentRecord', 'signature', 'tx', 'draft', 'expected', 'attemptAt', 'walletRequest', 'reviewFingerprint'];
  check('R02 record holds the full evidence (' + need.join(', ') + ')', before && need.every((k) => before[k] != null && before[k] !== ''), before && need.filter((k) => before[k] == null || before[k] === '').join(','));
  check('R02 record has exact calldata, target, value, gas and chainId', before && /^0x5a4b7ef0/.test(before.tx.data) && before.tx.to && before.tx.value && before.tx.gas && before.tx.chainId === '0x1237' && before.walletRequest.data === before.tx.data);
  check('R02 record has the typed data that was signed', before && before.signature.typedData && before.signature.typedData.message.recordHash === before.recordHash && before.signature.typedData.message.salt === before.salt);
  check('R02 record has expected economics, recipient, tax and markets', before && before.expected.economics.launchFee && before.expected.creatorFeeRecipient && before.expected.creatorTaxBps === 100 && before.expected.pairTokens.length === 1);
  await page.reload(); await page.waitForTimeout(1500);
  check('R02 after reload the UNRESOLVED launch is shown with its predicted token', /UNRESOLVED/.test(await txt(page, 'launchRecords')) && (await txt(page, 'launchRecords')).toLowerCase().includes(before.predicted.slice(2, 12)));
  check('R02 draft banner warns about the unresolved launch', !(await page.locator('#draftBanner').isVisible()) || /unresolved/.test(await txt(page, 'draftMeta')));
  // Try to launch the same project again from the fresh page.
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  await project(page, { name: 'Reload Test', symbol: 'RELD' }); await connect(page); await simulate(page);
  const g = await guardDone(page);
  check('R02 a second launch of $RELD from the same wallet is BLOCKED while the first is unresolved', /BLOCKED/.test(g) && /unresolved/.test(await txt(page, 'guardPanel')), g);
  if (await page.locator('#signIntent').isEnabled()) await sign(page);
  if (await page.locator('#finalAck').count()) await page.check('#finalAck');
  await page.fill('#liveConfirm', 'RELD');
  check('R02 LAUNCH LIVE stays disabled', await page.locator('#launchLive').isDisabled(), await txt(page, 'launchBlockers'));
  // Recovery: the chain shows nothing was sent → user marks it as not sent (record kept) → a new launch is possible.
  await page.goto(BASE + '/launches.html'); await page.waitForTimeout(1200);
  const card = page.locator('.record-card').filter({ hasText: 'RELD' }).first();
  await card.locator('[data-act="notsent"]').click(); await card.locator('[data-notsent-input]').fill('NOT SENT RELD'); await card.locator('[data-act="notsent-confirm"]').click();
  await page.waitForTimeout(1500);
  const after = (await recordsOf(page)).find((r) => r.id === before.id);
  check('R02 "mark as not sent" keeps the record and its history', after && after.state === 'FAILED_PRE_BROADCAST' && after.history.length > before.history.length && after.intentJson === before.intentJson);
  await c.close();
});

// ======================================================================================= R03
await test('R03 edits while the wallet popup is open cannot change the transaction', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Edit Race', symbol: 'EDIT' });
  await page.evaluate(() => { window.__mockSendHook = () => new Promise((r) => { window.__releaseSend = r; }); });
  await page.click('#launchLive');
  await page.waitForFunction(() => typeof window.__releaseSend === 'function', null, { timeout: 20000 });
  check('R03 form inputs are locked while the wallet is asked', await page.locator('#name').isDisabled() && await page.locator('#description').isDisabled() && await page.locator('#runSimulation').isDisabled());
  await page.evaluate(() => { for (const [id, v] of [['name', 'Hacked Name'], ['description', 'changed while the popup was open']]) { const el = document.getElementById(id); el.disabled = false; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } document.querySelector('input[name="feeMode"][value="creator"]').click(); });
  await page.evaluate(() => window.__releaseSend());
  await waitText(page, 'liveStatus', /LIVE LAUNCH CONFIRMED|VERIFICATION NEEDS/, 60000);
  const sent = await page.evaluate(() => window.__sentTx);
  const rec = (await recordsOf(page)).find((r) => POST.has(r.state));
  const d = Core.decodeLaunchCalldata(sent.data);
  check('R03 wallet received exactly the recorded transaction', sent.data === rec.walletRequest.data && sent.to === rec.walletRequest.to && sent.value === rec.walletRequest.value);
  check('R03 sent calldata has the ORIGINAL name, description and fee recipient', d.params.name === 'Edit Race' && d.params.description === 'Regression' && d.params.creatorFeeRecipient === A.HOLDER.toLowerCase(), JSON.stringify({ n: d.params.name, r: d.params.creatorFeeRecipient }));
  check('R03 deployed token matches the reviewed launch', /LIVE LAUNCH CONFIRMED/.test(await txt(page, 'liveStatus')));
  await c.close();
});

// ======================================================================================= R04
await test('R04 a new simulation after signing invalidates the old signature', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Resim', symbol: 'RSIM' });
  check('R04 signed and launch enabled before re-simulation', /SIGNED ✓/.test(await txt(page, 'checkIntentSignature')) && await page.locator('#launchLive').isEnabled());
  const typed1 = JSON.parse(await page.evaluate(() => window.__typed));
  await simulate(page); await guardDone(page);
  check('R04 signature shown as NOT SIGNED after re-simulation', /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
  check('R04 sign button enabled again (new signature required)', await page.locator('#signIntent').isEnabled());
  await page.check('#finalAck'); await page.fill('#liveConfirm', 'RSIM');
  check('R04 LAUNCH LIVE disabled with the old signature', await page.locator('#launchLive').isDisabled() && /sign the launch intent/.test(await txt(page, 'launchBlockers')));
  await sign(page); await page.check('#finalAck'); await page.fill('#liveConfirm', 'RSIM');
  const typed2 = JSON.parse(await page.evaluate(() => window.__typed));
  check('R04 the new signature covers the NEW recordHash and salt', typed2.message.recordHash !== typed1.message.recordHash && typed2.message.salt !== typed1.message.salt && await page.locator('#launchLive').isEnabled());
  await c.close();
});

// ======================================================================================= R05
await test('R05 account switch invalidates simulation, review and signature', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Account', symbol: 'ACCT', fee: 'creator' });
  check('R05 review names wallet A before the switch', (await txt(page, 'reviewRewards')).toLowerCase().includes(A.WALLET.toLowerCase()));
  await page.evaluate((b) => window.__mockSetAccount(b), A.WALLET2);
  await page.waitForTimeout(400);
  check('R05 simulation reset', /not run yet/.test(await txt(page, 'simStatus')));
  check('R05 signature reset', /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
  check('R05 final review removed', await page.locator('#finalReview').isHidden());
  check('R05 LAUNCH LIVE disabled', await page.locator('#launchLive').isDisabled());
  check('R05 review now names wallet B as the creator-fee recipient', (await txt(page, 'reviewRewards')).toLowerCase().includes(A.WALLET2.toLowerCase()), await txt(page, 'reviewRewards'));
  const sim = await simulate(page); await guardDone(page);
  check('R05 new simulation prepared for wallet B', sim.toLowerCase().includes(A.WALLET2.toLowerCase()) && chain.lastLaunchCall.params.creatorFeeRecipient === A.WALLET2.toLowerCase());
  await sign(page);
  check('R05 signature by wallet B verified for the new launch', /SIGNED ✓/.test(await txt(page, 'checkIntentSignature')) && /0x/.test(await txt(page, 'finalReview')) && (await txt(page, 'finalReview')).toLowerCase().includes(A.WALLET2.toLowerCase()));
  await c.close();
});

// ======================================================================================= R06
await test('R06 chain switch invalidates simulation, review and signature', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Chain', symbol: 'CHN' });
  await page.evaluate(() => window.__mockSetChain('0x1'));
  await page.waitForTimeout(400);
  check('R06 simulation reset', /not run yet/.test(await txt(page, 'simStatus')));
  check('R06 signature reset', /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
  check('R06 final review removed and LAUNCH disabled', await page.locator('#finalReview').isHidden() && await page.locator('#launchLive').isDisabled());
  check('R06 banner and wallet line flag the wrong network', /wallet on chain 1/.test(await txt(page, 'networkBanner')) && /Wrong network/.test(await txt(page, 'walletNetwork')));
  const sim = await simulate(page);
  check('R06 simulation refuses to run on the wrong chain (no automatic switch)', /No transaction was sent/.test(sim) && !(await page.evaluate(() => (window.__walletCalls || []).includes('wallet_switchEthereumChain'))), sim.slice(0, 160));
  await c.close();
});

// ======================================================================================= R07
await test('R07 an old-recordHash or foreign signature keeps LAUNCH LIVE blocked', async () => {
  const { c, page } = await newPage();
  await founder(page); await project(page, { name: 'Stale Sig', symbol: 'STSG' }); await connect(page); await simulate(page); await guardDone(page);
  // (a) the wallet popup stays open while a new simulation replaces the prepared launch
  await page.evaluate(() => { window.__mockSignHook = () => new Promise((r) => { window.__releaseSign = r; }); });
  await page.click('#signIntent');
  await page.waitForFunction(() => typeof window.__releaseSign === 'function');
  await page.evaluate(() => { const b = document.getElementById('runSimulation'); b.disabled = false; });
  // busy=true blocks simulation while signing; an input edit is what invalidates instead
  await page.evaluate(() => { const d = document.getElementById('description'); d.value = 'edited during signing'; d.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => { window.__mockSignHook = null; window.__releaseSign(); });
  await page.waitForFunction(() => !/SIGNING/.test(document.getElementById('checkIntentSignature').textContent));
  check('R07a signature returned for the replaced launch is discarded', /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
  // (b) wallet signs a DIFFERENT recordHash (tampered typed data)
  await simulate(page); await guardDone(page);
  await page.evaluate(() => { const p = window.ethereum; const orig = p.request.bind(p); p.request = async (a) => { if (a.method === 'eth_signTypedData_v4') { const t = JSON.parse(a.params[1]); t.message.recordHash = '0x' + '12'.repeat(32); a = { ...a, params: [a.params[0], JSON.stringify(t)] }; } return orig(a); }; });
  await sign(page);
  check('R07b signature over another recordHash is rejected', /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
  // (c) wallet signs with a different key
  await page.evaluate(() => { const p = window.ethereum; delete p.request; });
  await page.evaluate((w2) => { window.__mockSignAs = w2; }, A.WALLET2);
  await page.reload(); await founder(page); await project(page, { name: 'Stale Sig', symbol: 'STSG' }); await connect(page); await simulate(page); await guardDone(page);
  await page.evaluate((w2) => { window.__mockSignAs = w2; }, A.WALLET2);
  await sign(page);
  check('R07c signature by another wallet is rejected', /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
  await page.check('#finalAck'); await page.fill('#liveConfirm', 'STSG');
  check('R07 LAUNCH LIVE blocked in every case', await page.locator('#launchLive').isDisabled());
  check('R07 no transaction was ever requested', (await calls(page, 'eth_sendTransaction')) === 0);
  await c.close();
});

// ======================================================================================= R08
await test('R08 receipt never arrives in the page → provenance survives and resolves later', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Receipt', symbol: 'RCPT' });
  chain.sendMode = 'pending';
  await page.click('#launchLive');
  await waitText(page, 'liveStatus', /Submitted\. Waiting for confirmation/, 30000);
  const r1 = (await recordsOf(page)).find((r) => r.state === 'TX_HASH_RECEIVED');
  check('R08 record holds the tx hash, intent and signature while waiting', r1 && /^0x[0-9a-f]{64}$/.test(r1.txHash) && r1.intentJson && r1.signature);
  await page.reload(); await page.waitForTimeout(1500);
  check('R08 after reload the launch is UNRESOLVED (not forgotten)', /UNRESOLVED/.test(await txt(page, 'launchRecords')));
  minePending();
  await page.goto(BASE + '/launches.html'); await page.waitForTimeout(500);
  await page.locator('.record-card').filter({ hasText: 'RCPT' }).first().locator('[data-act="reverify"]').click();
  await page.waitForTimeout(2500);
  const r2 = (await recordsOf(page)).find((r) => r.id === r1.id);
  check('R08 RE-VERIFY after mining resolves it to a verified launch with its evidence intact', r2 && ['FULLY_VERIFIED', 'ONCHAIN_VERIFIED', 'INDEXER_PENDING'].includes(r2.state) && r2.intentJson === r1.intentJson && r2.signature.signature === r1.signature.signature, r2 && r2.state);
  await c.close();
});

// ======================================================================================= R09
await test('R09 indexer delay → on-chain verification still succeeds', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Indexer', symbol: 'IDXL' });
  chain.indexerLag = true;
  const live = await launchAndWait(page);
  const r = (await recordsOf(page)).find((x) => POST.has(x.state));
  check('R09 launch confirmed from the chain while the indexer lags', /LIVE LAUNCH CONFIRMED/.test(live) && /VERIFIED ✓/.test(live), live.slice(0, 200));
  check('R09 state INDEXER_PENDING (on-chain verified, indexer secondary)', r && r.state === 'INDEXER_PENDING', r && r.state);
  chain.indexerLag = false;
  await page.goto(BASE + '/launches.html'); await page.waitForTimeout(500);
  await page.locator('.record-card').filter({ hasText: 'IDXL' }).first().locator('[data-act="reverify"]').click(); await page.waitForTimeout(2000);
  check('R09 RE-VERIFY upgrades to FULLY_VERIFIED once indexed', (await recordsOf(page)).find((x) => x.id === r.id)?.state === 'FULLY_VERIFIED');
  await c.close();
});

// ======================================================================================= R10
await test('R10 clearing notices and drafts never removes launch evidence', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Notice', symbol: 'NOTC' });
  await launchAndWait(page);
  const r = (await recordsOf(page)).find((x) => POST.has(x.state));
  await page.goto(BASE + '/build.html'); await page.waitForTimeout(600);
  if (await page.locator('#draftBanner').isVisible()) await page.click('#draftDiscard');
  await page.goto(BASE + '/build.html?live=canary'); await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  check('R10 MY LAUNCHES panel still shows the launch after discard + founder unlock', /NOTC/.test(await txt(page, 'launchRecords')));
  const after = (await recordsOf(page)).find((x) => x.id === r.id);
  check('R10 evidence intact (intent, signature, tx hash)', after && after.intentJson === r.intentJson && after.signature.signature === r.signature.signature && after.txHash === r.txHash);
  await page.goto(BASE + '/launches.html'); await page.waitForTimeout(800);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.record-card').filter({ hasText: 'NOTC' }).first().locator('[data-act="proof"]').click()]);
  const proof = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  check('R10 exportable public proof (syncnet.launch.proof.v2)', proof.schema === 'syncnet.launch.proof.v2' && proof.recordHash === r.recordHash && proof.txHash === r.txHash);
  await c.close();
});

// ======================================================================================= R11
await test('R11 existing predicted token / same wallet + ticker → duplicate launch prevented', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Dup One', symbol: 'DUPE' });
  // (a) the prepared launch appears on-chain before LAUNCH (e.g. sent from another tab/device)
  const predicted = chain.lastPredicted;
  chain.tokens.set(predicted, { deployer: A.WALLET, params: chain.lastLaunchCall.params, pairTokens: chain.lastLaunchCall.pairTokens, buy: null, block: chain.block, baseFeeBps: 100n, protocolFeeShareBps: 5000n });
  const live = await launchAndWait(page, /Nothing was sent|already/i);
  check('R11a pre-send check refuses: the predicted token already exists; nothing sent', /already exists at the predicted address/.test(live) && (await calls(page, 'eth_sendTransaction')) === 0, live.slice(0, 160));
  chain.tokens.delete(predicted);
  // (b) launch once, then try the same ticker again from the same wallet
  await simulate(page); await guardDone(page); await sign(page); await confirm(page, 'DUPE');
  const firstLive = await launchAndWait(page);
  check('R11b the first $DUPE launch completes', /LIVE LAUNCH CONFIRMED/.test(firstLive), firstLive.slice(0, 200));
  await page.goto(BASE + '/build.html?live=canary'); await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  await project(page, { name: 'Dup One', symbol: 'DUPE' }); await connect(page); await simulate(page);
  const g = await guardDone(page);
  check('R11b guard reports the existing $DUPE from this wallet', /EXISTS/.test(g) && /ALREADY LAUNCHED FROM THIS WALLET/.test(await txt(page, 'guardPanel')));
  await sign(page); await page.check('#finalAck'); await page.fill('#liveConfirm', 'DUPE');
  check('R11b plain ticker does NOT unlock a second launch', await page.locator('#launchLive').isDisabled());
  await page.fill('#liveConfirm', 'DUPE AGAIN');
  check('R11b "AGAIN" alone is not enough without the explicit acknowledgement', await page.locator('#launchLive').isDisabled());
  await page.check('#dupAck');
  check('R11b only the high-friction path (checkbox + "DUPE AGAIN") unlocks it', await page.locator('#launchLive').isEnabled());
  check('R11 no second transaction was sent during the checks', (await calls(page, 'eth_sendTransaction')) === 0);
  await c.close();
});

// ======================================================================================= R12
await test('R12 a fake "SYNC" is never treated as canonical $SYNC', async () => {
  const { c, page } = await newPage();
  await page.goto(BASE + '/network.html'); await page.waitForFunction(() => !/Reading live/.test(document.getElementById('networkGrid').textContent), null, { timeout: 20000 });
  check('R12 Map: launches paired with the fake SYNC are not listed as $SYNC connections', !/0x9999|0x3333333333333333333333333333333333333333/.test(await page.innerHTML('#networkGrid')) || !(await txt(page, 'networkGrid')).includes('USDG'));
  await page.goto(BASE + '/project/' + A.FAKESYNC); await page.waitForFunction(() => !/CHECKING/.test(document.getElementById('tokenTitle').textContent)); await page.waitForTimeout(600);
  const card = await txt(page, 'tokenCard');
  check('R12 project page: fake SYNC flagged "NOT THE CANONICAL $SYNC" and not badged canonical', /NOT THE CANONICAL \$SYNC/.test(card) && !/CANONICAL SYNCNET ASSET/.test(card));
  await page.goto(BASE + '/project/' + A.SYNC); await page.waitForFunction(() => !/CHECKING/.test(document.getElementById('tokenTitle').textContent)); await page.waitForTimeout(600);
  check('R12 project page: real $SYNC carries the canonical-by-address badge', /CANONICAL SYNCNET ASSET · BY CONTRACT ADDRESS/.test(await txt(page, 'tokenCard')));
  await founder(page); await project(page, { name: 'Fake Friend', symbol: 'FFRD', quotes: [A.FAKESYNC] });
  check('R12 builder: adding the fake SYNC as a connection shows an impostor warning', /NOT the canonical \$SYNC/i.test(await txt(page, 'assetStatus')) || /NOT the canonical/.test(await txt(page, 'selectedAssets')));
  await project(page, { name: 'SyncNet', symbol: 'SYNC', quotes: [] }); await connect(page); await simulate(page);
  const g = await guardDone(page);
  check('R12 builder: launching a token with the canonical ticker is BLOCKED', /BLOCKED/.test(g) && /impersonates|canonical SyncNet asset/.test(await txt(page, 'guardPanel')), g);
  await c.close();
});

// ======================================================================================= R13
await test('R13 arbitrary contract project page makes no NETWORK HUB / ownership / immutable claims', async () => {
  const { c, page } = await newPage();
  for (const a of [A.RANDOM_CONTRACT, A.USDG, '0x1234567890abcdef1234567890abcdef12345678']) {
    await page.goto(BASE + '/project/' + a); await page.waitForFunction(() => !/CHECKING/.test(document.getElementById('tokenTitle').textContent), null, { timeout: 20000 }); await page.waitForTimeout(600);
    const t = (await txt(page, 'tokenCard')).replace(/\s+/g, ' ');
    check(`R13 ${a.slice(0, 10)}: NOT VERIFIED AS A PAR LAUNCH shown`, /NOT VERIFIED AS A PAR LAUNCH/.test(t));
    check(`R13 ${a.slice(0, 10)}: no NETWORK HUB / Ownerless / immutable / creator-fee / BUILT WITH SYNCNET claims`, !/NETWORK HUB|Ownerless|immutable|Creator-fee beneficiary|BUILT WITH SYNCNET|PAR LAUNCH ·/.test(t), t.slice(0, 200));
    check(`R13 ${a.slice(0, 10)}: no Passport panel`, (await page.locator('#passportPanel').count()) === 0);
  }
  chain.rpcDown = true;
  await page.goto(BASE + '/project/' + A.SYNC); await page.waitForFunction(() => !/CHECKING/.test(document.getElementById('tokenTitle').textContent), null, { timeout: 30000 }); await page.waitForTimeout(600);
  const t = await txt(page, 'tokenCard');
  check('R13 RPC outage: "PAR STATUS UNAVAILABLE", no launch claims even for $SYNC', /PAR STATUS UNAVAILABLE/.test(t) && !/Ownerless|NETWORK HUB|BUILT WITH SYNCNET · VERIFIED/.test(t));
  chain.rpcDown = false;
  await c.close();
});

// ======================================================================================= R14
await test('R14 Unicode spoofing (bidi, zero-width, controls) is rejected before simulation', async () => {
  const { c, page } = await newPage();
  await founder(page);
  for (const [label, name] of [['RTL override', 'Safe\u202eTOKEN'], ['zero-width space', 'Sync\u200bNet'], ['bidi isolate', 'Name\u2066x\u2069'], ['control char', 'Bad\u0007Name']]) {
    await page.click('#tab-1'); await page.fill('#name', name); await page.fill('#symbol', 'UNI'); await page.check('input[name="websiteChoice"][value="none"]');
    await page.click('#panel-1 [data-next]');
    check(`R14 name with ${label} blocked at step 1`, await page.locator('#panel-1').isVisible(), await txt(page, 'toast'));
    check(`R14 byte counter flags the ${label}`, /invisible|direction|control|not allowed|unsafe/i.test(await txt(page, 'nameBytes')), await txt(page, 'nameBytes'));
  }
  await page.fill('#name', 'Plain Name'); await page.fill('#description', 'ok\u202edescription');
  await page.click('#panel-1 [data-next]');
  check('R14 description with RTL override blocked', await page.locator('#panel-1').isVisible());
  await page.fill('#description', 'ok'); await page.fill('#symbol', 'SYNС'); // Cyrillic Es
  await page.click('#panel-1 [data-next]');
  check('R14 ticker with a Cyrillic look-alike blocked (A–Z, 0–9 only)', await page.locator('#panel-1').isVisible());
  check('R14 nothing reached the chain as a launch simulation', !chain.lastLaunchCall);
  await c.close();
});

// ======================================================================================= R15
await test('R15 PAR byte-limit overflow is rejected before any transaction', async () => {
  const { c, page } = await newPage();
  await founder(page);
  await page.click('#tab-1'); await page.fill('#name', '界'.repeat(40)); await page.fill('#symbol', 'BYTE'); await page.check('input[name="websiteChoice"][value="none"]');
  check('R15 counter shows 120 / 64 bytes', /120 \/ 64 bytes/.test(await txt(page, 'nameBytes')), await txt(page, 'nameBytes'));
  await page.click('#panel-1 [data-next]');
  check('R15 40 CJK characters (120 bytes) blocked at step 1', await page.locator('#panel-1').isVisible() && /120 bytes/.test(await txt(page, 'toast')), await txt(page, 'toast'));
  await page.fill('#name', 'Fine'); await page.fill('#description', '界'.repeat(700)); await page.click('#panel-1 [data-next]');
  check('R15 description of 2100 bytes blocked', await page.locator('#panel-1').isVisible() && /2100 bytes/.test(await txt(page, 'descriptionBytes')));
  await page.fill('#description', 'ok'); await page.check('input[name="websiteChoice"][value="have"]'); await page.fill('#website', 'https://example.com/' + 'x'.repeat(260));
  await page.click('#panel-1 [data-next]');
  check('R15 website over 256 bytes blocked', await page.locator('#panel-1').isVisible());
  check('R15 no launch simulation was sent to the chain', !chain.lastLaunchCall && (await calls(page, 'eth_sendTransaction')) === 0);
  await c.close();
});

// ======================================================================================= R16
await test('R16 unsafe creator-fee recipients are blocked, contracts need an explicit confirmation', async () => {
  const { c, page } = await newPage();
  await founder(page); await project(page, { name: 'Recipient', symbol: 'RCPT', fee: 'creator' });
  const cases = [['zero', '0x0000000000000000000000000000000000000000'], ['burn 0x…dEaD', '0x000000000000000000000000000000000000dEaD'], ['PAR router', A.ROUTER], ['PAR factory', A.FACTORY], ['holder vault', A.HOLDER], ['Uniswap PoolManager', '0x8366a39CC670B4001A1121B8F6A443A643e40951'], ['WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'], ['fee escrow', '0x1C27e8F0c2a754DB23ab1608fA09c068D54d4386'], ['selected market token', A.SYNC]];
  for (const [label, addr] of cases) {
    await page.click('#tab-3'); await page.fill('#creatorRecipient', addr); await page.click('#panel-3 [data-next]');
    check(`R16 ${label} blocked`, await page.locator('#panel-3').isVisible(), await txt(page, 'creatorRecipientHelp'));
  }
  await page.fill('#creatorRecipient', A.RANDOM_CONTRACT); await page.waitForTimeout(900);
  check('R16 contract recipient → explicit confirmation shown', await page.locator('#contractRecipientWrap').isVisible());
  await page.click('#panel-3 [data-next]');
  check('R16 contract recipient without confirmation blocked', await page.locator('#panel-3').isVisible());
  await page.check('#contractRecipientAck'); await page.click('#panel-3 [data-next]');
  check('R16 contract recipient allowed after confirmation', await page.locator('#panel-4').isVisible());
  await page.click('#tab-3'); await page.fill('#creatorRecipient', A.SYNCAT); await page.click('#panel-3 [data-next]');
  check('R16 a canonical SyncNet asset as recipient is blocked', await page.locator('#panel-3').isVisible() && /canonical SyncNet asset/.test(await txt(page, 'creatorRecipientHelp')), await txt(page, 'creatorRecipientHelp'));
  await page.fill('#creatorRecipient', A.CREATORLIVE); await page.waitForTimeout(900);
  await page.click('#tab-4'); await connect(page); const sim = await simulate(page);
  check('R16 a PAR-launched token as recipient is refused by the simulation', /PAR-launched token contract/.test(sim), sim.slice(0, 160));
  await page.click('#tab-3'); await page.fill('#creatorRecipient', A.OTHER_EOA); await page.waitForTimeout(700);
  check('R16 another wallet → clear warning that only it can claim', /Only that address will be able to claim/.test(await txt(page, 'creatorRecipientHelp')));
  await c.close();
});

// ======================================================================================= R17
await test('R17 malicious fake-image uploads are rejected and nothing is pinned', async () => {
  setFlags({ publicUploads: true });
  const { c, page } = await newPage();
  await page.goto(BASE + '/build.html'); await page.click('#tab-4'); await connect(page); await page.click('#tab-1');
  const fake = path.join(ROOT, 'tests/regression/.tmp-fake.png');
  fs.writeFileSync(fake, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<html><script>alert(1)</script></html>')]));
  await page.setInputFiles('#logoFile', fake);
  await page.waitForFunction(() => /could not|not be read|Uploaded|rejected|damaged/i.test(document.getElementById('logoStatus').textContent), null, { timeout: 15000 });
  check('R17 browser refuses the non-image before upload', !/Uploaded/.test(await txt(page, 'logoStatus')), await txt(page, 'logoStatus'));
  fs.unlinkSync(fake);
  // Direct server calls with a valid wallet session (the browser path can be bypassed).
  const us = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
  const tok = us.issue({ scope: 'wallet', subject: A.WALLET });
  const post = (type, buf) => fetch(BASE + '/api/ipfs-upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-syncnet-upload-session': tok }, body: JSON.stringify({ type, data: buf.toString('base64') }) });
  const bodies = [
    ['PNG signature + HTML', 'image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('<script>alert(1)</script>')])],
    ['GIF header + JS', 'image/gif', Buffer.from('GIF89a' + 'alert(document.cookie)//')],
    ['SVG declared as PNG', 'image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['JPEG (not accepted server-side)', 'image/jpeg', fs.readFileSync(path.join(ROOT, 'tests/e2e/fixture-exif.jpg'))],
  ];
  serverState.fixedIp = '9.9.9.1';
  for (const [label, type, buf] of bodies) { const r = await post(type, buf); const j = await r.json(); check(`R17 ${label} → rejected (${r.status})`, r.status === 400 && j.error && !/\n\s+at |Error:|stack|\.js:/.test(j.error), j.error); }
  check('R17 nothing was pinned', serverState.pins.length === 0);
  await c.close();
});

// ======================================================================================= R18
await test('R18 upload spam is rate-limited (per wallet, per IP) and uploads fail closed without a durable store', async () => {
  setFlags({ publicUploads: true });
  const us = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
  const png = (seed) => { const zlib = require('zlib'); const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }; const ch = (t, d) => { const T = Buffer.from(t); const L = Buffer.alloc(4); L.writeUInt32BE(d.length); const C = Buffer.alloc(4); C.writeUInt32BE(crc(Buffer.concat([T, d]))); return Buffer.concat([L, T, d, C]); }; const h = Buffer.alloc(13); h.writeUInt32BE(16, 0); h.writeUInt32BE(16, 4); h[8] = 8; h[9] = 2; const raw = Buffer.alloc(16 * 49, seed & 255); for (let y = 0; y < 16; y++) raw[y * 49] = 0; return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ch('IHDR', h), ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]); };
  const tok = us.issue({ scope: 'wallet', subject: A.WALLET });
  const post = (t, b) => fetch(BASE + '/api/ipfs-upload', { method: 'POST', headers: { 'content-type': 'application/json', 'x-syncnet-upload-session': t }, body: JSON.stringify({ type: 'image/png', data: b.toString('base64') }) });
  let ok = 0, limited = 0; for (let i = 0; i < 12; i++) { serverState.fixedIp = '9.9.8.' + i; const r = await post(tok, png(i)); if (r.status === 200) ok++; else if (r.status === 429) limited++; }
  check('R18 one wallet: 5 uploads per hour, then 429', ok === 5 && limited === 7, `ok=${ok} 429=${limited}`);
  serverState.fixedIp = '9.9.7.7'; let ipOk = 0, ipLimited = 0;
  for (let i = 0; i < 25; i++) { const t = us.issue({ scope: 'wallet', subject: '0x' + (1000 + i).toString(16).padStart(40, '0') }); const r = await post(t, png(100 + i)); if (r.status === 200) ipOk++; else if (r.status === 429) ipLimited++; }
  check('R18 one IP with many wallets: 20 per hour, then 429', ipOk === 20 && ipLimited === 5, `ok=${ipOk} 429=${ipLimited}`);
  const anon = await fetch(BASE + '/api/ipfs-upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'image/png', data: png(1).toString('base64') }) });
  check('R18 no anonymous path: upload without a session → 401', anon.status === 401);
  setFlags({ publicUploads: true, durable: false });
  const cfg = await (await fetch(BASE + '/api/config')).json();
  const nd = await post(us.issue({ scope: 'wallet', subject: A.WALLET2 }), png(3));
  check('R18 public uploads stay CLOSED without a durable store (gate + wallet session refused)', cfg.publicUploads === false && nd.status === 401, `config.publicUploads=${cfg.publicUploads} status=${nd.status}`);
  setFlags({ publicUploads: true, uploadsDisabled: true });
  const ks = await post(us.issue({ scope: 'founder', subject: '-' }), png(4));
  check('R18 kill switch SYNCNET_UPLOADS_DISABLED stops even founder uploads', ks.status === 503);
  setFlags();
});

// ======================================================================================= R19
await test('R19 DNS rebinding and internal hosts are blocked by the site check', async () => {
  const sc = require(path.join(ROOT, 'netlify/functions/site-check.js'));
  const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
  const mk = () => ({ ...createStore({ map: new Map() }), durable: true });
  const ev = (url) => ({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '7.7.7.' + Math.floor(Math.random() * 250) }, queryStringParameters: { url } });
  for (const u of ['https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/', 'https://10.0.0.1/', 'http://example.com/', 'https://example.com:8443/', 'https://user:pw@example.com/', 'https://metadata.google.internal/', 'https://intranet/']) {
    const r = await sc._handler(ev(u), { store: mk(), lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: () => { throw new Error('must not connect'); } });
    check(`R19 ${u} refused before any connection`, r.statusCode === 400, r.body);
  }
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '64:ff9b::a00:1', '2002:a00:1::1', '::ffff:10.0.0.1']) {
    let connected = false;
    const r = await sc._handler(ev('https://public-looking-name.com/'), { store: mk(), lookup: async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }], request: () => { connected = true; throw new Error('connected'); } });
    check(`R19 DNS answer ${ip} → blocked, no connection`, !connected && JSON.parse(r.body).found !== true, r.body);
  }
  let lookups = 0, pinnedTo = '';
  const { EventEmitter } = await import('node:events');
  await sc._handler(ev('https://rebind-me.com/'), { store: mk(), lookup: async () => { lookups++; return lookups === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]; },
    request: (opts, cb) => { const req = new EventEmitter(); req.destroy = () => {}; req.end = () => opts.lookup(opts.hostname, {}, (e, addr) => { pinnedTo = addr; const res = new EventEmitter(); res.statusCode = 404; res.headers = {}; res.destroy = () => {}; cb(res); }); return req; } });
  check('R19 rebinding: one DNS resolution, the socket is pinned to the validated address', lookups === 1 && pinnedTo === '93.184.216.34', `lookups=${lookups} pinned=${pinnedTo}`);
});

// ======================================================================================= R20
await test('R20 Registry: the signature verifies against the exact intent and the deployed launch', async () => {
  setFlags({ registry: true });
  const { c, page } = await newPage();
  await ready(page, { name: 'Registry Proof', symbol: 'RGP', fee: 'creator' });
  await launchAndWait(page);
  const live = await txt(page, 'liveStatus');
  check('R20 launch published to the Registry after server-side on-chain verification', /SyncNet Registry: VERIFIED and published/.test(live), live.slice(-300));
  const rec = (await recordsOf(page)).find((x) => POST.has(x.state));
  const proof = await page.evaluate((id) => window.SyncNetRecords.toProof(JSON.parse(localStorage.getItem('syncnet_launch_records_v1')).find((r) => r.id === id)), rec.id);
  const rpcFor = Chain.makeRpc('https://rpc.mainnet.chain.robinhood.com/', { timeoutMs: 5000, retries: 0 });
  const good = await Chain.verifyEvidence(rpcFor, proof);
  check('R20 proof verifies: intent→recordHash→salt, deployer signature, salt in tx, TokenLaunched, factory record', good.status === 'VERIFIED' && ['record-hash', 'salt', 'signature', 'tx-salt', 'tx-launched', 'factory-record', 'factory-markets', 'token-metadata'].every((id) => good.checks.find((x) => x.id === id)?.ok), good.checks.filter((x) => !x.ok).map((x) => x.label).join('; '));
  const tamper = async (label, mutate) => { const p = JSON.parse(JSON.stringify(proof)); mutate(p); const r = await fetch(BASE + '/api/registry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proof: p }) }); const j = await r.json().catch(() => ({})); check(`R20 tampered proof rejected: ${label}`, r.status === 422 || r.status === 400, r.status + ' ' + JSON.stringify(j).slice(0, 160)); };
  serverState.fixedIp = null;
  await tamper('intent JSON edited (name changed)', (p) => { const i = JSON.parse(p.intentJson); i.name = 'Something Else'; p.intentJson = JSON.stringify(i); });
  await tamper('another token claimed with the same evidence', (p) => { p.token = A.SYNCAT.toLowerCase(); });
  await tamper('signature by another wallet', (p) => { const t = p.signature.typedData; p.signature.signature = Core._internal.secp256k1.sign(Core.hashTypedData(t), '0x' + '11'.repeat(32)); });
  await tamper('deployer swapped', (p) => { p.deployer = A.WALLET2.toLowerCase(); });
  await tamper('tx hash of an unrelated transaction', (p) => { p.txHash = '0x' + 'ab'.repeat(32); });
  await tamper('salt not matching recordHash', (p) => { p.salt = '0x' + '00'.repeat(31) + '01'; });
  await page.goto(BASE + '/registry.html'); await page.waitForFunction(() => /\d/.test(document.getElementById('registryVerifiedCount').textContent), null, { timeout: 20000 }); await page.waitForTimeout(800);
  const grid = await txt(page, 'registryGrid');
  check('R20 Registry page shows BUILT WITH SYNCNET · VERIFIED with what was verified', /BUILT WITH SYNCNET · VERIFIED/.test(grid) && /Deployer signature over the intent/.test(grid) && /Launch transaction carried the committed salt/.test(grid) && (await txt(page, 'registryVerifiedCount')) === '1');
  check('R20 local record listed separately as THIS BROWSER ONLY · NOT PUBLIC', /THIS BROWSER ONLY · NOT PUBLIC/.test(await txt(page, 'localRegistryGrid')) && !/BUILT WITH SYNCNET/.test(await txt(page, 'localRegistryGrid')));
  await page.goto(BASE + '/project/' + rec.predicted); await page.waitForFunction(() => !/CHECKING/.test(document.getElementById('tokenTitle').textContent)); await page.waitForTimeout(800);
  const t = await txt(page, 'tokenCard');
  check('R20 project page: BUILT WITH SYNCNET · VERIFIED with EXPECTED / ACTUAL / VERIFIED evidence', /BUILT WITH SYNCNET · VERIFIED/.test(t) && /Expected \(signed intent\)/.test(t) && /Actual \(on-chain\)/.test(t) && /✓ VERIFIED/.test(t));
  setFlags();
  await c.close();
});

// ======================================================================================= R21
await test('R21 the wallet request equals the immutable final review exactly', async () => {
  const { c, page } = await newPage();
  await founder(page); await project(page, { name: 'Final Review', symbol: 'FINR', fee: 'creator', tax: '250' });
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.05'); await page.click('#tab-4');
  await connect(page); await simulate(page); await guardDone(page); await sign(page);
  const rows = await page.$$eval('#finalReview .final-grid > div', (ds) => Object.fromEntries(ds.map((d) => [d.querySelector('dt').textContent, d.querySelector('dd').textContent])));
  const need = ['Network', 'Wallet (deployer)', 'Predicted token address', 'Name', 'Ticker', 'Markets', 'Creator-fee destination', 'Creator tax', 'PAR base fee', 'Protocol share of the base fee', 'Pool fee (every market)', 'PAR launch fee', 'Opening buy', 'Total value sent from your wallet', 'Intent recordHash', 'Signed intent'];
  check('R21 final review lists every required field', need.every((k) => rows[k]), need.filter((k) => !rows[k]).join(', '));
  check('R21 network line says MAINNET · REAL FUNDS', /MAINNET · REAL FUNDS/.test(rows.Network));
  await confirm(page, 'FINR');
  await page.click('#launchLive'); await waitText(page, 'liveStatus', /LIVE LAUNCH CONFIRMED|NEEDS ATTENTION/, 60000);
  const sent = await page.evaluate(() => window.__sentTx);
  const wei = (rows['Total value sent from your wallet'].match(/\((\d+) wei\)/) || [])[1];
  check('R21 value sent = value in the final review', wei && BigInt(sent.value) === BigInt(wei), `${sent.value} vs ${wei}`);
  check('R21 target = router named in the review', rows.Transaction.toLowerCase().includes(String(sent.to).toLowerCase()));
  check('R21 calldata hash = the one in the review', rows.Calldata.includes(Core.keccak256(sent.data).slice(0, 18)));
  const d = Core.decodeLaunchCalldata(sent.data);
  check('R21 calldata fields = review (name, ticker, tax, recipient, salt)', d.params.name === rows.Name && '$' + d.params.symbol === rows.Ticker && rows['Creator tax'] === '2.5%' && rows['Creator-fee destination'].toLowerCase().includes(d.params.creatorFeeRecipient) && d.params.salt === rows['PAR salt']);
  check('R21 no token approval was ever requested', !(await page.evaluate(() => (window.__walletCalls || []).some((m) => /approve|permit/i.test(m)))) && !chain.sent.some((t) => /^0x095ea7b3|^0xd505accf/.test(t.data)));
  await c.close();
});

// ======================================================================================= R22
await test('R22 two tabs, same wallet and ticker: the second tab cannot launch after the first one completed', async () => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await installRoutes(c);
  const a = await c.newPage(), b = await c.newPage();
  for (const p of [a, b]) { p.on('dialog', (d) => d.accept()); await founder(p); await project(p, { name: 'Two Tabs', symbol: 'TWO' }); await connect(p); await simulate(p); await guardDone(p); await sign(p); await confirm(p, 'TWO'); }
  check('R22 both tabs are ready to launch', await a.locator('#launchLive').isEnabled() && await b.locator('#launchLive').isEnabled());
  await a.click('#launchLive'); await waitText(a, 'liveStatus', /LIVE LAUNCH CONFIRMED/, 60000);
  await b.click('#launchLive'); await waitText(b, 'liveStatus', /Nothing was sent|appeared since your review/, 60000);
  check('R22 tab B is refused at send time (launch appeared since its review)', /appeared since your review|just recorded/.test(await b.textContent('#liveStatus')), (await b.textContent('#liveStatus')).slice(0, 200));
  check('R22 exactly one launch transaction in total', chain.sent.length === 1 && chain.tokens.size === 1);
  await c.close();
});

// ======================================================================================= R23
await test('R23 imported evidence never shows as verified until the chain confirms it', async () => {
  const { c, page } = await newPage();
  await page.goto(BASE + '/launches.html');
  // the import listener is attached right before the first render() paints this heading —
  // setting the file any earlier loses the change event for good (the flake this replaces)
  await page.waitForFunction(() => /LAUNCH RECORDS IN THIS BROWSER/.test(document.getElementById('recordsPanel')?.textContent || ''), null, { timeout: 20000 });
  const fake = { schema: 'syncnet.launch.records.v1', records: [{ id: '0x' + 'ab'.repeat(32), state: 'FULLY_VERIFIED', chainId: 4663, deployer: A.WALLET, predicted: '0x' + 'cd'.repeat(20), symbol: 'FAKEV', name: 'Fake Verified', txHash: '0x' + 'ef'.repeat(32), recordHash: '0x' + 'ab'.repeat(32), salt: '0x' + '01'.repeat(32), intentJson: '{}', verification: { onchain: { status: 'verified' } }, registry: { status: 'VERIFIED · PUBLISHED' }, history: [] }] };
  const f = path.join(ROOT, 'tests/regression/.tmp-import.json'); fs.writeFileSync(f, JSON.stringify(fake));
  await page.setInputFiles('#importFile', f);
  // the temp file is deleted only AFTER the page has read it: Chromium backs the input with the path,
  // so an immediate unlink makes f.text() fail with "file not found" whenever the read is lazy
  await page.waitForFunction(() => /imported/.test(document.getElementById('importStatus').textContent), null, { timeout: 20000 }); await page.waitForTimeout(1500);
  fs.unlinkSync(f);
  const r = (await recordsOf(page)).find((x) => x.symbol === 'FAKEV');
  check('R23 imported "FULLY_VERIFIED" claim is neutralised (BROADCAST_UNKNOWN after the chain check)', r && r.state === 'BROADCAST_UNKNOWN' && r.importedState === 'FULLY_VERIFIED' && !r.verification && !r.registry, r && r.state);
  check('R23 MY LAUNCHES does not display it as verified', !/FULLY VERIFIED|ONCHAIN VERIFIED/.test(await page.locator('.record-card').filter({ hasText: 'FAKEV' }).first().textContent()));
  await page.goto(BASE + '/registry.html'); await page.waitForFunction(() => /\d/.test(document.getElementById('registryCount').textContent), null, { timeout: 20000 }); await page.waitForTimeout(500);
  check('R23 Registry: not counted, not public, not verified', !/FAKEV/.test(await page.textContent('#registryGrid')) && /THIS BROWSER ONLY · NOT PUBLIC/.test(await page.textContent('#localRegistryGrid')) && !/BUILT WITH SYNCNET/.test(await page.textContent('#localRegistryGrid')));
  await c.close();
});

// ======================================================================================= R24
await test('R24 wallet disconnect (accountsChanged [] and EIP-1193 disconnect) resets everything; reconnect works', async () => {
  const { c, page } = await newPage();
  await ready(page, { name: 'Disconnect', symbol: 'DISC' });
  check('R24 ready to launch before the disconnect', await page.locator('#launchLive').isEnabled());
  const reset = async (label) => {
    await page.waitForTimeout(400);
    check(`R24 ${label}: wallet shown as not connected`, /Not connected/.test(await txt(page, 'walletName')), await txt(page, 'walletName'));
    check(`R24 ${label}: simulation reset`, /not run yet/.test(await txt(page, 'simStatus')), (await txt(page, 'simStatus')).slice(0, 120));
    check(`R24 ${label}: signature reset`, /NOT SIGNED/.test(await txt(page, 'checkIntentSignature')));
    check(`R24 ${label}: final review removed and LAUNCH LIVE disabled`, await page.locator('#finalReview').isHidden() && await page.locator('#launchLive').isDisabled());
  };
  await page.evaluate(() => window.__mockSetAccount(''));
  await reset('accountsChanged []');
  await connect(page); await simulate(page); await guardDone(page); await sign(page); await confirm(page, 'DISC');
  check('R24 reconnect → simulate → sign re-enables LAUNCH LIVE', await page.locator('#launchLive').isEnabled(), await txt(page, 'launchBlockers'));
  await page.evaluate(() => window.__mockEmit('disconnect', { code: 4900, message: 'disconnected' }));
  await reset('disconnect event');
  check('R24 nothing was ever sent', (await calls(page, 'eth_sendTransaction')) === 0 && chain.sent.length === 0);
  check('R24 no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

// ======================================================================================= R25
await test('R25 hostile HTML in token metadata renders as inert text on every page (launch → project → registry → map)', async () => {
  setFlags({ registry: true }); // the launch is also published to the server Registry, so that card path renders it too
  const { c, page } = await newPage();
  const NAME = '<img src=x onerror=window.__xss=1>';
  const DESC = '<script>window.__xss=2</script><img src=x onerror="window.__xss=3"> hostile <b>bold</b>';
  await ready(page, { name: NAME, symbol: 'XSSX', description: DESC });
  const live = await launchAndWait(page);
  check('R25 launch with hostile metadata confirmed (the text policy allows < > as ordinary characters)', /LIVE LAUNCH CONFIRMED/.test(live), live.slice(0, 200));
  const rec = (await recordsOf(page)).find((r) => r.symbol === 'XSSX');
  // Each page must render the hostile token (so the probe is meaningful) and must render it as text only.
  const probe = async (label, shown, what) => {
    const r = await page.evaluate(() => ({ xss: window.__xss || 0, imgs: document.querySelectorAll('img[src="x"]').length, bold: [...document.querySelectorAll('b')].filter((b) => b.textContent === 'bold').length, text: document.body.innerText }));
    check(`R25 ${label}: no injected element, no script ran`, r.xss === 0 && r.imgs === 0 && r.bold === 0, JSON.stringify({ xss: r.xss, imgs: r.imgs, bold: r.bold }));
    check(`R25 ${label}: the hostile token is rendered (${what}) as plain text`, shown.test(r.text), r.text.slice(0, 200));
  };
  const NAME_TEXT = /<img src=x onerror=window\.__xss=1>/, TICKER = /\$XSSX/;
  await probe('builder (review, final review, status)', NAME_TEXT, 'name');
  const token = rec && rec.predicted;
  for (const [label, url, shown, what] of [['project page', '/project/' + token, NAME_TEXT, 'name'], ['MY LAUNCHES', '/launches.html', TICKER, 'ticker'], ['Registry', '/registry.html', NAME_TEXT, 'name'], ['map', '/network.html?token=' + token, TICKER, 'ticker'], ['home map', '/?token=' + token, TICKER, 'ticker']]) {
    await page.goto(BASE + url); await page.waitForTimeout(2500);
    await probe(label, shown, what);
  }
  check('R25 no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

// ======================================================================================= R26 (IPFS hotfix)
await test('R26 reported false negative: the browser cannot load the pinned image, the server-side IPFS check can → preflight PASS', async () => {
  const { c, page } = await newPage();
  await c.route(/https:\/\/(gateway\.pinata\.cloud|ipfs\.io|dweb\.link)\/.*/, (r) => r.abort('blockedbyclient')); // every browser <img> gateway load fails, as reported
  const checks = []; page.on('request', (q) => { if (q.url().includes('/api/ipfs-check')) checks.push(q.url()); });
  await founder(page); await project(page, { name: 'Ipfs Hotfix', symbol: 'IPFSH' }); await connect(page);
  const sim = await simulate(page);
  check('R26 metadata preflight PASS although the browser cannot load the image from either gateway', /Metadata preflight: PASS ✓/.test(sim), sim.slice(-300));
  if (!/Metadata preflight: PASS ✓/.test(sim)) { await c.close(); return; } // BEFORE the hotfix this is where the launch was blocked
  await guardDone(page); await sign(page); await confirm(page, 'IPFSH');
  check('R26 the preflight asked the same-origin server check for exactly the logo URI', checks.length >= 1 && checks.every((u) => new URL(u).searchParams.get('uri') === 'ipfs://' + TEST_CID), checks.join(' | '));
  check('R26 the server fetched the CID from a public gateway', serverState.gatewayHits.some((h) => h === 'ipfs.io/ipfs/' + TEST_CID || h.startsWith(TEST_CID.toLowerCase() + '.ipfs.dweb.link')), serverState.gatewayHits.join(' | '));
  await page.waitForFunction(() => /IMAGE UNAVAILABLE/.test(document.getElementById('logoPreview').textContent), null, { timeout: 20000 }).catch(() => {});
  check('R26 the browser preview stays a non-blocking preview (IMAGE UNAVAILABLE after every gateway failed)', /IMAGE UNAVAILABLE/.test(await txt(page, 'logoPreview')), await txt(page, 'logoPreview'));
  check('R26 metadata check PASS and LAUNCH LIVE enabled after the other steps', /PASS/.test(await txt(page, 'checkMetadata')) && await page.locator('#launchLive').isEnabled(), await txt(page, 'launchBlockers'));
  const live = await launchAndWait(page);
  check('R26 the launch completes and verifies on-chain (logo = the checked URI)', /LIVE LAUNCH CONFIRMED/.test(live) && chain.lastLaunchCall.params.logo === 'ipfs://' + TEST_CID, live.slice(0, 160));
  await c.close();
});

// ======================================================================================= R27 (IPFS hotfix)
await test('R27 LAUNCH LIVE stays blocked unless the server-side IPFS check passes (even when the browser can load the image)', async () => {
  const { c, page } = await newPage(); // browser gateway routes serve a PNG: a browser-side check would pass
  await founder(page); await project(page, { name: 'Ipfs Block', symbol: 'IPFSB' }); await connect(page);
  const blocked = async (label, re) => {
    const sim = await simulate(page);
    check(`R27 ${label}: metadata preflight FAILED with a clear reason`, re.test(sim), sim.slice(-260));
    check(`R27 ${label}: metadata check shows FAIL, signing disabled, LAUNCH LIVE disabled`, /FAIL/.test(await txt(page, 'checkMetadata')) && await page.locator('#signIntent').isDisabled() && await page.locator('#launchLive').isDisabled() && /metadata preflight must pass/.test(await txt(page, 'launchBlockers')), await txt(page, 'launchBlockers'));
  };
  serverState.gateways = { pinata: 'down', ipfs: 'down', dweb: 'down' };
  await blocked('all server-side gateways down', /Metadata preflight: FAILED — .*could not retrieve the pinned image/);
  serverState.gateways = { pinata: 'html', ipfs: 'html', dweb: 'html' };
  await blocked('gateways answer with an HTML page', /Metadata preflight: FAILED — .*not a PNG, JPEG, GIF or WebP image/);
  serverState.gateways = { pinata: 'ok', ipfs: 'ok', dweb: 'ok' };
  await page.click('#tab-1'); await page.fill('#logo', 'ipfs://bafytestcid'); await page.click('#tab-4'); // passes the page's ipfs:// shape check, is not a CID
  await blocked('logo is not a valid CID', /Metadata preflight: FAILED — .*not a valid ipfs:\/\/ CID/);
  check('R27 nothing was sent while blocked', (await calls(page, 'eth_sendTransaction')) === 0 && chain.sent.length === 0);
  await page.click('#tab-1'); await page.fill('#logo', 'ipfs://' + TEST_CID); await page.click('#tab-4');
  const sim = await simulate(page); await guardDone(page); await sign(page); await confirm(page, 'IPFSB');
  check('R27 once the server check passes, the same page recovers: PASS and LAUNCH LIVE enabled', /Metadata preflight: PASS ✓/.test(sim) && await page.locator('#launchLive').isEnabled(), await txt(page, 'launchBlockers'));
  await c.close();
});

// ======================================================================================= R28 (IPFS follow-up hotfix)
await test('R28 live report: ipfs.io and dweb.link answer 429, gateway.pinata.cloud serves the pin → preflight PASS, launch possible', async () => {
  const { c, page } = await newPage();
  await founder(page); await project(page, { name: 'Pinata Gateway', symbol: 'PGW' }); await connect(page);
  serverState.gateways = { pinata: 'ok', ipfs: '429', dweb: '429' };
  const sim = await simulate(page);
  check('R28 metadata preflight PASS with both public gateways rate-limited', /Metadata preflight: PASS ✓/.test(sim), sim.slice(-260));
  check('R28 the server tried Pinata and both public gateways', ['gateway.pinata.cloud/ipfs/', 'ipfs.io/ipfs/', 'dweb.link/ipfs/'].every((p) => serverState.gatewayHits.some((h) => h.startsWith(p))), serverState.gatewayHits.join(' | '));
  await guardDone(page); await sign(page); await confirm(page, 'PGW');
  check('R28 LAUNCH LIVE enabled after the other steps', await page.locator('#launchLive').isEnabled(), await txt(page, 'launchBlockers'));
  serverState.gateways = { pinata: '429', ipfs: '429', dweb: '429' };
  await page.click('#tab-1'); await page.fill('#logo', 'ipfs://' + cidFor(Buffer.from('another pinned logo'))); await page.click('#tab-4'); // a CID not yet passed (passes are cached 10 min)
  const sim2 = await simulate(page);
  check('R28 all three gateways 429 → preflight FAILED and LAUNCH LIVE blocked', /Metadata preflight: FAILED/.test(sim2) && await page.locator('#launchLive').isDisabled(), sim2.slice(-200));
  await c.close();
});

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-regressions.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} regression checks passed`);
process.exit(failures ? 1 : 0);
