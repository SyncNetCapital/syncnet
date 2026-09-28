// Network Map · child connections ("projects using this token as a market") — reveal / collapse.
// The first 12 render immediately; the rest are revealed from the already-discovered set, without a refetch.
// Run: node tests/e2e/network-children.mjs
import { startServer, installRoutes, A, resetChain, resetServer } from './harness.mjs';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'));

const BASE = 'http://localhost:8931';
const ROOT_TOKEN = A.SYNC.toLowerCase();
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail }); if (!cond) { failures++; console.log('FAIL', name, detail); } else console.log('ok  ', name); }
async function suite(name, fn) { console.log('\n# ' + name); try { await fn(); } catch (e) { failures++; console.log('FAIL (exception)', name, e.stack || e); } }

const childAddr = (i) => '0x' + (0xc0000000 + i).toString(16).padStart(8, '0') + 'c'.repeat(32);
// n distinct children of ROOT_TOKEN, plus duplicate rows (same token again, mixed case) that must not add cards.
function launchesWith(n, { dupes = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ token: childAddr(i), name: 'Child ' + i, symbol: 'CH' + i, markets: [{ index: 0, pairToken: ROOT_TOKEN }] });
  for (let i = 0; i < dupes; i++) rows.push({ token: childAddr(i % n).toUpperCase().replace('0X', '0x'), name: 'Child dup ' + i, symbol: 'CH' + (i % n), markets: [{ index: 0, pairToken: ROOT_TOKEN }] });
  return rows;
}

const srv = await startServer();
const browser = await chromium.launch();
async function mapWith(n, opts) {
  resetChain(); resetServer();
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installRoutes(c);
  const launches = launchesWith(n, opts);
  let historyFetches = 0;
  await c.route(/localhost:8931\/api\/par-launches-all/, (r) => { historyFetches++; return r.fulfill({ json: { count: launches.length, indexed: launches.length, launches } }); });
  const page = await c.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(BASE + '/network.html?token=' + ROOT_TOKEN);
  await page.waitForFunction(() => /IN CONTEXT/.test(document.getElementById('topologyTitle')?.textContent || ''), null, { timeout: 20000 });
  return { c, page, errs, fetches: () => historyFetches };
}
const cards = (page) => page.$$eval('#topologyChildren .topology-node.child', (a) => a.map((x) => x.getAttribute('href').split('token=')[1].toLowerCase()));
const meta = (page) => page.$eval('#topologyMeta', (e) => e.textContent);
const buttons = (page) => page.$$eval('#topologyChildMore button', (b) => b.map((x) => x.textContent.trim()));
const noDupes = (list) => new Set(list).size === list.length;

await suite('<= 12 children: no expand control', async () => {
  for (const n of [5, 12]) {
    const { c, page, errs } = await mapWith(n, { dupes: 3 });
    const list = await cards(page);
    check(`${n} children: all ${n} cards shown, no duplicates`, list.length === n && noDupes(list), String(list.length));
    check(`${n} children: no expand/collapse control`, (await buttons(page)).length === 0, (await buttons(page)).join('|'));
    const m = await meta(page);
    check(`${n} children: count copy says ${n} with no "showing" qualifier`, new RegExp(`\\b${n} projects use it as a market\\.`).test(m) && !/showing|shown/.test(m), m);
    check(`${n} children: no page errors`, errs.length === 0, errs.join(' | '));
    await c.close();
  }
});

await suite('13 children: the control appears at the first overflow', async () => {
  const { c, page } = await mapWith(13);
  check('13: initial 12 cards', (await cards(page)).length === 12);
  check('13: control reads SHOW ALL 13 CONNECTIONS', (await buttons(page)).join('|') === 'SHOW ALL 13 CONNECTIONS', (await buttons(page)).join('|'));
  await c.close();
});

