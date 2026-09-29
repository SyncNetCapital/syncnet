// SYNC Proof / EARLY — protocol primitives (lib/syncnet-early.js): EIP-712 domain/types, canonical JSON, canonical
// asset identity, Merkle bundle format, attestation ids/signatures, the public matching rule (pure parts), receipt ids.
// Golden vectors: tests/early/vectors.json (regenerate with WRITE_VECTORS=1 only when a schema version changes).
// Run: node tests/early/unit.test.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const E = require(path.join(ROOT, 'lib/syncnet-early.js'));
const ASSETS = require(path.join(ROOT, 'syncnet-early-assets.json'));
const KEYS = require(path.join(ROOT, 'syncnet-early-keys.json'));
const VECTORS_PATH = path.join(ROOT, 'tests/early/vectors.json');

const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 300)); } }
const throws = (name, fn, re) => { try { fn(); check(name, false, 'did not throw'); } catch (e) { check(name, !re || re.test(String(e.message)), e.message); } };
const lc = E.lc;
const K1 = '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const K2 = '0x' + '11'.repeat(32);
const ADDR1 = lc(Core._internal.secp256k1.privateKeyToAddress(K1)), ADDR2 = lc(Core._internal.secp256k1.privateKeyToAddress(K2));
const CH = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const b32 = (i) => '0x' + String(i).padStart(2, '0').repeat(32);
const vectors = {};

// ---------------------------------------------------------------- domain / types
check('domain pinned', E.DOMAIN.name === 'SyncNet SYNC Proof' && E.DOMAIN.version === '1' && E.DOMAIN.chainId === 4663 && !('verifyingContract' in E.DOMAIN));
check('every type carries a schema string first', Object.keys(E.TYPES).every((k) => E.TYPES[k][0].name === 'schema' && E.TYPES[k][0].type === 'string' && E.SCHEMA_OF[k]));
check('no Marketplace/Website domain confusion', E.DOMAIN.name !== 'SyncNet Marketplace' && E.DOMAIN.name !== 'SyncNet Website' && E.DOMAIN.name !== 'SyncNet Economies');
const intentMsg = { schema: E.SCHEMA.intent, intentId: b32(1), manifestHash: b32(2), creatorId: E.creatorIdOf(CH), chainId: 4663, sender: ADDR1, receiver: ADDR2, token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', amount: '1500000', notBefore: 1790000000, expiry: 1790007200, privacy: 'PRIVATE' };
const intentDigest = E.digest('SupportIntent', intentMsg);
vectors.supportIntentDigest = intentDigest;
check('SupportIntent digest is bytes32', E.isBytes32(intentDigest));
const sig = Core._internal.secp256k1.sign(intentDigest, K1);
check('SupportIntent signature recovers to sender', lc(Core.recoverAddress(intentDigest, sig)) === ADDR1);
check('sameTypedData accepts the exact payload', E.sameTypedData('SupportIntent', intentMsg, E.typedData('SupportIntent', intentMsg)));
check('sameTypedData rejects a changed receiver', !E.sameTypedData('SupportIntent', intentMsg, E.typedData('SupportIntent', { ...intentMsg, receiver: ADDR1 })));
check('sameTypedData rejects a foreign domain', !E.sameTypedData('SupportIntent', intentMsg, { ...E.typedData('SupportIntent', intentMsg), domain: { name: 'SyncNet Marketplace', version: '1', chainId: 4663 } }));
check('a different chainId changes the digest', E.digest('SupportIntent', { ...intentMsg, chainId: 1 }) !== intentDigest);
check('amount 1 unit off changes the digest', E.digest('SupportIntent', { ...intentMsg, amount: '1500001' }) !== intentDigest);
const manifestMsg = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: ADDR2, acceptedAssetsHash: b32(9), manifestVersion: 1, previousManifestHash: E.ZERO32, issuedAt: 1790000000, nonce: b32(7) };
vectors.creatorManifestDigest = E.digest('CreatorManifest', manifestMsg);
vectors.countMeInDigest = E.digest('CountMeIn', { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId: CH, fan: ADDR1, issuedAt: 1790000000, expiry: 1790000000 + E.CONST.CMI_TTL_S, nonce: b32(3) });
vectors.finalizeDigest = E.digest('SupportFinalize', { schema: E.SCHEMA.finalize, intentId: b32(1), txHash: b32(4), logIndex: 2, issuedAt: 1790000000, nonce: b32(5) });
throws('unknown structure refused', () => E.typedData('Listing', {}), /unknown/);

