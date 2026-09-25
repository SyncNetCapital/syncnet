// Audit PoCs driven through the real pages — AFTER version for the V2.5 release candidate.
// Same attacks as tests/audit/before/poc-e2e.mjs (original V2.5 build: 35/35 reproduced), adapted only where the
// UI changed (founder key, final review confirmation, launch records instead of the old pending list).
// Checks marked "setup:" confirm the attack was actually carried out and must stay CONFIRMED; every other check
// prints CONFIRMED only when the vulnerability reproduces. Nothing touches a real network.
// Run: node tests/audit/poc-e2e.mjs
import { startServer, installRoutes, A, chain, resetChain, resetServer, LAUNCHES, rpcStats, FOUNDER_KEY, TEST_CID } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 8934, BASE = 'http://localhost:' + PORT;
const results = []; let reproduced = 0, setups = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail: String(detail).slice(0, 400) }); if (cond) { if (name.startsWith('setup:')) setups++; else reproduced++; } console.log((cond ? 'CONFIRMED ' : 'not-reproduced ') + name + (detail ? ' :: ' + String(detail).slice(0, 240).replace(/\n/g, ' ⏎ ') : '')); };
const srv = await startServer(PORT);
const browser = await chromium.launch();
async function ctx() { const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await installRoutes(c); return c; }
const txt = (page, id) => page.textContent('#' + id);
const waitText = (page, id, re, timeout = 30000) => page.waitForFunction(([i, s]) => new RegExp(s).test(document.getElementById(i)?.textContent || ''), [id, re.source], { timeout });
const records = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_launch_records_v1') || '[]'));
const POST = ['BROADCAST_ATTEMPTED', 'BROADCAST_UNKNOWN', 'TX_HASH_RECEIVED', 'MINED', 'ONCHAIN_VERIFIED', 'INDEXER_PENDING', 'FULLY_VERIFIED', 'FAILED_POST_BROADCAST'];

async function founderReady(page, { name = 'PONSYNC', symbol = 'PONSYNC' } = {}) {
  await page.goto(BASE + '/build.html?live=canary');
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  await page.click('#tab-1'); await page.click('#panel-1 summary'); await page.fill('#logo', 'ipfs://' + TEST_CID);
  await page.fill('#name', name); await page.fill('#symbol', symbol); await page.fill('#description', 'PoC');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await waitText(page, 'assetStatus', /SYNC ready/);
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
}
/** simulate → (sign if possible) → tick the final-review confirmation → type the phrase. Returns the intent hash. */
async function simulateSignConfirm(page, phrase, { ackDuplicates = false } = {}) {
  // A disabled button is re-enabled the way an attacker would (devtools) before clicking.
  await page.evaluate(() => { const b = document.getElementById('runSimulation'); if (b.disabled) { b.disabled = false; } b.click(); }); await page.waitForTimeout(400);
  await waitText(page, 'simStatus', /SIMULATION PASSED|No transaction/).catch(() => {});
  const sim = await txt(page, 'simStatus');
  if (/SIMULATION PASSED/.test(sim)) {
    await waitText(page, 'checkDuplicate', /PASS|BLOCKED|EXISTS|WARN/, 15000).catch(() => {});
    if (await page.locator('#signIntent').isEnabled()) { await page.click('#signIntent'); await page.waitForFunction(() => !/SIGNING/.test(document.getElementById('checkIntentSignature').textContent)); }
    if (ackDuplicates) { for (const id of ['#dupAck', '#collisionAck']) if (await page.locator(id).count()) await page.check(id); }
    if (await page.locator('#finalAck').count()) await page.check('#finalAck');
  }
  await page.evaluate(() => { const i = document.getElementById('liveConfirm'); if (i.disabled) i.disabled = false; });
  await page.fill('#liveConfirm', phrase);
  return (sim.match(/SyncNet intent hash: (0x[0-9a-f]{64})/) || [])[1] || '';
}
const sends = (page) => page.evaluate(() => (window.__walletCalls || []).filter((m) => m === 'eth_sendTransaction').length);

