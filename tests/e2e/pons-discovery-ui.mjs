// PONS V2 discovery · browser suite for the Economy page and the Network Map, against the REAL /api/pons-economy,
// /api/economies functions (Upstash emulation) and the mock chain (exact Pons V2 ABI, Multicall3).
//   flag OFF → both pages render exactly as before (no PONS section, unchanged copy)
//   Economy: PAR-only, PONS-only, mixed roots · separate sections + labels · LOAD MORE · PONS down → PAR intact ·
//            PONS V2 root curator → existing Passport claim path (never the manual request form)
//   Network: PONS children + labels · mixed counts · PONS center shows its launch pair (and native ETH, unlinked) ·
//            12 / show-all / batches preserved · server LOAD MORE distinct from local reveal · no duplicates
// No real network. Run: node tests/e2e/pons-discovery-ui.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { startServer, installRoutes, setFlags, A, chain, resetChain, resetServer, ROOT } from './harness.mjs';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'));

const require = createRequire(import.meta.url);
const Index = require(path.join(ROOT, 'netlify/lib/pons-index.js'));
const Origins = require(path.join(ROOT, 'lib/syncnet-origins.js'));
const { getStore } = require(path.join(ROOT, 'netlify/lib/store.js'));

const PORT = 8953, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 400)); } else console.log('ok  ', name); }
async function suite(name, fn) { console.log('\n# ' + name); try { await fn(); } catch (e) { failures++; console.log('FAIL (exception)', name, e.stack || e); } }
const lc = (v) => String(v).toLowerCase();
const USDG = lc(A.USDG), SYNC = lc(A.SYNC), PONS2 = lc(A.PONS2), PONS2_PENDING = lc(A.PONS2_PENDING), PONS2_ETH = lc(A.PONS2_ETH);
const STACK = Origins.PONS_V2_STACKS[0];
const synth = (i) => '0x7a3' + i.toString(16).padStart(37, '0');
let seq = 0;
const fact = (token, root, block) => ({ token: lc(token), root, stack: STACK.id, factory: STACK.factory, block: block || STACK.fromBlock + 1000 + seq, logIndex: seq++ % 5 });

const srv = await startServer(PORT);
const browser = await chromium.launch();
async function fresh({ pons = true, curation = true } = {}) {
  resetChain(); resetServer(); setFlags({ economyCuration: curation, ponsDiscovery: pons }); Index._resetCache();
  const store = getStore();
  await Index.writeCursor(store, STACK.id, STACK.fromBlock + 90000, '0x' + 'ab'.repeat(32), Date.now());
  return store;
}
/** A synthetic PONS V2 launch: canonical factory record in the mock chain + an index entry. */
function ponsChild(token, root, phase = 0) { chain.pons.set(lc(token), { deployer: A.WALLET, creatorFeeRecipient: A.WALLET, pairToken: lc(root), phase, creatorTaxBps: 0, buyback: false, pending: null }); }
async function ctx(width = 1280) {
  const c = await browser.newContext({ viewport: { width, height: 950 } });
  await installRoutes(c);
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e)));
  return { c, page };
}
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
const ecoReady = (page) => page.waitForFunction(() => !document.getElementById('ecoCard').hidden && !document.getElementById('ecoConnectedSection').hidden, null, { timeout: 20000 });
const mapReady = (page) => page.waitForFunction(() => /IN CONTEXT/.test(document.getElementById('topologyTitle')?.textContent || ''), null, { timeout: 20000 });
const childCards = (page) => page.$$eval('#topologyChildren .topology-node.child', (a) => a.map((x) => ({ t: x.getAttribute('href').split('token=')[1].toLowerCase(), s: [...x.querySelectorAll('.node-status')].map((e) => e.textContent).join(' | ') })));
const buttons = (page) => page.$$eval('#topologyChildMore button', (b) => b.map((x) => x.textContent.trim()));

