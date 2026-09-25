// SyncNet — IPFS display regression (post-launch hotfix) + the PONSYNC real-CID regression case.
// One canonical renderer (lib/syncnet-ipfs.js): gateway.pinata.cloud → ipfs.io → dweb.link → deterministic
// placeholder, driven by a document-level error listener. The stored metadata always stays ipfs://<CID>.
// Uses the REAL PONSYNC logo CID. Nothing touches a real network. Run: node tests/regression/rc-ipfs-display.mjs
import { startServer, installRoutes, chain, resetChain, resetServer, browserGateways, LAUNCHES, FOUNDER_KEY, ROOT } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const PORT = 8939, BASE = 'http://localhost:' + PORT;
const PONSYNC_CID = 'bafkreig5hyt4po3peiq3cpezer2yuki57l3wnq4qztjphf4lp7tsq6m6si'; // the launched PONSYNC logo
const URI = 'ipfs://' + PONSYNC_CID;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const srv = await startServer(PORT);
const browser = await chromium.launch();
async function newPage() { const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await installRoutes(c); const page = await c.newPage(); page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e))); page.on('dialog', (d) => d.accept()); return { c, page }; }
const txt = (page, id) => page.textContent('#' + id);

// The launched-token state (the same launcher flow that launched PONSYNC, with its real logo CID).
resetChain(); resetServer();
const { c, page } = await newPage();
await page.goto(BASE + '/build.html?live=canary');
await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
await page.click('#tab-1'); await page.evaluate(() => { document.querySelector('#panel-1 details.technical-details').open = true; }); await page.fill('#logo', URI);
await page.fill('#name', 'PONSYNC'); await page.fill('#symbol', 'PONSYNC'); await page.fill('#description', 'The launched PONSYNC regression case.');
await page.check('input[name="websiteChoice"][value="none"]');
await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
await page.click('#tab-3'); await page.click('[data-tax="100"]'); await page.check('input[name="feeMode"][value="creator"]');
await page.click('#tab-4'); await page.click('#connectWallet'); await page.click('#providerList button');
await page.click('#runSimulation');
await page.waitForFunction(() => /SIMULATION PASSED/.test(document.getElementById('simStatus').textContent) && !/SIMULATING/.test(document.getElementById('runSimulation').textContent), null, { timeout: 45000 });
check('launcher regression: simulation + metadata preflight PASS with the real PONSYNC CID', /Metadata preflight: PASS ✓/.test(await txt(page, 'simStatus')), (await txt(page, 'simStatus')).slice(-200));
await page.waitForFunction(() => /PASS|WARN|EXISTS|BLOCKED/.test(document.getElementById('checkDuplicate').textContent), null, { timeout: 20000 });
await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED ✓/.test(document.getElementById('checkIntentSignature').textContent));
await page.check('#finalAck'); await page.fill('#liveConfirm', 'PONSYNC');
check('launcher regression: final review shows the immutable ipfs:// URI (never a gateway URL)', (await txt(page, 'finalReview')).includes(URI) && !/gateway\.pinata|ipfs\.io/.test(await page.$eval('#finalReview', (e) => [...e.querySelectorAll('dd')].map((d) => d.textContent).join(' '))));
await page.click('#launchLive');
await page.waitForFunction(() => /LIVE LAUNCH CONFIRMED/.test(document.getElementById('liveStatus').textContent), null, { timeout: 60000 });
const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_launch_records_v1'))[0]);
const TOKEN = rec.predicted;
check('launcher regression: launch confirmed and verified on-chain', ['ONCHAIN_VERIFIED', 'INDEXER_PENDING', 'FULLY_VERIFIED'].includes(rec.state), rec.state);
check('metadata untouched: the intent record and the sent calldata carry ipfs://<CID> exactly', JSON.parse(rec.intentJson).logo === URI && chain.lastLaunchCall.params.logo === URI);
const seedRecords = await page.evaluate(() => localStorage.getItem('syncnet_launch_records_v1'));
await c.close();