await suite('27 children: initial 12, expand to all 27, collapse to 12', async () => {
  const { c, page, errs, fetches } = await mapWith(27, { dupes: 9 });
  const first = await cards(page);
  check('27: initial render shows exactly 12 cards', first.length === 12, String(first.length));
  check('27: initial 12 are the first 12 discovered, in order', first.join() === Array.from({ length: 12 }, (_, i) => childAddr(i)).join());
  let m = await meta(page);
  check('27: count copy says 27 total and (showing 12 of 27)', /\b27 projects use it as a market \(showing 12 of 27\)\./.test(m), m);
  check('27: control directly below the child row reads SHOW ALL 27 CONNECTIONS', (await buttons(page)).join('|') === 'SHOW ALL 27 CONNECTIONS', (await buttons(page)).join('|'));
  check('27: control sits immediately after the child row', await page.evaluate(() => document.getElementById('topologyChildren').nextElementSibling?.id === 'topologyChildMore'));
  const before = fetches();

  await page.click('[data-child-more]');
  const all = await cards(page);
  check('27: expand reveals all 27 cards', all.length === 27, String(all.length));
  check('27: expanded set has no duplicates and is exactly the discovered set', noDupes(all) && all.join() === Array.from({ length: 27 }, (_, i) => childAddr(i)).join());
  m = await meta(page);
  check('27: count copy now says all 27 are shown (no "showing 12")', /\b27 projects use it as a market \(all 27 shown\)\./.test(m) && !/showing 12/.test(m), m);
  check('27: control becomes SHOW FIRST 12', (await buttons(page)).join('|') === 'SHOW FIRST 12', (await buttons(page)).join('|'));
  check('27: focus stays on the control after expanding', await page.evaluate(() => document.activeElement?.matches('#topologyChildMore button')));
  check('27: expanding did not refetch the launch history', fetches() === before, `${before} -> ${fetches()}`);

  await page.click('[data-child-collapse]');
  const back = await cards(page);
  check('27: collapse returns to the first 12', back.length === 12 && back.join() === first.join(), String(back.length));
  m = await meta(page);
  check('27: count copy returns to (showing 12 of 27)', /\(showing 12 of 27\)\./.test(m), m);
  check('27: control returns to SHOW ALL 27 CONNECTIONS', (await buttons(page)).join('|') === 'SHOW ALL 27 CONNECTIONS');

  await page.click('[data-child-more]');
  check('27: re-expanding again shows 27, still no duplicates', (await cards(page)).length === 27 && noDupes(await cards(page)));
  check('27: no refetch across the whole expand/collapse cycle', fetches() === before);
  check('27: no page errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

await suite('250 children: progressive batches, every connection reachable, never silently truncated', async () => {
  const { c, page, errs, fetches } = await mapWith(250, { dupes: 20 });
  const before = fetches();
  check('250: initial 12 cards', (await cards(page)).length === 12);
  check('250: count copy says 250 total (showing 12 of 250)', /\b250 projects use it as a market \(showing 12 of 250\)\./.test(await meta(page)), await meta(page));
  check('250: first step offers the next batch and states progress', (await buttons(page)).join('|') === 'SHOW NEXT 100 · 12 OF 250 SHOWN', (await buttons(page)).join('|'));
  await page.click('[data-child-more]');
  check('250: batch 1 → 112 shown', (await cards(page)).length === 112 && /\(showing 112 of 250\)/.test(await meta(page)), await meta(page));
  check('250: mid-way both next-batch and collapse are offered', (await buttons(page)).join('|') === 'SHOW NEXT 100 · 112 OF 250 SHOWN|SHOW FIRST 12', (await buttons(page)).join('|'));
  await page.click('[data-child-more]');
  check('250: batch 2 → 212 shown; last step names the full total', (await cards(page)).length === 212 && (await buttons(page))[0] === 'SHOW ALL 250 CONNECTIONS', (await buttons(page)).join('|'));
  await page.click('[data-child-more]');
  const all = await cards(page);
  check('250: all 250 reachable, no duplicates, exactly the discovered set', all.length === 250 && noDupes(all) && all.join() === Array.from({ length: 250 }, (_, i) => childAddr(i)).join(), String(all.length));
  check('250: copy says (all 250 shown); only collapse remains', /\(all 250 shown\)\./.test(await meta(page)) && (await buttons(page)).join('|') === 'SHOW FIRST 12');
  await page.click('[data-child-collapse]');
  check('250: collapse returns to 12', (await cards(page)).length === 12 && /\(showing 12 of 250\)/.test(await meta(page)));
  check('250: no refetch', fetches() === before);
  check('250: no page errors', errs.length === 0, errs.join(' | '));
  await c.close();
});

await browser.close(); srv.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} network children checks passed`);
process.exit(failures ? 1 : 0);