// ------------------------------------------------------------------ F-R1a: wallet broadcasts, then returns an error
{
  resetChain(); resetServer();
  const c = await ctx();
  await c.addInitScript(() => {
    const p = window.ethereum; const orig = p.request.bind(p);
    p.request = async (a) => {
      if (a.method === 'eth_sendTransaction' && window.__throwAfterBroadcast) { await orig(a); throw Object.assign(new Error('Internal JSON-RPC error.'), { code: -32603 }); }
      return orig(a);
    };
  });
  const page = await c.newPage();
  await founderReady(page);
  const h1 = await simulateSignConfirm(page, 'PONSYNC');
  await page.evaluate(() => { window.__throwAfterBroadcast = true; });
  await page.click('#launchLive');
  await waitText(page, 'liveStatus', /No transaction was sent|Nothing was sent|LIVE LAUNCH CONFIRMED|VERIFICATION NEEDS|treated as SENT/, 60000);
  await waitText(page, 'liveStatus', /LIVE LAUNCH CONFIRMED|VERIFICATION NEEDS|No token at the predicted/, 60000).catch(() => {});
  const live = await txt(page, 'liveStatus');
  check('setup: the wallet broadcast the launch and then returned an error', chain.tokens.size === 1);
  check('F-R1 wallet broadcast the launch but the page says "No transaction was sent."', /No transaction was sent|Nothing was sent/.test(live), live.slice(0, 200));
  const recs = await records(page);
  check('F-R1 nothing was persisted as pending (no reload guard, no "AGAIN" phrase)', !recs.some((r) => POST.includes(r.state)), recs.map((r) => r.state).join(','));
  check('F-R1 simulation button stays enabled', await page.locator('#runSimulation').isEnabled());
  await page.evaluate(() => { window.__throwAfterBroadcast = false; });
  const h2 = await simulateSignConfirm(page, 'PONSYNC');
  check('F-R1 re-simulation produces a NEW intent hash → new salt → new CREATE2 address on a real chain', h1 && h2 && h1 !== h2, h1.slice(0, 12) + ' vs ' + h2.slice(0, 12));
  check('F-R1 plain ticker (no "AGAIN") still unlocks the second launch', await page.locator('#launchLive').isEnabled());
  await page.evaluate(() => { const b = document.getElementById('launchLive'); b.disabled = false; b.click(); }); await page.waitForTimeout(3000);
  check('F-R1 a second launch transaction was sent', (await sends(page)) >= 2, 'eth_sendTransaction calls=' + (await sends(page)));
  await c.close();
}

// ------------------------------------------------------------------ F-R1b: page reloaded while the wallet popup is open
{
  resetChain(); resetServer();
  const c = await ctx();
  await c.addInitScript(() => {
    const p = window.ethereum; const orig = p.request.bind(p);
    p.request = async (a) => {
      if (a.method === 'eth_sendTransaction' && sessionStorage.getItem('hangAfterBroadcast')) { await orig(a); return new Promise(() => {}); }
      return orig(a);
    };
  });
  const page = await c.newPage();
  await founderReady(page);
  await simulateSignConfirm(page, 'PONSYNC');
  await page.waitForTimeout(600);
  await page.evaluate(() => sessionStorage.setItem('hangAfterBroadcast', '1'));
  await page.click('#launchLive');
  await page.waitForTimeout(800);
  check('setup: F-R1 transaction broadcast while the page still waits for the hash', chain.tokens.size === 1);
  await page.reload();
  await page.waitForTimeout(1500);
  const panel = (await page.locator('#launchRecords').isVisible()) ? await txt(page, 'launchRecords') : '';
  check('F-R1 after reload: no "unverified launch" notice', !/MY LAUNCHES/.test(panel), panel.slice(0, 160));
  const bannerOk = await page.locator('#draftBanner').isVisible();
  const meta = bannerOk ? await txt(page, 'draftMeta') : '';
  check('F-R1 after reload: the PONSYNC draft is offered for a fresh launch (without any unresolved-launch warning)', bannerOk && /PONSYNC/.test(await txt(page, 'draftTitle')) && !/unresolved/.test(meta) && !/MY LAUNCHES/.test(panel), meta.slice(0, 160));
  await c.close();
}

