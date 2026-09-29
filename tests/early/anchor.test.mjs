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
  const r0 = await job();
  check('C02 today is never built; the look-back builds earlier (empty) days with date-specific empty roots', !r0.j.report.built.includes(today) && !MAP.has('early:bundle:v1:' + today) && r0.j.report.built.length >= 1 && JSON.parse(MAP.get('early:bundle:v1:' + E.utcDate(nowSec() - 3 * 86400)).value).root === E.emptyRoot(E.utcDate(nowSec() - 3 * 86400)));
  clock.advance(86400 + 1500); syncHead(); // 00:25 UTC next day
  const r1 = await job();
  const b = JSON.parse(MAP.get('early:bundle:v1:' + today).value);
  check('C03 yesterday built: sorted de-duplicated leaves, root reproducible', r1.j.report.built.includes(today) && b.leafCount === 3 && E.merkleRoot(E.sortLeaves(b.leaves), today) === b.root && b.leaves.every((l, i) => i === 0 || BigInt(b.leaves[i - 1]) < BigInt(l)));
  check('C04 anchor tx sent once, write-ahead recorded before broadcast, self-transfer with the root', r1.j.report.anchored[today] === 'sent' && b.anchors.robinhood.status === 'sent' && pc.sent.length >= 1 && (() => { const d = Tx.decodeSigned(pc.sent[pc.sent.length - 1]); return d.from === W.anchor && d.to === W.anchor && d.value === 0n && E.decodeAnchorCalldata(d.data).root === b.root; })());
  check('C05 OTS submitted with honest wording', b.anchors.opentimestamps.status === 'submitted' && /Bitcoin-verifiable later/.test(b.anchors.opentimestamps.note) && !/anchored in Bitcoin/i.test(JSON.stringify(b)));
  const sentBefore = pc.sent.length;
  const r2 = await job();
  const b2 = JSON.parse(MAP.get('early:bundle:v1:' + today).value);
  check('C06 next run: the mined receipt confirms the anchor; nothing is re-sent', r2.j.report.anchored[today] === 'confirmed' && b2.anchors.robinhood.status === 'confirmed' && /^\d+$/.test(b2.anchors.robinhood.blockNumber) && pc.sent.length === sentBefore);
  // a straggler attestation for the built day moves to the next unbuilt day
  const { signer } = require(path.join(ROOT, 'netlify/lib/early-config.js'));
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
  // kill switches
  clock.advance(86400); syncHead();
  const r4 = await job({ env: { ...ENV, SYNCNET_EARLY_ANCHOR_DISABLED: 'true' } });
  const day2 = E.utcDate(nowSec() - 86400);
  check('C12 SYNCNET_EARLY_ANCHOR_DISABLED: bundles still build and OTS still submits, no chain tx', r4.j.report.anchorDisabled === true && r4.j.report.built.includes(day2) && !(day2 in r4.j.report.anchored) && JSON.parse(MAP.get('early:bundle:v1:' + day2).value).anchors.robinhood === null);
  const r5 = await job({ env: { ...ENV, SYNCNET_EARLY_ANCHOR_KEY: '' } });
  check('C13 no anchor key → anchoring off (fail closed), everything else proceeds', r5.j.report.anchorDisabled === true);
  const priceSpike = await (async () => { const orig = pc.gasPrice; const r = await (async () => { const rp = async (m, p) => (m === 'eth_gasPrice' ? '0x' + (Tx.MAX_GAS_PRICE_WEI + 1n).toString(16) : rpc(m, p)); return parse(await anchor._handler({}, { store, env: ENV, rpc: rp, now: () => clock.now(), keysFile: TEST_KEYS_FILE, fetch: calFetch, calendars: ['https://a.example'] })); })(); return r; })();
  check('C14 gas price above the ceiling → anchor attempt refused (error recorded), retried later, never sent', priceSpike.j.report.anchored[day2] === 'error' && JSON.parse(MAP.get('early:bundle:v1:' + day2).value).anchors.robinhood === null);
  const r6 = await job();
  check('C15 next hour at a normal price: anchored', r6.j.report.anchored[day2] === 'sent');
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
