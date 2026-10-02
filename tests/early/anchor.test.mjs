// EARLY anchoring suite: RLP + EIP-155 legacy signing against the published EIP-155 vector, the strictly validated
// anchor transaction (self-transfer, zero value, exact calldata, gas caps, chain id), OpenTimestamps serialization /
// submit / upgrade / status wording, the scheduled anchor job (deterministic bundle build, frozen bundles, stragglers,
// write-ahead single send, receipt confirmation, kill switches), and the independent receipt verifier end to end.
// Run: node tests/early/anchor.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, KEYS, W, sign, signDigest, TEST_KEYS_FILE, ENV, USDG, CH, clock, pc, resetPc, pay, makeSafe, makeFinal, syncHead, rpc, MAP, makeStore, resetStore, creatorSession } from './fixtures.mjs';
import { verifyReceipt } from '../../docs/early/verify-receipt.mjs';

const require = createRequire(import.meta.url);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const Tx = require(path.join(ROOT, 'netlify/lib/early-tx.js'));
const Ots = require(path.join(ROOT, 'netlify/lib/early-ots.js'));
const anchor = require(path.join(ROOT, 'netlify/functions/early-anchor.js'));
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } }
const throws = (name, fn, re) => { try { fn(); check(name, false, 'did not throw'); } catch (e) { check(name, !re || re.test(String(e.message)), e.message); } };
const store = makeStore();
let ipSeq = 0; const ip = () => `198.51.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const nowSec = () => Math.floor(clock.now() / 1000);
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body }; };
const api = async (method, body, query, over = {}) => parse(await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip(), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: over.env || ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE }));

// ============================================================================================ A. RLP / EIP-155 / anchor tx
resetStore(); resetPc();
{
  // EIP-155 spec example: nonce 9, gasPrice 20 gwei, gas 21000, to 0x3535…35, value 1e18, chainId 1, key 0x4646…46
  const key = '0x' + '46'.repeat(32);
  const signer = { address: lc(Core._internal.secp256k1.privateKeyToAddress(key)), sign: (d) => Core._internal.secp256k1.sign(d, key) };
  const tx = Tx.signLegacy({ signer, chainId: 1, nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: '0x' });
  check('A01 EIP-155 vector: signing hash', tx.signingDigest === '0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53');
  check('A02 EIP-155 vector: raw signed transaction', tx.raw === '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080' + '25a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83', tx.raw);
  const dec = Tx.decodeSigned(tx.raw);
  check('A03 decodeSigned recovers the sender and fields', dec.from === signer.address && dec.chainId === 1n && dec.nonce === 9n && dec.value === 10n ** 18n && dec.to === '0x3535353535353535353535353535353535353535' && dec.hash === tx.hash);
  check('A04 RLP round trip of nested lists and edge values', (() => { const items = [0n, 1n, 127n, 128n, 2n ** 64n, '0x', '0x00', new Uint8Array(56).fill(7), [[], ['0x01']]]; const enc = Tx.rlpEncode(items); const back = Tx.rlpDecode(enc); return Core.bytesToHex(Tx.rlpEncode(back)) === Core.bytesToHex(enc) && back[3].length === 1 && back[3][0] === 0x80 && back[0].length === 0; })());
  throws('A05 RLP non-canonical single byte refused', () => Tx.rlpDecode('0x8100'), /non-canonical/);
  const anchorKey = { address: W.anchor, sign: (d) => Core._internal.secp256k1.sign(d, KEYS.anchor) };
  const root = rnd32();
  const a = Tx.anchorTransaction({ signer: anchorKey, chainId: 4663, nonce: 0, gasPrice: 100000000n, gasLimit: 60000n, root, date: '2026-09-29' });
  const d2 = Tx.decodeSigned(a.raw);
  check('A06 anchor tx: self-transfer, zero value, exact 47-byte calldata, chain 4663, decodes root+date', d2.from === W.anchor && d2.to === W.anchor && d2.value === 0n && d2.chainId === 4663n && E.decodeAnchorCalldata(d2.data).root === root && E.decodeAnchorCalldata(d2.data).date === '2026-09-29' && Core.hexToBytes(d2.data).length === 47);
  throws('A07 anchor tx refuses another chain id', () => Tx.anchorTransaction({ signer: anchorKey, chainId: 1, nonce: 0, gasPrice: 1n, gasLimit: 60000n, root, date: '2026-09-29' }), /4663/);
  throws('A08 anchor tx refuses a gas limit above the cap', () => Tx.anchorTransaction({ signer: anchorKey, chainId: 4663, nonce: 0, gasPrice: 1n, gasLimit: Tx.MAX_GAS_LIMIT + 1n, root, date: '2026-09-29' }), /gas limit/);
  throws('A09 anchor tx refuses a gas price above the ceiling', () => Tx.anchorTransaction({ signer: anchorKey, chainId: 4663, nonce: 0, gasPrice: Tx.MAX_GAS_PRICE_WEI + 1n, gasLimit: 60000n, root, date: '2026-09-29' }), /gas price/);
  throws('A10 anchor tx refuses a bad root / date', () => Tx.anchorTransaction({ signer: anchorKey, chainId: 4663, nonce: 0, gasPrice: 1n, gasLimit: 60000n, root: '0x12', date: '2026-09-29' }));
  check('A11 the anchor code path has no way to name another destination or a value', !('to' in a.fields && a.fields.to !== a.fields.from) && a.fields.value === '0' && !/value:\s*BigInt\(value\)/.test('') && Tx.anchorTransaction.length === 1);
  check('A12 verifyAnchorTx accepts the mined shape and rejects another sender', Tx.verifyAnchorTx({ from: W.anchor, to: W.anchor, value: '0x0', input: a.fields.data }, W.anchor).ok && !Tx.verifyAnchorTx({ from: W.attacker, to: W.anchor, value: '0x0', input: a.fields.data }, W.anchor).ok && !Tx.verifyAnchorTx({ from: W.anchor, to: W.anchor, value: '0x1', input: a.fields.data }, W.anchor).ok);
  // ---- gas-price headroom (the live incident: quote 33,082,000 < base fee 33,198,000 → "max fee per gas less than block base fee")
  check('A13 the ceiling is still exactly 5 gwei', Tx.MAX_GAS_PRICE_WEI === 5000000000n);
  check('A14 headroom: ceil(quote × 1.5); the incident quote becomes comfortably above the incident base fee', Tx.anchorGasPrice(33082000n) === 49623000n && Tx.anchorGasPrice(33082000n) > 33198000n && Tx.anchorGasPrice(100000000n) === 150000000n && Tx.anchorGasPrice(3n) === 5n && Tx.anchorGasPrice(1n) === 2n);
  check('A15 the latest base fee is used when it is higher than the quote (headroom applies to the larger value)', Tx.anchorGasPrice(33082000n, 33198000n) === 49797000n && Tx.anchorGasPrice(33198000n, 33082000n) === 49797000n && Tx.anchorGasPrice(100n, 0n) === 150n && Tx.anchorGasPrice(100n, null) === 150n);
  check('A16 exactly at the ceiling is allowed (base 3,333,333,333 → 5,000,000,000)', Tx.anchorGasPrice(3333333333n) === Tx.MAX_GAS_PRICE_WEI);
  throws('A17 one wei over the ceiling after headroom fails closed (base 3,333,333,334 → 5,000,000,001), never clamped', () => Tx.anchorGasPrice(3333333334n), /above the ceiling/);
  throws('A18 a quote above the ceiling fails closed', () => Tx.anchorGasPrice(Tx.MAX_GAS_PRICE_WEI + 1n), /above the ceiling/);
  throws('A19 a base fee above the ceiling fails closed even when the quote is low', () => Tx.anchorGasPrice(1000n, Tx.MAX_GAS_PRICE_WEI), /above the ceiling/);
  throws('A20 zero / missing price is refused', () => Tx.anchorGasPrice(0n, 0n), /no usable gas price/);
  throws('A21 anchorTransaction independently keeps refusing a price above the ceiling (headroom helper cannot bypass it)', () => Tx.anchorTransaction({ signer: anchorKey, chainId: 4663, nonce: 0, gasPrice: Tx.anchorGasPrice(3333333333n) + 1n, gasLimit: 60000n, root, date: '2026-09-29' }), /ceiling/);
  const headroomTx = Tx.anchorTransaction({ signer: anchorKey, chainId: 4663, nonce: 1, gasPrice: Tx.anchorGasPrice(33082000n, 33198000n), gasLimit: 60000n, root, date: '2026-09-29' });
  const hd = Tx.decodeSigned(headroomTx.raw);
  check('A22 the headroom price still yields exactly the anchor transaction (self-transfer, value 0, exact calldata, chain 4663)', hd.gasPrice === 49797000n && hd.from === W.anchor && hd.to === W.anchor && hd.value === 0n && hd.chainId === 4663n && hd.data === E.anchorCalldata(root, '2026-09-29') && Core.hexToBytes(hd.data).length === 47);
}

// ============================================================================================ B. OpenTimestamps
const CAL = { mode: 'ok', upgrades: new Map(), calls: [] };
async function calFetch(url, init) {
  CAL.calls.push(String(url));
  const u = new URL(String(url));
  const body = (bytes, status = 200) => ({ ok: status < 400, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  if (CAL.mode === 'down') return body(new Uint8Array(0), 503);
  if (u.pathname === '/digest') { const digest = new Uint8Array(init.body); const prefix = Core.utf8Bytes('cal:' + u.hostname); return body(Ots.pendingTimestamp(u.origin, prefix)); }
  const m = /^\/timestamp\/([0-9a-f]{64})$/.exec(u.pathname);
  if (m) { const up = CAL.upgrades.get(m[1]); return up ? body(up) : body(new Uint8Array(0), 404); }
  return body(new Uint8Array(0), 404);
}
{
  const root = rnd32();
  const p = Ots.pendingTimestamp('https://cal.example', Core.utf8Bytes('x'));
  const [node, end] = Ots.parseTimestamp(p);
  check('B01 synthetic pending timestamp parses fully and re-serialises identically', end === p.length && Core.bytesToHex(Ots.serializeTimestamp(node)) === Core.bytesToHex(p));
  const atts = Ots.attestationsOf(node, Ots.otsDigest(root));
  check('B02 the stamped message is sha256(root); commitment = sha256(sha256(root) ‖ x) for the pending attestation', atts.length === 1 && atts[0].tag === Ots.TAG.PENDING && atts[0].commitment === '0x' + require('node:crypto').createHash('sha256').update(Buffer.concat([Buffer.from(Ots.otsDigest(root)), Buffer.from('x')])).digest('hex'));
  const sub = await Ots.submit(root, { fetch: calFetch, calendars: ['https://a.example', 'https://b.example'], now: () => clock.now() });
  check('B03 submit: both calendars ok, one merged proof, status "submitted" (never Bitcoin)', sub.calendars.every((c) => c.ok) && sub.proof && Ots.status(root, sub.proof) === 'submitted' && !Ots.hasBitcoin(root, sub.proof));
  const [mergedNode] = Ots.parseTimestamp(Uint8Array.from(Buffer.from(sub.proof, 'base64')));
  const pend = Ots.attestationsOf(mergedNode, Ots.otsDigest(root)).filter((x) => x.tag === Ots.TAG.PENDING);
  check('B04 merged proof holds one pending attestation per calendar', pend.length === 2);
  CAL.upgrades.set(pend[0].commitment.slice(2), Ots.bitcoinTimestamp(900000, Core.utf8Bytes('btc')));
  const up = await Ots.upgrade(root, sub.proof, { fetch: calFetch });
  check('B05 upgrade: one calendar answered with a Bitcoin attestation → bitcoin-verifiable, other still pending', up.upgraded === 1 && up.bitcoin === true && Ots.status(root, up.proof) === 'bitcoin-verifiable' && Ots.bitcoinHeights(root, up.proof).includes(900000) && up.errors.length === 1);
  const file = Ots.otsFile(root, up.proof);
  check('B06 .ots file: the reference HEADER_MAGIC (31 bytes, python-opentimestamps), version 1, sha256 digest op, sha256(root), then the timestamp', Core.bytesToHex(Ots.MAGIC) === '0x004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294' && Core.bytesToHex(file.subarray(0, 32)) === Core.bytesToHex(Ots.MAGIC) + '01' && file[32] === Ots.OP.SHA256 && Core.bytesToHex(file.subarray(33, 65)) === Core.bytesToHex(Ots.otsDigest(root)));
  CAL.mode = 'down';
  const down = await Ots.submit(root, { fetch: calFetch, calendars: ['https://a.example'] });
  check('B07 calendars down → proof null, status failed, no throw', down.proof === null && Ots.status(root, down.proof) === 'failed' && down.calendars[0].ok === false);
  CAL.mode = 'ok';
  throws('B08 unknown op refused', () => Ots.parseTimestamp(Uint8Array.of(0x99)), /unknown op/);
}

// ============================================================================================ C. anchor job
const job = async (over = {}) => parse(await anchor._handler({}, { store, env: over.env || ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: calFetch, calendars: ['https://a.example'], budgetMs: over.budgetMs }));
{
  // seed: a creator (two attestations + an enrolment snapshot queued for TODAY)
  const na = E.normalizeAcceptedAssets([{ token: USDG, minAmount: '1000000' }], E.parseAssetList(ASSETS));
  const m = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: W.creator, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: nowSec(), nonce: rnd32() };
  const act = await api('POST', { action: 'creator-manifest', creatorId: m.creatorId, channelId: CH, receivingWallet: W.creator, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorManifest', m, W.creator) }, null, { session: creatorSession(store) });
  const M1 = E.digest('CreatorManifest', m);
  const today = E.utcDate(nowSec());
  check('C01 seed: creator active, 3 leaves queued for today', act.s === 201 && (await store.smembers('early:bundle-queue:v1:' + today)).length === 3);
  const calBefore0 = CAL.calls.length, sentBefore0 = (pc.sent || []).length;
  const r0 = await job();
  check('C02 EMPTY DAYS: the 30-day look-back persists NO bundle at all (no record, no index entry), sends NO anchor tx and makes NO OpenTimestamps request; today is never built', r0.j.report.built.length === 0 && !MAP.has('early:bundle:v1:' + today) && ![...MAP.keys()].some((k) => k.startsWith('early:bundle:v1:')) && !MAP.has('early:bundles:v1') && (pc.sent || []).length === sentBefore0 && CAL.calls.length === calBefore0 && Object.keys(r0.j.report.anchored).length === 0 && Object.keys(r0.j.report.ots).length === 0, JSON.stringify(r0.j.report));
  const noop = await anchor._internals.buildBundle(store, '2020-01-01', new Date().toISOString());
  check('C02b buildBundle on a day with zero queued leaves is a clear no-op: {built:false, empty:true}, nothing persisted', noop.built === false && noop.empty === true && !MAP.has('early:bundle:v1:2020-01-01') && !(await store.smembers('early:bundles:v1')).includes('2020-01-01'));
  // (isolated store: this must not leave a real bundle in the shared state the rest of the section reasons about)
  const side = require(path.join(ROOT, 'netlify/lib/store.js')).createStore({ map: new Map(), now: () => clock.now() });
  const first = await anchor._internals.buildBundle(side, '2020-01-02', new Date().toISOString());
  await side.sadd('early:bundle-queue:v1:2020-01-02', E.leafHash('attestation', rnd32()));
  const late = await anchor._internals.buildBundle(side, '2020-01-02', new Date().toISOString());
  check('C02c a leaf queued for a day that was empty on an earlier run is built normally on the next run (nothing was frozen empty)', first.empty === true && late.built === true && late.bundle.leafCount === 1);
  clock.advance(86400 + 1500); syncHead(); // next day
  const r1 = await job();
  const b = JSON.parse(MAP.get('early:bundle:v1:' + today).value);
  check('C03 the one day WITH leaves is built (and only that one): sorted de-duplicated leaves, root reproducible', r1.j.report.built.length === 1 && r1.j.report.built.includes(today) && b.leafCount === 3 && E.merkleRoot(E.sortLeaves(b.leaves), today) === b.root && b.leaves.every((l, i) => i === 0 || BigInt(b.leaves[i - 1]) < BigInt(l)));
  check('C04 anchor tx sent once, write-ahead recorded before broadcast, self-transfer with the root', r1.j.report.anchored[today] === 'sent' && b.anchors.robinhood.status === 'sent' && pc.sent.length >= 1 && (() => { const d = Tx.decodeSigned(pc.sent[pc.sent.length - 1]); return d.from === W.anchor && d.to === W.anchor && d.value === 0n && E.decodeAnchorCalldata(d.data).root === b.root; })());
  check('C05 OTS submitted with honest wording', b.anchors.opentimestamps.status === 'submitted' && /Bitcoin-verifiable later/.test(b.anchors.opentimestamps.note) && !/anchored in Bitcoin/i.test(JSON.stringify(b)));
  const sentBefore = pc.sent.length;
  const r2 = await job();
  const b2 = JSON.parse(MAP.get('early:bundle:v1:' + today).value);
  check('C06 next run: the mined receipt confirms the anchor; nothing is re-sent', r2.j.report.anchored[today] === 'confirmed' && b2.anchors.robinhood.status === 'confirmed' && /^\d+$/.test(b2.anchors.robinhood.blockNumber) && pc.sent.length === sentBefore);
  // a straggler attestation for the built day moves to the next unbuilt day
  const { signer, earlyConfig } = require(path.join(ROOT, 'netlify/lib/early-config.js'));
  const Attest = require(path.join(ROOT, 'netlify/lib/early-attest.js'));
  const bd = await Attest.bundleDateFor(store, nowSec() - 86400 - 1000);
  check('C07 bundleDate rule: an attestation issued "yesterday" after yesterday was built goes to the next unbuilt day', bd === E.utcDate(nowSec()));
  const rebuilt = await anchor._internals.buildBundle(store, today, new Date().toISOString());
  check('C08 rebuilding a built day reproduces its root and changes nothing', rebuilt.built === false && rebuilt.bundle.root === b.root);
  // inclusion proofs now resolve for the receipt / manifest views
  const mv = (await api('GET', null, { view: 'manifest', manifestHash: M1 })).j;
  check('C09 manifest attestations carry inclusion proofs that verify under the anchored root', mv.manifest.attestations.every((a) => a.inclusion && a.inclusion.root === b.root && E.verifyProof(a.inclusion.leaf, a.inclusion.siblings, b.root)));
  const bv = (await api('GET', null, { view: 'bundle', date: today })).j;
  check('C10 public bundle view: leaves, root, anchors (tx hash, OTS status), enough to recompute', bv.built && bv.bundle.leaves.length === 3 && bv.bundle.anchors.robinhood.txHash && bv.bundle.anchors.opentimestamps.status === 'submitted');
  // OTS upgrade on a later run
  const [node] = Ots.parseTimestamp(Uint8Array.from(Buffer.from(b2.anchors.opentimestamps.proof, 'base64')));
  const pend = Ots.attestationsOf(node, Ots.otsDigest(b.root)).find((x) => x.tag === Ots.TAG.PENDING);
  CAL.upgrades.set(pend.commitment.slice(2), Ots.bitcoinTimestamp(910000));
  const r3 = await job();
  check('C11 OTS upgrade → bitcoin-verifiable with the height recorded', r3.j.report.upgraded[today] === 'bitcoin-verifiable' && JSON.parse(MAP.get('early:bundle:v1:' + today).value).anchors.opentimestamps.bitcoinHeights.includes(910000));
  // a real attestation leaf for the CURRENT day (the day the next section anchors); days without leaves are never anchored
  const attSigner = signer(ENV, earlyConfig({ env: ENV, store, now: () => clock.now(), keysFile: TEST_KEYS_FILE }));
  const seedLeaf = async () => { const d = await Attest.bundleDateFor(store, nowSec()); await Attest.issue(store, attSigner, { type: 'audience-snapshot', subject: { channelId: CH }, claims: { channelId: CH, dateUTC: d, subscriberCount: 1, hiddenSubscriberCount: false, title: 'seed', fetchedAt: nowSec(), source: 'test' }, issuedAt: nowSec(), bundleDate: d }); return d; };
  const seeded2 = await seedLeaf();
  // kill switches
  clock.advance(86400); syncHead();
  const r4 = await job({ env: { ...ENV, SYNCNET_EARLY_ANCHOR_DISABLED: 'true' } });
  const day2 = E.utcDate(nowSec() - 86400);
  check('C11b the seeded day is the day that was built (a day WITH a leaf)', day2 === seeded2 && JSON.parse(MAP.get('early:bundle:v1:' + day2).value).leafCount === 1);
  check('C12 SYNCNET_EARLY_ANCHOR_DISABLED: bundles still build and OTS still submits, no chain tx', r4.j.report.anchorDisabled === true && r4.j.report.built.includes(day2) && !(day2 in r4.j.report.anchored) && JSON.parse(MAP.get('early:bundle:v1:' + day2).value).anchors.robinhood === null);
  const r5 = await job({ env: { ...ENV, SYNCNET_EARLY_ANCHOR_KEY: '' } });
  check('C13 no anchor key → anchoring off (fail closed), everything else proceeds', r5.j.report.anchorDisabled === true);
  const priceSpike = await (async () => { const orig = pc.gasPrice; const r = await (async () => { const rp = async (m, p) => (m === 'eth_gasPrice' ? '0x' + (Tx.MAX_GAS_PRICE_WEI + 1n).toString(16) : rpc(m, p)); return parse(await anchor._handler({}, { store, env: ENV, rpc: rp, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: calFetch, calendars: ['https://a.example'] })); })(); return r; })();
  check('C14 gas price above the ceiling → anchor attempt refused (error recorded), retried later, never sent', priceSpike.j.report.anchored[day2] === 'error' && JSON.parse(MAP.get('early:bundle:v1:' + day2).value).anchors.robinhood === null);
  const sentBeforeCeiling = (pc.sent || []).length;
  const nearCeiling = parse(await anchor._handler({}, { store, env: ENV, rpc: async (m, p) => (m === 'eth_gasPrice' ? '0x' + (4000000000n).toString(16) : rpc(m, p)), now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: calFetch, calendars: ['https://a.example'] }));
  check('C14b a quote UNDER the ceiling whose headroom price would be over it (4 gwei → 6 gwei) fails closed: error, no record written, nothing sent, ceiling not raised', nearCeiling.j.report.anchored[day2] === 'error' && JSON.parse(MAP.get('early:bundle:v1:' + day2).value).anchors.robinhood === null && (pc.sent || []).length === sentBeforeCeiling);
  const r6 = await job();
  check('C15 next hour at a normal price: anchored', r6.j.report.anchored[day2] === 'sent');
  const normalTx = Tx.decodeSigned(pc.sent[pc.sent.length - 1]);
  const rec2 = JSON.parse(MAP.get('early:bundle:v1:' + day2).value).anchors.robinhood;
  check('C15b headroom applied: the broadcast gas price is ceil(1.5 × the 100,000,000 wei quote) = 150,000,000 and the record shows quote and price', normalTx.gasPrice === 150000000n && rec2.gasPrice === '150000000' && rec2.quotedGasPrice === '100000000', String(normalTx.gasPrice));
  // ---- the live incident, reproduced: quote 33,082,000 wei but the latest block's base fee is already 33,198,000, plus legacy EMPTY bundle records
  const seeded3 = await seedLeaf();
  clock.advance(86400); syncHead();
  const emptyDates = [];
  for (let i = 1; i <= 35; i++) emptyDates.push(E.utcDate(nowSec() + i * 86400)); // newer than every real bundle: they would fill the newest-30 window
  emptyDates.push(E.utcDate(nowSec() - 9 * 86400)); // and one inside the look-back
  for (const d of emptyDates) {
    await store.set('early:bundle:v1:' + d, JSON.stringify({ schema: E.SCHEMA.bundle, date: d, leafType: 'attestation', leaves: [], leafCount: 0, root: E.emptyRoot(d), builtAt: new Date(clock.now()).toISOString(), anchors: { robinhood: null, opentimestamps: null } }));
    await store.sadd('early:bundles:v1', d);
  }
  const incidentRpc = async (m, p) => {
    if (m === 'eth_gasPrice') return '0x' + (33082000n).toString(16);
    if (m === 'eth_getBlockByNumber' && p[0] === 'latest') return { ...(await rpc(m, p)), baseFeePerGas: '0x' + (33198000n).toString(16) };
    return rpc(m, p);
  };
  const sentBeforeIncident = (pc.sent || []).length;
  const rI = parse(await anchor._handler({}, { store, env: ENV, rpc: incidentRpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: calFetch, calendars: ['https://a.example'] }));
  const day3 = E.utcDate(nowSec() - 86400);
  check('C15c a real bundle is not crowded out by 36 legacy empty bundle records: day with a leaf is anchored and submitted', day3 === seeded3 && rI.j.report.anchored[day3] === 'sent' && rI.j.report.ots[day3] === 'submitted', JSON.stringify(rI.j.report));
  const incidentTx = Tx.decodeSigned(pc.sent[pc.sent.length - 1]);
  check('C15d incident: with quote 33,082,000 < base fee 33,198,000 the broadcast price is ceil(1.5 × 33,198,000) = 49,797,000 (> base fee), under the 5 gwei ceiling', (pc.sent.length === sentBeforeIncident + 1) && incidentTx.gasPrice === 49797000n && incidentTx.gasPrice > 33198000n && incidentTx.gasPrice <= Tx.MAX_GAS_PRICE_WEI);
  check('C15e pre-existing empty bundles are skipped: counted, never anchored / submitted / upgraded, records untouched', rI.j.report.skippedEmpty === 36 && emptyDates.every((d) => !(d in rI.j.report.anchored) && !(d in rI.j.report.ots) && !(d in rI.j.report.upgraded)) && emptyDates.every((d) => { const x = JSON.parse(MAP.get('early:bundle:v1:' + d).value); return x.anchors.robinhood === null && x.anchors.opentimestamps === null; }));
  const realDates = new Set([today, day2, day3]);
  check('C15f only days with leaves appear in the job report (anchored / ots / upgraded)', [...Object.keys(rI.j.report.anchored), ...Object.keys(rI.j.report.ots), ...Object.keys(rI.j.report.upgraded)].every((d) => realDates.has(d)));
  // direct calls on an empty record (defence in depth)
  const emptyRec = JSON.parse(MAP.get('early:bundle:v1:' + emptyDates[0]).value);
  const sentBeforeDirect = (pc.sent || []).length, calBeforeDirect = CAL.calls.length;
  const dA = await anchor._internals.anchorOnChain(store, rpc, { address: W.anchor, sign: (x) => Core._internal.secp256k1.sign(x, KEYS.anchor) }, emptyRec, () => clock.now());
  const dO = await anchor._internals.submitOts(store, calFetch, emptyRec, () => clock.now(), ['https://a.example']);
  const dU = await anchor._internals.upgradeOts(store, calFetch, emptyRec, () => clock.now());
  check('C15g even if called directly with an empty bundle: anchorOnChain / submitOts / upgradeOts refuse (no tx, no OTS request)', dA === 'empty' && dO === 'empty' && dU === 'skip' && (pc.sent || []).length === sentBeforeDirect && CAL.calls.length === calBeforeDirect);
  // ---- every transaction the whole section ever sent: self-transfer only, value 0, exact anchor calldata, chain 4663, root of a NON-empty bundle
  const allBundles = [...MAP.entries()].filter(([k]) => k.startsWith('early:bundle:v1:')).map(([, v]) => JSON.parse(v.value));
  const okRoots = new Set(allBundles.filter((x) => x.leafCount > 0).map((x) => x.root));
  const invariants = (pc.sent || []).map((raw) => { const t = Tx.decodeSigned(raw); const c = E.decodeAnchorCalldata(t.data); return t.from === W.anchor && t.to === W.anchor && t.value === 0n && t.chainId === 4663n && Core.hexToBytes(t.data).length === 47 && c && okRoots.has(c.root) && c.root !== E.emptyRoot(c.date) && t.gasPrice <= Tx.MAX_GAS_PRICE_WEI && t.gasLimit <= Tx.MAX_GAS_LIMIT; });
  check('C15h every anchor tx ever sent in this suite is a self-transfer, value 0, exactly 47 bytes of anchor calldata, chain 4663, for a non-empty bundle root, within the gas caps', invariants.length >= 3 && invariants.every(Boolean), invariants.join(','));
  // ---- BROADCAST REFUSAL: a synchronous, deterministic RPC refusal frees the attempt at once; anything ambiguous stays `sent` for the hour
  {
    const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
    const sgn = { address: W.anchor, sign: (x) => Core._internal.secp256k1.sign(x, KEYS.anchor) };
    const T0 = clock.now(), HOUR = 3600000;
    let seq = 0;
    const iso = async () => { // an isolated store holding one real-looking, non-empty, unanchored bundle
      const s = createStore({ map: new Map(), now: () => clock.now() });
      const date = '2031-03-' + String(10 + seq++).padStart(2, '0');
      const leaf = E.leafHash('attestation', rnd32());
      await s.set('early:bundle:v1:' + date, JSON.stringify({ schema: E.SCHEMA.bundle, date, leafType: E.LEAF_ATTESTATION, leaves: [leaf], leafCount: 1, root: E.merkleRoot([leaf], date), builtAt: new Date(T0).toISOString(), anchors: { robinhood: null, opentimestamps: null } }));
      return { s, date, rec: async () => JSON.parse(await s.get('early:bundle:v1:' + date)).anchors.robinhood };
    };
    const calls = { lookups: 0 };
    const refuse = (msg, extra = {}, lookup = () => null) => async (m, p) => {
      if (m === 'eth_sendRawTransaction') throw Object.assign(new Error(msg), { name: 'RpcError', code: -32000 }, extra);
      if (m === 'eth_getTransactionByHash') { calls.lookups++; return lookup(p); }
      return rpc(m, p);
    };
    const go = (x, rp, t) => anchor._internals.anchorOnChain(x.s, rp, sgn, { date: x.date }, () => t).catch((e) => 'threw');
    const BASEFEE = 'max fee per gas less than block base fee: maxFeePerGas 33082000, baseFee 33198000';
    const sentN = () => (pc.sent || []).length;

    // 1. the live incident: refusal -> broadcast-failed, audit fields kept, immediately retryable, retried once
    const A = await iso(); const n0 = sentN(); const nonce0 = pc.nonce || 0;
    const a1 = await go(A, refuse(BASEFEE), T0);
    const fr = await A.rec();
    check('C18 synchronous refusal ("max fee per gas less than block base fee") → state broadcast-failed (not sent); nothing reached the chain', a1 === 'broadcast-failed' && fr.status === 'broadcast-failed' && sentN() === n0 && (pc.nonce || 0) === nonce0, JSON.stringify(fr));
    check('C18b the failed attempt keeps txHash, nonce, gas fields, sentAt, attempts and a sanitized error + failedAt', /^0x[0-9a-f]{64}$/.test(fr.txHash) && fr.nonce === String(nonce0) && fr.gasPrice === '150000000' && fr.quotedGasPrice === '100000000' && /^\d+$/.test(fr.gasLimit) && fr.sentAt === new Date(T0).toISOString() && fr.failedAt === new Date(T0).toISOString() && fr.attempts === 1 && /max fee per gas less than block base fee/.test(fr.broadcastError) && fr.broadcastError.length <= 200);
    const a2 = await go(A, rpc, T0); // same instant: no one-hour wait
    const fs2 = await A.rec();
    check('C19 the next run retries IMMEDIATELY (same instant, no 1 h wait): exactly one new tx, status sent, attempts 2, same nonce reused (the refused tx never existed); with unchanged inputs it is the byte-identical tx, so even a wrongly-assumed refusal could never produce a second transfer', a2 === 'sent' && fs2.status === 'sent' && fs2.attempts === 2 && sentN() === n0 + 1 && fs2.nonce === String(nonce0) && fs2.txHash === fr.txHash, JSON.stringify(fs2));
    const retryTx = Tx.decodeSigned(pc.sent[pc.sent.length - 1]);
    check('C19b the retry is still the anchor transaction: self-transfer, value 0, 47-byte calldata, chain 4663, headroom price within the ceiling', retryTx.from === W.anchor && retryTx.to === W.anchor && retryTx.value === 0n && retryTx.chainId === 4663n && Core.hexToBytes(retryTx.data).length === 47 && retryTx.gasPrice === 150000000n && retryTx.gasPrice <= Tx.MAX_GAS_PRICE_WEI);

    // 2. a successful broadcast stays `sent`, and is not re-sent while pending
    const B = await iso(); const nB = sentN();
    const noReceipt = async (m, p) => (m === 'eth_getTransactionReceipt' ? null : rpc(m, p));
    const b1 = await go(B, noReceipt, T0);
    const b2 = await go(B, noReceipt, T0 + 10 * 60000);
    check('C20 successful broadcast → status sent (unchanged behaviour); a re-run while unconfirmed is "pending" and sends nothing', b1 === 'sent' && (await B.rec()).status === 'sent' && b2 === 'pending' && sentN() === nB + 1);

    // 3. ambiguous failures: NEVER an immediate retry; the one-hour protection stays
    const ambiguous = [
      ['request timeout', refuse('RPC timeout', { transient: true, code: undefined })],
      ['HTTP 503', refuse('RPC HTTP 503', { transient: true, code: undefined })],
      ['"already known"', refuse('already known')],
      ['"nonce too low"', refuse('nonce too low')],
      ['"replacement transaction underpriced"', refuse('replacement transaction underpriced')],
      ['unlisted message', refuse('something unexpected')],
      ['refusal text but NOT a JSON-RPC error response (no code)', refuse(BASEFEE, { code: undefined })],
      ['refusal text but the node already knows the tx', refuse(BASEFEE, {}, () => ({ hash: 'x' }))],
      ['refusal text but the node lookup fails', refuse(BASEFEE, {}, () => { throw new Error('lookup down'); })],
    ];
    let allHeld = true, anySend = false; const detail = [];
    for (const [label, rp] of ambiguous) {
      const X = await iso(); const nx = sentN();
      const f = await go(X, rp, T0);
      const rec1 = await X.rec();
      const again = await go(X, rpc, T0 + 59 * 60000); // 59 min later: still protected
      const held = f === 'threw' && rec1.status === 'sent' && again === 'pending' && sentN() === nx;
      const later = await go(X, rpc, T0 + HOUR + 60000); // after the hour: the old retry rule still applies, exactly once
      const ok = held && later === 'sent' && sentN() === nx + 1;
      if (!ok) { allHeld = false; detail.push(label + ':' + [f, rec1 && rec1.status, again, later, sentN() - nx].join('/')); }
      if (sentN() > nx + 1) anySend = true;
    }
    check('C21 nine ambiguous failures (timeout, 503, already known, nonce too low, underpriced, unlisted text, no JSON-RPC code, node knows the tx, lookup fails) stay `sent`: not retried at once, not at 59 min, retried exactly once after the hour', allHeld && !anySend, detail.join(' | '));

    // 4. old stuck `sent` records stay conservatively protected (e.g. the 2026-09-30 preview record) and are not "rescued" by the new code
    const O = await iso();
    await O.s.set('early:bundle:v1:' + O.date, JSON.stringify({ ...JSON.parse(await O.s.get('early:bundle:v1:' + O.date)), anchors: { robinhood: { status: 'sent', txHash: '0x' + '11'.repeat(32), from: W.anchor, nonce: '5', gasPrice: '33082000', gasLimit: '72000', sentAt: new Date(T0).toISOString(), attempts: 1 }, opentimestamps: null } }));
    const lookupsBefore = calls.lookups, nO = sentN();
    const o1 = await go(O, refuse(BASEFEE), T0 + 30 * 60000);
    const o2 = await go(O, refuse(BASEFEE), T0 + HOUR - 1000);
    check('C22 a pre-existing `sent` record is not retried early and not reclassified (no evidence lookup, no send) until the hour has passed', o1 === 'pending' && o2 === 'pending' && sentN() === nO && calls.lookups === lookupsBefore && (await O.rec()).status === 'sent');

    // 5. no double-send path: concurrent attempts, repeated refusals, mixed outcomes
    const C = await iso(); const nC = sentN();
    const race = await Promise.all([go(C, rpc, T0), go(C, rpc, T0), go(C, rpc, T0)]);
    check('C23 three concurrent attempts on one bundle: exactly one broadcast (write-ahead CAS), the others see a conflict/pending', sentN() === nC + 1 && race.filter((x) => x === 'sent').length === 1, race.join(','));
    const D = await iso(); const nD = sentN();
    const d1 = await go(D, refuse(BASEFEE), T0), d2 = await go(D, refuse(BASEFEE), T0), d3 = await go(D, rpc, T0), d4 = await go(D, noReceipt, T0 + 1000);
    const drec = await D.rec();
    check('C24 refused twice then accepted: only the accepted attempt reaches the chain, attempts counts all three, and the next run sees it as pending (no further send)', d1 === 'broadcast-failed' && d2 === 'broadcast-failed' && d3 === 'sent' && drec.attempts === 3 && sentN() === nD + 1 && (d4 === 'pending' || d4 === 'confirmed'));
    const E2 = await iso(); const nE = sentN();
    await go(E2, refuse(BASEFEE), T0);
    const stale = JSON.parse(await E2.s.get('early:bundle:v1:' + E2.date));
    const deadSigner = await Promise.all([go(E2, rpc, T0), go(E2, rpc, T0)]);
    check('C25 a refused attempt can be retried by only one of two racing runs', sentN() === nE + 1 && deadSigner.filter((x) => x === 'sent').length === 1 && stale.anchors.robinhood.status === 'broadcast-failed');

    // 6. job level: the whole handler retries a refused day on the very next run, no hour wait
    const seeded5 = await seedLeaf();
    clock.advance(86400); syncHead();
    const day5 = E.utcDate(nowSec() - 86400);
    const nJ = sentN();
    const jobRefuse = parse(await anchor._handler({}, { store, env: ENV, rpc: refuse(BASEFEE), now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: calFetch, calendars: ['https://a.example'] }));
    const jr1 = JSON.parse(MAP.get('early:bundle:v1:' + day5).value).anchors.robinhood;
    const jobRetry = await job();
    const jr2 = JSON.parse(MAP.get('early:bundle:v1:' + day5).value).anchors.robinhood;
    check('C26 job level: a refused broadcast is reported broadcast-failed, and the very next job run anchors it (one tx, status sent) without waiting an hour', day5 === seeded5 && jobRefuse.j.report.anchored[day5] === 'broadcast-failed' && jr1.status === 'broadcast-failed' && jobRetry.j.report.anchored[day5] === 'sent' && jr2.status === 'sent' && jr2.attempts === 2 && sentN() === nJ + 1, JSON.stringify([jobRefuse.j.report.anchored[day5], jr1.status, jobRetry.j.report.anchored[day5], jr2.status]));
    const allTx = (pc.sent || []).map((raw) => Tx.decodeSigned(raw));
    check('C27 whole section: every transaction ever sent (including all retries) is a self-transfer, value 0, 47-byte calldata, chain 4663, within the gas caps; no nonce/hash is broadcast twice for different attempts of one bundle', allTx.every((t) => t.from === W.anchor && t.to === W.anchor && t.value === 0n && t.chainId === 4663n && Core.hexToBytes(t.data).length === 47 && t.gasPrice <= Tx.MAX_GAS_PRICE_WEI && t.gasLimit <= Tx.MAX_GAS_LIMIT) && new Set(allTx.map((t) => t.hash)).size === allTx.length);
  }
  const off = await job({ env: {} });
  check('C16 disabled deployment → skipped', off.j.skipped === 'disabled');
  MAP.set('early:anchor-lock:v1', { type: 'string', value: '1', expiresAt: clock.now() + 60000 });
  check('C17 one run at a time', (await job()).j.skipped === 'running');
  MAP.delete('early:anchor-lock:v1');

  // ============================================================================================ D. independent verifier, end to end
  const d = await api('POST', { action: 'intent-draft', manifestHash: M1, sender: W.fan, token: USDG, amount: '1500000' });
  const st = await api('POST', { action: 'intent-store', intentId: d.j.intentId, signature: signDigest(W.fan, Core.hashTypedData(d.j.typedData)) });
  const p = pay({ from: W.fan, to: W.creator, amount: '1500000' }); makeFinal(p.blockNumber);
  const v = await api('POST', { action: 'verify', intentId: st.j.intent.intentId, txHash: p.txHash });
  const doc = (await api('GET', null, { view: 'receipt', intent: st.j.intent.intentId })).j.receipt;
  const bundleOf = async (date) => (await api('GET', null, { view: 'bundle', date })).j.bundle;
  const bundles = {}; for (const a of doc.attestations) bundles[a.bundleDate] = await bundleOf(a.bundleDate);
  const rpcForVerifier = async (m, params) => (m === 'eth_getTransactionByHash' ? { from: W.anchor, to: W.anchor, value: '0x0', input: E.anchorCalldata(bundles[Object.keys(bundles)[0]].root, Object.keys(bundles)[0]) } : rpc(m, params));
  const ver = await verifyReceipt(doc, { rpc: rpcForVerifier, registry: TEST_KEYS_FILE, bundles: Object.fromEntries(Object.entries(bundles).filter(([, b]) => b)) });
  check('D01 verifier: FINALIZED auto receipt verifies offline + on the mock chain + attestations + inclusion', v.j.status === 'FINALIZED' && ver.ok, JSON.stringify(ver.checks.filter((c) => !c.ok)));
  check('D02 verifier states that ordering is not independently verifiable', ver.checks.some((c) => c.id === 'ordering' && /not independently verifiable/.test(c.label)));
  const tampered = JSON.parse(JSON.stringify(doc)); tampered.fact.transfer.value = '1500001';
  const bad = await verifyReceipt(tampered, { registry: TEST_KEYS_FILE, bundles: {} });
  check('D03 verifier rejects a tampered amount', !bad.ok && bad.checks.some((c) => c.id === 'token-amount' && !c.ok));
  const forged = JSON.parse(JSON.stringify(doc)); forged.attestations[0].claims.receivingWallet = W.attacker;
  const bad2 = await verifyReceipt(forged, { registry: TEST_KEYS_FILE, bundles: {} });
  check('D04 verifier rejects a tampered attestation (id/signature)', bad2.checks.some((c) => c.id.startsWith('att-') && !c.ok));
  const swapped = JSON.parse(JSON.stringify(doc)); swapped.intent.signature = signDigest(W.fan2, Core.hashTypedData(doc.intent.typedData));
  const bad3 = await verifyReceipt(swapped, { registry: TEST_KEYS_FILE, bundles: {} });
  check('D05 verifier rejects an intent signed by someone else', bad3.checks.some((c) => c.id === 'intent-signer' && !c.ok));
  fs.writeFileSync(path.join(ROOT, 'tests/early/sample-receipt.json'), JSON.stringify({ receipt: doc }, null, 2));
}

fs.writeFileSync(path.join(ROOT, 'tests/early/anchor.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early anchor checks passed`);
process.exit(failures ? 1 : 0);