// ------------------------------------------------------------------ F-P6: re-simulating keeps the OLD intent signature
{
  resetChain(); resetServer();
  const c = await ctx(); const page = await c.newPage();
  await founderReady(page, { name: 'SIGTEST', symbol: 'SIGT' });
  const h1 = await simulateSignConfirm(page, 'SIGT');
  const typed1 = JSON.parse(await page.evaluate(() => window.__typed));
  await page.click('#runSimulation'); await waitText(page, 'simStatus', /SIMULATION PASSED/);
  const h2 = ((await txt(page, 'simStatus')).match(/SyncNet intent hash: (0x[0-9a-f]{64})/) || [])[1];
  check('setup: F-P6 second simulation (no input change) yields a new intent hash', h1 && h2 && h1 !== h2);
  await waitText(page, 'checkDuplicate', /PASS|BLOCKED|EXISTS|WARN/, 15000).catch(() => {});
  check('F-P6 UI still shows "SIGNED ✓" and the sign button stays disabled', /SIGNED ✓/.test(await txt(page, 'checkIntentSignature')) && await page.locator('#signIntent').isDisabled(), await txt(page, 'checkIntentSignature'));
  if (await page.locator('#finalAck').count()) await page.check('#finalAck');
  await page.fill('#liveConfirm', 'SIGT');
  check('F-P6 LAUNCH LIVE is enabled without a signature over the new record', await page.locator('#launchLive').isEnabled(), await txt(page, 'launchBlockers'));
  // To complete a launch the user must sign again; the stored evidence must then bind the NEW record.
  await page.click('#signIntent'); await waitText(page, 'checkIntentSignature', /SIGNED/);
  if (await page.locator('#finalAck').count()) await page.check('#finalAck');
  await page.fill('#liveConfirm', 'SIGT');
  await page.click('#launchLive'); await waitText(page, 'liveStatus', /CONFIRMED|NEEDS ATTENTION/, 90000);
  const rec = (await records(page)).find((r) => POST.includes(r.state));
  const signed = rec?.signature?.typedData?.message;
  check('F-P6 saved proof: signed recordHash ≠ committed recordHash', !rec || !signed || signed.recordHash !== rec.recordHash || signed.recordHash === typed1.message.recordHash, `signed=${signed?.recordHash?.slice(0, 14)} committed=${rec?.recordHash?.slice(0, 14)} first-signature=${typed1.message.recordHash.slice(0, 14)}`);
  check('F-P6 saved proof: signed salt ≠ salt used in the launch', !rec || !signed || signed.salt !== rec.salt);
  await page.goto(BASE + '/registry.html'); await page.waitForFunction(() => /\d/.test(document.getElementById('registryCount').textContent), null, { timeout: 20000 }); await page.waitForTimeout(600);
  check('F-P6 Registry labels it "SIGNED + TX-COMMITTED · THIS BROWSER"', /SIGNED \+ TX-COMMITTED/.test(await page.textContent('#localRegistryGrid')) || /BUILT WITH SYNCNET/.test(await page.textContent('#localRegistryGrid')), (await page.textContent('#localRegistryGrid')).slice(0, 120));
  await c.close();
}