// ---- project page: the four display cases -----------------------------------------------------------------
const HOSTOF = (src) => { try { return new URL(src).hostname; } catch { return src.slice(0, 24); } };
async function projectLogo(modes) {
  Object.assign(browserGateways, modes);
  const { c, page } = await newPage();
  await page.goto(BASE + '/project/' + TOKEN);
  await page.waitForFunction(() => document.querySelector('#tokenCard img[data-ipfs]'), null, { timeout: 20000 });
  await page.waitForFunction(() => { const i = document.querySelector('#tokenCard img[data-ipfs]'); return (i.complete && i.naturalWidth > 0) || i.dataset.ipfsFailed; }, null, { timeout: 20000 });
  const state = await page.$eval('#tokenCard img[data-ipfs]', (i) => ({ src: i.currentSrc || i.src, failed: i.dataset.ipfsFailed || '', ipfs: i.dataset.ipfs, w: i.naturalWidth }));
  const errs = page.__errors.slice();
  const badge = await page.textContent('#tokenCard');
  await c.close();
  return { ...state, errs, badge };
}
{
  let r = await projectLogo({ pinata: 'ok', ipfs: 'ok', dweb: 'ok' });
  check('display 1: Pinata succeeds → logo rendered from gateway.pinata.cloud', HOSTOF(r.src) === 'gateway.pinata.cloud' && r.w > 0 && !r.failed, r.src);
  check('display 1: the DOM keeps the original CID as data (ipfs://) — gateway is src-only', r.ipfs === PONSYNC_CID, r.ipfs);
  check('display 1: PONSYNC stays a verified PAR launch on its page', /PAR LAUNCH · FACTORY RECORD ON-CHAIN/.test(r.badge));
  r = await projectLogo({ pinata: 'down', ipfs: 'ok', dweb: 'ok' });
  check('display 2: Pinata fails → automatic ipfs.io fallback renders', HOSTOF(r.src) === 'ipfs.io' && r.w > 0 && !r.failed, r.src);
  r = await projectLogo({ pinata: 'down', ipfs: 'down', dweb: 'ok' });
  check('display 3: Pinata + ipfs.io fail → automatic dweb.link fallback renders', HOSTOF(r.src) === 'dweb.link' && r.w > 0 && !r.failed, r.src);
  r = await projectLogo({ pinata: 'down', ipfs: 'down', dweb: 'down' });
  check('display 4: all gateways fail → deterministic SVG placeholder, no broken image', r.failed === '1' && r.src.startsWith('data:image/svg+xml') && r.w > 0, r.src.slice(0, 60));
  check('display 4: no page errors while falling back', r.errs.length === 0, r.errs.join(' | '));
  r = await projectLogo({ pinata: 'html', ipfs: 'ok', dweb: 'ok' });
  check('display 5: a gateway answering non-image bytes falls through to the next gateway', (HOSTOF(r.src) === 'ipfs.io' || HOSTOF(r.src) === 'gateway.pinata.cloud') && r.w > 0, r.src);
}

