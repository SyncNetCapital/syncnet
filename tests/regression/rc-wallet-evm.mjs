// "EVM ACCOUNT REQUIRED" notice: Phantom with a Solana-only account selected, on every page that connects a wallet
// (Marketplace, Economy, Builder). Proves the notice appears ONLY for a confident "no EVM account" signal, that
// TRY AGAIN reconnects after the user switches account, that every other error keeps the existing generic message,
// and that MetaMask / Phantom-EVM / disconnect / chain switching are unchanged. Nothing touches a real network.
// Run: node tests/regression/rc-wallet-evm.mjs
import { startServer, installRoutes, A, resetChain, resetServer, ROOT } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const PORT = 8949, BASE = 'http://localhost:' + PORT;
const SHOTS = process.env.WALLET_SHOTS || '';
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const srv = await startServer(PORT);
const browser = await chromium.launch();
resetChain(); resetServer();
const PH = '0x' + '22'.repeat(20), MM = '0x' + '11'.repeat(20);
const shortOf = (a) => a.slice(0, 6) + '…' + a.slice(-4);

/**
 * Browser-side fake wallets. Phantom's EVM provider answers per window.__phantomMode:
 *   'evm'                 -> [PH]
 *   'unsupported'         -> rejects with Phantom's "Unsupported account … this Solana account doesn't support" text
 *   'unsupported-4001'    -> same text but code 4001
 *   'empty'               -> resolves [] (no EVM address exposed)
 *   'rejected'            -> generic user rejection (code 4001, no account wording)
 *   'unauthorized'        -> bare code 4100 without account wording
 * MetaMask ('mmMode'): 'ok' or 'unsupported' (same wording, but NOT Phantom -> must stay generic).
 */
function inject({ withMetaMask }) {
  const listeners = { ph: {}, mm: {} };
  const mk = (tag, flags, answer) => ({ ...flags, on: (e, f) => ((listeners[tag][e] ||= []).push(f)), removeListener() {},
    async request({ method, params }) {
      window.__calls = (window.__calls || []).concat(tag + ':' + method);
      if (method === 'eth_requestAccounts') return answer();
      if (method === 'eth_accounts') return [];
      if (method === 'eth_chainId') return window.__chain || '0x1237';
      if (method === 'wallet_switchEthereumChain') { window.__chain = params[0].chainId; (listeners[tag].chainChanged || []).forEach((f) => f(params[0].chainId)); return null; }
      throw Object.assign(new Error('unsupported ' + method), { code: -32601 });
    } });
  const TEXT = "Unsupported account. This website is trying to use Ethereum, which this Solana account doesn't support.";
  const ph = mk('ph', { isPhantom: true }, async () => {
    const m = window.__phantomMode || 'evm';
    if (m === 'evm') return [window.__phAccount];
    if (m === 'empty') return [];
    if (m === 'unsupported') throw Object.assign(new Error(TEXT), { code: 4100 });
    if (m === 'unsupported-4001') throw Object.assign(new Error(TEXT), { code: 4001 });
    if (m === 'rejected') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    if (m === 'unauthorized') throw Object.assign(new Error('The requested account and/or method has not been authorized by the user.'), { code: 4100 });
    throw new Error('unknown mode');
  });
  const mm = mk('mm', { isMetaMask: true }, async () => {
    if ((window.__mmMode || 'ok') === 'unsupported') throw Object.assign(new Error(TEXT), { code: 4100 });
    return [window.__mmAccount];
  });
  window.__emitPh = (e, v) => (listeners.ph[e] || []).forEach((f) => f(v));
  window.addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.info?.rdns === 'test.mock') e.stopImmediatePropagation(); });
  window.addEventListener('eip6963:requestProvider', () => {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'Phantom', rdns: 'app.phantom', uuid: 'ph', icon: '' }, provider: ph } }));
    if (withMetaMask) window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'MetaMask', rdns: 'io.metamask', uuid: 'mm', icon: '' }, provider: mm } }));
  });
}

async function open(url, { withMetaMask = true, mode = 'evm', width = 1280 } = {}) {
  const c = await browser.newContext({ viewport: { width, height: 900 } });
  await installRoutes(c);
  await c.addInitScript(inject, { withMetaMask });
  await c.addInitScript(({ mode, PH, MM }) => { window.__phantomMode = mode; window.__phAccount = PH; window.__mmAccount = MM; }, { mode, PH, MM });
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e)));
  await page.goto(BASE + url); await page.waitForTimeout(900);
  return { c, page };
}
const noticeOpen = (page) => page.evaluate(() => Boolean(document.getElementById('evmAccountNotice')?.classList.contains('open')));
const setMode = (page, m) => page.evaluate((m) => { window.__phantomMode = m; }, m);

