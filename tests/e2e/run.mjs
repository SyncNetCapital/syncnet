import { startServer, installRoutes, A, chain, resetChain, resetServer, setFlags, serverState, ROOT, rpcStats, FOUNDER_KEY, TEST_CID } from './harness.mjs';
import path from 'node:path';
import fs from 'node:fs';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const BASE = 'http://localhost:8931';
const results = []; let failures = 0;
const recordsOf = (page, ns = 'syncnet_') => page.evaluate((ns) => JSON.parse(localStorage.getItem(ns + 'launch_records_v1') || '[]'), ns);
const DEPLOYED = ['MINED', 'ONCHAIN_VERIFIED', 'INDEXER_PENDING', 'FULLY_VERIFIED'];
async function waitGuard(page) { await page.waitForFunction(() => /PASS|BLOCKED|EXISTS|WARN/.test(document.getElementById('checkDuplicate').textContent) && !/SIMULATING/.test(document.getElementById('runSimulation').textContent), null, { timeout: 20000 }); }
const SHOTS = process.env.SHOTS || '';
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail }); if (!cond) { failures++; console.log('FAIL', name, detail); } else console.log('ok  ', name); }
const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function suite(name, fn) { if (only && !only.test(name)) return; console.log('\n# ' + name); try { await fn(); } catch (e) { failures++; console.log('FAIL (exception)', name, e.stack || e); } }

const srv = await startServer();
const browser = await chromium.launch();
async function ctx(opts = {}) { const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts }); await installRoutes(c); return c; }
function trackErrors(page) { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return errs; }
const inViewport = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; const r = el.getBoundingClientRect(); return r.top >= -2 && r.top < innerHeight * 0.6 && r.bottom > 0; }, sel);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };

// ---------------- MAP UX ----------------
await suite('network map UX (moved from the old home)', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/network.html'); // the token mapper moved from / to Network (Phase 2 IA)
  await page.fill('#tokenSearch', 'SYNCAT'); await page.click('#mapToken');
  await page.waitForFunction(() => /SYNCAT/.test(document.getElementById('topologyTitle').textContent));
  await page.waitForTimeout(900);
  check('network: mapper result visible', await page.locator('#topologyTitle').isVisible());
  check('home: topology title in viewport after MAP', await inViewport(page, '#topologyTitle'));
  check('home: page scrolled', (await page.evaluate(() => scrollY)) > 150);
  check('home: focus moved to result heading', await page.evaluate(() => document.activeElement?.id === 'topologyTitle'));
  check('home: SYNCAT direct markets rendered', /CASHCAT/.test(await page.textContent('#topologyGraph')));
  check('home: sync-with action points at token', (await page.getAttribute('#buildAround', 'href')).includes(A.SYNCAT));
  await shot(page, 'home-mapped');
  // ambiguous ticker → chooser, no silent pick
  await page.evaluate(() => scrollTo(0, 0));
  await page.fill('#tokenSearch', 'PONS'); await page.press('#tokenSearch', 'Enter');
  await page.waitForSelector('#searchMatches [data-map-address]');
  const n = await page.locator('#searchMatches [data-map-address]').count();
  check('home: ambiguous PONS shows chooser', n >= 2, 'matches=' + n);
  check('home: chooser focused', await page.evaluate(() => Boolean(document.activeElement?.closest('#searchMatches'))));
  check('home: collision warning shown', /share this ticker/.test(await page.textContent('#searchMatches')));
  await shot(page, 'home-ambiguous');
  await page.locator('#searchMatches [data-map-address]').first().click();
  await page.waitForFunction(() => /PONS/.test(document.getElementById('topologyTitle').textContent));
  await page.waitForTimeout(800);
  check('home: choosing a match maps it and scrolls', await inViewport(page, '#topologyTitle'));
  // no match
  await page.evaluate(() => scrollTo(0, 0));
  await page.fill('#tokenSearch', 'ZZQQXX'); await page.click('#mapToken');
  await page.waitForFunction(() => /No indexed/.test(document.getElementById('searchStatus').textContent));
  check('home: no-match status is visible', await page.evaluate(() => { const r = document.getElementById('searchStatus').getBoundingClientRect(); return r.top > 0 && r.bottom < innerHeight; }));
  check('home: no-match status marked fail', (await page.getAttribute('#searchStatus', 'class')).includes('fail'));
  // empty input
  await page.fill('#tokenSearch', ''); await page.click('#mapToken');
  check('home: empty input keeps focus in search', await page.evaluate(() => document.activeElement?.id === 'tokenSearch'));
  // contract lookup is authoritative
  await page.fill('#tokenSearch', A.PONS); await page.click('#mapToken');
  await page.waitForFunction(() => /PONS/.test(document.getElementById('topologyTitle').textContent));
  check('home: contract lookup maps directly (no chooser)', (await page.locator('#searchMatches [data-map-address]').count()) === 0);
  // bidi/absurd metadata stays bounded
  await page.fill('#tokenSearch', A.SYNC); await page.click('#mapToken');
  await page.waitForFunction(() => /SYNC/.test(document.getElementById('topologyTitle').textContent) && !/MAPPING/.test(document.getElementById('topologyTitle').textContent));
  await page.waitForTimeout(400);
  const txt = await page.textContent('#topologyGraph');
  check('home: bidi characters stripped from rendered graph', !/[\u202a-\u202e\u200b]/.test(txt));
  check('home: no horizontal overflow after absurd metadata', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('home: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

await suite('network map UX · reduced motion + race', async () => {
  const c = await ctx({ reducedMotion: 'reduce' }); const page = await c.newPage();
  await page.goto(BASE + '/network.html'); // the token mapper moved from / to Network (Phase 2 IA)
  await page.fill('#tokenSearch', A.SYNCAT); await page.click('#mapToken');
  const y = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(scrollY))));
  check('reduced-motion: jump is immediate (no smooth scroll)', y > 150, 'y=' + y);
  // two rapid requests: last one wins
  await page.fill('#tokenSearch', A.PONS); await page.evaluate(() => document.getElementById('mapToken').click());
  await page.fill('#tokenSearch', A.SYNC); await page.evaluate(() => { const b = document.getElementById('mapToken'); b.disabled = false; b.click(); });
  await page.waitForTimeout(1500);
  check('race: last MAP request wins', /\$SYNC/.test(await page.textContent('#topologyTitle')) && !/PONS/.test(await page.textContent('#topologyTitle')));
  await c.close();
});

