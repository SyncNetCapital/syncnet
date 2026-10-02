// EARLY · X platform (phase 4): the X adapter, X OAuth 2.0 (Authorization Code + PKCE S256, scopes "tweet.read users.read" only), the X
// resolver, dated follower snapshots, the spend guard and the feature gate. Everything runs against a FAKE X HTTP server
// that behaves like the real token endpoint (Basic client auth, exact redirect URI, PKCE S256 verification, single-use
// codes); nothing touches a real network. The real adapter/clients/functions are the code under test.
//   A. input parsing            B. PKCE + authorize URL        C. the HTTP client (token, /users/me, lookups, errors)
//   D. OAuth function end to end (state, PKCE, redirects, no token persisted/logged, budget)
//   E. resolver (cache, reserved paths, budget, malformed)     F. snapshots + receipts (first-of-day, outage, mixed run)
//   G. feature gate (flag, credentials, redirect, kill switches; YouTube unaffected)
// Run: node tests/early/x.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, CH, CH2, clock, resetPc, pay, makeFinal, rpc, MAP, makeStore, resetStore, creatorSession, Session } from './fixtures.mjs';
import { verifyReceipt } from '../../docs/early/verify-receipt.mjs';

const require = createRequire(import.meta.url);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }
const LOG = [];
console.log = ((orig) => (...a) => { for (const x of a) if (typeof x === 'string') LOG.push(x); if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const xAuth = require(path.join(ROOT, 'netlify/functions/early-x-auth.js'));
const ytAuth = require(path.join(ROOT, 'netlify/functions/early-youtube-auth.js'));
const snapJob = require(path.join(ROOT, 'netlify/functions/early-snapshot.js'));
const { earlyConfig, platformEnabled, X_BUDGET } = require(path.join(ROOT, 'netlify/lib/early-config.js'));
const Xc = require(path.join(ROOT, 'netlify/lib/early-x.js'));
const Platforms = require(path.join(ROOT, 'netlify/lib/early-platforms.js'));
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const store = makeStore();
const nowSec = () => Math.floor(clock.now() / 1000);
let ipSeq = 0; const ip = () => `203.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body, headers: r.headers || {} }; };

// ---- secrets used by this suite: none of them may ever be persisted, logged or returned
const SECRET = 'x-client-secret-TEST-0123456789abcdef';
const BEARER = 'x-app-bearer-TEST-0123456789abcdef';
const CLIENT_ID = 'x-client-id-TEST-abc';
const REDIRECT = 'https://deploy-preview-9.example.test/api/early-x-auth';
const XENV = { ...ENV, SYNCNET_EARLY_X_ENABLED: 'true', SYNCNET_X_CLIENT_ID: CLIENT_ID, SYNCNET_X_CLIENT_SECRET: SECRET, SYNCNET_X_BEARER_TOKEN: BEARER, SYNCNET_EARLY_X_OAUTH_REDIRECT: REDIRECT };
const SESSION_KEY = ENV.SYNCNET_EARLY_SESSION_KEY;
const BIG = '9007199254740993', BIG2 = '18446744073709551615'; // 2^53 + 1 (not a safe integer) and the largest 20-digit id

// ---------------------------------------------------------------- fake X (api.x.com)
const X = { users: new Map(), codes: new Map(), tokens: new Map(), calls: [], mode: 'ok', override: null, refresh: false };
const addUser = (u) => X.users.set(u.id, { id: u.id, name: u.name, username: u.username, profile_image_url: u.avatar === undefined ? 'https://pbs.twimg.com/profile_images/' + u.id + '/a_normal.jpg' : u.avatar, protected: Boolean(u.protected), ...(u.metrics === null ? {} : { public_metrics: { followers_count: u.followers, following_count: 1, tweet_count: 2, listed_count: 0 } }) });
addUser({ id: '44196397', name: 'Elon Musk', username: 'elonmusk', followers: 200000000 });
addUser({ id: BIG, name: 'Alice (X)', username: 'alice_x', followers: 12400 });
addUser({ id: '1234567890', name: 'Bob', username: 'bob', followers: 15 });
addUser({ id: BIG2, name: 'Carol', username: 'carol_99', followers: 987654 });
addUser({ id: '777', name: 'Nometrics', username: 'nometrics', metrics: null });
addUser({ id: '31337', name: 'Business', username: 'business', followers: 1000 });
const resp = (status, body, headers) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || null } });
const callsTo = (pred) => X.calls.filter(pred);
async function fakeFetch(url, init = {}) {
  const u = new URL(String(url));
  const h = init.headers || {};
  X.calls.push({ method: init.method || 'GET', host: u.host, path: u.pathname, search: u.search, auth: h.authorization, ct: h['content-type'], body: init.body, redirect: init.redirect });
  if (X.mode === 'down') return resp(503, {});
  if (X.mode === 'ratelimit') return resp(429, {}, { 'retry-after': '30' });
  if (X.mode === 'hang') await new Promise((res, rej) => { const t = setTimeout(res, 3000); init.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
  if (X.override) { const o = X.override(u, init); if (o) return o; }
  if (u.host !== 'api.x.com') return resp(404, {});
  if (u.pathname === '/2/oauth2/token') {
    const p = new URLSearchParams(init.body || '');
    const expected = 'Basic ' + Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64');
    if (init.method !== 'POST' || h.authorization !== expected || h['content-type'] !== 'application/x-www-form-urlencoded') return resp(401, { error: 'invalid_client' });
    const c = X.codes.get(p.get('code'));
    if (!c || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== c.redirect_uri) return resp(400, { error: 'invalid_grant' });
    const v = p.get('code_verifier') || '';
    if (crypto.createHash('sha256').update(v).digest('base64url') !== c.challenge) return resp(400, { error: 'invalid_grant', error_description: 'pkce' });
    X.codes.delete(p.get('code')); // single use
    const token = 'xat-' + crypto.randomBytes(12).toString('hex');
    X.tokens.set(token, c.userId);
    return resp(200, { token_type: 'bearer', expires_in: 7200, access_token: token, scope: c.scope, ...(X.refresh ? { refresh_token: 'xrt-' + crypto.randomBytes(8).toString('hex') } : {}) });
  }
  const bearer = String(h.authorization || '').replace(/^Bearer /, '');
  if (u.pathname === '/2/users/me') {
    const uid = X.tokens.get(bearer);
    return uid && X.users.has(uid) ? resp(200, { data: X.users.get(uid) }) : resp(401, { title: 'Unauthorized' });
  }
  if (bearer !== BEARER) return resp(401, { title: 'Unauthorized' });
  let m;
  if ((m = /^\/2\/users\/by\/username\/([A-Za-z0-9_]+)$/.exec(u.pathname))) { const f = [...X.users.values()].find((x) => x.username.toLowerCase() === m[1].toLowerCase()); return resp(200, f ? { data: f } : { errors: [{ title: 'Not Found Error', detail: 'Could not find user' }] }); }
  if ((m = /^\/2\/users\/([0-9]+)$/.exec(u.pathname))) { const f = X.users.get(m[1]); return resp(200, f ? { data: f } : { errors: [{ title: 'Not Found Error' }] }); }
  if (u.pathname === '/2/users') { const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean); const data = ids.map((i) => X.users.get(i)).filter(Boolean); return resp(200, data.length ? { data } : { errors: [{ title: 'Not Found Error' }] }); }
  return resp(404, {});
}
/** The browser step: the user approves at X. Validates the authorize URL like X would and mints a one-time code. */
function consent(location, userId, over = {}) {
  const u = new URL(location);
  const q = u.searchParams;
  if (u.origin + u.pathname !== 'https://x.com/i/oauth2/authorize' || q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) throw new Error('bad authorize URL ' + location);
  const code = 'authcode-' + crypto.randomBytes(10).toString('hex');
  X.codes.set(code, { challenge: q.get('code_challenge'), redirect_uri: q.get('redirect_uri'), userId, scope: over.scope || q.get('scope') });
  return { code, state: q.get('state') };
}

// ---------------------------------------------------------------- harness
const callEarly = async (method, body, queryParams, over = {}) => parse(await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': over.ip || ip(), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: queryParams || {}, body: body ? JSON.stringify(body) : null }, { store, env: over.env || XENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: over.fetch || fakeFetch, xBudget: over.xBudget, youtube: over.youtube }));
const get = (view, params, over) => callEarly('GET', null, { view, ...(params || {}) }, over);
const post = (body, over) => callEarly('POST', body, null, over);
const authCall = async (params, over = {}) => parse(await xAuth._handler({ httpMethod: over.method || 'GET', headers: { 'x-nf-client-connection-ip': over.ip || ip() }, queryStringParameters: params }, { store, env: over.env || XENV, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: fakeFetch, xBudget: over.xBudget }));
const ytAuthCall = async (params) => parse(await ytAuth._handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: params }, { store, env: XENV, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: fakeFetch }));
const jobCall = async (over = {}) => parse(await snapJob._handler({}, { store, env: over.env || XENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: fakeFetch, youtube: over.youtube, xBudget: over.xBudget }));
async function creatorLink(wallet = W.creator, platform = 'x', env) {
  const m = { schema: E.SCHEMA.creatorLink, wallet, issuedAt: nowSec(), nonce: rnd32() };
  return post({ action: 'creator-link', ...(platform ? { platform } : {}), wallet, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorLinkRequest', m, wallet) }, { env });
}
const stateOf = (r) => decodeURIComponent((r.j.startUrl || '').split('start=')[1] || '');
/** wallet signs the link request -> X consent -> callback. Returns everything a test may want to inspect. */
async function login(userId, wallet = W.creator, over = {}) {
  const link = await creatorLink(wallet, 'x');
  const state = stateOf(link);
  const start = await authCall({ start: state }, over);
  const c = consent(start.headers.location, userId, over);
  const cb = await authCall({ code: c.code, state: c.state, ...(over.extra || {}) }, over);
  const session = decodeURIComponent((cb.headers.location || '').split('#s=')[1] || '');
  return { link, state, start, code: c.code, cb, session };
}
const fresh = () => { resetStore(); resetPc(); X.calls.length = 0; X.codes.clear(); X.tokens.clear(); X.mode = 'ok'; X.override = null; X.refresh = false; LOG.length = 0; };
const NA = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
async function manifestFor(platform, id, wallet, session, version = 1, prev = E.ZERO32) {
  const m = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(id, platform), platform, channelId: id, chainId: 4663, receivingWallet: wallet, acceptedAssetsHash: NA.hash, manifestVersion: version, previousManifestHash: prev, issuedAt: nowSec(), nonce: rnd32() };
  const r = await post({ action: 'creator-manifest', creatorId: m.creatorId, ...(platform === 'youtube' ? { channelId: id } : { platform, externalId: id }), receivingWallet: wallet, acceptedAssets: NA.assets, acceptedAssetsHash: NA.hash, manifestVersion: version, previousManifestHash: prev, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorManifest', m, wallet) }, { session });
  return { r, hash: E.digest('CreatorManifest', m), m };
}

// ============================================================================================ A. input parsing
{
  const P = Xc.parseInput;
  const u = (v) => ({ kind: 'username', value: v }), id = (v) => ({ kind: 'id', value: v });
  const cases = [
    ['@elonmusk', u('elonmusk')], ['elonmusk', u('elonmusk')], ['  @ElonMusk  ', u('ElonMusk')], ['@123', u('123')], ['business', u('business')], ['home', u('home')], ['a_b_1', u('a_b_1')],
    ['https://x.com/elonmusk', u('elonmusk')], ['http://x.com/elonmusk', u('elonmusk')], ['x.com/elonmusk', u('elonmusk')], ['https://www.x.com/elonmusk/', u('elonmusk')], ['https://mobile.x.com/elonmusk', u('elonmusk')],
    ['https://twitter.com/elonmusk', u('elonmusk')], ['twitter.com/elonmusk', u('elonmusk')], ['https://www.twitter.com/elonmusk?lang=en', u('elonmusk')], ['https://x.com/elonmusk/status/1234567890#frag', u('elonmusk')], ['https://x.com/business', u('business')],
    ['44196397', id('44196397')], [BIG, id(BIG)], [BIG2, id(BIG2)], ['https://x.com/i/user/44196397', id('44196397')], ['https://twitter.com/intent/user?user_id=44196397', id('44196397')], ['https://x.com/123', u('123')],
  ];
  const bad = ['', '   ', '@', '@@elon', '@has space', '@toolongusernamexx1', '@bad-dash', 'bad-dash', 'a.b', 'https://x.com', 'https://x.com/', 'https://x.com/home', 'https://x.com/explore', 'https://x.com/search?q=a', 'https://x.com/i/flow/login', 'https://x.com/i/user/abc', 'https://x.com/i/user/0123',
    'https://x.com/intent/tweet?text=hi', 'https://x.com/intent/user', 'https://x.com/intent/user?user_id=abc', 'https://x.com/settings', 'https://x.com/notifications', 'https://x.com/messages', 'https://x.com/compose/post', 'https://x.com/share?url=a', 'https://x.com/tos', 'https://x.com/hashtag/foo',
    'https://evil.com/elonmusk', 'https://x.com.evil.com/elonmusk', 'https://notx.com/elonmusk', 'https://user:pw@x.com/elonmusk', 'https://x.com:8443/elonmusk', 'ftp://x.com/elonmusk', 'javascript:alert(1)', 'https://x.com/elon musk', 'https://x.com/ünicode', '123456789012345678901', 'x'.repeat(201), null, undefined, 12345, {}, ['x']];
  check('A01 accepted forms: @name, name, x.com / twitter.com URLs (incl. www, mobile, trailing path/query), numeric id, /i/user/<id>, intent/user?user_id=', cases.every(([i, want]) => same(P(i), want)), JSON.stringify(cases.filter(([i, want]) => !same(P(i), want)).map(([i]) => i)));
  check('A02 rejected: reserved product paths, other hosts / look-alikes, credentials, ports, other schemes, malformed names, empty / oversize / non-strings', bad.filter((i) => P(i) !== null).length === 0, JSON.stringify(bad.filter((i) => P(i) !== null).map((i) => [i, P(i)])));
  check('A03 "@123" is a USERNAME (all-digit names exist) while a bare "123" is an id; a URL path of digits is a username; digit strings that are not valid ids ("0", leading zero) can only be usernames', same(P('@123'), u('123')) && same(P('123'), id('123')) && same(P('x.com/123'), u('123')) && same(P('0'), u('0')) && same(P('012345'), u('012345')));
  check('A04 ids stay strings (no Number() anywhere): a 20-digit id parses exactly', P(BIG2).value === BIG2 && typeof P(BIG2).value === 'string' && P(BIG).value === BIG);
  check('A05 userOf: id must be a STRING of the id shape; numbers (already lossy), leading zeros, blanks are refused', Xc.userOf({ id: BIG, username: 'a' }).externalId === BIG && Xc.userOf({ id: 9007199254740993, username: 'a' }) === null && Xc.userOf({ id: '0123', username: 'a' }) === null && Xc.userOf({ id: '', username: 'a' }) === null && Xc.userOf({ id: '12a' }) === null && Xc.userOf(null) === null && Xc.userOf([]) === null && Xc.userOf({ id: '1'.repeat(21) }) === null);
  const w = Xc.userOf({ id: '5', username: 'ok_1', name: 'N', profile_image_url: 'http://insecure/a.png', public_metrics: { followers_count: 12.5 } });
  const w2 = Xc.userOf({ id: '5', username: 'bad name', name: 7, profile_image_url: 'https://pbs.twimg.com/a.jpg', public_metrics: { followers_count: -1 } });
  const w3 = Xc.userOf({ id: '5', username: 'ok', public_metrics: { followers_count: '99' } });
  check('A06 userOf display metadata is sanitised: non-https avatar dropped, bad username blanked, non-integer / negative / string follower counts become null', w.avatarUrl === '' && w.followerCount === null && w.handle === '@ok_1' && w2.handle === '' && w2.title === '' && w2.avatarUrl.startsWith('https://') && w2.followerCount === null && w3.followerCount === null && Xc.userOf({ id: '5', username: 'ok', public_metrics: { followers_count: 0 } }).followerCount === 0);
}

// ============================================================================================ B. PKCE + authorize URL
{
  check('B01 RFC 7636 Appendix B vector: S256 challenge of the sample verifier', Xc.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const s1 = 'e1.state.0xabc.1.deadbeef.cafe', s2 = 'e1.state.0xabc.1.deadbef0.cafe';
  const v1 = Xc.deriveVerifier(SESSION_KEY, s1);
  check('B02 derived verifier: 43 unreserved chars (RFC 7636), deterministic per state, different per state, different per secret, never the state or its hash', /^[A-Za-z0-9_-]{43}$/.test(v1) && v1 === Xc.deriveVerifier(SESSION_KEY, s1) && v1 !== Xc.deriveVerifier(SESSION_KEY, s2) && v1 !== Xc.deriveVerifier(SESSION_KEY + 'x', s1) && v1 !== s1 && v1 !== crypto.createHash('sha256').update(s1).digest('base64url') && v1 !== crypto.createHmac('sha256', SESSION_KEY).update(s1).digest('base64url'));
  check('B03 deriveVerifier refuses a weak secret or empty state', (() => { try { Xc.deriveVerifier('short', s1); return false; } catch { try { Xc.deriveVerifier(SESSION_KEY, ''); return false; } catch { return true; } } })());
  const x = Xc.makeX({ clientId: CLIENT_ID, clientSecret: SECRET, redirect: REDIRECT });
  const url = new URL(x.authUrl(s1, Xc.pkceChallenge(v1)));
  const q = url.searchParams;
  check('B04 authorize URL: x.com/i/oauth2/authorize, code flow, exact client id + redirect URI, PKCE S256 with the derived challenge, our state, and NOTHING else', url.origin + url.pathname === 'https://x.com/i/oauth2/authorize' && same([...q.keys()].sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state']) && q.get('response_type') === 'code' && q.get('client_id') === CLIENT_ID && q.get('redirect_uri') === REDIRECT && q.get('code_challenge_method') === 'S256' && q.get('code_challenge') === Xc.pkceChallenge(v1) && q.get('state') === s1);
  check('B05 the scopes requested are EXACTLY "tweet.read users.read": those two, in that order, no others (no tweet.write, offline.access, follows.read, like, DM or any other scope)', q.get('scope') === 'tweet.read users.read' && Xc.OAUTH_SCOPE === 'tweet.read users.read' && same(Xc.OAUTH_SCOPES, ['tweet.read', 'users.read']) && Object.isFrozen(Xc.OAUTH_SCOPES) && same(q.get('scope').split(' ').slice().sort(), ['tweet.read', 'users.read']) && !/offline\.access|tweet\.write|tweet\.moderate|follows|like\.|dm\.|bookmark|mute|block|list\.|space\.|users\.email/.test(url.search));
  check('B06 authUrl refuses a missing / malformed challenge (never "plain", never absent) and an unconfigured client', (() => { const t = (f) => { try { f(); return false; } catch (e) { return e.code === 'not_configured'; } }; return t(() => x.authUrl(s1)) && t(() => x.authUrl(s1, 'short')) && t(() => x.authUrl(s1, v1 + 'x')) && t(() => Xc.makeX({}).authUrl(s1, Xc.pkceChallenge(v1))); })());
}

// ============================================================================================ C. the HTTP client
{
  fresh();
  const x = Xc.makeX({ fetch: fakeFetch, bearer: BEARER, clientId: CLIENT_ID, clientSecret: SECRET, redirect: REDIRECT, timeoutMs: 300 });
  const verifier = Xc.deriveVerifier(SESSION_KEY, 'state-1');
  const grant = (userId, scope = 'tweet.read users.read') => { const code = 'authcode-' + crypto.randomBytes(8).toString('hex'); X.codes.set(code, { challenge: Xc.pkceChallenge(verifier), redirect_uri: REDIRECT, userId, scope }); return code; };
  const tok = await x.exchangeCode(grant(BIG), verifier);
  const tc = callsTo((c) => c.path === '/2/oauth2/token')[0];
  const body = new URLSearchParams(tc.body);
  check('C01 token exchange: POST api.x.com/2/oauth2/token, form-encoded, confidential-client Basic auth, code + grant_type + EXACT redirect_uri + code_verifier', tc.method === 'POST' && tc.host === 'api.x.com' && tc.ct === 'application/x-www-form-urlencoded' && tc.auth === 'Basic ' + Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64') && body.get('grant_type') === 'authorization_code' && body.get('redirect_uri') === REDIRECT && body.get('code_verifier') === verifier && Boolean(body.get('code')) && typeof tok === 'string');
  check('C02 the client secret travels ONLY in the Basic header (never in the body, query or URL)', !tc.body.includes(SECRET) && !tc.search.includes(SECRET) && !body.has('client_secret') && tc.redirect === 'error');
  const me = await x.me(tok);
  const mc = callsTo((c) => c.path === '/2/users/me')[0];
  check('C03 GET api.x.com/2/users/me with the USER token as Bearer, asking for id,name,username,profile_image_url,public_metrics,protected', mc.method === 'GET' && mc.auth === 'Bearer ' + tok && new URLSearchParams(mc.search).get('user.fields') === Xc.USER_FIELDS && Xc.USER_FIELDS === 'id,name,username,profile_image_url,public_metrics,protected' && mc.redirect === 'error');
  check('C04 an id above 2^53 survives as an exact STRING end to end (not rounded, not a number)', me.externalId === BIG && typeof me.externalId === 'string' && String(Number(BIG)) !== BIG && me.followerCount === 12400 && me.handle === '@alice_x' && me.title === 'Alice (X)');
  const wrongV = grant(BIG);
  const e1 = await x.exchangeCode(wrongV, Xc.deriveVerifier(SESSION_KEY, 'state-2')).catch((e) => e);
  check('C05 a wrong PKCE verifier is rejected by X (the code is bound to the challenge) -> fixed code "denied"', e1 && e1.code === 'denied');
  const e2 = await Xc.makeX({ fetch: fakeFetch, clientId: CLIENT_ID, clientSecret: SECRET, redirect: 'https://other.example/api/early-x-auth' }).exchangeCode(grant(BIG), verifier).catch((e) => e);
  check('C06 a different redirect URI is rejected by X (exact match) -> "denied"', e2 && e2.code === 'denied');
  const e3 = await x.exchangeCode(grant(BIG, 'tweet.read'), verifier).catch((e) => e);
  const e3a = await x.exchangeCode(grant(BIG, 'users.read'), verifier).catch((e) => e);
  const e3n = await x.exchangeCode(grant(BIG, 'follows.read'), verifier).catch((e) => e);
  const e3b = await x.exchangeCode(grant(BIG, 'users.read tweet.read'), verifier).catch((e) => e);
  check('C07 a grant missing EITHER tweet.read or users.read (or neither) is refused ("scope"); both, in any order, are accepted', e3 && e3.code === 'scope' && e3a && e3a.code === 'scope' && e3n && e3n.code === 'scope' && typeof e3b === 'string');
  X.refresh = true;
  const withRefresh = await x.exchangeCode(grant(BIG), verifier);
  X.refresh = false;
  check('C08 a refresh_token (never requested) is ignored: only the access token string is returned', typeof withRefresh === 'string' && !withRefresh.includes('xrt-'));
  const used = grant(BIG); await x.exchangeCode(used, verifier);
  check('C09 an authorization code is single-use at X; reuse -> "denied"', (await x.exchangeCode(used, verifier).catch((e) => e)).code === 'denied');
  const badSecret = await Xc.makeX({ fetch: fakeFetch, clientId: CLIENT_ID, clientSecret: 'nope', redirect: REDIRECT }).exchangeCode(grant(BIG), verifier).catch((e) => e);
  check('C10 bad client credentials -> "denied"; missing config / malformed code / malformed verifier are refused before any request', badSecret.code === 'denied' && (await Xc.makeX({ fetch: fakeFetch }).exchangeCode(grant(BIG), verifier).catch((e) => e)).code === 'not_configured' && (await x.exchangeCode('short', verifier).catch((e) => e)).code === 'denied' && (await x.exchangeCode(grant(BIG), 'tooshort').catch((e) => e)).code === 'not_configured' && (await x.exchangeCode(undefined, verifier).catch((e) => e)).code === 'denied');
  // ---- fail-closed on malformed API answers
  const mal = async (raw, fn) => { X.override = (u, init) => (u.pathname === '/2/users/me' || u.pathname.startsWith('/2/users') ? resp(200, raw) : null); try { return await fn(); } catch (e) { return e; } finally { X.override = null; } };
  const meTok = 'xat-manual'; X.tokens.set(meTok, BIG);
  const malformed = [
    '{"data":{"id":9007199254740993,"username":"alice_x"}}', '{"data":{"id":"0123","username":"a"}}', '{"data":{"id":"","username":"a"}}', '{"data":{}}', '{"data":[]}', '{"data":"x"}', '{}', '[]', 'not json', '{"errors":[{"title":"x"}]}', '{"data":null}',
  ];
  const meResults = []; for (const raw of malformed) meResults.push([raw, await mal(raw, () => x.me(meTok))]);
  check('C11 /users/me: numeric ids, bad ids, missing / odd "data", non-JSON, errors-only -> XError "malformed" (never an identity)', meResults.every(([, r]) => r instanceof Xc.XError && r.code === 'malformed'), JSON.stringify(meResults.filter(([, r]) => !(r instanceof Xc.XError && r.code === 'malformed')).map(([raw, r]) => [raw, r && r.code])));
  check('C12 /users/me with no token or a rejected token fails closed', (await x.me('').catch((e) => e)).code === 'denied' && (await x.me('xat-unknown').catch((e) => e)).code === 'denied');
  // ---- resolver
  const r1 = await x.resolve('@Alice_X'), r2 = await x.resolve('https://twitter.com/alice_x'), r3 = await x.resolve(BIG);
  const rc = callsTo((c) => c.path.startsWith('/2/users/by/username/') || c.path === '/2/users/' + BIG);
  check('C13 resolve: username / URL / id -> the immutable numeric id as a string + current display metadata; app-only Bearer; username lookup path /2/users/by/username/<name>', r1.externalId === BIG && r2.externalId === BIG && r3.externalId === BIG && r1.handle === '@alice_x' && rc.length === 3 && rc[0].path === '/2/users/by/username/Alice_X' && rc.every((c) => c.auth === 'Bearer ' + BEARER && c.method === 'GET'));
  check('C14 resolve: unknown account (errors, no data) -> null; unparseable / reserved input -> null with NO request', await x.resolve('doesnotexist') === null && await x.resolve('https://x.com/home') === null && await x.resolve('') === null && callsTo((c) => c.path.includes('home')).length === 0);
  X.override = (u) => (u.pathname.startsWith('/2/users/by/username/') ? resp(200, { data: X.users.get('1234567890') }) : null);
  const mism = await x.resolve('alice_x').catch((e) => e);
  X.override = (u) => (u.pathname === '/2/users/' + BIG ? resp(200, { data: X.users.get('1234567890') }) : null);
  const mism2 = await x.resolve(BIG).catch((e) => e);
  X.override = null;
  check('C15 resolve: an answer for a DIFFERENT username / id than asked is malformed (fail closed)', mism instanceof Xc.XError && mism.code === 'malformed' && mism2 instanceof Xc.XError && mism2.code === 'malformed');
  // ---- batch lookup
  const many = await x.usersById([BIG, '1234567890', '999999999', BIG, 'abc', '0123', 5, null]);
  const bc = callsTo((c) => c.path === '/2/users').slice(-1)[0];
  check('C16 usersById: ids filtered / de-duplicated before the request, capped at 100, Map keyed by exact string id, public_metrics requested; unknown ids are simply absent', many instanceof Map && many.size === 2 && many.get(BIG).followerCount === 12400 && many.get('1234567890').followerCount === 15 && bc.search.includes('ids=' + BIG + '%2C1234567890') && !bc.search.includes('abc') && new URLSearchParams(bc.search).get('user.fields').includes('public_metrics'));
  const hundred = Array.from({ length: 150 }, (_, i) => String(1000 + i));
  await x.usersById(hundred);
  check('C17 usersById sends at most 100 ids per request', new URLSearchParams(callsTo((c) => c.path === '/2/users').slice(-1)[0].search).get('ids').split(',').length === 100 && (await x.usersById([])).size === 0);
  X.override = (u) => (u.pathname === '/2/users' ? resp(200, { data: [{ id: BIG, username: 'alice_x', public_metrics: { followers_count: 5 } }, { id: 5, username: 'num' }, { id: '8888', username: 'stranger', public_metrics: { followers_count: 1 } }, null, 'x'] }) : null);
  const filt = await x.usersById([BIG, '1234567890']);
  X.override = (u) => (u.pathname === '/2/users' ? resp(200, { data: 'oops' }) : null);
  const nolist = await x.usersById([BIG]).catch((e) => e);
  X.override = (u) => (u.pathname === '/2/users' ? resp(200, { meta: {} }) : null);
  const nodata = await x.usersById([BIG]).catch((e) => e);
  X.override = null;
  check('C18 usersById: malformed members are dropped, ids we did not ask for are dropped, "data" that is not a list or an answer with neither data nor errors -> malformed', filt.size === 1 && filt.get(BIG).followerCount === 5 && nolist.code === 'malformed' && nodata.code === 'malformed');
  X.mode = 'ratelimit'; const rl = await x.resolve('alice_x').catch((e) => e);
  X.mode = 'down'; const dn = await x.resolve('alice_x').catch((e) => e);
  X.mode = 'hang'; const t0 = Date.now(); const hg = await x.resolve('alice_x').catch((e) => e); const dt = Date.now() - t0;
  X.mode = 'ok';
  check('C19 429 -> rate_limited (with Retry-After), 5xx -> unavailable, a hung request is aborted by the hard timeout -> unavailable; nothing retried', rl.code === 'rate_limited' && rl.retryAfter === 30 && dn.code === 'unavailable' && hg.code === 'unavailable' && dt < 1500);
  const appless = await Xc.makeX({ fetch: fakeFetch }).resolve('alice_x').catch((e) => e);
  check('C20 no app-only bearer configured -> not_configured (no request made)', appless.code === 'not_configured');
}

// ============================================================================================ D. OAuth function end to end
{
  fresh(); clock.advance(0);
  const l = await creatorLink(W.creator, 'x');
  const state = stateOf(l);
  check('D01 creator-link platform=x returns the X start URL and scopes "tweet.read users.read"; the state is bound to platform x', l.s === 200 && l.j.startUrl.startsWith('/api/early-x-auth?start=') && l.j.scope === 'tweet.read users.read' && Session.verify(state, { scope: 'state', now: () => clock.now(), env: XENV }).platform === 'x' && state.split('.')[2] === W.creator + '~x', l.body);
  const start = await authCall({ start: state });
  const au = new URL(start.headers.location), aq = au.searchParams;
  const expectedChallenge = Xc.pkceChallenge(Xc.deriveVerifier(SESSION_KEY, state));
  check('D02 start -> 302 to x.com authorize with PKCE S256 whose challenge derives from THIS state (verifier never leaves the server), exact redirect URI, scopes tweet.read users.read ONLY', start.s === 302 && au.origin + au.pathname === 'https://x.com/i/oauth2/authorize' && aq.get('code_challenge') === expectedChallenge && aq.get('code_challenge_method') === 'S256' && aq.get('redirect_uri') === REDIRECT && aq.get('scope') === 'tweet.read users.read' && aq.get('state') === state && !start.headers.location.includes(Xc.deriveVerifier(SESSION_KEY, state)), start.headers.location);
  const c1 = consent(start.headers.location, BIG);
  const callsBefore = X.calls.length;
  const cb = await authCall({ code: c1.code, state: c1.state, code_verifier: 'attacker-chosen-verifier-0123456789abcdefghijklmnop', redirect_uri: 'https://evil.example/cb', redirect: 'https://evil.example', next: '//evil.example', returnTo: 'https://evil.example' });
  const tok = decodeURIComponent((cb.headers.location || '').split('#s=')[1] || '');
  const sv = Session.verify(tok, { scope: 'creator', now: () => clock.now(), env: XENV });
  const newCalls = X.calls.slice(callsBefore);
  const tokenCall = newCalls.find((c) => c.path === '/2/oauth2/token'), meCall = newCalls.find((c) => c.path === '/2/users/me');
  const tbody = new URLSearchParams(tokenCall.body);
  check('D03 callback -> 302 to the FIXED creator page with a session fragment; a browser-supplied code_verifier / redirect_uri / redirect / next / returnTo is ignored (X verified the SERVER-derived verifier and the configured redirect)', cb.s === 302 && cb.headers.location.startsWith('/labs/early/creator#s=') && !cb.headers.location.includes('evil') && tbody.get('code_verifier') === Xc.deriveVerifier(SESSION_KEY, state) && tbody.get('redirect_uri') === REDIRECT && !tokenCall.body.includes('attacker') && !tokenCall.body.includes('evil'), cb.headers.location);
  check('D04 the creator session is bound to (x, numeric externalId as an exact string, wallet) from the AUTHENTICATED /2/users/me; subject spelling x_<id>~<wallet>', sv && sv.platform === 'x' && sv.externalId === BIG && typeof sv.externalId === 'string' && sv.wallet === W.creator && tok.split('.')[2] === 'x_' + BIG + '~' + W.creator && meCall && meCall.auth.startsWith('Bearer xat-'));
  const linkRec = JSON.parse(MAP.get('early:oauth:v1:' + tok.split('.')[4]).value);
  check('D05 link record: platform x, channelId (v1 name of the external id) = the numeric id string, wallet, display metadata, follower count read at that moment, scope "tweet.read users.read"; NO username as identity field', linkRec.platform === 'x' && linkRec.channelId === BIG && linkRec.wallet === W.creator && linkRec.title === 'Alice (X)' && linkRec.handle === '@alice_x' && linkRec.followerCount === 12400 && linkRec.scope === 'tweet.read users.read' && linkRec.avatarUrl.startsWith('https://') && !('username' in linkRec) && Number.isInteger(linkRec.at));
  const everything = JSON.stringify([...MAP.entries()].map(([k, e]) => [k, e.type === 'set' ? [...e.value] : e.type === 'zset' ? [...e.value] : e.value])) + '\n' + LOG.join('\n') + '\n' + cb.body + start.body + l.body;
  const accessTokens = [...X.tokens.keys()];
  const verifierNow = Xc.deriveVerifier(SESSION_KEY, state);
  check('D06 NOTHING secret is persisted, logged or returned: no access token, client secret, bearer, authorization code or PKCE verifier appears in the store, the logs or any response body', accessTokens.length >= 1 && ![...accessTokens, SECRET, BEARER, c1.code, verifierNow, 'attacker-chosen'].some((s) => everything.includes(s)) && !everything.includes(Buffer.from(CLIENT_ID + ':' + SECRET).toString('base64')));
  check('D07 exactly one token exchange and one /users/me per login; the discarded token is never reused', newCalls.filter((c) => c.path === '/2/oauth2/token').length === 1 && newCalls.filter((c) => c.path === '/2/users/me').length === 1 && newCalls.length === 2);
  // single use
  const again = await authCall({ code: c1.code, state: c1.state });
  check('D08 the state is SINGLE USE: replaying the same callback -> #e=state and no provider call', again.s === 302 && again.headers.location === '/labs/early/creator#e=state' && X.calls.length === callsBefore + 2);
  const stateKey = 'early:oauth-state:v1:' + Session.verify(state, { scope: 'state', now: () => clock.now(), env: XENV }).sid;
  check('D09 the consumed state nonce is recorded (atomic single-use marker)', MAP.has(stateKey));
  // wrong platform / tampered / expired / missing
  const yl = await creatorLink(W.creator, 'youtube');
  const yState = stateOf(yl);
  const n0 = X.calls.length;
  const wp1 = await authCall({ start: yState }), wp2 = await authCall({ code: 'authcode-0123456789abcd', state: yState });
  check('D10 a YouTube-bound state is refused by the X function (start and callback): #e=state, no provider call', wp1.headers.location === '/labs/early/creator#e=state' && wp2.headers.location === '/labs/early/creator#e=state' && X.calls.length === n0);
  const ytWithX = await ytAuthCall({ start: state }), ytWithX2 = await ytAuthCall({ code: 'code-0123456789abcdef', state });
  check('D11 and an X-bound state is refused by the YouTube function', ytWithX.headers.location === '/labs/early/creator#e=state' && ytWithX2.headers.location === '/labs/early/creator#e=state');
  const l2 = await creatorLink(W.creator, 'x'), st2 = stateOf(l2);
  const parts = st2.split('.'); parts[5] = parts[5].replace(/.$/, (c) => (c === '0' ? '1' : '0'));
  const tam = await authCall({ start: parts.join('.') }), tam2 = await authCall({ code: 'authcode-0123456789abcd', state: parts.join('.') });
  check('D12 a tampered state is refused (start and callback)', tam.headers.location.endsWith('#e=state') && tam2.headers.location.endsWith('#e=state'));
  const l3 = await creatorLink(W.creator, 'x'), st3 = stateOf(l3);
  const s3 = await authCall({ start: st3 }); const c3 = consent(s3.headers.location, BIG);
  clock.advance(11 * 60);
  const n1 = X.calls.length;
  const exp = await authCall({ code: c3.code, state: st3 });
  check('D13 an expired state (10 min TTL preserved) is refused and X is not called', exp.headers.location.endsWith('#e=state') && X.calls.length === n1);
  const miss = await authCall({ code: 'authcode-0123456789abcd' }), miss2 = await authCall({ state: st3 }), miss3 = await authCall({}), den = await authCall({ error: 'access_denied', state: st3 });
  check('D14 missing code/state -> #e=state; provider error=access_denied -> #e=denied; neither calls X', miss.headers.location.endsWith('#e=state') && miss2.headers.location.endsWith('#e=state') && miss3.headers.location.endsWith('#e=state') && den.headers.location.endsWith('#e=denied') && X.calls.length === n1);
  // provider failures map to fixed codes
  const bad = async (override, wantCode, label) => {
    const l = await creatorLink(W.creator, 'x'), st = stateOf(l), s = await authCall({ start: st }), c = consent(s.headers.location, BIG);
    X.override = override; const r = await authCall({ code: c.code, state: st }); X.override = null;
    return [label, r.headers.location === '/labs/early/creator#e=' + wantCode, r.headers.location];
  };
  const prov = [
    await bad((u) => (u.pathname === '/2/oauth2/token' ? resp(400, { error: 'invalid_grant' }) : null), 'denied', 'token 400'),
    await bad((u) => (u.pathname === '/2/oauth2/token' ? resp(503, {}) : null), 'unavailable', 'token 503'),
    await bad((u) => (u.pathname === '/2/oauth2/token' ? resp(200, { token_type: 'bearer', access_token: 'xat-q', scope: 'tweet.read' }) : null), 'denied', 'scope without users.read'),
    await bad((u) => (u.pathname === '/2/oauth2/token' ? resp(200, { token_type: 'bearer', access_token: 'xat-q', scope: 'users.read' }) : null), 'denied', 'scope without tweet.read'),
    await bad((u) => (u.pathname === '/2/oauth2/token' ? resp(200, { token_type: 'mac', access_token: 'xat-q', scope: 'tweet.read users.read' }) : null), 'denied', 'non-bearer token'),
    await bad((u) => (u.pathname === '/2/oauth2/token' ? resp(200, { token_type: 'bearer', scope: 'tweet.read users.read' }) : null), 'denied', 'no access token'),
    await bad((u) => (u.pathname === '/2/users/me' ? resp(200, { data: { id: 9007199254740993, username: 'x' } }) : null), 'unavailable', '/me numeric id'),
    await bad((u) => (u.pathname === '/2/users/me' ? resp(200, { data: { id: '0', username: 'x' } }) : null), 'unavailable', '/me id 0'),
    await bad((u) => (u.pathname === '/2/users/me' ? resp(200, {}) : null), 'unavailable', '/me empty'),
    await bad((u) => (u.pathname === '/2/users/me' ? resp(401, {}) : null), 'denied', '/me 401'),
    await bad((u) => (u.pathname === '/2/users/me' ? resp(429, {}) : null), 'unavailable', '/me 429'),
  ];
  check('D15 provider failures and malformed answers fail closed with FIXED codes (no detail leaks); no session is issued', prov.every(([, ok]) => ok), JSON.stringify(prov.filter(([, ok]) => !ok)));
  check('D16 every outcome above redirected only to the fixed creator page (no open redirect)', LOG.length >= 0 && [cb, again, wp1, wp2, tam, exp, miss, den].every((r) => r.s === 302 && r.headers.location.startsWith('/labs/early/creator#') && !r.headers.location.includes('//')));
  // no logs of secrets across the ENTIRE suite so far
  const logs = LOG.join('\n');
  check('D17 logs across the whole OAuth section never contain a token, the secret, the bearer, a code or a verifier (only hashed ids and fixed codes)', ![SECRET, BEARER, 'xat-', 'authcode-', 'attacker-chosen', Xc.deriveVerifier(SESSION_KEY, state), Xc.deriveVerifier(SESSION_KEY, st3)].some((s) => logs.includes(s)) && logs.includes('early-x-auth'));
  // rate limit per IP preserved
  const sameIp = '203.0.113.99'; const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await authCall({ start: 'bogus' }, { ip: sameIp })).s);
  check('D18 per-IP limits are preserved on the X function (5 / minute)', codes.slice(0, 5).every((s) => s === 302) && codes[5] === 429 && codes[6] === 429, codes.join());
  // global spend guard
  fresh();
  const bud = { ...X_BUDGET, oauthPerDay: 1 };
  const lA = await creatorLink(W.creator, 'x'), sA = stateOf(lA), stA = await authCall({ start: sA }, { xBudget: bud }), cA = consent(stA.headers.location, BIG);
  const lB = await creatorLink(W.creator2, 'x'), sB = stateOf(lB), stB = await authCall({ start: sB }, { xBudget: bud }), cB = consent(stB.headers.location, '1234567890');
  const okA = await authCall({ code: cA.code, state: sA }, { xBudget: bud });
  const nBefore = X.calls.length;
  const noB = await authCall({ code: cB.code, state: sB }, { xBudget: bud });
  check('D19 global daily budget: the (N+1)th login in a day is refused BEFORE any API call and WITHOUT consuming its single-use state', okA.headers.location.startsWith('/labs/early/creator#s=') && noB.headers.location === '/labs/early/creator#e=unavailable' && X.calls.length === nBefore && !MAP.has('early:oauth-state:v1:' + Session.verify(sB, { scope: 'state', now: () => clock.now(), env: XENV }).sid));
}

// ============================================================================================ E. resolver
{
  fresh();
  const big = { ...X_BUDGET, resolvePerHour: 1000, resolvePerDay: 1000 };
  const rs = (q, extra = {}, over = {}) => get('resolve', { platform: 'x', q, ...extra }, { xBudget: big, ...over });
  const a = await rs('@Alice_X');
  const apiCalls = () => callsTo((c) => c.path.startsWith('/2/users')).length;
  check('E01 @username -> immutable numeric id (string) + current display metadata; username is NOT part of the identity fields', a.s === 200 && a.j.platform === 'x' && a.j.externalId === BIG && a.j.title === 'Alice (X)' && a.j.handle === '@alice_x' && a.j.avatarUrl.startsWith('https://') && a.j.cached === false && !('channelId' in a.j) && !('username' in a.j) && !('followerCount' in a.j), a.body);
  const n0 = apiCalls();
  const forms = ['alice_x', 'https://x.com/alice_x', 'https://twitter.com/Alice_X/', BIG];
  const rr = []; for (const f of forms) rr.push(await rs(f));
  check('E02 username / x.com URL / twitter.com URL / numeric id all resolve to the same immutable id', rr.every((r) => r.s === 200 && r.j.externalId === BIG), rr.map((r) => r.s).join());
  check('E03 cache: the same account (any spelling of the username) is served from cache with no new API call; the id spelling is cached separately', rr[0].j.cached === true && rr[1].j.cached === true && rr[2].j.cached === true && apiCalls() === n0 + 1, apiCalls() - n0 + ' new calls');
  const cacheKeys = [...MAP.keys()].filter((k) => k.startsWith('early:x:resolve:v1:'));
  check('E04 cache entries are keyed by a hash of the normalised input and hold {externalId, title, handle, avatarUrl} for 1 h only', cacheKeys.length === 2 && cacheKeys.every((k) => /^early:x:resolve:v1:[0-9a-f]{64}$/.test(k) && MAP.get(k).expiresAt - clock.now() <= 3600000 && same(Object.keys(JSON.parse(MAP.get(k).value)).sort(), ['avatarUrl', 'externalId', 'handle', 'title'])));
  const n1 = apiCalls();
  const rv = []; for (const p of ['https://x.com/home', 'https://x.com/explore', 'https://x.com/i/flow/login', 'https://x.com/settings', 'https://x.com/search?q=a', '@bad-name', 'a.b', 'https://evil.com/alice_x']) rv.push(await rs(p));
  check('E05 reserved / non-user paths and junk input -> 400, and X is NOT called', rv.every((r) => r.s === 400) && apiCalls() === n1, rv.map((r) => r.s).join());
  const nf = await rs('doesnotexist'), nf2 = await rs('doesnotexist');
  check('E06 unknown account -> 404 (a miss is not cached, never invented)', nf.s === 404 && nf2.s === 404 && !('externalId' in nf.j));
  const spoof = await get('resolve', { platform: 'x', q: '@someone', yt: 'https://youtube.com/@x' }, { xBudget: big });
  check('E07 the platform parameter decides: platform=x never reaches the YouTube resolver', spoof.s !== 200 || spoof.j.platform === 'x');
  const mal = async (raw, label) => { X.override = (u) => (u.pathname.startsWith('/2/users') ? resp(200, raw) : null); const r = await rs('mallory_' + label); X.override = null; return r; };
  const bads = [await mal('{"data":{"id":9007199254740993,"username":"mallory_a"}}', 'a'), await mal('{"data":{"id":"abc","username":"mallory_b"}}', 'b'), await mal('<html>', 'c'), await mal('{"data":{"id":"5","username":"someone_else"}}', 'd'), await mal('{"meta":{}}', 'e')];
  check('E08 malformed / mismatched API answers fail closed -> 503, nothing cached, no identity returned', bads.every((r) => r.s === 503 && !('externalId' in r.j)) && [...MAP.keys()].filter((k) => k.startsWith('early:x:resolve:v1:')).length === cacheKeys.length, bads.map((r) => r.s).join());
  X.mode = 'down'; const dn = await rs('bob'); X.mode = 'ratelimit'; const rl429 = await rs('bob'); X.mode = 'ok';
  check('E09 X outage / X rate limit -> 503 "could not be reached", nothing cached', dn.s === 503 && rl429.s === 503 && !MAP.has([...MAP.keys()].find((k) => k.startsWith('early:x:resolve:v1:') && !cacheKeys.includes(k)) || '-'));
  // per-IP limit preserved
  const ipFixed = '203.0.113.200'; const sts = [];
  for (let i = 0; i < 22; i++) sts.push((await get('resolve', { platform: 'x', q: '@bob' }, { ip: ipFixed, xBudget: big })).s);
  check('E10 per-IP limits are preserved (20 / minute): the 21st request from one IP is 429', sts.slice(0, 20).every((s) => s === 200) && sts[20] === 429, sts.join());
  // global budget guard
  fresh();
  const tight = { ...X_BUDGET, resolvePerHour: 2, resolvePerDay: 100 };
  const t1 = await rs('alice_x', {}, { xBudget: tight }), t2 = await rs('bob', {}, { xBudget: tight });
  const nb = apiCalls();
  const t3 = await rs('carol_99', {}, { xBudget: tight }), t4 = await rs('elonmusk', {}, { xBudget: tight }), t3c = await rs('alice_x', {}, { xBudget: tight });
  check('E11 spend guard (hourly): once the allowance of API requests is used, a NEW lookup is refused with 429 BEFORE any X request, while cached answers keep working', t1.s === 200 && t2.s === 200 && t3.s === 429 && t4.s === 429 && apiCalls() === nb && t3c.s === 200 && t3c.j.cached === true && Number(t3.headers['retry-after']) > 0, [t1.s, t2.s, t3.s, t4.s].join());
  fresh();
  const tight2 = { ...X_BUDGET, resolvePerHour: 100, resolvePerDay: 3 };
  const d = []; for (const q of ['alice_x', 'bob', 'carol_99', 'elonmusk', 'business']) d.push((await rs(q, {}, { xBudget: tight2 })).s);
  clock.advance(86400);
  const next = await rs('elonmusk', {}, { xBudget: tight2 });
  check('E12 spend guard (daily): the daily allowance holds across the hour windows and resets with the UTC day', same(d, [200, 200, 200, 429, 429]) && next.s === 200, d.join() + ' ' + next.s);
  check('E13 the shipped defaults are conservative request counts (not currency), and the guard is shared with OAuth / snapshots through one daily bucket family', X_BUDGET.resolvePerDay <= 500 && X_BUDGET.resolvePerHour <= 100 && X_BUDGET.oauthPerDay <= 500 && X_BUDGET.snapshotRequestsPerDay <= 100 && Object.isFrozen(X_BUDGET) && !/\$|usd|price|cost/i.test(JSON.stringify(X_BUDGET)));
  // the resolver with X closed, and YouTube unaffected (including the env-built YouTube client)
  fresh();
  const closed = await get('resolve', { platform: 'x', q: '@alice_x' }, { env: ENV });
  const ytFetch = async (url) => { const u = new URL(String(url)); return u.pathname.endsWith('/channels') ? resp(200, { items: [{ id: CH, snippet: { title: 'Alice', customUrl: '@alice', thumbnails: { default: { url: 'https://yt3.example/a.jpg' } } }, statistics: { subscriberCount: '1', hiddenSubscriberCount: false } }] }) : resp(404, {}); };
  const ytr = await get('resolve', { yt: 'https://youtube.com/@alice' }, { env: ENV, fetch: ytFetch });
  const ytq = await get('resolve', { platform: 'youtube', q: '@alice2' }, { env: XENV, fetch: ytFetch });
  check('E14 X resolver is CLOSED without the flag (400, no API call); the YouTube resolver builds its client from the environment and works (legacy `yt` and platform=youtube&q), with and without X enabled', closed.s === 400 && /Unsupported platform/.test(closed.j.error) && X.calls.length === 0 && ytr.s === 200 && ytr.j.externalId === CH && ytr.j.channelId === CH && ytq.s === 200 && ytq.j.externalId === CH, [closed.s, ytr.s, ytq.s].join() + ytr.body);
}

// ============================================================================================ F. snapshots + receipts
const ytStub = (counts = new Map()) => ({ channelsById: async (ids) => new Map(ids.map((id) => [id, { channelId: id, title: 'Yt Creator', avatarUrl: 'https://yt.example/a.png', handle: '@yt', subscriberCount: counts.get(id) == null ? 777 : counts.get(id), hidden: false }])) });
async function xCreator(id, wallet) {
  const lg = await login(id, wallet);
  const mf = await manifestFor('x', id, wallet, lg.session);
  return { ...lg, mf, creatorId: E.creatorIdOf(id, 'x') };
}
{
  fresh();
  const A = await xCreator(BIG, W.creator);
  check('F01 an X creator activates through the real OAuth link: manifest (platform x, channelId = numeric id string) accepted, creator record + public view carry platform x / externalId; no legacy channelId on the public view', A.mf.r.s === 201 && A.mf.r.j.creator.platform === 'x' && A.mf.r.j.creator.externalId === BIG && !('channelId' in A.mf.r.j.creator) && (await get('creator', { platform: 'x', externalId: BIG })).j.display.handle === '@alice_x', A.mf.r.body);
  const mfRec = JSON.parse(MAP.get('early:manifest:v1:' + A.mf.hash).value);
  const idAtt = JSON.parse(MAP.get('early:att:v1:' + mfRec.identityAttestationId).value);
  check('F02 the creator-identity attestation names platform x and the numeric id as `externalId`, method x-oauth2-pkce tweet.read users.read; no username / handle in it', idAtt.claims.platform === 'x' && idAtt.claims.externalId === BIG && idAtt.subject.externalId === BIG && !('channelId' in idAtt.claims) && idAtt.claims.method === 'x-oauth2-pkce tweet.read users.read GET /2/users/me' && !JSON.stringify(idAtt).includes('alice_x') && mfRec.struct.platform === 'x' && mfRec.struct.channelId === BIG);
  const today = E.utcDate(nowSec());
  const enrol = JSON.parse(MAP.get('early:snap:v1:x:' + BIG + ':' + today).value);
  check('F03 join-day snapshot (from the OAuth link): kind followers, platform x, numeric externalId, follower count, time, source - and NO handleThen / handle / title / avatar / channelId / subscriberCount', same(Object.keys(enrol.claims).sort(), ['audienceKind', 'dateUTC', 'externalId', 'fetchedAt', 'followerCount', 'platform', 'source']) && enrol.claims.audienceKind === 'followers' && enrol.claims.platform === 'x' && enrol.claims.externalId === BIG && enrol.claims.followerCount === 12400 && enrol.claims.source.includes('enrolment') && same(Object.keys(enrol.subject), ['externalId']) && enrol.type === 'audience-snapshot' && !/handle|alice|title|avatar/i.test(JSON.stringify(enrol.claims)));
  // a YouTube creator in the same deployment
  const ys = creatorSession(store, { channelId: CH, wallet: W.creator2 });
  const yM = await manifestFor('youtube', CH, W.creator2, ys);
  check('F04 a YouTube creator activates in the same deployment, unchanged', yM.r.s === 201 && yM.r.j.creator.channelId === CH && yM.r.j.creator.platform === 'youtube');
  // ---- daily job
  clock.advance(86400 + 60);
  const day2 = E.utcDate(nowSec());
  X.users.get(BIG).public_metrics.followers_count = 15000;
  const n0 = callsTo((c) => c.path === '/2/users').length;
  const j1 = await jobCall({ youtube: ytStub() });
  const s1 = JSON.parse(MAP.get('early:snap:v1:x:' + BIG + ':' + day2).value);
  check('F05 daily job: ONE batch call to GET /2/users, an X snapshot with the dated follower count; YouTube snapshotted by its own adapter in the same run; per-platform report', j1.s === 200 && callsTo((c) => c.path === '/2/users').length === n0 + 1 && s1.claims.followerCount === 15000 && s1.claims.audienceKind === 'followers' && s1.claims.fetchedAt === nowSec() && j1.j.report.byPlatform.x.snapshots === 1 && j1.j.report.byPlatform.youtube.snapshots === 1 && j1.j.report.snapshots === 2 && JSON.parse(MAP.get('early:snap:v1:' + CH + ':' + day2).value).claims.subscriberCount === 777, JSON.stringify(j1.j.report));
  X.users.get(BIG).public_metrics.followers_count = 99999;
  const n1 = callsTo((c) => c.path === '/2/users').length;
  const j2 = await jobCall({ youtube: ytStub() });
  const s1b = JSON.parse(MAP.get('early:snap:v1:x:' + BIG + ':' + day2).value);
  check('F06 first success of the UTC day wins: a later run (and a changed count) never replaces it and does not even call X again', s1b.claims.followerCount === 15000 && s1b.id === s1.id && callsTo((c) => c.path === '/2/users').length === n1 && j2.j.report.snapshots === 0);
  X.users.get(BIG).public_metrics.followers_count = 12400;
  const days = [...MAP.get('early:snap-days:v1:x:' + BIG).value].sort();
  check('F07 no backfill: only the join day and the days the job actually ran exist (the skipped days between are absent)', same(days, [today, day2].sort()) && !days.includes(E.utcDate(nowSec() - 86400 * 3)));
  // ---- receipt for the X creator verifies with the EXISTING verifier; wording
  const d = await post({ action: 'intent-draft', manifestHash: A.mf.hash, sender: W.fan, token: USDG, amount: '1500000' });
  const st = await post({ action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) });
  const p = pay({ from: W.fan, to: W.creator, amount: '1500000' }); makeFinal(p.blockNumber);
  const v = await post({ action: 'verify', intentId: d.j.intentId, txHash: p.txHash });
  const doc = (await get('receipt', { intent: d.j.intentId })).j.receipt;
  const ver = await verifyReceipt(doc, { registry: TEST_KEYS_FILE, bundles: {} });
  check('F08 an X receipt is a normal v1 receipt: FINALIZED, creator manifest typed data platform x + channelId = numeric id string, and the EXISTING independent verifier returns RECEIPT VERIFIED (no receipt v2)', v.j.status === 'FINALIZED' && doc.schema === 'syncnet.sync-proof.receipt.v1' && doc.creatorManifest.typedData.message.platform === 'x' && doc.creatorManifest.typedData.message.channelId === BIG && E.sameTypedData('CreatorManifest', doc.creatorManifest.typedData.message, doc.creatorManifest.typedData) && ver.ok && doc.intent.typedData.message.creatorId === E.creatorIdOf(BIG, 'x'), JSON.stringify(ver.checks.filter((c) => !c.ok)));
  const at = doc.context.audienceThen;
  check('F09 the receipt context uses the transfer day\'s snapshot as dated FOLLOWER context; the line reads "Followers on X then: ~12K" - never the generic "Audience then"', at.state === 'approximate' && at.kind === 'followers' && at.value === 15000 && at.display === '~15K' && E.audienceLine({ ...at, display: E.formatAudience(12400) }) === 'Followers on X then: ~12K' && E.audienceLine(at) === 'Followers on X then: ~15K' && !/Audience then/.test(E.audienceLine(at)));
  const attTypes = doc.attestations.map((a) => a.type).sort();
  check('F10 the receipt carries the identity + manifest + audience-snapshot attestations; the snapshot attestation is the follower one', same(attTypes, ['audience-snapshot', 'creator-identity', 'creator-manifest']) && doc.attestations.find((a) => a.type === 'audience-snapshot').claims.audienceKind === 'followers');
  const sm ={ schema: E.SCHEMA.session, wallet: W.fan, issuedAt: nowSec(), nonce: rnd32() };
  const fs1 = (await post({ action: 'session', wallet: W.fan, issuedAt: sm.issuedAt, nonce: sm.nonce, signature: sign('EarlySession', sm, W.fan) })).j.session;
  const card = await post({ action: 'card-create', receiptId: v.j.receiptId }, { session: fs1 });
  const cv = (await get('card', { shareId: card.j.shareId })).j.card;
  check('F11 the public card: platform x identity in separate fields (no legacy creatorChannelId), follower context kind, still private by default', card.s === 201 && cv.creatorPlatform === 'x' && cv.creatorExternalId === BIG && cv.creatorChannelId === null && cv.audienceThen.kind === 'followers' && cv.wallet === null && cv.amount === null && cv.transaction === null);
  // ---- outage / mixed run
  fresh();
  const B = await xCreator(BIG, W.creator);
  const ys2 = creatorSession(store, { channelId: CH, wallet: W.creator2 });
  await manifestFor('youtube', CH, W.creator2, ys2);
  clock.advance(86400 + 60);
  const day = E.utcDate(nowSec());
  X.mode = 'down';
  const jo = await jobCall({ youtube: ytStub() });
  X.mode = 'ok';
  check('F12 X outage: no X snapshot is recorded, the failure is counted for X only, and the YouTube creator in the SAME run is still snapshotted', !MAP.has('early:snap:v1:x:' + BIG + ':' + day) && MAP.has('early:snap:v1:' + CH + ':' + day) && jo.j.report.byPlatform.x.failures === 1 && jo.j.report.byPlatform.youtube.snapshots === 1 && !(jo.j.report.byPlatform.youtube.failures > 0), JSON.stringify(jo.j.report));
  const d2 = await post({ action: 'intent-draft', manifestHash: B.mf.hash, sender: W.fan, token: USDG, amount: '1500000' });
  await post({ action: 'intent-store', intentId: d2.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d2.j.typedData)) });
  const p2 = pay({ from: W.fan, to: W.creator, amount: '1500000' }); makeFinal(p2.blockNumber);
  await post({ action: 'verify', intentId: d2.j.intentId, txHash: p2.txHash });
  const doc2 = (await get('receipt', { intent: d2.j.intentId })).j.receipt;
  check('F13 a receipt for a day with no X snapshot reads "Followers on X then: unavailable" (kind kept, nothing guessed) and still verifies', doc2.context.audienceThen.state === 'unavailable' && doc2.context.audienceThen.kind === 'followers' && E.audienceLine(doc2.context.audienceThen) === 'Followers on X then: unavailable' && (await verifyReceipt(doc2, { registry: TEST_KEYS_FILE, bundles: {} })).ok);
  const jr = await jobCall({ youtube: ytStub() });
  check('F14 the outage is retried within the day and the first X success of that day is then THE snapshot (receipts of that day read it)', jr.j.report.byPlatform.x.snapshots === 1 && MAP.has('early:snap:v1:x:' + BIG + ':' + day) && JSON.parse(MAP.get('early:snap:v1:x:' + BIG + ':' + day).value).claims.followerCount === 12400);
  // ---- other failure shapes
  fresh();
  const C2 = await xCreator('1234567890', W.creator); const C3 = await xCreator(BIG2, W.creator2);
  clock.advance(86400 + 60);
  const day3 = E.utcDate(nowSec());
  X.override = (u) => (u.pathname === '/2/users' ? resp(200, { data: [{ id: '1234567890', username: 'bob' }, { id: BIG2, username: 'carol_99', public_metrics: { followers_count: 5 } }] }) : null);
  const jn = await jobCall({ youtube: ytStub() });
  X.override = null;
  check('F15 a user returned WITHOUT a follower count records nothing (no guess) and is a counted failure; the other user in the batch is still recorded; the 20-digit id is exact', !MAP.has('early:snap:v1:x:1234567890:' + day3) && MAP.has('early:snap:v1:x:' + BIG2 + ':' + day3) && JSON.parse(MAP.get('early:snap:v1:x:' + BIG2 + ':' + day3).value).claims.externalId === BIG2 && jn.j.report.byPlatform.x.failures === 1 && jn.j.report.byPlatform.x.snapshots === 1, JSON.stringify(jn.j.report));
  clock.advance(86400);
  X.override = (u) => (u.pathname === '/2/users' ? resp(200, '{"data":[{"id":1234567890,"username":"bob","public_metrics":{"followers_count":5}}]}') : null);
  const jm = await jobCall({ youtube: ytStub() });
  X.override = null;
  check('F16 an API answer with numeric ids is malformed: nothing recorded, counted as failure, the job still completes', jm.s === 200 && ![...MAP.keys()].some((k) => k.startsWith('early:snap:v1:x:1234567890:' + E.utcDate(nowSec()))) && jm.j.report.byPlatform.x.failures >= 1 && jm.j.report.byPlatform.x.snapshots === 0);
  // ---- budget guard in the job
  fresh();
  await xCreator(BIG, W.creator);
  clock.advance(86400 + 60);
  X.mode = 'down';
  const tight = { ...X_BUDGET, snapshotRequestsPerDay: 2 };
  const calls = []; for (let i = 0; i < 4; i++) { const n = callsTo((c) => c.path === '/2/users').length; const jb = await jobCall({ youtube: ytStub(), xBudget: tight }); calls.push([callsTo((c) => c.path === '/2/users').length - n, Boolean(jb.j.report.budgetExhausted)]); }
  X.mode = 'ok';
  check('F17 spend guard in the job: failing hourly retries stop calling X once the daily request allowance is used (2 attempts, then none), and the run reports budgetExhausted', same(calls, [[1, false], [1, false], [0, true], [0, true]]), JSON.stringify(calls));
  clock.advance(86400);
  const jb2 = await jobCall({ youtube: ytStub(), xBudget: tight });
  check('F18 the allowance resets with the UTC day and the job resumes', jb2.j.report.byPlatform.x.snapshots === 1);
  // ---- flag absent: the job never reads X
  fresh();
  await xCreator(BIG, W.creator);
  clock.advance(86400 + 60);
  const nOff = X.calls.length;
  const jf = await jobCall({ env: ENV, youtube: ytStub() });
  const jf2 = await jobCall({ env: { ...XENV, SYNCNET_EARLY_X_ENABLED: 'false' }, youtube: ytStub() });
  check('F19 with the flag absent or false the job makes NO X request, records nothing for X and does not count X creators as failures (skipped)', X.calls.length === nOff && jf.j.report.noX === true && jf.j.report.snapshotFailures === 0 && jf2.j.report.noX === true && ![...MAP.keys()].some((k) => k.startsWith('early:snap:v1:x:' + BIG + ':' + E.utcDate(nowSec()))));
}

// ============================================================================================ G. feature gate
{
  const cfgOf = (env) => earlyConfig({ env, store: { durable: true }, now: () => clock.now(), keysFile: TEST_KEYS_FILE });
  const without = (k) => { const e = { ...XENV }; delete e[k]; return e; };
  const g = (env) => cfgOf(env).platforms.x.enabled;
  const noFlag = { ...XENV }; delete noFlag.SYNCNET_EARLY_X_ENABLED;
  check('G01 credentials + redirect present but the flag ABSENT -> X is closed', g(noFlag) === false && cfgOf(noFlag).x.configured === true && cfgOf(noFlag).x.requested === false && !platformEnabled(cfgOf(noFlag), 'x'));
  check('G02 flag false / empty / 0 / 1 / yes / "true " variants: only a (case-insensitive, trimmed) "true" opens X', ['false', '', '0', '1', 'yes', 'on', 'enabled', 'tru', 'truee'].every((v) => g({ ...XENV, SYNCNET_EARLY_X_ENABLED: v }) === false) && g({ ...XENV, SYNCNET_EARLY_X_ENABLED: ' TRUE ' }) === true && g({ ...XENV, SYNCNET_EARLY_X_ENABLED: 'true' }) === true);
  const open = cfgOf(XENV);
  check('G03 flag true + the complete configuration -> X is enabled, with OAuth and the resolver available; YouTube unchanged', open.platforms.x.enabled === true && open.platforms.x.oauth === true && open.platforms.x.resolver === true && platformEnabled(open, 'x') && platformEnabled(open, 'youtube') && open.x.missing.length === 0 && open.x.redirect === REDIRECT);
  const missing = ['SYNCNET_X_CLIENT_ID', 'SYNCNET_X_CLIENT_SECRET', 'SYNCNET_X_BEARER_TOKEN', 'SYNCNET_EARLY_X_OAUTH_REDIRECT'];
  check('G04 flag true but ANY ONE required value missing (client id, client secret, bearer, redirect) -> X is closed, and the cause names only the variable, never a value', missing.every((k) => { const c = cfgOf(without(k)); return c.platforms.x.enabled === false && c.x.missing.length === 1 && c.x.missing[0].startsWith(k) && platformEnabled(c, 'youtube'); }) && missing.every((k) => ['', '   '].every((v) => g({ ...XENV, [k]: v }) === false)));
  const badRedirects = ['http://x.example/api/early-x-auth', 'https://x.example/api/early-x-auth/', 'https://x.example/api/early-x-auth?x=1', 'https://x.example/api/early-youtube-auth', 'https://x.example/api/early-x-auth#f', 'https://x.example/other', '/api/early-x-auth', 'https://x.example', 'javascript:alert(1)', 'https://a b.example/api/early-x-auth'];
  check('G05 the redirect must be an https URL ending exactly in /api/early-x-auth (no http, query, fragment, trailing slash, other path)', badRedirects.every((r) => g({ ...XENV, SYNCNET_EARLY_X_OAUTH_REDIRECT: r }) === false) && g({ ...XENV, SYNCNET_EARLY_X_OAUTH_REDIRECT: 'https://deploy-preview-9--amazing-bombolone-579a48.netlify.app/api/early-x-auth' }) === true);
  check('G06 the YouTube configuration is independent of X: YouTube enabled/oauth/resolver identical with X absent, closed or open', [noFlag, XENV, without('SYNCNET_X_CLIENT_ID'), { ...ENV }].every((env) => { const c = cfgOf(env); return c.platforms.youtube.enabled === true && c.platforms.youtube.oauth === true && c.platforms.youtube.resolver === true && same(c.oauth, cfgOf(ENV).oauth); }));
  check('G07 EARLY itself closed (no SYNCNET_EARLY_ENABLED) keeps everything closed regardless of the X flag', (() => { const e = { ...XENV }; delete e.SYNCNET_EARLY_ENABLED; const c = cfgOf(e); return c.enabled === false; })());
  // ---- every X entry point with X closed (credentials present, flag absent / false)
  fresh();
  const variants = { 'flag absent': noFlag, 'flag false': { ...XENV, SYNCNET_EARLY_X_ENABLED: 'false' }, 'missing bearer': without('SYNCNET_X_BEARER_TOKEN'), 'missing secret': without('SYNCNET_X_CLIENT_SECRET') };
  const bad = [];
  for (const [label, env] of Object.entries(variants)) {
    const before = [...MAP.keys()].filter((k) => k.startsWith('early:')).length, nCalls = X.calls.length;
    const l = await creatorLink(W.creator, 'x', env);
    const rs = await get('resolve', { platform: 'x', q: '@alice_x' }, { env });
    const cr = await get('creator', { platform: 'x', externalId: BIG }, { env });
    const m = { schema: E.SCHEMA.countMeIn, platform: 'x', channelId: BIG, fan: W.fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() };
    const cm = await post({ action: 'count-me-in', platform: 'x', externalId: BIG, fan: W.fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sign('CountMeIn', m, W.fan) }, { env });
    const au = await authCall({ start: 'x' }, { env }), au2 = await authCall({ code: 'authcode-0123456789abcd', state: 'x' }, { env });
    const sess = Session.issue({ scope: 'creator', wallet: W.creator, platform: 'x', externalId: BIG, now: () => clock.now(), env });
    const me = await get('me', {}, { env, session: sess });
    const cfgv = (await get('config', {}, { env })).j;
    const ok = l.s === 400 && rs.s === 400 && cr.s === 400 && cm.s === 400 && au.headers.location === '/labs/early/creator#e=closed' && au2.headers.location === '/labs/early/creator#e=closed' && me.s === 401 && !cfgv.platforms.includes('x') && !('x' in (cfgv.platformServices || {})) && X.calls.length === nCalls && [...MAP.keys()].filter((k) => k.startsWith('early:')).length === before;
    if (!ok) bad.push([label, l.s, rs.s, cr.s, cm.s, au.headers.location, me.s, cfgv.platforms]);
  }
  check('G08 with X closed (flag absent / false / a credential missing) EVERY X entry point fails closed: creator-link, resolver, creator view, Count me in, OAuth start + callback, X creator sessions, config; no X request, nothing stored', bad.length === 0, JSON.stringify(bad));
  const ytOk = async (env) => {
    const m = { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId: CH, fan: W.fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() };
    const cm = await post({ action: 'count-me-in', channelId: CH, fan: W.fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sign('CountMeIn', m, W.fan) }, { env });
    const lk = await creatorLink(W.creator, null, env);
    const cv = await get('creator', { channelId: CH }, { env });
    return [cm.s === 201 || cm.s === 200, lk.s === 200 && lk.j.startUrl.startsWith('/api/early-youtube-auth?start='), cv.s === 200];
  };
  const yAll = [];
  for (const env of [ENV, noFlag, { ...XENV, SYNCNET_EARLY_X_ENABLED: 'false' }, without('SYNCNET_X_BEARER_TOKEN'), XENV]) yAll.push((await ytOk(env)).every(Boolean));
  check('G09 YouTube is unaffected in every X configuration: Count me in, creator-link (YouTube start URL) and creator views behave identically with X absent, closed, half-configured and open', yAll.every(Boolean), yAll.join());
  // ---- with X open
  fresh();
  const cfgv = (await get('config', {}, { env: XENV })).j;
  const dump = JSON.stringify(cfgv);
  check('G10 config view with X open lists x with oauth+resolver availability and exposes no credential, secret, client id or redirect', cfgv.platforms.includes('x') && cfgv.platforms.includes('youtube') && cfgv.platformServices.x.oauth === true && cfgv.platformServices.x.resolver === true && ![SECRET, BEARER, CLIENT_ID, REDIRECT, 'deploy-preview'].some((s) => dump.includes(s)));
  const kill = await authCall({ start: 'x' }, { env: { ...XENV, SYNCNET_EARLY_WRITES_DISABLED: 'true' } });
  const killOff = await authCall({ start: 'x' }, { env: { ...XENV, SYNCNET_EARLY_DISABLED: 'true' } });
  check('G11 the EARLY kill switches close the X OAuth function too (writes disabled / EARLY disabled)', kill.headers.location === '/labs/early/creator#e=closed' && killOff.headers.location === '/labs/early/creator#e=closed');
  const weak = await authCall({ start: 'x' }, { env: { ...XENV, SYNCNET_EARLY_SESSION_KEY: 'short' } });
  check('G12 without a strong session secret the X OAuth function answers unavailable (no PKCE can be derived)', weak.headers.location === '/labs/early/creator#e=unavailable');
  check('G13 non-GET methods are refused; only the two documented GET shapes exist', (await authCall({ start: 'x' }, { method: 'POST' })).s === 405 && (await authCall({ start: 'x' }, { method: 'PUT' })).s === 405);
}

// ============================================================================================ H. confinement of X in the code base
{
  const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const xMods = ['netlify/lib/early-x.js', 'netlify/functions/early-x-auth.js'];
  // every log()/logError() call in the X modules: its arguments may mention only fixed error codes (err.code), hashed ids and counters
  const logCalls = xMods.flatMap((p) => text(p).match(/\blog(?:Error)?\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/g) || []);
  const secretish = /token|secret|verifier|bearer|authorization|access_token|SYNCNET_|query\(|(^|[^.\w])code\b(?!:)|\bstate\b(?!:)|\bstart\b/i;
  const offenders = logCalls.filter((c) => secretish.test(c.replace(/err\.code/g, '').replace(/\{ code: err && [^}]*?: 'error'/g, '{ code: X')));
  check('H01 the X modules never log token / secret / code / verifier / bearer / authorization / state values (only fixed error codes, hashed ids and counters), and never use console.*', logCalls.length >= 5 && offenders.length === 0 && xMods.every((p) => !/console\./.test(text(p))), JSON.stringify(offenders));
  const persist = text('netlify/functions/early-x-auth.js');
  check('H02 the OAuth function stores only the link record (no token field) and never writes the client secret, bearer or verifier to the store', !/store\.(set|cas)\([^)]*(token|verifier|SECRET|BEARER)/i.test(persist.replace(/ttlSeconds/g, '')) && !/access_token|refresh_token/.test(persist) && /discarded|never stored/.test(persist));
  const others = ['netlify/functions/early.js', 'netlify/functions/early-snapshot.js', 'netlify/functions/early-youtube-auth.js', 'netlify/lib/early-session.js', 'lib/syncnet-early.js'].map(text).join('\n');
  check('H03 X credentials / env names / hosts appear only in the config, adapter, platform-registry and X OAuth modules - not in the shared server code or the protocol lib', !/SYNCNET_X_|SYNCNET_EARLY_X_|api\.x\.com|x\.com\/i\/oauth2|twitter\.com/.test(others));
  check('H04 the HTML pages contain no X markup or copy at all (X UI is created by script only when the server enables X; see tests/e2e/early-ui-x.mjs); the scripts never name the OAuth function or an X host', !/\bX\b (creator|account|username)|Continue with X|ePlatform|cLinkX|early-x-auth|x\.com|twitter/i.test(text('labs-early.html') + text('labs-early-creator.html')) && !/early-x-auth|api\.x\.com|twitter/i.test(text('labs-early.js') + text('labs-early-creator.js')));
  check('H05 the protocol and the verifier are untouched by X: domain, types, schema strings, matching rule', E.DOMAIN.version === '1' && E.SCHEMA.manifest === 'syncnet.early.creator-manifest.v1' && E.SCHEMA.matching === 'syncnet.sync-proof.matching.v1' && E.TYPES.CreatorManifest.some((f) => f.name === 'channelId') && !text('docs/early/verify-receipt.mjs').includes('x.com'));
}

fs.writeFileSync(path.join(ROOT, 'tests/early/x.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early X checks passed`);
process.exit(failures ? 1 : 0);