// ---- map card + builder preview ---------------------------------------------------------------------------
{
  Object.assign(browserGateways, { pinata: 'ok', ipfs: 'ok', dweb: 'ok' });
  const row = LAUNCHES[0]; row.logo = URI; // give the first indexed launch the PONSYNC logo for this check
  const { c, page } = await newPage();
  await page.goto(BASE + '/network.html'); await page.waitForTimeout(2500);
  const img = await page.$('#networkGrid img[data-ipfs]');
  check('map: token cards render through the same canonical utility (Pinata first)', Boolean(img) && HOSTOF(await img.evaluate((i) => i.currentSrc || i.src)) === 'gateway.pinata.cloud', img ? await img.evaluate((i) => i.src) : 'no data-ipfs img in #networkGrid');
  delete row.logo;
  await c.close();
}
{
  Object.assign(browserGateways, { pinata: 'down', ipfs: 'down', dweb: 'down' });
  const { c, page } = await newPage();
  await page.goto(BASE + '/build.html');
  await page.evaluate(() => { document.querySelector('#panel-1 details.technical-details').open = true; });
  await page.fill('#logo', URI); await page.evaluate(() => document.getElementById('logo').dispatchEvent(new Event('input', { bubbles: true })));
  await page.waitForFunction(() => /IMAGE UNAVAILABLE/.test(document.getElementById('logoPreview').textContent), null, { timeout: 20000 });
  check('builder preview: every gateway failed → graceful IMAGE UNAVAILABLE (after trying all three)', browserGateways.hits.filter((h) => h === 'gateway.pinata.cloud').length >= 1 && browserGateways.hits.some((h) => h === 'dweb.link'), browserGateways.hits.join(','));
  check('builder preview: the logo field itself still holds the ipfs:// URI', (await page.inputValue('#logo')) === URI);
  Object.assign(browserGateways, { pinata: 'ok', ipfs: 'ok', dweb: 'ok' });
  await page.fill('#logo', ''); await page.fill('#logo', URI); await page.evaluate(() => document.getElementById('logo').dispatchEvent(new Event('input', { bubbles: true })));
  await page.waitForFunction(() => { const i = document.querySelector('#logoPreview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 });
  check('builder preview: renders from Pinata when reachable', HOSTOF(await page.$eval('#logoPreview img', (i) => i.currentSrc || i.src)) === 'gateway.pinata.cloud');
  await c.close();
}

// ---- utility hardening + My Launches intact ---------------------------------------------------------------
{
  const { c, page } = await newPage();
  await page.goto(BASE + '/registry.html'); await page.waitForTimeout(400);
  const u = await page.evaluate(() => { const I = window.SyncNetIpfs; return {
    js: I.display('javascript:alert(1)'), http: I.display('http://x.example/a.png'), data: I.display('data:text/html,<script>1</script>'),
    https: I.display('https://example.com/x.png'), asset: I.display('/assets/syncat.png'), traversal: I.display('ipfs://../../etc/passwd'),
    q: I.display('ipfs://bafkreig5hyt4po3peiq3cpezer2yuki57l3wnq4qztjphf4lp7tsq6m6si?x=1'), sp: I.display('ipfs://abc def'),
    good: I.display('ipfs://bafkreig5hyt4po3peiq3cpezer2yuki57l3wnq4qztjphf4lp7tsq6m6si'),
    p1: I.placeholder('seed-a', 'P'), p2: I.placeholder('seed-a', 'P'), p3: I.placeholder('seed-b', 'P'),
    htmlEsc: I.imgHtml('https://example.com/"onerror="x.png'),
  }; });
  check('hardening: javascript:/http:/data: URIs are never transformed or rendered', u.js === '' && u.http === '' && u.data === '');
  check('hardening: https:// and /assets/ pass through unchanged (no unexpected rewriting)', u.https === 'https://example.com/x.png' && u.asset === '/assets/syncat.png');
  check('hardening: malformed ipfs URIs (traversal, query, spaces) render nothing', u.traversal === '' && u.q === '' && u.sp === '');
  check('hardening: a valid CID resolves to Pinata first', u.good === 'https://gateway.pinata.cloud/ipfs/' + PONSYNC_CID);
  check('hardening: the placeholder is deterministic per seed', u.p1 === u.p2 && u.p1 !== u.p3 && u.p1.startsWith('data:image/svg+xml'));
  check('hardening: attribute injection in image values cannot break out of the src attribute', !/\"onerror/.test(u.htmlEsc.replace(/^[^\"]*\"/, '"')) && !u.htmlEsc.includes('"onerror="'), u.htmlEsc);
  await c.close();
}
{
  const { c, page } = await newPage();
  await page.goto(BASE + '/launches.html');
  await page.evaluate((s) => localStorage.setItem('syncnet_launch_records_v1', s), seedRecords);
  await page.reload(); await page.waitForTimeout(1200);
  const panel = await page.textContent('#recordsPanel');
  check('My Launches: the PONSYNC record still lists and re-verifies (no launch history lost)', /PONSYNC/.test(panel) && /ONCHAIN VERIFIED|FULLY VERIFIED|INDEXER PENDING/.test(panel), panel.slice(0, 200));
  await c.close();
}

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-ipfs-display.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} ipfs-display checks passed`);
process.exit(failures ? 1 : 0);
