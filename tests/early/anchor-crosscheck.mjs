// Independent cross-check of EARLY's custom RLP / EIP-155 legacy signing (netlify/lib/early-tx.js) against a mature
// implementation (ethers v6). Not part of run-all.mjs (needs `ethers` resolvable: ETHERS_MODULE=file:///…/ethers/lib.esm/index.js
// or an installed package). Compares raw bytes for the EIP-155 vector and for 300 random anchor transactions, decodes
// our raw bytes with ethers and checks from/to/value/data/chainId, and confirms the hard limits. Writes
// tests/early/anchor-crosscheck.results.json. Nothing is broadcast.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ethers = await import('ethers').catch(() => import(process.env.ETHERS_MODULE));
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const E = require(path.join(ROOT, 'lib/syncnet-early.js'));
const Tx = require(path.join(ROOT, 'netlify/lib/early-tx.js'));
const results = []; let failures = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); if (!ok) { failures++; console.log('FAIL', name, detail); } };
const lc = (s) => String(s).toLowerCase();
const signerOf = (key) => ({ address: lc(Core._internal.secp256k1.privateKeyToAddress(key)), sign: (d) => Core._internal.secp256k1.sign(d, key) });

// 1. EIP-155 vector through ethers
{
  const key = '0x' + '46'.repeat(32);
  const w = new ethers.Wallet(key);
  const raw = await w.signTransaction({ type: 0, chainId: 1, nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: '0x' });
  const ours = Tx.signLegacy({ signer: signerOf(key), chainId: 1, nonce: 9, gasPrice: 20000000000n, gasLimit: 21000, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: '0x' });
  check('EIP-155 vector: ethers raw == ours', lc(raw) === lc(ours.raw), raw + ' vs ' + ours.raw);
}
// 2. random anchor transactions: byte-identical to ethers, and ethers decodes ours to the anchor shape
let identical = 0;
for (let i = 0; i < 300; i++) {
  const key = '0x' + crypto.randomBytes(32).toString('hex');
  const signer = signerOf(key);
  const nonce = crypto.randomInt(0, 1000000), gasPrice = BigInt(crypto.randomInt(1, 5000000000)), gasLimit = BigInt(crypto.randomInt(21000, 300001));
  const root = '0x' + crypto.randomBytes(32).toString('hex');
  const date = new Date(Date.UTC(2026, crypto.randomInt(0, 12), crypto.randomInt(1, 28))).toISOString().slice(0, 10);
  const ours = Tx.anchorTransaction({ signer, chainId: 4663, nonce, gasPrice, gasLimit, root, date });
  const w = new ethers.Wallet(key);
  const raw = await w.signTransaction({ type: 0, chainId: 4663, nonce, gasPrice, gasLimit, to: signer.address, value: 0n, data: ours.fields.data });
  if (lc(raw) === lc(ours.raw)) identical++;
  else { check('random #' + i + ' byte-identical', false, raw + ' vs ' + ours.raw); break; }
  const parsed = ethers.Transaction.from(ours.raw);
  const okShape = lc(parsed.from) === signer.address && lc(parsed.to) === signer.address && parsed.value === 0n && lc(parsed.data) === lc(ours.fields.data) && parsed.chainId === 4663n && parsed.type === 0 && lc(parsed.hash) === lc(ours.hash);
  if (!okShape) { check('random #' + i + ' ethers decodes ours to the anchor shape', false, JSON.stringify({ from: parsed.from, to: parsed.to, value: String(parsed.value), chainId: String(parsed.chainId), hash: parsed.hash })); break; }
}
check('300 random anchor transactions byte-identical to ethers and decoded by ethers with the right sender/recipient/value/data/chainId/hash', identical === 300, String(identical));
// 3. our decoder agrees with ethers on ethers-produced transactions with unusual field sizes
{
  const key = '0x' + crypto.randomBytes(32).toString('hex');
  const w = new ethers.Wallet(key);
  for (const t of [{ nonce: 0, gasPrice: 1n, gasLimit: 21000, value: 0n, data: '0x' }, { nonce: 255, gasPrice: 2n ** 40n, gasLimit: 2n ** 24n, value: 2n ** 70n, data: '0x' + 'ab'.repeat(200) }, { nonce: 65536, gasPrice: 10n ** 18n, gasLimit: 30000000, value: 1n, data: '0x00' }]) {
    const raw = await w.signTransaction({ type: 0, chainId: 4663, to: '0x' + '11'.repeat(20), ...t });
    const d = Tx.decodeSigned(raw);
    const p = ethers.Transaction.from(raw);
    check('decodeSigned agrees with ethers (nonce ' + t.nonce + ')', lc(d.from) === lc(p.from) && d.nonce === BigInt(t.nonce) && d.gasPrice === BigInt(t.gasPrice) && d.gasLimit === BigInt(t.gasLimit) && d.value === BigInt(t.value) && lc(d.data) === lc(p.data) && lc(d.hash) === lc(p.hash));
  }
}
// 4. hard limits (independent of the serializer)
{
  const signer = signerOf('0x' + '55'.repeat(32));
  const root = '0x' + 'ab'.repeat(32);
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('refuses chainId != 4663', throws(() => Tx.anchorTransaction({ signer, chainId: 1, nonce: 0, gasPrice: 1n, gasLimit: 60000n, root, date: '2026-09-29' })));
  check('refuses gas limit > cap', throws(() => Tx.anchorTransaction({ signer, chainId: 4663, nonce: 0, gasPrice: 1n, gasLimit: Tx.MAX_GAS_LIMIT + 1n, root, date: '2026-09-29' })));
  check('refuses gas price > cap', throws(() => Tx.anchorTransaction({ signer, chainId: 4663, nonce: 0, gasPrice: Tx.MAX_GAS_PRICE_WEI + 1n, gasLimit: 60000n, root, date: '2026-09-29' })));
  check('refuses non-bytes32 root / bad date', throws(() => Tx.anchorTransaction({ signer, chainId: 4663, nonce: 0, gasPrice: 1n, gasLimit: 60000n, root: '0x01', date: '2026-09-29' })) && throws(() => Tx.anchorTransaction({ signer, chainId: 4663, nonce: 0, gasPrice: 1n, gasLimit: 60000n, root, date: '29-09-2026' })));
  const a = Tx.anchorTransaction({ signer, chainId: 4663, nonce: 3, gasPrice: 100n, gasLimit: 60000n, root, date: '2026-09-29' });
  check('anchorTransaction exposes no way to set to/value/data: fields are derived', a.fields.to === a.fields.from && a.fields.value === '0' && a.fields.data === E.anchorCalldata(root, '2026-09-29'));
}
fs.writeFileSync(path.join(ROOT, 'tests/early/anchor-crosscheck.results.json'), JSON.stringify({ at: new Date().toISOString(), ethers: ethers.version, passed: results.length - failures, failed: failures, results }, null, 2));
console.log(`${results.length - failures}/${results.length} anchor cross-check checks passed (ethers ${ethers.version})`);
process.exit(failures ? 1 : 0);
