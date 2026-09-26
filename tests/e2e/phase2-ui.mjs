// Phase 2 product UI / information architecture — end-to-end in a real browser against the offline harness
// (real Netlify functions in-process, mock chain, mock wallet, mock Upstash with the CAS script emulated).
// Run: node tests/e2e/phase2-ui.mjs      (SHOTS=dir to keep screenshots)
import { startServer, installRoutes, A, chain, resetChain, resetServer, setFlags, serverState } from './harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const BASE = 'http://localhost:8931';
const SHOTS = process.env.SHOTS || '';
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail }); if (!cond) { failures++; console.log('FAIL', name, detail); } else console.log('ok  ', name); }
async function suite(name, fn) { console.log('\n# ' + name); try { await fn(); } catch (e) { failures++; console.log('FAIL (exception)', name, e.stack || e); } }
const lc = (v) => String(v).toLowerCase();
const T = lc(A.CREATORLIVE); // PAR launch; deployer = fee recipient = A.WALLET
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' http://127.0.0.1:8545 http://localhost:8545 https://api.par.family https://par.family https://rpc.mainnet.chain.robinhood.com https://ipfs.io https://dweb.link; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const toml = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../netlify.toml'), 'utf8');

const srv = await startServer();
const browser = await chromium.launch();
async function ctx({ width = 1440, height = 900, account = null, reducedMotion, csp = false } = {}) {
  const mobile = width < 760;
  const c = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion });
  await installRoutes(c);
  if (account) await c.addInitScript((a) => { window.__mockAccount = a; }, account);
  if (csp) {
    // Production header emulation: serve every page with the exact CSP from netlify.toml.
    await c.route(/localhost:8931\/(?!api\/|site\/|site-img\/).*/, async (route) => {
      const r = await route.fetch();
      const ct = r.headers()['content-type'] || '';
      return route.fulfill({ response: r, headers: { ...r.headers(), ...(ct.includes('text/html') ? { 'content-security-policy': CSP } : {}) } });
    });
  }
  return c;
}
function errorsOf(page) { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return errs; }
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const store = {
  get: (k) => { const e = serverState.upstash.get(k); return e && !e.set ? JSON.parse(e.v) : null; },
  put: (k, v) => { serverState.upstash.set(k, { v: JSON.stringify(v), exp: 0 }); },
};
async function connect(page) { await page.click('[data-wallet]'); await page.waitForFunction(() => document.querySelector('[data-wallet]').dataset.connected === 'true', null, { timeout: 8000 }); }
async function openProject(page, token = T) { await page.goto(BASE + '/project/' + token); await page.waitForFunction(() => document.querySelector('#projectRows [data-row]') || /not eligible|unavailable/i.test(document.body.innerText), null, { timeout: 20000 }); await page.waitForTimeout(600); }
async function syncProject(page) { await openProject(page); if (!(await page.$('[data-wallet][data-connected="true"]'))) await connect(page); await page.waitForSelector('#syncProject', { timeout: 8000 }); await page.click('#syncProject'); await page.waitForFunction(() => /Synced\./.test(document.getElementById('pjStatus').textContent), null, { timeout: 15000 }); }
function pngOf(w, h) {
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)])));
  const chunk = (t, d) => { const b = Buffer.alloc(4); b.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([b, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function fresh(flags = { projectHome: true }) { resetChain(); resetServer(); setFlags(flags); }

// ================================================================= Explore
await suite('Explore · first viewport, search, filters, For sale', async () => {
  fresh();
  const c = await ctx(); const page = await c.newPage(); const errs = errorsOf(page);
  await page.goto(BASE + '/'); await page.waitForSelector('#exploreList .sn-row', { timeout: 20000 });
  const fold = await page.evaluate(() => ({ h1: document.getElementById('exploreTitle').getBoundingClientRect().bottom, search: document.getElementById('exploreSearch').getBoundingClientRect(), filters: document.querySelector('.sn-filters').getBoundingClientRect().bottom, row: document.querySelector('#exploreList .sn-row').getBoundingClientRect().bottom, vh: innerHeight }));
  check('Explore: headline, search, filters and the first row fit the first desktop viewport', fold.row < fold.vh && fold.filters < fold.vh, JSON.stringify(fold));
  check('Explore: search control is 48–54px tall', fold.search.height >= 48 && fold.search.height <= 54, String(fold.search.height));
  check('Explore: search button opens (arrow), never says SYNC', (await page.getAttribute('#exploreSearch button', 'aria-label')) === 'Open project' && !/SYNC/.test(await text(page, '#exploreSearch')));
  check('Explore: "+ Create a new project" links to Create', (await page.getAttribute('a[href="/build.html"].sn-textbtn', 'href')) === '/build.html');
  check('Explore: filters are All / Synced / For sale / New as text buttons with aria-pressed', (await page.$$eval('[data-filter]', (b) => b.map((x) => x.textContent + ':' + x.getAttribute('aria-pressed')).join('|'))) === 'All:true|Synced:false|For sale:false|New:false');
  check('Explore: columns PROJECT | SYNC STATE | MARKET | CONNECTIONS', /Project\s*Sync state\s*Market\s*Connections/i.test(await text(page, '.sn-list-head')));
  check('Explore: sync state is a shape glyph + words (not colour alone)', (await page.$$eval('#exploreList .sn-d-col .sn-state', (s) => s.every((x) => x.querySelector('svg[data-glyph]') && /Unclaimed|Synced/.test(x.textContent)))));
  check('Explore: no normal name is letter-spaced', (await page.$$eval('.sn-proj-name', (n) => n.every((x) => ['normal', '0px'].includes(getComputedStyle(x).letterSpacing)))));
  check('Explore: no box-shadow or text-shadow anywhere', await page.evaluate(() => [...document.querySelectorAll('body *')].every((e) => { const s = getComputedStyle(e); return s.boxShadow === 'none' && s.textShadow === 'none'; })));
  // Only $SYNC itself may show the SyncNet mark (it is that token's own logo); fallbacks are the project's initial.
  check('Explore: fallback logos are the project initial, never the SyncNet mark', await page.$$eval('#exploreList .sn-row', (rows, sync) => rows.every((r) => r.getAttribute('href') === '/project/' + sync || !r.querySelector('.sn-logo img[src*="syncnet-logo"]')), lc(A.SYNC)) && await page.$$eval('#exploreList .sn-logo:not(:has(img))', (l) => l.every((x) => /^[A-Z0-9·]$/.test(x.textContent.trim()))));
  const fake = (await page.locator(`#exploreList a[href="/project/${lc(A.FAKESYNC)}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ');
  const real = (await page.locator(`#exploreList a[href="/project/${lc(A.SYNC)}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('Explore: a same-ticker impostor says "Not the canonical $SYNC"; the canonical row does not', /Not the canonical \$SYNC/.test(fake) && real && !/Not the canonical/.test(real), fake + ' || ' + real);
  // search by name / ticker
  await page.fill('#exploreQ', 'OPLIVE'); await page.waitForTimeout(500);
  const rows = await page.$$eval('#exploreList .sn-row', (r) => r.map((x) => x.getAttribute('href')));
  check('Explore: search by ticker narrows the rows', rows.length === 1 && rows[0] === '/project/' + T, rows.join(','));
  await page.press('#exploreQ', 'Enter'); await page.waitForURL(/\/project\//, { timeout: 8000 });
  check('Explore: Enter with a single match opens its Project Page', page.url().endsWith('/project/' + T));
  await page.goto(BASE + '/'); await page.waitForSelector('#exploreList .sn-row');
  await page.fill('#exploreQ', '0x' + A.SYNCAT.slice(2).toUpperCase()); await page.click('#exploreSearch button'); await page.waitForURL(/\/project\//);
  check('Explore: a contract address opens directly (lower-cased)', page.url().endsWith('/project/' + lc(A.SYNCAT)));
  // keyboard: filters are operable, focus is visible
  await page.goto(BASE + '/'); await page.waitForSelector('#exploreList .sn-row');
  await page.focus('[data-filter="new"]'); await page.keyboard.press('Enter'); await page.waitForTimeout(200);
  check('Explore keyboard: Enter on a filter selects it', (await page.getAttribute('[data-filter="new"]', 'aria-pressed')) === 'true' && page.url().endsWith('/?view=new'));
  await page.keyboard.press('Tab');
  check('Explore keyboard: focus ring is a visible outline', await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; }));
  // For sale entry point
  await page.goto(BASE + '/for-sale'); await page.waitForTimeout(1500);
  check('/for-sale: Explore with the For sale filter selected', (await page.getAttribute('[data-filter="sale"]', 'aria-pressed')) === 'true');
  check('/for-sale: honest empty state when nothing is listed', /Nothing is listed for sale right now/.test(await text(page, '#exploreList')));
  check('Explore: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

await suite('Explore · Synced AND For sale are independent dimensions', async () => {
  fresh();
  const c = await ctx(); const page = await c.newPage();
  // Serve one active listing + one Passport for the same project (read views only; rendering under test).
  await page.route('**/api/marketplace?view=listings', (r) => r.fulfill({ json: { enabled: true, listings: [{ id: '0x' + 'ab'.repeat(32), token: T, status: 'ACTIVE', price: '1.5', currency: 'ETH', snapshot: { name: 'Operator Live', symbol: 'OPLIVE' } }] } }));
  await page.route('**/api/marketplace?view=passports*', (r) => r.fulfill({ json: { enabled: true, passports: { [T]: { operator: lc(A.WALLET), operatorSince: '2026-09-01T00:00:00Z', launchpad: 'PAR', listing: '0x' + 'ab'.repeat(32) } } } }));
  await page.goto(BASE + '/'); await page.waitForSelector('#exploreList .sn-row');
  const row = page.locator(`#exploreList a[href="/project/${T}"]`);
  const rowText = (await row.innerText()).replace(/\s+/g, ' ');
  check('row shows Synced (sync state) and For sale (market) together', /Synced/.test(rowText) && /For sale/.test(rowText), rowText);
  check('synced glyph is one line; for-sale is copper text, not a state', (await row.locator('.sn-d-col svg[data-glyph]').getAttribute('data-glyph')) === 'synced' && (await row.locator('.sn-copper').count()) >= 1);
  await page.click('[data-filter="synced"]'); await page.waitForTimeout(200);
  check('Synced filter keeps it', (await page.locator(`#exploreList a[href="/project/${T}"]`).count()) === 1);
  await page.click('[data-filter="sale"]'); await page.waitForTimeout(200);
  check('For sale filter keeps it and switches the URL to /for-sale', (await page.locator(`#exploreList a[href="/project/${T}"]`).count()) === 1 && page.url().endsWith('/for-sale'));
  await c.close();
});

// ================================================================= global navigation
await suite('Global navigation · desktop + mobile 3-item bar', async () => {
  fresh();
  const d = await ctx(); const p = await d.newPage();
  await p.goto(BASE + '/network.html'); await p.waitForTimeout(600);
  check('desktop: Explore · Create, wallet Connect; My Projects hidden until connected', (await text(p, '.sn-nav')).replace(/\s+/g, ' ').trim() === 'Explore Create' && (await text(p, '[data-wallet]')) === 'Connect');
  check('desktop: persistent search in the top bar', await p.locator('.sn-top-search input').isVisible());
  check('desktop: Network counts as Explore (current page marker)', (await p.getAttribute('.sn-nav [data-nav="explore"]', 'aria-current')) === 'page');
  await connect(p);
  check('desktop: connected → My Projects appears and wallet shows a short address', /My Projects/.test(await text(p, '.sn-nav')) && /^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test((await text(p, '[data-wallet]')).trim()));
  await d.close();
  const m = await ctx({ width: 375, height: 760 }); const q = await m.newPage();
  for (const pth of ['/', '/project/' + T, '/you.html', '/build.html', '/marketplace.html']) {
    await q.goto(BASE + pth); await q.waitForTimeout(500);
    const tabs = (await q.locator('.sn-tabbar a:visible').allInnerTexts()).map((t) => t.trim());
    check(`mobile ${pth}: exactly Explore · Create · You, no hamburger, top nav hidden`, tabs.join('|') === 'Explore|Create|You' && (await q.locator('.nav-toggle').count()) === 0 && !(await q.locator('.sn-nav').isVisible()), tabs.join('|'));
    const ov = await q.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(`mobile ${pth}: no horizontal overflow`, ov <= 1, 'overflow ' + ov);
  }
  await q.goto(BASE + '/'); await q.waitForSelector('#exploreList .sn-row');
  check('mobile Explore: its own stacked hierarchy (desktop columns hidden, state + fact lines shown)', !(await q.locator('.sn-list-head').isVisible()) && (await q.locator('#exploreList .sn-row .sn-m-only').first().isVisible()));
  await m.close();
});

// ================================================================= Project Page
await suite('Project Page · visitor, eligible wallet, SYNC PROJECT, operator', async () => {
  fresh();
  const v = await ctx(); const vp = await v.newPage(); const errs = errorsOf(vp);
  await openProject(vp);
  check('header: ← Explore, name, $TICKER · origin · sync state, contract + Copy', (await vp.getAttribute('.sn-back', 'href')) === '/' && /Operator Live/.test(await text(vp, '#tokenTitle')) && /\$OPLIVE\s*·\s*PAR launch\s*·\s*Unclaimed/.test(await text(vp, '#pjSub')) && (await vp.getAttribute('#pjCopy', 'data-copy-text')) === T);
  check('visitor: CONTROL Unclaimed with a Connect action, no SYNC PROJECT button', /Unclaimed/.test(await text(vp, '[data-row="control"]')) && (await vp.locator('#syncProject').count()) === 0 && (await vp.locator('[data-row="control"] [data-connect]').count()) === 1);
  check('visitor: no HOME row and no MARKET row (nothing meaningful to show)', (await vp.locator('[data-row="home"]').count()) === 0 && (await vp.locator('[data-row="market"]').count()) === 0);
  check('visitor: CONNECTIONS row links to Network', (await vp.getAttribute('[data-row="connections"] .pj-row-a a', 'href')) === '/network.html?token=' + T);
  check('rows are 4–6 max and in order', await vp.$$eval('#projectRows [data-row]', (r) => r.length <= 6 && r.map((x) => x.dataset.row).join(',') === r.map((x) => x.dataset.row).sort((a, b) => ['home', 'control', 'market', 'connections', 'economy'].indexOf(a) - ['home', 'control', 'market', 'connections', 'economy'].indexOf(b)).join(',')));
  check('DETAILS is collapsed and still holds the on-chain evidence', !(await vp.getAttribute('#projectDetails', 'open') !== null) && /PAR LAUNCH · FACTORY RECORD ON-CHAIN/.test(await vp.textContent('#tokenCard')));
  await vp.goto(BASE + '/project/' + T + '#details'); await vp.waitForSelector('#passportPanel .passport-row', { timeout: 20000 });
  check('#details opens DETAILS (Passport panel visible)', await vp.locator('#passportPanel').isVisible());
  // unverified contract: never offered SYNC
  await vp.goto(BASE + '/project/' + A.RANDOM_CONTRACT); await vp.waitForSelector('[data-row="control"]', { timeout: 20000 });
  check('unverified contract: CONTROL explains it cannot be synced; no action', /PAR and Pons V2 launches only/.test(await text(vp, '[data-row="control"]')) && (await vp.locator('#syncProject').count()) === 0);
  await v.close();
  // a connected wallet that is not the deployer / fee recipient
  const o = await ctx({ account: A.WALLET2 }); const op = await o.newPage();
  await openProject(op); await connect(op); await op.waitForTimeout(300);
  check('non-eligible wallet: no SYNC PROJECT, says who can', (await op.locator('#syncProject').count()) === 0 && /Only the deployer or the creator-fee recipient/.test(await text(op, '[data-row="control"]')));
  await o.close();
  // the deployer: SYNC PROJECT (reject once, then sign)
  const e = await ctx(); const ep = await e.newPage();
  await openProject(ep); await connect(ep); await ep.waitForSelector('#syncProject');
  check('eligible wallet: SYNC PROJECT with the exact helper text', (await text(ep, '#syncProject')) === 'SYNC PROJECT' && /Verify that you control this project\. Nothing moves on-chain\./.test(await text(ep, '[data-row="control"]')));
  await ep.evaluate(() => { window.__mockSignReject = true; });
  await ep.click('#syncProject'); await ep.waitForTimeout(800);
  check('rejected signature: nothing saved, still Unclaimed', /You rejected the signature\. Nothing was saved\./.test(await text(ep, '#pjStatus')) && !store.get('mp:passport:v1:' + T));
  await ep.evaluate(() => { window.__mockSignReject = false; window.__txBefore = (window.__sentTxs || []).length; });
  await ep.click('#syncProject'); await ep.waitForFunction(() => /Synced\./.test(document.getElementById('pjStatus').textContent), null, { timeout: 15000 });
  const typed = JSON.parse(await ep.evaluate(() => window.__typed));
  check('SYNC PROJECT is the Marketplace OperatorClaim (EIP-712, SyncNet Marketplace domain), no transaction', typed.primaryType === 'OperatorClaim' && typed.domain.name === 'SyncNet Marketplace' && (await ep.evaluate(() => (window.__sentTxs || []).length)) === 0);
  check('server recorded the Passport for the deployer', lc((store.get('mp:passport:v1:' + T) || {}).operator) === lc(A.WALLET));
  check('after sync: header and CONTROL show Synced with the one-line glyph', /Synced/.test(await text(ep, '#pjSub')) && (await ep.getAttribute('[data-row="control"] svg[data-glyph]', 'data-glyph')) === 'synced');
  check('operator actions appear: Transfer →, List →, Create home →', (await ep.getAttribute('[data-row="control"] .pj-row-a a', 'href')) === '/marketplace.html#sell=' + T && /List/.test(await text(ep, '[data-row="market"]')) && /Create home/.test(await text(ep, '[data-row="home"]')));
  await ep.click('[data-row="market"] .pj-row-a a'); await ep.waitForURL(/marketplace\.html#sell=/); await ep.waitForTimeout(800);
  check('Marketplace #sell=0x… prefills the project (checking stays explicit)', lc(await ep.inputValue('#mpToken')) === T);
  check('Project Page: no JS errors', errs.length === 0, errs.join(' | '));
  await e.close();
});

await suite('Project Page · reduced motion: the Synced transition is immediate', async () => {
  fresh();
  const c = await ctx({ reducedMotion: 'reduce' }); const p = await c.newPage();
  await openProject(p); await connect(p); await p.waitForSelector('#syncProject');
  await p.click('#syncProject'); await p.waitForFunction(() => /Synced\./.test(document.getElementById('pjStatus').textContent), null, { timeout: 10000 });
  check('reduced motion: synced without the converging animation delay', (await p.getAttribute('[data-row="control"] svg[data-glyph]', 'data-glyph')) === 'synced');
  await c.close();
});

// ================================================================= My Projects
await suite('You / My Projects · auto-discovery, one status + one action per row', async () => {
  fresh();
  const c = await ctx(); const p = await c.newPage();
  await p.goto(BASE + '/you.html'); await p.waitForTimeout(1200);
  check('not connected: Connect prompt, no list', await p.locator('#youConnect').isVisible() && await p.locator('#youListWrap').isHidden());
  await p.click('#youConnect'); await p.waitForSelector('#youList .you-row', { timeout: 15000 });
  const before = await p.$$eval('#youList .you-row', (r) => r.map((x) => [x.dataset.token, x.querySelector('.you-status-text').textContent, x.querySelectorAll('.you-action a').length]));
  check('discovers launches this wallet can sync (deployer / fee recipient)', before.some(([t, s]) => t === T && /Unclaimed · you can sync it/.test(s)), JSON.stringify(before));
  check('every row: one status, one action', before.every(([, s, n]) => s && n === 1));
  await syncProject(p);
  await p.goto(BASE + '/you.html'); await p.waitForSelector(`#youList .you-row[data-token="${T}"]`, { timeout: 15000 });
  check('synced project: Synced · Create home →', /Synced/.test(await text(p, `.you-row[data-token="${T}"] .you-status`)) && /Create home/.test(await text(p, `.you-row[data-token="${T}"] .you-action`)));
  check('links: + Find another project, + Create new', (await p.getAttribute('.you-links a:nth-child(1)', 'href')) === '/?find=1' && (await p.getAttribute('.you-links a:nth-child(2)', 'href')) === '/build.html');
  await c.close();
});

// ================================================================= Project Home: flags
await suite('Project Home · flags closed (production default) and payments closed', async () => {
  fresh({});
  const c = await ctx(); const p = await c.newPage();
  await syncProject(p);
  await openProject(p);
  check('flags closed: no HOME row on the Project Page', (await p.locator('[data-row="home"]').count()) === 0);
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForTimeout(2500);
  check('flags closed: editor says Project Home is not open', /Project Home is not open yet/.test(await text(p, '#heGate')));
  setFlags({ projectHome: true, projectHomePayments: false });
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heBar:not([hidden])', { timeout: 20000 });
  check('payments closed: preview works, activation button disabled with an honest note', (await p.isDisabled('#hePrimary')) && /Activation is not open yet/.test(await text(p, '#heBarNote')) && /PREVIEW · NOT PUBLISHED/.test(await p.$eval('#hePreview', (f) => f.srcdoc)));
  await c.close();
});

// ================================================================= editor + preview + images
await suite('Project Home editor · V1 schema, validation, preview under the production CSP, images', async () => {
  fresh({ projectHome: true, publicUploads: true });
  const c = await ctx({ csp: true }); const p = await c.newPage(); const errs = errorsOf(p);
  await p.addInitScript(() => { window.__cspViolations = []; document.addEventListener('securitypolicyviolation', (e) => window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI)); });
  await syncProject(p);
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heGrid:not([hidden])', { timeout: 20000 });
  check('control groups: STYLE / CONTENT / LINKS / SECTIONS', (await p.$$eval('#heForm legend', (l) => l.map((x) => x.textContent).join('|'))) === 'Style|Content|Links|Sections');
  check('no HTML / CSS / Markdown / embed / AI inputs', (await p.$$eval('#heForm textarea', (t) => t.length)) === 1 && !/html|css|markdown|embed|\bAI\b/i.test(await text(p, '#heForm')));
  await p.check('input[name="preset"][value="TERMINAL"]'); await p.selectOption('#heAccent', 'GREEN');
  await p.fill('#heHeadline', 'Hello from the operator'); await p.fill('#heAbout', 'Line one.\n\nLine two.');
  await p.selectOption('#heCtaLabel', 'TRADE'); await p.fill('#heCtaUrl', 'https://par.family/token/' + T); await p.fill('#heX', '@oplive');
  await p.uncheck('[data-section="socials"]'); await p.waitForTimeout(300);
  const doc = await p.$eval('#hePreview', (f) => f.srcdoc);
  check('preview: the pure renderer in preview mode (watermark, noindex)', doc.includes('<div class="watermark">PREVIEW · NOT PUBLISHED</div>') && doc.includes('noindex'));
  check('preview: operator text, preset and accent applied', doc.includes('Hello from the operator') && doc.includes('preset-terminal accent-green'));
  check('preview: no clickable link, no script, socials hidden by the Sections switch', !/<a /.test(doc) && !/<script/i.test(doc) && !/@?oplive/.test(doc.split('Socials')[1] || ''));
  check('preview iframe: sandbox without script permission', (await p.getAttribute('#hePreview', 'sandbox')) === 'allow-same-origin');
  check('preview: no public URL (srcdoc, about:srcdoc)', (await p.getAttribute('#hePreview', 'src')) === null && p.frames().some((f) => f.url() === 'about:srcdoc'));
  check('draft saved in this browser only', /Hello from the operator/.test(await p.evaluate((t) => localStorage.getItem('syncnet_home_draft_' + t), T)));
  // validation
  await p.fill('#heCtaUrl', 'http://insecure.example'); await p.waitForTimeout(200);
  check('validation: http:// link refused inline', /Button link must start with https:\/\//.test(await text(p, '#heErrors')));
  await p.fill('#heCtaUrl', 'https://par.family/token/' + T); await p.fill('#heHeadline', 'Official website of the project'); await p.waitForTimeout(200);
  check('validation: reserved authority claims refused', /claim SyncNet never grants/.test(await text(p, '#heErrors')));
  await p.fill('#heHeadline', 'Hello from the operator'); await p.waitForTimeout(200);
  // image through the sanitizer
  const png = path.join(SHOTS || '/tmp', 'phase2-logo.png'); fs.writeFileSync(png, pngOf(48, 48));
  await p.setInputFiles('#heLogoFile', png); await p.waitForFunction(() => /Sanitised/.test(document.getElementById('heLogoName').textContent), null, { timeout: 15000 });
  const cid = await p.evaluate(() => (document.getElementById('hePreview').srcdoc.match(/\/site-img\/([A-Za-z0-9]+)/) || [])[1]);
  check('upload: personal_sign upload session, then the sanitizer returns a CID recorded for Project Home', Boolean(cid) && Boolean(serverState.upstash.get('site:img:v1:' + cid)) && Boolean(await p.evaluate(() => window.__personal)));
  await p.waitForTimeout(500);
  check('preview shows the sanitised image from /site-img under the production CSP', await p.frameLocator('#hePreview').locator('img').first().evaluate((i) => i.complete && i.naturalWidth > 0));
  check('no CSP violations while editing and previewing', (await p.evaluate(() => window.__cspViolations.length)) === 0, await p.evaluate(() => window.__cspViolations.join(', ')));
  check('the editor page is served with the unchanged netlify.toml CSP', toml.includes(CSP));
  check('editor: no JS errors', errs.length === 0, errs.join(' | '));
  await shot(p, 'p2-editor');
  await c.close();
});

await suite('Project Home editor · uploads closed', async () => {
  fresh();
  const c = await ctx(); const p = await c.newPage();
  await syncProject(p);
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heGrid:not([hidden])', { timeout: 20000 }); await p.waitForTimeout(800);
  check('uploads closed: file inputs disabled with an honest note', (await p.isDisabled('#heLogoFile')) && /not open on this deployment/.test(await text(p, '#heImgNote')));
  await c.close();
});

// ================================================================= payment, finality, recovery, HOME states
await suite('Project Home · quote, expiry guard, payment seen, recovery, activation, publish, HOME states', async () => {
  fresh();
  const c = await ctx(); const p = await c.newPage(); const errs = errorsOf(p);
  await syncProject(p);
  await openProject(p);
  check('HOME: No home yet → Create home →', /No home yet/.test(await text(p, '[data-row="home"]')));
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heGrid:not([hidden])', { timeout: 20000 });
  await p.fill('#heHeadline', 'Paid home'); await p.waitForTimeout(200);
  await openProject(p);
  check('HOME: Draft (saved in this browser)', /Draft/.test(await text(p, '[data-row="home"]')) && /Saved in this browser/.test(await text(p, '[data-row="home"]')));
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heBar:not([hidden])', { timeout: 20000 });
  check('progressive: payment details stay hidden until Continue', await p.locator('#hePay').isHidden() && (await text(p, '#hePrimary')) === 'Continue to activation');
  await p.click('#hePrimary');
  check('activation copy: $39 ONE-TIME · Pay with $SYNC · 60% burned · 40% converted to USDG', /\$39/.test(await text(p, '.he-price')) && /Pay with \$SYNC · 60% burned · 40% converted to USDG for SyncNet treasury/.test(await text(p, '#hePay')));
  await p.click('#heQuoteBtn'); await p.waitForSelector('#hePayBtn', { timeout: 15000 });
  const q = await text(p, '#heQuote');
  check('QUOTE READY: exact amount, sink, SYNCNET REFERENCE RATE locked 30 minutes, countdown', /\$SYNC/.test(q) && /SYNCNET REFERENCE RATE · Your rate is locked for 30 minutes/.test(q) && /2\d:\d\d|30:00/.test(await text(p, '#heLeft')));
  check('expiry warning shown next to the pay button', /Send only the exact quoted amount before the quote expires\. Late or duplicate payments cannot be automatically refunded\./.test(q));
  check('never says oracle; never a per-activation revenue figure', !/oracle|15\.60/i.test(await text(p, 'main')));
  const typed = JSON.parse(await p.evaluate(() => window.__typed));
  check('quote request is a SyncNet Website ActivationRequest signature', typed.primaryType === 'ActivationRequest' && typed.domain.name === 'SyncNet Website');
  await openProject(p);
  check('HOME: Needs payment while a quote is open', /Needs payment/.test(await text(p, '[data-row="home"]')));
  // expiry guard: jump the browser clock to 29.5 minutes later
  await p.goto(BASE + '/home-editor.html?token=' + T + '&step=pay'); await p.waitForSelector('#hePayBtn', { timeout: 20000 });
  await p.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 29.5 * 60 * 1000; }); await p.waitForTimeout(1300);
  check('near expiry: payment blocked, get a new quote', (await p.isDisabled('#hePayBtn')) && /about to expire/.test(await text(p, '#hePayStatus')));
  await p.reload(); await p.waitForSelector('#hePayBtn', { timeout: 20000 });
  // pay, with the chain not yet SAFE
  chain.safeLag = 50;
  await p.click('#hePayBtn');
  await p.waitForFunction(() => /Payment seen/.test(document.getElementById('hePayStatus').textContent), null, { timeout: 20000 });
  const sent = await p.evaluate(() => window.__sentTxs);
  check('one transaction: $SYNC transfer(sink, exact amount), no value', sent.length === 1 && lc(sent[0].to) === lc(A.SYNC) && sent[0].data.startsWith('0xa9059cbb') && sent[0].value === '0x0' && sent[0].chainId === '0x1237');
  check('PAYMENT SEEN (confirming) and "you can leave"', /You can leave this page/.test(await text(p, '#hePayStatus')) && (await p.getAttribute('#hePaySteps li[data-p="seen"]', 'aria-current')) === 'step');
  await openProject(p);
  check('HOME: Publishing while the payment confirms', /Publishing/.test(await text(p, '[data-row="home"]')));
  // leave and return: recovery from this browser's record and the server's request state
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForFunction(() => /Payment seen|confirm/i.test(document.getElementById('hePayStatus').textContent), null, { timeout: 20000 });
  check('recovery: returning resumes verification without a new quote or transfer', (await p.evaluate(() => (window.__sentTxs || []).length)) === 0 && (await p.locator('#hePayBtn').count()) === 0);
  chain.safeLag = 0; chain.finalLag = 100;
  await p.waitForFunction(() => /Activated/.test(document.getElementById('hePayStatus').textContent), null, { timeout: 30000 });
  check('ACTIVATED (finality later)', /Finality is confirmed later/.test(await text(p, '#hePayStatus')) && store.get('site:entitlement:v1:' + T).status === 'ACTIVE');
  check('HOME: Draft · Activated, not published', await (async () => { const q2 = await (await c.newPage()); await openProject(q2); const t = await text(q2, '[data-row="home"]'); await q2.close(); return /Activated · not published/.test(t); })());
  chain.finalLag = 0;
  await p.waitForFunction(() => /Finalized/.test(document.getElementById('hePayStatus').textContent), null, { timeout: 20000 });
  check('FINALIZED later, via UI-triggered reconcile while the page is open', store.get('site:entitlement:v1:' + T).status === 'FINALIZED');
  await p.click('#hePrimary'); await p.waitForFunction(() => /Published/.test(document.getElementById('heStatus').textContent), null, { timeout: 15000 });
  check('publish: fresh SitePublish signature', JSON.parse(await p.evaluate(() => window.__typed)).primaryType === 'SitePublish');
  check('publish: no changes → button disabled', (await p.isDisabled('#hePrimary')) && /No changes to publish/.test(await text(p, '#heBarNote')));
  await openProject(p);
  check('HOME: Live · Edit →', /Live/.test(await text(p, '[data-row="home"]')) && /Edit/.test(await text(p, '[data-row="home"] .pj-row-a')));
  const site = await (await p.request.get(BASE + '/site/' + T)).text();
  check('public Project Home: operator-verified label and the published content', /PASSPORT OPERATOR VERIFIED/.test(site) && /Paid home/.test(site) && !/PREVIEW/.test(site));
  // unpublish
  p.once('dialog', (d) => d.accept());
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heUnpublish:not([hidden])', { timeout: 20000 });
  await p.click('#heUnpublish'); await p.waitForFunction(() => /Unpublished/.test(document.getElementById('heStatus').textContent), null, { timeout: 15000 });
  await openProject(p);
  check('HOME: Unpublished · Edit →', /Unpublished/.test(await text(p, '[data-row="home"]')));
  // suspended (reorg invalidation recorded by the server)
  const ent = store.get('site:entitlement:v1:' + T); store.put('site:entitlement:v1:' + T, { ...ent, status: 'INVALIDATED_BY_REORG' });
  await openProject(p);
  check('HOME: Suspended when the activation payment left the canonical chain', /Suspended/.test(await text(p, '[data-row="home"]')));
  store.put('site:entitlement:v1:' + T, ent);
  check('payment flow: no JS errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

// ================================================================= transfer → review & adopt; old operator restricted
await suite('Project Home · previous operator home: links disabled, REVIEW & ADOPT, old operator restricted', async () => {
  fresh();
  const c = await ctx(); const p = await c.newPage();
  await syncProject(p);
  // activate + publish through the UI
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForSelector('#heBar:not([hidden])', { timeout: 20000 });
  await p.fill('#heHeadline', 'First operator'); await p.selectOption('#heCtaLabel', 'TRADE'); await p.fill('#heCtaUrl', 'https://par.family/token/' + T);
  await p.click('#hePrimary'); await p.click('#heQuoteBtn'); await p.waitForSelector('#hePayBtn', { timeout: 15000 }); await p.click('#hePayBtn');
  await p.waitForFunction(() => /Activated/.test(document.getElementById('hePayStatus').textContent), null, { timeout: 30000 });
  await p.click('#hePrimary'); await p.waitForFunction(() => /Published/.test(document.getElementById('heStatus').textContent), null, { timeout: 15000 });
  // the Passport moves to WALLET2 (as the Marketplace two-party transfer would record it)
  const pk = 'mp:passport:v1:' + T; const pass = store.get(pk); store.put(pk, { ...pass, operator: lc(A.WALLET2) });
  const before = await (await p.request.get(BASE + '/site/' + T)).text();
  check('public home after transfer: AWAITING CONFIRMATION, links disabled', /AWAITING CONFIRMATION/.test(before) && !/<a class="ext"/.test(before) && /link disabled/.test(before));
  await openProject(p);
  check('visitor HOME: Awaiting confirmation', /Awaiting confirmation/.test(await text(p, '[data-row="home"]')));
  await p.goto(BASE + '/home-editor.html?token=' + T); await p.waitForTimeout(3000);
  check('old operator: editor refuses (only the current Passport operator)', /Only the current Passport operator/.test(await text(p, '#heGate')));
  await c.close();
  const n = await ctx({ account: A.WALLET2 }); const q = await n.newPage();
  await openProject(q); await connect(q); await q.waitForTimeout(500);
  check('new operator HOME: Previous operator’s home · REVIEW & ADOPT', /Previous operator/.test(await text(q, '[data-row="home"]')) && (await text(q, '[data-row="home"] .pj-row-a')).trim() === 'REVIEW & ADOPT');
  await q.click('[data-row="home"] .pj-row-a a'); await q.waitForSelector('#heReview:not([hidden])', { timeout: 20000 });
  check('REVIEW & ADOPT: preview of the published version + one ADOPT HOME action, no payment UI', /First operator/.test(await q.$eval('#hePreview', (f) => f.srcdoc)) && (await q.locator('#heReview .sn-btn.primary').count()) === 1 && await q.locator('#hePay').isHidden());
  const txBefore = chain.sent.length;
  await q.click('#heAdopt'); await q.waitForFunction(() => /Adopted/.test(document.getElementById('heStatus').textContent), null, { timeout: 15000 });
  check('adopt: fresh SitePublish by the new operator, no transaction', JSON.parse(await q.evaluate(() => window.__typed)).primaryType === 'SitePublish' && chain.sent.length === txBefore);
  const after = await (await q.request.get(BASE + '/site/' + T)).text();
  check('after adopt: operator-verified again, links enabled', /PASSPORT OPERATOR VERIFIED/.test(after) && /<a class="ext"/.test(after));
  await n.close();
});

await browser.close(); srv.close();
console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} phase 2 UI checks passed`);
process.exit(failures ? 1 : 0);
