// Marketplace wallet selection with several injected EVM wallets (hotfix regression).
//   Phantom + MetaMask / MetaMask + Rabby / Brave + MetaMask / duplicates / legacy window.ethereum.providers /
//   one provider / no provider / CHANGE WALLET / several already-authorised wallets / no wallet side-effects.
// Extra wallets are injected on top of the harness mock; nothing touches a real network.
// Run: node tests/regression/rc-wallet-select.mjs
import { startServer, installRoutes, A, resetChain, resetServer, ROOT } from '../e2e/harness.mjs';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const PORT = 8943, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const srv = await startServer(PORT);
const browser = await chromium.launch();
resetChain(); resetServer();

const MM = '0x' + '11'.repeat(20), PH = '0x' + '22'.repeat(20), RB = '0x' + '33'.repeat(20), BR = '0x' + '44'.repeat(20);
const shortOf = (a) => a.slice(0, 6) + '…' + a.slice(-4);
const FORBIDDEN = /sendTransaction|personal_sign|signTypedData|eth_sign\b|switchEthereumChain|addEthereumChain|approve|permit/i;

/** Runs in the browser before page scripts: builds fake wallets and exposes them like real extensions do. */
function injectWallets({ wallets, hideMock, legacy, noEthereum }) {
  const mk = (w) => {
    const listeners = {};
    const p = { ...(w.flags || {}), on: (e, f) => ((listeners[e] ||= []).push(f)), removeListener() {},
      async request({ method }) {
        window.__calls = (window.__calls || []).concat(w.tag + ':' + method);
        if (method === 'eth_requestAccounts') return [w.account];
        if (method === 'eth_accounts') return w.authorised ? [w.account] : [];
        if (method === 'eth_chainId') return '0x1237';
        throw Object.assign(new Error('unsupported ' + method), { code: -32601 });
      } };
    return p;
  };
  const built = wallets.map((w) => ({ w, p: mk(w) }));
  window.__wallets = built.map((b) => b.p);
  if (hideMock) window.addEventListener('eip6963:announceProvider', (e) => { if (e.detail?.info?.rdns === 'test.mock') e.stopImmediatePropagation(); });
  if (noEthereum) delete window.ethereum;
  if (legacy) { const base = built[0].p; base.providers = built.map((b) => b.p); window.ethereum = base; return; }
  window.addEventListener('eip6963:requestProvider', () => built.forEach((b) => {
    if (!b.w.info) return;
    const announce = (info, provider) => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } }));
    announce(b.w.info, b.p);
    if (b.w.announceTwice) announce(b.w.info, b.p); // the same provider object announced again (proxied/duplicated announcement)
    if (b.w.dupRdns) announce({ ...b.w.info, uuid: b.w.info.uuid + '-dup' }, mk(b.w)); // another object claiming the same rdns
  }));
}

async function scenario(cfg) {
  const c = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await installRoutes(c);
  if (cfg) await c.addInitScript(injectWallets, cfg);
  const page = await c.newPage();
  page.__errors = []; page.on('pageerror', (e) => page.__errors.push(String(e)));
  await page.goto(BASE + '/marketplace.html'); await page.waitForTimeout(900);
  return { c, page };
}
const chooserOpen = (page) => page.evaluate(() => document.getElementById('mpWalletModal').classList.contains('open'));
const chooserNames = (page) => page.$$eval('#mpProviderList button', (bs) => bs.map((b) => b.textContent.trim()));
const walletName = (page) => page.textContent('#mpWalletName');
const allCalls = (page) => page.evaluate(() => (window.__calls || []).concat((window.__walletCalls || []).map((m) => 'mock:' + m)));
const choose = async (page, name) => { await page.locator('#mpProviderList button', { hasText: name }).first().click(); await page.waitForTimeout(300); };

const MMW = { tag: 'mm', account: MM, flags: { isMetaMask: true }, info: { name: 'MetaMask', rdns: 'io.metamask', uuid: 'mm', icon: '' } };
const PHW = { tag: 'ph', account: PH, flags: { isPhantom: true, isMetaMask: true }, info: { name: 'Phantom', rdns: 'app.phantom', uuid: 'ph', icon: '' } };
const RBW = { tag: 'rb', account: RB, flags: { isRabby: true, isMetaMask: true }, info: { name: 'Rabby Wallet', rdns: 'io.rabby', uuid: 'rb', icon: '' } };
const BRW = { tag: 'br', account: BR, flags: { isBraveWallet: true, isMetaMask: true }, info: { name: 'Brave Wallet', rdns: 'com.brave.wallet', uuid: 'br', icon: '' } };

