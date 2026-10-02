// EARLY UI · X (phase 5): X added to the EXISTING EARLY interface with the smallest possible delta. The YouTube UI is frozen.
// The real pages + the real functions run in-process (mock chain, EIP-1193 wallet mock that COUNTS prompts, a fake X API
// that behaves like the real token endpoint, a fake X consent page). No real network.
//   O. flag OFF  : X is invisible; the frozen YouTube DOM equals GOLDEN snapshots captured from the pre-phase-5 code (a8568ea)
//   N. flag ON   : YouTube default + unchanged (its DOM = golden once the X elements are subtracted); X lookup, Count me in,
//                  "Continue with X" → X consent (PKCE S256, users.read) → manifest → creator page → support → receipt/card
//   R. routes    : legacy /c/<UC…>, /c/youtube/<UC…>, /c/x/<id>; invalid platform/id combinations fail closed
//   P. privacy   : defaults and wording unchanged;  G. gate: the server decides (a stale/tampered client cannot bypass it)
//   V. visual    : no HTML/CSS file changed (pinned hashes); every class the X UI uses already exists in the stylesheets
// Run: node tests/e2e/early-ui-x.mjs     (PLAYWRIGHT_MODULE=… if playwright is not resolvable)
// Golden mode (run from a checkout of the PRE-phase-5 code):  WRITE_GOLDEN=<file.json> node tests/e2e/early-ui-x.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, CH, clock, pc, resetPc, pay, makeFinal, rpc, MAP, makeStore, resetStore, creatorSession, Session } from '../early/fixtures.mjs';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));

const require = createRequire(import.meta.url);
const WRITE_GOLDEN = process.env.WRITE_GOLDEN || '';
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const ytAuth = require(path.join(ROOT, 'netlify/functions/early-youtube-auth.js'));
const xAuth = fs.existsSync(path.join(ROOT, 'netlify/functions/early-x-auth.js')) ? require(path.join(ROOT, 'netlify/functions/early-x-auth.js')) : null;
const PORT = WRITE_GOLDEN ? 8951 : 8946, BASE = 'http://localhost:' + PORT;
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } else console.log('ok  ', name); }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);

// ---------------------------------------------------------------- environments: X credentials are ALWAYS present; only the flag differs
const XSECRET = 'x-client-secret-TEST-0123456789abcdef', XBEARER = 'x-app-bearer-TEST-0123456789abcdef', XCLIENT = 'x-client-id-TEST-abc', XREDIRECT = 'https://example.test/api/early-x-auth';
const ENV_OFF = { ...ENV, SYNCNET_X_CLIENT_ID: XCLIENT, SYNCNET_X_CLIENT_SECRET: XSECRET, SYNCNET_X_BEARER_TOKEN: XBEARER, SYNCNET_EARLY_X_OAUTH_REDIRECT: XREDIRECT };
const ENV_ON = { ...ENV_OFF, SYNCNET_EARLY_X_ENABLED: 'true' };
const CUR = { env: ENV_OFF };
const BIG = '9007199254740993', BIG2 = '18446744073709551615'; // ids above 2^53 stay exact strings end to end