await suite('map page', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/network.html');
  check('map page: button says MAP', (await page.textContent('#mapToken')).trim() === 'MAP');
  await page.fill('#tokenSearch', 'syncat'); await page.click('#mapToken');
  await page.waitForFunction(() => /SYNCAT/.test(document.getElementById('topologyTitle').textContent));
  await page.waitForTimeout(900);
  check('map page: result in viewport', await inViewport(page, '#topologyTitle'));
  await page.goto(BASE + '/network.html?token=' + A.PONS);
  await page.waitForFunction(() => /PONS/.test(document.getElementById('topologyTitle').textContent));
  await page.waitForTimeout(900);
  check('map page: ?token= arrival shows the result', await inViewport(page, '#topologyTitle'));
  check('map page: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ---------------- BUILDER · public ----------------
const VISIBLE_TEXT = (page) => page.evaluate(() => document.body.innerText);
await suite('builder public', async () => {
  resetServer(); resetChain();
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/build.html');
  const all = await page.evaluate(() => { document.querySelectorAll('.step-panel').forEach((p) => (p.hidden = false)); document.querySelectorAll('details').forEach((d) => (d.open = true)); const t = document.body.innerText; document.querySelectorAll('.step-panel').forEach((p, i) => (p.hidden = i !== 0)); return t; });
  for (const bad of [/canary/i, /PINATA/, /SYNCNET_[A-Z_]+/, /upload (access )?key/i, /operator key/i, /\?live=/, /environment variable/i])
    check('public builder never shows ' + bad, !bad.test(all));
  check('public: every [hidden] element is really hidden (root cause of leaked canary UI)', await page.evaluate(() => [...document.querySelectorAll('[hidden]')].every((e) => getComputedStyle(e).display === 'none')));
  check('public: no upload retry/key controls visible', await page.locator('#uploadLogo').isHidden());
  check('public: founder gate hidden', await page.locator('#canaryGate').isHidden());
  check('public: live panel hidden', await page.locator('#liveCanary').isHidden());
  check('public: image control reads UPLOAD PROJECT IMAGE', /UPLOAD PROJECT IMAGE/.test(await page.textContent('#logoPick')));
  check('public: file input has accessible name', (await page.evaluate(() => document.getElementById('logoFile').labels.length + (document.getElementById('logoFile').getAttribute('aria-labelledby') ? 1 : 0))) > 0);
  await page.setInputFiles('#logoFile', path.join(ROOT, 'tests/e2e/fixture-exif.jpg'));
  await page.waitForFunction(() => /Image ready/.test(document.getElementById('logoStatus').textContent));
  check('public (uploads closed): honest non-technical message', /when live launching opens/.test(await page.textContent('#logoStatus')));
  check('public: local preview shown', await page.locator('#logoPreview img').count() === 1);
  check('public (uploads closed): nothing uploaded', serverState.pins.length === 0);
  await shot(page, 'build-step1-public');
  // uploads open publicly (server-side gate) → wallet-signed, rate-limited, server re-encoded
  setFlags({ publicUploads: true });
  await page.reload();
  await page.setInputFiles('#logoFile', path.join(ROOT, 'tests/e2e/fixture-exif.jpg'));
  await page.waitForSelector('#walletModal.open', { timeout: 10000 }); await page.waitForTimeout(150);
  check('public (uploads open): upload asks for the wallet first (uploads are tied to a wallet)', /Connect your wallet first/.test(await page.textContent('#logoStatus')));
  check('wallet modal focus inside', await page.evaluate(() => Boolean(document.activeElement?.closest('#walletModal'))), await page.evaluate(() => document.activeElement?.outerHTML?.slice(0, 80)));
  await page.click('#providerList button');
  await page.waitForFunction(() => /Uploaded/.test(document.getElementById('logoStatus').textContent), null, { timeout: 20000 });
  check('public (uploads open): wallet signed a free upload sign-in (personal_sign, no transaction)', await page.evaluate(() => (window.__walletCalls || []).includes('personal_sign') && !(window.__walletCalls || []).includes('eth_sendTransaction')));
  check('public (uploads open): logo URI set to ipfs', /^ipfs:\/\/bafkrei[a-z2-7]+$/.test(await page.inputValue('#logo')));
  check('upload normalised to PNG', serverState.pins.at(-1)?.type === 'image/png');
  check('upload has no EXIF or text chunks after server re-encoding', serverState.pins.at(-1)?.hasExif === false && serverState.pins.at(-1)?.hasText === false);
  check('upload pinned with the scoped server credential only', serverState.pins.at(-1)?.auth === 'Bearer test-pinata-jwt' && serverState.pins.at(-1)?.meta?.keyvalues?.source === 'wallet');
  check('redundant pin requested at the secondary pinning service', serverState.secondary.length === 1 && serverState.secondary[0].cid === serverState.pins.at(-1).cid);
  setFlags();
  // step 1
  await page.fill('#name', 'PONSYNC'); await page.fill('#symbol', 'ponsync');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#panel-1 [data-next]');
  check('step 2 visible after next', await page.locator('#panel-2').isVisible());
  check('panel 1 hidden (tabpanel semantics)', await page.locator('#panel-1').isHidden());
  // connections
  await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
  await page.fill('#customAsset', A.PONS); await page.click('#checkAdd');
  await page.waitForFunction(() => /PONS ready/.test(document.getElementById('assetStatus').textContent));
  await page.fill('#customAsset', A.NOCODE); await page.click('#checkAdd');
  await page.waitForFunction(() => document.getElementById('assetStatus').className.includes('fail'));
  check('no-contract address rejected', /No contract/.test(await page.textContent('#assetStatus')));
  check('two connections selected', /2 connections/.test(await page.textContent('#quoteCount')));
  check('connection insight no longer assumes holder mode', !/fees-to-holders/.test(await page.textContent('#connectionInsight')));
  await page.fill('[data-intent-address="' + A.PONS.toLowerCase() + '"]', 'PONS community bridge');
  await page.click('#panel-2 [data-next]');
  // fees
  await page.click('[data-tax="250"]');
  check('total fee shown explicitly (1% + 2.5%)', (await page.textContent('#feeTotalPct')).trim() === '3.5%');
  check('creator share shown (0.5% + 2.5%)', (await page.textContent('#feeCreatorPct')).trim() === '3%');
  await page.click('#panel-3 [data-next]');
  check('fee destination required (no default forced)', await page.locator('#panel-3').isVisible());
  await shot(page, 'build-step3-fees');
  for (const mode of ['holders', 'burn', 'floor', 'creator']) {
    await page.check(`input[name="feeMode"][value="${mode}"]`);
    const d = await page.textContent('#feeModeDetail');
    check(`fee mode ${mode}: explanation rendered`, d.length > 80);
    if (mode === 'holders') check('holders: payout assets listed', /PONS, SYNC and PONSYNC|SYNC, PONS and PONSYNC/.test(d), d);
    if (mode !== 'creator') check(`${mode}: says right cannot follow operator`, /cannot follow|nothing to hand over/.test(d));
  }
  check('creator: recipient field shown', await page.locator('#creatorRecipientWrap').isVisible());
  check('creator: explains on-chain transferability', /transfer this right on-chain/.test(await page.textContent('#feeModeDetail')));
  check('never claims token contract is transferable', !/token contract (is|becomes) transferable/i.test(await VISIBLE_TEXT(page)));
  await page.fill('#creatorRecipient', '0x123'); await page.click('#panel-3 [data-next]');
  check('invalid creator recipient blocks review', await page.locator('#panel-3').isVisible());
  await page.fill('#creatorRecipient', '');
  await page.click('#panel-3 [data-next]');
  check('review visible', await page.locator('#panel-4').isVisible());
  check('review shows creator mode', /CREATOR \/ OPERATOR WALLET/.test(await page.textContent('#reviewRewards')));
  check('review trade fee', /3\.5% per trade/.test(await page.textContent('#reviewTradeFee')));
  // simulate
  // The wallet was connected by the upload sign-in above; the simulation uses it directly.
  check('wallet stays connected after the upload sign-in', /…/.test(await page.textContent('#walletName')));
  await page.click('#runSimulation');
  await page.waitForFunction(() => /SIMULATION PASSED|No transaction was sent/.test(document.getElementById('simStatus').textContent), null, { timeout: 20000 });
  const sim = await page.textContent('#simStatus');
  check('simulation passed', /SIMULATION PASSED/.test(sim), sim.slice(0, 300));
  check('sim: creator recipient = connected wallet in calldata', chain.lastLaunchCall?.params.creatorFeeRecipient.toLowerCase() === A.WALLET.toLowerCase());
  check('sim: tax 250 in calldata', Number(chain.lastLaunchCall?.params.creatorTaxBps) === 250);
  check('sim: two pair tokens', chain.lastLaunchCall?.pairTokens.length === 2);
  check('sim: public says live launching not open', /not open on this deployment/.test(sim));
  check('sim: salt commits to intent record', /SyncNet intent hash: 0x[0-9a-f]{64}/.test(sim));
  check('public: no eth_sendTransaction ever requested', !(await page.evaluate(() => (window.__walletCalls || []).includes('eth_sendTransaction'))));
  // holders mode → vault in calldata
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]'); await page.click('#tab-4');
  check('changing fee mode invalidates simulation', /not run yet/.test(await page.textContent('#simStatus')));
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent), null, { timeout: 20000 });
  check('sim: holders → HolderVault recipient', chain.lastLaunchCall?.params.creatorFeeRecipient.toLowerCase() === A.HOLDER.toLowerCase());
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="floor"]'); await page.click('#tab-4');
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent), null, { timeout: 20000 });
  check('sim: floor → FloorVault recipient', chain.lastLaunchCall?.params.creatorFeeRecipient.toLowerCase() === A.FLOOR.toLowerCase());
  // keyboard: arrow keys on tabs
  await page.focus('#tab-4'); await page.keyboard.press('ArrowLeft');
  check('keyboard: ArrowLeft moves to step 3', await page.evaluate(() => document.activeElement?.id === 'tab-3') && await page.locator('#panel-3').isVisible());
  await page.focus('input[name="feeMode"][value="floor"]'); await page.keyboard.press('ArrowUp');
  check('keyboard: radio group arrow selects burn', await page.evaluate(() => document.querySelector('input[name="feeMode"]:checked')?.value === 'burn'));
  await shot(page, 'build-fees-selected');
  check('builder: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ---------------- BUILDER · founder live canary ----------------
await suite('builder founder canary', async () => {
  resetServer(); resetChain();
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/build.html?live=canary');
  await page.click('#tab-4');
  check('founder: gate visible only with route', await page.locator('#canaryGate').isVisible());
  await page.fill('#canaryKey', 'wrong'); await page.click('#unlockCanary');
  await page.waitForFunction(() => /denied/i.test(document.getElementById('canaryAuthStatus').textContent));
  check('founder: wrong key denied, live panel still hidden', await page.locator('#liveCanary').isHidden());
  // image selected before unlock → kept as preview, uploaded after unlock with session token
  await page.click('#tab-1');
  await page.setInputFiles('#logoFile', path.join(ROOT, 'tests/e2e/fixture-exif.jpg'));
  await page.waitForFunction(() => /Image ready/.test(document.getElementById('logoStatus').textContent));
  await page.click('#tab-4');
  await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary');
  await page.waitForFunction(() => /Uploaded/.test(document.getElementById('logoStatus').textContent), null, { timeout: 20000 });
  check('founder: live panel unlocked', await page.locator('#liveCanary').isVisible());
  check('founder: upload used the founder session (no raw key in UI)', serverState.pins.length === 1 && serverState.pins[0].meta.keyvalues.source === 'founder');
  check('founder: banner switches to MAINNET · REAL FUNDS', /MAINNET · REAL FUNDS/.test(await page.textContent('#networkBanner')));
  check('founder: no upload-key input exists', await page.locator('#uploadAccessKey').count() === 0);
  await page.click('#tab-1'); await page.fill('#name', 'PONSYNC'); await page.fill('#symbol', 'PONSYNC'); await page.fill('#description', 'Canary');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
  await page.fill('#customAsset', A.PONS); await page.click('#checkAdd'); await page.waitForFunction(() => /PONS ready/.test(document.getElementById('assetStatus').textContent));
  await page.click('#tab-3'); await page.click('[data-tax="100"]'); await page.check('input[name="feeMode"][value="creator"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED|No transaction/.test(document.getElementById('simStatus').textContent), null, { timeout: 25000 });
  check('founder: sim + metadata preflight pass', /Metadata preflight: PASS/.test(await page.textContent('#simStatus')), (await page.textContent('#simStatus')).slice(0, 400));
  check('founder: launch locked before signature', await page.locator('#launchLive').isDisabled());
  await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED/.test(document.getElementById('checkIntentSignature').textContent));
  const typed = JSON.parse(await page.evaluate(() => window.__typed));
  check('founder: EIP-712 intent signs record hash + salt', /^0x[0-9a-f]{64}$/.test(typed.message.recordHash) && typed.message.salt === (chain.lastLaunchCall && '0x' + '') || /^0x[0-9a-f]{64}$/.test(typed.message.salt));
  // stale-edit guard
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]'); await page.click('#tab-4');
  check('founder: editing fee mode after signing re-locks launch', await page.locator('#launchLive').isDisabled() && /NOT SIGNED/.test(await page.textContent('#checkIntentSignature')));
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="creator"]'); await page.click('#tab-4');
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent), null, { timeout: 25000 });
  await waitGuard(page);
  await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED ✓/.test(document.getElementById('checkIntentSignature').textContent));
  check('founder: immutable final review shown after signing', await page.locator('#finalReview').isVisible() && /MAINNET · REAL FUNDS/.test(await page.textContent('#finalReview')));
  await page.fill('#liveConfirm', 'ponsync');
  check('founder: exact ticker alone does not unlock (final confirmation required)', await page.locator('#launchLive').isDisabled());
  await page.check('#finalAck');
  await page.fill('#liveConfirm', 'PONSYN');
  check('founder: wrong ticker keeps launch locked', await page.locator('#launchLive').isDisabled());
  await page.fill('#liveConfirm', 'ponsync');
  check('founder: exact ticker unlocks launch', await page.locator('#launchLive').isEnabled());
  await page.click('#launchLive');
  await page.waitForFunction(() => /LIVE LAUNCH CONFIRMED|WAS sent|No transaction/.test(document.getElementById('liveStatus').textContent), null, { timeout: 90000 });
  const live = await page.textContent('#liveStatus');
  check('founder: live launch confirmed + verified', /LIVE LAUNCH CONFIRMED/.test(live) && /factory record \+ markets \+ metadata: VERIFIED ✓/.test(live), live.slice(0, 500));
  const sent = await page.evaluate(() => window.__sentTx);
  check('founder: tx carries explicit chainId', sent?.chainId === '0x1237');
  const rec = (await recordsOf(page)).find((r) => DEPLOYED.includes(r.state));
  check('record: feeMode creator + recipient', rec?.expected?.feeMode === 'creator' && rec?.expected?.creatorFeeRecipient === A.WALLET.toLowerCase());
  check('record: intent record includes fee routing', rec?.intentRecord?.feeMode === 'creator' && rec?.intentRecord?.creatorFeeRecipient === A.WALLET.toLowerCase());
  check('record: on-chain verification stored', rec?.verification?.onchain?.status === 'verified' && rec.state === 'FULLY_VERIFIED');
  check('record: nothing left unresolved after verification', !(await recordsOf(page)).some((r) => ['BROADCAST_ATTEMPTED', 'BROADCAST_UNKNOWN', 'TX_HASH_RECEIVED'].includes(r.state)));
  check('after launch: simulation locked', await page.locator('#runSimulation').isDisabled());
  check('founder: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

await suite('builder founder · factory mismatch + recovery', async () => {
  resetChain(); chain.factoryOverride = A.EVIL;
  const c = await ctx(); const page = await c.newPage();
  await page.goto(BASE + '/build.html?live=canary');
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  await page.click('#tab-1'); await page.click('#panel-1 summary'); await page.fill('#logo', 'ipfs://' + TEST_CID);
  await page.fill('#name', 'MISMATCH'); await page.fill('#symbol', 'MISM');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent), null, { timeout: 25000 });
  await waitGuard(page);
  await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED ✓/.test(document.getElementById('checkIntentSignature').textContent));
  await page.check('#finalAck'); await page.fill('#liveConfirm', 'MISM'); await page.click('#launchLive');
  await page.waitForFunction(() => /NEEDS ATTENTION|CONFIRMED/.test(document.getElementById('liveStatus').textContent), null, { timeout: 90000 });
  const t = await page.textContent('#liveStatus');
  check('mismatch: factory record failure surfaced, tx hash kept', /VERIFICATION NEEDS ATTENTION/.test(t) && /MISMATCH in Creator-fee recipient/.test(t) && /Transaction: 0x/.test(t), t.slice(0, 300));
  check('mismatch: further launches locked', await page.locator('#runSimulation').isDisabled());
  check('mismatch: evidence export offered', await page.locator('#exportLaunchProof').isVisible());
  await page.goto(BASE + '/build.html'); await page.waitForTimeout(800);
  check('recovery: launch record visible without founder unlock', await page.locator('#launchRecords').isVisible() && /MISM/.test(await page.textContent('#launchRecords')) && /MINED/.test(await page.textContent('#launchRecords')));
  await c.close(); chain.factoryOverride = null;
});