const PAGES = [
  { name: 'marketplace', url: '/marketplace.html', connect: '#mpConnect', list: '#mpProviderList', chooser: 'mpWalletModal', wallet: '#mpWalletName', note: '#mpServiceNote' },
  { name: 'economy', url: '/economy.html?root=' + A.SYNC.toLowerCase(), connect: '#ecoConnect', list: '#ecoProviderList', chooser: 'ecoWalletModal', wallet: '#ecoWalletName', note: '#ecoNote' },
  { name: 'builder', url: '/build.html', connect: '#connectWallet', list: '#providerList', chooser: 'walletModal', wallet: '#walletName', note: '#toast' },
];
async function pick(page, P, name) {
  await page.evaluate((sel) => { // record every message the page writes (some pages clear their note right after)
    const el = document.querySelector(sel); if (!el || el.__watched) return; el.__watched = true; window.__notes = window.__notes || [];
    new MutationObserver(() => window.__notes.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  }, P.note);
  if (P.name === 'builder' && !(await page.isVisible(P.connect))) await page.click('#tab-4');
  await page.click(P.connect); await page.waitForTimeout(250);
  await page.locator(P.list + ' button', { hasText: name }).first().click(); await page.waitForTimeout(400);
}

for (const P of PAGES) {
  // ---------------------------------------------------------------- Phantom, Solana-only account → notice → switch → TRY AGAIN
  {
    const { c, page } = await open(P.url, { mode: 'unsupported' });
    if (P.name === 'economy') await page.waitForSelector('#ecoConnect:not([hidden])');
    await pick(page, P, 'Phantom');
    check(`${P.name}: Phantom Solana-only account shows EVM ACCOUNT REQUIRED`, await noticeOpen(page));
    const text = await page.textContent('#evmAccountNotice');
    check(`${P.name}: wording — Robinhood Chain, Solana-only account, switch; never "unsupported/broken/invalid" Phantom`, /EVM ACCOUNT REQUIRED/.test(text) && /SyncNet runs on Robinhood Chain/.test(text) && /Phantom account is Solana-only/.test(text) && /Ethereum-compatible account/.test(text) && /Robinhood Chain is EVM-compatible/.test(text) && !/Phantom is (unsupported|broken|not supported)|invalid wallet|Robinhood Chain is Ethereum/i.test(text), text);
    check(`${P.name}: the wallet chooser is closed, so the notice is not underneath it`, !(await page.evaluate((id) => document.getElementById(id).classList.contains('open'), P.chooser)));
    check(`${P.name}: TRY AGAIN has focus`, await page.evaluate(() => document.activeElement?.id === 'evmAccountNoticeRetry'));
    check(`${P.name}: no generic error shown alongside the notice`, !(await page.evaluate(() => window.__notes || [])).some((t) => /did not complete/i.test(t)));
    if (SHOTS && P.name === 'marketplace') { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'evm-notice-desktop.png') }); }
    await setMode(page, 'evm'); // the user switches Phantom to an account with an Ethereum address
    await page.click('#evmAccountNoticeRetry'); await page.waitForTimeout(500);
    check(`${P.name}: TRY AGAIN reconnects the same wallet and the notice disappears`, !(await noticeOpen(page)) && (await page.textContent(P.wallet)).includes(shortOf(PH)), await page.textContent(P.wallet));
    const calls = await page.evaluate(() => window.__calls || []);
    check(`${P.name}: nothing beyond account/chain reads was requested (no signing, no chain switch)`, calls.every((x) => /eth_requestAccounts|eth_chainId|eth_accounts/.test(x)), calls.join(','));
    check(`${P.name}: no page errors`, page.__errors.length === 0, page.__errors.join(' | '));
    await c.close();
  }
  // ---------------------------------------------------------------- DISMISS / Escape restore focus; no reload
  {
    const { c, page } = await open(P.url, { mode: 'unsupported' });
    if (P.name === 'economy') await page.waitForSelector('#ecoConnect:not([hidden])');
    await page.evaluate(() => { window.__marker = 1; });
    await pick(page, P, 'Phantom');
    await page.click('#evmAccountNoticeDismiss'); await page.waitForTimeout(200);
    check(`${P.name}: DISMISS closes the notice and returns focus to Connect wallet`, !(await noticeOpen(page)) && await page.evaluate((sel) => document.activeElement === document.querySelector(sel), P.connect));
    await pick(page, P, 'Phantom');
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    check(`${P.name}: Escape closes the notice`, !(await noticeOpen(page)));
    check(`${P.name}: no page reload happened`, await page.evaluate(() => window.__marker === 1));
    await c.close();
  }
  // ---------------------------------------------------------------- other signals: [] → notice; ambiguous → generic, unchanged
  for (const [mode, expectNotice] of [['empty', true], ['unsupported-4001', true], ['rejected', false], ['unauthorized', false]]) {
    const { c, page } = await open(P.url, { mode });
    if (P.name === 'economy') await page.waitForSelector('#ecoConnect:not([hidden])');
    await pick(page, P, 'Phantom');
    const shown = await noticeOpen(page);
    const generic = (await page.evaluate(() => window.__notes || [])).some((t) => /did not complete/i.test(t));
    check(`${P.name}: Phantom "${mode}" → ${expectNotice ? 'EVM notice' : 'existing generic error, no notice'}`, expectNotice ? shown && !generic : !shown && generic, `notice=${shown} generic=${generic}`);
    check(`${P.name}: Phantom "${mode}" leaves the wallet disconnected`, /Not connected/.test(await page.textContent(P.wallet)));
    await c.close();
  }
  // ---------------------------------------------------------------- MetaMask: normal success; same wording from a non-Phantom wallet stays generic
  {
    const { c, page } = await open(P.url, { mode: 'unsupported' });
    if (P.name === 'economy') await page.waitForSelector('#ecoConnect:not([hidden])');
    await pick(page, P, 'MetaMask');
    check(`${P.name}: MetaMask still connects normally`, (await page.textContent(P.wallet)).includes(shortOf(MM)) && !(await noticeOpen(page)));
    await page.evaluate(() => { window.__mmMode = 'unsupported'; });
    await pick(page, P, 'MetaMask');
    check(`${P.name}: a non-Phantom wallet error never shows the Phantom notice (generic path kept)`, !(await noticeOpen(page)));
    await c.close();
  }
  // ---------------------------------------------------------------- Phantom with an EVM account: unchanged; disconnect still works
  {
    const { c, page } = await open(P.url, { mode: 'evm' });
    if (P.name === 'economy') await page.waitForSelector('#ecoConnect:not([hidden])');
    await pick(page, P, 'Phantom');
    check(`${P.name}: Phantom with an EVM account connects directly (no notice)`, (await page.textContent(P.wallet)).includes(shortOf(PH)) && !(await noticeOpen(page)));
    if (P.name !== 'builder') {
      await page.evaluate(() => window.__emitPh('disconnect'));
      await page.waitForTimeout(200);
      check(`${P.name}: wallet disconnect still resets the page`, /Not connected/.test(await page.textContent(P.wallet)));
    } else {
      await page.evaluate(() => window.__emitPh('disconnect'));
      await page.waitForTimeout(200);
      check(`${P.name}: wallet disconnect still resets the page`, /Not connected/.test(await page.textContent(P.wallet)));
    }
    await c.close();
  }
}

