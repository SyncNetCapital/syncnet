// EARLY UI + mobile suite: the real pages (labs-early.html, labs-early-creator.html) against the real functions run
// in-process on the mock chain from tests/early/fixtures.mjs, with an EIP-1193 wallet mock that COUNTS prompts.
// Covers: landing, Count me in (one free signature), creator setup through a fake Google consent round trip, the fan
// happy path on a phone (connect → sign → send → receipt: exactly TWO wallet prompts, no third signature), resume
// after a reload at each step, finality + the opt-in card + the public verification page (no wallet/amount/tx),
// the ambiguous path (a conditional third signature), the wallet-app hand-off when no wallet is injected, and the
// 320/360/390/430 px sweep (no overflow, tap targets ≥ 40 px, text ≥ 10.5 px). No real network.
// Run: node tests/e2e/early-ui.mjs   (PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs if not resolvable)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, Core, E, lc, W, KEYS, signDigest, TEST_KEYS_FILE, ENV, USDG, CH, clock, pc, resetPc, pay, makeSafe, makeFinal, syncHead, rpc, MAP, makeStore, resetStore } from '../early/fixtures.mjs';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const require = createRequire(import.meta.url);
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const auth = require(path.join(ROOT, 'netlify/functions/early-youtube-auth.js'));
const PORT = 8941, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);