// ---------------- MARKETPLACE V1 ----------------
// The full two-browser walkthrough (offer → deal → transfer → payment → completion) lives in
// tests/regression/rc-marketplace.mjs; this suite covers the page's claim/list core in the standard harness.
await suite('marketplace', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/marketplace.html'); await page.waitForTimeout(800);
  const body = await VISIBLE_TEXT(page);
  check('mp: production surface — no lab/local-test/simulated wording', !/MARKETPLACE LAB|LOCAL TEST|NO REAL PAYMENTS|SIMULAT|DEMO/i.test(body), (body.match(/.{0,40}(LAB|SIMULAT|DEMO).{0,40}/i) || [''])[0]);
  check('mp: non-custodial model stated on the page (hero + settlement card)', /SIGNED LISTINGS · VERIFIED HANDOVERS · NON-CUSTODIAL/.test(body) && /never holds funds/i.test(body) && /no escrow/i.test(body));
  check('mp: empty state is polished, with no fake listings seeded', /NO PROJECTS LISTED YET/.test(await page.textContent('#mp-listings')) && !(await page.$('.mp-listing-card')));
  // claim + list: wallet is the on-chain deployer AND the transferable fee recipient
  await page.click('#mpConnect'); await page.waitForTimeout(250);
  await page.click('[data-mp-view="sell"]');
  await page.fill('#mpToken', A.CREATORLIVE); await page.click('#mpCheckProject');
  await page.waitForFunction(() => /Evidence found/.test(document.getElementById('mpClaimStatus').textContent), null, { timeout: 15000 });
  check('mp: live PAR facts shown before any signature', /EXISTS · multi factory/.test(await page.textContent('#mpClaimFacts')) && /none recorded yet/.test(await page.textContent('#mpClaimFacts')));
  await page.click('#mpSignClaim');
  await page.waitForFunction(() => /recorded ✓/.test(document.getElementById('mpClaimStatus').textContent), null, { timeout: 15000 });
  check('mp: claim is a free EIP-712 signature — no transaction, no approval, no permit', await page.evaluate(() => (window.__walletCalls || []).includes('eth_signTypedData_v4') && !(window.__walletCalls || []).some((m) => /sendTransaction|approve|permit/i.test(m))));
  check('mp: fee right offerable only because the LIVE chain names this wallet', /YOUR WALLET IS THE RECIPIENT/.test(await page.textContent('#mpFeeRowState')));
  await page.fill('#mpPrice', '1.5');
  await page.fill('#mpDescription', 'Live operating project with a website and community, listed by the recognised operator.');
  await page.check('#mpIncludeFee');
  await page.click('#mpCreateListing');
  await page.waitForFunction(() => location.hash.startsWith('#listing='), null, { timeout: 15000 }); await page.waitForTimeout(500);
  const detail = await page.textContent('#mpDetail');
  check('mp: listing is ACTIVE with chain-backed badges (server record, not localStorage)', /ACTIVE/.test(detail) && /VERIFIED OPERATOR/.test(detail) && /CREATOR FEE TRANSFERABLE/.test(detail), detail.slice(0, 160));
  check('mp: what is never sold is explicit (supply, liquidity, metadata, X account)', /NEVER SOLD · NEVER TRANSFERRED/.test(detail) && /X account/.test(detail));
  check('mp: nothing marketplace-related was written to localStorage', await page.evaluate(() => !Object.keys(localStorage).some((k) => /marketplace|mp:/i.test(k))));
  // holder-vault token: claimable by its deployer, but the fee right is locked out truthfully
  await page.click('[data-mp-view="sell"]');
  await page.fill('#mpToken', A.SYNCAT); await page.click('#mpCheckProject');
  await page.waitForFunction(() => /Evidence found/.test(document.getElementById('mpClaimStatus').textContent), null, { timeout: 15000 });
  check('mp: holder-vault token → fee right NOT TRANSFERABLE · FIXED TO A PAR VAULT, unincludable', /FIXED TO A PAR VAULT/.test(await page.textContent('#mpFeeRowState')) && await page.locator('#mpIncludeFee').isDisabled());
  // a wallet with no on-chain relationship cannot claim a project someone else operates
  await page.evaluate((a) => window.__mockSetAccount(a), A.ATTACKER); await page.waitForTimeout(400);
  await page.fill('#mpToken', A.CREATORLIVE); await page.click('#mpCheckProject');
  await page.waitForFunction(() => /already recognised for this project/.test(document.getElementById('mpClaimStatus').textContent), null, { timeout: 15000 });
  check('mp: a stranger wallet cannot claim — the recognised operator is protected', await page.locator('#mpSignClaim').isDisabled());
  check('marketplace: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
  // leave no marketplace records behind for later suites (the passport suite expects a clean operator row)
  for (const k of [...serverState.upstash.keys()]) if (k.startsWith('mp:')) serverState.upstash.delete(k);
});



