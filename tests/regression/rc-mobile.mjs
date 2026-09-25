// SyncNet V2.5 RC — the real launch flow on phone widths 320 / 360 / 390 / 430 px (touch, mobile UA):
// wallet connect, simulation, signing, the immutable final review, launch, MY LAUNCHES / RECOVER.
// Checks: no horizontal overflow, launch information inside the viewport, tap targets ≥ 40 px, text ≥ 10.5 px.
// Plus every page at 320 px (no overflow, no JS errors).
// Run: node tests/regression/rc-mobile.mjs   (SHOTS=dir to save screenshots)
import { startServer, installRoutes, chain, resetChain, resetServer, FOUNDER_KEY, ROOT, TEST_CID } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));
const PORT = 8937, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const srv = await startServer(PORT);
const browser = await chromium.launch();
const SHOTS = process.env.SHOTS || '';
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const outside = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1); }).map((e) => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right)).slice(0, 5), sel);
const smallTargets = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); if (!r.width || e.closest('[hidden]')) return false; const target = e.closest('label') || e; const tr = target.getBoundingClientRect(); return tr.height < 40; }).map((e) => (e.id || e.className) + ':' + Math.round((e.closest('label') || e).getBoundingClientRect().height)).slice(0, 6), sel);
const tinyText = (page, sel) => page.evaluate((sel) => { const out = []; for (const root of document.querySelectorAll(sel)) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el || el.closest('[hidden]')) continue; const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 10.5) out.push(fs + 'px:' + n.textContent.trim().slice(0, 24)); } } return out.slice(0, 6); }, sel);
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); } };

