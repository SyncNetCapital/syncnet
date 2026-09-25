// Economies V0 — browser walkthrough of /economy.html against the REAL /api/economies + /api/marketplace functions,
// the mock PAR indexer and the mock chain:
//   derived membership (address match, fake-ticker exclusion) → curator = Passport operator (claimed through the
//   unchanged Marketplace) → RECOGNIZE (one EIP-712 signature) → PARENT-RECOGNIZED seen from a second browser →
//   child drops out of the index window / indexer down (never shown as indexer-confirmed) → REVOKE →
//   "Create a project in the $X Economy" opens the existing Builder prefill → entry points from Map + Project page
//   → no ranking page, no OFFICIAL badge, no volume/TVL → mobile widths. Nothing touches a real network.
// Screenshots: set ECONOMY_SHOTS=<dir>. Run: node tests/regression/rc-economy.mjs
import { startServer, installRoutes, setFlags, A, chain, resetChain, resetServer, LAUNCHES, signDigest, ROOT } from '../e2e/harness.mjs';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));
const require = createRequire(import.meta.url);
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));

const PORT = 8947, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.ECONOMY_SHOTS || '';
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const lc = (v) => String(v).toLowerCase();
const SYNC = lc(A.SYNC), SYNCAT = lc(A.SYNCAT), CATF0 = '0x8' + '0'.repeat(39), CREATORLIVE = lc(A.CREATORLIVE);
const rnd = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

const srv = await startServer(PORT);
resetChain(); resetServer(); setFlags({ economyCuration: true });
const browser = await chromium.launch();
async function newCtx(account, width = 1280) {
  const c = await browser.newContext({ viewport: { width, height: 950 } });
  await installRoutes(c);
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e)));
  if (account) await page.addInitScript((a) => { window.__mockAccount = a; }, account);
  return { c, page };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const ready = (page) => page.waitForFunction(() => !document.getElementById('ecoCard').hidden && !document.getElementById('ecoConnectedSection').hidden, null, { timeout: 20000 });

// ================================================================= no root: no ranking / leaderboard
{
  const { c, page } = await newCtx();
  await page.goto(BASE + '/economy.html'); await page.waitForTimeout(700);
  const body = await page.evaluate(() => document.body.innerText);
  check('no root: only an address picker is shown (no Economy ranking or leaderboard)', !(await page.$eval('#ecoPick', (e) => e.hidden)) && (await page.$$('#ecoConnected article')).length === 0 && !/rank|leaderboard|top economies|largest/i.test(body));
  await page.fill('#ecoRootInput', 'SYNC'); await page.click('#ecoOpen');
  check('no root: a ticker is refused (address only)', /not a contract address/.test(await text(page, '#ecoPickStatus')));
  await c.close();
}

// ================================================================= derived membership, unclaimed root
const S = await newCtx(); // curator browser (mock wallet account A.WALLET = $SYNC deployer)
{
  await S.page.goto(BASE + '/economy.html?root=' + SYNC); await ready(S.page);
  const connected = await S.page.$$eval('#ecoConnected article', (xs) => xs.map((x) => x.dataset.child));
  check('derived: every PAR launch with a market paired with $SYNC is listed', [SYNCAT, CATF0, lc(A.PONS_FAKE), lc(A.EVIL)].every((a) => connected.includes(a)), connected.join(','));
  check('derived: projects not paired with $SYNC are absent (CREATORLIVE, the fake-SYNC contract itself)', !connected.includes(CREATORLIVE) && !connected.includes(lc(A.FAKESYNC)));
  check('derived: the root is not its own child', !connected.includes(SYNC));
  const card = await text(S.page, '#ecoConnected');
  check('derived: children carry CONNECTED · ON-CHAIN PAR MARKET, never OFFICIAL', /CONNECTED · ON-CHAIN PAR MARKET/.test(card) && !/OFFICIAL/i.test(await S.page.evaluate(() => document.body.innerText)));
  check('unclaimed PAR root: guidance points to the existing Passport claim', /UNCLAIMED/.test(await text(S.page, '#ecoCurator')) && (await S.page.$('#ecoClaim a[href="/marketplace.html"]')) !== null);
  check('no volume / TVL / fee aggregates in the Economy content (the footer only disclaims them)', !/\bTVL\b|volume|total value locked|fees earned|market cap/i.test(await S.page.evaluate(() => document.querySelector('main').innerText)));
  check('build link: the existing Builder prefill (?with=<root>)', (await S.page.getAttribute('#ecoBuild', 'href')) === '/build.html?with=' + SYNC && /CREATE A PROJECT IN THE \$SYNC ECONOMY/.test(await text(S.page, '#ecoBuild')));
  check('stats: only connected + parent-recognized counts, with the index coverage stated', /^CONNECTED PROJECTS \(INDEXED PAR HISTORY\)\n\d+\nPARENT-RECOGNIZED\n\d+$/i.test(await text(S.page, '#ecoFacts')) && /indexed PAR launch/.test(await text(S.page, '#ecoCoverage')), await text(S.page, '#ecoFacts'));
  await shot(S.page, '01-economy-unclaimed');
}

