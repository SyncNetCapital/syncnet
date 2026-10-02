// EARLY platform-identity suite (phases 1-3 of the multi-platform work): identity is (platform, immutable external id), only
// YouTube is enabled, and EVERYTHING that existed before platforms must keep working byte for byte.
//   A. pinned protocol vectors (YouTube creatorId, EIP-712 digests, receipt/attestation ids) - independent of vectors.json
//   B. the platform helpers: registry, id shapes, refs, creatorId, audience, and that identities can never cross
//   C. session tokens: YouTube spelling unchanged, platform bound into the MAC, state tokens cannot cross platforms
//   D. a platform that is not enabled is refused at every entry point and writes nothing; no env var can enable one
//   E. stored-data shape: a fresh run of the current code stores exactly the keys/fields the pre-platform code stored
//   F. legacy replay: state written by the PRE-platform code (tests/early/legacy/youtube-state.v1.json, generated from
//      b4fccd5 by make-legacy-state.mjs) is read, verified and continued by the current code; the frozen receipts verify
//   G. generic code with a hypothetically enabled second platform (pure functions + the snapshot job's grouping)
//   H. nothing of another platform exists in this build (no adapter, route, env var)
// Run: node tests/early/platform.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, SYNC, CH, CH2, clock, resetPc, pay, makeFinal, rpc, MAP, makeStore, resetStore, creatorSession, fanSession, Session } from './fixtures.mjs';
import { verifyReceipt } from '../../docs/early/verify-receipt.mjs';