// ================================================================= 1. Phantom + MetaMask (Phantom announced FIRST)
{
  const { c, page } = await scenario({ wallets: [PHW, MMW], hideMock: true });
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  check('phantom+metamask: chooser appears instead of auto-connecting', await chooserOpen(page));
  const names = await chooserNames(page);
  check('phantom+metamask: both wallets are visible with their own names', names.includes('Phantom') && names.includes('MetaMask'), names.join(','));
  await choose(page, 'MetaMask');
  check('phantom+metamask: choosing MetaMask connects MetaMask (not providers[0] = Phantom)', (await walletName(page)) === shortOf(MM), await walletName(page));
  check('phantom+metamask: chooser closes after the choice', !(await chooserOpen(page)));
  check('phantom+metamask: only MetaMask was asked for accounts', (await allCalls(page)).filter((m) => /requestAccounts/.test(m)).every((m) => m.startsWith('mm:')), (await allCalls(page)).join(','));
  // CHANGE WALLET → chooser again → Phantom
  check('change wallet: the button now reads Change wallet', /Change wallet/.test(await page.textContent('#mpConnect')));
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  check('change wallet: reopens the chooser', await chooserOpen(page));
  await choose(page, 'Phantom');
  check('change wallet: choosing Phantom connects Phantom', (await walletName(page)) === shortOf(PH), await walletName(page));
  const calls = await allCalls(page);
  check('no side-effects: connect + change wallet only used eth_requestAccounts / eth_chainId / eth_accounts', calls.length > 0 && calls.every((m) => /eth_requestAccounts|eth_chainId|eth_accounts/.test(m)) && !calls.some((m) => FORBIDDEN.test(m)), calls.join(','));
  check('no side-effects: no chain switch was requested by the chooser', !calls.some((m) => /switchEthereumChain/.test(m)));
  // Cancel path: Escape closes without changing the wallet
  await page.click('#mpConnect'); await page.waitForTimeout(150); await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  check('chooser: Escape cancels and keeps the current wallet', !(await chooserOpen(page)) && (await walletName(page)) === shortOf(PH));
  check('phantom+metamask: no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
}

// ================================================================= 2. MetaMask + Rabby
{
  const { c, page } = await scenario({ wallets: [MMW, RBW], hideMock: true });
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  const names = await chooserNames(page);
  check('metamask+rabby: chooser shows both', (await chooserOpen(page)) && names.includes('MetaMask') && names.includes('Rabby Wallet'), names.join(','));
  await choose(page, 'Rabby');
  check('metamask+rabby: Rabby can be selected', (await walletName(page)) === shortOf(RB), await walletName(page));
  await page.click('#mpConnect'); await page.waitForTimeout(200); await choose(page, 'MetaMask');
  check('metamask+rabby: MetaMask can be selected afterwards', (await walletName(page)) === shortOf(MM), await walletName(page));
  check('metamask+rabby: no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
}

// ================================================================= 3. Brave + MetaMask (Brave also sets isMetaMask=true)
{
  const { c, page } = await scenario({ wallets: [BRW, MMW], hideMock: true });
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  const names = await chooserNames(page);
  check('brave+metamask (EIP-6963): Brave is labelled Brave Wallet, not MetaMask', names.filter((n) => n === 'MetaMask').length === 1 && names.includes('Brave Wallet'), names.join(','));
  await choose(page, 'Brave'); check('brave+metamask: choosing Brave connects Brave', (await walletName(page)) === shortOf(BR));
  await c.close();
}
{ // legacy flags only (no EIP-6963 info): labels must come from the flags with Brave/Phantom/Rabby before MetaMask
  const { c, page } = await scenario({ wallets: [{ ...BRW, info: null }, { ...MMW, info: null }, { ...PHW, info: null }], hideMock: true, legacy: true });
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  const names = await chooserNames(page);
  check('brave+metamask (legacy flags): Brave Wallet / MetaMask / Phantom labelled from flags, none mislabelled', names.join(',') === 'Brave Wallet,MetaMask,Phantom', names.join(','));
  await c.close();
}

// ================================================================= 4. duplicate / proxied provider
{
  const { c, page } = await scenario({ wallets: [{ ...MMW, announceTwice: true, dupRdns: true }, PHW], hideMock: true });
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  const names = await chooserNames(page);
  check('duplicates: a provider announced twice / a second object with the same rdns is listed once', names.filter((n) => n === 'MetaMask').length === 1 && names.length === 2, names.join(','));
  await c.close();
}

// ================================================================= 5. legacy window.ethereum.providers
{
  const { c, page } = await scenario({ wallets: [{ ...MMW, info: null }, { ...PHW, info: null }], hideMock: true, legacy: true });
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  const names = await chooserNames(page);
  check('legacy providers[]: both wallets are selectable', (await chooserOpen(page)) && names.includes('MetaMask') && names.includes('Phantom'), names.join(','));
  await choose(page, 'Phantom');
  check('legacy providers[]: choosing Phantom connects Phantom (not window.ethereum itself)', (await walletName(page)) === shortOf(PH), await walletName(page));
  await c.close();
}

// ================================================================= 6. exactly one provider (the harness mock)
{
  const { c, page } = await scenario(null);
  await page.click('#mpConnect'); await page.waitForTimeout(300);
  check('one provider: connects directly, no chooser', !(await chooserOpen(page)) && (await walletName(page)) === shortOf(A.WALLET), await walletName(page));
  await page.click('#mpConnect'); await page.waitForTimeout(300);
  check('one provider: CHANGE WALLET reconnects directly to that wallet', !(await chooserOpen(page)) && (await walletName(page)) === shortOf(A.WALLET));
  const calls = await allCalls(page);
  check('one provider: connection is UI-only (no signature, transaction, approval or chain switch)', !calls.some((m) => FORBIDDEN.test(m)), calls.join(','));
  await c.close();
}

// ================================================================= 7. no provider at all
{
  const { c, page } = await scenario({ wallets: [], hideMock: true, noEthereum: true });
  await page.click('#mpConnect'); await page.waitForTimeout(300);
  check('no provider: the existing helpful error is shown', /No EVM wallet was found/.test(await page.textContent('#mpServiceNote')) && !(await chooserOpen(page)), await page.textContent('#mpServiceNote'));
  check('no provider: no page errors', page.__errors.length === 0, page.__errors.join(' | '));
  await c.close();
}

// ================================================================= 9. silent reconnect: several authorised → no arbitrary choice; one authorised → restored
{
  const { c, page } = await scenario({ wallets: [{ ...PHW, authorised: true }, { ...MMW, authorised: true }], hideMock: true });
  await page.waitForTimeout(600);
  check('two authorised wallets: nothing is auto-selected after a page load', (await walletName(page)) === 'Not connected', await walletName(page));
  await page.click('#mpConnect'); await page.waitForTimeout(200);
  check('two authorised wallets: the chooser is required', await chooserOpen(page));
  const calls = await allCalls(page);
  check('two authorised wallets: only eth_accounts was used silently (no prompt, no signature)', calls.every((m) => /eth_accounts|eth_chainId/.test(m)) && !calls.some((m) => /requestAccounts/.test(m) || FORBIDDEN.test(m)), calls.join(','));
  await c.close();
}
{
  const { c, page } = await scenario({ wallets: [PHW, { ...MMW, authorised: true }], hideMock: true });
  await page.waitForTimeout(600);
  check('one authorised wallet among two: it is restored silently (the one that authorised, not providers[0])', (await walletName(page)) === shortOf(MM), await walletName(page));
  const calls = await allCalls(page);
  check('silent restore never prompts', !calls.some((m) => /requestAccounts/.test(m)) && !calls.some((m) => FORBIDDEN.test(m)), calls.join(','));
  await c.close();
}

await browser.close(); srv.close();
fs.writeFileSync(path.join(ROOT, 'tests/regression/rc-wallet-select.results.json'), JSON.stringify({ at: new Date().toISOString(), failures, passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 2));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} wallet-selection checks passed`);
process.exit(failures ? 1 : 0);
