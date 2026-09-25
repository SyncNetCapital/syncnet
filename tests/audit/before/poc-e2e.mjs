// Audit PoCs driven through the real pages with the project's own mocks (tests/e2e/harness.mjs).
// Nothing touches a real network. Run: node tests/audit/poc-e2e.mjs
import { startServer, installRoutes, A, chain, resetChain, LAUNCHES, rpcStats } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'http://localhost:8931';
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail: String(detail).slice(0, 400) }); console.log((cond ? 'CONFIRMED ' : 'not-reproduced ') + name + (detail ? ' :: ' + String(detail).slice(0, 240).replace(/\n/g, ' ⏎ ') : '')); };
const srv = await startServer();
const browser = await chromium.launch();
async function ctx() { const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await installRoutes(c); return c; }
const txt = (page, id) => page.textContent('#' + id);
const waitText = (page, id, re, timeout = 30000) => page.waitForFunction(([i, s]) => new RegExp(s).test(document.getElementById(i)?.textContent || ''), [id, re.source], { timeout });

async function founderReady(page, { name = 'PONSYNC', symbol = 'PONSYNC' } = {}) {
  await page.goto(BASE + '/build.html?live=canary');
  await page.click('#tab-4'); await page.fill('#canaryKey', 'founder-key'); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  await page.click('#tab-1'); await page.click('#panel-1 summary'); await page.fill('#logo', 'ipfs://bafytestcid');
  await page.fill('#name', name); await page.fill('#symbol', symbol); await page.fill('#description', 'PoC');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await waitText(page, 'assetStatus', /SYNC ready/);
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
}
async function simulateSignConfirm(page, phrase) {
  await page.click('#runSimulation'); await waitText(page, 'simStatus', /SIMULATION PASSED|No transaction/);
  const sim = await txt(page, 'simStatus');
  if (await page.locator('#signIntent').isEnabled()) { await page.click('#signIntent'); await waitText(page, 'checkIntentSignature', /SIGNED/); }
  await page.fill('#liveConfirm', phrase);
  return (sim.match(/SyncNet intent hash: (0x[0-9a-f]{64})/) || [])[1] || '';
}
const sends = (page) => page.evaluate(() => (window.__walletCalls || []).filter((m) => m === 'eth_sendTransaction').length);

// ------------------------------------------------------------------ F-R1a: wallet broadcasts, then returns an error
{
  resetChain();
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
  await waitText(page, 'liveStatus', /No transaction was sent|WAS sent|CONFIRMED/);
  const live = await txt(page, 'liveStatus');
  check('F-R1 wallet broadcast the launch but the page says "No transaction was sent."', chain.launched && /No transaction was sent/.test(live), live);
  const pending = await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_pending_launches') || '[]').length);
  check('F-R1 nothing was persisted as pending (no reload guard, no "AGAIN" phrase)', pending === 0, 'pending=' + pending);
  check('F-R1 simulation button stays enabled', await page.locator('#runSimulation').isEnabled());
  await page.evaluate(() => { window.__throwAfterBroadcast = false; });
  const h2 = await simulateSignConfirm(page, 'PONSYNC');
  check('F-R1 re-simulation produces a NEW intent hash → new salt → new CREATE2 address on a real chain', h1 && h2 && h1 !== h2, h1.slice(0, 12) + ' vs ' + h2.slice(0, 12));
  check('F-R1 plain ticker (no "AGAIN") still unlocks the second launch', await page.locator('#launchLive').isEnabled());
  await page.click('#launchLive');
  await waitText(page, 'liveStatus', /CONFIRMED|WAS sent/, 90000);
  check('F-R1 a second launch transaction was sent', (await sends(page)) === 2, 'eth_sendTransaction calls=' + (await sends(page)));
  await c.close();
}

// ------------------------------------------------------------------ F-R1b: page reloaded while the wallet popup is open
{
  resetChain();
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
  await page.waitForTimeout(600); // let the debounced draft save run
  await page.evaluate(() => sessionStorage.setItem('hangAfterBroadcast', '1'));
  await page.click('#launchLive');
  await page.waitForTimeout(800);
  check('F-R1 transaction broadcast while the page still waits for the hash', Boolean(chain.launched));
  await page.reload();
  await page.waitForTimeout(800);
  const sim = await txt(page, 'simStatus');
  check('F-R1 after reload: no "unverified launch" notice', !/has not been verified yet/.test(sim), sim.slice(0, 120));
  check('F-R1 after reload: the PONSYNC draft is offered for a fresh launch', await page.locator('#draftBanner').isVisible() && /PONSYNC/.test(await txt(page, 'draftTitle')), await txt(page, 'draftTitle'));
  await c.close();
}

