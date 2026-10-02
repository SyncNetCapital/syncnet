// Generates tests/early/legacy/youtube-state.v1.json: the COMPLETE stored state a YouTube-only deployment (code at
// b4fccd5, before platforms existed) wrote while serving one creator end to end: a Count me in signal that waited for the
// creator, creator activation (manifest v1 + enrolment snapshot), a fan intent, a matched FINALIZED receipt, an EARLY card,
// plus a signal for a creator that never joined.
//
// It is meant to be run ONCE, from a checkout of the pre-platform code, never from the current tree:
//     git archive b4fccd5 | tar -x -C <dir>        # then copy this file to <dir>/tests/early/legacy/
//     node <dir>/tests/early/legacy/make-legacy-state.mjs <out.json>
// The committed fixture is what tests/early/legacy-state.test.mjs replays against the CURRENT code: stored keys, stored
// records, issued session tokens and the downloadable receipt must all keep working, byte for byte.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, SYNC, CH, CH2, clock, resetPc, pay, makeFinal, rpc, MAP, makeStore, resetStore, creatorSession, fanSession } from '../fixtures.mjs';

const require = createRequire(import.meta.url);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access'); }; }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const out = process.argv[2];
if (!out) { console.error('usage: make-legacy-state.mjs <out.json>'); process.exit(2); }

clock.t = Date.UTC(2026, 9, 5, 12, 0, 0); // fixed instant: the fixture is deterministic apart from its random ids
resetStore(); resetPc();
const store = makeStore();
let ipSeq = 0;
const call = async (method, body, query, over = {}) => { const r = await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': '198.51.100.' + (ipSeq++ % 250), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE }); let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j }; };
const nowSec = () => Math.floor(clock.now() / 1000);
const must = (r, what) => { if (r.s !== 200 && r.s !== 201) throw new Error(what + ' failed: ' + r.s + ' ' + JSON.stringify(r.j)); return r; };

// 1. fan2 signals interest in CH before the creator joins; fan signals interest in CH2, which never joins
for (const [channelId, fan] of [[CH, W.fan2], [CH2, W.fan]]) {
  const m = { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId, fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() };
  must(await call('POST', { action: 'count-me-in', channelId, fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sign('CountMeIn', m, fan) }), 'count-me-in');
}
// 2. the creator joins (OAuth link record + creator session exactly as the callback writes them)
const creatorToken = creatorSession(store, { channelId: CH, wallet: W.creator, title: 'Alice', subscriberCount: 1234 });
const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }, { token: SYNC, minAmount: '1000000000000000000' }], E.parseAssetList(ASSETS));
const mm = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: nowSec(), nonce: rnd32() };
const manifestHash = E.digest('CreatorManifest', mm);
must(await call('POST', { action: 'creator-manifest', creatorId: mm.creatorId, channelId: CH, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: mm.issuedAt, nonce: mm.nonce, signature: sign('CreatorManifest', mm, W.creator) }, null, { session: creatorToken }), 'creator-manifest');
// 3. a fan intent, the transfer, the verified receipt, the card
const d = must(await call('POST', { action: 'intent-draft', manifestHash, sender: W.fan, token: USDG, amount: '1500000' }), 'intent-draft');
const st = must(await call('POST', { action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) }), 'intent-store');
const p = pay({ from: W.fan, to: W.creator, amount: '1500000' }); makeFinal(p.blockNumber);
const v = must(await call('POST', { action: 'verify', intentId: st.j.intent.intentId, txHash: p.txHash }), 'verify');
if (v.j.status !== 'FINALIZED') throw new Error('expected FINALIZED, got ' + v.j.status);
const fanToken = fanSession(W.fan);
const card = must(await call('POST', { action: 'card-create', receiptId: v.j.receiptId }, null, { session: fanToken }), 'card-create');
const receiptDoc = must(await call('GET', null, { view: 'receipt', intent: st.j.intent.intentId }), 'receipt').j.receipt;

const dump = [];
for (const [k, e] of [...MAP.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const value = e.type === 'set' ? [...e.value].sort() : e.type === 'zset' ? [...e.value.entries()] : e.value;
  dump.push([k, { type: e.type, value, expiresAt: e.expiresAt }]);
}
fs.writeFileSync(out, JSON.stringify({
  schema: 'syncnet.early.legacy-state.v1', generatedBy: 'b4fccd57b3d01709c1d1fdd5465bd3731156da1b', clockMs: clock.t,
  ids: { channel: CH, unclaimedChannel: CH2, creatorId: E.creatorIdOf(CH), manifestHash, intentId: st.j.intent.intentId, receiptId: v.j.receiptId, shareId: card.j.shareId, txHash: p.txHash },
  tokens: { creator: creatorToken, fan: fanToken },
  receipt: receiptDoc, entries: dump,
}, null, 1));
console.log('wrote ' + dump.length + ' stored keys to ' + out);