for (const width of [320, 360, 390, 430]) {
  resetChain(); resetServer();
  const c = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await installRoutes(c);
  const page = await c.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  const W = width + 'px';
  await page.goto(BASE + '/build.html?live=canary');
  check(`${W} build: no horizontal overflow on load`, (await overflow(page)) <= 1, 'overflow=' + (await overflow(page)));
  check(`${W} build: network banner visible and inside the viewport`, await page.locator('#networkBanner').isVisible() && (await outside(page, '#networkBanner')).length === 0);
  await page.click('#tab-4'); await page.fill('#canaryKey', FOUNDER_KEY); await page.click('#unlockCanary'); await page.waitForSelector('#liveCanary:not([hidden])');
  check(`${W} build: MAINNET · REAL FUNDS banner after unlock`, /MAINNET · REAL FUNDS/.test(await page.textContent('#networkBanner')));
  await page.click('#tab-1'); await page.evaluate(() => { document.querySelector('#panel-1 details.technical-details').open = true; }); await page.fill('#logo', 'ipfs://' + TEST_CID);
  await page.fill('#name', 'Mobile Project'); await page.fill('#symbol', 'MOB' + width); await page.fill('#description', 'A project launched from a phone-sized screen, with a long enough description to wrap.');
  await page.check('input[name="websiteChoice"][value="none"]');
  check(`${W} step 1: no overflow with byte counters`, (await overflow(page)) <= 1);
  await page.click('#tab-2'); await page.click('[data-preset="SYNC"]'); await page.waitForFunction(() => /SYNC ready/.test(document.getElementById('assetStatus').textContent));
  await page.click('[data-preset="USDG"]'); await page.waitForFunction(() => /USDG ready/.test(document.getElementById('assetStatus').textContent));
  check(`${W} step 2: no overflow with two connections`, (await overflow(page)) <= 1);
  await page.click('#tab-3'); await page.click('[data-tax="250"]'); await page.check('input[name="feeMode"][value="creator"]');
  await page.fill('#openingBuy', '0.02');
  check(`${W} step 3: no overflow (fees, recipient, opening buy)`, (await overflow(page)) <= 1);
  await page.click('#tab-4');
  await page.click('#connectWallet');
  check(`${W} wallet modal fits`, (await outside(page, '#walletModal .modal-card')).length === 0);
  await page.click('#providerList button');
  await page.click('#runSimulation');
  await page.waitForFunction(() => /SIMULATION PASSED|No transaction was sent/.test(document.getElementById('simStatus').textContent) && !/SIMULATING/.test(document.getElementById('runSimulation').textContent), null, { timeout: 45000 });
  check(`${W} simulation passes`, /SIMULATION PASSED/.test(await page.textContent('#simStatus')), (await page.textContent('#simStatus')).slice(0, 200));
  await page.waitForFunction(() => /PASS|BLOCKED|EXISTS|WARN/.test(document.getElementById('checkDuplicate').textContent), null, { timeout: 20000 });
  check(`${W} simulation status and PAR preflight fit`, (await outside(page, '#simStatus, #parPreflight, #parPreflight .pf')).length === 0 && (await overflow(page)) <= 1);
  await page.click('#signIntent'); await page.waitForFunction(() => /SIGNED ✓/.test(document.getElementById('checkIntentSignature').textContent));
  await page.locator('#finalReview').scrollIntoViewIfNeeded();
  check(`${W} final review visible`, await page.locator('#finalReview').isVisible());
  check(`${W} final review: every value inside the viewport (long hex wraps)`, (await outside(page, '#finalReview dd, #finalReview dt, #finalReview .final-head')).length === 0, JSON.stringify(await outside(page, '#finalReview dd')));
  check(`${W} final review: text ≥ 10.5 px`, (await tinyText(page, '#finalReview, #networkBanner, #guardPanel, #launchBlockers')).length === 0, (await tinyText(page, '#finalReview, #networkBanner')).join(' | '));
  { const dts = await page.$$eval('#finalReview dt', (els) => els.map((e) => e.textContent)); const need = ['Network', 'Wallet (deployer)', 'Predicted token address', 'Markets', 'Creator-fee destination', 'Creator tax', 'PAR base fee', 'Protocol share of the base fee', 'Pool fee (every market)', 'PAR launch fee', 'Opening buy', 'Total value sent from your wallet', 'Intent recordHash', 'Signed intent']; check(`${W} final review: all required rows present`, need.every((k) => dts.includes(k)), need.filter((k) => !dts.includes(k)).join(', ')); }
  await page.locator('#finalAck').check();
  await page.fill('#liveConfirm', 'MOB' + width);
  check(`${W} launch controls are tappable (≥ 40 px)`, (await smallTargets(page, '#signIntent, #launchLive, #runSimulation, #connectWallet, #switchChain, #finalAck, #liveConfirm')).length === 0, (await smallTargets(page, '#signIntent, #launchLive, #runSimulation, #connectWallet, #switchChain, #finalAck, #liveConfirm')).join(', '));
  check(`${W} LAUNCH LIVE enabled only after every step`, await page.locator('#launchLive').isEnabled(), await page.textContent('#launchBlockers'));
  await shot(page, `mobile-${width}-final-review`);
  await page.click('#launchLive');
  await page.waitForFunction(() => /LIVE LAUNCH CONFIRMED|NEEDS ATTENTION/.test(document.getElementById('liveStatus').textContent), null, { timeout: 60000 });
  check(`${W} launch confirmed`, /LIVE LAUNCH CONFIRMED/.test(await page.textContent('#liveStatus')));
  check(`${W} live status, links and export button fit`, (await outside(page, '#liveStatus, #exportLaunchProof, #launchRecords, #launchRecords .record-row > *')).length === 0 && (await overflow(page)) <= 1, JSON.stringify(await outside(page, '#liveStatus, #launchRecords .record-row > *')));
  await shot(page, `mobile-${width}-confirmed`);
  // Recovery page
  await page.goto(BASE + '/launches.html'); await page.waitForTimeout(900);
  check(`${W} MY LAUNCHES: no horizontal overflow`, (await overflow(page)) <= 1, 'overflow=' + (await overflow(page)));
  check(`${W} MY LAUNCHES: the launch is listed and its controls fit`, /MOB/.test(await page.textContent('#recordsPanel')) && (await outside(page, '.record-card, .record-card .btn, .record-row > *')).length === 0);
  check(`${W} MY LAUNCHES: buttons tappable (≥ 40 px)`, (await smallTargets(page, '.record-card .btn, #recoverRun, #exportAll, label[for="importFile"]')).length === 0, (await smallTargets(page, '.record-card .btn, #recoverRun, #exportAll')).join(', '));
  await page.locator('.record-card summary').first().click();
  check(`${W} MY LAUNCHES: evidence details wrap inside the viewport`, (await outside(page, '.record-card dd, .record-history li')).length === 0);
  await page.fill('#recoverInput', chain.sent[0] ? (await page.evaluate(() => JSON.parse(localStorage.getItem('syncnet_launch_records_v1'))[0].txHash)) : '0x');
  await page.click('#recoverRun'); await page.waitForTimeout(1200);
  check(`${W} RECOVER by tx hash finds the launch`, /Found it/.test(await page.textContent('#recoverStatus')), await page.textContent('#recoverStatus'));
  check(`${W} recover result fits`, (await overflow(page)) <= 1);
  await shot(page, `mobile-${width}-my-launches`);
  check(`${W} no JS errors`, errs.length === 0, errs.join(' | '));
  await c.close();
}
// Every page at the narrowest width (320 px): no horizontal overflow, no JS errors.
{
  resetChain(); resetServer();
  const c = await browser.newContext({ viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await installRoutes(c);
  const page = await c.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  for (const p of ['/', '/network.html', '/build.html', '/registry.html', '/launches.html', '/marketplace.html', '/sync.html', '/labs.html', '/kit.html', '/project/0x6368e007b9f0b941560ed1f3bceb20247f5eca37', '/project/0x5fc5360d0400a0fd4f2af552add042d716f1d168', '/terms.html', '/risk.html', '/privacy.html', '/contact.html']) {
    await page.goto(BASE + p); await page.waitForTimeout(700);
    const ov = await overflow(page);
    check(`320px ${p}: no horizontal overflow`, ov <= 1, 'overflow=' + ov);
  }
  check('320px all pages: no JS errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  await c.close();
}

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-mobile.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} mobile checks passed`);
process.exit(failures ? 1 : 0);