// ---------------------------------------------------------------- canonical JSON
check('canonicalJson sorts keys at every level', E.canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }) === '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
check('canonicalJson drops undefined, keeps null, stringifies bigint', E.canonicalJson({ a: undefined, b: null, c: 5n }) === '{"b":null,"c":"5"}');
throws('canonicalJson refuses floats', () => E.canonicalJson({ a: 1.5 }), /safe integers/);
check('hashJson stable', E.hashJson({ a: 1, b: 2 }) === E.hashJson({ b: 2, a: 1 }));
vectors.hashJsonSample = E.hashJson({ b: 2, a: [1, 'x', null] });

// ---------------------------------------------------------------- canonical asset identity
const allow = E.parseAssetList(ASSETS);
check('pilot allowlist parses with 2 assets, lowercase, reviewed decimals', allow.size === 2 && allow.get('0x5fc5360d0400a0fd4f2af552add042d716f1d168').decimals === 6 && allow.get('0x6368e007b9f0b941560ed1f3bceb20247f5eca37').decimals === 18);
throws('allowlist refuses a checksummed (non-lowercase) address', () => E.parseAssetList({ ...ASSETS, assets: [{ token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 }] }), /lowercase/);
throws('allowlist refuses a wrong chain', () => E.parseAssetList({ ...ASSETS, chainId: 1 }), /bad file/);
const norm = E.normalizeAcceptedAssets([{ token: '0x6368E007b9f0b941560ed1f3bceb20247f5eca37', minAmount: '1000000000000000000' }, { token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', minAmount: 1000000 }], allow);
check('acceptedAssets normalised: lowercase, sorted by token, hash present', norm.ok && norm.assets[0].token === '0x5fc5360d0400a0fd4f2af552add042d716f1d168' && norm.assets[1].minAmount === '1000000000000000000' && E.isBytes32(norm.hash));
vectors.acceptedAssetsHash = norm.hash;
check('acceptedAssets: symbol-alike token outside the allowlist refused', !E.normalizeAcceptedAssets([{ token: '0x9999999999999999999999999999999999999999', minAmount: '1' }], allow).ok);
check('acceptedAssets: duplicate refused', !E.normalizeAcceptedAssets([{ token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', minAmount: '1' }, { token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', minAmount: '2' }], allow).ok);
check('acceptedAssets: zero / non-integer / huge minimum refused', !E.normalizeAcceptedAssets([{ token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', minAmount: '0' }], allow).ok && !E.normalizeAcceptedAssets([{ token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', minAmount: '1.5' }], allow).ok && !E.normalizeAcceptedAssets([{ token: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', minAmount: (1n << 128n).toString() }], allow).ok);
check('acceptedAssets: order-independent hash', E.normalizeAcceptedAssets(norm.assets.slice().reverse(), allow).hash === norm.hash);
check('formatUnits/parseUnits exact round trip', E.formatUnits('1500000', 6) === '1.5' && E.parseUnits('1.5', 6) === '1500000' && E.parseUnits('0.0000001', 6) === null && E.formatUnits('1', 18) === '0.000000000000000001' && E.parseUnits('0', 6) === null);
check('isRawAmount bounds', E.isRawAmount('1') && !E.isRawAmount('01') && !E.isRawAmount('-1') && !E.isRawAmount('1e3') && !E.isRawAmount((1n << 128n).toString()) && E.isRawAmount(((1n << 128n) - 1n).toString()));
const cd = E.transferCalldata(ADDR2, '1500000');
check('transfer calldata is exactly 68 bytes, selector 0xa9059cbb, nothing appended', cd.length === 2 + 68 * 2 && cd.startsWith('0xa9059cbb') && cd.slice(10, 74) === ADDR2.slice(2).padStart(64, '0') && BigInt('0x' + cd.slice(74)) === 1500000n);
throws('transfer calldata refuses a bad amount', () => E.transferCalldata(ADDR2, '0'));

// ---------------------------------------------------------------- creator id / dates / audience
check('creatorId deterministic from the channel id', E.creatorIdOf(CH) === Core.keccak256Utf8('syncnet.early.creator.v1|youtube|' + CH));
vectors.creatorId = E.creatorIdOf(CH);
throws('creatorId refuses a handle', () => E.creatorIdOf('@alice'));
check('utcDate uses UTC', E.utcDate(1790000000) === new Date(1790000000 * 1000).toISOString().slice(0, 10) && E.utcDate(86399) === '1970-01-01' && E.utcDate(86400) === '1970-01-02');
check('formatAudience', E.formatAudience(1234) === '~1.2K' && E.formatAudience(15400) === '~15K' && E.formatAudience(1250000) === '~1.2M' && E.formatAudience(999) === '~999' && E.formatAudience(-1) === '');

// ---------------------------------------------------------------- Merkle bundle
const leaves = [b32(3), b32(1), b32(2), b32(1)].map((p) => E.leafHash('attestation', p));
const sorted = E.sortLeaves(leaves);
check('leaves sorted ascending and de-duplicated', sorted.length === 3 && BigInt(sorted[0]) < BigInt(sorted[1]) && BigInt(sorted[1]) < BigInt(sorted[2]));
const root = E.merkleRoot(sorted, '2026-09-29');
check('root deterministic regardless of input order', E.merkleRoot(E.sortLeaves(leaves.slice().reverse()), '2026-09-29') === root);
for (let i = 0; i < sorted.length; i++) { const p = E.merkleProof(sorted, i); check('inclusion proof ' + i + ' verifies', p.root === root && E.verifyProof(p.leaf, p.siblings, root)); }
const p1 = E.merkleProof(sorted, 1);
check('tampered proof fails', !E.verifyProof(p1.leaf, p1.siblings.map((s) => ({ ...s, side: s.side === 'L' ? 'R' : 'L' })), root) && !E.verifyProof(b32(9), p1.siblings, root));
check('single leaf root = leaf', E.merkleRoot([sorted[0]], '2026-09-29') === sorted[0]);
check('empty bundle root is date-specific and never equals a leaf root', E.emptyRoot('2026-09-29') !== E.emptyRoot('2026-09-30') && E.merkleRoot([], '2026-09-29') === E.emptyRoot('2026-09-29'));
check('leaf domain-separated from node hashes', E.leafHash('attestation', b32(1)) !== Core.keccak256(b32(1)));
vectors.merkleRoot3 = root; vectors.emptyRoot = E.emptyRoot('2026-09-29'); vectors.leaf1 = E.leafHash('attestation', b32(1));
const four = E.sortLeaves([b32(4), b32(5), b32(6), b32(7)].map((p) => E.leafHash('attestation', p)));
check('odd level duplicates the last node (5 leaves)', (() => { const five = E.sortLeaves([...four, E.leafHash('attestation', b32(8))]); const r = E.merkleRoot(five, '2026-09-29'); return five.every((l, i) => E.verifyProof(l, E.merkleProof(five, i).siblings, r)); })());
const cdata = E.anchorCalldata(root, '2026-09-29');
check('anchor calldata round-trips and is 47 bytes', E.decodeAnchorCalldata(cdata).root === root && E.decodeAnchorCalldata(cdata).date === '2026-09-29' && cdata.length === 2 + 47 * 2);
check('anchor calldata: junk refused', E.decodeAnchorCalldata('0x1234') === null && E.decodeAnchorCalldata(cdata + '00') === null);

// ---------------------------------------------------------------- attestations
const registry = { schema: E.SCHEMA.keys, attestation: [{ keyId: 'early-att-test-k1', address: ADDR1, validFrom: '2026-01-01T00:00:00Z', validUntil: null }], anchor: [{ address: ADDR2, validFrom: '2026-01-01T00:00:00Z' }] };
check('committed keys file is public-only and parses', E.parseKeyRegistry(KEYS) && KEYS.attestation.length === 0);
throws('registry refuses any 32-byte value', () => E.parseKeyRegistry({ ...registry, attestation: [{ ...registry.attestation[0], secret: b32(1) }] }), /32-byte/);
throws('registry refuses a bare 64-hex secret', () => E.parseKeyRegistry({ ...registry, note: K1.slice(2) }), /32-byte/);
const att = { schema: E.SCHEMA.attestation, type: 'audience-snapshot', subject: { channelId: CH }, claims: { dateUTC: '2026-09-29', subscriberCount: 1200, hiddenSubscriberCount: false, title: 'Alice' }, issuedAt: 1790000000, bundleDate: '2026-09-29', keyId: 'early-att-test-k1' };
att.id = E.attestationId(att);
att.signature = Core._internal.secp256k1.sign(E.attestationDigest(att.id), K1);
check('attestation verifies with the registered key', E.verifyAttestation(att, registry).ok);
check('attestation: tampered claim fails on id', !E.verifyAttestation({ ...att, claims: { ...att.claims, subscriberCount: 5000 } }, registry).ok);
check('attestation: other key fails on signature', E.verifyAttestation({ ...att, signature: Core._internal.secp256k1.sign(E.attestationDigest(att.id), K2) }, registry).reason === 'signature');
check('attestation: unknown keyId', E.verifyAttestation({ ...att, keyId: 'nope' }, registry).reason === 'unknown-key');
check('attestation: outside key validity', E.verifyAttestation(att, { ...registry, attestation: [{ ...registry.attestation[0], validUntil: '2026-01-02T00:00:00Z' }] }).reason === 'key-validity');
check('attestation id excludes keyId and signature', E.attestationId({ ...att, keyId: 'x', signature: '0x00' }) === att.id);
vectors.attestationId = att.id;

// ---------------------------------------------------------------- public matching rule (pure parts)
const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const pad = (a) => '0x' + '0'.repeat(24) + lc(a).slice(2);
const mkLog = (o, i) => ({ address: o.token || TOKEN, topics: [o.topic || E.TRANSFER_TOPIC, pad(o.from || ADDR1), pad(o.to || ADDR2)], data: '0x' + BigInt(o.value == null ? 1500000 : o.value).toString(16).padStart(64, '0'), logIndex: '0x' + i.toString(16), transactionHash: b32(4), blockHash: b32(6), removed: o.removed || false });
const rcpt = (logs, status = '0x1') => ({ transactionHash: b32(4), blockHash: b32(6), status, logs });
const want = { token: TOKEN, sender: ADDR1, receiver: ADDR2, amount: '1500000' };
check('matching: exact transfer matches once', E.matchingTransfers(rcpt([mkLog({}, 0)]), want).length === 1);
check('matching: two identical transfers in one tx both match (ambiguity surfaced)', E.matchingTransfers(rcpt([mkLog({}, 0), mkLog({}, 3)]), want).map((m) => m.logIndex).join() === '0,3');
check('matching: fake token with same symbol never matches', E.matchingTransfers(rcpt([mkLog({ token: '0x9999999999999999999999999999999999999999' }, 0)]), want).length === 0);
check('matching: wrong sender / receiver / amount', E.matchingTransfers(rcpt([mkLog({ from: ADDR2 }, 0), mkLog({ to: ADDR1 }, 1), mkLog({ value: 1500001 }, 2), mkLog({ value: 1499999 }, 3)]), want).length === 0);
check('matching: reverted tx has no candidates', E.matchingTransfers(rcpt([mkLog({}, 0)], '0x0'), want).length === 0);
check('matching: removed log / wrong topic / malformed data skipped', E.matchingTransfers(rcpt([mkLog({ removed: true }, 0), mkLog({ topic: b32(1) }, 1), { ...mkLog({}, 2), data: '0x01' }, { ...mkLog({}, 3), topics: [E.TRANSFER_TOPIC, pad(ADDR1)] }]), want).length === 0);
check('matching: log from another tx/block skipped', E.matchingTransfers(rcpt([{ ...mkLog({}, 0), transactionHash: b32(5) }, { ...mkLog({}, 1), blockHash: b32(7) }]), want).length === 0);
check('matching: checksummed inputs normalised', E.matchingTransfers(rcpt([mkLog({}, 0)]), { ...want, sender: Core.toChecksumAddress(ADDR1), token: Core.toChecksumAddress(TOKEN) }).length === 1);
check('windowState', E.windowState(intentMsg, 1790000000) === 'in-window' && E.windowState(intentMsg, 1790007200) === 'in-window' && E.windowState(intentMsg, 1790007201) === 'late' && E.windowState(intentMsg, 1790007200 + 86400) === 'late' && E.windowState(intentMsg, 1790007200 + 86401) === 'out' && E.windowState(intentMsg, 1789999999) === 'early');
check('receiptId deterministic', E.receiptIdOf(4663, b32(4), 2) === Core.keccak256Utf8(E.SCHEMA.receipt + '|4663|' + b32(4) + '|2'));
vectors.receiptId = E.receiptIdOf(4663, b32(4), 2);

// ---------------------------------------------------------------- golden vectors
if (process.env.WRITE_VECTORS === '1') { fs.writeFileSync(VECTORS_PATH, JSON.stringify(vectors, null, 2) + '\n'); console.log('vectors written'); }
else if (fs.existsSync(VECTORS_PATH)) {
  const gold = JSON.parse(fs.readFileSync(VECTORS_PATH, 'utf8'));
  for (const k of Object.keys(gold)) check('golden vector ' + k, gold[k] === vectors[k], gold[k] + ' vs ' + vectors[k]);
  check('golden vector set complete', Object.keys(gold).sort().join() === Object.keys(vectors).sort().join());
} else check('vectors.json present', false, 'run once with WRITE_VECTORS=1');

fs.writeFileSync(path.join(ROOT, 'tests/early/unit.results.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} early unit checks passed`);
process.exit(failures ? 1 : 0);