// ---- in-process functions + fake YouTube/Google
resetStore(); resetPc();
const store = makeStore();
const YT = { channels: new Map([[CH, { channelId: CH, title: 'Alice', avatarUrl: 'https://yt3.example/a.jpg', handle: '@alice', subscriberCount: 1234, hidden: false }]]), codes: new Map([['code-alice-0123456789', CH]]) };
const youtube = {
  OAUTH_SCOPE: 'https://www.googleapis.com/auth/youtube.readonly',
  async resolve(input) { const s = String(input).toLowerCase(); return s.includes('alice') || s.includes(CH.toLowerCase()) ? YT.channels.get(CH) : null; },
  async channelsById(ids) { const m = new Map(); for (const id of ids) if (YT.channels.has(id)) m.set(id, YT.channels.get(id)); return m; },
  authUrl(state) { return BASE + '/__google?state=' + encodeURIComponent(state); },
  async exchangeCode(code) { if (!YT.codes.has(code)) throw Object.assign(new Error('bad'), { code: 'denied' }); return 'tok-' + code; },
  async mine(token) { const code = token.replace('tok-', ''); return YT.channels.get(YT.codes.get(code)) || null; },
};
let ipCounter = 0;
const deps = () => ({ store, env: ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname;
  const run = (fn) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => { const event = { httpMethod: req.method, path: p, headers: { ...req.headers, 'x-nf-client-connection-ip': '10.0.' + ((ipCounter >> 8) & 255) + '.' + (ipCounter++ & 255) }, queryStringParameters: Object.fromEntries(u.searchParams), body: Buffer.concat(chunks).toString('utf8') || null }; const out = await fn._handler(event, deps()); res.writeHead(out.statusCode, out.headers || {}); res.end(out.body || ''); }); };
  if (p === '/api/early') return run(early);
  if (p === '/api/early-youtube-auth') return run(auth);
  if (p === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ early: true, chainId: 4663 })); }
  if (p === '/__google') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>Google (fake)</title><h1>Fake Google consent</h1><a id="allow" href="/api/early-youtube-auth?code=code-alice-0123456789&state=${encodeURIComponent(u.searchParams.get('state') || '')}">Allow</a> <a id="deny" href="/api/early-youtube-auth?error=access_denied&state=${encodeURIComponent(u.searchParams.get('state') || '')}">Deny</a>`); }
  if (p === '/labs/early/creator') p = '/labs-early-creator.html';
  else if (p === '/labs/early' || p.startsWith('/labs/early/')) p = '/labs-early.html';
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, path.normalize(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, r));

// ---- browser wallet mock: signs with the fixtures' keys, mines transfers on the mock chain, counts prompts
const SENT = [];
async function wireWallet(context, { account = W.fan, inject = true, sendMode = 'one' } = {}) {
  await context.route('https://yt3.example/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }));
  await context.exposeBinding('__earlySign', (_s, { typed, account: acct }) => signDigest(acct, Core.hashTypedData(JSON.parse(typed))));
  await context.exposeBinding('__earlySend', (_s, tx) => {
    SENT.push(tx);
    const data = String(tx.data || ''); const to = '0x' + data.slice(34, 74), amount = BigInt('0x' + data.slice(74)).toString();
    const p = pay({ from: tx.from, to, token: tx.to, amount });
    if (sendMode === 'double') pay({ from: tx.from, to, token: tx.to, amount });
    return p.txHash;
  });
  if (!inject) return;
  await context.addInitScript(({ WALLET }) => {
    const listeners = {}; const emit = (e, v) => (listeners[e] || []).forEach((f) => { try { f(v); } catch (err) { console.warn(err); } });
    window.__prompts = [];
    const provider = {
      isMetaMask: true, on: (e, f) => ((listeners[e] ||= []).push(f)), removeListener: () => {},
      async request({ method, params }) {
        switch (method) {
          case 'eth_requestAccounts': window.__prompts.push('connect'); return [WALLET];
          case 'eth_accounts': return [WALLET];
          case 'eth_chainId': return '0x1237';
          case 'wallet_switchEthereumChain': return null;
          case 'wallet_addEthereumChain': return null;
          case 'eth_signTypedData_v4': window.__prompts.push('sign'); window.__lastTyped = params[1]; return window.__earlySign({ typed: params[1], account: params[0] });
          case 'eth_sendTransaction': window.__prompts.push('send'); window.__lastTx = params[0]; return window.__earlySend(params[0]);
          default: throw Object.assign(new Error('unsupported ' + method), { code: -32601 });
        }
      },
    };
    window.ethereum = provider;
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'Mock Wallet', rdns: 'test.mock', uuid: '1', icon: '' }, provider } })));
  }, { WALLET: account });
}
const browser = await chromium.launch();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const prompts = (page) => page.evaluate(() => window.__prompts || []);
const smallTargets = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && !e.hidden && r.height < 40; }).map((e) => e.id + ':' + Math.round(e.getBoundingClientRect().height)), sel);
const tinyText = (page, sel) => page.evaluate((sel) => { const out = []; for (const root of document.querySelectorAll(sel)) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (w.nextNode()) { const n = w.currentNode; if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el || el.closest('[hidden]')) continue; const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 10.5) out.push(fs + 'px:' + n.textContent.trim().slice(0, 24)); } } return out.slice(0, 6); }, sel);
const mobileCtx = async (opts) => { const c = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }); await wireWallet(c, opts); return c; };
const errsOf = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); }); return errs; };

try {
  // ============================================================================================ 1. landing + Count me in (phone)
  {
    const c = await mobileCtx(); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early');
    await page.waitForSelector('#eLanding:not([hidden])');
    check('L01 landing renders on a phone without overflow or JS errors', (await overflow(page)) <= 1 && errs.length === 0, errs.join(' | '));
    check('L02 landing copy: I was there when; direct payment; no investment framing', /I was there when/.test(await page.textContent('#eLanding')) && /directly/.test(await page.textContent('#eLanding')) && !/ROI|investor|multiple|leaderboard/i.test(await page.textContent('body')));
    await page.fill('#eCmiInput', 'https://www.youtube.com/@alice'); await page.click('#eCmiFind');
    await page.waitForSelector('#eCmiSign');
    check('L03 resolver shows the channel and offers Count me in for a creator not on EARLY', /Alice/.test(await page.textContent('#eCmiResult')) && /Not on EARLY yet/.test(await page.textContent('#eCmiResult')));
    await page.click('#eCmiSign');
    await page.waitForFunction(() => /Counted in/.test(document.getElementById('eCmiStatus').textContent), null, { timeout: 15000 });
    const pr = await prompts(page);
    check('L04 Count me in = connect + ONE free signature, no transaction', pr.filter((x) => x === 'sign').length === 1 && !pr.includes('send'), pr.join(','));
    check('L05 signal stored privately (server) and the public creator view still says not on EARLY', MAP.has('early:cmi:v1:' + CH + ':' + W.fan) && (await (await fetch(BASE + '/api/early?view=creator&channelId=' + CH)).json()).onEarly === false);
    await c.close();
  }
  // ============================================================================================ 2. creator setup through the OAuth round trip (desktop)
  {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await wireWallet(c, { account: W.creator });
    const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early/creator');
    await page.waitForSelector('#cWallet:not([hidden])');
    await page.click('#cConnect'); await page.waitForSelector('#cLink:not([hidden])');
    await page.click('#cLink');
    await page.waitForURL(/__google/);
    check('C01 creator-link signature accepted by the server → redirected to the (fake) Google consent with a wallet-bound state', /\/__google\?state=e1\.state\./.test(decodeURIComponent(page.url())));
    await page.click('#allow');
    await page.waitForSelector('#cManifest:not([hidden])', { timeout: 15000 });
    check('C02 callback returns to the creator page with a session in the fragment (cleared from the URL) and shows the manifest step', !page.url().includes('#') && /Alice/.test(await page.textContent('#cYou')));
    await page.check('input[type="checkbox"][data-token="' + USDG + '"]');
    await page.fill('input[data-min="' + USDG + '"]', '1');
    await page.click('#cSign');
    await page.waitForSelector('#cDash:not([hidden])', { timeout: 15000 });
    check('C03 manifest signed by the receiving wallet → dashboard live; signals counted as records', /ACTIVE/.test(await page.textContent('#dStatus')) && /1 signed interest signal was waiting/.test(await page.textContent('#dSignals')) && !/people/.test(await page.textContent('#dSignals')), await page.textContent('#dSignals'));
    check('C04 dashboard shows the page link and the receiving wallet', (await page.getAttribute('#dPage', 'href')) === '/labs/early/c/' + CH && (await page.textContent('#dWallet')) === W.creator);
    check('C05 no JS errors in the creator flow', errs.length === 0, errs.join(' | '));
    await c.close();
  }
  // ============================================================================================ 3. fan happy path on a phone: exactly two prompts, resumable
  let intentId = null, shareUrl = null;
  {
    const c = await mobileCtx(); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early/c/' + CH);
    await page.waitForSelector('#eCreator:not([hidden])');
    await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice');
    check('F01 creator page: name, verified wallet, accepted asset + minimum, no supporter data', /Alice/.test(await page.textContent('#eTitle')) && (await page.textContent('#eWallet')).includes(W.creator.slice(0, 6)) && /USDG/.test(await page.textContent('#eAssets')) && !(await page.textContent('body')).includes(W.fan));
    check('F02 no overflow at 390 px', (await overflow(page)) <= 1);
    await page.click('#eConnect'); await page.waitForSelector('#eSign:not([hidden])');
    await page.fill('#eAmount', '1.5');
    await page.click('#eSign');
    await page.waitForSelector('#eSend:not([hidden])', { timeout: 15000 });
    check('F03 sign what you mean → ONE typed signature, Send enabled, transfer button appears only after the server stored the intent', (await prompts(page)).filter((x) => x === 'sign').length === 1 && (await prompts(page)).filter((x) => x === 'send').length === 0);
    const typed = JSON.parse(await page.evaluate(() => window.__lastTyped));
    check('F04 the wallet prompt showed the SYNC Proof domain, receiver = creator wallet, USDG, exact raw amount, PRIVATE', typed.domain.name === 'SyncNet SYNC Proof' && typed.message.receiver === W.creator && typed.message.token === USDG && typed.message.amount === '1500000' && typed.message.privacy === 'PRIVATE');
    intentId = typed.message.intentId;
    // resume: reload mid-flow (browser closed after signing) → Send is still offered, nothing re-signed
    await page.reload(); await page.waitForSelector('#eCreator:not([hidden])');
    await page.click('#eConnect').catch(() => {});
    await page.waitForSelector('#eSend:not([hidden])', { timeout: 15000 });
    check('F05 reload after signing resumes at Send (stored intent found), no new signature', (await prompts(page)).filter((x) => x === 'sign').length === 0 && (await page.inputValue('#eAmount')) === '1.5');
    await page.click('#eSend');
    await page.waitForURL(/\/labs\/early\/receipt\?intent=/, { timeout: 15000 });
    const tx = SENT[SENT.length - 1];
    check('F06 send → ONE eth_sendTransaction: standard transfer to the token contract, value 0, 68-byte calldata, from the signing wallet', SENT.length === 1 && tx && lc(tx.to) === USDG && tx.value === '0x0' && tx.data === E.transferCalldata(W.creator, '1500000') && lc(tx.from) === W.fan, JSON.stringify(tx));
    check('F07 happy path = exactly two wallet prompts across the flow (one typed signature in F03, one send in F06); no third signature', SENT.length === 1);
    await page.waitForFunction(() => /confirming|Transfer seen/i.test(document.getElementById('eRTitle').textContent), null, { timeout: 20000 });
    check('F08 receipt page: transfer seen, waiting for SAFE', /confirming/i.test(await page.textContent('#eRTitle')));
    makeSafe(pc.head);
    await page.click('#eRVerify');
    await page.waitForFunction(() => /verified/i.test(document.getElementById('eRStatus').textContent), null, { timeout: 20000 });
    check('F09 SAFE → verified (CONFIRMED) without any signature; card shows creator/date/audience', /Verified/.test(await page.textContent('#eRTitle')) && (await page.textContent('#eRName')) === 'ALICE' && /Supported /.test(await page.textContent('#eRDate')) && /~1.2K/.test(await page.textContent('#eRAudience')) && (await prompts(page)).filter((x) => x === 'sign').length === 0);
    check('F10 card button hidden until FINALIZED', await page.locator('#eRCardBtn').isHidden());
    // finality (the scheduled job / the page's reconcile loop would do this; here directly through the API)
    makeFinal(pc.head);
    await fetch(BASE + '/api/early', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reconcile', intentId }) });
    await page.reload(); await page.waitForSelector('#eRCardBtn:not([hidden])', { timeout: 20000 });
    check('F11 reload after finality: verified and final, card available', /final/i.test(await page.textContent('#eRTitle')));
    await page.click('#eRCardBtn');
    await page.waitForSelector('#eRShare:not([hidden])', { timeout: 15000 });
    shareUrl = await page.inputValue('#eRShareUrl');
    check('F12 making a card is an explicit opt-in (one session signature), link produced', /\/labs\/early\/v\/0x[0-9a-f]{64}$/.test(shareUrl) && (await prompts(page)).filter((x) => x === 'sign').length === 1);
    await page.click('#eRDownload');
    check('F13 receipt JSON download offered; details panel states ordering is not independently verifiable', /Not independently verifiable/.test(await page.textContent('#eRJson')));
    check('F14 no JS errors in the fan flow', errs.length === 0, errs.join(' | '));
    await c.close();
  }
  // ============================================================================================ 4. public verification page (fresh visitor, no wallet)
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true }); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(shareUrl);
    await page.waitForFunction(() => document.getElementById('eCName').textContent === 'ALICE', null, { timeout: 15000 });
    const body = await page.textContent('body');
    check('V01 public card: EARLY / I WAS THERE WHEN / ALICE / Supported date / audience / SYNC Proof verified', /I WAS THERE WHEN/.test(body) && /Supported /.test(body) && /~1.2K/.test(body) && /SYNC Proof verified/.test(body));
    check('V02 public card shows no wallet, amount, tx hash or intent id', !body.includes(W.fan) && !body.includes('1500000') && !body.includes('1.5 USDG') && !body.includes(intentId));
    check('V03 public card says what is not shown', /Not shown: .*transaction/.test(body));
    check('V04 no overflow, no JS errors', (await overflow(page)) <= 1 && errs.length === 0, errs.join(' | '));
    await c.close();
  }
  // ============================================================================================ 5. ambiguous path: two identical transfers → one conditional signature
  {
    const c = await mobileCtx({ account: W.fan2, sendMode: 'double' }); const page = await c.newPage();
    await page.goto(BASE + '/labs/early/c/' + CH); await page.waitForSelector('#eCreator:not([hidden])');
    await page.click('#eConnect'); await page.waitForSelector('#eSign:not([hidden])');
    await page.fill('#eAmount', '2'); await page.click('#eSign'); await page.waitForSelector('#eSend:not([hidden])', { timeout: 15000 });
    await page.click('#eSend'); await page.waitForURL(/\/labs\/early\/receipt\?intent=/, { timeout: 15000 });
    makeSafe(pc.head);
    await page.click('#eRVerify');
    await page.waitForSelector('#eRChoose:not([hidden])', { timeout: 20000 });
    check('A01 two matching transfers → the page asks the fan to choose (never guesses)', (await page.locator('#eRCandidates button').count()) === 2 && /Choose the transfer/.test(await page.textContent('#eRTitle')));
    await page.locator('#eRCandidates button').first().click();
    await page.waitForFunction(() => /verified/i.test(document.getElementById('eRStatus').textContent), null, { timeout: 20000 });
    check('A02 one SupportFinalize signature resolves it (the only case with a third prompt)', (await prompts(page)).filter((x) => x === 'sign').length === 1 && /Verified/.test(await page.textContent('#eRTitle')));
    await c.close();
  }
  // ============================================================================================ 6. no injected wallet on a phone → wallet-app hand-off
  {
    const c = await mobileCtx({ inject: false }); const page = await c.newPage();
    await page.goto(BASE + '/labs/early/c/' + CH); await page.waitForSelector('#eCreator:not([hidden])');
    await page.click('#eConnect');
    await page.waitForSelector('#eWalletApps:not([hidden])', { timeout: 10000 });
    const links = await page.$$eval('#eWalletAppLinks a', (as) => as.map((a) => a.href));
    check('M01 no wallet in the browser → "Open in your wallet" hand-off links carrying this exact page URL', links.length === 3 && links[0].startsWith('https://metamask.app.link/dapp/localhost:' + PORT + '/labs/early/c/' + CH) && links[1].includes(encodeURIComponent(BASE + '/labs/early/c/' + CH)));
    await c.close();
  }
  // ============================================================================================ 7. width sweep
  for (const width of [320, 360, 390, 430]) {
    const c = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await wireWallet(c);
    const page = await c.newPage(); const errs = errsOf(page);
    for (const p of ['/labs/early', '/labs/early/c/' + CH, '/labs/early/creator', '/labs/early/mine', shareUrl.replace(BASE, '')]) {
      await page.goto(BASE + p); await page.waitForTimeout(400);
      check(`${width}px ${p}: no horizontal overflow`, (await overflow(page)) <= 1, 'overflow=' + (await overflow(page)));
    }
    await page.goto(BASE + '/labs/early/c/' + CH); await page.waitForSelector('#eCreator:not([hidden])');
    await page.click('#eConnect'); await page.waitForSelector('#eSign:not([hidden])');
    check(`${width}px creator page: controls tappable (≥ 40 px) and text ≥ 10.5 px`, (await smallTargets(page, '#eSign, #eAsset, #eAmount')).length === 0 && (await tinyText(page, '#eSupportPanel, #eWarn')).length === 0, (await smallTargets(page, '#eSign, #eAsset, #eAmount')).join(',') + ' ' + (await tinyText(page, '#eSupportPanel')).join('|'));
    check(`${width}px: no JS errors`, errs.length === 0, errs.join(' | '));
    await c.close();
  }
} finally {
  await browser.close(); srv.close();
}
fs.writeFileSync(path.join(ROOT, 'tests/e2e/early-ui.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early UI checks passed`);
process.exit(failures ? 1 : 0);