// ------------------------------------------------------------------ F-RH1: misspelled rehearsal parameters fall back to mainnet silently
{
  resetChain(); resetServer(); rpcStats.mainnet = 0; rpcStats.fork = 0;
  const c = await ctx();
  await c.addInitScript(() => { window.__mockChainId = '0xb626'; }); // wallet is on the fork (46630)
  const page = await c.newPage();
  await page.goto(BASE + '/build.html?live=canary&fork=http://127.0.0.1:8545&chainid=46630');
  await page.waitForTimeout(500);
  const bannerCls = await page.getAttribute('#networkBanner', 'class');
  check('F-RH1 no rehearsal banner (neither amber nor red)', !/error|rehearsal/.test(bannerCls || ''), bannerCls + ' :: ' + (await txt(page, 'networkBanner')).slice(0, 120));
  await page.click('#tab-1'); await page.fill('#name', 'PONSYNC'); await page.fill('#symbol', 'PONSYNC');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await waitText(page, 'assetStatus', /SYNC ready/);
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  check('F-RH1 wallet on the fork is reported as "Wrong network" while the page silently runs as mainnet (no rehearsal error shown)', /Wrong network · 46630/.test(await txt(page, 'walletNetwork')) && !/error/.test(await page.getAttribute('#networkBanner', 'class') || ''), await txt(page, 'walletNetwork'));
  await page.click('#runSimulation', { force: true }).catch(() => {}); await page.waitForTimeout(1500);
  const calls = await page.evaluate(() => window.__walletCalls || []);
  check('F-RH1 RUN SIMULATION asks the wallet to switch to Robinhood Chain (0x1237)', calls.includes('wallet_switchEthereumChain'), calls.join(','));
  check('F-RH1 a simulation ran against the mainnet RPC although the URL asked for a fork', Boolean(chain.lastLaunchCall) || /SIMULATION PASSED/.test(await txt(page, 'simStatus')), `mainnet=${rpcStats.mainnet} fork=${rpcStats.fork} runSimulation disabled=${await page.locator('#runSimulation').isDisabled()}`);
  await c.close();
}

// ------------------------------------------------------------------ F-P3: fake "SYNC" ticker lands in RECENT $SYNC CONNECTIONS
{
  const FAKE_SYNC = A.FAKESYNC;
  LAUNCHES.unshift({ token: '0x9898989898989898989898989898989898989898', name: 'Totally Official SyncNet Child', symbol: 'SCAM', deployer: A.ATTACKER, createdAt: new Date().toISOString(), feeMode: 'creator', markets: [{ pairToken: FAKE_SYNC, quoteSymbol: 'SYNC' }] });
  const c = await ctx(); const page = await c.newPage();
  await page.goto(BASE + '/network.html');
  await page.waitForFunction(() => !/Reading live/.test(document.getElementById('networkGrid').textContent), null, { timeout: 20000 });
  const grid = await txt(page, 'networkGrid');
  check('F-P3 project paired with a FAKE SYNC (other address, same ticker) is listed under "RECENT $SYNC CONNECTIONS"', /Totally Official SyncNet Child/.test(grid), grid.slice(0, 160));
  LAUNCHES.shift();
  await c.close();
}

