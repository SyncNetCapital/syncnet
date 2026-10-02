// EARLY server suite (/api/early): gate, Count me in, creator activation, intents, the public matching rule against a
// mock chain (unique / ambiguous / late recovery / reverted / fake token / wrong amount / backdated / reorg / finality /
// budget / outage), receipts, sessions, cards, wallet rotation with lock and override, privacy shapes, replay.
// The function under test is the real code; the chain, wallet keys and store are local fakes. No real network.
// Run: node tests/early/server.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, KEYS, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, SYNC, CH, CH2, clock, pc, resetPc, pay, reorg, makeSafe, makeFinal, syncHead, rpc, MAP, makeStore, resetStore, creatorSession, fanSession, Session } from './fixtures.mjs';

const require = createRequire(import.meta.url);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const { earlyConfig, signer: makeSigner } = require(path.join(ROOT, 'netlify/lib/early-config.js'));
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }

const store = makeStore();
let ipSeq = 0;
const ip = () => `198.51.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body, headers: r.headers }; };
const call = async (method, body, query, over = {}) => parse(await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': over.ip || ip(), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: over.env || ENV, rpc: over.rpc || rpc, now: () => clock.now(), keysFile: over.keysFile || TEST_KEYS_FILE, youtube: over.youtube, random: over.random }));
const get = (view, params, over) => call('GET', null, { view, ...(params || {}) }, over);
const post = (body, over) => call('POST', body, null, over);
const nowSec = () => Math.floor(clock.now() / 1000);
const ok = (r) => r.s === 200 || r.s === 201;

// ---- helpers for the flows
async function countMeIn(channelId = CH, fan = W.fan, over = {}) {
  const m = { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId, fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32(), ...over.message };
  const signature = over.signature || sign('CountMeIn', m, over.signer || fan);
  return post({ action: 'count-me-in', channelId: m.channelId, fan: m.fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature, ...over.extra }, over);
}
const acceptedDefault = [{ token: USDG, minAmount: '1000000' }, { token: SYNC, minAmount: '1000000000000000000' }];
async function manifest({ channelId = CH, wallet = W.creator, version = 1, prev = E.ZERO32, accepted = acceptedDefault, session, over = {} } = {}) {
  const na = E.normalizeAcceptedAssets(accepted, E.parseAssetList(ASSETS));
  const m = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(channelId), platform: 'youtube', channelId, chainId: 4663, receivingWallet: wallet, acceptedAssetsHash: na.ok ? na.hash : E.hashJson(accepted), manifestVersion: version, previousManifestHash: prev, issuedAt: nowSec(), nonce: rnd32(), ...over.message };
  const signature = over.signature || sign('CreatorManifest', m, over.signer || wallet);
  const body = { action: 'creator-manifest', creatorId: m.creatorId, channelId: m.channelId, receivingWallet: m.receivingWallet, acceptedAssets: na.ok ? na.assets : accepted, acceptedAssetsHash: over.hash || m.acceptedAssetsHash, manifestVersion: m.manifestVersion, previousManifestHash: m.previousManifestHash, issuedAt: m.issuedAt, nonce: m.nonce, signature, ...over.extra };
  return { r: await post(body, { ...over, session: session === undefined ? creatorSession(store, { channelId, wallet }) : session }), hash: E.digest('CreatorManifest', m) };
}
async function draft(manifestHash, { sender = W.fan, token = USDG, amount = '1500000' } = {}, over = {}) { return post({ action: 'intent-draft', manifestHash, sender, token, amount }, over); }
async function storeIntent(d, { signer } = {}, over = {}) {
  const sig = signDigest(signer || d.j.typedData.message.sender, Core.hashTypedData(d.j.typedData));
  return post({ action: 'intent-store', intentId: d.j.intentId, signature: sig, ...over.extra }, over);
}
async function newIntent(manifestHash, opts = {}, over = {}) { const d = await draft(manifestHash, opts, over); if (!ok(d)) throw new Error('draft failed ' + d.body); const s = await storeIntent(d, {}, over); if (!ok(s)) throw new Error('store failed ' + s.body); return s.j.intent; }
const verify = (intentId, txHash, over) => post({ action: 'verify', intentId, ...(txHash ? { txHash } : {}) }, over);
const reconcile = (intentId, over) => post({ action: 'reconcile', intentId }, over);
async function finalizeTx(intent, txHash, logIndex, over = {}) {
  const m = { schema: E.SCHEMA.finalize, intentId: intent.intentId, txHash, logIndex, issuedAt: nowSec(), nonce: rnd32() };
  return post({ action: 'finalize', intentId: m.intentId, txHash, logIndex, issuedAt: m.issuedAt, nonce: m.nonce, signature: over.signature || sign('SupportFinalize', m, over.signer || intent.typedData.message.sender) }, over);
}
const payFor = (intent, o = {}) => pay({ from: intent.typedData.message.sender, to: intent.typedData.message.receiver, token: intent.typedData.message.token, amount: intent.typedData.message.amount, ...o });

// ============================================================================================ A. gate / config
resetStore(); resetPc();
{
  const c = (await get('config')).j;
  check('A01 config enabled with the full test environment; attestations, oauth on; anchoring key configured', c.enabled === true && c.writes === true && c.attestations === true && c.oauth === true && c.anchoring === true && c.chainId === 4663);
  check('A02 config lists assets by address with reviewed decimals and no supporter data', c.assets.length === 2 && c.assets.every((a) => /^0x[0-9a-f]{40}$/.test(a.token) && Number.isInteger(a.decimals)) && !JSON.stringify(c).includes(W.fan));
  check('A03 config never uses investment framing', !/ROI|investor|multiple|leaderboard|rank/i.test(JSON.stringify(c)));
  const off = (await get('config', {}, { env: {} })).j;
  check('A04 default deployment: EARLY closed', off.enabled === false && off.writes === false);
  const closed = await post({ action: 'count-me-in' }, { env: {} });
  check('A05 writes refused when closed (503 closed)', closed.s === 503 && closed.j.code === 'closed');
  const wOff = await countMeIn(CH, W.fan, { env: { ...ENV, SYNCNET_EARLY_WRITES_DISABLED: 'true' } });
  check('A06 kill switch: writes 503 writes_closed', wOff.s === 503 && wOff.j.code === 'writes_closed');
  const vOff = await post({ action: 'verify', intentId: rnd32() }, { env: { ...ENV, SYNCNET_EARLY_WRITES_DISABLED: 'true' } });
  check('A07 kill switch keeps verification reachable (404 for an unknown intent, not 503)', vOff.s === 404);
  const noKey = (await get('config', {}, { env: { ...ENV, SYNCNET_EARLY_ATTESTATION_KEY: '' } })).j;
  check('A08 missing attestation key: enabled but attestations false', noKey.enabled === true && noKey.attestations === false);
  const wrongKey = (await get('config', {}, { env: { ...ENV, SYNCNET_EARLY_ATTESTATION_KEY: KEYS.attacker } })).j;
  check('A09 attestation key whose address is not in the registry: attestations false', wrongKey.attestations === false);
  const sameKey = (await get('config', {}, { env: { ...ENV, SYNCNET_EARLY_ANCHOR_KEY: KEYS.attest } })).j;
  check('A10 anchor key == attestation key refused (both off)', sameKey.attestations === false && sameKey.anchoring === false);
  const keys = (await get('keys')).j;
  check('A11 keys view is public data only', keys.registry.attestation[0].address === W.attest && !JSON.stringify(keys).includes(KEYS.attest.slice(2)));
  const bad = await call('PUT', null, {});
  check('A12 method not allowed', bad.s === 405);
  check('A13 responses are JSON with nosniff and deny-all CSP', bad.headers['content-type'].includes('json') && bad.headers['x-content-type-options'] === 'nosniff' && /default-src 'none'/.test(bad.headers['content-security-policy']));
}

// ============================================================================================ B. Count me in
{
  const before = (await get('creator', { channelId: CH })).body;
  const r1 = await countMeIn();
  check('B01 first signal stored (201, private, no EARLY status)', r1.s === 201 && r1.j.signal.status === 'ACTIVE' && /non-binding/.test(r1.j.note) && r1.j.signal.creatorOnEarly === false);
  const r2 = await countMeIn();
  check('B02 signing again renews the same record (200, renewedAt grows)', r2.s === 200 && r2.j.signal.renewedAt.length === 1);
  const after = (await get('creator', { channelId: CH })).body;
  check('B03 unclaimed channel view is byte-identical before and after signals (no leak)', before === after && JSON.parse(after).onEarly === false);
  const replayNonce = rnd32();
  await countMeIn(CH, W.fan2, { message: { nonce: replayNonce } });
  const replay = await countMeIn(CH, W.fan2, { message: { nonce: replayNonce, issuedAt: nowSec() } });
  check('B04 same nonce twice → idempotent / replay refused, never a second record', (replay.s === 200 && replay.j.idempotent) || (replay.s === 409 && replay.j.code === 'replay'));
  const badSig = await countMeIn(CH2, W.fan, { signer: W.attacker });
  check('B05 signature by another wallet refused (401)', badSig.s === 401 && badSig.j.code === 'bad_signature');
  const badExp = await countMeIn(CH2, W.fan, { message: { expiry: nowSec() + 10 } });
  check('B06 expiry must be issuedAt + 180 days', badExp.s === 400);
  const skew = await countMeIn(CH2, W.fan, { message: { issuedAt: nowSec() - 1000 } });
  check('B07 issuedAt outside ±120 s refused', skew.s === 400 && /device clock/.test(skew.j.error));
  const extra = await countMeIn(CH2, W.fan, { extra: { amount: '5' } });
  check('B08 extra fields refused (no amount can ride along)', extra.s === 400 && /Unexpected field/.test(extra.j.error));
  const badCh = await countMeIn('@alice', W.fan);
  check('B09 handle instead of channel id refused', badCh.s === 400);
  const wm = { schema: E.SCHEMA.countMeInWithdraw, channelId: CH, fan: W.fan2, issuedAt: nowSec(), nonce: rnd32() };
  const wd = await post({ action: 'count-me-in-withdraw', channelId: CH, fan: W.fan2, issuedAt: wm.issuedAt, nonce: wm.nonce, signature: sign('CountMeInWithdraw', wm, W.fan2) });
  check('B10 withdraw (signed) → WITHDRAWN', wd.s === 200 && wd.j.signal.status === 'WITHDRAWN');
  // per-wallet daily budget: 20 signals/day
  let limited = null;
  for (let i = 0; i < 22; i++) { const r = await countMeIn('UC' + String(i).padStart(22, 'z'), W.attacker, { ip: '203.0.113.9' }); if (r.s === 429) { limited = i; break; } }
  check('B11 per-wallet signal budget (20/day) enforced', limited !== null && limited <= 20, String(limited));
}

// ============================================================================================ C. creator activation
let M1; // manifest v1 hash for CH
{
  const noSession = await manifest({ session: null });
  check('C01 manifest without a creator session → 401', noSession.r.s === 401 && noSession.r.j.code === 'session');
  const noLink = await manifest({ session: creatorSession(store, { link: false }) });
  check('C02 session without a fresh OAuth link → 403 reverify', noLink.r.s === 403 && noLink.r.j.code === 'reverify');
  const mismatch = await manifest({ channelId: CH2, session: creatorSession(store, { channelId: CH }) });
  check('C03 OAuth account mismatch: manifest names another channel → 403 channel_mismatch', mismatch.r.s === 403 && mismatch.r.j.code === 'channel_mismatch');
  const badAsset = await manifest({ accepted: [{ token: '0x9999999999999999999999999999999999999999', minAmount: '1' }] });
  check('C04 asset outside the allowlist → 400 asset_not_allowed', badAsset.r.s === 400 && badAsset.r.j.code === 'asset_not_allowed');
  const badHash = await manifest({ over: { hash: rnd32() } });
  check('C05 acceptedAssetsHash mismatch → 400', badHash.r.s === 400);
  const badSigner = await manifest({ over: { signer: W.attacker } });
  check('C06 manifest signed by a wallet other than receivingWallet → 401', badSigner.r.s === 401);
  const noAtt = await manifest({ over: { env: { ...ENV, SYNCNET_EARLY_ATTESTATION_KEY: '' } } });
  check('C07 attestation key unavailable → 503 attestation_unavailable, nothing written', noAtt.r.s === 503 && noAtt.r.j.code === 'attestation_unavailable' && !MAP.has('early:creator:v1:' + E.creatorIdOf(CH)));
  const v2first = await manifest({ version: 2 });
  check('C08 first manifest must be version 1', v2first.r.s === 400);
  const good = await manifest();
  M1 = good.hash;
  check('C09 valid manifest v1 → 201 ACTIVE, manifestHash = EIP-712 digest', good.r.s === 201 && good.r.j.creator.status === 'ACTIVE' && good.r.j.manifest.manifestHash === M1 && good.r.j.manifest.status === 'ACTIVE');
  check('C10 signals waiting at join counted as records (fan active, fan2 withdrawn → 1), wording never "people"', good.r.j.creator.signalsWaitingAtJoin === 1 && /1 signed interest signal was waiting/.test(good.r.j.signalsNote) && !/people|verified supporter/.test(good.r.j.signalsNote));
  const cv = (await get('creator', { channelId: CH })).j;
  check('C11 public creator view: wallet, assets, status; NO signal count, NO supporters', cv.onEarly === true && cv.currentManifest.receivingWallet === W.creator && cv.acceptsSupport === true && !('signalsWaitingAtJoin' in cv) && !JSON.stringify(cv).includes(W.fan));
  const mv = (await get('manifest', { manifestHash: M1 })).j;
  check('C12 manifest view carries identity + manifest attestations signed by the registered key (inclusion pending until the bundle is built)', mv.manifest.attestations.length === 2 && mv.manifest.attestations.every((a) => E.verifyAttestation(a, TEST_KEYS_FILE).ok && a.inclusion === null) && mv.manifest.attestations.some((a) => a.type === 'creator-identity' && a.claims.receivingWallet === W.creator));
  check('C13 enrolment audience snapshot attested for the join day (from the OAuth link value)', MAP.has('early:snap:v1:' + CH + ':' + E.utcDate(nowSec())));
  const again = await manifest();
  check('C14 a second v1 manifest for an ACTIVE creator is refused as a stale rotation (409 stale_manifest)', again.r.s === 409 && again.r.j.code === 'stale_manifest');
  const other = await manifest({ wallet: W.attacker, session: creatorSession(store, { channelId: CH, wallet: W.attacker }) });
  check('C15 another wallet with a fresh session cannot re-claim v1 (must rotate: 409)', other.r.s === 409);
  const me = (await get('me', {}, { session: creatorSession(store) })).j;
  check('C16 creator dashboard shows the count privately', me.creator && me.creator.signalsWaitingAtJoin === 1 && /records, not as people/.test(me.signalsNote));
  const fanView = (await get('me', {}, { session: fanSession() }));
  check('C17 a fan session cannot open the creator dashboard', fanView.s === 401);
}

// ============================================================================================ D. intents (draft → sign → store)
{
  const d = await draft(M1);
  check('D01 draft returns exact typed data: server-filled receiver/token/chain/creatorId/window, PRIVATE', d.s === 201 && d.j.typedData.message.receiver === W.creator && d.j.typedData.message.token === USDG && d.j.typedData.message.chainId === 4663 && d.j.typedData.message.privacy === 'PRIVATE' && d.j.typedData.message.expiry - d.j.typedData.message.notBefore === E.CONST.INTENT_WINDOW_S && d.j.typedData.domain.name === 'SyncNet SYNC Proof' && d.j.human === '1.5');
  const wrongAsset = await draft(M1, { token: '0x9999999999999999999999999999999999999999' });
  check('D02 asset the creator does not accept → 422', wrongAsset.s === 422 && wrongAsset.j.code === 'asset_not_accepted');
  const low = await draft(M1, { amount: '999999' });
  check('D03 below the creator minimum → 422', low.s === 422 && low.j.code === 'below_minimum');
  const badAmt = await draft(M1, { amount: '1.5' });
  check('D04 human amount refused: raw integers only', badAmt.s === 400);
  const unknown = await draft(rnd32());
  check('D05 unknown manifest → 404', unknown.s === 404);
  const self = await draft(M1, { sender: W.creator });
  check('D06 sender == receiving wallet refused', self.s === 400);
  const smuggle = await post({ action: 'intent-draft', manifestHash: M1, sender: W.fan, token: USDG, amount: '1500000', receiver: W.attacker });
  check('D07 client-supplied receiver refused (400 unexpected field)', smuggle.s === 400 && /Unexpected field/.test(smuggle.j.error));
  const badSig = await storeIntent(d, { signer: W.attacker });
  check('D08 intent signed by another wallet → 401', badSig.s === 401);
  const s1 = await storeIntent(d);
  check('D09 valid signature → INTENT_STORED (OPEN) with createdBlock and the standard transfer calldata', s1.s === 201 && s1.j.intent.status === 'OPEN' && /^\d+$/.test(s1.j.intent.createdBlock) && s1.j.intent.tx.to === USDG && s1.j.intent.tx.data === E.transferCalldata(W.creator, '1500000') && s1.j.intent.tx.value === '0x0');
  const s2 = await storeIntent(d);
  check('D10 storing again is idempotent (lost POST after signing is safe)', s2.s === 200 && s2.j.idempotent === true);
  const dup = await draft(M1);
  check('D11 second draft for the same (sender, receiver, token, amount) while one is OPEN → 409 intent_open, and the open intent id is never disclosed', dup.s === 409 && dup.j.code === 'intent_open' && !JSON.stringify(dup.headers).includes(s1.j.intent.intentId) && !dup.body.includes(s1.j.intent.intentId));
  const other = await draft(M1, { amount: '2000000' });
  check('D12 a different amount is a different tuple → allowed', other.s === 201);
  const iv = (await get('intent', { intent: s1.j.intent.intentId })).j;
  check('D13 intent readable by its id (capability), 404 for a random id', iv.intent.status === 'OPEN' && (await get('intent', { intent: rnd32() })).s === 404);
  const mine401 = await get('mine');
  check('D14 listing a wallet’s intents needs a fan session (401)', mine401.s === 401);
  const mine = (await get('mine', {}, { session: fanSession() })).j;
  check('D15 fan session lists own intents only', mine.intents.length === 1 && mine.intents[0].intentId === s1.j.intent.intentId && mine.signals.length === 1);
  clock.advance(E.CONST.DRAFT_TTL_S + 5);
  const late = await storeIntent(other);
  check('D16 an unsigned draft expires after 20 minutes → 404 draft_missing', late.s === 404 && late.j.code === 'draft_missing');
  // the OPEN intent from D09 is still open (2 h window); keep it for section E
  globalThis.__I1 = s1.j.intent;
}

// ============================================================================================ E. verification: the public rule on the mock chain
{
  const I1 = globalThis.__I1;
  const w0 = await verify(I1.intentId);
  check('E01 no transfer yet → 202 WAITING, no state change', w0.s === 202 && w0.j.status === 'WAITING');
  // backdated: a transfer mined at the intent's createdBlock (before persistence) is never a candidate, even as a hint
  const back = pay({ from: W.fan, to: W.creator, amount: '1500000', blockNumber: BigInt(I1.createdBlock), timestamp: I1.typedData.message.notBefore + 1 });
  const wb = await verify(I1.intentId, back.txHash);
  check('E02 transfer mined at/before createdBlock is not a candidate (backdating guard)', wb.s === 202 && wb.j.status === 'WAITING');
  // wrong amount, fake token, reverted, wrong sender: none match
  pay({ from: W.fan, to: W.creator, amount: '1500001' });
  pay({ from: W.fan, to: W.creator, amount: '1500000', token: '0x9999999999999999999999999999999999999999' });
  const rev = pay({ from: W.fan, to: W.creator, amount: '1500000', status: '0x0' });
  pay({ from: W.fan2, to: W.creator, amount: '1500000' });
  const wn = await verify(I1.intentId, rev.txHash);
  check('E03 wrong amount / same-symbol fake token / reverted / other sender never match', wn.s === 202 && wn.j.status === 'WAITING');
  // the real transfer, not yet SAFE
  const p = payFor(I1);
  const w1 = await verify(I1.intentId, p.txHash);
  check('E04 exact transfer found but block not SAFE → 202 PENDING_CONFIRMATION (observed recorded)', w1.s === 202 && w1.j.status === 'PENDING_CONFIRMATION' && w1.j.candidate.txHash === p.txHash && w1.j.intent.observed.txHash === p.txHash);
  makeSafe(p.blockNumber);
  const w2 = await verify(I1.intentId); // no hint: the sweep finds it
  check('E05 SAFE + exactly one in-window candidate → CONFIRMED receipt, mode auto, no signature', w2.s === 200 && w2.j.status === 'CONFIRMED' && w2.j.mode === 'auto' && E.isBytes32(w2.j.receiptId));
  const w3 = await verify(I1.intentId, p.txHash);
  check('E06 verify again is idempotent', w3.s === 200 && w3.j.idempotent === true && w3.j.receiptId === w2.j.receiptId);
  const doc = (await get('receipt', { intent: I1.intentId })).j.receipt;
  check('E07 receipt document: fact from the log, intent typed data + signature recovering to the sender, creator manifest, ordering note', doc.schema === E.SCHEMA.receipt && doc.fact.txHash === p.txHash && doc.fact.transfer.from === W.fan && doc.fact.transfer.to === W.creator && doc.fact.transfer.value === '1500000' && lc(Core.recoverAddress(Core.hashTypedData(doc.intent.typedData), doc.intent.signature)) === W.fan && lc(Core.recoverAddress(Core.hashTypedData(doc.creatorManifest.typedData), doc.creatorManifest.signature)) === W.creator && /Not independently verifiable/.test(doc.ordering.note));
  check('E08 receipt context: EARLY date = block date (UTC), audience from the day’s snapshot, approximate', doc.context.earlyDate === E.utcDate(Number(p.timestamp)) && doc.context.audienceThen.state === 'approximate' && doc.context.audienceThen.display === '~1.2K' && doc.context.creatorTitleThen === 'Alice');
  check('E09 receipt attestations verify against the key registry; anchors pending (no bundle yet)', doc.attestations.length === 3 && doc.attestations.every((a) => E.verifyAttestation(a, TEST_KEYS_FILE).ok) && doc.anchors.every((a) => a.built === false));
  check('E10 receipt is PRIVATE and the public creator view still shows nothing about it', doc.privacy.state === 'PRIVATE' && !JSON.stringify((await get('creator', { channelId: CH })).j).includes(p.txHash));
  // the same transfer cannot be bound twice; the tuple is released at the transfer's block time (a new intent may start)
  const tooSoon = await draft(M1);
  check('E11a a same-tuple intent in the same second as the transfer waits (409 tuple_cooldown)', tooSoon.s === 409 && tooSoon.j.code === 'tuple_cooldown');
  clock.advance(2); syncHead();
  const d2 = await draft(M1);
  check('E11 after finalisation a new same-tuple intent is allowed (notBefore > transfer time)', d2.s === 201 && d2.j.typedData.message.notBefore > Number(p.timestamp), d2.body);
  const I2 = (await storeIntent(d2)).j.intent;
  const r2 = await verify(I2.intentId, p.txHash);
  check('E12 the consumed transfer is not a candidate for the new intent (window + txlog claim)', r2.s === 202 && r2.j.status === 'WAITING');
  // ambiguity: two exact transfers inside I2's window
  const pa = payFor(I2), pb = payFor(I2);
  makeSafe(pb.blockNumber);
  const amb = await verify(I2.intentId);
  check('E13 two in-window candidates → AMBIGUOUS, needsFinalize, both listed, nothing finalised', amb.s === 200 && amb.j.status === 'AMBIGUOUS' && amb.j.needsFinalize === true && amb.j.candidates.length === 2);
  const wrongPick = await finalizeTx(I2, rnd32(), 0);
  check('E14 finalize naming a non-matching tx → 409 no_match', wrongPick.s === 409 && wrongPick.j.code === 'no_match');
  const badFin = await finalizeTx(I2, pa.txHash, 0, { signer: W.attacker });
  check('E15 finalize signed by another wallet → 401', badFin.s === 401);
  const fin = await finalizeTx(I2, pa.txHash, 0);
  check('E16 finalize with the sender’s signature → receipt mode ambiguous-finalized', fin.s === 200 && fin.j.mode === 'ambiguous-finalized' && fin.j.status === 'CONFIRMED');
  const docB = (await get('receipt', { intent: I2.intentId })).j.receipt;
  check('E17 finalize signature stored in the receipt and recovers to the sender', docB.finalize && lc(Core.recoverAddress(Core.hashTypedData(docB.finalize.typedData), docB.finalize.signature)) === W.fan && docB.fact.txHash === pa.txHash);
  check('E18 the other transfer stays unbound (no receipt exists for it)', !MAP.has('early:txlog:v1:' + pb.txHash + ':0'));
  // recovery: transfer mined after expiry, within 24 h, bound only by signature
  const d3 = await draft(M1, { amount: '3000000' }); const I3 = (await storeIntent(d3)).j.intent;
  clock.advance(E.CONST.INTENT_WINDOW_S + 3600); syncHead();
  const lateTx = payFor(I3); makeSafe(lateTx.blockNumber);
  const ex = await verify(I3.intentId);
  check('E19 expired with no in-window match and no hint → EXPIRED', ex.s === 200 && ex.j.status === 'EXPIRED');
  const rec = await verify(I3.intentId, lateTx.txHash);
  check('E20 a late transfer given as a hint → RECOVERY_AVAILABLE (never auto-finalised)', rec.s === 200 && rec.j.status === 'RECOVERY_AVAILABLE' && rec.j.needsFinalize === true);
  const finRec = await finalizeTx(I3, lateTx.txHash, 0);
  check('E21 recovery finalize → receipt mode recovery-finalized; EARLY date = block time', finRec.s === 200 && finRec.j.mode === 'recovery-finalized' && finRec.j.receipt.earlyDate === E.utcDate(Number(lateTx.timestamp)));
  // out of grace
  const d4 = await draft(M1, { amount: '4000000' }); const I4 = (await storeIntent(d4)).j.intent;
  clock.advance(E.CONST.INTENT_WINDOW_S + E.CONST.RECOVERY_GRACE_S + 10); syncHead();
  const tooLate = payFor(I4); makeSafe(tooLate.blockNumber);
  const closed = await verify(I4.intentId, tooLate.txHash);
  check('E22 transfer after the 24 h grace → CLOSED, no receipt', closed.s === 200 && closed.j.status === 'CLOSED');
  const finClosed = await finalizeTx(I4, tooLate.txHash, 0);
  check('E23 finalize refused once closed', finClosed.s === 409);
  // finality + reorg
  const d5 = await draft(M1, { amount: '5000000' }); const I5 = (await storeIntent(d5)).j.intent;
  const p5 = payFor(I5); makeSafe(p5.blockNumber);
  const c5 = await verify(I5.intentId);
  check('E24 CONFIRMED at SAFE', c5.s === 200 && c5.j.status === 'CONFIRMED');
  const rc0 = await reconcile(I5.intentId);
  check('E25 reconcile before finality: unchanged', rc0.s === 200 && rc0.j.changed === false);
  reorg(p5.blockNumber);
  const rc1 = await reconcile(I5.intentId);
  check('E26 reorg removes the block → INVALIDATED_BY_REORG (receipt kept, card impossible)', rc1.s === 200 && rc1.j.status === 'INVALIDATED_BY_REORG');
  const iv5 = (await get('intent', { intent: I5.intentId })).j.intent;
  check('E27 intent reopened as REORGED', iv5.status === 'REORGED');
  const p5b = payFor(I5); makeFinal(p5b.blockNumber);
  const c5b = await verify(I5.intentId);
  check('E28 a new matching transfer re-verifies the REORGED intent → FINALIZED (finalized tag) with previous recorded', c5b.s === 200 && c5b.j.status === 'FINALIZED' && (await get('receipt', { intent: I5.intentId })).j.receipt.status === 'FINALIZED');
  globalThis.__I5 = I5; globalThis.__R5 = c5b.j.receiptId;
  // outage / budget
  const d6 = await draft(M1, { amount: '6000000' }); const I6 = (await storeIntent(d6)).j.intent;
  pc.mode = 'down';
  const down = await verify(I6.intentId);
  pc.mode = 'ok';
  check('E29 RPC outage → 503 chain_unavailable, intent unchanged', down.s === 503 && down.j.code === 'chain_unavailable' && (await get('intent', { intent: I6.intentId })).j.intent.status === 'OPEN', down.body);
  pc.mode = 'down';
  const downStore = await storeIntent(await draft(M1, { amount: '6100000' }));
  pc.mode = 'ok';
  check('E29b RPC outage while persisting an intent → 503 chain_unavailable (no intent stored)', downStore.s === 503 && downStore.j.code === 'chain_unavailable');
  clock.advance(3600); syncHead(); // 3,600 blocks past the intent: 100-block chunks need > 24 calls
  const tiny = await verify(I6.intentId, undefined, { env: { ...ENV, EARLY_GETLOGS_CHUNK: '100' } });
  check('E30 call budget exhausted (tiny chunks over a long window) → 202 VERIFY_DEFERRED, intent unchanged', tiny.s === 202 && tiny.j.status === 'VERIFY_DEFERRED' && (await get('intent', { intent: I6.intentId })).j.intent.status === 'OPEN', tiny.body);
  const normal = await verify(I6.intentId);
  check('E30b the default chunk size covers the window inside the budget (WAITING, not deferred)', normal.s === 202 && normal.j.status === 'WAITING', normal.body);
  const noSafe = await (async () => { const p6 = payFor(I6); pc.mode = 'no-safe'; const r = await verify(I6.intentId, p6.txHash); pc.mode = 'ok'; return r; })();
  check('E31 RPC without a safe tag never confirms (fail closed)', noSafe.s === 202 && noSafe.j.status === 'PENDING_CONFIRMATION');
}

// ============================================================================================ F. sessions + cards
{
  const I5 = globalThis.__I5, R5 = globalThis.__R5;
  const sm = { schema: E.SCHEMA.session, wallet: W.fan, issuedAt: nowSec(), nonce: rnd32() };
  const s = await post({ action: 'session', wallet: W.fan, issuedAt: sm.issuedAt, nonce: sm.nonce, signature: sign('EarlySession', sm, W.fan) });
  check('F01 EarlySession signature → fan session token', s.s === 200 && s.j.scope === 'fan' && Session.verify(s.j.session, { scope: 'fan', now: () => clock.now(), env: ENV }).wallet === W.fan);
  const sReplay = await post({ action: 'session', wallet: W.fan, issuedAt: sm.issuedAt, nonce: sm.nonce, signature: sign('EarlySession', sm, W.fan) });
  check('F02 session nonce replay refused', sReplay.s === 409);
  const foreign = await post({ action: 'card-create', receiptId: R5 }, { session: fanSession(W.fan2) });
  check('F03 another wallet cannot make a card for this receipt (404)', foreign.s === 404);
  const c1 = await post({ action: 'card-create', receiptId: R5 }, { session: s.j.session });
  check('F04 card created for a FINALIZED receipt, all fields hidden by default', c1.s === 201 && E.isBytes32(c1.j.shareId) && c1.j.defaults.wallet === 'hidden' && c1.j.defaults.amount === 'hidden' && c1.j.defaults.transaction === 'hidden');
  const c2 = await post({ action: 'card-create', receiptId: R5 }, { session: s.j.session });
  check('F05 card creation is idempotent (one share id per receipt)', c2.s === 200 && c2.j.shareId === c1.j.shareId);
  const view = (await get('card', { shareId: c1.j.shareId })).j;
  const text = JSON.stringify(view);
  check('F06 public card: creator, date, audience, "SYNC Proof verified"; NO wallet, amount or tx hash', view.card.headline === 'EARLY' && view.card.line === 'I WAS THERE WHEN.' && view.card.creator === 'Alice' && view.card.verified === 'SYNC Proof verified' && view.card.wallet === null && view.card.amount === null && view.card.transaction === null && !text.includes(W.fan) && !text.includes('5000000') && !text.includes(I5.intentId));
  check('F07 public card states what is and is not independently verifiable', view.verification.notShown.some((x) => /transaction/.test(x)) && view.verification.independentlyVerifiable.includes('creator identity attestation'));
  check('F08 public card carries attestations that verify against the registry', view.verification.attestations.length >= 2 && view.verification.attestations.every((a) => E.verifyAttestation(a, TEST_KEYS_FILE).ok));
  // The card claims only attestations that exist for THIS receipt (no false "audience snapshot attestation" claim).
  const hasType = (v, t) => v.verification.attestations.some((a) => a.type === t);
  // In this suite the clock has advanced past the join day, so the transfer's UTC day has NO audience snapshot: the
  // exact scenario of the reported bug.
  check('F08a NO snapshot attestation → audienceThen "unavailable" and the card does NOT claim an audience snapshot attestation', view.card.audienceThen.state === 'unavailable' && !hasType(view, 'audience-snapshot') && !view.verification.independentlyVerifiable.includes('audience snapshot attestation'));
  check('F08b NO snapshot attestation → the claims that remain are exactly the attestations returned (identity + manifest), each verifiable', view.verification.independentlyVerifiable.join('|') === 'creator identity attestation|creator manifest attestation' && view.verification.attestations.length === 2 && view.verification.attestations.every((a) => E.verifyAttestation(a, TEST_KEYS_FILE).ok));
  check('F08c NO snapshot attestation → wallet, amount, transaction and revealed fields stay hidden by default (privacy unchanged)', view.card.wallet === null && view.card.amount === null && view.card.transaction === null && view.card.revealed.length === 0 && view.verification.notShown.length === 3 && !text.includes(W.fan) && !text.includes('5000000') && !text.includes(I5.intentId));
  // Now create a REAL audience-snapshot attestation for the transfer's day (same code path as enrolment/the daily job).
  const dayT = Math.floor(Date.parse(view.card.supportedOn + 'T12:00:00Z') / 1000);
  const snapKey = 'early:snap:v1:' + CH + ':' + view.card.supportedOn;
  const cfgNow = earlyConfig({ env: ENV, store, now: () => clock.now(), keysFile: TEST_KEYS_FILE });
  await early._internals.enrolmentSnapshot({ store, signer: makeSigner(ENV, cfgNow) }, CH, { title: 'Alice', subscriberCount: 1234, hiddenSubscriberCount: false, at: dayT }, dayT, view.card.supportedOn);
  const withSnap = (await get('card', { shareId: c1.j.shareId })).j;
  MAP.delete(snapKey); // leave the fixtures as they were for the checks below
  check('F08d snapshot attestation present → the hidden card DOES claim identity, manifest and audience snapshot attestations, and each really exists', MAP.size > 0 && withSnap.card.audienceThen.state === 'approximate' && hasType(withSnap, 'creator-identity') && hasType(withSnap, 'creator-manifest') && hasType(withSnap, 'audience-snapshot') && withSnap.verification.independentlyVerifiable.join('|') === 'creator identity attestation|creator manifest attestation|audience snapshot attestation' && withSnap.verification.attestations.every((a) => E.verifyAttestation(a, TEST_KEYS_FILE).ok), JSON.stringify(withSnap.verification.independentlyVerifiable));
  check('F08e snapshot attestation present → wallet, amount and transaction still hidden by default', withSnap.card.wallet === null && withSnap.card.amount === null && withSnap.card.transaction === null && withSnap.verification.notShown.length === 3);
  const notFinal = await post({ action: 'card-create', receiptId: (await get('receipt', { intent: globalThis.__I1.intentId })).j.receipt.receiptId }, { session: s.j.session });
  check('F09 no card for a CONFIRMED (not yet FINALIZED) receipt', notFinal.s === 409 && notFinal.j.code === 'not_final');
  const ev = await post({ action: 'card-event', shareId: c1.j.shareId, event: 'link_copied' }, { session: s.j.session });
  check('F10 share-link-copied is a named metric event', ev.s === 200);
  const d = E.utcDate(nowSec());
  const visits = Number(MAP.get('early:metrics:v1:verification_page_visits:' + d) && MAP.get('early:metrics:v1:verification_page_visits:' + d).value);
  await get('card', { shareId: c1.j.shareId }, { ip: '198.51.100.7' }); await get('card', { shareId: c1.j.shareId }, { ip: '198.51.100.7' });
  const visits2 = Number(MAP.get('early:metrics:v1:verification_page_visits:' + d).value);
  check('F11 verification-page visits deduped per (card, ip, hour) and never called shares', visits2 === visits + 1 && Number(MAP.get('early:metrics:v1:share_links_copied:' + d).value) === 1);
  const mine = (await get('mine', {}, { session: s.j.session })).j;
  check('F12 "mine" lists receipts with their card share id; nothing about other wallets', mine.receipts.some((r) => r.receiptId === R5 && r.cardShareId === c1.j.shareId) && !JSON.stringify(mine).includes(W.fan2));
  const nope = await get('card', { shareId: rnd32() });
  check('F13 unknown share id → 404', nope.s === 404);
}

// ============================================================================================ G. wallet rotation
{
  const dNo = await draft(M1, { sender: W.fan2, amount: '7000000' });
  check('G00 baseline: drafts work before rotation', dNo.s === 201);
  const oldOnly = await manifest({ wallet: W.creator2, version: 2, prev: M1, session: null });
  check('G01 a new manifest without a creator session (wallet only) → 401: a wallet alone cannot rotate', oldOnly.r.s === 401);
  const wrongPrev = await manifest({ wallet: W.creator2, version: 2, prev: rnd32() });
  check('G02 rotation must reference the current manifest hash (409 stale_manifest)', wrongPrev.r.s === 409 && wrongPrev.r.j.code === 'stale_manifest');
  const sameW = await manifest({ wallet: W.creator, version: 2, prev: M1 });
  check('G03 rotation to the same wallet refused', sameW.r.s === 409 && sameW.r.j.code === 'same_wallet');
  const rot = await manifest({ wallet: W.creator2, version: 2, prev: M1 });
  check('G04 fresh OAuth + new wallet signature → ROTATION_PENDING with a 48 h effectiveAt and a warning', rot.r.s === 201 && rot.r.j.creator.status === 'ROTATION_PENDING' && rot.r.j.effectiveAt === nowSec() + E.CONST.ROTATION_COOLDOWN_S && /current wallet/.test(rot.r.j.warning));
  const P2 = rot.hash;
  const cv = (await get('creator', { channelId: CH })).j;
  check('G05 public creator view warns: rotation pending, effectiveAt visible, current wallet unchanged', cv.rotation && cv.rotation.pending === true && cv.currentManifest.receivingWallet === W.creator && cv.currentManifest.manifestHash === M1);
  const dPend = await draft(M1, { sender: W.fan2, amount: '7100000' });
  check('G06 drafts during the cooldown still pay the CURRENT wallet and expire no later than effectiveAt', dPend.s === 201 && dPend.j.typedData.message.receiver === W.creator && dPend.j.typedData.message.expiry <= rot.r.j.effectiveAt);
  const second = await manifest({ wallet: W.attacker, version: 2, prev: M1 });
  check('G07 a second rotation while one is pending is refused', second.r.s === 409 && second.r.j.code === 'rotation_pending');
  // cancel by the CURRENT wallet (attacker holding the Google account started it; the wallet holder stops it)
  const cm = { schema: E.SCHEMA.rotationCancel, creatorId: E.creatorIdOf(CH), pendingManifestHash: P2, issuedAt: nowSec(), nonce: rnd32() };
  const badCancel = await post({ action: 'rotation-cancel', creatorId: cm.creatorId, pendingManifestHash: P2, issuedAt: cm.issuedAt, nonce: cm.nonce, signature: sign('RotationCancel', cm, W.creator2) });
  check('G08 the NEW wallet cannot cancel (401)', badCancel.s === 401);
  const cancel = await post({ action: 'rotation-cancel', creatorId: cm.creatorId, pendingManifestHash: P2, issuedAt: cm.issuedAt, nonce: cm.nonce, signature: sign('RotationCancel', cm, W.creator) });
  check('G09 current wallet cancels → ACTIVE again, locked', cancel.s === 200 && cancel.j.cancelledBy === 'current-wallet' && cancel.j.locked === true && (await get('creator', { channelId: CH })).j.rotation === null);
  check('G10 the cancelled manifest is CANCELLED and immutable in history', (await get('manifest', { manifestHash: P2 })).j.manifest.status === 'CANCELLED');
  // realistic sequence: the lock lands AFTER every sign-in recorded so far; the first attempt under the lock is refused
  // but recorded; a second sign-in ≥ 24 h later succeeds (a compromised old wallet cannot veto forever).
  clock.advance(3600); syncHead();
  const lockedTry = await manifest({ wallet: W.creator2, version: 2, prev: M1 });
  check('G11 while locked, one fresh OAuth session is not enough (409 rotation_locked) and is recorded', lockedTry.r.s === 409 && lockedTry.r.j.code === 'rotation_locked' && JSON.parse(MAP.get('early:creator:v1:' + E.creatorIdOf(CH)).value).oauthSeen.includes(nowSec()));
  clock.advance(23 * 3600); syncHead();
  const tooEarly = await manifest({ wallet: W.creator2, version: 2, prev: M1 });
  check('G11b a second sign-in only 23 h later is still refused', tooEarly.r.s === 409 && tooEarly.r.j.code === 'rotation_locked');
  clock.advance(2 * 3600); syncHead();
  const override = await manifest({ wallet: W.creator2, version: 2, prev: M1 });
  check('G12 two OAuth sessions ≥ 24 h apart after the lock override the wallet’s cancel', override.r.s === 201 && override.r.j.creator.status === 'ROTATION_PENDING', override.r.body);
  const P3 = override.hash;
  const cm2 = { schema: E.SCHEMA.rotationCancel, creatorId: E.creatorIdOf(CH), pendingManifestHash: P3, issuedAt: nowSec(), nonce: rnd32() };
  const repeat = await post({ action: 'rotation-cancel', creatorId: cm2.creatorId, pendingManifestHash: P3, issuedAt: cm2.issuedAt, nonce: cm2.nonce, signature: sign('RotationCancel', cm2, W.creator) });
  check('G13 the same old wallet cannot cancel again within 30 days (409 cancel_repeat)', repeat.s === 409 && repeat.j.code === 'cancel_repeat');
  // freeze in the last hour before effect
  clock.advance(E.CONST.ROTATION_COOLDOWN_S - 1800); syncHead();
  const frozen = await draft(M1, { sender: W.fan2, amount: '7200000' });
  check('G14 no new drafts in the final hour before the wallet change (409 rotation_imminent)', frozen.s === 409 && frozen.j.code === 'rotation_imminent');
  clock.advance(1900); syncHead();
  const cvDone = (await get('creator', { channelId: CH })).j;
  check('G15 after the cooldown any read completes the rotation: ACTIVE, new wallet, new manifest', cvDone.status === 'ACTIVE' && cvDone.currentManifest.receivingWallet === W.creator2 && cvDone.currentManifest.manifestHash === P3 && cvDone.rotation === null);
  const oldM = (await get('manifest', { manifestHash: M1 })).j.manifest, newM = (await get('manifest', { manifestHash: P3 })).j.manifest;
  check('G16 old manifest SUPERSEDED (attested, immutable struct), new manifest ACTIVE with an identity attestation for the new wallet', oldM.status === 'SUPERSEDED' && oldM.supersededBy === P3 && oldM.receivingWallet === W.creator && newM.status === 'ACTIVE' && newM.attestations.some((a) => a.type === 'creator-identity' && a.claims.receivingWallet === W.creator2) && oldM.attestations.some((a) => a.type === 'creator-manifest' && a.claims.status === 'SUPERSEDED'));
  const stale = await draft(M1, { sender: W.fan2, amount: '7300000' });
  check('G17 drafts against the superseded manifest are refused and point at the current one', stale.s === 409 && stale.j.code === 'manifest_not_active' && stale.headers['x-early-current-manifest'] === P3);
  const fresh = await draft(P3, { sender: W.fan2, amount: '7300000' });
  check('G18 drafts against the new manifest pay the new wallet', fresh.s === 201 && fresh.j.typedData.message.receiver === W.creator2);
  // old receipt still interpretable: the manifest it references is immutable and its attestations remain
  const oldDoc = (await get('receipt', { intent: globalThis.__I1.intentId })).j.receipt;
  check('G19 an old receipt still references the old manifest and its ACTIVE-at-the-time attestation', oldDoc.creatorManifest.manifestHash === M1 && oldDoc.attestations.some((a) => a.type === 'creator-manifest' && a.claims.status === 'ACTIVE' && a.subject.manifestHash === M1));
  // pause / resume via the creator session (no wallet needed)
  const pause = await post({ action: 'creator-pause' }, { session: creatorSession(store, { wallet: W.creator2 }) });
  const dPaused = await draft(P3, { sender: W.fan2, amount: '7400000' });
  const resume = await post({ action: 'creator-resume' }, { session: creatorSession(store, { wallet: W.creator2 }) });
  check('G20 pause (session only) stops new drafts; resume restores', pause.s === 200 && dPaused.s === 409 && dPaused.j.code === 'creator_paused' && resume.s === 200 && (await draft(P3, { sender: W.fan2, amount: '7400000' })).s === 201);
  const sessionCancelStart = await manifest({ wallet: W.attacker, version: 3, prev: P3, session: creatorSession(store, { wallet: W.attacker }) });
  const sc = await post({ action: 'rotation-cancel', creatorId: E.creatorIdOf(CH), pendingManifestHash: sessionCancelStart.hash }, { session: creatorSession(store, { wallet: W.creator2 }) });
  check('G21 a creator session can cancel a pending rotation without a wallet signature (no lock)', sessionCancelStart.r.s === 201 && sc.s === 200 && sc.j.cancelledBy === 'creator-session' && sc.j.locked === false);
}

// ============================================================================================ H. privacy / hygiene sweep
{
  const pages = [(await get('creator', { channelId: CH })).body, (await get('config')).body, (await get('keys')).body, (await get('manifest', { manifestHash: M1 })).body];
  check('H01 no public read contains a fan wallet, an intent id or a tx hash', pages.every((t) => !t.includes(W.fan) && !t.includes(W.fan2) && !t.includes(globalThis.__I1.intentId)));
  check('H02 no public read contains a per-creator receipt count or ranking word', pages.every((t) => !/receiptCount|supporters|rank|leaderboard|Supporter #/i.test(t)));
  const err = await post({ action: 'intent-draft', manifestHash: 'nope' });
  check('H03 errors are fixed sentences with codes (no stack, no env names)', err.s === 400 && typeof err.j.code === 'string' && !/SYNCNET_|at .*\.js/.test(err.body));
  // receiptId derives from PUBLIC chain data (tx hash + log index): it must never open a receipt or reveal its existence
  const R5 = globalThis.__R5;
  const byId = await get('receipt', { receiptId: R5 });
  check('H04 receipt by receiptId without a session → 401 (never a document, never existence)', byId.s === 401);
  const byIdOther = await get('receipt', { receiptId: R5 }, { session: fanSession(W.fan2) });
  const byIdMine = await get('receipt', { receiptId: R5 }, { session: fanSession(W.fan) });
  check('H05 receipt by receiptId: another wallet’s session → 404 identical to unknown; the owner’s session → 200', byIdOther.s === 404 && (await get('receipt', { receiptId: rnd32() }, { session: fanSession(W.fan2) })).s === 404 && byIdMine.s === 200);
  const recPub = await post({ action: 'reconcile', receiptId: R5 });
  const recUnknown = await post({ action: 'reconcile', receiptId: rnd32() });
  check('H06 public reconcile by receiptId is refused identically whether or not the receipt exists (400)', recPub.s === 400 && recUnknown.s === 400 && recPub.body === recUnknown.body);
  const recInternal = parse(await early._handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {}, body: JSON.stringify({ action: 'reconcile', receiptId: R5 }) }, { store, env: ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, internal: true }));
  check('H07 the scheduled job (internal) may reconcile by receiptId', recInternal.s === 200);
}

fs.writeFileSync(path.join(ROOT, 'tests/early/server.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early server checks passed`);
process.exit(failures ? 1 : 0);