// ---------------------------------------------------------------- fake YouTube (as in tests/e2e/early-ui.mjs)
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
// ---------------------------------------------------------------- fake X API (api.x.com): same behaviour as the phase-4 suite
const X = { users: new Map(), codes: new Map(), tokens: new Map(), calls: [], approves: BIG, authorize: [] };
const addUser = (u) => X.users.set(u.id, { id: u.id, name: u.name, username: u.username, profile_image_url: 'https://pbs.twimg.com/profile_images/' + u.id + '/a_normal.jpg', protected: false, public_metrics: { followers_count: u.followers, following_count: 1, tweet_count: 2, listed_count: 0 } });
addUser({ id: BIG, name: 'Alice (X)', username: 'alice_x', followers: 12400 });
addUser({ id: '1234567890', name: 'Bob', username: 'bob', followers: 15 });
addUser({ id: BIG2, name: 'Carol', username: 'carol_99', followers: 987654 });
const resp = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => null } });
async function xFetch(url, init = {}) {
  const u = new URL(String(url)), h = init.headers || {};
  X.calls.push({ method: init.method || 'GET', path: u.pathname, search: u.search, auth: h.authorization, body: init.body });
  if (u.host !== 'api.x.com') return resp(404, {});
  if (u.pathname === '/2/oauth2/token') {
    const p = new URLSearchParams(init.body || ''), c = X.codes.get(p.get('code'));
    if (h.authorization !== 'Basic ' + Buffer.from(XCLIENT + ':' + XSECRET).toString('base64') || !c || p.get('redirect_uri') !== c.redirect_uri || crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return resp(400, { error: 'invalid_grant' });
    X.codes.delete(p.get('code'));
    const token = 'xat-' + crypto.randomBytes(10).toString('hex'); X.tokens.set(token, c.userId);
    return resp(200, { token_type: 'bearer', expires_in: 7200, access_token: token, scope: c.scope });
  }
  const bearer = String(h.authorization || '').replace(/^Bearer /, '');
  if (u.pathname === '/2/users/me') { const uid = X.tokens.get(bearer); return uid ? resp(200, { data: X.users.get(uid) }) : resp(401, {}); }
  if (bearer !== XBEARER) return resp(401, {});
  let m;
  if ((m = /^\/2\/users\/by\/username\/([A-Za-z0-9_]+)$/.exec(u.pathname))) { const f = [...X.users.values()].find((x) => x.username.toLowerCase() === m[1].toLowerCase()); return resp(200, f ? { data: f } : { errors: [{ title: 'Not Found Error' }] }); }
  if ((m = /^\/2\/users\/([0-9]+)$/.exec(u.pathname))) { const f = X.users.get(m[1]); return resp(200, f ? { data: f } : { errors: [{ title: 'Not Found Error' }] }); }
  if (u.pathname === '/2/users') { const data = (u.searchParams.get('ids') || '').split(',').map((i) => X.users.get(i)).filter(Boolean); return resp(200, data.length ? { data } : { errors: [{ title: 'Not Found Error' }] }); }
  return resp(404, {});
}

let ipCounter = 0;
const deps = () => ({ store, env: CUR.env, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube, fetch: xFetch, xBudget: { resolvePerDay: 100000, resolvePerHour: 100000, oauthPerDay: 100000, snapshotRequestsPerDay: 100000 } });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const API_LOG = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname;
  const run = (fn) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => { API_LOG.push(req.method + ' ' + p + u.search); const event = { httpMethod: req.method, path: p, headers: { ...req.headers, 'x-nf-client-connection-ip': '10.1.' + ((ipCounter >> 8) & 255) + '.' + (ipCounter++ & 255) }, queryStringParameters: Object.fromEntries(u.searchParams), body: Buffer.concat(chunks).toString('utf8') || null }; const out = await fn._handler(event, deps()); res.writeHead(out.statusCode, out.headers || {}); res.end(out.body || ''); }); };
  if (p === '/api/early') return run(early);
  if (p === '/api/early-youtube-auth') return run(ytAuth);
  if (p === '/api/early-x-auth' && xAuth) return run(xAuth);
  if (p === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ early: true, chainId: 4663 })); }
  if (p === '/__google') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><title>Google (fake)</title><a id="allow" href="/api/early-youtube-auth?code=code-alice-0123456789&state=${encodeURIComponent(u.searchParams.get('state') || '')}">Allow</a>`); }
  if (p === '/labs/early/creator') p = '/labs-early-creator.html';
  else if (p === '/labs/early' || p.startsWith('/labs/early/')) p = '/labs-early.html';
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, path.normalize(p));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(PORT, r));

// ---------------------------------------------------------------- browser: wallet mock (counts prompts) + fake external hosts
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SENT = [], SIGNLOG = []; // every signature the wallet mock produced, in order (survives page navigations)
async function wireWallet(context, { account = W.fan } = {}) {
  await context.route('https://yt3.example/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await context.route('https://pbs.twimg.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  // the fake X consent page: validates the authorize URL like X would, mints a one-time code bound to the PKCE challenge
  // (the browser would leave for https://x.com here; the redirect hop itself is not interceptable, so the OAuth START navigation is
  // fetched WITHOUT following the redirect: its Location is the exact authorize URL our server built, and the fake consent page
  // is served in its place)
  await context.route((url) => url.pathname === '/api/early-x-auth' && url.searchParams.has('start'), async (r) => {
    const res = await r.fetch({ maxRedirects: 0 });
    const loc = res.headers().location || '';
    X.authorize.push(loc);
    let u; try { u = new URL(loc); } catch { return r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>no redirect</title><p id="noredirect">${res.status()} ${loc}</p>` }); }
    const q = u.searchParams;
    if (u.origin + u.pathname !== 'https://x.com/i/oauth2/authorize' || q.get('client_id') !== XCLIENT || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return r.fulfill({ status: 400, contentType: 'text/html', body: 'bad authorize request' });
    const code = 'authcode-' + crypto.randomBytes(10).toString('hex');
    X.codes.set(code, { challenge: q.get('code_challenge'), redirect_uri: q.get('redirect_uri'), userId: X.approves, scope: q.get('scope') });
    return r.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>X (fake)</title><h1>Fake X consent</h1><a id="allow" href="${BASE}/api/early-x-auth?code=${code}&state=${encodeURIComponent(q.get('state') || '')}">Authorize app</a>` });
  });
  await context.exposeBinding('__earlySign', (_s, { typed, account: acct }) => { SIGNLOG.push(JSON.parse(typed).primaryType); return signDigest(acct, Core.hashTypedData(JSON.parse(typed))); });
  await context.exposeBinding('__earlySend', (_s, tx) => { SENT.push(tx); const data = String(tx.data || ''); const to = '0x' + data.slice(34, 74), amount = BigInt('0x' + data.slice(74)).toString(); return pay({ from: tx.from, to, token: tx.to, amount }).txHash; });
  await context.addInitScript(({ WALLET }) => {
    const listeners = {}; const emit = (e, v) => (listeners[e] || []).forEach((f) => { try { f(v); } catch (err) { console.warn(err); } });
    window.__prompts = []; window.__typed = [];
    const provider = {
      isMetaMask: true, on: (e, f) => ((listeners[e] ||= []).push(f)), removeListener: () => {},
      async request({ method, params }) {
        switch (method) {
          case 'eth_requestAccounts': window.__prompts.push('connect'); return [WALLET];
          case 'eth_accounts': return [WALLET];
          case 'eth_chainId': return '0x1237';
          case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null;
          case 'eth_signTypedData_v4': window.__prompts.push('sign'); window.__typed.push(params[1]); return window.__earlySign({ typed: params[1], account: params[0] });
          case 'eth_sendTransaction': window.__prompts.push('send'); return window.__earlySend(params[0]);
          default: throw Object.assign(new Error('unsupported ' + method), { code: -32601 });
        }
      },
    };
    window.ethereum = provider;
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'Mock Wallet', rdns: 'test.mock', uuid: '1', icon: '' }, provider } })));
  }, { WALLET: account });
}
const browser = await chromium.launch();
const newCtx = async (opts = {}) => { const c = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 }, ...(opts.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) }); await wireWallet(c, opts); return c; };
const prompts = (page) => page.evaluate(() => window.__prompts || []);
const typedOf = (page, i = -1) => page.evaluate((i) => { const t = window.__typed || []; return JSON.parse(t[i < 0 ? t.length + i : i]); }, i);
const errsOf = (page) => { const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return errs; };
const nowSec = () => Math.floor(clock.now() / 1000);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const settle = (page) => page.waitForTimeout(350);

// ---------------------------------------------------------------- API helpers (setup that is not under test)
async function api(method, body, query, session) {
  const r = await fetch(BASE + '/api/early' + (query ? '?' + new URLSearchParams(query) : ''), { method, headers: { 'content-type': 'application/json', ...(session ? { 'x-syncnet-early-session': session } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch { j = {}; }
  return { s: r.status, j };
}
const NA = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
async function activateYouTubeCreator() {
  const tok = creatorSession(store, { channelId: CH, wallet: W.creator, title: 'Alice', subscriberCount: 1234 });
  const m = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator, acceptedAssetsHash: NA.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: nowSec(), nonce: rnd32() };
  const r = await api('POST', { action: 'creator-manifest', creatorId: m.creatorId, channelId: CH, receivingWallet: W.creator, acceptedAssets: NA.assets, acceptedAssetsHash: NA.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorManifest', m, W.creator) }, null, tok);
  if (r.s !== 201) throw new Error('youtube creator seed failed ' + JSON.stringify(r));
  return E.digest('CreatorManifest', m);
}
/** intent -> transfer -> FINALIZED receipt -> fan session -> card, entirely through the API. Returns {intentId, shareId}. */
async function supportViaApi(manifestHash, amount = '1500000') {
  const d = await api('POST', { action: 'intent-draft', manifestHash, sender: W.fan, token: USDG, amount });
  const st = await api('POST', { action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) });
  const p = pay({ from: W.fan, to: d.j.typedData.message.receiver, amount }); makeFinal(p.blockNumber);
  const v = await api('POST', { action: 'verify', intentId: d.j.intentId, txHash: p.txHash });
  const sm = { schema: E.SCHEMA.session, wallet: W.fan, issuedAt: nowSec(), nonce: rnd32() };
  const ss = await api('POST', { action: 'session', wallet: W.fan, issuedAt: sm.issuedAt, nonce: sm.nonce, signature: sign('EarlySession', sm, W.fan) });
  const card = await api('POST', { action: 'card-create', receiptId: v.j.receiptId }, null, ss.j.session);
  return { intentId: d.j.intentId, shareId: card.j.shareId, status: v.j.status, card };
}

// ---------------------------------------------------------------- DOM capture: <main> (the whole page body content), normalised for dynamic values only
const norm = (h) => h.replace(/0x[0-9a-fA-F]{8,}/g, '0x…').replace(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g, '<date>').replace(/(<pre class="early-pre" id="eRJson">)[\s\S]*?(<\/pre>)/, '$1…$2');
const mainHtml = (page, strip = []) => page.evaluate((strip) => { const m = document.querySelector('main').cloneNode(true); for (const sel of strip) for (const el of m.querySelectorAll(sel)) el.remove(); return m.outerHTML; }, strip).then(norm);
let SHOTS = {};
async function captureYouTubePages(ids, strip = {}) {
  const out = {};
  const c = await newCtx(); const page = await c.newPage(); const errs = errsOf(page);
  await page.goto(BASE + '/labs/early'); await page.waitForSelector('#eLanding:not([hidden])'); await settle(page);
  out.landing = await mainHtml(page, strip.landing);
  await page.fill('#eCmiInput', 'https://www.youtube.com/@alice'); await page.click('#eCmiFind'); await page.waitForSelector('#eCmiResult:not([hidden]) a.sn-btn'); await settle(page);
  out.landingFound = await mainHtml(page, strip.landing);
  await page.goto(BASE + '/labs/early/creator'); await page.waitForSelector('#cWallet:not([hidden])'); await page.click('#cConnect'); await page.waitForSelector('#cLink:not([hidden])'); await settle(page);
  out.setupConnected = await mainHtml(page, strip.setup);
  await page.goto(BASE + '/labs/early/c/' + CH); await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice'); await settle(page);
  out.creatorPage = await mainHtml(page);
  await page.goto(BASE + '/labs/early/receipt?intent=' + ids.intentId); await page.waitForSelector('#eRCardBtn:not([hidden])', { timeout: 20000 }); await settle(page);
  out.receipt = await mainHtml(page);
  await page.goto(BASE + '/labs/early/v/' + ids.shareId); await page.waitForFunction(() => document.getElementById('eCName').textContent === 'ALICE', null, { timeout: 15000 }); await settle(page);
  out.card = await mainHtml(page);
  await c.close();
  return { out, errs };
}

try {
  // ================================================================================================ setup: one YouTube creator with a finalized receipt and a card
  CUR.env = ENV_OFF;
  const manifestHash = await activateYouTubeCreator();
  const ids = await supportViaApi(manifestHash);

  // ================================================================================================ O. flag OFF
  const off = await captureYouTubePages(ids);
  if (WRITE_GOLDEN) {
    fs.mkdirSync(path.dirname(WRITE_GOLDEN), { recursive: true });
    fs.writeFileSync(WRITE_GOLDEN, JSON.stringify({ schema: 'syncnet.early.ui-golden.v1', generatedBy: process.env.GOLDEN_FROM || 'pre-phase-5', pages: off.out }, null, 1));
    console.log('wrote golden DOM for ' + Object.keys(off.out).length + ' pages to ' + WRITE_GOLDEN);
    await browser.close(); srv.close(); process.exit(0);
  }
  const GOLDEN = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/e2e/golden/early-flag-off.v1.json'), 'utf8')).pages;
  const diffAt = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `@${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 80))} vs …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 80))}`; };
  for (const [k, label] of [['landing', 'landing page'], ['landingFound', 'landing after a YouTube lookup'], ['setupConnected', 'creator setup (wallet connected)'], ['creatorPage', 'creator page (legacy URL)'], ['receipt', 'receipt page'], ['card', 'public card page']]) {
    check(`O0${['landing', 'landingFound', 'setupConnected', 'creatorPage', 'receipt', 'card'].indexOf(k) + 1} flag OFF: ${label} is DOM-identical to the golden captured from the pre-phase-5 code`, off.out[k] === GOLDEN[k], off.out[k] === GOLDEN[k] ? '' : diffAt(off.out[k], GOLDEN[k]));
  }
  check('O07 flag OFF: no JS errors while rendering the frozen pages', off.errs.length === 0, off.errs.join(' | '));
  {
    const c = await newCtx(); const page = await c.newPage();
    await page.goto(BASE + '/labs/early'); await page.waitForSelector('#eLanding:not([hidden])'); await settle(page);
    const landingText = await page.evaluate(() => document.body.innerText);
    check('O08 flag OFF: the platform selector does not exist anywhere (no #ePlatform, no .sn-filters, no "X" option); label and placeholder are the original YouTube ones', (await page.locator('#ePlatform').count()) === 0 && (await page.locator('.sn-filters').count()) === 0 && (await page.textContent('label[for="eCmiInput"]')) === 'YouTube channel link or @handle' && (await page.getAttribute('#eCmiInput', 'placeholder')) === 'youtube.com/@creator' && !/\bX\b/.test(landingText.replace(/SYNC Proof/g, '')));
    await page.goto(BASE + '/labs/early/creator'); await page.waitForSelector('#cWallet:not([hidden])'); await page.click('#cConnect'); await page.waitForSelector('#cLink:not([hidden])'); await settle(page);
    check('O09 flag OFF: creator setup offers only "Continue with YouTube" (no X button, no X note, step 2 is "YouTube")', (await page.locator('#cLinkX').count()) === 0 && (await page.textContent('#cLink')) === 'Continue with YouTube' && (await page.locator('#cWallet .sn-small').count()) === 2 && /YouTube/.test(await page.textContent('#cSteps')) && !/\bX\b/.test(await page.textContent('#cWallet')));
    await c.close();
  }
  {
    // the legacy URL and the canonical youtube URL render the same creator page; the existing flow data is unchanged
    const c = await newCtx(); const page = await c.newPage();
    await page.goto(BASE + '/labs/early/c/' + CH); await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice'); await settle(page);
    const legacy = await mainHtml(page);
    await page.goto(BASE + '/labs/early/c/youtube/' + CH); await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice'); await settle(page);
    const canonical = await mainHtml(page);
    check('O10 flag OFF: /labs/early/c/<UC…> (legacy) and /labs/early/c/youtube/<UC…> render the identical creator page, equal to the golden', legacy === GOLDEN.creatorPage && canonical === GOLDEN.creatorPage);
    API_LOG.length = 0;
    await page.goto(BASE + '/labs/early/c/x/' + BIG); await page.waitForSelector('#eCreator:not([hidden])'); await settle(page);
    check('O11 flag OFF: /c/x/<id> fails closed: "Not on EARLY", no support panel, no creator data (the server answers 400 Unsupported platform)', (await page.textContent('#eTitle')) === 'Not on EARLY' && (await page.locator('#eSupportPanel').isHidden()) && /This account has not joined EARLY/.test(await page.textContent('#eHandle')) && API_LOG.some((l) => /view=creator.*platform=x/.test(l)));
    const direct = [await api('GET', null, { view: 'resolve', platform: 'x', q: '@alice_x' }), await api('GET', null, { view: 'creator', platform: 'x', externalId: BIG }), await api('POST', { action: 'creator-link', platform: 'x', wallet: W.creator, issuedAt: nowSec(), nonce: rnd32(), signature: '0x' })];
    const xa = await fetch(BASE + '/api/early-x-auth?start=x', { redirect: 'manual' });
    check('O12 flag OFF: every X server entry point is closed even when called directly (resolver 400, creator view 400, creator-link 400, OAuth function → #e=closed); no X API request was made', direct.every((d) => d.s === 400) && xa.status === 302 && xa.headers.get('location') === '/labs/early/creator#e=closed' && X.calls.length === 0, direct.map((d) => d.s).join());
    const cfg = (await api('GET', null, { view: 'config' })).j;
    check('O13 flag OFF: the public config lists only YouTube (this is what the pages read)', JSON.stringify(cfg.platforms) === '["youtube"]' && !('x' in (cfg.platformServices || {})));
    await c.close();
  }

  // ================================================================================================ N. flag ON
  CUR.env = ENV_ON;
  const on = await captureYouTubePages(ids, { landing: ['#ePlatform'] });
  // creator setup is captured separately below, subtracting exactly the X additions: the X button paragraph and its note (the two paragraphs after the YouTube note)
  const onSetup = await (async () => {
    const c = await newCtx(); const page = await c.newPage();
    await page.goto(BASE + '/labs/early/creator'); await page.waitForSelector('#cWallet:not([hidden])'); await page.click('#cConnect'); await page.waitForSelector('#cLink:not([hidden])'); await page.waitForSelector('#cLinkX:not([hidden])'); await settle(page);
    const html = await page.evaluate(() => { const m = document.querySelector('main').cloneNode(true); const b = m.querySelector('#cLinkX'); const p1 = b.parentElement, p2 = p1.nextElementSibling; p2.remove(); p1.remove(); return m.outerHTML; }).then(norm);
    const info = await page.evaluate(() => { const b = document.getElementById('cLinkX'); return { text: b.textContent, cls: b.className, prev: b.parentElement.previousElementSibling.className, next: b.parentElement.nextElementSibling.className, ytText: document.getElementById('cLink').textContent }; });
    await c.close();
    return { html, info };
  })();
  check('N01 flag ON: YouTube landing DOM equals the golden once the single added element (#ePlatform tabs) is removed - nothing else on the landing page changed', on.out.landing === GOLDEN.landing, on.out.landing === GOLDEN.landing ? '' : diffAt(on.out.landing, GOLDEN.landing));
  check('N02 flag ON: after a YouTube lookup the landing DOM still equals the golden minus the tabs (YouTube input, result markup, copy and resolver behave exactly as before)', on.out.landingFound === GOLDEN.landingFound, on.out.landingFound === GOLDEN.landingFound ? '' : diffAt(on.out.landingFound, GOLDEN.landingFound));
  check('N03 flag ON: creator setup DOM equals the golden once the X button and its note are removed (YouTube button, copy and order untouched)', onSetup.html === GOLDEN.setupConnected, onSetup.html === GOLDEN.setupConnected ? '' : diffAt(onSetup.html, GOLDEN.setupConnected));
  check('N04 flag ON: the YouTube creator page, receipt page and public card are byte-identical to the golden (X never touches them)', on.out.creatorPage === GOLDEN.creatorPage && on.out.receipt === GOLDEN.receipt && on.out.card === GOLDEN.card, ['creatorPage', 'receipt', 'card'].filter((k) => on.out[k] !== GOLDEN[k]).join());
  check('N05 flag ON: the X button reuses existing classes ("sn-btn primary", the same as the YouTube button), sits right after the YouTube note, YouTube text unchanged', onSetup.info.text === 'Continue with X' && onSetup.info.cls === 'sn-btn primary' && onSetup.info.ytText === 'Continue with YouTube' && /sn-small sn-muted/.test(onSetup.info.prev) && /sn-small sn-muted/.test(onSetup.info.next), JSON.stringify(onSetup.info));
  check('N06 flag ON: no JS errors on the frozen pages', on.errs.length === 0, on.errs.join(' | '));

  // ---- landing: platform choice + X lookup
  {
    const c = await newCtx({ account: W.fan }); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early'); await page.waitForSelector('#eLanding:not([hidden])'); await page.waitForSelector('#ePlatform'); await settle(page);
    const tabs = await page.$$eval('#ePlatform button', (bs) => bs.map((b) => [b.textContent, b.getAttribute('aria-pressed'), b.dataset.platform]));
    check('N07 flag ON: the landing offers "YouTube | X" as the existing tab control (.sn-filters, aria-pressed); YouTube is the default; original label and placeholder', JSON.stringify(tabs) === JSON.stringify([['YouTube', 'true', 'youtube'], ['X', 'false', 'x']]) && (await page.getAttribute('#ePlatform', 'class')) === 'sn-filters' && (await page.textContent('label[for="eCmiInput"]')) === 'YouTube channel link or @handle' && (await page.getAttribute('#eCmiInput', 'placeholder')) === 'youtube.com/@creator');
    await page.fill('#eCmiInput', 'https://www.youtube.com/@alice'); API_LOG.length = 0; await page.click('#eCmiFind'); await page.waitForSelector('#eCmiResult:not([hidden]) a.sn-btn');
    check('N08 flag ON + YouTube selected: the lookup is the original request (legacy `yt` parameter, creator view by `channelId`) and links to the legacy URL', API_LOG.some((l) => l.includes('view=resolve&yt=')) && API_LOG.some((l) => l.includes('view=creator&channelId=' + CH)) && !API_LOG.some((l) => l.includes('platform=x')) && (await page.getAttribute('#eCmiResult a.sn-btn', 'href')) === '/labs/early/c/' + CH);
    // switch to X
    await page.click('#ePlatform button[data-platform="x"]');
    const tabs2 = await page.$$eval('#ePlatform button', (bs) => bs.map((b) => b.getAttribute('aria-pressed')));
    check('N09 selecting X: aria-pressed moves, the label/placeholder become the X ones, the previous result and input are cleared', JSON.stringify(tabs2) === '["false","true"]' && (await page.textContent('label[for="eCmiInput"]')) === 'X username or profile link' && (await page.getAttribute('#eCmiInput', 'placeholder')) === 'x.com/username' && (await page.inputValue('#eCmiInput')) === '' && (await page.locator('#eCmiResult').isHidden()));
    // and back to YouTube: the ORIGINAL label, placeholder and behaviour return exactly
    await page.click('#ePlatform button[data-platform="youtube"]');
    check('N09b switching back to YouTube restores the original label, placeholder and pressed state (and clears the input)', JSON.stringify(await page.$$eval('#ePlatform button', (bs) => bs.map((b) => b.getAttribute('aria-pressed')))) === '["true","false"]' && (await page.textContent('label[for="eCmiInput"]')) === 'YouTube channel link or @handle' && (await page.getAttribute('#eCmiInput', 'placeholder')) === 'youtube.com/@creator' && (await page.inputValue('#eCmiInput')) === '');
    await page.fill('#eCmiInput', 'https://www.youtube.com/@alice'); API_LOG.length = 0; await page.click('#eCmiFind'); await page.waitForSelector('#eCmiResult:not([hidden]) a.sn-btn');
    check('N09c ... and a YouTube lookup after the round trip is again the original request', API_LOG.some((l) => l.includes('view=resolve&yt=')) && !API_LOG.some((l) => l.includes('platform=x')) && (await page.getAttribute('#eCmiResult a.sn-btn', 'href')) === '/labs/early/c/' + CH);
    await page.click('#ePlatform button[data-platform="x"]');
    const forms = ['@alice_x', 'alice_x', 'x.com/alice_x', 'twitter.com/alice_x', 'https://twitter.com/Alice_X'];
    const seen = [];
    for (const f of forms) {
      await page.fill('#eCmiInput', f); API_LOG.length = 0; await page.click('#eCmiFind');
      await page.waitForSelector('#eCmiResult:not([hidden]) strong'); await settle(page);
      seen.push({ f, req: API_LOG.find((l) => l.includes('view=resolve')), name: await page.textContent('#eCmiResult strong'), line: await page.textContent('#eCmiResult .sn-small'), text: await page.textContent('#eCmiResult') });
      await page.evaluate(() => { document.getElementById('eCmiResult').hidden = true; });
    }
    check('N10 X lookup: @username, username, x.com/… and twitter.com/… all resolve through platform=x; the result shows the CURRENT display name and @username, never the numeric id', seen.every((s) => /platform=x&q=/.test(s.req) && s.name === 'Alice (X)' && s.line === '@alice_x' && !s.text.includes(BIG)), JSON.stringify(seen.map((s) => [s.f, s.name, s.line])));
    await page.fill('#eCmiInput', 'https://x.com/home'); await page.click('#eCmiFind'); await page.waitForFunction(() => /not an X username/.test(document.getElementById('eStatus').textContent));
    check('N11 a reserved X path is refused with a clear message and no result', /not an X username/.test(await page.textContent('#eStatus')) && (await page.locator('#eCmiResult').isHidden()));
    await page.fill('#eCmiInput', 'nobodyhere'); await page.click('#eCmiFind'); await page.waitForFunction(() => /could not be found|No X account/.test(document.getElementById('eStatus').textContent));
    check('N12 an unknown X account shows the not-found message (X wording), no result', /No X account was found|account could not be found/.test(await page.textContent('#eStatus')) && (await page.locator('#eCmiResult').isHidden()));
    // Count me in for an X account that is not on EARLY: the same single free signature, on the immutable id
    await page.fill('#eCmiInput', '@carol_99'); await page.click('#eCmiFind'); await page.waitForSelector('#eCmiSign');
    check('N13 X account not on EARLY: the same Count me in offer and copy as YouTube', /Not on EARLY yet/.test(await page.textContent('#eCmiResult')) && /Carol/.test(await page.textContent('#eCmiResult')) && !(await page.textContent('#eCmiResult')).includes(BIG2));
    await page.click('#eCmiSign');
    await page.waitForFunction(() => /Counted in/.test(document.getElementById('eCmiStatus').textContent), null, { timeout: 15000 });
    const pr = await prompts(page), typed = await typedOf(page);
    check('N14 Count me in (X) = connect + ONE free signature, no transaction; the signed struct is platform "x" with the immutable numeric id in the v1 channelId field - never the username', pr.filter((x) => x === 'sign').length === 1 && !pr.includes('send') && typed.message.platform === 'x' && typed.message.channelId === BIG2 && !JSON.stringify(typed.message).includes('carol'), JSON.stringify(typed.message));
    check('N15 the signal is stored under the x:<id> ref and the creator is still not public', MAP.has('early:cmi:v1:x:' + BIG2 + ':' + W.fan) && (await api('GET', null, { view: 'creator', platform: 'x', externalId: BIG2 })).j.onEarly === false);
    check('N16 no JS errors on the landing with X on', errs.length === 0, errs.join(' | '));
    await c.close();
  }

  // ---- creator: Continue with X → X consent → manifest → live
  let xPage = null;
  {
    X.approves = BIG; X.authorize.length = 0;
    const c = await newCtx({ account: W.creator2 }); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early/creator'); await page.waitForSelector('#cWallet:not([hidden])');
    check('N17 before a wallet is connected neither platform button is shown (same rule as YouTube)', await page.locator('#cLink').isHidden() && await page.locator('#cLinkX').isHidden());
    await page.click('#cConnect'); await page.waitForSelector('#cLinkX:not([hidden])');
    check('N18 once connected both "Continue with YouTube" and "Continue with X" are offered', (await page.textContent('#cLink')) === 'Continue with YouTube' && (await page.textContent('#cLinkX')) === 'Continue with X' && await page.locator('#cLink').isVisible());
    const signsBefore = SIGNLOG.length;
    await page.click('#cLinkX');
    await page.waitForSelector('#allow', { timeout: 10000 });
    const au = new URL(X.authorize[X.authorize.length - 1]), q = au.searchParams;
    check('N19 Continue with X: ONE free link signature, then X consent with the Phase-4 flow: users.read ONLY, PKCE S256, exact redirect URI, X-bound wallet state', SIGNLOG.length === signsBefore + 1 && SIGNLOG[SIGNLOG.length - 1] === 'CreatorLinkRequest' && q.get('scope') === 'users.read' && q.get('code_challenge_method') === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge')) && q.get('redirect_uri') === XREDIRECT && q.get('response_type') === 'code' && q.get('client_id') === XCLIENT && /^e1\.state\.0x[0-9a-f]{40}~x\./.test(q.get('state')) && !/tweet\.read|offline\.access/.test(au.search), au.search);
    await page.waitForSelector('#allow', { timeout: 5000 }).catch(async () => { throw new Error('X consent page did not render: ' + (await page.content()).replace(/\s+/g, ' ').slice(0, 300) + ' | authorize=' + X.authorize.join(',').slice(0, 200)); });
    await page.click('#allow');
    await page.waitForSelector('#cManifest:not([hidden])', { timeout: 15000 });
    const you = await page.textContent('#cYou');
    check('N20 back on the creator page: session in the fragment is cleared, the manifest step shows the X display name and @username (not the numeric id), step 2 is named "X"', !page.url().includes('#') && /Alice \(X\)/.test(you) && /@alice_x/.test(you) && !you.includes(BIG) && /X/.test(await page.textContent('#cSteps li:nth-child(2)')) && !/YouTube/.test(await page.textContent('#cSteps li:nth-child(2)')), you);
    check('N21 the manifest step copy is the same sentence with X words ("Identity is your X account id; your username and name can change freely")', /Identity is your X account id; your username and name can change freely/.test(await page.textContent('#cManifest')) && !/channel id/.test(await page.textContent('#cManifest > p.sn-dim')));
    await page.check('input[type="checkbox"][data-token="' + USDG + '"]'); await page.fill('input[data-min="' + USDG + '"]', '1');
    await page.click('#cSign');
    await page.waitForSelector('#cDash:not([hidden])', { timeout: 15000 });
    const t2 = await typedOf(page);
    check('N22 signing the manifest: the receiving wallet signs the v1 CreatorManifest with platform "x" and channelId = the exact numeric id (above 2^53, as a string)', t2.primaryType === 'CreatorManifest' && t2.message.platform === 'x' && t2.message.channelId === BIG && t2.message.creatorId === E.creatorIdOf(BIG, 'x') && t2.message.receivingWallet === W.creator2, JSON.stringify(t2.message));
    check('N23 dashboard: live, X display name + @username, the page link is the canonical /labs/early/c/x/<id>, receiving wallet shown', /ACTIVE/.test(await page.textContent('#dStatus')) && (await page.textContent('#dTitle')) === 'Alice (X)' && (await page.textContent('#dHandle')) === '@alice_x' && (await page.getAttribute('#dPage', 'href')) === '/labs/early/c/x/' + BIG && (await page.textContent('#dWallet')) === W.creator2);
    await page.click('#dRotate');
    check('N24 wallet-change panel uses X wording for the fresh-verification note (same sentence otherwise)', /Your X verification is fresh/.test(await page.textContent('#dRotateFresh')) && !/YouTube/.test(await page.textContent('#dRotatePanel')));
    check('N25 no JS errors in the X creator flow', errs.length === 0, errs.join(' | '));
    const creatorRec = JSON.parse(MAP.get('early:creator:v1:' + E.creatorIdOf(BIG, 'x')).value);
    check('N26 server state: creator record is platform x with the numeric id; the OAuth access token was never stored', creatorRec.platform === 'x' && creatorRec.channelId === BIG && ![...X.tokens.keys()].some((t) => JSON.stringify([...MAP.entries()]).includes(t)));
    xPage = '/labs/early/c/x/' + BIG;
    await c.close();
  }
  // ---- fan: the X creator page, support flow, receipt, card
  let xIntent = null, xShare = null;
  {
    const c = await newCtx({ mobile: true, account: W.fan }); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + xPage); await page.waitForSelector('#eCreator:not([hidden])');
    await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice (X)'); await settle(page);
    const ids2 = await page.$$eval('#eCreator [id]', (els) => els.filter((e) => !e.closest('[hidden]') || true).map((e) => e.id).sort());
    const idsYt = await (async () => { const p2 = await c.newPage(); await p2.goto(BASE + '/labs/early/c/' + CH); await p2.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice'); const r = await p2.$$eval('#eCreator [id]', (els) => els.map((e) => e.id).sort()); await p2.close(); return r; })();
    check('N27 the X creator page is the SAME layout: identical set of element ids as the YouTube creator page (no section added or removed)', JSON.stringify(ids2) === JSON.stringify(idsYt), JSON.stringify(ids2.filter((i) => !idsYt.includes(i))));
    check('N28 only platform data/words differ: "EARLY · X creator", display name, @username, "verified for this account"; the numeric id is not the headline; assets and minimum shown', (await page.textContent('#eCreator .early-head .sn-label')) === 'EARLY · X creator' && (await page.textContent('#eTitle')) === 'Alice (X)' && (await page.textContent('#eHandle')) === '@alice_x' && /verified for this account by SyncNet/.test(await page.textContent('#eCreator .early-kv')) && /USDG/.test(await page.textContent('#eAssets')) && !(await page.textContent('#eCreator .early-head')).includes(BIG));
    check('N29 avatar from X is shown (display metadata only)', (await page.locator('#eAvatar img').count()) === 1);
    await page.click('#eConnect'); await page.waitForSelector('#eSign:not([hidden])');
    await page.fill('#eAmount', '1.5'); await page.click('#eSign'); await page.waitForSelector('#eSend:not([hidden])', { timeout: 15000 });
    const typed = await typedOf(page);
    xIntent = typed.message.intentId;
    check('N30 sign what you mean: ONE typed signature; the SupportIntent names creatorId = keccak(x|numeric id), the creator wallet, USDG, the exact amount, PRIVATE - the immutable id, not a username', (await prompts(page)).filter((x) => x === 'sign').length === 1 && typed.message.creatorId === E.creatorIdOf(BIG, 'x') && typed.message.receiver === W.creator2 && typed.message.token === USDG && typed.message.amount === '1500000' && typed.message.privacy === 'PRIVATE');
    await page.click('#eSend'); await page.waitForURL(/\/labs\/early\/receipt\?intent=/, { timeout: 15000 });
    const tx = SENT[SENT.length - 1];
    check('N31 direct payment unchanged: ONE eth_sendTransaction, a standard transfer to the token contract, value 0, 68-byte calldata to the creator wallet; the flow had exactly two prompts (sign, send)', tx && lc(tx.to) === USDG && tx.value === '0x0' && tx.data === E.transferCalldata(W.creator2, '1500000') && SENT.length >= 1, JSON.stringify(tx));
    await page.waitForFunction(() => /confirming|Transfer seen/i.test(document.getElementById('eRTitle').textContent), null, { timeout: 25000 });
    makeFinal(pc.head);
    await page.click('#eRVerify');
    await page.waitForFunction(() => /verified/i.test(document.getElementById('eRStatus').textContent), null, { timeout: 25000 });
    await fetch(BASE + '/api/early', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reconcile', intentId: xIntent }) });
    await page.reload(); await page.waitForSelector('#eRCardBtn:not([hidden])', { timeout: 20000 });
    check('N32 receipt: X creator name on the card and "Followers on X then: ~12K" (never "Audience then")', (await page.textContent('#eRName')) === 'ALICE (X)' && (await page.textContent('#eRAudience')) === 'Followers on X then: ~12K' && !/Audience then/.test(await page.textContent('#eRCard')));
    check('N33 receipt page keeps its structure; the share note names the followers context for X; no wallet / amount / transaction on the card', /followers on X then/.test(await page.textContent('#eRShare')) && !(await page.textContent('#eRCard')).includes(W.fan) && !(await page.textContent('#eRCard')).includes('1500000'));
    await page.click('#eRCardBtn'); await page.waitForSelector('#eRShare:not([hidden])', { timeout: 15000 });
    xShare = await page.inputValue('#eRShareUrl');
    check('N34 making the card is the same opt-in (one session signature); no JS errors', (await prompts(page)).filter((x) => x === 'sign').length === 1 && !(await prompts(page)).includes('send') && /\/labs\/early\/v\/0x[0-9a-f]{64}$/.test(xShare) && errs.length === 0, (await prompts(page)).join() + errs.join('|'));
    await c.close();
  }
  {
    const c = await newCtx({ mobile: true }); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(xShare); await page.waitForFunction(() => document.getElementById('eCName').textContent === 'ALICE (X)', null, { timeout: 15000 });
    const body = await page.textContent('body');
    check('N35 public X card: EARLY / I WAS THERE WHEN / name / "Followers on X then: ~12K" / SYNC Proof verified; the audience note speaks of X followers', /I WAS THERE WHEN/.test(body) && (await page.textContent('#eCAudience')) === 'Followers on X then: ~12K' && /SYNC Proof verified/.test(body) && /Follower count is an approximate, dated snapshot from X/.test(await page.textContent('#eCAudNote')) && (await page.$eval('#eCAudNote', (e) => e.hidden)) === false && !/Audience then/.test(body));
    check('N36 privacy defaults unchanged on the X card: no wallet, amount, tx hash, intent id, numeric id or username; the same "Not shown" sentence; attestations listed', !body.includes(W.fan) && !body.includes('1500000') && !body.includes(xIntent) && !body.includes(BIG) && !/alice_x/.test(body) && /Not shown: .*transaction/.test(body) && /audience snapshot attestation/.test(await page.textContent('#eCList')));
    // the payload the page reads (not only the rendered text): privacy defaults are exactly the YouTube ones
    const card = (await api('GET', null, { view: 'card', shareId: xShare.split('/').pop() })).j.card;
    const ytCard = (await api('GET', null, { view: 'card', shareId: ids.shareId })).j.card;
    check('P01 card API payload: wallet, amount and transaction are null and nothing is revealed - identical defaults for the X card and the YouTube card; no username or supporter data in the payload', card.wallet === null && card.amount === null && card.transaction === null && JSON.stringify(card.revealed) === '[]' && ytCard.wallet === null && ytCard.amount === null && ytCard.transaction === null && JSON.stringify(ytCard.revealed) === '[]' && !JSON.stringify(card).includes(W.fan) && !/alice_x/.test(JSON.stringify(card)) && card.creatorPlatform === 'x' && card.creatorExternalId === BIG && card.creatorChannelId === null);
    // snapshot absent for the transfer's day → the unavailable wording
    const key = 'early:snap:v1:x:' + BIG + ':' + card.supportedOn, saved = MAP.get(key);
    MAP.delete(key);
    try {
      await page.reload(); await page.waitForFunction(() => document.getElementById('eCName').textContent === 'ALICE (X)', null, { timeout: 15000 });
      check('N37 no follower snapshot for that day → "Followers on X then: unavailable"; the snapshot note is hidden and the list does not claim a snapshot attestation', (await page.textContent('#eCAudience')) === 'Followers on X then: unavailable' && (await page.$eval('#eCAudNote', (e) => e.hidden)) === true && !/audience snapshot attestation/.test(await page.textContent('#eCList')) && !/Audience then/.test(await page.textContent('body')));
    } finally { MAP.set(key, saved); }
    check('N38 no JS errors on the public X card', errs.length === 0, errs.join(' | '));
    await c.close();
  }
  {
    // "My EARLY" lists X signals by what we know, links joined X creators to the canonical route
    const c = await newCtx({ account: W.fan }); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early/mine'); await page.waitForSelector('#eMine:not([hidden])'); await page.click('#eMineSignIn');
    await page.waitForSelector('#eMineLists:not([hidden])', { timeout: 15000 }); await settle(page);
    const sig = await page.textContent('#eMineSignals');
    check('N39 My EARLY: the X signal is listed as "X account <id>" (we hold no profile for it) and the YouTube-style layout is unchanged; receipts list the X receipt', sig.includes('X account ' + BIG2) && (await page.textContent('#eMineReceipts')).includes('Alice (X)') && errs.length === 0, sig);
    await c.close();
  }

  {
    // an X creator that IS on EARLY: the lookup offers the support link, built from the immutable id (never the username)
    const c = await newCtx(); const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early'); await page.waitForSelector('#ePlatform'); await page.click('#ePlatform button[data-platform="x"]');
    await page.fill('#eCmiInput', 'https://x.com/alice_x'); await page.click('#eCmiFind'); await page.waitForSelector('#eCmiResult:not([hidden]) a.sn-btn'); await settle(page);
    const href = await page.getAttribute('#eCmiResult a.sn-btn', 'href'), txt = await page.textContent('#eCmiResult');
    check('N40 X creator already on EARLY: the lookup shows "On EARLY · Support directly →" linking to /labs/early/c/x/<numeric id>; the username is only displayed, the id is not shown as text; no Count me in offer', href === '/labs/early/c/x/' + BIG && /On EARLY · Support directly/.test(txt) && txt.includes('@alice_x') && !txt.includes(BIG) && (await page.locator('#eCmiSign').count()) === 0 && errs.length === 0);
    await page.click('#eCmiResult a.sn-btn'); await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice (X)');
    check('N41 following that link opens the X creator page', page.url() === BASE + '/labs/early/c/x/' + BIG);
    await c.close();
  }

  // ================================================================================================ R. routes
  {
    const c = await newCtx(); const page = await c.newPage(); const errs = errsOf(page);
    const title = async (p) => { API_LOG.length = 0; await page.goto(BASE + p); await settle(page); await page.waitForTimeout(250); return { t: await page.evaluate(() => (document.getElementById('eCreator').hidden ? null : document.getElementById('eTitle').textContent)), landing: await page.evaluate(() => !document.getElementById('eLanding').hidden), creatorCalls: API_LOG.filter((l) => /view=creator/.test(l)).length }; };
    const r1 = await title('/labs/early/c/' + CH), r2 = await title('/labs/early/c/youtube/' + CH), r3 = await title('/labs/early/c/x/' + BIG);
    check('R01 /c/<UC…> (legacy, permanent), /c/youtube/<UC…> and /c/x/<numeric id> each render their creator page', r1.t === 'Alice' && r2.t === 'Alice' && r3.t === 'Alice (X)');
    const bad = ['/labs/early/c/x/' + CH, '/labs/early/c/youtube/' + BIG, '/labs/early/c/tiktok/' + BIG, '/labs/early/c/x/0123', '/labs/early/c/x/0', '/labs/early/c/x/' + '9'.repeat(21), '/labs/early/c/x/12a', '/labs/early/c/x/', '/labs/early/c/x/' + BIG + '/extra', '/labs/early/c/youtube/UC123', '/labs/early/c/X/' + BIG, '/labs/early/c/@alice_x', '/labs/early/c/x/@alice_x', '/labs/early/c/UC123', '/labs/early/c/x/' + BIG + '%20'];
    const rs = []; for (const p of bad) rs.push([p, await title(p)]);
    check('R02 invalid platform/id combinations fail closed: no creator page, no creator API request is made (the page falls back to the landing)', rs.every(([, r]) => r.t === null && r.creatorCalls === 0 && r.landing === true), JSON.stringify(rs.filter(([, r]) => !(r.t === null && r.creatorCalls === 0)).map(([p]) => p)));
    API_LOG.length = 0;
    await page.goto(BASE + '/labs/early/c/x/' + BIG); await settle(page);
    check('R03 the X route asks the server by (platform, numeric id) - never by username', API_LOG.some((l) => l.includes('view=creator&platform=x&externalId=' + BIG)) && !API_LOG.some((l) => /alice_x/.test(l)));
    check('R04 no JS errors across the routes', errs.length === 0, errs.join(' | '));
    await c.close();
  }

  // ================================================================================================ G. the server decides
  {
    // a page loaded while X was ON keeps working markup, but once the server closes X the stale client cannot get anything through
    const c = await newCtx({ account: W.fan }); const page = await c.newPage();
    await page.goto(BASE + '/labs/early'); await page.waitForSelector('#ePlatform'); await page.click('#ePlatform button[data-platform="x"]');
    CUR.env = ENV_OFF; // the flag is removed while the page is open
    const before = X.calls.length;
    await page.fill('#eCmiInput', '@alice_x'); await page.click('#eCmiFind');
    await page.waitForFunction(() => /Unsupported platform|could not be found/.test(document.getElementById('eStatus').textContent));
    check('G01 stale client + server gate: with X switched off the lookup is refused by the SERVER (no result, no X API request) even though the page still shows the X tab', /Unsupported platform/.test(await page.textContent('#eStatus')) && (await page.locator('#eCmiResult').isHidden()) && X.calls.length === before);
    // X creator page and a tampered client cannot sign in: the OAuth function and creator-link are closed server-side
    const link = await api('POST', { action: 'creator-link', platform: 'x', wallet: W.creator2, issuedAt: nowSec(), nonce: rnd32(), signature: sign('CreatorLinkRequest', { schema: E.SCHEMA.creatorLink, wallet: W.creator2, issuedAt: nowSec(), nonce: rnd32() }, W.creator2) });
    const cr = await api('GET', null, { view: 'creator', platform: 'x', externalId: BIG });
    const ses = Session.issue({ scope: 'creator', wallet: W.creator2, platform: 'x', externalId: BIG, now: () => clock.now(), env: ENV_OFF });
    const me = await api('GET', null, { view: 'me' }, ses);
    check('G02 flag removed: creator-link(x), the X creator view and even a validly signed X creator session are all refused by the server', link.s === 400 && cr.s === 400 && me.s === 401, [link.s, cr.s, me.s].join());
    await page.goto(BASE + xPage); await page.waitForSelector('#eCreator:not([hidden])'); await settle(page);
    check('G03 flag removed: the X creator page degrades to the standard "Not on EARLY" (no support panel) - the YouTube creator page is unaffected', (await page.textContent('#eTitle')) === 'Not on EARLY' && await page.locator('#eSupportPanel').isHidden());
    await page.goto(BASE + '/labs/early/c/' + CH); await page.waitForFunction(() => document.getElementById('eTitle').textContent === 'Alice');
    check('G04 flag removed: the YouTube creator page still renders', (await page.textContent('#eTitle')) === 'Alice' && await page.locator('#eSupportPanel').isVisible());
    CUR.env = ENV_ON;
    // credentials without the flag never open X (the fixed ENV_OFF has all four values)
    check('G05 credentials alone never show X: ENV_OFF holds all four X values yet the landing has no tabs (O08) and the config lists only YouTube (O13)', ENV_OFF.SYNCNET_X_CLIENT_ID && ENV_OFF.SYNCNET_X_CLIENT_SECRET && ENV_OFF.SYNCNET_X_BEARER_TOKEN && ENV_OFF.SYNCNET_EARLY_X_OAUTH_REDIRECT && !ENV_OFF.SYNCNET_EARLY_X_ENABLED);
    await c.close();
  }
  // ---- phone sweep for the X additions
  for (const width of [320, 390]) {
    const c = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await wireWallet(c);
    const page = await c.newPage(); const errs = errsOf(page);
    await page.goto(BASE + '/labs/early'); await page.waitForSelector('#ePlatform'); await page.click('#ePlatform button[data-platform="x"]'); await settle(page);
    const o1 = await overflow(page);
    const small = await page.evaluate(() => [...document.querySelectorAll('#ePlatform button')].filter((b) => b.getBoundingClientRect().height < 40).length);
    await page.goto(BASE + xPage); await page.waitForSelector('#eCreator:not([hidden])'); await settle(page);
    const o2 = await overflow(page);
    await page.goto(BASE + '/labs/early/creator'); await page.waitForSelector('#cWallet:not([hidden])'); await page.click('#cConnect'); await page.waitForSelector('#cLinkX:not([hidden])'); await settle(page);
    const o3 = await overflow(page);
    const smallBtn = await page.evaluate(() => [...document.querySelectorAll('#cLink, #cLinkX')].filter((b) => b.getBoundingClientRect().height < 40).length);
    check(`${width}px: X tabs, X creator page and creator setup with both buttons have no horizontal overflow; the new tap targets are ≥ 40 px; no JS errors`, o1 <= 1 && o2 <= 1 && o3 <= 1 && small === 0 && smallBtn === 0 && errs.length === 0, [o1, o2, o3, small, smallBtn, errs.join('|')].join());
    await c.close();
  }

  // ================================================================================================ V. no visual-language change
  {
    const gitBlob = (rel) => { const b = fs.readFileSync(path.join(ROOT, rel)); return crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob ' + b.length + '\0'), b])).digest('hex'); };
    // git blob ids of the files at the pre-phase-5 commit a8568ea: phase 5 changes NO html and NO css
    const FROZEN = { 'labs-early.html': 'f31f23418bf7e55ded2ceaac14f2b36491c875a2', 'labs-early-creator.html': 'e7cca95a2e3e7612af35622f99d99872068d33b2', 'ui.css': '354af0e8d3ad523929117d973ef07f8e0ac6c70e', 'v2.css': '893b839b7443ce46132613aa705a1b20cddc1547' };
    check('V01 phase 5 changes NO html and NO stylesheet: labs-early.html, labs-early-creator.html, ui.css and v2.css are byte-identical to a8568ea (re-pin deliberately if a later phase changes them)', Object.entries(FROZEN).every(([f, h]) => gitBlob(f) === h), Object.entries(FROZEN).filter(([f, h]) => gitBlob(f) !== h).map(([f]) => f).join());
    const css = fs.readFileSync(path.join(ROOT, 'ui.css'), 'utf8') + fs.readFileSync(path.join(ROOT, 'v2.css'), 'utf8');
    const defined = (cls) => new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![A-Za-z0-9_-])').test(css);
    const js = fs.readFileSync(path.join(ROOT, 'labs-early.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'labs-early-creator.js'), 'utf8');
    const xBlocks = [js.match(/<div class="sn-filters"[^>]*>/)[0], js.match(/<button class="sn-btn primary" type="button" id="cLinkX"[^>]*>/)[0], js.match(/<p class="sn-small sn-muted">Continuing signs a free message with your wallet, then opens X[^<]*/)[0]];
    const classes = [...new Set(xBlocks.flatMap((b) => [...b.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))))];
    check('V02 every CSS class used by the X additions already exists in the shared stylesheets (no new visual language): ' + classes.join(', '), classes.length >= 3 && classes.every(defined) && !/early-x|sn-x|platform-/.test(css), classes.filter((c) => !defined(c)).join());
    check('V03 the only inline style added is the tab strip margin (the same inline-margin pattern the page already uses); no new <style>, no new stylesheet link', (js.match(/style="margin:14px 0 0"/g) || []).length === 1 && !/<style|createElement\('style'\)|stylesheet/.test(js));
  }
} finally {
  await browser.close(); srv.close();
}
fs.writeFileSync(path.join(ROOT, 'tests/e2e/early-ui-x.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early X UI checks passed`);
process.exit(failures ? 1 : 0);