// ---------------------------------------------------------------- Builder: Robinhood Chain switching still works (Phantom EVM account on another chain)
{
  const { c, page } = await open('/build.html', { mode: 'evm' });
  await page.evaluate(() => { window.__chain = '0x1'; });
  await pick(page, PAGES[2], 'Phantom');
  check('builder: wrong network is reported after connecting', /Wrong network/.test(await page.textContent('#walletNetwork')));
  await page.click('#switchChain'); await page.waitForTimeout(400);
  check('builder: SWITCH TO ROBINHOOD CHAIN still switches the wallet (wallet_switchEthereumChain 0x1237)', /Robinhood Chain · MAINNET ✓/.test(await page.textContent('#walletNetwork')) && await page.evaluate(() => window.__chain === '0x1237'));
  await c.close();
}

// ---------------------------------------------------------------- mobile: fits, tappable, above everything
for (const width of [320, 360, 390]) {
  const { c, page } = await open('/marketplace.html', { mode: 'unsupported', width });
  await pick(page, PAGES[0], 'Phantom');
  const m = await page.evaluate(() => {
    const card = document.querySelector('#evmAccountNotice .modal-card').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#evmAccountNotice button')].map((b) => b.getBoundingClientRect());
    const top = document.elementFromPoint(btns[0].left + btns[0].width / 2, btns[0].top + btns[0].height / 2);
    return { left: card.left, right: card.right, top: card.top, bottom: card.bottom, vw: innerWidth, vh: innerHeight, minH: Math.min(...btns.map((b) => b.height)), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, topIsRetry: top && top.id === 'evmAccountNoticeRetry' };
  });
  check(`mobile ${width}px: notice fits the viewport`, m.left >= 0 && m.right <= m.vw && m.top >= 0 && m.bottom <= m.vh, JSON.stringify(m));
  check(`mobile ${width}px: buttons are tappable (≥ 40 px) and nothing covers TRY AGAIN`, m.minH >= 40 && m.topIsRetry, JSON.stringify(m));
  check(`mobile ${width}px: no horizontal overflow`, m.overflow <= 1, 'overflow ' + m.overflow);
  if (SHOTS && width === 390) await page.screenshot({ path: path.join(SHOTS, 'evm-notice-mobile-390.png') });
  await c.close();
}

await browser.close(); srv.close();
const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-wallet-evm.results.json'), JSON.stringify({ passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} wallet EVM-account checks passed`);
process.exit(failures ? 1 : 0);