// ------------------------------------------------------------------ F-P1: VERIFIED TRANSFERABLE for a contract fee recipient
// Marketplace V1 adaptation of the same attack: the fee recipient is a CONTRACT; the seller (still the
// deployer) tries to sell the creator-fee right anyway, forcing the checkbox with devtools like the original PoC.
{
  const row = LAUNCHES.find((l) => l.token === A.CREATORLIVE); const prev = row.creatorFeeRecipient;
  row.creatorFeeRecipient = A.USDG; // any address with code, e.g. a multisig or an X/GitHub creator-account contract
  const c = await ctx(); const page = await c.newPage(); page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/marketplace.html#sell');
  await page.click('#mpConnect'); await page.waitForTimeout(250);
  await page.fill('#mpToken', A.CREATORLIVE); await page.click('#mpCheckProject');
  await waitText(page, 'mpClaimStatus', /Evidence found|cannot claim|already/);
  const feeState = await txt(page, 'mpFeeRowState');
  const includable = await page.$eval('#mpIncludeFee', (x) => !x.disabled);
  check('F-P1 marketplace represents a CONTRACT fee recipient as transferable/includable', includable || /YOUR WALLET IS THE RECIPIENT|ON-CHAIN TRANSFERABLE/.test(feeState), 'state=' + feeState);
  // forge it anyway (devtools), claim as the deployer, and submit the listing with the fee right included
  await page.click('#mpSignClaim'); await waitText(page, 'mpClaimStatus', /recorded ✓/);
  await page.evaluate(() => { const cb = document.getElementById('mpIncludeFee'); cb.disabled = false; cb.checked = true; });
  await page.fill('#mpPrice', '1'); await page.fill('#mpDescription', 'Forged transferable fee-right claim, exactly like the original PoC but against the real backend.');
  await page.click('#mpCreateListing'); await page.waitForTimeout(1500);
  const sellErr = (await page.$eval('#mpSellError', (e) => e.textContent).catch(() => '')) || '';
  check('F-P1b the forged fee-right listing is accepted server-side and renders as a real listing', /#listing=/.test(page.url()), 'server said: ' + sellErr.slice(0, 120));
  // and the Project Passport must keep telling the truth about a contract recipient
  await page.goto(BASE + '/project/' + A.CREATORLIVE);
  await page.waitForFunction(() => /Depends on that contract|transfer the right|fixed to a PAR vault/.test(document.getElementById('passportPanel')?.textContent || ''), null, { timeout: 20000 });
  check('F-P1 marketplace and Passport disagree about a contract recipient', (includable || /YOUR WALLET IS THE RECIPIENT/.test(feeState)) && /Depends on that contract/.test(await txt(page, 'passportPanel')));
  row.creatorFeeRecipient = prev;
  await c.close();
}

// ------------------------------------------------------------------ F-P4 / F-P5: project page misstatements
{
  const row = LAUNCHES.find((l) => l.token === A.CREATORLIVE); const prevW = row.website;
  row.description = 'A deliberately long but perfectly normal project description that is longer than ninety-six characters in total.';
  row.website = 'http://oplive.example/';
  const c = await ctx(); const page = await c.newPage();
  await page.goto(BASE + '/project/' + A.CREATORLIVE);
  await page.waitForFunction(() => /Website in token metadata/.test(document.getElementById('passportPanel')?.textContent || ''), null, { timeout: 20000 });
  const card = await txt(page, 'tokenCard');
  check('F-P4 description longer than 96 chars is rendered as "Description: Token…"', /Description:\s*Token…/.test(card) || !/ninety-six characters in total/.test(card), (card.match(/Description:[^\n]{0,60}/) || [''])[0]);
  const pp = (await txt(page, 'passportPanel')).replace(/\s+/g, '');
  check('F-P5 token with an http:// website is shown as "Website in token metadata: None"', /WebsiteintokenmetadataNone/.test(pp) || !/http:\/\/oplive\.example/.test(pp), (await txt(page, 'passportPanel')).match(/Website in token metadata[^]{0,120}/)?.[0]);
  delete row.description; row.website = prevW;
  await c.close();
}

// ------------------------------------------------------------------ F-R3: transient post-send failure → recovery path deletes the only copy of the intent record
{
  resetChain(); resetServer();
  const c = await ctx();
  // A lagging RPC node: the receipt is there, but eth_getCode for the new token still returns 0x.
  await c.route('https://rpc.mainnet.chain.robinhood.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (!Array.isArray(body) && body.method === 'eth_getCode' && globalThis.__lagCode && chain.tokens.has(String(body.params?.[0]).toLowerCase())) return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: '0x' } });
    return route.fallback();
  });
  const page = await c.newPage(); page.on('dialog', (d) => d.accept());
  await founderReady(page, { name: 'LAGTEST', symbol: 'LAGT' });
  await simulateSignConfirm(page, 'LAGT');
  globalThis.__lagCode = true;
  await page.click('#launchLive');
  await waitText(page, 'liveStatus', /CONFIRMED|NEEDS ATTENTION|could not read/, 90000);
  const live = await txt(page, 'liveStatus');
  check('setup: F-R3 the launch was mined while the node lagged', chain.tokens.size === 1, live.slice(0, 160));
  let recs = await records(page); const rec = recs.find((r) => POST.includes(r.state));
  check('F-R3 launch mined, but a lagging node makes the page stop without saving a proof', !rec || !rec.intentJson || !rec.signature, rec ? rec.state + ' intent=' + Boolean(rec.intentJson) + ' signature=' + Boolean(rec.signature) : 'no record');
  check('F-R3 the intent record + signature exist only in a transient pending entry (no durable launch record)', !rec, rec ? 'durable record ' + rec.state : '');
  check('F-R3 no export button is offered on this path', (await page.locator('#exportLaunchProof').count()) === 0);
  globalThis.__lagCode = false;
  await page.goto(BASE + '/build.html?live=canary'); await page.waitForTimeout(1500);
  const panel = (await page.locator('#launchRecords').isVisible()) ? await txt(page, 'launchRecords') : '';
  check('F-R3 reload notice names only ticker + tx hash, never the predicted token address, and does not check the chain', !panel || !panel.toLowerCase().includes(String(rec?.predicted || 'zz').slice(2, 12)), panel.slice(0, 160));
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  const afterUnlock = (await page.locator('#launchRecords').isVisible()) ? await txt(page, 'launchRecords') : '';
  check('F-R3 unlocking founder mode wipes the launch notice', !/MY LAUNCHES/.test(afterUnlock), afterUnlock.slice(0, 120));
  await page.goto(BASE + '/launches.html'); await page.waitForTimeout(800);
  const btn = page.locator('[data-act="reverify"]').first(); if (await btn.count()) { await btn.click(); await page.waitForTimeout(2000); }
  recs = await records(page); const again = recs.find((r) => r.id === rec?.id);
  check('F-R3 following the recovery path erases the record: intent JSON/signature are gone for good', !again || !again.intentJson || !again.signature, again ? again.state + ' intent=' + Boolean(again.intentJson) : 'missing');
  await c.close();
}