// ---------------- WEBSITE DECISION + DRAFT ----------------
await suite('builder website + draft', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/build.html');
  await page.fill('#name', 'DRAFTY'); await page.fill('#symbol', 'DRFT'); await page.fill('#description', 'Saved while I build my site');
  await page.click('#panel-1 [data-next]');
  check('website: a choice is required before step 2', await page.locator('#panel-1').isVisible());
  await page.check('input[name="websiteChoice"][value="have"]');
  check('website: "I have a site" shows URL field', await page.locator('#websiteUrlWrap').isVisible() && await page.locator('#websiteKitCard').isHidden());
  await page.fill('#website', 'not a url'); await page.click('#panel-1 [data-next]');
  check('website: invalid URL blocks', await page.locator('#panel-1').isVisible() && /Not a valid URL/.test(await page.textContent('#websiteStatus')));
  await page.fill('#website', '');
  await page.check('input[name="websiteChoice"][value="kit"]');
  check('website: "Build one" shows Kit card + optional URL', await page.locator('#websiteKitCard').isVisible() && await page.locator('#websiteUrlWrap').isVisible());
  check('website: Kit link opens in new tab', (await page.getAttribute('#websiteKitCard .js-open-kit', 'target')) === '_blank');
  await page.click('#panel-1 [data-next]');
  check('website: kit choice with empty URL may continue', await page.locator('#panel-2').isVisible());
  await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
  await page.click('#tab-3'); await page.click('[data-tax="250"]'); await page.check('input[name="feeMode"][value="creator"]');
  await page.click('#tab-4');
  check('review: missing website reminder shown', await page.locator('#reviewWebsiteCta').isVisible() && /No website URL yet/.test(await page.textContent('#reviewWebsiteCta')) && /permanently/.test(await page.textContent('#reviewWebsiteCta')));
  await page.click('#reviewAddUrl'); await page.waitForTimeout(200);
  check('review: ADD A URL returns to step 1 and focuses the URL', await page.locator('#panel-1').isVisible() && await page.evaluate(() => document.activeElement?.id === 'website'));
  await page.fill('#website', 'https://drafty.example'); await page.click('#tab-4');
  check('review: reminder hidden once a URL exists', await page.locator('#reviewWebsiteCta').isHidden() && /drafty\.example/.test(await page.textContent('#reviewWebsite')));
  await page.click('#tab-1'); await page.check('input[name="websiteChoice"][value="none"]');
  check('website: "No website" clears and disables the URL', (await page.inputValue('#website')) === '' && await page.locator('#websiteNoneNote').isVisible());
  await page.click('#tab-4');
  check('review: explicit no-website shown as a choice', /your choice/.test(await page.textContent('#reviewWebsiteCta')));
  await page.click('#tab-1'); await page.check('input[name="websiteChoice"][value="kit"]');
  check('website: switching back restores the stashed URL', (await page.inputValue('#website')) === 'https://drafty.example');
  // simulate so we can prove simulations are not persisted
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent), null, { timeout: 20000 });
  await page.waitForTimeout(600);
  const raw = await page.evaluate(() => localStorage.getItem('syncnet_builder_draft_v1'));
  const d = JSON.parse(raw || '{}');
  check('draft: saved with fields, choice, fee, connection', d.name === 'DRAFTY' && d.websiteChoice === 'kit' && d.feeMode === 'creator' && d.tax === 250 && d.quotes?.length === 1);
  check('draft: never stores simulation/signature/keys', !/recordHash|salt|signature|predicted|uploadSession|canary/i.test(raw));
  // reload → banner → start fresh
  await page.reload();
  check('draft: banner offered after reload', await page.locator('#draftBanner').isVisible() && /DRAFTY/.test(await page.textContent('#draftBanner')));
  check('draft: nothing auto-filled before the user chooses', (await page.inputValue('#name')) === '');
  await page.click('#draftContinue');
  await page.waitForFunction(() => /re-checked/.test(document.getElementById('assetStatus').textContent), null, { timeout: 15000 });
  check('draft: fields restored', (await page.inputValue('#name')) === 'DRAFTY' && (await page.inputValue('#description')).includes('Saved while') && (await page.inputValue('#website')) === 'https://drafty.example');
  check('draft: website choice restored', await page.evaluate(() => document.querySelector('input[name="websiteChoice"]:checked')?.value === 'kit'));
  check('draft: tax + fee mode restored', await page.evaluate(() => document.querySelector('.tax-btn.active')?.dataset.tax === '250' && document.querySelector('input[name="feeMode"]:checked')?.value === 'creator'));
  check('draft: connection restored and re-verified on-chain', /1 connection/.test(await page.textContent('#quoteCount')) && /re-checked ✓/.test(await page.textContent('#assetStatus')));
  check('draft: simulation is fresh after restore', /not run yet/.test(await page.textContent('#simStatus')));
  await page.click('#tab-2'); await page.click('#panel-2 [data-next]');
  check('draft: restored connections pass eligibility validation', await page.locator('#panel-3').isVisible());
  // start fresh
  await page.reload(); await page.click('#draftDiscard');
  check('draft: START FRESH clears it', await page.evaluate(() => localStorage.getItem('syncnet_builder_draft_v1') === null));
  await page.reload();
  check('draft: no banner after discard', await page.locator('#draftBanner').isHidden());
  // unanswered banner must not be overwritten by a ?with= prefill
  await page.fill('#name', 'KEEPME'); await page.fill('#symbol', 'KEEP'); await page.waitForTimeout(600);
  await page.goto(BASE + '/build.html?with=' + A.PONS); await page.waitForTimeout(1500);
  const kept = JSON.parse(await page.evaluate(() => localStorage.getItem('syncnet_builder_draft_v1')) || '{}');
  check('draft: prefilled link does not overwrite an unanswered draft', kept.name === 'KEEPME');
  check('website/draft: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});


// ---------------- OPENING BUY (dev buy in the launch tx) ----------------
await suite('builder opening buy', async () => {
  resetChain();
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  const setup = async (conns) => {
    await page.goto(BASE + '/build.html?live=canary');
    await page.fill('#name', 'BUYTEST'); await page.fill('#symbol', 'BUYT'); await page.check('input[name="websiteChoice"][value="none"]');
    await page.click('#panel-1 summary'); await page.fill('#logo', 'ipfs://' + TEST_CID);
    await page.click('#tab-2');
    for (const a of conns) { await page.fill('#customAsset', a); await page.click('#checkAdd'); await page.waitForFunction(() => /ready/.test(document.getElementById('assetStatus').textContent)); }
    await page.click('#tab-3'); await page.click('[data-tax="100"]'); await page.check('input[name="feeMode"][value="creator"]');
  };
  const simulate = async () => { await page.click('#tab-4'); if (!(await page.evaluate(() => /…/.test(document.getElementById('walletName').textContent)))) { await page.click('#connectWallet'); await page.click('#providerList button'); } await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED|No transaction was sent/.test(document.getElementById('simStatus').textContent), null, { timeout: 25000 }); return page.textContent('#simStatus'); };
  await setup([A.SYNC, A.PONS]);
  check('buy: default is no opening buy', /No opening buy/.test(await page.textContent('#openingBuyStatus')));
  let sim = await simulate();
  check('buy: 0 ETH keeps the direct factory launch', chain.lastLaunchCall && !chain.lastRouterCall && /SIMULATION PASSED/.test(sim));
  // invalid inputs
  await page.click('#tab-3'); await page.fill('#openingBuy', 'abc');
  check('buy: invalid amount flagged', /Enter an ETH amount/.test(await page.textContent('#openingBuyStatus')));
  await page.click('#panel-3 [data-next]');
  check('buy: invalid amount blocks review', await page.locator('#panel-3').isVisible());
  await page.fill('#openingBuy', '11');
  check('buy: >10 ETH refused', /limited to 10 ETH/.test(await page.textContent('#openingBuyStatus')));
  // quick button
  await page.click('.buy-btn[data-buy="0.05"]');
  check('buy: quick 0.05 sets field + pre-sim explanation', (await page.inputValue('#openingBuy')) === '0.05' && /split equally across your 2 markets/.test(await page.textContent('#openingBuyStatus')));
  sim = await simulate();
  const rc = chain.lastRouterCall;
  check('buy: simulation passes through PAR router', /SIMULATION PASSED/.test(sim) && /Opening buy: 0.05 ETH/.test(sim) && /via PAR router 0x458D2a59/i.test(sim), sim.slice(0, 500));
  check('buy: two legs, equal split, sum = buy', rc && rc.legs.length === 2 && BigInt(rc.legs[0].amountIn) + BigInt(rc.legs[1].amountIn) === 5n * 10n ** 16n && BigInt(rc.legs[0].amountIn) === BigInt(rc.legs[1].amountIn));
  check('buy: legs use PAR pricer routes (1 hop each)', rc && rc.legs.every((l) => l.hops.length === 1));
  check('buy: minTokensOut = 99% of simulated output', rc && BigInt(rc.minTokensOut) === (rc.tokensOut * 9900n) / 10000n);
  check('buy: value = launch fee + buy', rc && rc.value === 100000000000000n + 5n * 10n ** 16n);
  check('buy: status shows tokens + % of supply', /2\.0% of supply/.test(await page.textContent('#openingBuyStatus')) || /2\.0% of supply/.test(await page.textContent('#reviewOpeningBuy')));
  check('buy: review shows exact wallet value', /0\.0501 ETH/.test(await page.textContent('#reviewTxValue')));
  // slippage change invalidates
  await page.click('#tab-3'); await page.selectOption('#openingSlippage', '200'); await page.click('#tab-4');
  check('buy: price-protection change invalidates simulation', /not run yet/.test(await page.textContent('#simStatus')));
  sim = await simulate();
  check('buy: 2% protection → 98% minimum', BigInt(chain.lastRouterCall.minTokensOut) === (chain.lastRouterCall.tokensOut * 9800n) / 10000n);
  // large buy warning
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.5'); sim = await simulate();
  check('buy: large buy (20% supply) warned as public risk signal', /risk signal/.test(await page.textContent('#openingBuyStatus')));
  // unreachable market is skipped
  chain.noRoute.add(A.PONS.toLowerCase());
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.05'); sim = await simulate();
  check('buy: market without ETH route skipped + disclosed', chain.lastRouterCall.legs.length === 1 && /no ETH route to PONS/.test(sim));
  chain.noRoute.add(A.SYNC.toLowerCase());
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.06'); sim = await simulate();
  check('buy: no reachable market → clear error, nothing sent', /None of the selected markets can be reached/.test(sim));
  chain.noRoute.clear();
  // router mismatch
  chain.forwarder = A.EVIL;
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.05'); sim = await simulate();
  check('buy: unexpected PAR router → refused by the live PAR preflight', /launchForwarder\(\) is PAR multi router/.test(sim), sim.slice(0, 200));
  chain.forwarder = null;
  // insufficient balance
  chain.balanceWei = 10n ** 16n;
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.04'); sim = await simulate();
  check('buy: insufficient ETH explained before the wallet', /Not enough ETH in this wallet/.test(sim), sim.slice(0, 200));
  chain.balanceWei = 100n * 10n ** 18n;
  // full founder launch with buy
  await page.click('#tab-3'); await page.fill('#openingBuy', '0.05'); await page.selectOption('#openingSlippage', '100');
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  sim = await simulate(); await waitGuard(page);
  check('buy: live panel states exact value + router', /sends 0\.0501 ETH \+ gas to PAR’s router/.test(await page.textContent('#liveValue')));
  await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED ✓/.test(document.getElementById('checkIntentSignature').textContent));
  check('buy: final review shows the opening buy and the exact wallet value', /0\.05 ETH/.test(await page.textContent('#finalReview')) && /0\.0501 ETH/.test(await page.textContent('#finalReview')));
  await page.check('#finalAck'); await page.fill('#liveConfirm', 'BUYT'); await page.click('#launchLive');
  await page.waitForFunction(() => /LIVE LAUNCH CONFIRMED|NEEDS ATTENTION/.test(document.getElementById('liveStatus').textContent), null, { timeout: 90000 });
  const live = await page.textContent('#liveStatus');
  check('buy: launch confirmed + verified through router path', /LIVE LAUNCH CONFIRMED/.test(live) && /VERIFIED ✓/.test(live), live.slice(0, 400));
  check('buy: tx sent to router with fee + buy', chain.lastSentTo === A.ROUTER.toLowerCase() && chain.lastSentValue === 100000000000000n + 5n * 10n ** 16n);
  check('buy: post-launch balance meets minimum', /wallet holds 20,000,000 tokens \(2\.0% of supply\) ✓/.test(live), live);
  const rec = (await recordsOf(page)).find((r) => DEPLOYED.includes(r.state));
  check('buy: record holds the opening buy, the exact value and the met minimum', rec?.expected?.openingBuy?.ethWei === String(5n * 10n ** 16n) && rec.tx.value === String(100000000000000n + 5n * 10n ** 16n) && rec.verification.onchain.checks.find((c) => c.id === 'opening-buy')?.ok === true);
  check('buy: opening buy committed in the salted intent record', rec?.intentRecord?.openingBuy?.ethWei === String(5n * 10n ** 16n) && rec.intentRecord.openingBuy.router === A.ROUTER.toLowerCase());
  await page.goto(BASE + '/project/' + rec.predicted);
  await page.waitForTimeout(800);
  check('buy: project page discloses the opening buy', /Opening buy in the launch transaction: 0\.05 ETH/.test(await page.textContent('#tokenCard')));
  check('opening buy: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ---------------- REHEARSAL (local fork) ----------------
await suite('builder rehearsal', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  for (const [q, why] of [['?rpc=http://127.0.0.1:8545&chain=46630', 'outside founder mode'], ['?live=canary&rpc=https://evil.example/&chain=46630', 'non-loopback rpc'], ['?live=canary&rpc=http://127.0.0.1:8545&chain=4663', 'real chain id'], ['?live=canary&rpc=http://127.0.0.1:8545', 'missing chain id']]) {
    await page.goto(BASE + '/build.html' + q);
    check(`rehearsal: ${why} → red banner + simulation disabled`, (await page.getAttribute('#networkBanner', 'class')).includes('error') && await page.locator('#runSimulation').isDisabled());
  }
  resetChain(); rpcStats.fork = 0; rpcStats.mainnet = 0;
  await page.goto(BASE + '/build.html?live=canary&rpc=http://127.0.0.1:8545&chain=46630');
  check('rehearsal: amber banner names the fork', /REHEARSAL · LOCAL FORK · chain 46630/.test(await page.textContent('#networkBanner')) && (await page.getAttribute('#networkBanner', 'class')).includes('rehearsal'));
  await page.fill('#name', 'PONSYNC'); await page.fill('#symbol', 'PONSYNC'); await page.click('#panel-1 summary'); await page.fill('#logo', 'ipfs://' + TEST_CID);
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="creator"]');
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  await page.click('#connectWallet'); await page.click('#providerList button');
  // wallet still on the real chain → must not simulate
  await page.click('#runSimulation'); await page.waitForFunction(() => /No transaction was sent/.test(document.getElementById('simStatus').textContent), null, { timeout: 20000 });
  check('rehearsal: wallet on real chain 4663 is refused', /rehearsal fork|rehearsal network|SWITCH/.test(await page.textContent('#simStatus')), (await page.textContent('#simStatus')).slice(0, 200));
  await page.evaluate(() => { window.__mockChainId = '0xb626'; });
  await page.click('#connectWallet'); await page.click('#providerList button');
  await page.click('#runSimulation'); await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent), null, { timeout: 25000 });
  check('rehearsal: simulation used the fork RPC only', rpcStats.fork > 5 && rpcStats.mainnet === 0, JSON.stringify(rpcStats));
  await waitGuard(page);
  await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED ✓/.test(document.getElementById('checkIntentSignature').textContent));
  check('rehearsal: EIP-712 domain uses fork chain id', JSON.parse(await page.evaluate(() => window.__typed)).domain.chainId === 46630);
  check('rehearsal: final review says REHEARSAL, never MAINNET', /REHEARSAL/.test(await page.textContent('#finalReview')) && !/MAINNET · REAL FUNDS/.test(await page.textContent('#finalReview')));
  await page.check('#finalAck'); await page.fill('#liveConfirm', 'PONSYNC'); await page.click('#launchLive');
  await page.waitForFunction(() => /LIVE LAUNCH CONFIRMED|NEEDS ATTENTION/.test(document.getElementById('liveStatus').textContent), null, { timeout: 90000 });
  check('rehearsal: full launch confirmed on fork', /LIVE LAUNCH CONFIRMED/.test(await page.textContent('#liveStatus')), (await page.textContent('#liveStatus')).slice(0, 300));
  check('rehearsal: tx chainId is the fork', (await page.evaluate(() => window.__sentTx?.chainId)) === '0xb626');
  const real = await recordsOf(page), fork = await recordsOf(page, 'syncnet_rehearsal_46630_');
  check('rehearsal: record stored separately, never as a real launch', real.length === 0 && fork.some((r) => r.rehearsal === true && r.intentRecord?.chainId === 46630 && DEPLOYED.includes(r.state)));
  check('rehearsal: mainnet RPC never touched', rpcStats.mainnet === 0);
  check('rehearsal: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ---------------- PROJECT KIT ----------------
await suite('project kit', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/kit.html');
  await page.fill('#kitName', 'PONSYNC'); await page.fill('#kitSymbol', 'ponsync'); await page.fill('#kitTagline', 'A bridge between two communities');
  await page.fill('#kitConnections', `PONS | ${A.PONS} | community\nSYNC | ${A.SYNC} | network\nBAD | 0x123 | oops`);
  let pr = await page.inputValue('#kitPrompt');
  check('kit: site prompt includes project + connections', /PONSYNC/.test(pr) && pr.includes(A.PONS) && /Direct market/.test(pr));
  check('kit: not-launched prompt forbids showing an address', /NOT launched yet/.test(pr));
  check('kit: safety rules present', /not a partnership|NOT a partnership/i.test(pr) && /No wallet connection/.test(pr) && /Never invent/.test(pr));
  check('kit: invalid connection line warned', /invalid contract address/.test(await page.textContent('#kitWarnings')));
  check('kit: prompt asks for syncnet.json', /syncnet\.json with EXACTLY this content/.test(pr));
  await page.fill('#kitToken', A.CREATORLIVE); await page.click('#kitLoad');
  await page.waitForFunction(() => /Loaded/.test(document.getElementById('kitStatus').textContent));
  pr = await page.inputValue('#kitPrompt');
  check('kit: live token → contract, PAR and SyncNet links in prompt', pr.includes(A.CREATORLIVE.toLowerCase()) && /par\.family\/token/.test(pr) && /syncnet\.capital\/project/.test(pr));
  const decl = JSON.parse(await page.inputValue('#kitDeclaration'));
  check('kit: declaration names the token', decl.schema === 'syncnet.site.v1' && decl.token === A.CREATORLIVE.toLowerCase());
  await page.focus('#kt-site'); await page.keyboard.press('ArrowRight');
  check('kit: tabs keyboard → description prompt', await page.evaluate(() => document.activeElement?.id === 'kt-description') && /permanently on-chain/.test(await page.inputValue('#kitPrompt')));
  await page.click('#kt-listing');
  check('kit: listing prompt says token is never sold', /never sold/.test(await page.inputValue('#kitPrompt')));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('#kitCopy');
  await page.waitForFunction(() => document.getElementById('kitCopyStatus').textContent.length > 0, null, { timeout: 5000 }).catch(() => {});
  { const cs = await page.textContent('#kitCopyStatus'); check('kit: copy gives feedback (clipboard or manual fallback)', /Copied|copy manually/.test(cs), cs); }
  // builder hand-off
  const b = await c.newPage(); await b.goto(BASE + '/build.html');
  await b.fill('#name', 'HANDOFF'); await b.fill('#symbol', 'HAND'); await b.fill('#description', 'From the builder');
  await b.check('input[name="websiteChoice"][value="kit"]');
  const [kitTab] = await Promise.all([c.waitForEvent('page'), b.click('#websiteKitCard .js-open-kit')]);
  await kitTab.waitForLoadState(); await kitTab.waitForTimeout(300);
  check('kit: prefilled from builder draft', (await kitTab.inputValue('#kitName')) === 'HANDOFF' && /builder draft/.test(await kitTab.textContent('#kitDraftNote')));
  check('kit: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ---------------- PASSPORT PANEL ----------------
await suite('project page passport', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/project/' + A.CREATORLIVE + '#details') /* evidence lives in DETAILS */;
  await page.waitForSelector('#passportPanel .passport-row');
  const t = await page.textContent('#passportPanel');
  check('passport: token shown as ownerless', /Ownerless · immutable/.test(t));
  check('passport: wallet beneficiary → transferable', /Wallet \(externally owned account\)/.test(t) && /Yes — this wallet can transfer/.test(t));
  check('passport: beneficiary ≠ operator stated', /not necessarily the operator/.test(t) && /Not recorded yet/.test(t));
  check('passport: CTO explained', /Community Takeover/.test(t));
  await page.waitForFunction(() => /LINKED|unconfirmed|different/.test(document.getElementById('siteStatus').textContent));
  check('passport: bidirectional site link → WEBSITE LINKED', /WEBSITE LINKED/.test(await page.textContent('#siteStatus')));
  await page.fill('#siteUrl', 'https://declarer.example'); await page.click('#checkSite');
  await page.waitForFunction(() => !/Checking/.test(document.getElementById('siteStatus').textContent));
  check('passport: site-only declaration stays unconfirmed', /unconfirmed/.test(await page.textContent('#siteStatus')));
  await page.goto(BASE + '/project/' + A.SYNCAT + '#details') /* evidence lives in DETAILS */;
  await page.waitForSelector('#passportPanel .passport-row');
  check('passport: holder-vault token → not transferable', /No — fixed to a PAR vault/.test(await page.textContent('#passportPanel')));
  await page.goto(BASE + '/project/' + A.PONS_FAKE + '#details') /* evidence lives in DETAILS */;
  await page.waitForFunction(() => /LINKED|unconfirmed|different|No syncnet/.test(document.getElementById('siteStatus')?.textContent || ''));
  check('passport: spoof site declaring another token is flagged', /different token/.test(await page.textContent('#siteStatus')));
  check('passport: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ---------------- other pages / mobile / legibility ----------------
const PAGES = ['/', '/for-sale', '/you.html', '/network.html', '/build.html', '/marketplace.html', '/sync.html', '/registry.html', '/labs.html', '/project/' + A.SYNCAT, '/kit.html', '/launches.html', '/terms.html', '/risk.html', '/privacy.html', '/contact.html'];
await suite('all pages · desktop + mobile + nav vocabulary', async () => {
  for (const vp of [{ width: 1280, height: 860, name: 'desktop' }, { width: 375, height: 740, name: 'mobile' }]) {
    const c = await ctx({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.name === 'mobile', hasTouch: vp.name === 'mobile' }); const page = await c.newPage(); const errs = trackErrors(page);
    for (const p of PAGES) {
      await page.goto(BASE + p); await page.waitForTimeout(700);
      const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(`${vp.name} ${p}: no horizontal overflow`, ov <= 1, 'overflow=' + ov);
      if (await page.locator('.sn-nav').count()) {
        // Phase 2 IA: Explore / Create (+ My Projects once connected) and Connect — nothing else is primary navigation
        const nav = vp.name === 'desktop' ? (await page.innerText('.sn-nav')).replace(/\s+/g, ' ').trim() : '';
        if (vp.name === 'desktop') check(`${p}: primary nav is Explore · Create, wallet says Connect`, nav === 'Explore Create' && (await page.innerText('[data-wallet]')).trim() === 'Connect' && !/sign in/i.test(await page.innerText('.sn-top')), nav);
        else check(`mobile ${p}: bottom nav has exactly Explore · Create · You`, (await page.locator('.sn-tabbar a:visible').allInnerTexts()).map((t) => t.trim()).join('|') === 'Explore|Create|You' && (await page.locator('.nav-toggle').count()) === 0);
      }
      if (vp.name === 'mobile') {
        const small = await page.evaluate(() => [...document.querySelectorAll('a,button,input,select,summary,label.btn')].filter((e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden]') && !e.closest('.footer-nav') && !e.closest('p') && (r.height < 40 || r.width < 24) && e.type !== 'hidden' && !e.classList.contains('file-input-hidden') && !((e.type === 'radio' || e.type === 'checkbox') && e.closest('label')); }).map((e) => (e.id || e.className || e.tagName) + '[' + (e.textContent||'').trim().slice(0,18) + ']:' + Math.round(e.getBoundingClientRect().height)).slice(0, 8));
        check(`mobile ${p}: tap targets ≥40px`, small.length === 0, small.join(', '));
        await shot(page, 'mobile' + p.replace(/[^a-z]/gi, '_'));
      }
      const tiny = await page.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el || el.closest('[hidden],svg,script,style,[aria-hidden="true"]')) continue; const r = el.getBoundingClientRect(); if (!r.width) continue; const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 10.5) out.push(fs + 'px:' + n.textContent.trim().slice(0, 30)); } return out; });
      check(`${vp.name} ${p}: no visible text under 10.5px`, tiny.length === 0, tiny.slice(0, 6).join(' | ') + (tiny.length > 6 ? ` (+${tiny.length - 6})` : ''));
    }
    check(`${vp.name}: no JS errors across pages`, errs.length === 0, errs.slice(0, 5).join(' | '));
    await c.close();
  }
});

await suite('labs duel still works', async () => {
  const c = await ctx(); const page = await c.newPage(); const errs = trackErrors(page);
  await page.goto(BASE + '/labs.html'); await page.waitForTimeout(600);
  await page.click('#duelEnter'); await page.waitForTimeout(300);
  await page.click('#duelStart'); await page.waitForTimeout(1200);
  check('labs: SYNC DUEL opens and starts', await page.locator('#duelSync').isVisible());
  check('labs: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/e2e/last-run.json'), JSON.stringify({ at: new Date().toISOString(), failures, results }, null, 2));
console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