// ======================================================================= ECONOMY
await suite('Economy · flag OFF: identical to main', async () => {
  const store = await fresh({ pons: false });
  await Index.writeLaunches(store, [fact(PONS2, USDG)]);
  const { c, page } = await ctx();
  await page.goto(BASE + '/economy.html?root=' + USDG); await ecoReady(page); await page.waitForTimeout(400);
  check('OFF: no PONS section', await page.$eval('#ecoPonsSection', (e) => e.hidden));
  check('OFF: original lead copy', /^Every PAR project with an on-chain market paired with/.test(await txt(page, '#ecoLead')));
  check('OFF: original fact label and section title', /Connected projects \(indexed PAR history\)/.test(await txt(page, '#ecoFacts')) && !/PONS/.test(await txt(page, '#ecoFacts')) && (await txt(page, '#ecoConnectedTitle')) === 'CONNECTED PROJECTS.');
  check('OFF: no PONS card anywhere', !(await page.evaluate(() => document.body.innerText)).includes('PONS V2 LAUNCH PAIR'));
  check('OFF: no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Economy · mixed root (USDG): PAR and PONS V2 listed separately', async () => {
  const store = await fresh();
  await Index.writeLaunches(store, [fact(PONS2, USDG), fact(PONS2_PENDING, USDG)]);
  const { c, page } = await ctx();
  await page.goto(BASE + '/economy.html?root=' + USDG); await ecoReady(page);
  await page.waitForFunction(() => !document.getElementById('ecoPonsSection').hidden, null, { timeout: 15000 });
  const par = await page.$$eval('#ecoConnected article', (x) => x.map((a) => a.dataset.child));
  const pons = await page.$$eval('#ecoPons article', (x) => x.map((a) => a.dataset.child));
  check('PAR section keeps its PAR children (SYNC has a USDG market)', par.includes(SYNC) && !par.includes(PONS2), par.join());
  check('PONS section lists both PONS children, newest first', pons.join() === [PONS2_PENDING, PONS2].join(), pons.join());
  const ponsText = await txt(page, '#ecoPons');
  check('PONS cards: CONNECTED · PONS V2 LAUNCH PAIR + factual phase, never "PAR"/"official"', /CONNECTED · PONS V2 LAUNCH PAIR/.test(ponsText) && /PONS · BONDING CURVE/.test(ponsText) && !/ON-CHAIN PAR MARKET|OFFICIAL|PARTNER/i.test(ponsText), ponsText);
  check('PONS cards link to /project/<token>', (await page.$$eval('#ecoPons a[href^="/project/"]', (x) => x.map((a) => a.getAttribute('href')))).includes('/project/' + PONS2));
  check('PAR cards keep their PAR label only', /CONNECTED · ON-CHAIN PAR MARKET/.test(await txt(page, '#ecoConnected')) && !/PONS/.test(await txt(page, '#ecoConnected')));
  check('section titles are source-specific', (await txt(page, '#ecoConnectedTitle')) === 'CONNECTED VIA PAR.' && /CONNECTED VIA PONS V2/.test(await txt(page, '#ecoPonsSection')));
  const facts = await txt(page, '#ecoFacts');
  check('facts show PAR and PONS V2 counts separately', /Connected via PAR/.test(facts) && /Connected via PONS V2 \(indexed launches\)\s*2/.test(facts), facts);
  check('coverage: PONS V2 indexed launches + indexed-through block', /PONS V2: 2 indexed launches against this root · indexed through block/.test(await txt(page, '#ecoPonsCoverage')));
  check('lead copy is source-neutral and truthful', /observable launch or market relationship/.test(await txt(page, '#ecoLead')) && /PAR markets and canonical PONS V2 launches, listed separately/.test(await txt(page, '#ecoLead')));
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Economy · PAR-only root unchanged, PONS-only root, pagination', async () => {
  const store = await fresh();
  const R = '0x' + '3d'.repeat(20);
  for (let i = 0; i < 30; i++) { ponsChild(synth(i), R, i % 4); }
  await Index.writeLaunches(store, Array.from({ length: 30 }, (_, i) => fact(synth(i), R, STACK.fromBlock + 5000 + i)));
  const { c, page } = await ctx();
  await page.goto(BASE + '/economy.html?root=' + SYNC); await ecoReady(page);
  await page.waitForFunction(() => !document.getElementById('ecoPonsSection').hidden, null, { timeout: 15000 });
  const parOn = await page.$$eval('#ecoConnected article', (x) => x.map((a) => a.dataset.child).sort().join());
  check('PAR-only root: PONS section says none, PAR list present', /No canonical PONS V2 launch was launched against this root/.test(await txt(page, '#ecoPons')) && parOn.length > 0);
  await c.close();
  await fresh({ pons: false });
  const off = await ctx();
  await off.page.goto(BASE + '/economy.html?root=' + SYNC); await ecoReady(off.page);
  check('PAR-only root: the PAR cards are exactly the same with the flag off and on', (await off.page.$$eval('#ecoConnected article', (x) => x.map((a) => a.dataset.child).sort().join())) === parOn);
  await off.c.close();

  const store2 = await fresh();
  for (let i = 0; i < 30; i++) ponsChild(synth(i), R, i % 4);
  await Index.writeLaunches(store2, Array.from({ length: 30 }, (_, i) => fact(synth(i), R, STACK.fromBlock + 5000 + i)));
  const { c: c2, page: p2 } = await ctx();
  await p2.goto(BASE + '/economy.html?root=' + R); await ecoReady(p2);
  await p2.waitForFunction(() => document.querySelectorAll('#ecoPons article').length > 0, null, { timeout: 15000 });
  check('PONS-only root: PAR says none, PONS shows the first 24 of 30', /No other indexed PAR launch/.test(await txt(p2, '#ecoConnected')) && (await p2.$$('#ecoPons article')).length === 24 && /Loaded 24 of 30 PONS V2 launches/.test(await txt(p2, '#ecoPonsCount')));
  const labels = await txt(p2, '#ecoPons');
  check('phase labels: bonding curve / curve closed · pool pending / graduated · V4 / rescued', /PONS · BONDING CURVE/.test(labels) && /PONS · CURVE CLOSED · POOL PENDING/.test(labels) && /PONS · GRADUATED · V4/.test(labels) && /PONS · RESCUED/.test(labels));
  check('LOAD MORE is visible (never silently truncated)', !(await p2.$eval('#ecoPonsMore', (e) => e.hidden)));
  await p2.click('#ecoPonsMore');
  await p2.waitForFunction(() => document.querySelectorAll('#ecoPons article').length === 30, null, { timeout: 15000 });
  const all = await p2.$$eval('#ecoPons article', (x) => x.map((a) => a.dataset.child));
  check('LOAD MORE appends the next page: 30 unique cards, then the control disappears', new Set(all).size === 30 && (await p2.$eval('#ecoPonsMore', (e) => e.hidden)) && /All 30 PONS V2 launches loaded/.test(await txt(p2, '#ecoPonsCount')));
  check('no page errors', p2.__errors.length === 0, p2.__errors.join(' | '));
  await c2.close();
});

await suite('Economy · PONS unavailable → PAR still visible', async () => {
  await fresh();
  const { c, page } = await ctx();
  await c.route(/\/api\/pons-economy/, (r) => r.fulfill({ status: 503, json: { error: 'PONS discovery is temporarily unavailable.', code: 'unavailable' } }));
  await page.goto(BASE + '/economy.html?root=' + USDG); await ecoReady(page);
  await page.waitForFunction(() => !document.getElementById('ecoPonsSection').hidden, null, { timeout: 15000 });
  check('PAR section renders normally', (await page.$$eval('#ecoConnected article', (x) => x.map((a) => a.dataset.child))).includes(SYNC));
  check('one small neutral note in the PONS section', (await txt(page, '#ecoPons')).trim() === 'PONS discovery is temporarily unavailable.' && (await page.$eval('#ecoPonsMore', (e) => e.hidden)));
  check('the Economy did not fail', !/ECONOMY UNAVAILABLE/.test(await txt(page, '#ecoTitle')));
  await c.close();
});

await suite('Economy · PONS V2 root curator → existing Passport claim path', async () => {
  await fresh();
  const { c, page } = await ctx();
  await page.goto(BASE + '/economy.html?root=' + PONS2_PENDING); await ecoReady(page);
  await page.waitForFunction(() => /PONS V2 launch/.test(document.getElementById('ecoCurator')?.innerText || ''), null, { timeout: 15000 });
  check('PONS V2 root without a Passport: points to CLAIM THE PROJECT PASSPORT', /CLAIM THE PROJECT PASSPORT/.test(await txt(page, '#ecoClaim')) && /PONS V2 launch/.test(await txt(page, '#ecoCurator')));
  check('…and never shows the generic manual curator-request form', !(await page.$('#ecoEvidence')));
  check('root badge: PONS V2 LAUNCH · FACTORY RECORD ON-CHAIN', /PONS V2 LAUNCH · FACTORY RECORD ON-CHAIN/.test(await txt(page, '#ecoBadges')));
  await c.close();
  await fresh({ pons: false });
  const off = await ctx();
  await off.page.goto(BASE + '/economy.html?root=' + PONS2_PENDING); await ecoReady(off.page); await off.page.waitForTimeout(500);
  check('flag OFF: PONS V2 root curator UX unchanged from main (manual request form)', Boolean(await off.page.$('#ecoEvidence')));
  await off.c.close();
  await fresh();
  const v1 = await ctx();
  await v1.page.goto(BASE + '/economy.html?root=' + lc(A.PONS1)); await ecoReady(v1.page); await v1.page.waitForTimeout(800);
  check('PONS V1 root behaviour unchanged (not routed to a Passport claim)', !/CLAIM THE PROJECT PASSPORT/.test(await txt(v1.page, '#ecoClaim')));
  await v1.c.close();
});

// ======================================================================= NETWORK MAP
await suite('Network · flag OFF: unchanged', async () => {
  const store = await fresh({ pons: false });
  await Index.writeLaunches(store, [fact(PONS2, USDG)]);
  const { c, page } = await ctx();
  await page.goto(BASE + '/network.html?token=' + USDG); await mapReady(page);
  const cards = await childCards(page);
  check('OFF: no PONS children, PAR labels only, original copy', !cards.some((x) => x.t === PONS2) && !cards.some((x) => /PONS/.test(x.s)) && /projects? uses? it as a market/.test(await txt(page, '#topologyMeta')) && !/PONS/.test(await txt(page, '#topologyGraph')));
  check('OFF: no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Network · mixed PAR + PONS children, source labels, dedupe', async () => {
  const store = await fresh();
  await Index.writeLaunches(store, [fact(PONS2, USDG), fact(PONS2_PENDING, USDG), fact(SYNC, USDG)]); // SYNC: forged index entry that is ALSO a PAR child
  const { c, page } = await ctx();
  await page.goto(BASE + '/network.html?token=' + USDG); await mapReady(page);
  const cards = await childCards(page);
  const by = Object.fromEntries(cards.map((x) => [x.t, x.s]));
  const FAKESYNC = lc(A.FAKESYNC);
  check('PAR-only child keeps its PAR-side label, no PONS role', by[FAKESYNC] && !/PONS/.test(by[FAKESYNC]), JSON.stringify(by));
  check('PONS children appear with PONS V2 · BONDING CURVE, not PAR INDEXED', /PONS V2 · BONDING CURVE/.test(by[PONS2] || '') && !/PAR INDEXED/.test(by[PONS2]) && /PONS V2 · BONDING CURVE/.test(by[PONS2_PENDING] || ''));
  check('a token from both sources is ONE card, both roles kept (SyncNet provenance + PONS V2)', cards.filter((x) => x.t === SYNC).length === 1 && /SYNCNET NETWORK ASSET/.test(by[SYNC]) && /PONS V2/.test(by[SYNC]), by[SYNC]);
  check('an index entry the live factory does not confirm shows PONS V2 · PHASE UNAVAILABLE (never a phase)', /PONS V2 · PHASE UNAVAILABLE/.test(by[SYNC]), by[SYNC]);
  check('no duplicate cards', new Set(cards.map((x) => x.t)).size === cards.length);
  const meta = await txt(page, '#topologyMeta');
  check('source-aware totals: "N PAR connections · 3 PONS V2 connections"', /\d+ PAR connections? · 3 PONS V2 connections/.test(meta), meta);
  check('child line label reads MARKET · PONS V2 LAUNCH PAIR', /MARKET · PONS V2 LAUNCH PAIR/.test(await txt(page, '#topologyGraph')));
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Network · PONS token as the center node', async () => {
  await fresh();
  const { c, page } = await ctx();
  await page.goto(BASE + '/network.html?token=' + PONS2); await mapReady(page);
  const g = await txt(page, '#topologyGraph');
  check('center shows its own launch pair: THIS TOKEN WAS LAUNCHED AGAINST $USDG', /THIS TOKEN WAS LAUNCHED AGAINST/.test(g) && /\$USDG/.test(g), g.slice(0, 300));
  check('edge is "LAUNCHED AGAINST · PONS V2", never a PAR "market"', /LAUNCHED AGAINST · PONS V2/.test(g) && !/direct market/.test(await txt(page, '#topologyMeta')));
  check('center provenance is PONS V2 · BONDING CURVE', /PONS V2 · BONDING CURVE/.test(await page.$eval('.topology-root', (e) => e.innerText)));
  check('meta: PONS V2 launch · launched against $USDG', /PONS V2 launch · launched against \$USDG/.test(await txt(page, '#topologyMeta')));
  await page.goto(BASE + '/network.html?token=' + PONS2_ETH); await mapReady(page);
  const g2 = await page.$eval('#topologyGraph', (e) => e.innerHTML);
  check('native-ETH pair shown as ETH (native), never linked to /project/0x000… or the map of 0x000…', /native · not a contract/.test(g2) && !/0x0{40}/.test(g2) && /PONS V2 · GRADUATED · V4/.test(g2));
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Network · expansion: 12 / show all loaded / server load more', async () => {
  const store = await fresh();
  const R = lc(A.NET); // a contract in the mock chain; its PAR rows are replaced below
  for (let i = 0; i < 60; i++) ponsChild(synth(100 + i), R, 0);
  await Index.writeLaunches(store, Array.from({ length: 60 }, (_, i) => fact(synth(100 + i), R, STACK.fromBlock + 7000 + i)));
  const parRows = Array.from({ length: 10 }, (_, i) => ({ token: '0x7a4' + i.toString(16).padStart(37, '0'), name: 'Par ' + i, symbol: 'PAR' + i, markets: [{ index: 0, pairToken: R }] }));
  const { c, page } = await ctx();
  let parFetches = 0, ponsFetches = 0;
  await c.route(/localhost:\d+\/api\/par-launches-all/, (r) => { parFetches++; return r.fulfill({ json: { count: parRows.length, indexed: parRows.length, launches: parRows } }); });
  page.on('request', (rq) => { if (/\/api\/pons-economy/.test(rq.url())) ponsFetches++; });
  await page.goto(BASE + '/network.html?token=' + R); await mapReady(page);
  let cards = await childCards(page);
  check('initial render: exactly 12 cards (PAR first, then PONS)', cards.length === 12 && cards[0].t === parRows[0].token.toLowerCase(), String(cards.length));
  let b = await buttons(page);
  check('controls: local "SHOW ALL 60 LOADED CONNECTIONS" and separate "LOAD MORE FROM PONS V2 · 50 OF 60 LOADED"', b.includes('SHOW ALL 60 LOADED CONNECTIONS') && b.includes('LOAD MORE FROM PONS V2 · 50 OF 60 LOADED'), b.join('|'));
  let meta = await txt(page, '#topologyMeta');
  check('meta: 10 PAR connections · 60 PONS V2 connections (showing 12 of 60 loaded)', /10 PAR connections · 60 PONS V2 connections \(showing 12 of 60 loaded\)/.test(meta), meta);
  const pf = ponsFetches;
  await page.click('[data-child-more]');
  cards = await childCards(page);
  check('local reveal shows every LOADED card without any refetch', cards.length === 60 && ponsFetches === pf && parFetches === 1, `${cards.length} ${ponsFetches} ${parFetches}`);
  b = await buttons(page);
  check('after local reveal the server control remains (not everything is loaded yet)', b.some((x) => /LOAD MORE FROM PONS V2/.test(x)) && b.includes('SHOW FIRST 12'), b.join('|'));
  await page.click('[data-child-server]');
  await page.waitForFunction(() => document.querySelectorAll('#topologyChildren .topology-node.child').length === 70, null, { timeout: 15000 });
  cards = await childCards(page);
  check('server LOAD MORE appends the next PONS page: 70 unique cards', cards.length === 70 && new Set(cards.map((x) => x.t)).size === 70 && ponsFetches === pf + 1);
  b = await buttons(page);
  meta = await txt(page, '#topologyMeta');
  check('when the source is exhausted the server control disappears and copy says all shown', !b.some((x) => /PONS V2/.test(x)) && /\(all 70 shown\)/.test(meta), b.join('|') + ' :: ' + meta);
  await page.click('[data-child-collapse]');
  check('collapse back to 12 still works', (await childCards(page)).length === 12);
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Network · PONS unavailable → PAR map intact', async () => {
  await fresh();
  const { c, page } = await ctx();
  await c.route(/\/api\/pons-economy/, (r) => r.fulfill({ status: 503, json: { error: 'PONS discovery is temporarily unavailable.' } }));
  await page.goto(BASE + '/network.html?token=' + USDG); await mapReady(page);
  const cards = await childCards(page);
  check('PAR children still mapped', cards.some((x) => x.t === SYNC));
  check('small neutral note in the meta line', /PONS discovery is temporarily unavailable\./.test(await txt(page, '#topologyMeta')));
  await c.close();
});

await browser.close(); srv.close();
console.log(`\n${results.length - failures}/${results.length} pons discovery UI checks passed`);
process.exit(failures ? 1 : 0);