// ------------------------------------------------------------------ F-P7: any address gets a "NETWORK HUB" badge
{
  const c = await ctx(); const page = await c.newPage();
  const RANDOM = '0x1234567890abcdef1234567890abcdef12345678';
  await page.goto(BASE + '/project/' + RANDOM);
  await page.waitForFunction(() => !/CHECKING|LOADING/.test(document.getElementById('tokenTitle').textContent), null, { timeout: 20000 }); await page.waitForTimeout(500);
  const card = await txt(page, 'tokenCard');
  check('F-P7 an arbitrary contract (not on PAR, used by no project) is badged "NETWORK HUB" on a SyncNet page', /NETWORK HUB/.test(card), card.slice(0, 160));
  await c.close();
}

// ------------------------------------------------------------------ F-P7b: static "Ownerless · immutable" claims for non-PAR contracts
{
  const c = await ctx(); const page = await c.newPage();
  await page.goto(BASE + '/project/' + A.USDG);
  await page.waitForFunction(() => !/CHECKING|LOADING/.test(document.getElementById('tokenTitle').textContent), null, { timeout: 20000 }); await page.waitForTimeout(800);
  const all = (await txt(page, 'tokenCard')).replace(/\s+/g, ' ');
  check('F-P7 Passport of a NON-PAR contract (USDG) still states "Ownerless · immutable" and "Only the creator-fee recipient" can change', /Ownerless · immutable/.test(all) || /Only the creator-fee recipient/.test(all), all.slice(0, 220));
  await c.close();
}