// ------------------------------------------------------------------ F-P6: re-simulating keeps the OLD intent signature
{
  resetChain();
  const c = await ctx(); const page = await c.newPage();
  await founderReady(page, { name: 'SIGTEST', symbol: 'SIGT' });
  const h1 = await simulateSignConfirm(page, 'SIGT');
  const typed1 = JSON.parse(await page.evaluate(() => window.__typed));
  await page.click('#runSimulation'); await waitText(page, 'simStatus', /SIMULATION PASSED/);
  const h2 = ((await txt(page, 'simStatus')).match(/SyncNet intent hash: (0x[0-9a-f]{64})/) || [])[1];
  check('F-P6 second simulation (no input change) yields a new intent hash', h1 && h2 && h1 !== h2);
  check('F-P6 UI still shows "SIGNED ✓" and the sign button stays disabled', /SIGNED/.test(await txt(page, 'checkIntentSignature')) && await page.locator('#signIntent').isDisabled());
  await page.fill('#liveConfirm', 'SIGT');
  check('F-P6 LAUNCH LIVE is enabled without a signature over the new record', await page.locator('#launchLive').isEnabled());
  await page.click('#launchLive'); await waitText(page, 'liveStatus', /CONFIRMED|WAS sent/, 90000);
  const proof = await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_live_launch_proofs') || '[]')[0]);
  check('F-P6 saved proof: signed recordHash ≠ committed recordHash', proof && proof.typedData?.message?.recordHash === typed1.message.recordHash && proof.recordHash === h2 && proof.recordHash !== proof.typedData.message.recordHash, `signed=${proof?.typedData?.message?.recordHash?.slice(0, 14)} committed=${proof?.recordHash?.slice(0, 14)}`);
  check('F-P6 saved proof: signed salt ≠ salt used in the launch', proof && proof.typedData?.message?.salt !== proof.salt);
  await page.goto(BASE + '/registry.html'); await page.waitForTimeout(1200);
  check('F-P6 Registry labels it "SIGNED + TX-COMMITTED · THIS BROWSER"', /SIGNED \+ TX-COMMITTED/.test(await page.textContent('#localRegistryGrid')));
  await c.close();
}

// ------------------------------------------------------------------ F-RH1: misspelled rehearsal parameters fall back to mainnet silently
{
  resetChain(); rpcStats.mainnet = 0; rpcStats.fork = 0;
  const c = await ctx();
  await c.addInitScript(() => { window.__mockChainId = '0xb626'; }); // wallet is on the fork (46630)
  const page = await c.newPage();
  await page.goto(BASE + '/build.html?live=canary&fork=http://127.0.0.1:8545&chainid=46630');
  check('F-RH1 no rehearsal banner (neither amber nor red)', (await page.locator('#rehearsalBanner').count()) === 0);
  await page.click('#tab-1'); await page.fill('#name', 'PONSYNC'); await page.fill('#symbol', 'PONSYNC');
  await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await waitText(page, 'assetStatus', /SYNC ready/);
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="holders"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  check('F-RH1 wallet on the fork is reported as "Wrong network", not as rehearsal', /Wrong network · 46630/.test(await txt(page, 'walletNetwork')), await txt(page, 'walletNetwork'));
  await page.click('#runSimulation'); await page.waitForTimeout(1500);
  const calls = await page.evaluate(() => window.__walletCalls || []);
  check('F-RH1 RUN SIMULATION asks the wallet to switch to Robinhood Chain (0x1237)', calls.includes('wallet_switchEthereumChain'), calls.join(','));
  check('F-RH1 all reads went to the mainnet RPC, none to the fork', rpcStats.mainnet > 0 && rpcStats.fork === 0, `mainnet=${rpcStats.mainnet} fork=${rpcStats.fork}`);
  await c.close();
}

// ------------------------------------------------------------------ F-P3: fake "SYNC" ticker lands in RECENT $SYNC CONNECTIONS
{
  const FAKE_SYNC = '0x9999999999999999999999999999999999999999';
  LAUNCHES.unshift({ token: '0x9898989898989898989898989898989898989898', name: 'Totally Official SyncNet Child', symbol: 'SCAM', createdAt: new Date().toISOString(), feeMode: 'creator', markets: [{ pairToken: FAKE_SYNC, quoteSymbol: 'SYNC' }] });
  const c = await ctx(); const page = await c.newPage();
  await page.goto(BASE + '/network.html');
  await page.waitForFunction(() => !/Reading live/.test(document.getElementById('networkGrid').textContent), null, { timeout: 20000 });
  const grid = await txt(page, 'networkGrid');
  check('F-P3 project paired with a FAKE SYNC (other address, same ticker) is listed under "RECENT $SYNC CONNECTIONS"', /Totally Official SyncNet Child/.test(grid), grid.slice(0, 160));
  LAUNCHES.shift();
  await c.close();
}

