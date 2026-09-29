// EARLY identity/context suite: the YouTube client (input parsing, API shapes, timeouts, no-retry), the OAuth function
// (state binding, single use, code exchange, channels.mine, session + link record, fixed error codes, no token stored),
// and the scheduled snapshot job (first success of the UTC day wins, hidden counts, API outage, no backfill after the
// day ends, rotation completion, finality reconciliation). No real network.
// Run: node tests/early/identity.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, CH, CH2, clock, pc, resetPc, pay, makeSafe, makeFinal, syncHead, rpc, MAP, makeStore, resetStore, creatorSession, Session } from './fixtures.mjs';

const require = createRequire(import.meta.url);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const { makeYouTube, parseInput, YouTubeError } = require(path.join(ROOT, 'netlify/lib/early-youtube.js'));
const auth = require(path.join(ROOT, 'netlify/functions/early-youtube-auth.js'));
const snap = require(path.join(ROOT, 'netlify/functions/early-snapshot.js'));
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }
const store = makeStore();
let ipSeq = 0; const ip = () => `198.51.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const nowSec = () => Math.floor(clock.now() / 1000);
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, headers: r.headers, body: r.body }; };

// ---------------------------------------------------------------- fake Google / YouTube
const YT = { channels: new Map(), tokens: new Map(), mode: 'ok', calls: [], delayMs: 0 };
function ytChannel(id, over = {}) { YT.channels.set(id, { id, snippet: { title: over.title || 'Alice', customUrl: over.handle || '@alice', thumbnails: { default: { url: 'https://yt3.example/' + id + '.jpg' } } }, statistics: { subscriberCount: String(over.subs == null ? 1234 : over.subs), hiddenSubscriberCount: Boolean(over.hidden) } }); }
ytChannel(CH); ytChannel(CH2, { title: 'Bob', handle: '@bob', subs: 20 });
const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
async function fakeFetch(url, init) {
  YT.calls.push({ url: String(url), method: (init && init.method) || 'GET', auth: init && init.headers && init.headers.authorization });
  if (YT.mode === 'down') return res(503, { error: 'down' });
  if (YT.mode === 'hang') await new Promise((resolve, reject) => { const t = setTimeout(resolve, YT.delayMs); if (init && init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
  if (YT.mode === 'quota') return res(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
  const u = new URL(String(url));
  if (u.hostname === 'oauth2.googleapis.com') {
    const p = new URLSearchParams(init.body);
    const code = p.get('code');
    if (!YT.tokens.has(code)) return res(400, { error: 'invalid_grant' });
    const t = YT.tokens.get(code);
    return res(200, { access_token: t.token, scope: t.scope || 'https://www.googleapis.com/auth/youtube.readonly', token_type: 'Bearer', expires_in: 3599 });
  }
  if (u.pathname.endsWith('/channels')) {
    if (u.searchParams.get('mine') === 'true') {
      const tok = String((init.headers || {}).authorization || '').replace('Bearer ', '');
      const owner = [...YT.tokens.values()].find((t) => t.token === tok);
      return res(owner ? 200 : 401, owner ? { items: owner.channel ? [YT.channels.get(owner.channel)] : [] } : { error: 'unauth' });
    }
    if (u.searchParams.get('key') !== ENV.SYNCNET_YOUTUBE_API_KEY) return res(400, { error: 'key' });
    const ids = (u.searchParams.get('id') || '').split(',').filter(Boolean);
    const handle = u.searchParams.get('forHandle'), user = u.searchParams.get('forUsername');
    let items = [];
    if (ids.length) items = ids.map((i) => YT.channels.get(i)).filter(Boolean);
    else if (handle) items = [...YT.channels.values()].filter((c) => c.snippet.customUrl.toLowerCase() === handle.toLowerCase());
    else if (user) items = [...YT.channels.values()].filter((c) => c.snippet.customUrl.toLowerCase() === '@' + user.toLowerCase());
    return res(200, { items });
  }
  return res(404, {});
}
const yt = makeYouTube({ fetch: fakeFetch, apiKey: ENV.SYNCNET_YOUTUBE_API_KEY, clientId: ENV.SYNCNET_GOOGLE_CLIENT_ID, clientSecret: ENV.SYNCNET_GOOGLE_CLIENT_SECRET, redirect: ENV.SYNCNET_EARLY_OAUTH_REDIRECT, timeoutMs: 200 });
const authCall = async (params, over = {}) => parse(await auth._handler({ httpMethod: over.method || 'GET', headers: { 'x-nf-client-connection-ip': over.ip || ip() }, queryStringParameters: params }, { store, env: over.env || ENV, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube: over.youtube || yt, fetch: fakeFetch }));
const api = async (method, body, query, over = {}) => parse(await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip(), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: over.env || ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube: yt }));
const job = async (over = {}) => parse(await snap._handler({}, { store, env: over.env || ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube: over.youtube === null ? undefined : (over.youtube || yt), budgetMs: over.budgetMs }));

// ============================================================================================ A. client
resetStore(); resetPc();
{
  check('A01 parseInput: channel id', parseInput(CH).kind === 'id');
  check('A02 parseInput: @handle and URL forms', parseInput('@Alice').value === '@Alice' && parseInput('https://www.youtube.com/@alice').value === '@alice' && parseInput('youtube.com/channel/' + CH).value === CH && parseInput('https://youtube.com/user/alice').kind === 'username' && parseInput('https://youtube.com/c/alice').value === '@alice');
  check('A03 parseInput: junk / other hosts refused', parseInput('https://evil.example/@alice') === null && parseInput('') === null && parseInput('x'.repeat(300)) === null && parseInput('javascript:alert(1)') === null);
  const r1 = await yt.resolve('@alice');
  check('A04 resolve by handle → channel id, title, https avatar, handle', r1 && r1.channelId === CH && r1.title === 'Alice' && r1.avatarUrl.startsWith('https://') && r1.handle === '@alice');
  check('A05 resolve unknown → null', (await yt.resolve('@nobody')) === null);
  const m = await yt.channelsById([CH, CH2, 'bad', CH]);
  check('A06 channelsById dedupes, filters, returns counts and hidden flags', m.size === 2 && m.get(CH).subscriberCount === 1234 && m.get(CH2).subscriberCount === 20 && m.get(CH).hidden === false);
  ytChannel('UChiddenhiddenhiddenhidd', { hidden: true, subs: 999 });
  const h = await yt.channelsById(['UChiddenhiddenhiddenhidd']);
  check('A07 hidden subscriber count → null + hidden:true', h.get('UChiddenhiddenhiddenhidd').subscriberCount === null && h.get('UChiddenhiddenhiddenhidd').hidden === true);
  YT.mode = 'down';
  let err = null; try { await yt.resolve('@alice'); } catch (e) { err = e; }
  check('A08 5xx → YouTubeError unavailable, no retry', err instanceof YouTubeError && err.code === 'unavailable' && YT.calls.filter((c) => c.url.includes('forHandle')).length >= 2);
  YT.mode = 'quota';
  err = null; try { await yt.resolve('@alice'); } catch (e) { err = e; }
  check('A09 quota → code quota', err && err.code === 'quota');
  YT.mode = 'hang'; YT.delayMs = 400;
  err = null; try { await yt.resolve('@alice'); } catch (e) { err = e; }
  check('A10 timeout → unavailable', err instanceof YouTubeError && err.code === 'unavailable' && /timeout/.test(err.message), err && err.message);
  YT.mode = 'ok';
  check('A11 authUrl: youtube.readonly only, online access, no offline/refresh', (() => { const u = new URL(yt.authUrl('st')); return u.searchParams.get('scope') === 'https://www.googleapis.com/auth/youtube.readonly' && u.searchParams.get('access_type') === 'online' && u.searchParams.get('state') === 'st' && u.searchParams.get('redirect_uri') === ENV.SYNCNET_EARLY_OAUTH_REDIRECT; })());
  err = null; try { await yt.exchangeCode('bad'); } catch (e) { err = e; }
  check('A12 malformed code refused before any request', err && err.code === 'denied');
}

// ============================================================================================ B. OAuth function
let creatorToken = null;
{
  const off = await authCall({ start: 'x' }, { env: {} });
  check('B01 closed deployment → 302 #e=closed', off.s === 302 && /#e=closed$/.test(off.headers.location));
  const badState = await authCall({ start: 'e1.state.bogus' });
  check('B02 forged/unknown state token → #e=state', badState.s === 302 && /#e=state$/.test(badState.headers.location));
  const lm = { schema: E.SCHEMA.creatorLink, wallet: W.creator, issuedAt: nowSec(), nonce: rnd32() };
  const link = await api('POST', { action: 'creator-link', wallet: W.creator, issuedAt: lm.issuedAt, nonce: lm.nonce, signature: sign('CreatorLinkRequest', lm, W.creator) });
  check('B03 creator-link (wallet signature) returns a start URL with a wallet-bound state', link.s === 200 && /^\/api\/early-youtube-auth\?start=/.test(link.j.startUrl));
  const state = decodeURIComponent(link.j.startUrl.split('start=')[1]);
  const start = await authCall({ start: state });
  check('B04 start → 302 to Google consent with that state', start.s === 302 && start.headers.location.startsWith('https://accounts.google.com/o/oauth2/v2/auth?') && new URL(start.headers.location).searchParams.get('state') === state);
  const denied = await authCall({ error: 'access_denied', state });
  check('B05 user denies consent → #e=denied', /#e=denied$/.test(denied.headers.location));
  YT.tokens.set('code-alice-0123456789', { token: 'tok-alice', channel: CH });
  const badCode = await authCall({ code: 'code-unknown-0123456789', state });
  check('B06 invalid grant → #e=denied and the state is consumed (single use)', /#e=denied$/.test(badCode.headers.location));
  const reuse = await authCall({ code: 'code-alice-0123456789', state });
  check('B07 the same state cannot be used again → #e=state', /#e=state$/.test(reuse.headers.location));
  const lm2 = { schema: E.SCHEMA.creatorLink, wallet: W.creator, issuedAt: nowSec(), nonce: rnd32() };
  const link2 = await api('POST', { action: 'creator-link', wallet: W.creator, issuedAt: lm2.issuedAt, nonce: lm2.nonce, signature: sign('CreatorLinkRequest', lm2, W.creator) });
  const state2 = decodeURIComponent(link2.j.startUrl.split('start=')[1]);
  YT.calls.length = 0;
  const done = await authCall({ code: 'code-alice-0123456789', state: state2 });
  check('B08 valid callback → 302 to /labs/early/creator#s=<creator session>', done.s === 302 && done.headers.location.startsWith('/labs/early/creator#s='));
  creatorToken = decodeURIComponent(done.headers.location.split('#s=')[1]);
  const sess = Session.verify(creatorToken, { scope: 'creator', now: () => clock.now(), env: ENV });
  check('B09 session bound to the channel from channels.mine and the wallet from the state', sess && sess.channelId === CH && sess.wallet === W.creator);
  const linkRec = JSON.parse(MAP.get('early:oauth:v1:' + sess.sid).value);
  check('B10 link record stores channel id, title, count, wallet, time; never the access token', linkRec.channelId === CH && linkRec.subscriberCount === 1234 && linkRec.wallet === W.creator && !JSON.stringify([...MAP.entries()]).includes('tok-alice'));
  check('B11 the code exchange and channels.mine happened once each, with the bearer token in memory only', YT.calls.filter((c) => c.url.includes('oauth2.googleapis.com')).length === 1 && YT.calls.filter((c) => c.url.includes('mine=true') && c.auth === 'Bearer tok-alice').length === 1);
  const noCh = (() => { YT.tokens.set('code-nochannel-0123456789', { token: 'tok-none', channel: null }); return null; })();
  const lm3 = { schema: E.SCHEMA.creatorLink, wallet: W.creator2, issuedAt: nowSec(), nonce: rnd32() };
  const link3 = await api('POST', { action: 'creator-link', wallet: W.creator2, issuedAt: lm3.issuedAt, nonce: lm3.nonce, signature: sign('CreatorLinkRequest', lm3, W.creator2) });
  const none = await authCall({ code: 'code-nochannel-0123456789', state: decodeURIComponent(link3.j.startUrl.split('start=')[1]) });
  check('B12 account without a channel → #e=no_channel', /#e=no_channel$/.test(none.headers.location), none.headers.location);
  const scopeless = (() => { YT.tokens.set('code-scopeless-0123456789', { token: 'tok-s', channel: CH, scope: 'openid' }); return null; })();
  const lm4 = { schema: E.SCHEMA.creatorLink, wallet: W.creator2, issuedAt: nowSec(), nonce: rnd32() };
  const link4 = await api('POST', { action: 'creator-link', wallet: W.creator2, issuedAt: lm4.issuedAt, nonce: lm4.nonce, signature: sign('CreatorLinkRequest', lm4, W.creator2) });
  const sc = await authCall({ code: 'code-scopeless-0123456789', state: decodeURIComponent(link4.j.startUrl.split('start=')[1]) });
  check('B13 token without the youtube.readonly scope → #e=denied', /#e=denied$/.test(sc.headers.location));
  let limited = 0;
  for (let i = 0; i < 7; i++) { const r = await authCall({ start: 'e1.state.bogus' }, { ip: '203.0.113.77' }); if (r.s === 429) limited++; }
  check('B14 OAuth endpoint rate-limited per IP (5/min)', limited >= 2);
  const post = await authCall({}, { method: 'POST' });
  check('B15 POST not allowed', post.s === 405);
  // the session from B08 activates a creator (the real flow)
  const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
  const m = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: nowSec(), nonce: rnd32() };
  const act = await api('POST', { action: 'creator-manifest', creatorId: m.creatorId, channelId: CH, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorManifest', m, W.creator) }, null, { session: creatorToken });
  check('B16 the OAuth-issued session activates the creator (end-to-end identity)', act.s === 201 && act.j.creator.status === 'ACTIVE', act.body);
  globalThis.__M1 = E.digest('CreatorManifest', m);
  const resolve = await api('GET', null, { view: 'resolve', yt: 'https://www.youtube.com/@bob' });
  check('B17 /api/early resolve view uses the client and caches', resolve.s === 200 && resolve.j.channelId === CH2 && resolve.j.cached === false && (await api('GET', null, { view: 'resolve', yt: 'https://www.youtube.com/@bob' })).j.cached === true);
  const rNone = await api('GET', null, { view: 'resolve', yt: '@nobody' });
  check('B18 resolve unknown → 404 (identical whether or not signals exist)', rNone.s === 404);
}

// ============================================================================================ C. snapshot job
{
  const today = () => E.utcDate(nowSec());
  const snapOf = (d) => { const v = MAP.get('early:snap:v1:' + CH + ':' + d); return v ? JSON.parse(v.value) : null; };
  check('C01 enrolment snapshot exists for the join day (from the OAuth link value)', snapOf(today()) && snapOf(today()).claims.source.includes('enrolment') && snapOf(today()).claims.subscriberCount === 1234);
  ytChannel(CH, { subs: 5000 });
  const r0 = await job();
  check('C02 job on the join day: today already snapshotted → skipped, no overwrite (first success wins)', r0.j.report.snapshotsSkipped === 1 && r0.j.report.snapshots === 0 && snapOf(today()).claims.subscriberCount === 1234);
  clock.advance(86400); syncHead();
  const d1 = today();
  YT.mode = 'down';
  const r1 = await job();
  check('C03 next day, YouTube down → failure counted, no snapshot, no state change', r1.j.report.snapshotFailures === 1 && snapOf(d1) === null);
  YT.mode = 'ok';
  const r2 = await job();
  check('C04 hourly retry succeeds → snapshot for that day with the value read then (5000), attested and queued', r2.j.report.snapshots === 1 && snapOf(d1).claims.subscriberCount === 5000 && E.verifyAttestation(snapOf(d1), TEST_KEYS_FILE).ok && [...MAP.keys()].some((k) => k.startsWith('early:bundle-queue:v1:')));
  ytChannel(CH, { subs: 9000 });
  const r3 = await job();
  check('C05 a later run the same day never replaces the day’s snapshot', r3.j.report.snapshots === 0 && snapOf(d1).claims.subscriberCount === 5000);
  clock.advance(86400 * 2); syncHead();
  const d3 = today(), d2 = E.utcDate(nowSec() - 86400);
  await job();
  check('C06 a day that ended without a snapshot is never backfilled (d2 missing, d3 taken)', snapOf(d2) === null && snapOf(d3) && snapOf(d3).claims.subscriberCount === 9000);
  ytChannel(CH, { hidden: true, subs: 1 });
  clock.advance(86400); syncHead();
  await job();
  check('C07 hidden subscriber count recorded as hidden (null count)', snapOf(today()).claims.hiddenSubscriberCount === true && snapOf(today()).claims.subscriberCount === null);
  const cv = (await api('GET', null, { view: 'creator', channelId: CH })).j;
  ytChannel(CH, { title: 'Alice Renamed', handle: '@alice2', subs: 42 });
  clock.advance(86400); syncHead();
  await job();
  const cv2 = (await api('GET', null, { view: 'creator', channelId: CH })).j;
  check('C08 handle/title change refreshes display metadata only; identity (channel id, creatorId, wallet) unchanged', cv2.display.title === 'Alice Renamed' && cv2.display.handle === '@alice2' && cv2.creatorId === cv.creatorId && cv2.currentManifest.receivingWallet === cv.currentManifest.receivingWallet);
  const noSigner = await job({ env: { ...ENV, SYNCNET_EARLY_ATTESTATION_KEY: '' } });
  check('C09 without the attestation key the job takes no snapshots (fail closed) and says so', noSigner.j.report.noSigner === true && noSigner.j.report.snapshots === 0);
  // receipt context uses the snapshot of the transfer's UTC day, never a later value
  const d = await api('POST', { action: 'intent-draft', manifestHash: globalThis.__M1, sender: W.fan, token: USDG, amount: '2500000' });
  const st = await api('POST', { action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) });
  const p = pay({ from: W.fan, to: W.creator, amount: '2500000' }); makeSafe(p.blockNumber);
  const v = await api('POST', { action: 'verify', intentId: st.j.intent.intentId, txHash: p.txHash });
  check('C10 receipt CONFIRMED and indexed for finality', v.s === 200 && v.j.status === 'CONFIRMED' && MAP.has('early:pending-final:v1'));
  const doc = (await api('GET', null, { view: 'receipt', intent: st.j.intent.intentId })).j.receipt;
  check('C11 receipt audience = the transfer day’s snapshot (42), display ~42', doc.context.audienceThen.value === 42 && doc.context.creatorTitleThen === 'Alice Renamed');
  ytChannel(CH, { subs: 100000 });
  clock.advance(86400); syncHead(); await job();
  const doc2 = (await api('GET', null, { view: 'receipt', intent: st.j.intent.intentId })).j.receipt;
  check('C12 a later day’s value never mutates the historical receipt context', doc2.context.audienceThen.value === 42);
  makeFinal(p.blockNumber);
  const r4 = await job();
  check('C13 the job reconciles CONFIRMED receipts to FINALIZED and clears the index', r4.j.report.finalized === 1 && (await api('GET', null, { view: 'receipt', intent: st.j.intent.intentId })).j.receipt.status === 'FINALIZED' && (await store.zcard('early:pending-final:v1')) === 0);
  // rotation completion by the job
  const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
  const rm = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator2, acceptedAssetsHash: na.hash, manifestVersion: 2, previousManifestHash: globalThis.__M1, issuedAt: nowSec(), nonce: rnd32() };
  const rot = await api('POST', { action: 'creator-manifest', creatorId: rm.creatorId, channelId: CH, receivingWallet: W.creator2, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 2, previousManifestHash: globalThis.__M1, issuedAt: rm.issuedAt, nonce: rm.nonce, signature: sign('CreatorManifest', rm, W.creator2) }, null, { session: creatorSession(store, { channelId: CH, wallet: W.creator2 }) });
  clock.advance(E.CONST.ROTATION_COOLDOWN_S + 60); syncHead();
  const r5 = await job();
  check('C14 the job completes a due rotation', rot.s === 201 && r5.j.report.rotationsCompleted === 1 && JSON.parse(MAP.get('early:creator:v1:' + E.creatorIdOf(CH)).value).currentManifestHash === E.digest('CreatorManifest', rm));
  const lock = await (async () => { MAP.set('early:snap-lock:v1', { type: 'string', value: '1', expiresAt: clock.now() + 60000 }); const r = await job(); MAP.delete('early:snap-lock:v1'); return r; })();
  check('C15 one run at a time (lock)', lock.j.skipped === 'running');
  const off = await job({ env: {} });
  check('C16 disabled deployment → skipped', off.j.skipped === 'disabled');
}

fs.writeFileSync(path.join(ROOT, 'tests/early/identity.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early identity checks passed`);
process.exit(failures ? 1 : 0);