// ------------------------------------------------------------------ F-R1 (N1): an edit while the wallet popup is open loses the hash
{
  resetChain(); resetServer();
  const c = await ctx();
  await c.addInitScript(() => {
    const p = window.ethereum; const orig = p.request.bind(p);
    p.request = async (a) => {
      if (a.method === 'eth_sendTransaction' && window.__slowWallet) { const h = await orig(a); await new Promise((r) => setTimeout(r, 1500)); return h; }
      return orig(a);
    };
  });
  const page = await c.newPage();
  await founderReady(page, { name: 'EDITPOP', symbol: 'EDPOP' });
  await simulateSignConfirm(page, 'EDPOP');
  await page.evaluate(() => { window.__slowWallet = true; });
  await page.click('#launchLive');
  await page.waitForTimeout(300);
  await page.evaluate(() => { const d = document.getElementById('description'); d.value = 'PoC edited'; d.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitText(page, 'liveStatus', /CONFIRMED|NEEDS ATTENTION|Nothing was sent/, 60000);
  const recs = await records(page); const rec = recs.find((r) => POST.includes(r.state));
  check('setup: F-R1/N1 the transaction was broadcast', chain.tokens.size === 1);
  check('F-R1/N1 tx broadcast; the page claims the launch is saved but nothing was saved', !rec || !rec.txHash, rec ? rec.state + ' tx=' + String(rec.txHash).slice(0, 12) : 'no record');
  const sent = chain.sent[0] ? Buffer.from(chain.sent[0].data.slice(2), 'hex').toString('latin1') : '';
  check('F-R1/N1 the edit made while the wallet popup was open changed the sent transaction', /PoC edited/.test(sent));
  await page.reload(); await page.waitForTimeout(800);
  const panel = (await page.locator('#launchRecords').isVisible()) ? await txt(page, 'launchRecords') : '';
  check('F-R1/N1 after reload: no notice, draft offered again', !/MY LAUNCHES/.test(panel), panel.slice(0, 120));
  await c.close();
}

// ------------------------------------------------------------------ F-UX1 (N5): Review shows the old fee recipient after an account switch
{
  resetChain(); resetServer();
  const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002';
  const c = await ctx();
  await c.addInitScript((B) => {
    const p = window.ethereum; const orig = p.request.bind(p); const origOn = p.on; window.__ls = {};
    p.on = (e, f) => { (window.__ls[e] ||= []).push(f); return origOn(e, f); };
    p.request = async (a) => { if (window.__acct && (a.method === 'eth_accounts' || a.method === 'eth_requestAccounts')) return [window.__acct]; return orig(a); };
  }, B);
  const page = await c.newPage();
  await page.goto(BASE + '/build.html');
  await page.click('#tab-1'); await page.fill('#name', 'REVIEWT'); await page.fill('#symbol', 'REVT'); await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await waitText(page, 'assetStatus', /SYNC ready/);
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="creator"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  await page.click('#tab-3'); await page.click('#tab-4');
  const before = await txt(page, 'reviewRewards');
  await page.evaluate((B) => { window.__acct = B; (window.__ls.accountsChanged || []).forEach((f) => f([B])); }, B);
  await page.click('#runSimulation'); await waitText(page, 'simStatus', /SIMULATION PASSED|No transaction/);
  const review = await txt(page, 'reviewRewards'), sim = await txt(page, 'simStatus');
  check('F-UX1 Review still names wallet A as fee recipient while the simulated calldata pays wallet B', new RegExp(A.WALLET, 'i').test(review) && review === before && new RegExp(B, 'i').test(sim) && !new RegExp(B, 'i').test(review), 'review=' + review.slice(0, 90) + ' | sim has B=' + new RegExp(B, 'i').test(sim));
  await c.close();
}

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/audit/poc-e2e.json'), JSON.stringify({ at: new Date().toISOString(), version: 'v2.5-rc', results }, null, 2));
process.stdout.write(`\n${reproduced}/${results.length - setups} vulnerability checks reproduced (expected after the fixes: 0); ${setups} setup checks confirmed the attacks ran\n`);
process.exit(0);