// ------------------------------------------------------------------ F-P1: VERIFIED TRANSFERABLE for a contract fee recipient
{
  const row = LAUNCHES.find((l) => l.token === A.CREATORLIVE); const prev = row.creatorFeeRecipient;
  row.creatorFeeRecipient = A.USDG; // any address with code, e.g. a multisig or an X/GitHub creator-account contract
  const c = await ctx(); const page = await c.newPage(); page.on('dialog', (d) => d.accept());
  await page.goto(BASE + '/marketplace.html');
  await page.click('[data-mp-view="sell"]'); await page.click('[data-mp-type="live"]');
  await page.fill('#mp-token-address', A.CREATORLIVE); await page.click('#mp-check-live');
  await page.waitForFunction(() => /PAR launch found/.test(document.getElementById('mp-live-check-status').textContent), null, { timeout: 15000 });
  const fees = await page.$eval('select[data-asset="fees"]', (s) => s.value);
  check('F-P1 marketplace marks a CONTRACT recipient as verified-transferable', fees === 'verified-transferable', 'fees=' + fees);
  await page.goto(BASE + '/project/' + A.CREATORLIVE);
  await page.waitForFunction(() => /Depends on that contract|transfer the right|fixed to a PAR vault/.test(document.getElementById('passportPanel')?.textContent || ''), null, { timeout: 20000 });
  check('F-P1 while the Passport for the same token says "Depends on that contract"', /Depends on that contract/.test(await txt(page, 'passportPanel')));
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
  check('F-P4 description longer than 96 chars is rendered as "Description: Token…"', /Description:\s*Token…/.test(card), (card.match(/Description:[^\n]{0,40}/) || [''])[0]);
  check('F-P5 token with an http:// website is shown as "Website in token metadata: None"', /WebsiteintokenmetadataNone/.test((await txt(page, "passportPanel")).replace(/\s+/g, "")));
  delete row.description; row.website = prevW;
  await c.close();
}

// ------------------------------------------------------------------ F-R3: transient post-send failure → recovery button deletes the only copy of the intent record
{
  resetChain();
  const c = await ctx();
  // A lagging RPC node: the receipt is there, but eth_getCode for the new token still returns 0x for >12 s.
  await c.route('https://rpc.mainnet.chain.robinhood.com/**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const one = (q) => q.method === 'eth_getCode' && String(q.params?.[0]).toLowerCase() === A.PREDICTED.toLowerCase();
    if (!Array.isArray(body) && one(body) && globalThis.__lagCode) return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: '0x' } });
    return route.fallback();
  });
  const page = await c.newPage(); page.on('dialog', (d) => d.accept());
  await founderReady(page, { name: 'LAGTEST', symbol: 'LAGT' });
  await simulateSignConfirm(page, 'LAGT');
  globalThis.__lagCode = true;
  await page.click('#launchLive');
  await waitText(page, 'liveStatus', /WAS sent|CONFIRMED/, 90000);
  check('F-R3 launch mined, but a lagging node makes the page stop without saving a proof', Boolean(chain.launched) && /bytecode was not readable/.test(await txt(page, 'liveStatus')), (await txt(page, 'liveStatus')).slice(0, 160));
  const pend = await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_pending_launches') || '[]'));
  check('F-R3 the intent record + signature now exist only inside the pending entry', pend.length === 1 && pend[0].intentRecord && pend[0].intentSignature && (await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_live_launch_proofs') || '[]').length)) === 0);
  check('F-R3 no export button is offered on this path', (await page.locator('#exportLaunchProof').count()) === 0);
  globalThis.__lagCode = false;
  await page.goto(BASE + '/build.html?live=canary');
  const before = await txt(page, 'simStatus');
  check('F-R3 reload notice names only ticker + tx hash, never the predicted token address, and does not check the chain', /has not been verified yet/.test(before) && !new RegExp(A.PREDICTED.slice(2, 12), 'i').test(before), before.slice(0, 140));
  await page.click('#tab-4'); await page.fill('#canaryKey', 'founder-key'); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  const afterUnlock = (await txt(page, 'simStatus')) + ' | ' + (await txt(page, 'liveStatus'));
  check('F-R3 unlocking founder mode wipes the pending warning text (only the CLEAR button remains)', !/has not been verified yet|Unverified launch/.test(afterUnlock) && await page.getByText('I CHECKED IT — CLEAR NOTICE').isVisible(), afterUnlock.slice(0, 160));
  await page.getByText('I CHECKED IT — CLEAR NOTICE').click();
  await page.waitForLoadState('load'); await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ p: JSON.parse(localStorage.getItem('syncnet_pending_launches') || '[]').length, q: JSON.parse(localStorage.getItem('syncnet_live_launch_proofs') || '[]').length }));
  check('F-R3 following the recovery button erases the record: intent JSON/signature are gone for good', after.p === 0 && after.q === 0, JSON.stringify(after));
  await c.close();
}

