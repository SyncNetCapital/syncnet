#!/usr/bin/env node
// Independent SYNC Proof receipt verifier (docs/sync-proof-early-spec.md §8). Dependency-free: uses only this
// repository's lib/syncnet-core.js + lib/syncnet-early.js and, optionally, a Robinhood Chain JSON-RPC URL.
//
//   node docs/early/verify-receipt.mjs receipt.json [--rpc https://rpc.mainnet.chain.robinhood.com/] [--keys syncnet-early-keys.json] [--bundle <date>=<bundle.json> ...]
//
// What it proves WITHOUT SyncNet: (1) the intent signature recovers to the sender, (2) the creator manifest signature
// recovers to the receiving wallet, (3) with --rpc: the transfer exists on chain 4663, succeeded, was emitted by the
// canonical token contract from sender to receiver for the exact amount, in a canonical block inside the signed
// window (or the recovery window with a valid finalize signature), (4) each SyncNet attestation verifies against the
// key registry and, when a bundle file is given, is included under that bundle's root, (5) with --rpc: the bundle
// root was anchored on chain by the registry's anchor address. What it does NOT prove: that the intent was signed
// before the transfer (an application guarantee; the receipt's `ordering` block is SyncNet's statement only).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const E = require(path.join(ROOT, 'lib/syncnet-early.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));

