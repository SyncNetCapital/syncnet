// Pump.fun (Solana) discovery V0 · browser suite for the Economy page and the Network Map. UI only: /api/pump-economy
// is served by an in-test fake with the production response shape (the backend has its own suites).
//   parsing: 0x unchanged · Solana mint case-preserved · mis-cased mint never substituted · native SOL refused
//   Economy: Solana root → only /api/pump-economy, read-only (no curator/wallet/Builder/Passport), labels, coverage,
//            LOAD MORE FROM PUMP.FUN append + exact-case dedupe, failed page keeps data, disabled / 503 / empty
//   Network: direct mint → SOLANA ASSET center, PUMP.FUN INDEXED children, first 12 / SHOW NEXT 100, server LOAD MORE
//            independent of local reveal, EVM map unchanged afterwards (Builder / Project Page restored)
// No real network. Run: node tests/e2e/pump-discovery-ui.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, installRoutes, setFlags, A, resetChain, resetServer, ROOT } from './harness.mjs';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'));

const require = createRequire(import.meta.url);
const Assets = require(path.join(ROOT, 'lib/syncnet-assets.js'));

const PORT = 8954, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 400)); } else console.log('ok  ', name); }
async function suite(name, fn) { console.log('\n# ' + name); try { await fn(); } catch (e) { failures++; console.log('FAIL (exception)', name, e.stack || e); } }
const lc = (v) => String(v).toLowerCase();

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // fixture only; never hardcoded in the UI
const mint = () => { for (;;) { const m = Assets.base58Encode(crypto.randomBytes(32)); if (Assets.isSolanaMint(m)) return m; } };
const USDG = lc(A.USDG), SYNC = lc(A.SYNC);

/** Fake /api/pump-economy with the production shape. roots: mint → [child mints], newest first. */
function fakePump({ roots = {}, mode = 'ok', stale = false, failCursor = null, dupAcross = false } = {}) {
  const log = [];
  const handler = (route) => {
    const u = new URL(route.request().url());
    const root = u.searchParams.get('root') || '', cursor = u.searchParams.get('cursor'), limit = Math.min(50, Number(u.searchParams.get('limit') || 24));
    log.push({ root, cursor, limit });
    if (mode === 'disabled') return route.fulfill({ status: 404, json: { enabled: false, error: 'Pump discovery is not enabled on this deployment.', code: 'disabled' } });
    if (mode === '503' || (failCursor && cursor === failCursor)) return route.fulfill({ status: 503, json: { error: 'Pump discovery is temporarily unavailable.', code: 'unavailable' } });
    if (!Assets.isSolanaMint(root)) return route.fulfill({ status: 400, json: { error: 'root must be a Solana token mint address (base58, exact case).', code: 'invalid_request' } });
    const all = roots[root] || [];
    const start = cursor ? Number(cursor.split(':')[1]) : 0;
    let slice = all.slice(start, start + limit);
    if (dupAcross && start > 0) slice = [all[start - 1], ...slice.slice(0, limit - 1)]; // server repeats the last item of the previous page
    const nextIdx = start + limit;
    return route.fulfill({ status: 200, json: {
      enabled: true, chain: 'SOLANA_MAINNET', chainId: Assets.SOLANA_MAINNET, source: 'PUMP_FUN', relationship: 'LAUNCHED_AGAINST',
      root: { mint: root, assetId: Assets.formatAssetId({ chain: Assets.SOLANA_MAINNET, address: root }) }, total: all.length,
      items: slice.map((m, i) => ({ mint: m, source: 'PUMP_FUN', launchSlot: 400000000 - start - i, launchSignature: 'sig' + (start + i) })),
      nextCursor: nextIdx < all.length ? 'c1:' + nextIdx + ':Zz' : null,
      indexedThroughSlot: 401000000, indexedAt: new Date().toISOString(), historyComplete: true, historyFromSlot: 350000000, stale,
    } });
  };
  return { handler, log };
}