// ------------------------------------------------------------------ F-P7: any address gets a "NETWORK HUB" badge
{
  const c = await ctx(); const page = await c.newPage();
  const RANDOM = '0x1234567890abcdef1234567890abcdef12345678';
  await page.goto(BASE + '/project/' + RANDOM);
  await page.waitForFunction(() => /NETWORK HUB|UNAVAILABLE/.test(document.body.textContent), null, { timeout: 20000 });
  const card = await txt(page, 'tokenCard');
  check('F-P7 an arbitrary contract (not on PAR, used by no project) is badged "NETWORK HUB" on a SyncNet page', /NETWORK HUB/.test(card) && /Projectsusingthistokenasamarket0/.test(card.replace(/\s+/g, '')), card.slice(0, 160));
  await c.close();
}

// ------------------------------------------------------------------ F-P7b: static "Ownerless · immutable" claims for non-PAR contracts
{
  const c = await ctx(); const page = await c.newPage();
  await page.goto(BASE + '/project/' + A.USDG);
  await page.waitForFunction(() => /Website in token metadata/.test(document.getElementById('passportPanel')?.textContent || ''), null, { timeout: 20000 });
  const pp = (await txt(page, 'passportPanel')).replace(/\s+/g, ' ');
  check('F-P7 Passport of a NON-PAR contract (USDG) still states "Ownerless · immutable · never transferred" and "Only the creator-fee recipient" can change', /Not a PAR launch/.test(pp) && /Ownerless · immutable · never transferred/.test(pp) && /Only the creator-fee recipient/.test(pp), pp.slice(0, 220));
  await c.close();
}

// ------------------------------------------------------------------ F-R1 (N1): an edit while the wallet popup is open loses the hash
{
  resetChain();
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
  // founder notices a typo while the wallet popup is open and edits the description, then approves in the wallet
  await page.evaluate(() => { const d = document.getElementById('description'); d.value = 'PoC edited'; d.dispatchEvent(new Event('input', { bubbles: true })); });
  await waitText(page, 'liveStatus', /WAS sent|CONFIRMED|No transaction/, 30000);
  const live = await txt(page, 'liveStatus');
  const pend = await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_pending_launches') || '[]').length);
  check('F-R1/N1 tx broadcast; page claims "The hash is saved in this browser" but nothing was saved', Boolean(chain.launched) && /hash is saved in this browser/.test(live) && pend === 0, 'pending=' + pend + ' :: ' + live.slice(0, 160));
  await page.reload(); await page.waitForTimeout(700);
  check('F-R1/N1 after reload: no notice, draft offered again', !/has not been verified yet/.test(await txt(page, 'simStatus')) && await page.locator('#draftBanner').isVisible());
  await c.close();
}

// ------------------------------------------------------------------ F-UX1 (N5): Review shows the old fee recipient after an account switch
{
  resetChain();
  const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002';
  const c = await ctx();
  await c.addInitScript((B) => {
    const p = window.ethereum; const orig = p.request.bind(p); const origOn = p.on; window.__ls = {};
    p.on = (e, f) => { (window.__ls[e] ||= []).push(f); return origOn(e, f); };
    p.request = async (a) => { if (window.__acct && (a.method === 'eth_accounts' || a.method === 'eth_requestAccounts')) return [window.__acct]; if (a.method === 'eth_sendTransaction' && window.__acct) { a = { ...a, params: [{ ...a.params[0] }] }; } return orig(a); };
  }, B);
  const page = await c.newPage();
  await page.goto(BASE + '/build.html');
  await page.click('#tab-1'); await page.fill('#name', 'REVIEWT'); await page.fill('#symbol', 'REVT'); await page.check('input[name="websiteChoice"][value="none"]');
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await waitText(page, 'assetStatus', /SYNC ready/);
  await page.click('#tab-3'); await page.check('input[name="feeMode"][value="creator"]');
  await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
  await page.click('#tab-3'); await page.click('#tab-4'); // Review rendered with wallet A
  const before = await txt(page, 'reviewRewards');
  await page.evaluate((B) => { window.__acct = B; (window.__ls.accountsChanged || []).forEach((f) => f([B])); }, B);
  await page.click('#runSimulation'); await waitText(page, 'simStatus', /SIMULATION PASSED|No transaction/);
  const review = await txt(page, 'reviewRewards'), sim = await txt(page, 'simStatus');
  check('F-UX1 Review still names wallet A as fee recipient while the simulated calldata pays wallet B', new RegExp(A.WALLET, 'i').test(review) && review === before && new RegExp(B, 'i').test(sim) && !new RegExp(B, 'i').test(review), 'review=' + review.slice(0, 90) + ' | sim has B=' + new RegExp(B, 'i').test(sim));
  await c.close();
}

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/audit/poc-e2e.json'), JSON.stringify({ results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} reproduced`);