export async function verifyReceipt(doc, { rpc = null, registry = null, bundles = {} } = {}) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok: Boolean(ok), detail: detail || '' });
  const lc = E.lc;
  try {
    add('schema', 'Receipt schema', doc && doc.schema === E.SCHEMA.receipt && doc.matchingRule === E.SCHEMA.matching, doc && doc.schema);
    const msg = doc.intent && doc.intent.typedData && doc.intent.typedData.message;
    add('intent-typed', 'Intent typed data is exactly the SYNC Proof SupportIntent structure', msg && E.sameTypedData('SupportIntent', msg, doc.intent.typedData));
    const intentDigest = msg ? Core.hashTypedData(doc.intent.typedData) : null;
    add('intent-digest', 'Intent digest matches', intentDigest && lc(intentDigest) === lc(doc.intent.digest), intentDigest);
    let signer = '';
    try { signer = lc(Core.recoverAddress(intentDigest, doc.intent.signature)); } catch (e) { signer = ''; }
    add('intent-signer', 'Intent signature recovers to the sender (EOA; contract wallets need an EIP-1271 read)', signer && signer === lc(msg.sender), signer);
    add('intent-sender-is-from', 'Intent sender equals the transfer sender', msg && lc(msg.sender) === lc(doc.fact.transfer.from));
    const cm = doc.creatorManifest;
    const mm = cm && cm.typedData && cm.typedData.message;
    add('manifest-typed', 'Creator manifest typed data is exactly the CreatorManifest structure', mm && E.sameTypedData('CreatorManifest', mm, cm.typedData));
    const manifestHash = mm ? Core.hashTypedData(cm.typedData) : null;
    add('manifest-hash', 'Manifest hash matches the intent reference', manifestHash && lc(manifestHash) === lc(cm.manifestHash) && lc(manifestHash) === lc(msg.manifestHash), manifestHash);
    let msigner = '';
    try { msigner = lc(Core.recoverAddress(manifestHash, cm.signature)); } catch (e) { msigner = ''; }
    add('manifest-signer', 'Manifest signature recovers to the receiving wallet', msigner && msigner === lc(mm.receivingWallet), msigner);
    add('receiver', 'Intent receiver equals the manifest receiving wallet and the transfer recipient', mm && lc(msg.receiver) === lc(mm.receivingWallet) && lc(msg.receiver) === lc(doc.fact.transfer.to));
    const assetsHash = E.hashJson(cm.acceptedAssets || []);
    add('assets', 'Accepted assets list hashes to the signed acceptedAssetsHash and includes the token', lc(assetsHash) === lc(mm.acceptedAssetsHash) && (cm.acceptedAssets || []).some((a) => lc(a.token) === lc(msg.token) && BigInt(msg.amount) >= BigInt(a.minAmount)));
    add('token-amount', 'Transfer token/value equal the intent token/amount', lc(doc.fact.transfer.token) === lc(msg.token) && BigInt(doc.fact.transfer.value) === BigInt(msg.amount));
    const state = E.windowState(msg, doc.fact.blockTimestamp);
    if (doc.mode === 'recovery-finalized') {
      const fm = doc.finalize && doc.finalize.typedData && doc.finalize.typedData.message;
      let fsig = ''; try { fsig = lc(Core.recoverAddress(Core.hashTypedData(doc.finalize.typedData), doc.finalize.signature)); } catch (e) { fsig = ''; }
      add('recovery', 'Recovery: transfer inside the 24 h grace and a finalize signature by the sender naming this tx/log', state === 'late' && fm && lc(fm.txHash) === lc(doc.fact.txHash) && Number(fm.logIndex) === Number(doc.fact.logIndex) && fsig === lc(msg.sender) && E.sameTypedData('SupportFinalize', fm, doc.finalize.typedData));
    } else add('window', 'Transfer block time inside the signed intent window', state === 'in-window', state);
    add('receipt-id', 'Receipt id derives from chain, tx and log index', lc(E.receiptIdOf(4663, doc.fact.txHash, doc.fact.logIndex)) === lc(doc.receiptId));
    if (rpc) {
      const chainId = Number(await rpc('eth_chainId', []));
      add('chain', 'RPC is Robinhood Chain (4663)', chainId === 4663, String(chainId));
      const rcpt = await rpc('eth_getTransactionReceipt', [doc.fact.txHash]);
      add('tx', 'Transaction found and succeeded', rcpt && lc(rcpt.status) === '0x1');
      if (rcpt) {
        const m = E.matchingTransfers(rcpt, { token: msg.token, sender: msg.sender, receiver: msg.receiver, amount: msg.amount }).find((x) => x.logIndex === Number(doc.fact.logIndex));
        add('log', 'Log at logIndex is a Transfer by the canonical token, sender → receiver, exact amount', Boolean(m));
        const blk = await rpc('eth_getBlockByNumber', [rcpt.blockNumber, false]);
        add('block', 'Block is canonical and matches the receipt (hash, number, timestamp)', blk && lc(blk.hash) === lc(rcpt.blockHash) && lc(blk.hash) === lc(doc.fact.blockHash) && BigInt(blk.number) === BigInt(doc.fact.blockNumber) && Number(BigInt(blk.timestamp)) === Number(doc.fact.blockTimestamp));
        const fin = await rpc('eth_getBlockByNumber', ['finalized', false]).catch(() => null);
        add('finalized', 'Block at or below the finalized tag', fin && BigInt(fin.number) >= BigInt(rcpt.blockNumber), fin ? String(BigInt(fin.number)) : 'n/a');
      }
    }
    for (const a of doc.attestations || []) {
      const v = registry ? E.verifyAttestation(a, registry) : { ok: false, reason: 'no registry' };
      add('att-' + a.type, 'Attestation ' + a.type + ' verifies against the key registry', v.ok, v.reason || v.address);
      const b = bundles[a.bundleDate];
      if (b) {
        const leaf = E.leafHash(E.LEAF_ATTESTATION, a.id);
        const idx = (b.leaves || []).indexOf(leaf);
        add('incl-' + a.type, 'Attestation included in bundle ' + a.bundleDate, idx >= 0 && E.merkleRoot(E.sortLeaves(b.leaves), a.bundleDate) === b.root && E.verifyProof(leaf, E.merkleProof(b.leaves, idx).siblings, b.root), idx);
        if (rpc && b.anchors && b.anchors.robinhood && b.anchors.robinhood.txHash && registry) {
          const tx = await rpc('eth_getTransactionByHash', [b.anchors.robinhood.txHash]);
          const rc = await rpc('eth_getTransactionReceipt', [b.anchors.robinhood.txHash]);
          const anchorAddr = (registry.anchor || []).map((k) => lc(k.address));
          const dec = tx ? E.decodeAnchorCalldata(tx.input) : null;
          add('anchor-' + a.bundleDate, 'Bundle root anchored on Robinhood Chain by a registry anchor address', tx && rc && lc(rc.status) === '0x1' && anchorAddr.includes(lc(tx.from)) && lc(tx.to) === lc(tx.from) && BigInt(tx.value || 0) === 0n && dec && dec.root === b.root && dec.date === a.bundleDate);
        }
      }
    }
    if (a_manifestActive(doc)) add('manifest-window', 'Manifest ACTIVE attestation covers the transfer time', a_manifestActive(doc));
    add('ordering', 'Ordering (intent before transfer) is SyncNet’s statement, not independently verifiable', true, doc.ordering ? 'createdBlock ' + doc.ordering.createdBlock : 'absent');
  } catch (e) { add('error', 'Verifier error', false, String(e && e.message)); }
  return { ok: checks.every((c) => c.ok), checks };
}
function a_manifestActive(doc) {
  const a = (doc.attestations || []).find((x) => x.type === 'creator-manifest' && x.claims && x.claims.status === 'ACTIVE');
  if (!a) return false;
  const ts = Number(doc.fact.blockTimestamp);
  return Number(a.claims.effectiveAt) <= ts && (a.claims.supersededAt == null || Number(a.claims.supersededAt) > ts) && E.lc(a.subject.manifestHash) === E.lc(doc.creatorManifest.manifestHash);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file) { console.error('usage: verify-receipt.mjs receipt.json [--rpc URL] [--keys keys.json] [--bundle DATE=bundle.json]'); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')).receipt || JSON.parse(fs.readFileSync(file, 'utf8'));
  const opt = { bundles: {} };
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] === '--rpc') opt.rpc = Chain.makeRpc(args[i + 1], { timeoutMs: 15000, retries: 1 });
    if (args[i] === '--keys') opt.registry = E.parseKeyRegistry(JSON.parse(fs.readFileSync(args[i + 1], 'utf8')));
    if (args[i] === '--bundle') { const [d, p] = args[i + 1].split('='); const b = JSON.parse(fs.readFileSync(p, 'utf8')); opt.bundles[d] = b.bundle || b; }
  }
  const out = await verifyReceipt(doc, opt);
  for (const c of out.checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.id.padEnd(24) + ' ' + c.label + (c.detail ? '  [' + String(c.detail).slice(0, 80) + ']' : ''));
  console.log(out.ok ? 'RECEIPT VERIFIED' : 'RECEIPT NOT VERIFIED');
  process.exit(out.ok ? 0 : 1);
}