const srv = await startServer(PORT);
const browser = await chromium.launch();
async function ctx(pump) {
  resetChain(); resetServer(); setFlags({ economyCuration: true, ponsDiscovery: false });
  const c = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await installRoutes(c);
  if (pump) await c.route(/\/api\/pump-economy/, pump.handler);
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e)));
  page.__reqs = []; page.on('request', (r) => page.__reqs.push(r.url()));
  return { c, page };
}
const txt = (page, sel) => page.$eval(sel, (e) => e.textContent).catch(() => '');
const hidden = (page, sel) => page.$eval(sel, (e) => e.hidden || getComputedStyle(e).display === 'none').catch(() => true);
const evmCalls = (page) => page.__reqs.filter((u) => /api\.par\.family|par\.family\/tokenlist|rpc\.mainnet\.chain\.robinhood\.com|\/api\/(par-launches-all|economies|pons-economy|par-tokenlist)/.test(u));
const mapReady = (page) => page.waitForFunction(() => /IN CONTEXT|UNAVAILABLE/.test(document.getElementById('topologyTitle')?.textContent || '') && document.getElementById('topologySection')?.getAttribute('aria-busy') === 'false', null, { timeout: 20000 });
const pumpCards = (page) => page.$$eval('#topologyChildren .topology-node.child', (a) => a.map((x) => ({ m: x.dataset.mint, tag: x.tagName, s: x.textContent })));
const buttons = (page) => page.$$eval('#topologyChildMore button', (b) => b.map((x) => x.textContent.trim()));

// ======================================================================= identity
await suite('Identity: lib/syncnet-assets.js parsing', async () => {
  check('1 bare 0x keeps meaning Robinhood Chain, lowercased', Assets.parseAssetId(A.USDG)?.kind === 'evm' && Assets.parseAssetId(A.USDG).address === USDG);
  check('2 Solana mint accepted exactly as written', Assets.isSolanaMint(MINT) && Assets.formatAssetId({ chain: Assets.SOLANA_MAINNET, address: MINT }).endsWith(':' + MINT));
  check('3 lowercased mint is not the same key', !Assets.isSolanaMint(lc(MINT)) || lc(MINT) !== MINT);
  check('native SOL placeholder is a pubkey, not a mint', Assets.isSolanaPubkey(Assets.NATIVE_SOL) && !Assets.isSolanaMint(Assets.NATIVE_SOL));
});