const require = createRequire(import.meta.url);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const snapJob = require(path.join(ROOT, 'netlify/functions/early-snapshot.js'));
const { earlyConfig, platformEnabled } = require(path.join(ROOT, 'netlify/lib/early-config.js'));
const Platforms = require(path.join(ROOT, 'netlify/lib/early-platforms.js'));
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const store = makeStore();
let ipSeq = 0; const ip = () => `198.51.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body, headers: r.headers || {} }; };
const nowSec = () => Math.floor(clock.now() / 1000);
const call = async (method, body, query, over = {}) => parse(await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip(), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: over.env || ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube: over.youtube }));
const get = (view, params, over) => call('GET', null, { view, ...(params || {}) }, over);
const post = (body, over) => call('POST', body, null, over);
const domainKeys = () => [...MAP.keys()].filter((k) => k.startsWith('early:')).sort();
const X_ID = '1234567890', X_ID2 = '18446744073709551615'; // a typical id and the largest 20-digit one

// ============================================================================================ A. pinned protocol vectors
// These literals are the values committed at b4fccd5 in tests/early/vectors.json. They are repeated HERE so that
// regenerating vectors.json (WRITE_VECTORS=1) can never silently bless a change to a YouTube identity or digest.
const PINNED = {
  supportIntentDigest: '0x9fce2d6cc3a5c38d9d758386b22a59afaca442f8604be771ba3a949d23daf2b1',
  creatorManifestDigest: '0xedd69e3b9cd0c577b094baf96056aa1130e767b0b42a11baca35e723d1c65011',
  countMeInDigest: '0x70e1bef82b7df6cad6b1c25b29b9cfe6cdb75e10616089f15ce4902ba534b76b',
  finalizeDigest: '0x36343b3410b23fb7f774679e3894f2efcd3c074efc63785514b82349f8d78ec0',
  hashJsonSample: '0x4fcf72b17f17c576aa536a00863b124b0a7fedd4fa5a34ea8849c5245a6cef79',
  acceptedAssetsHash: '0xdf0fbcabdea57394b008d9485aa3a21f21384675d57ea3579103620d50afd021',
  creatorId: '0x32b74c7680a22c1424cb949ffe137d3bed4067061c681d4c8ec848b9435b2d18',
  merkleRoot3: '0x5b9d2bc9d88de2b185b7d3672d3a2678fee42fe6864b27856edd9a606137ca13',
  emptyRoot: '0x25693c1e624d15fba76fd33ee8a08375aa2d84afb72173b5dca1dc7627b0fb56',
  leaf1: '0x35263fd6ea15b27f9af10ea426457154eeaa4fdd6e3dc22e6c33fb7b17d41881',
  attestationId: '0x30d0fb05a56fcf5e66a622f1d630b3604989e50c6a5aec87add00b430cf4d5dd',
  receiptId: '0x626eef70d2d0c914c9953da0cf69c80d62404b085e7946267f88d7d31754e41e',
};
{
  const K1 = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', K2 = '0x' + '11'.repeat(32);
  const A1 = lc(Core._internal.secp256k1.privateKeyToAddress(K1)), A2 = lc(Core._internal.secp256k1.privateKeyToAddress(K2));
  const b32 = (i) => '0x' + String(i).padStart(2, '0').repeat(32);
  const vec = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/early/vectors.json'), 'utf8'));
  check('P01 tests/early/vectors.json equals the vectors pinned at b4fccd5 (every one of the 12)', same(Object.keys(PINNED).sort(), Object.keys(vec).sort()) && Object.keys(PINNED).every((k) => vec[k] === PINNED[k]), JSON.stringify(Object.keys(PINNED).filter((k) => vec[k] !== PINNED[k])));
  check('P02 YouTube creatorId unchanged: keccak256("syncnet.early.creator.v1|youtube|" + channelId)', E.creatorIdOf(CH) === PINNED.creatorId && Core.keccak256Utf8('syncnet.early.creator.v1|youtube|' + CH) === PINNED.creatorId);
  const intentMsg = { schema: E.SCHEMA.intent, intentId: b32(1), manifestHash: b32(2), creatorId: E.creatorIdOf(CH), chainId: 4663, sender: A1, receiver: A2, token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', amount: '1500000', notBefore: 1790000000, expiry: 1790007200, privacy: 'PRIVATE' };
  check('P03 SupportIntent digest (which embeds the YouTube creatorId) unchanged', E.digest('SupportIntent', intentMsg) === PINNED.supportIntentDigest);
  const mm = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: A2, acceptedAssetsHash: b32(9), manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: 1790000000, nonce: b32(7) };
  check('P04 CreatorManifest digest unchanged (the signed field is still `channelId`)', E.digest('CreatorManifest', mm) === PINNED.creatorManifestDigest && E.TYPES.CreatorManifest.some((f) => f.name === 'channelId') && !E.TYPES.CreatorManifest.some((f) => f.name === 'externalId'));
  check('P05 CountMeIn digest unchanged', E.digest('CountMeIn', { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId: CH, fan: A1, issuedAt: 1790000000, expiry: 1790000000 + E.CONST.CMI_TTL_S, nonce: b32(3) }) === PINNED.countMeInDigest);
  check('P06 the EIP-712 type list and schema strings are exactly the v1 ones (no new type, no renamed field)', same(Object.keys(E.TYPES), ['CreatorManifest', 'CountMeIn', 'CountMeInWithdraw', 'SupportIntent', 'SupportFinalize', 'RotationCancel', 'EarlySession', 'CreatorLinkRequest', 'CardReveal']) && E.SCHEMA.manifest === 'syncnet.early.creator-manifest.v1' && E.SCHEMA.intent === 'syncnet.early.support-intent.v1' && E.SCHEMA.receipt === 'syncnet.sync-proof.receipt.v1' && E.SCHEMA.matching === 'syncnet.sync-proof.matching.v1' && E.DOMAIN.version === '1');
  check('P07 receiptId derivation unchanged', E.receiptIdOf(4663, b32(4), 2) === Core.keccak256Utf8('syncnet.sync-proof.receipt.v1|4663|' + b32(4) + '|2'));
  check('P08 `PLATFORM` is still "youtube" (the default for every legacy call)', E.PLATFORM === 'youtube');
}

// ============================================================================================ B. platform helpers
{
  check('B01 registry: frozen, exactly youtube + x, each with an id pattern and an audience kind', Object.isFrozen(E.PLATFORMS) && same(Object.keys(E.PLATFORMS), ['youtube', 'x']) && Object.values(E.PLATFORMS).every((p) => Object.isFrozen(p) && p.idPattern instanceof RegExp && typeof p.audienceKind === 'string') && E.PLATFORMS.youtube.audienceKind === 'subscribers' && E.PLATFORMS.x.audienceKind === 'followers');
  check('B02 creatorIdOf(CH) === creatorIdOf(CH, "youtube") and both are the pinned value', E.creatorIdOf(CH) === E.creatorIdOf(CH, 'youtube') && E.creatorIdOf(CH, 'youtube') === PINNED.creatorId);
  check('B03 X creatorId follows the same formula with its own platform tag', E.creatorIdOf(X_ID, 'x') === Core.keccak256Utf8('syncnet.early.creator.v1|x|' + X_ID) && E.creatorIdOf(X_ID, 'x') !== E.creatorIdOf(CH));
  check('B04 an id of one platform can never produce another platform\'s creatorId (validated against the GIVEN platform only)', throws(() => E.creatorIdOf(CH, 'x')) && throws(() => E.creatorIdOf(X_ID, 'youtube')) && throws(() => E.creatorIdOf(X_ID)) && throws(() => E.creatorIdOf('youtube', CH)) && throws(() => E.creatorIdOf(CH, 'tiktok')) && throws(() => E.creatorIdOf(CH, null)) && throws(() => E.creatorIdOf(CH, '')) && throws(() => E.creatorIdOf(CH, '__proto__')) && throws(() => E.creatorIdOf(CH, 'constructor')));
  check('B05 creatorIdOf refuses handles, empty, non-strings', throws(() => E.creatorIdOf('@alice')) && throws(() => E.creatorIdOf('')) && throws(() => E.creatorIdOf(undefined)) && throws(() => E.creatorIdOf(1234567890, 'x')) && throws(() => E.creatorIdOf('@elonmusk', 'x')));
  const okX = ['1', '12', X_ID, '1790000000000000000', X_ID2];
  const badX = ['0', '01', '', ' 12', '12 ', '-1', '1.5', '12a', '123456789012345678901', '１２', '0x12', X_ID + '\n', CH];
  check('B06 isExternalId(x): digits only, no leading zero, 1-20 chars, strings only', okX.every((v) => E.isExternalId('x', v)) && badX.every((v) => !E.isExternalId('x', v)) && !E.isExternalId('x', 12) && !E.isExternalId('x', null) && !E.isExternalId('x', undefined) && !E.isExternalId('x', 12n));
  check('B07 isExternalId(youtube) is the legacy channel-id shape and refuses X ids', E.isExternalId('youtube', CH) && E.isChannelId(CH) && !E.isExternalId('youtube', X_ID) && !E.isExternalId('youtube', 'UC' + '1'.repeat(21)) && !E.isExternalId('tiktok', CH) && !E.isExternalId(undefined, CH));
  // the two shapes must stay disjoint: platformOfId needs exactly one match
  let disjoint = true; const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  for (let i = 0; i < 4000 && disjoint; i++) {
    const ytId = 'UC' + Array.from({ length: 22 }, () => alpha[Math.floor(Math.random() * alpha.length)]).join('');
    const xId = String(1 + Math.floor(Math.random() * 9)) + Array.from({ length: Math.floor(Math.random() * 19) }, () => Math.floor(Math.random() * 10)).join('');
    disjoint = E.platformOfId(ytId) === 'youtube' && E.platformOfId(xId) === 'x' && !E.isExternalId('x', ytId) && !E.isExternalId('youtube', xId);
  }
  check('B08 the id alphabets are disjoint (4000 random ids per platform): platformOfId is unambiguous', disjoint && E.platformOfId('@alice') === null && E.platformOfId('') === null && E.platformOfId(12) === null);
  check('B09 refOf: YouTube ref is the BARE channel id (stored keys keep their names); X ref is "x:<id>"', E.refOf('youtube', CH) === CH && E.refOf('x', X_ID) === 'x:' + X_ID && throws(() => E.refOf('x', CH)) && throws(() => E.refOf('youtube', X_ID)) && throws(() => E.refOf('tiktok', X_ID)));
  check('B10 parseRef round-trips every valid identity', same(E.parseRef(CH), { platform: 'youtube', externalId: CH }) && same(E.parseRef('x:' + X_ID), { platform: 'x', externalId: X_ID }) && [CH, CH2].every((c) => E.parseRef(E.refOf('youtube', c)).externalId === c) && okX.every((v) => E.parseRef(E.refOf('x', v)).externalId === v && E.parseRef(E.refOf('x', v)).platform === 'x'));
  check('B11 parseRef refuses non-canonical / cross-platform / junk refs (one spelling per identity)', ['youtube:' + CH, 'x:' + CH, 'X:' + X_ID, 'x:0', 'x:01', 'x:', 'x:12a', ':12', X_ID, 'tiktok:12', 'x:' + X_ID + ':y', '', '__proto__:1'].every((r) => E.parseRef(r) === null) && E.parseRef(undefined) === null && E.parseRef(12) === null && E.parseRef(null) === null);
  // refs of different identities never collide, so keyed records can never be shared across platforms
  const refs = new Set([E.refOf('youtube', CH), E.refOf('youtube', CH2), ...okX.map((v) => E.refOf('x', v))]);
  const cids = new Set([E.creatorIdOf(CH), E.creatorIdOf(CH2), ...okX.map((v) => E.creatorIdOf(v, 'x'))]);
  check('B12 distinct identities have distinct refs and distinct creatorIds', refs.size === 2 + okX.length && cids.size === 2 + okX.length);

  // audience context (dated, approximate, never part of payment validity)
  check('B13 audienceOf: legacy YouTube claims (no audienceKind) = subscribers; hidden/null stay hidden', same(E.audienceOf({ subscriberCount: 1234, hiddenSubscriberCount: false }), { kind: 'subscribers', count: 1234, hidden: false }) && E.audienceOf({ subscriberCount: 1234, hiddenSubscriberCount: true }).hidden === true && E.audienceOf({ subscriberCount: null, hiddenSubscriberCount: false }).hidden === true && E.audienceOf({ subscriberCount: 0 }).hidden === false && E.audienceOf({ subscriberCount: 0 }).count === 0);
  check('B14 audienceOf: followers claims are followers (never relabelled as subscribers); unknown kinds are never guessed', same(E.audienceOf({ audienceKind: 'followers', followerCount: 12400 }), { kind: 'followers', count: 12400, hidden: false }) && E.audienceOf({ audienceKind: 'followers', followerCount: null }).count === null && E.audienceOf({ audienceKind: 'members', followerCount: 5 }) === null && E.audienceOf(null) === null && E.audienceOf('x') === null && E.audienceOf({ audienceKind: 'followers', subscriberCount: 99 }).count === null);
  check('B15 audienceOf ignores negative / non-numeric counts', E.audienceOf({ subscriberCount: -5 }).count === null && E.audienceOf({ audienceKind: 'followers', followerCount: 'many' }).count === null);
  const yl = (a) => E.audienceLine(a);
  check('B16 YouTube audience line is byte-identical to the pre-platform text (and to a legacy receipt without `kind`)', yl({ state: 'approximate', kind: 'subscribers', display: '~1.2K' }) === 'Audience then: ~1.2K' && yl({ state: 'approximate', display: '~1.2K' }) === 'Audience then: ~1.2K' && yl({ state: 'hidden', kind: 'subscribers' }) === 'Audience then: hidden' && yl({ state: 'unavailable', kind: 'subscribers' }) === 'Audience then: unavailable' && yl(null) === 'Audience then: unavailable' && yl(undefined) === 'Audience then: unavailable');
  check('B17 X follower context is always labelled as X context, never as the generic "Audience then"', yl({ state: 'approximate', kind: 'followers', display: '~12.4K' }) === 'Followers on X then: ~12.4K' && yl({ state: 'approximate', kind: 'followers', display: E.formatAudience(1234) }) === 'Followers on X then: ~1.2K' && yl({ state: 'hidden', kind: 'followers' }) === 'Followers on X then: hidden' && yl({ state: 'unavailable', kind: 'followers' }) === 'Followers on X then: unavailable' && ['approximate', 'hidden', 'unavailable'].every((s) => !/Audience then/.test(yl({ state: s, kind: 'followers', display: '~1' }))));
  check('B18 formatAudience is unchanged (pre-platform rounding: one decimal below 10K, whole units above)', E.formatAudience(12400) === '~12K' && E.formatAudience(9999) === '~9.9K' && E.formatAudience(999) === '~999' && E.formatAudience(1234) === '~1.2K' && E.formatAudience(15000) === '~15K' && E.formatAudience(2400000) === '~2.4M' && E.formatAudience(24000000) === '~24M');
  const withAdapter = Platforms.adapterOf('youtube');
  check('B19 adapters: YouTube and X are registered; adapterOf refuses everything else (incl. prototype names)', Platforms.adapterOf('x') && Platforms.adapterOf('x').platform === 'x' && Platforms.adapterOf('tiktok') === null && Platforms.adapterOf('constructor') === null && Platforms.adapterOf('__proto__') === null && Platforms.adapterOf(undefined) === null && withAdapter && withAdapter.platform === 'youtube' && same(Object.keys(Platforms.ADAPTERS), ['youtube', 'x']) && Object.isFrozen(Platforms.ADAPTERS));
  check('B20 idFields: YouTube keeps `channelId` in attestation subjects/claims; other platforms use `externalId`', same(Platforms.idFields('youtube', CH), { channelId: CH }) && same(Platforms.idFields('x', X_ID), { externalId: X_ID }));
  // the exact YouTube claim shapes (an attestation id hashes its claims: these are part of the stored/anchored protocol)
  const link = { title: ' Alice ', subscriberCount: 1234, hiddenSubscriberCount: false, at: 1790000000 };
  check('B21 YouTube enrolment snapshot claims are exactly the pre-platform shape', same(withAdapter.enrolmentSnapshot(CH, link, '2026-10-05'), { subject: { channelId: CH }, claims: { channelId: CH, dateUTC: '2026-10-05', title: 'Alice', subscriberCount: 1234, hiddenSubscriberCount: false, fetchedAt: 1790000000, source: 'youtube-data-api-v3 channels.list statistics (oauth link, enrolment)' } }));
  check('B22 YouTube daily snapshot claims are exactly the pre-platform shape (hidden count -> null)', same(withAdapter.dailySnapshot(CH, { title: 'Alice', subscriberCount: 99, hidden: true }, '2026-10-05', 1790000001), { subject: { channelId: CH }, claims: { channelId: CH, dateUTC: '2026-10-05', title: 'Alice', subscriberCount: null, hiddenSubscriberCount: true, fetchedAt: 1790000001, source: 'youtube-data-api-v3 channels.list statistics' } }) && withAdapter.identityMethod === 'google-oauth2 youtube.readonly channels.mine' && withAdapter.authStart === '/api/early-youtube-auth' && withAdapter.oauthScope === 'https://www.googleapis.com/auth/youtube.readonly');
}

// ============================================================================================ C. sessions
{
  const T = () => clock.now();
  const issue = (o) => Session.issue({ now: T, env: ENV, ...o });
  const subjectOf = (tok) => tok.split('.')[2];
  const cTok = issue({ scope: 'creator', wallet: W.creator, channelId: CH });
  check('C01 YouTube creator token: subject is exactly <channelId>~<wallet> (unchanged format), verify returns platform youtube', subjectOf(cTok) === CH + '~' + W.creator && same((({ platform, externalId, channelId, wallet }) => ({ platform, externalId, channelId, wallet }))(Session.verify(cTok, { scope: 'creator', now: T, env: ENV })), { platform: 'youtube', externalId: CH, channelId: CH, wallet: W.creator }));
  check('C02 legacy spelling (channelId) and explicit spelling (platform + externalId) issue the SAME subject', subjectOf(issue({ scope: 'creator', wallet: W.creator, platform: 'youtube', externalId: CH })) === subjectOf(cTok));
  check('C03 fan and YouTube state subjects are the bare wallet (unchanged)', subjectOf(issue({ scope: 'fan', wallet: W.fan })) === W.fan && subjectOf(issue({ scope: 'state', wallet: W.fan })) === W.fan && Session.verify(issue({ scope: 'state', wallet: W.fan }), { scope: 'state', now: T, env: ENV }).platform === 'youtube');
  const xTok = issue({ scope: 'creator', wallet: W.creator, platform: 'x', externalId: X_ID });
  const xv = Session.verify(xTok, { scope: 'creator', now: T, env: ENV });
  check('C04 an X creator token carries the platform: x_<id>~<wallet>, verifies as platform x', subjectOf(xTok) === 'x_' + X_ID + '~' + W.creator && xv && xv.platform === 'x' && xv.externalId === X_ID && xv.wallet === W.creator);
  check('C05 tokens cannot be issued for an id that is not of the named platform', issue({ scope: 'creator', wallet: W.creator, platform: 'x', externalId: CH }) === '' && issue({ scope: 'creator', wallet: W.creator, platform: 'youtube', externalId: X_ID }) === '' && issue({ scope: 'creator', wallet: W.creator, platform: 'tiktok', externalId: X_ID }) === '' && issue({ scope: 'creator', wallet: W.creator, platform: null, externalId: CH }) === '' && issue({ scope: 'creator', wallet: W.creator }) === '');
  const swap = (tok, from, to) => { const p = tok.split('.'); p[2] = p[2].replace(from, to); return p.join('.'); };
  check('C06 the platform is inside the MAC: rewriting a token\'s platform/id invalidates it', Session.verify(swap(xTok, 'x_' + X_ID, CH), { scope: 'creator', now: T, env: ENV }) === null && Session.verify(swap(cTok, CH, 'x_' + X_ID), { scope: 'creator', now: T, env: ENV }) === null && Session.verify(swap(xTok, 'x_', 'y_'), { scope: 'creator', now: T, env: ENV }) === null);
  const sx = issue({ scope: 'state', wallet: W.fan, platform: 'x' });
  check('C07 a state token is bound to its platform (an X state is not a YouTube state, and vice versa)', Session.verify(sx, { scope: 'state', now: T, env: ENV }).platform === 'x' && subjectOf(sx) === W.fan + '~x' && Session.verify(swap(sx, '~x', ''), { scope: 'state', now: T, env: ENV }) === null && Session.verify(swap(issue({ scope: 'state', wallet: W.fan }), W.fan, W.fan + '~x'), { scope: 'state', now: T, env: ENV }) === null);
  check('C08 scopes stay separate (a state/fan token is never a creator token)', Session.verify(sx, { scope: 'creator', now: T, env: ENV }) === null && Session.verify(cTok, { scope: 'fan', now: T, env: ENV }) === null && Session.verify(xTok, { scope: 'state', now: T, env: ENV }) === null);
  check('C09 the longest legal subject still fits the token limits (20-digit id)', issue({ scope: 'creator', wallet: W.creator, platform: 'x', externalId: X_ID2 }).length < 260 && Session.verify(issue({ scope: 'creator', wallet: W.creator, platform: 'x', externalId: X_ID2 }), { scope: 'creator', now: T, env: ENV }).externalId === X_ID2);
  check('C10 the same wallet+id under different platforms can never share a token subject', subjectOf(xTok) !== subjectOf(cTok) && !subjectOf(xTok).startsWith('UC'));
  // MAC-valid tokens built with the test key: the verifier must still refuse every non-canonical subject (one spelling per identity)
  const forge = (scope, subject) => {
    const exp = Math.floor(clock.now() / 1000) + Session.TTL[scope], sid = 'abcdef0123456789';
    const mac = crypto.createHmac('sha256', ENV.SYNCNET_EARLY_SESSION_KEY).update(`syncnet-early-session|v1|${scope}|${subject}|${exp}|${sid}|${String(ENV.SYNCNET_SESSION_EPOCH || '1')}`, 'utf8').digest('hex');
    return `e1.${scope}.${subject}.${exp}.${sid}.${mac}`;
  };
  const vf = (scope, subject) => Session.verify(forge(scope, subject), { scope, now: T, env: ENV });
  const w = W.creator;
  check('C17 harness sanity: forged tokens with canonical subjects verify (youtube, x creator; youtube, x state; fan)', vf('creator', CH + '~' + w) && vf('creator', CH + '~' + w).platform === 'youtube' && vf('creator', 'x_' + X_ID + '~' + w).platform === 'x' && vf('state', w).platform === 'youtube' && vf('state', w + '~x').platform === 'x' && vf('fan', w).wallet === w);
  check('C18 MAC-valid but NON-canonical or cross-platform subjects are refused', [
    vf('creator', 'youtube_' + CH + '~' + w), vf('creator', 'x_' + CH + '~' + w), vf('creator', 'youtube_' + X_ID + '~' + w), vf('creator', 'X_' + X_ID + '~' + w), vf('creator', 'tiktok_' + X_ID + '~' + w),
    vf('creator', 'x_0' + X_ID + '~' + w), vf('creator', X_ID + '~' + w), vf('creator', 'x_' + X_ID), vf('creator', CH),
    vf('state', w + '~youtube'), vf('state', w + '~tiktok'), vf('state', w + '~'), vf('fan', w + '~x'), vf('fan', w + '~youtube'),
  ].every((r) => r === null));
}

// ============================================================================================ C2. the real YouTube OAuth round trip
{
  resetStore(); resetPc();
  const authMod = require(path.join(ROOT, 'netlify/functions/early-youtube-auth.js'));
  const { makeYouTube } = require(path.join(ROOT, 'netlify/lib/early-youtube.js'));
  let fetchCalls = 0;
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fakeFetch = async (url) => {
    fetchCalls++;
    const u = new URL(String(url));
    if (u.hostname === 'oauth2.googleapis.com') return res(200, { access_token: 'tok-1', scope: 'https://www.googleapis.com/auth/youtube.readonly', token_type: 'Bearer' });
    if (u.pathname.endsWith('/channels')) return res(200, { items: [{ id: CH, snippet: { title: 'Alice', customUrl: '@alice', thumbnails: { default: { url: 'https://yt3.example/a.jpg' } } }, statistics: { subscriberCount: '1234', hiddenSubscriberCount: false } }] });
    return res(404, {});
  };
  const yt = makeYouTube({ fetch: fakeFetch, apiKey: ENV.SYNCNET_YOUTUBE_API_KEY, clientId: ENV.SYNCNET_GOOGLE_CLIENT_ID, clientSecret: ENV.SYNCNET_GOOGLE_CLIENT_SECRET, redirect: ENV.SYNCNET_EARLY_OAUTH_REDIRECT, timeoutMs: 200 });
  const authCall = async (params) => parse(await authMod._handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: params }, { store, env: ENV, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube: yt, fetch: fakeFetch }));
  const lm = { schema: E.SCHEMA.creatorLink, wallet: W.creator, issuedAt: nowSec(), nonce: rnd32() };
  const link = await post({ action: 'creator-link', wallet: W.creator, issuedAt: lm.issuedAt, nonce: lm.nonce, signature: sign('CreatorLinkRequest', lm, W.creator) });
  const state = decodeURIComponent((link.j.startUrl || '').split('start=')[1] || '');
  check('C11 creator-link (legacy body, no platform) still returns the YouTube start URL and scope; the state is a YouTube state', link.s === 200 && link.j.startUrl.startsWith('/api/early-youtube-auth?start=') && link.j.scope === 'https://www.googleapis.com/auth/youtube.readonly' && Session.verify(state, { scope: 'state', now: () => clock.now(), env: ENV }).platform === 'youtube' && state.split('.')[2] === W.creator, link.body);
  const lm2 = { ...lm, nonce: rnd32() };
  const link2 = await post({ action: 'creator-link', platform: 'youtube', wallet: W.creator, issuedAt: lm2.issuedAt, nonce: lm2.nonce, signature: sign('CreatorLinkRequest', lm2, W.creator) });
  check('C12 creator-link with explicit platform=youtube is the same', link2.s === 200 && link2.j.startUrl.startsWith('/api/early-youtube-auth?start=') && link2.j.scope === link.j.scope);
  const start = await authCall({ start: state });
  check('C13 OAuth start redirects to Google with the youtube.readonly scope', start.s === 302 && /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/.test(start.headers.location) && start.headers.location.includes('youtube.readonly'), start.headers.location);
  const cb = await authCall({ code: 'code-0123456789abcdef', state });
  const tok = decodeURIComponent((cb.headers.location || '').split('#s=')[1] || '');
  const sv = Session.verify(tok, { scope: 'creator', now: () => clock.now(), env: ENV });
  const linkRec = JSON.parse(MAP.get('early:oauth:v1:' + tok.split('.')[4]).value);
  check('C14 the callback issues a legacy-spelled YouTube creator session (<channelId>~<wallet>) bound to the channel from channels.mine', cb.s === 302 && cb.headers.location.startsWith('/labs/early/creator#s=') && tok.split('.')[2] === CH + '~' + W.creator && sv.platform === 'youtube' && sv.externalId === CH && sv.channelId === CH && sv.wallet === W.creator, cb.headers.location);
  check('C15 the link record keeps `channelId` (v1 name of the external id) and records `platform: youtube`; no token is stored', linkRec.platform === 'youtube' && linkRec.channelId === CH && linkRec.wallet === W.creator && linkRec.subscriberCount === 1234 && !JSON.stringify([...MAP.entries()]).includes('tok-1'));
  // a state minted for another platform is not redeemable by the YouTube function (start or callback), and costs no provider call
  const xState = Session.issue({ scope: 'state', wallet: W.creator, platform: 'x', now: () => clock.now(), env: ENV });
  const callsBefore = fetchCalls, keysBefore = domainKeys();
  const s1 = await authCall({ start: xState }), s2 = await authCall({ code: 'code-0123456789abcdef', state: xState });
  check('C16 an X-bound state is refused by the YouTube OAuth function (start and callback): fixed "state" error, no provider call, nothing stored', s1.s === 302 && s1.headers.location.endsWith('#e=state') && s2.s === 302 && s2.headers.location.endsWith('#e=state') && fetchCalls === callsBefore && same(domainKeys(), keysBefore), s1.headers.location + ' ' + s2.headers.location);
}

// ============================================================================================ D. a platform that is not enabled
{
  resetStore(); resetPc();
  const cfg = earlyConfig({ env: ENV, store, now: () => clock.now(), keysFile: TEST_KEYS_FILE });
  check('D01 config (no X settings): only YouTube is enabled; X is described but disabled; platformEnabled is true for youtube and false for x / unknown / prototype names', same(Object.keys(cfg.platforms), ['youtube', 'x']) && cfg.platforms.youtube.enabled === true && cfg.platforms.x.enabled === false && platformEnabled(cfg, 'youtube') && !platformEnabled(cfg, 'x') && !platformEnabled(cfg, 'tiktok') && !platformEnabled(cfg, 'constructor') && !platformEnabled(cfg, '__proto__') && !platformEnabled(cfg, undefined) && Object.isFrozen(cfg.platforms));
  const everything = { ...ENV, SYNCNET_X_ENABLED: 'true', SYNCNET_EARLY_PLATFORMS: 'youtube,x', SYNCNET_X_CLIENT_ID: 'id', SYNCNET_X_CLIENT_SECRET: 'secret', SYNCNET_X_BEARER_TOKEN: 'b', SYNCNET_EARLY_X_OAUTH_REDIRECT: 'https://example.test/api/early-x-auth' };
  const cfg2 = earlyConfig({ env: everything, store, now: () => clock.now(), keysFile: TEST_KEYS_FILE });
  check('D02 X credentials + redirect + generic "enable" style variables WITHOUT the explicit SYNCNET_EARLY_X_ENABLED flag never enable X (full matrix in x.test.mjs)', same(Object.keys(cfg2.platforms), ['youtube', 'x']) && !platformEnabled(cfg2, 'x') && cfg2.x.requested === false);
  check('D03 config view lists exactly the enabled platforms', same((await get('config')).j.platforms, ['youtube']));

  const xId = X_ID, xCreatorId = E.creatorIdOf(xId, 'x'), before = domainKeys();
  const cmiBody = (extra = {}) => { const m = { schema: E.SCHEMA.countMeIn, platform: 'x', channelId: xId, fan: W.fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() }; return { action: 'count-me-in', platform: 'x', externalId: xId, fan: W.fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sign('CountMeIn', m, W.fan), ...extra }; };
  const r1 = await post(cmiBody());
  check('D04 count-me-in for platform x -> 400 "Unsupported platform", nothing stored', r1.s === 400 && /Unsupported platform/.test(r1.j.error) && same(domainKeys(), before), r1.body);
  const wm = { schema: E.SCHEMA.countMeInWithdraw, channelId: xId, fan: W.fan, issuedAt: nowSec(), nonce: rnd32() };
  const r2 = await post({ action: 'count-me-in-withdraw', platform: 'x', externalId: xId, fan: W.fan, issuedAt: wm.issuedAt, nonce: wm.nonce, signature: sign('CountMeInWithdraw', wm, W.fan) });
  check('D05 count-me-in-withdraw for platform x -> 400, nothing stored', r2.s === 400 && /Unsupported platform/.test(r2.j.error) && same(domainKeys(), before), r2.body);
  const lm = { schema: E.SCHEMA.creatorLink, wallet: W.creator, issuedAt: nowSec(), nonce: rnd32() };
  const r3 = await post({ action: 'creator-link', platform: 'x', wallet: W.creator, issuedAt: lm.issuedAt, nonce: lm.nonce, signature: sign('CreatorLinkRequest', lm, W.creator) });
  check('D06 creator-link for platform x -> 400 before any signature work or nonce burn', r3.s === 400 && /Unsupported platform/.test(r3.j.error) && same(domainKeys(), before) && !r3.body.includes('startUrl'), r3.body);
  const r3b = await post({ action: 'creator-link', platform: 'tiktok', wallet: W.creator, issuedAt: lm.issuedAt, nonce: lm.nonce, signature: '0x' });
  check('D07 creator-link for an unknown platform -> 400', r3b.s === 400);
  const g1 = await get('creator', { platform: 'x', externalId: xId });
  check('D08 GET creator for platform x -> 400', g1.s === 400 && /Unsupported platform/.test(g1.j.error));
  // even if a record of another platform somehow existed in the store, no public path serves it
  MAP.set('early:creator:v1:' + xCreatorId, { type: 'string', value: JSON.stringify({ creatorId: xCreatorId, channelId: xId, platform: 'x', status: 'ACTIVE', display: { title: 'X Person' } }), expiresAt: null });
  const g2 = await get('creator', { creatorId: xCreatorId });
  check('D09 GET creator by creatorId of a stored non-enabled platform record -> 400, never served', g2.s === 400 && !g2.body.includes('X Person'), g2.body);
  MAP.delete('early:creator:v1:' + xCreatorId);
  const g3 = await get('creator', { platform: 'x', channelId: xId });
  check('D10 `channelId` is the YouTube spelling only (refused for x even if x were enabled)', g3.s === 400);
  const yt = { resolve: async () => ({ channelId: CH, title: 'Alice', avatarUrl: 'https://yt.example/a.png', handle: '@alice' }) };
  const rs1 = await get('resolve', { platform: 'x', q: '@someone' }, { youtube: yt });
  const rs2 = await get('resolve', { yt: 'https://youtube.com/@alice' }, { youtube: yt });
  const rs3 = await get('resolve', { platform: 'youtube', q: 'https://youtube.com/@alice2' }, { youtube: yt });
  check('D11 resolve: platform x -> 400; the legacy `yt` parameter and platform=youtube&q resolve with {platform, externalId, channelId}', rs1.s === 400 && rs2.s === 200 && rs2.j.channelId === CH && rs2.j.externalId === CH && rs2.j.platform === 'youtube' && rs3.s === 200 && rs3.j.externalId === CH, rs2.body);
  // a creator session of another platform (validly signed) is no session at all
  const before2 = domainKeys();
  const xs = Session.issue({ scope: 'creator', wallet: W.creator, platform: 'x', externalId: xId, now: () => clock.now(), env: ENV });
  const mm = { schema: E.SCHEMA.manifest, creatorId: xCreatorId, platform: 'x', channelId: xId, chainId: 4663, receivingWallet: W.creator, acceptedAssetsHash: E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS)).hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: nowSec(), nonce: rnd32() };
  const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
  const rm = await post({ action: 'creator-manifest', creatorId: xCreatorId, platform: 'x', externalId: xId, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: mm.issuedAt, nonce: mm.nonce, signature: sign('CreatorManifest', mm, W.creator) }, { session: xs });
  const rme = await get('me', {}, { session: xs });
  const rp = await post({ action: 'creator-pause' }, { session: xs });
  const rc = await post({ action: 'rotation-cancel', creatorId: xCreatorId, pendingManifestHash: rnd32() }, { session: xs });
  check('D12 a (validly signed) X creator session is refused everywhere: manifest/me/pause -> 401, rotation-cancel does not treat it as a creator session; nothing stored', rm.s === 401 && rme.s === 401 && rp.s === 401 && rc.s !== 200 && same(domainKeys(), before2), [rm.s, rme.s, rp.s, rc.s].join());
  // a signed link/session of the right platform but a DIFFERENT id is not the manifest's id
  const mm2 = { ...mm, platform: 'youtube', channelId: CH2, creatorId: E.creatorIdOf(CH2) };
  const ys = creatorSession(store, { channelId: CH, wallet: W.creator });
  const rmm = await post({ action: 'creator-manifest', creatorId: mm2.creatorId, channelId: CH2, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: mm2.issuedAt, nonce: mm2.nonce, signature: sign('CreatorManifest', mm2, W.creator) }, { session: ys });
  check('D13 a manifest naming another channel than the session proved -> 403 channel_mismatch', rmm.s === 403 && rmm.j.code === 'channel_mismatch', rmm.body);
  const ym = { ...mm, platform: 'youtube', channelId: CH, creatorId: E.creatorIdOf(CH) };
  const rxm = await post({ action: 'creator-manifest', creatorId: ym.creatorId, platform: 'x', externalId: xId, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: ym.issuedAt, nonce: ym.nonce, signature: sign('CreatorManifest', ym, W.creator) }, { session: ys });
  check('D14 a YouTube session cannot be used to publish a manifest for an X identity -> 403', rxm.s === 403 && rxm.j.code === 'channel_mismatch', rxm.body);
  // `channelId` and `externalId` are the same thing for YouTube: either spelling stores the identical record under the identical key
  resetStore();
  const send = async (spelling) => { const m = { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId: CH, fan: W.fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() }; const body = { action: 'count-me-in', fan: W.fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sign('CountMeIn', m, W.fan), ...spelling }; return post(body); };
  const a1 = await send({ channelId: CH });
  const k1 = domainKeys().filter((k) => k.startsWith('early:cmi')); const rec1 = JSON.parse(MAP.get('early:cmi:v1:' + CH + ':' + W.fan).value);
  resetStore();
  const a2 = await send({ platform: 'youtube', externalId: CH });
  const k2 = domainKeys().filter((k) => k.startsWith('early:cmi')); const rec2 = JSON.parse(MAP.get('early:cmi:v1:' + CH + ':' + W.fan).value);
  check('D15 Count me in by {channelId} and by {platform, externalId} write the same keys and the same signed struct', a1.s === 201 && a2.s === 201 && same(k1, k2) && same(rec1.struct, { ...rec2.struct, issuedAt: rec1.struct.issuedAt, expiry: rec1.struct.expiry, nonce: rec1.struct.nonce }) && rec1.struct.platform === 'youtube' && rec1.struct.channelId === CH && a1.j.signal.channelId === CH && a1.j.signal.externalId === CH && a1.j.signal.platform === 'youtube');
  const a3 = await send({ channelId: CH, externalId: CH2 });
  const a4 = await send({ channelId: CH, platform: 'youtube', externalId: CH });
  check('D16 conflicting spellings are refused; agreeing ones are accepted (a repeat signal is a renewal)', a3.s === 400 && /differ/.test(a3.j.error) && a4.s === 200 && a4.j.signal.channelId === CH, a3.body + a4.body);
  const a5 = await send({ channelId: 12345 });
  const a6 = await send({ channelId: X_ID });
  const a7 = await send({ channelId: '@alice' });
  check('D17 non-string / wrong-shape ids are refused with the legacy message', [a5, a6, a7].every((r) => r.s === 400 && r.j.error === 'Invalid channel id.'), [a5.body, a6.body, a7.body].join('|'));
}

// ============================================================================================ E. stored-data shape unchanged
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/early/legacy/youtube-state.v1.json'), 'utf8'));
const norm = (k) => k.replace(/0x[0-9a-f]{64}/g, '<b32>').replace(/0x[0-9a-f]{40}/g, '<addr>').replace(/\d{4}-\d{2}-\d{2}/g, '<date>').replace(/:[0-9a-f]{16,64}(?=:|$)/g, ':<hex>').replace(/:\d+(?=:|$)/g, ':<n>');
const fields = (v) => { try { const j = JSON.parse(v); return j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j).sort() : null; } catch { return null; } };
const attShape = (v) => { try { const j = JSON.parse(v); return j && j.claims ? j.type + '|subject:' + Object.keys(j.subject).sort() + '|claims:' + Object.keys(j.claims).sort() : null; } catch { return null; } };
function shapeOf(entries) {
  const keys = [], recs = {}, atts = new Set();
  for (const [k, e] of entries) {
    if (!k.startsWith('early:')) continue;
    const nk = norm(k); keys.push(nk);
    if (e.type === 'string') { const f = fields(e.value); if (f) recs[nk] = f; const a = attShape(e.value); if (a) atts.add(a); }
  }
  return { keys: keys.sort(), recs, atts: [...atts].sort() };
}
const fixtureEntries = FX.entries.map(([k, e]) => [k, e]);
/** The exact scenario make-legacy-state.mjs ran, replayed here against the CURRENT code at the same instant. */
async function runScenario() {
  const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }, { token: SYNC, minAmount: '1000000000000000000' }], E.parseAssetList(ASSETS));
  for (const [channelId, fan] of [[CH, W.fan2], [CH2, W.fan]]) { const m = { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId, fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() }; await post({ action: 'count-me-in', channelId, fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sign('CountMeIn', m, fan) }); }
  const tok = creatorSession(store, { channelId: CH, wallet: W.creator, title: 'Alice', subscriberCount: 1234 });
  const mm = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: nowSec(), nonce: rnd32() };
  const act = await post({ action: 'creator-manifest', creatorId: mm.creatorId, channelId: CH, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: mm.issuedAt, nonce: mm.nonce, signature: sign('CreatorManifest', mm, W.creator) }, { session: tok });
  const d = await post({ action: 'intent-draft', manifestHash: E.digest('CreatorManifest', mm), sender: W.fan, token: USDG, amount: '1500000' });
  const st = await post({ action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) });
  const p = pay({ from: W.fan, to: W.creator, amount: '1500000' }); makeFinal(p.blockNumber);
  const v = await post({ action: 'verify', intentId: st.j.intent.intentId, txHash: p.txHash });
  const card = await post({ action: 'card-create', receiptId: v.j.receiptId }, { session: fanSession(W.fan) });
  return { act, v, card, intentId: st.j.intent.intentId };
}
{
  clock.t = FX.clockMs; resetStore(); resetPc();
  const run = await runScenario();
  check('E01 the legacy scenario runs to a FINALIZED receipt and a card on the current code', run.act.s === 201 && run.v.j.status === 'FINALIZED' && run.card.s === 201, [run.act.s, run.v.j.status, run.card.s].join());
  const fresh = shapeOf([...MAP.entries()].map(([k, e]) => [k, { type: e.type, value: e.value }]));
  const legacy = shapeOf(fixtureEntries);
  const onlyNew = fresh.keys.filter((k) => !legacy.keys.includes(k)), onlyOld = legacy.keys.filter((k) => !fresh.keys.includes(k));
  check('E02 the current code stores EXACTLY the legacy key set (no new, no missing, no renamed key)', same(fresh.keys, legacy.keys), JSON.stringify({ onlyNew, onlyOld }));
  const diffs = [];
  for (const k of new Set([...Object.keys(fresh.recs), ...Object.keys(legacy.recs)])) {
    const a = fresh.recs[k] || [], b = legacy.recs[k] || [];
    const added = a.filter((f) => !b.includes(f)), removed = b.filter((f) => !a.includes(f));
    if (added.length || removed.length) diffs.push({ k, added, removed });
  }
  check('E03 every stored record has EXACTLY the legacy top-level fields (nothing added, nothing removed)', diffs.length === 0, JSON.stringify(diffs));
  check('E04 every attestation type has the legacy subject and claim keys (YouTube keeps `channelId`; none gained `externalId`/`audienceKind`)', same(fresh.atts, legacy.atts) && !fresh.atts.some((a) => /externalId|audienceKind/.test(a)), JSON.stringify({ fresh: fresh.atts, legacy: legacy.atts }));
  const cmi = JSON.parse(MAP.get('early:cmi:v1:' + CH + ':' + W.fan2).value), cr = JSON.parse(MAP.get('early:creator:v1:' + E.creatorIdOf(CH)).value);
  check('E05 YouTube refs: the CMI and snapshot keys use the bare channel id, the creator record says platform youtube', cmi.struct.platform === 'youtube' && cmi.struct.channelId === CH && cr.platform === 'youtube' && cr.channelId === CH && MAP.has('early:cmi-set:v1:' + CH) && [...MAP.get('early:cmi-of:v1:' + W.fan2).value].join() === CH && [...MAP.keys()].some((k) => k.startsWith('early:snap:v1:' + CH + ':')) && ![...MAP.keys()].some((k) => /early:(cmi|snap)[a-z-]*:v1:(youtube|x):/.test(k)));
}

// ============================================================================================ F. legacy replay
{
  clock.t = FX.clockMs + 60000; resetStore(); resetPc();
  for (const [k, e] of FX.entries) MAP.set(k, { type: e.type, value: e.type === 'set' ? new Set(e.value) : e.type === 'zset' ? new Map(e.value) : e.value, expiresAt: e.expiresAt });
  const { ids, tokens } = FX;
  const cv = (await get('creator', { channelId: ids.channel })).j;
  check('F01 legacy creator is served by the old `channelId` query AND the new {platform, externalId} query, identically', cv.onEarly === true && cv.channelId === CH && cv.platform === 'youtube' && cv.externalId === CH && cv.creatorId === ids.creatorId && cv.acceptsSupport === true && same((await get('creator', { platform: 'youtube', externalId: CH })).j, cv) && same((await get('creator', { creatorId: ids.creatorId })).j, cv), JSON.stringify(cv).slice(0, 200));
  check('F02 an unclaimed legacy channel and an unknown channel answer identically', same((await get('creator', { channelId: ids.unclaimedChannel })).j, { onEarly: false }) && same((await get('creator', { channelId: 'UCzzzzzzzzzzzzzzzzzzzzzz' })).j, { onEarly: false }));
  const rcpt = (await get('receipt', { intent: ids.intentId })).j.receipt;
  const withoutKind = JSON.parse(JSON.stringify(rcpt)); delete withoutKind.context.audienceThen.kind;
  check('F03 the legacy receipt is served unchanged: the document equals the one the old code produced (the only addition is audienceThen.kind)', same(withoutKind, FX.receipt) && rcpt.context.audienceThen.kind === 'subscribers' && rcpt.context.audienceThen.state === 'approximate' && rcpt.context.audienceThen.display === '~1.2K' && rcpt.receiptId === ids.receiptId && rcpt.creatorManifest.manifestHash === ids.manifestHash, JSON.stringify(rcpt.context));
  const v1 = await verifyReceipt(rcpt, { registry: TEST_KEYS_FILE, bundles: {} });
  const v2 = await verifyReceipt(FX.receipt, { registry: TEST_KEYS_FILE, bundles: {} });
  const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/early/legacy/youtube-receipt.v1.json'), 'utf8')).receipt;
  const v3 = await verifyReceipt(frozen, { registry: TEST_KEYS_FILE, bundles: {} });
  check('F04 RECEIPT VERIFIED by the independent verifier: the receipt re-served by the current code, the one the old code produced, and the frozen b4fccd5 sample receipt', v1.ok && v2.ok && v3.ok && v3.checks.some((c) => c.id === 'manifest-signer' && c.ok) && v3.checks.some((c) => c.id === 'att-creator-identity' && c.ok), JSON.stringify([v1, v2, v3].map((v) => v.checks.filter((c) => !c.ok))));
  const tam = JSON.parse(JSON.stringify(frozen)); tam.creatorManifest.typedData.message.platform = 'x'; tam.creatorManifest.typedData.message.channelId = X_ID;
  const vt = await verifyReceipt(tam, { registry: TEST_KEYS_FILE, bundles: {} });
  check('F05 relabelling a legacy receipt\'s creator as an X identity breaks verification (platform + id are signed)', !vt.ok && vt.checks.some((c) => !c.ok && /manifest/.test(c.id)));
  const card = (await get('card', { shareId: ids.shareId })).j.card;
  check('F06 the legacy card still renders: creator title, YouTube channel id, audience, no wallet/amount/tx', card && card.creator === 'Alice' && card.creatorChannelId === CH && card.creatorPlatform === 'youtube' && card.creatorExternalId === CH && card.creatorId === ids.creatorId && card.audienceThen.kind === 'subscribers' && card.wallet === null && card.amount === null && card.transaction === null);
  const mine = (await get('mine', {}, { session: tokens.fan })).j;
  check('F07 the old fan session still opens "mine": the legacy receipt and the legacy signal for the unclaimed creator (bare-id ref)', mine.receipts.length === 1 && mine.receipts[0].receiptId === ids.receiptId && mine.signals.length === 1 && mine.signals[0].channelId === CH2 && mine.signals[0].externalId === CH2 && mine.signals[0].platform === 'youtube' && mine.signals[0].creatorOnEarly === false, JSON.stringify(mine.signals));
  const sm = { schema: E.SCHEMA.session, wallet: W.fan2, issuedAt: nowSec(), nonce: rnd32() };
  const sess2 = (await post({ action: 'session', wallet: W.fan2, issuedAt: sm.issuedAt, nonce: sm.nonce, signature: sign('EarlySession', sm, W.fan2) })).j.session;
  const mine2 = (await get('mine', {}, { session: sess2 })).j;
  check('F08 the legacy signal that waited for the creator is frozen at join and now resolves to the creator', mine2.signals.length === 1 && mine2.signals[0].channelId === CH && mine2.signals[0].status === 'FROZEN' && mine2.signals[0].creatorOnEarly === true && mine2.signals[0].creatorId === ids.creatorId, JSON.stringify(mine2.signals));
  const me = await get('me', {}, { session: tokens.creator });
  check('F09 the legacy creator session (issued by the old code) still opens the dashboard', me.s === 200 && me.j.channelId === CH && me.j.platform === 'youtube' && me.j.creator && me.j.creator.creatorId === ids.creatorId, me.body.slice(0, 200));
  const sig2 = await early._internals.countSignals(store, CH, nowSec());
  check('F10 countSignals reads the legacy bare-id key set', sig2 === 1 && (await early._internals.countSignals(store, E.refOf('youtube', CH), nowSec())) === 1);
  const paused = await post({ action: 'creator-pause' }, { session: tokens.creator });
  const resumed = await post({ action: 'creator-resume' }, { session: tokens.creator });
  check('F11 pause / resume work with the legacy creator session on the legacy creator record', paused.s === 200 && paused.j.paused === true && resumed.s === 200 && resumed.j.paused === false);
  const wm = { schema: E.SCHEMA.countMeInWithdraw, channelId: CH, fan: W.fan2, issuedAt: nowSec(), nonce: rnd32() };
  const wd = await post({ action: 'count-me-in-withdraw', channelId: CH, fan: W.fan2, issuedAt: wm.issuedAt, nonce: wm.nonce, signature: sign('CountMeInWithdraw', wm, W.fan2) });
  check('F12 a signal written by the old code can be withdrawn with the (unchanged) withdraw signature', wd.s === 200 && JSON.parse(MAP.get('early:cmi:v1:' + CH + ':' + W.fan2).value).status === 'WITHDRAWN', wd.body);
  // continue serving: a brand-new support on the legacy manifest, on the same chain mock
  const d = await post({ action: 'intent-draft', manifestHash: ids.manifestHash, sender: W.fan, token: USDG, amount: '1600000' });
  const s = await post({ action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) });
  const p = pay({ from: W.fan, to: W.creator, amount: '1600000' }); makeFinal(p.blockNumber);
  const vv = await post({ action: 'verify', intentId: d.j.intentId, txHash: p.txHash });
  const doc2 = (await get('receipt', { intent: d.j.intentId })).j.receipt;
  const vr2 = await verifyReceipt(doc2, { registry: TEST_KEYS_FILE, bundles: {} });
  check('F13 a NEW support on the legacy manifest works end to end and its receipt verifies independently', d.s === 201 && s.s === 201 && vv.j.status === 'FINALIZED' && vr2.ok && doc2.creatorManifest.manifestHash === ids.manifestHash && doc2.context.audienceThen.kind === 'subscribers', JSON.stringify(vr2.checks.filter((c) => !c.ok)));
  check('F14 the creator\'s receipt index holds both receipts under the unchanged creatorId key', [...MAP.get('early:receipts-of-creator:v1:' + ids.creatorId).value].length === 2);
  // a legacy-shaped link (no `platform`) is a YouTube link; a link that says another platform is not
  const rot = async (linkPatch) => {
    const tk = creatorSession(store, { channelId: CH, wallet: W.creator2 });
    const sid = tk.split('.')[4], lk = JSON.parse(MAP.get('early:oauth:v1:' + sid).value);
    MAP.set('early:oauth:v1:' + sid, { type: 'string', value: JSON.stringify({ ...lk, ...linkPatch }), expiresAt: clock.now() + 900000 });
    const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
    const m = { schema: E.SCHEMA.manifest, creatorId: ids.creatorId, platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator2, acceptedAssetsHash: na.hash, manifestVersion: 2, previousManifestHash: ids.manifestHash, issuedAt: nowSec(), nonce: rnd32() };
    return post({ action: 'creator-manifest', creatorId: m.creatorId, channelId: CH, receivingWallet: W.creator2, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 2, previousManifestHash: ids.manifestHash, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorManifest', m, W.creator2) }, { session: tk });
  };
  const badLink = await rot({ platform: 'x' });
  check('F15 a link record that names another platform does not satisfy a YouTube session -> 403 reverify', badLink.s === 403 && badLink.j.code === 'reverify', badLink.body);
  const goodLink = await rot({});
  check('F16 a legacy-shaped link record (no `platform`) starts a wallet rotation on the legacy creator', goodLink.s === 201 && goodLink.j.pendingManifest && goodLink.j.pendingManifest.manifestVersion === 2, goodLink.body);
  // the daily snapshot job, on the next UTC day, writes under the legacy bare-id key and never touches other platforms' creators
  clock.advance(86400);
  const xCid = E.creatorIdOf(X_ID, 'x');
  MAP.set('early:creator:v1:' + xCid, { type: 'string', value: JSON.stringify({ creatorId: xCid, channelId: X_ID, platform: 'x', status: 'ACTIVE', display: { title: 'X Person', avatarUrl: '', handle: '' } }), expiresAt: null });
  MAP.get('early:creators:v1').value.add(xCid);
  const seenIds = []; const ytClient = { channelsById: async (ids2) => { seenIds.push(...ids2); return new Map(ids2.map((id) => [id, { channelId: id, title: 'Alice Renamed', avatarUrl: 'https://yt.example/new.png', handle: '@alice2', subscriberCount: 2222, hidden: false }])); } };
  const job = parse(await snapJob._handler({}, { store, env: ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, youtube: ytClient }));
  const today = E.utcDate(nowSec()), snapKey = 'early:snap:v1:' + CH + ':' + today;
  const snapRec = MAP.has(snapKey) ? JSON.parse(MAP.get(snapKey).value) : null;
  check('F17 snapshot job: the legacy creator gets today\'s snapshot under the bare-id key with the legacy claim shape; display metadata refreshes', job.s === 200 && job.j.report.snapshots === 1 && snapRec && snapRec.claims.subscriberCount === 2222 && snapRec.claims.channelId === CH && !('audienceKind' in snapRec.claims) && JSON.parse(MAP.get('early:creator:v1:' + ids.creatorId).value).display.title === 'Alice Renamed', JSON.stringify(job.j));
  check('F18 snapshot job: a creator of a platform with no adapter is skipped - never sent to the YouTube client, never recorded, not a failure', !seenIds.includes(X_ID) && !MAP.has('early:snap:v1:x:' + X_ID + ':' + today) && ![...MAP.keys()].some((k) => k.startsWith('early:snap:v1:x:')) && job.j.report.snapshotFailures === 0, JSON.stringify({ seenIds, report: job.j.report }));
  check('F19 the legacy enrolment snapshot of the join day is untouched (earlier day, bare-id key)', MAP.has('early:snap:v1:' + CH + ':' + E.utcDate(Math.floor(FX.clockMs / 1000))) && [...MAP.get('early:snap-days:v1:' + CH).value].length === 2);
  check('F20 across the whole replay no key of the form early:(cmi|snap):v1:<platform>: was ever created for YouTube', ![...MAP.keys()].some((k) => /early:(cmi|snap)[a-z-]*:v1:(youtube):/.test(k)));
}

// ============================================================================================ G. generic code, second platform "enabled"
{
  const cfgBoth = { platforms: { youtube: { enabled: true }, x: { enabled: true } } };
  const idf = early._internals.identityFrom;
  const a = idf(cfgBoth, { platform: 'x', externalId: X_ID });
  check('G01 identityFrom(x): id, ref and creatorId all derive from the named platform', a.platform === 'x' && a.externalId === X_ID && a.ref === 'x:' + X_ID && a.creatorId === E.creatorIdOf(X_ID, 'x') && !a.error);
  const y = idf(cfgBoth, { channelId: CH });
  check('G02 identityFrom with only the legacy `channelId` is YouTube, with the legacy ref and creatorId', y.platform === 'youtube' && y.ref === CH && y.creatorId === PINNED.creatorId);
  const bad = [
    { platform: 'x', externalId: CH }, { platform: 'youtube', externalId: X_ID }, { platform: 'x', channelId: X_ID }, { platform: 'x', externalId: X_ID, channelId: X_ID },
    { externalId: X_ID }, { platform: 'youtube', externalId: CH, channelId: CH2 }, { platform: 'tiktok', externalId: X_ID }, { platform: 'x', externalId: Number(X_ID) },
    { platform: 'x', externalId: '@elonmusk' }, { platform: 'x' }, {}, { platform: 'constructor', externalId: X_ID }, { platform: ['x'], externalId: X_ID }, { platform: 'x', externalId: [X_ID] },
  ];
  check('G03 identityFrom never crosses identities: wrong platform/id pairs, mixed spellings, handles, numbers, arrays and junk are all errors', bad.every((s) => typeof idf(cfgBoth, s).error === 'string'), JSON.stringify(bad.filter((s) => !idf(cfgBoth, s).error)));
  check('G04 identityFrom refuses a registered-but-not-enabled platform', typeof idf({ platforms: { youtube: { enabled: true } } }, { platform: 'x', externalId: X_ID }).error === 'string' && typeof idf({ platforms: { youtube: { enabled: true }, x: { enabled: 'true' } } }, { platform: 'x', externalId: X_ID }).error === 'string' && typeof idf({ platforms: {} }, { channelId: CH }).error === 'string' && typeof idf({}, { channelId: CH }).error === 'string');
  const I = early._internals;
  const xc = I.publicCreator({ creatorId: E.creatorIdOf(X_ID, 'x'), channelId: X_ID, platform: 'x', display: { title: 'T' }, status: 'ACTIVE', paused: false, joinedAt: 1 }, null);
  const yc = I.publicCreator({ creatorId: PINNED.creatorId, channelId: CH, platform: 'youtube', display: { title: 'T' }, status: 'ACTIVE', paused: false, joinedAt: 1 }, null);
  const lc0 = I.publicCreator({ creatorId: PINNED.creatorId, channelId: CH, display: { title: 'T' }, status: 'ACTIVE', paused: false, joinedAt: 1 }, null);
  check('G05 public creator shape: always {platform, externalId}; only YouTube also carries the legacy `channelId`; a pre-platform record (no platform field) is YouTube', xc.platform === 'x' && xc.externalId === X_ID && !('channelId' in xc) && yc.platform === 'youtube' && yc.externalId === CH && yc.channelId === CH && lc0.platform === 'youtube' && lc0.channelId === CH);
  const sig = (platform, channelId) => ({ struct: { platform, channelId, expiry: 4e9 }, status: 'ACTIVE', createdAt: 'x', renewedAt: [] });
  const xs = I.publicSignal(sig('x', X_ID), null), ys = I.publicSignal(sig('youtube', CH), null), ls = I.publicSignal({ struct: { channelId: CH, expiry: 4e9 }, status: 'ACTIVE' }, null);
  check('G06 public signal shape follows the same rule', xs.platform === 'x' && xs.externalId === X_ID && !('channelId' in xs) && ys.channelId === CH && ls.platform === 'youtube' && ls.channelId === CH);
  const man = (platform, channelId) => I.publicManifest({ manifestHash: '0x' + '1'.repeat(64), creatorId: '0x' + '2'.repeat(64), channelId, struct: { platform, manifestVersion: 1, receivingWallet: W.creator, previousManifestHash: E.ZERO32 }, acceptedAssets: [], status: 'ACTIVE' });
  check('G07 public manifest shape follows the same rule', man('x', X_ID).externalId === X_ID && !('channelId' in man('x', X_ID)) && man('youtube', CH).channelId === CH && man('youtube', CH).platform === 'youtube');
  check('G08 attestation field names: audience-snapshot claims of another platform would use `externalId`, YouTube keeps `channelId` (pinned in B20-B22)', same(Platforms.idFields('youtube', CH), { channelId: CH }) && same(Platforms.idFields('x', X_ID), { externalId: X_ID }));
  // CountMeInWithdraw signs only the id: an id of one platform cannot be withdrawn "as" another platform (guard in the handler)
  check('G09 the withdraw guard: platformOfId(id) must equal the named platform', E.platformOfId(CH) === 'youtube' && E.platformOfId(X_ID) === 'x' && E.platformOfId(CH) !== 'x' && E.platformOfId(X_ID) !== 'youtube');
}

// ============================================================================================ H. nothing of another platform is wired in
{
  const exists = (p) => fs.existsSync(path.join(ROOT, p));
  const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  check('H01 the X client, X OAuth function and their single route exist (the function answers closed unless X is explicitly enabled)', exists('netlify/lib/early-x.js') && exists('netlify/functions/early-x-auth.js') && /\/api\/early-x-auth/.test(text('netlify.toml')) && /\/api\/early-x-auth /.test(text('_redirects')));
  const code = ['lib/syncnet-early.js', 'netlify/functions/early.js', 'netlify/functions/early-snapshot.js', 'netlify/functions/early-youtube-auth.js', 'netlify/lib/early-session.js'].map(text).join('\n');
  check('H02 X env var names, X API hosts and X OAuth endpoints appear only in the X modules, config and platform registry - not in the shared server code or the protocol lib', !/SYNCNET_X_|EARLY_X_|api\.x\.com|api\.twitter\.com|x\.com\/i\/oauth2|twitter\.com|oauth2\/token/.test(code));
  check('H03 the HTML pages carry no X markup or copy (the X UI is created by script only when the server enables it; tests/e2e/early-ui-x.mjs)', !/\bX\b (creator|account|username)|Continue with X|ePlatform|cLinkX|x\.com|twitter/i.test(text('labs-early.html') + text('labs-early-creator.html')));
}

fs.writeFileSync(path.join(ROOT, 'tests/early/platform.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early platform checks passed`);
process.exit(failures ? 1 : 0);