// ================================================================= claim Passport (unchanged Marketplace), recognize
{
  const m = { token: SYNC, operator: lc(A.WALLET), basis: 'deployer', nonce: rnd(), expiry: Math.floor(Date.now() / 1000) + 600 };
  const r = await mp._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.9.9.9' }, body: JSON.stringify({ action: 'claim', ...m, signature: signDigest(A.WALLET, Market.digest('OperatorClaim', m)) }) });
  check('setup: $SYNC Passport claimed through the unchanged Marketplace claim', r.statusCode === 200, r.body);
  await S.page.reload(); await ready(S.page);
  check('curator: the Passport operator is shown as the $SYNC operator', /\$SYNC OPERATOR/.test(await text(S.page, '#ecoCuratorTitle')) && (await text(S.page, '#ecoCurator')).includes(lc(A.WALLET)));
  check('before connecting a wallet no RECOGNIZE control is shown', (await S.page.$$('[data-eco-act]')).length === 0);
  await S.page.click('#ecoConnect');
  await S.page.waitForSelector(`[data-eco-act="recognize"][data-child="${SYNCAT}"]`, { timeout: 10000 });
  check('connected curator sees RECOGNIZE on connected projects', (await S.page.$$('[data-eco-act="recognize"]')).length >= 4);
  await S.page.click(`[data-eco-act="recognize"][data-child="${SYNCAT}"]`);
  await S.page.waitForFunction((c) => document.querySelector(`#ecoRecognized article[data-child="${c}"]`), SYNCAT, { timeout: 15000 });
  const typed = JSON.parse(await S.page.evaluate(() => window.__typed));
  check('the wallet signed EIP-712 "SyncNet Economies" EconomyCuration (no transaction)', typed.domain.name === 'SyncNet Economies' && typed.primaryType === 'EconomyCuration' && typed.message.decision === 'recognize' && !(await S.page.evaluate(() => (window.__walletCalls || []).includes('eth_sendTransaction'))));
  const rec = await text(S.page, '#ecoRecognized');
  check('recognized project shows PARENT-RECOGNIZED + RECOGNIZED BY $SYNC OPERATOR', /PARENT-RECOGNIZED/.test(rec) && /RECOGNIZED BY \$SYNC OPERATOR/.test(rec));
  check('recognized project also keeps its CONNECTED (indexer) label', /CONNECTED · ON-CHAIN PAR MARKET/.test(rec));
  check('recognized project no longer duplicated in the connected list', !(await S.page.$(`#ecoConnected article[data-child="${SYNCAT}"]`)));
  await shot(S.page, '02-economy-recognized-curator');
  await S.page.click(`[data-eco-act="recognize"][data-child="${CATF0}"]`);
  await S.page.waitForFunction((c) => document.querySelector(`#ecoRecognized article[data-child="${c}"]`), CATF0, { timeout: 15000 });
}

// ================================================================= a second, clean browser sees the same signed state
const B = await newCtx(lc(A.WALLET2));
{
  await B.page.goto(BASE + '/economy.html?root=' + SYNC); await ready(B.page);
  const recs = await B.page.$$eval('#ecoRecognized article', (xs) => xs.map((x) => x.dataset.child));
  check('second browser: the same recognitions (server state, not browser state)', recs.includes(SYNCAT) && recs.includes(CATF0));
  await B.page.click('#ecoConnect'); await B.page.waitForTimeout(500);
  check('second browser: a non-curator wallet gets no RECOGNIZE/REVOKE controls', (await B.page.$$('[data-eco-act]')).length === 0 && /not the current curator/.test(await text(B.page, '#ecoWalletNote')));
  check('second browser: nothing Economy-related stored in browser storage', await B.page.evaluate(() => !Object.keys(localStorage).some((k) => /eco|econom/i.test(k))));
}