// ======================================================================= ECONOMY
const K30 = Array.from({ length: 30 }, mint);
await suite('Economy · Solana root: only /api/pump-economy, read-only, labels, pagination', async () => {
  const pump = fakePump({ roots: { [MINT]: K30 }, dupAcross: true });
  const { c, page } = await ctx(pump);
  await page.goto(BASE + '/economy.html?root=' + MINT);
  await page.waitForFunction(() => document.querySelectorAll('#ecoPump article').length > 0, null, { timeout: 15000 });
  check('5 Solana path calls /api/pump-economy with the exact-case mint', pump.log.length === 1 && pump.log[0].root === MINT && pump.log[0].limit === 24, JSON.stringify(pump.log));
  check('5 no PAR / Robinhood RPC / economies / PONS request', evmCalls(page).length === 0, evmCalls(page).join(' | '));
  check('URL keeps the mint exactly', new URL(page.url()).searchParams.get('root') === MINT);
  check('header: SOLANA ECONOMY + short mint + full mint, no invented symbol', (await txt(page, '#ecoTitle')) === 'SOLANA ECONOMY' && (await txt(page, '#ecoRootName')) === 'EPjF…Dt1v' && (await txt(page, '#ecoRootAddr')) === MINT && /SOLANA/.test(await txt(page, '#ecoBadges')) && !/\$/.test(await txt(page, '#ecoTitle')));
  check('6 no curator / wallet / recognition / PAR / PONS sections', (await hidden(page, '#ecoCuratorSection')) && (await hidden(page, '#ecoRecognizedSection')) && (await hidden(page, '#ecoConnectedSection')) && (await hidden(page, '#ecoPonsSection')));
  check('6 no Builder / Project Passport actions; MAP links to the exact mint', (await hidden(page, '#ecoBuild')) && (await hidden(page, '#ecoProject')) && (await page.$eval('#ecoMap', (a) => a.getAttribute('href'))) === '/network.html?token=' + MINT);
  check('6 no RECOGNIZE / CLAIM / SIGN control anywhere', !/RECOGNIZE|CLAIM THE PROJECT PASSPORT|SIGN CURATOR REQUEST|CREATE A PROJECT/.test(await page.evaluate(() => [...document.querySelectorAll('main button, main a')].filter((e) => e.offsetParent).map((e) => e.textContent).join(' '))));
  check('read-only block is shown', !(await hidden(page, '#ecoSolanaSection')) && /Passport, curation and project ownership remain Robinhood Chain features/.test(await txt(page, '#ecoSolanaSection')));
  check('no wallet request was ever made', !(await page.evaluate(() => (window.__walletCalls || []).length)));
  const sec = await txt(page, '#ecoPumpSection');
  check('PUMP.FUN · 30 CONNECTIONS', /PUMP\.FUN/.test(sec) && (await txt(page, '#ecoPumpCountTitle')) === '30 CONNECTIONS.');
  check('cards: short mint, full mint, CONNECTED · PUMP.FUN LAUNCH PAIR, LAUNCHED AGAINST · PUMP.FUN, SOLANA', await page.$eval('#ecoPump article', (a) => /…/.test(a.querySelector('h3').textContent) && a.textContent.includes(a.dataset.child) && /CONNECTED · PUMP\.FUN LAUNCH PAIR/.test(a.textContent) && /LAUNCHED AGAINST · PUMP\.FUN/.test(a.textContent) && /SOLANA/.test(a.textContent)));
  check('cards are not links (no child → root lookup in V0)', (await page.$$('#ecoPump a')).length === 0);
  const cov = await txt(page, '#ecoPumpCoverage');
  check('coverage: non-SOL quote, complete from slot, native SOL excluded, not stale', /Pump\.fun non-SOL quote launches/.test(cov) && /historical V0 coverage is complete from slot 350,000,000/.test(cov) && /Native-SOL Pump\.fun launches are not included in this V0 index/.test(cov) && !/stale/.test(cov), cov);
  check('first page: 24 of 30, LOAD MORE FROM PUMP.FUN visible', (await page.$$('#ecoPump article')).length === 24 && /Loaded 24 of 30/.test(await txt(page, '#ecoPumpCount')) && !(await hidden(page, '#ecoPumpMore')) && (await txt(page, '#ecoPumpMore')) === 'LOAD MORE FROM PUMP.FUN');
  await page.click('#ecoPumpMore');
  await page.waitForFunction(() => document.querySelectorAll('#ecoPump article').length === 30, null, { timeout: 15000 });
  const all = await page.$$eval('#ecoPump article', (x) => x.map((a) => a.dataset.child));
  check('7 append + exact-case dedupe (server repeated one item): 30 unique, in order', new Set(all).size === 30 && all.join() === K30.join());
  check('7 nextCursor passed back verbatim; earlier page never refetched', pump.log.length === 2 && pump.log[1].cursor === 'c1:24:Zz');
  check('7 source exhausted: control hidden, all loaded', (await hidden(page, '#ecoPumpMore')) && /All 30 Pump\.fun launches loaded/.test(await txt(page, '#ecoPumpCount')));
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await suite('Economy · Pump page failure keeps loaded data; stale; empty; disabled; 503', async () => {
  let pump = fakePump({ roots: { [MINT]: K30 }, failCursor: 'c1:24:Zz', stale: true });
  let { c, page } = await ctx(pump);
  await page.goto(BASE + '/economy.html?root=' + MINT);
  await page.waitForFunction(() => document.querySelectorAll('#ecoPump article').length === 24, null, { timeout: 15000 });
  check('stale:true → neutral freshness warning', /Index data may be stale/.test(await txt(page, '#ecoPumpCoverage')));
  await page.click('#ecoPumpMore');
  await page.waitForFunction(() => /temporarily unavailable/.test(document.getElementById('ecoPumpCount').textContent), null, { timeout: 15000 });
  check('failed page: 24 cards kept, neutral note, button re-enabled for retry', (await page.$$('#ecoPump article')).length === 24 && !(await hidden(page, '#ecoPumpMore')) && !(await page.$eval('#ecoPumpMore', (b) => b.disabled)) && (await txt(page, '#ecoPumpMore')) === 'LOAD MORE FROM PUMP.FUN');
  await c.close();

  const empty = mint();
  ({ c, page } = await ctx(fakePump({ roots: {} })));
  await page.goto(BASE + '/economy.html?root=' + empty);
  await page.waitForFunction(() => /No Pump\.fun launch/.test(document.getElementById('ecoPump').textContent), null, { timeout: 15000 });
  check('empty root: 0 CONNECTIONS + neutral empty state, no LOAD MORE', (await txt(page, '#ecoPumpCountTitle')) === '0 CONNECTIONS.' && (await hidden(page, '#ecoPumpMore')));
  await c.close();

  for (const [mode, re] of [['disabled', /not enabled on this deployment/], ['503', /temporarily unavailable/]]) {
    ({ c, page } = await ctx(fakePump({ mode })));
    await page.goto(BASE + '/economy.html?root=' + MINT);
    await page.waitForFunction(() => /inferred/.test(document.getElementById('ecoPump').textContent), null, { timeout: 15000 });
    check('12 ' + mode + ' → neutral state, page still renders, no controls', re.test(await txt(page, '#ecoPump')) && (await txt(page, '#ecoTitle')) === 'SOLANA ECONOMY' && (await hidden(page, '#ecoPumpMore')) && (await hidden(page, '#ecoCuratorSection')));
    check('12 ' + mode + ' → no page errors', page.__errors.length === 0, page.__errors.join(' | '));
    await c.close();
  }
});

await suite('Economy · invalid / native SOL / mis-cased roots', async () => {
  const pump = fakePump({ roots: { [MINT]: K30 } });
  const { c, page } = await ctx(pump);
  await page.goto(BASE + '/economy.html?root=' + Assets.NATIVE_SOL); await page.waitForTimeout(500);
  check('native SOL → picker with explicit note, no fetch', !(await hidden(page, '#ecoPick')) && /Native SOL is not a token mint/.test(await txt(page, '#ecoPickStatus')) && pump.log.length === 0);
  await page.goto(BASE + '/economy.html?root=not-a-mint'); await page.waitForTimeout(400);
  check('invalid base58 → picker with neutral error', !(await hidden(page, '#ecoPick')) && /not a Robinhood Chain contract address or a Solana mint/.test(await txt(page, '#ecoPickStatus')));
  const low = lc(MINT);
  await page.goto(BASE + '/economy.html?root=' + low); await page.waitForTimeout(600);
  check('3 lowercased mint never resolves to the real mint', !pump.log.some((l) => l.root === MINT) && !(await page.evaluate(() => document.body.innerText)).includes('EPjFWdd5'));
  await page.goto(BASE + '/economy.html'); await page.waitForTimeout(400);
  await page.fill('#ecoRootInput', MINT); await page.click('#ecoOpen');
  await page.waitForFunction(() => /SOLANA ECONOMY/.test(document.getElementById('ecoTitle').textContent), null, { timeout: 15000 });
  check('picker accepts a mint and preserves its case in the URL', new URL(page.url()).searchParams.get('root') === MINT);
  await c.close();
});

await suite('Economy · EVM root unchanged (PAR path, curator, Builder)', async () => {
  const pump = fakePump({ roots: {} });
  const { c, page } = await ctx(pump);
  await page.goto(BASE + '/economy.html?root=' + A.USDG);
  await page.waitForFunction(() => !document.getElementById('ecoCard').hidden && !document.getElementById('ecoConnectedSection').hidden, null, { timeout: 20000 });
  check('4 EVM root: PAR children + curator + Builder as before', (await page.$$eval('#ecoConnected article', (x) => x.map((a) => a.dataset.child))).includes(SYNC) && !(await hidden(page, '#ecoCuratorSection')) && !(await hidden(page, '#ecoBuild')) && /CREATE A PROJECT IN THE \$/.test(await txt(page, '#ecoBuild')));
  check('4 EVM root: PAR data requested, Pump never requested, no Solana UI', page.__reqs.some((u) => /\/api\/par-launches-all/.test(u)) && pump.log.length === 0 && (await hidden(page, '#ecoPumpSection')) && (await hidden(page, '#ecoSolanaSection')));
  check('4 EVM root lowercased in the ecoRootAddr as before', (await txt(page, '#ecoRootAddr')) === USDG);
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

// ======================================================================= NETWORK
const K130 = Array.from({ length: 130 }, mint);
await suite('Network · direct Solana mint: center, children, first 12 / SHOW NEXT / LOAD MORE FROM PUMP.FUN', async () => {
  const pump = fakePump({ roots: { [MINT]: K130 } });
  const { c, page } = await ctx(pump);
  await page.goto(BASE + '/network.html'); await mapReady(page);
  const before = pump.log.length;
  await page.fill('#tokenSearch', MINT); await page.click('#mapToken');
  await page.waitForFunction(() => /EPjF…Dt1v/.test(document.getElementById('topologyTitle').textContent), null, { timeout: 15000 });
  await mapReady(page);
  check('9 search box: pasted mint mapped directly, exact case, limit 50', before === 0 && pump.log.length === 1 && pump.log[0].root === MINT && pump.log[0].limit === 50);
  check('9 URL ?token= keeps the mint exactly', new URL(page.url()).searchParams.get('token') === MINT && (await page.$eval('#tokenSearch', (i) => i.value)) === MINT);
  check('9 title TOKEN TOPOLOGY <short mint> IN CONTEXT', /EPjF…Dt1v\s*IN CONTEXT\./.test(await txt(page, '#topologyTitle')));
  const meta = await txt(page, '#topologyMeta');
  check('9 meta: SOLANA · 130 PUMP.FUN CONNECTIONS + native SOL exclusion', /^SOLANA · 130 PUMP\.FUN CONNECTIONS/.test(meta) && /Native-SOL Pump\.fun launches are not included in this V0 index/.test(meta), meta);
  const root = await page.$eval('#topologyGraph .topology-root', (e) => ({ tag: e.tagName, t: e.textContent }));
  check('9 center: short mint + SOLANA ASSET, not a Project Passport / PAR link', root.tag === 'SPAN' && /EPjF…Dt1v/.test(root.t) && /SOLANA ASSET/.test(root.t) && !/PAR|PASSPORT/i.test(root.t));
  check('9 relationship label MARKET · PUMP.FUN LAUNCH PAIR', /MARKET · PUMP\.FUN LAUNCH PAIR/.test(await txt(page, '#topologyGraph')));
  check('9 Builder and Project Page hidden; Economy link keeps the mint', (await hidden(page, '#buildAround')) && (await hidden(page, '#openProjectPage')) && (await page.$eval('#openEconomy', (a) => a.getAttribute('href'))) === '/economy.html?root=' + MINT);
  let cards = await pumpCards(page);
  check('10 first 12 shown, PUMP.FUN INDEXED badge, not links', cards.length === 12 && cards.every((x) => /PUMP\.FUN INDEXED/.test(x.s) && x.tag === 'SPAN') && cards.map((x) => x.m).join() === K130.slice(0, 12).join());
  let b = await buttons(page);
  check('11 local SHOW NEXT and server LOAD MORE FROM PUMP.FUN are separate controls', b.some((x) => /^SHOW ALL 50 LOADED CONNECTIONS$/.test(x)) && b.some((x) => /^LOAD MORE FROM PUMP\.FUN · 50 OF 130 LOADED$/.test(x)), b.join('|'));
  check('9 no EVM lookup on the Solana path (no PAR launch/RPC call for the mint)', !page.__reqs.some((u) => u.includes(MINT) && !/\/api\/pump-economy/.test(u)) && !page.__reqs.some((u) => u.includes(lc(MINT))));
  await page.click('[data-child-more]');
  cards = await pumpCards(page);
  check('11 local reveal shows all loaded cards without a fetch', cards.length === 50 && pump.log.length === 1);
  await page.click('[data-child-server]');
  await page.waitForFunction(() => document.querySelectorAll('#topologyChildren .topology-node.child').length === 100, null, { timeout: 15000 });
  check('11 server LOAD MORE appends next page with verbatim cursor', pump.log.length === 2 && pump.log[1].cursor === 'c1:50:Zz' && new Set((await pumpCards(page)).map((x) => x.m)).size === 100);
  await page.click('[data-child-collapse]');
  check('11 collapse to 12 does not refetch or lose loaded pages', (await pumpCards(page)).length === 12 && pump.log.length === 2 && /LOAD MORE FROM PUMP\.FUN · 100 OF 130/.test((await buttons(page)).join('|')));
  await page.click('[data-child-server]');
  await page.waitForFunction(() => !/PUMP\.FUN/.test(document.getElementById('topologyChildMore').textContent), null, { timeout: 15000 });
  b = await buttons(page);
  check('11 exhausted: server control gone, SHOW NEXT covers the rest', pump.log.length === 3 && b.some((x) => /SHOW NEXT 100|SHOW ALL 130 CONNECTIONS/.test(x)), b.join('|'));
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));

  // 8: switching back to an EVM token restores the EVM map exactly.
  await page.fill('#tokenSearch', A.USDG); await page.click('#mapToken');
  await page.waitForFunction(() => /IN CONTEXT/.test(document.getElementById('topologyTitle').textContent) && !/…/.test(document.getElementById('topologyTitle').textContent), null, { timeout: 20000 });
  const evmCards = await page.$$eval('#topologyChildren .topology-node.child', (a) => a.map((x) => x.getAttribute('href')));
  check('8 EVM map after Solana: PAR children linked, Builder + Project Page restored, no Pump call', evmCards.some((h) => lc(h).includes(SYNC)) && !(await hidden(page, '#buildAround')) && !(await hidden(page, '#openProjectPage')) && pump.log.length === 3 && (await page.$eval('#openEconomy', (a) => a.getAttribute('href'))) === '/economy.html?root=' + USDG);
  await c.close();
});

await suite('Network · URL reload, native SOL, mis-cased mint, disabled / 503 / empty', async () => {
  let pump = fakePump({ roots: { [MINT]: K30 }, stale: true });
  let { c, page } = await ctx(pump);
  await page.goto(BASE + '/network.html?token=' + MINT); await mapReady(page);
  check('reload with ?token=<mint> maps the exact mint', pump.log.length === 1 && pump.log[0].root === MINT && /EPjF…Dt1v/.test(await txt(page, '#topologyTitle')));
  check('stale:true → neutral freshness warning in meta', /Index data may be stale/.test(await txt(page, '#topologyMeta')));
  await page.fill('#tokenSearch', Assets.NATIVE_SOL); await page.click('#mapToken'); await page.waitForTimeout(300);
  check('native SOL refused with explicit note, no fetch', /Native SOL is not a token mint/.test(await txt(page, '#searchStatus')) && pump.log.length === 1);
  const bad = MINT.slice(0, 40) + 'zzzz';
  await page.fill('#tokenSearch', bad); await page.click('#mapToken'); await page.waitForTimeout(300);
  check('invalid mint-shaped base58 → explicit error, no fetch, no substitution', (Assets.isSolanaPubkey(bad) ? pump.log.some((l) => l.root === bad) : /not a valid Solana mint/.test(await txt(page, '#searchStatus'))) && !pump.log.some((l, i) => i > 0 && l.root === MINT));
  const low = lc(MINT);
  await page.fill('#tokenSearch', low); await page.click('#mapToken'); await page.waitForTimeout(600);
  check('3 lowercased mint is never mapped as the real mint', pump.log.filter((l) => l.root === MINT).length === 1);
  await c.close();

  for (const [mode, re] of [['disabled', /not enabled on this deployment/], ['503', /temporarily unavailable/]]) {
    ({ c, page } = await ctx(fakePump({ mode })));
    await page.goto(BASE + '/network.html?token=' + MINT); await mapReady(page);
    check('12 network ' + mode + ' → neutral state, nothing inferred', re.test(await txt(page, '#topologyGraph')) && /inferred/.test(await txt(page, '#topologyGraph')) && /^SOLANA · /.test(await txt(page, '#topologyMeta')));
    check('12 network ' + mode + ' → no page errors', page.__errors.length === 0, page.__errors.join(' | '));
    await c.close();
  }
  ({ c, page } = await ctx(fakePump({ roots: {} })));
  await page.goto(BASE + '/network.html?token=' + mint()); await mapReady(page);
  check('empty root → 0 PUMP.FUN CONNECTIONS + neutral empty row, no controls', /SOLANA · 0 PUMP\.FUN CONNECTIONS/.test(await txt(page, '#topologyMeta')) && /No Pump\.fun launch/.test(await txt(page, '#topologyChildren')) && (await buttons(page)).length === 0);
  await c.close();
});

await suite('Network · EVM search path unchanged', async () => {
  const pump = fakePump({ roots: {} });
  const { c, page } = await ctx(pump);
  await page.goto(BASE + '/network.html?token=' + A.USDG); await mapReady(page);
  check('8 EVM ?token= maps PAR children, no Pump request', (await page.$$eval('#topologyChildren .topology-node.child', (a) => a.map((x) => x.getAttribute('href').toLowerCase()))).some((h) => h.includes(SYNC)) && pump.log.length === 0);
  await page.fill('#tokenSearch', 'SYNC'); await page.click('#mapToken'); await page.waitForTimeout(1500);
  check('8 ticker search still goes through the name/ticker path (no Pump request)', pump.log.length === 0 && /match|mapped/i.test(await txt(page, '#searchStatus')), await txt(page, '#searchStatus'));
  check('copy mentions Solana mint', /Robinhood Chain contract, or Solana mint/.test(await page.evaluate(() => document.querySelector('.page-head p').textContent)));
  check('no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
});

await browser.close(); srv.close();
console.log(`\n${results.length - failures}/${results.length} pump discovery UI checks passed`);
process.exit(failures ? 1 : 0);