// ================================================================= outside the index window / indexer down
{
  const i = LAUNCHES.findIndex((l) => lc(l.token) === CATF0);
  const [row] = LAUNCHES.splice(i, 1); // the chain still knows CATF0; the indexer no longer lists it
  await B.page.reload(); await ready(B.page);
  const card = await text(B.page, `#ecoRecognized article[data-child="${CATF0}"]`);
  check('outside index: still PARENT-RECOGNIZED (verified on-chain when recorded)', /PARENT-RECOGNIZED/.test(card));
  check('outside index: labelled CONNECTION PREVIOUSLY VERIFIED · OUTSIDE CURRENT INDEX WINDOW, not as indexer-confirmed', /OUTSIDE CURRENT INDEX WINDOW/.test(card) && !/CONNECTED · ON-CHAIN PAR MARKET/.test(card), card);
  await shot(B.page, '03-economy-outside-index-window');
  chain.indexerDown = true;
  await B.page.reload(); await ready(B.page);
  const down = await text(B.page, '#ecoRecognized');
  check('indexer down: recognitions stay visible, labelled INDEXER UNAVAILABLE, never as connected-now', /INDEXER UNAVAILABLE/.test(down) && !/CONNECTED · ON-CHAIN PAR MARKET/.test(down));
  check('indexer down: connected list says so instead of inferring anything', /indexer is unavailable/i.test(await text(B.page, '#ecoConnected')));
  chain.indexerDown = false;
  LAUNCHES.splice(i, 0, row);
}

// ================================================================= revoke
{
  await S.page.reload(); await ready(S.page); await S.page.click('#ecoConnect');
  await S.page.waitForSelector(`[data-eco-act="revoke"][data-child="${CATF0}"]`, { timeout: 10000 });
  await S.page.click(`[data-eco-act="revoke"][data-child="${CATF0}"]`);
  await S.page.waitForFunction((c) => !document.querySelector(`#ecoRecognized article[data-child="${c}"]`) && document.querySelector(`#ecoConnected article[data-child="${c}"]`), CATF0, { timeout: 15000 });
  check('revoke: the project returns to CONNECTED only', true);
  check('no page errors in the curator browser', S.page.__errors.length === 0, S.page.__errors.join(' | '));
}

// ================================================================= builder prefill, entry points
{
  await S.page.click('#ecoBuild');
  await S.page.waitForURL(/\/build\.html\?with=/, { timeout: 10000 });
  await S.page.waitForFunction((a) => (document.getElementById('selectedAssets')?.innerText || '').toLowerCase().includes(a), SYNC, { timeout: 20000 }).catch(() => {});
  check('Create-in-Economy opens the Builder with the root preselected by its existing ?with= prefill', (await text(S.page, '#selectedAssets')).toLowerCase().includes(SYNC));
  await shot(S.page, '04-builder-prefill');
  await B.page.goto(BASE + '/project/' + SYNC); await B.page.waitForTimeout(2500);
  check('Project page links to the Economy view', (await B.page.getAttribute('a[href^="/economy.html?root="]', 'href').catch(() => '')) === '/economy.html?root=' + SYNC);
  await B.page.goto(BASE + '/network.html?token=' + SYNC); await B.page.waitForTimeout(2500);
  check('Map links to the Economy view of the mapped token', lc(await B.page.getAttribute('#openEconomy', 'href').catch(() => '')) === '/economy.html?root=' + SYNC);
}

// ================================================================= mobile
for (const w of [320, 390]) {
  const { c, page } = await newCtx(null, w);
  await page.goto(BASE + '/economy.html?root=' + SYNC); await ready(page);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(`mobile ${w}px: no horizontal overflow`, over <= 1, 'overflow ' + over);
  if (w === 390) await shot(page, '05-economy-mobile-390');
  await c.close();
}

await S.c.close(); await B.c.close(); await browser.close(); srv.close();
const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-economy.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} economy walkthrough checks passed`);
process.exit(failures ? 1 : 0);
