'use strict';
/*
 * The ONE server-signed transaction in SyncNet: the EARLY daily anchor (docs §0.4, §10.5).
 *
 *   anchorTransaction({signer, chainId, nonce, gasPrice, gasLimit, root, date}) -> {raw, hash, fields}
 *
 * Hard rules, enforced here and nowhere overridable:
 *   to == signer.address (a self-transfer), value == 0, data == anchorCalldata(root, date) exactly (47 bytes),
 *   gasLimit <= MAX_GAS_LIMIT, gasPrice <= MAX_GAS_PRICE_WEI, chainId == 4663, nonce a small integer.
 * The key never leaves the signer closure (netlify/lib/early-config.js anchorSigner). Legacy (type 0) EIP-155
 * transaction, RLP-encoded here with no dependency; decodeSigned() lets verifiers and tests read a raw tx back and
 * recover its sender. Robinhood Chain (Arbitrum Nitro) accepts legacy transactions.
 */
const Core = require('../../lib/syncnet-core.js');
const E = require('../../lib/syncnet-early.js');

const MAX_GAS_LIMIT = 300000n; // Nitro charges L1 calldata inside gasLimit; a 47-byte self-transfer stays far below this
const MAX_GAS_PRICE_WEI = 5n * 10n ** 9n; // 5 gwei ceiling; the job refuses to anchor above it (retries later)
const ANCHOR_DATA_BYTES = 47;

// ---------------------------------------------------------------- RLP
const toBytes = (v) => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') return Core.hexToBytes(v === '0x' ? '0x' : v);
  if (typeof v === 'bigint' || typeof v === 'number') { const n = BigInt(v); if (n < 0n) throw new RangeError('rlp: negative'); if (n === 0n) return new Uint8Array(0); let h = n.toString(16); if (h.length % 2) h = '0' + h; return Core.hexToBytes('0x' + h); }
  throw new TypeError('rlp: unsupported item');
};
function encodeLength(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const b = toBytes(BigInt(len));
  return Core.concatBytes(Uint8Array.of(offset + 55 + b.length), b);
}
function rlpEncode(item) {
  if (Array.isArray(item)) { const body = Core.concatBytes(...item.map(rlpEncode)); return Core.concatBytes(encodeLength(body.length, 0xc0), body); }
  const b = toBytes(item);
  if (b.length === 1 && b[0] < 0x80) return b;
  return Core.concatBytes(encodeLength(b.length, 0x80), b);
}
function rlpDecode(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : Core.hexToBytes(bytes);
  const [item, end] = decodeAt(buf, 0);
  if (end !== buf.length) throw new Error('rlp: trailing bytes');
  return item;
}
function decodeAt(buf, pos) {
  if (pos >= buf.length) throw new Error('rlp: truncated');
  const b0 = buf[pos];
  if (b0 < 0x80) return [buf.subarray(pos, pos + 1), pos + 1];
  const readLen = (n, start) => { let len = 0n; for (let i = 0; i < n; i++) len = (len << 8n) | BigInt(buf[start + i]); if (n > 8 || len > BigInt(buf.length)) throw new Error('rlp: length'); return Number(len); };
  if (b0 < 0xb8) { const len = b0 - 0x80; if (pos + 1 + len > buf.length) throw new Error('rlp: truncated'); if (len === 1 && buf[pos + 1] < 0x80) throw new Error('rlp: non-canonical'); return [buf.subarray(pos + 1, pos + 1 + len), pos + 1 + len]; }
  if (b0 < 0xc0) { const n = b0 - 0xb7; const len = readLen(n, pos + 1); const s = pos + 1 + n; if (len < 56 || s + len > buf.length) throw new Error('rlp: length'); return [buf.subarray(s, s + len), s + len]; }
  let len, s;
  if (b0 < 0xf8) { len = b0 - 0xc0; s = pos + 1; } else { const n = b0 - 0xf7; len = readLen(n, pos + 1); s = pos + 1 + n; if (len < 56) throw new Error('rlp: length'); }
  if (s + len > buf.length) throw new Error('rlp: truncated');
  const out = []; let p = s;
  while (p < s + len) { const [it, next] = decodeAt(buf, p); out.push(it); p = next; }
  if (p !== s + len) throw new Error('rlp: list length');
  return [out, p];
}
const bnOf = (b) => (b.length ? BigInt(Core.bytesToHex(b)) : 0n);

// ---------------------------------------------------------------- legacy EIP-155 transactions
function signLegacy({ signer, chainId, nonce, gasPrice, gasLimit, to, value, data }) {
  const cid = BigInt(chainId);
  const unsigned = [BigInt(nonce), BigInt(gasPrice), BigInt(gasLimit), to, BigInt(value), data, cid, 0n, 0n];
  const digest = Core.keccak256(rlpEncode(unsigned));
  const sig = Core.hexToBytes(signer.sign(digest));
  // r and s are RLP INTEGERS: minimal big-endian bytes, never zero-padded (a leading 0x00 byte would be non-canonical
  // RLP and produce a different transaction hash; found by the ethers cross-check, tests/early/anchor-crosscheck.mjs).
  const r = bnOf(sig.subarray(0, 32)), s = bnOf(sig.subarray(32, 64)), recid = BigInt(sig[64] - 27);
  const v = recid + cid * 2n + 35n;
  const raw = rlpEncode([BigInt(nonce), BigInt(gasPrice), BigInt(gasLimit), to, BigInt(value), data, v, r, s]);
  return { raw: Core.bytesToHex(raw), hash: Core.keccak256(raw), signingDigest: digest, v };
}
/** decodeSigned(rawHex) -> {nonce, gasPrice, gasLimit, to, value, data, chainId, v, r, s, from, hash} */
function decodeSigned(raw) {
  const list = rlpDecode(raw);
  if (!Array.isArray(list) || list.length !== 9) throw new Error('tx: not a legacy transaction');
  const [nonce, gasPrice, gasLimit, to, value, data, vB, rB, sB] = list;
  const v = bnOf(vB);
  const chainId = v >= 35n ? (v - 35n) / 2n : null;
  if (chainId === null) throw new Error('tx: pre-EIP-155 transaction refused');
  const recid = Number(v - 35n - chainId * 2n);
  const unsigned = [bnOf(nonce), bnOf(gasPrice), bnOf(gasLimit), to, bnOf(value), data, chainId, 0n, 0n];
  const digest = Core.keccak256(rlpEncode(unsigned));
  const sig = Core.bytesToHex(Core.concatBytes(pad32(rB), pad32(sB), Uint8Array.of(27 + recid)));
  const from = E.lc(Core.recoverAddress(digest, sig));
  return { nonce: bnOf(nonce), gasPrice: bnOf(gasPrice), gasLimit: bnOf(gasLimit), to: to.length ? Core.bytesToHex(to) : null, value: bnOf(value), data: Core.bytesToHex(data), chainId, v, r: Core.bytesToHex(pad32(rB)), s: Core.bytesToHex(pad32(sB)), from, hash: Core.keccak256(rlpEncode(list)) };
}
const pad32 = (b) => { const out = new Uint8Array(32); out.set(b, 32 - b.length); return out; };

// ---------------------------------------------------------------- the anchor transaction (strictly validated)
function anchorTransaction({ signer, chainId, nonce, gasPrice, gasLimit, root, date }) {
  if (!signer || !E.isAddr(signer.address) || typeof signer.sign !== 'function') throw new Error('anchor: signer');
  if (Number(chainId) !== E.CHAIN_ID) throw new Error('anchor: chain id must be 4663');
  const n = BigInt(nonce), gp = BigInt(gasPrice), gl = BigInt(gasLimit);
  if (n < 0n || n > 10n ** 9n) throw new Error('anchor: nonce');
  if (gp <= 0n || gp > MAX_GAS_PRICE_WEI) throw new Error('anchor: gas price above the ceiling');
  if (gl < 21000n || gl > MAX_GAS_LIMIT) throw new Error('anchor: gas limit outside [21000, ' + MAX_GAS_LIMIT + ']');
  const data = E.anchorCalldata(root, date); // throws unless root is bytes32 and date is a UTC day
  if (Core.hexToBytes(data).length !== ANCHOR_DATA_BYTES) throw new Error('anchor: calldata');
  const to = E.lc(signer.address);
  const tx = signLegacy({ signer, chainId: E.CHAIN_ID, nonce: n, gasPrice: gp, gasLimit: gl, to, value: 0n, data });
  const back = decodeSigned(tx.raw);
  // belt and braces: what we are about to broadcast decodes to exactly the defined anchor and nothing else
  if (back.from !== to || back.to !== to || back.value !== 0n || back.data !== data || back.chainId !== BigInt(E.CHAIN_ID) || back.gasLimit !== gl || back.gasPrice !== gp || back.nonce !== n) throw new Error('anchor: self-check failed');
  return { raw: tx.raw, hash: tx.hash, fields: { from: to, to, value: '0', data, nonce: n.toString(), gasPrice: gp.toString(), gasLimit: gl.toString(), chainId: E.CHAIN_ID, root: E.lc(root), date } };
}
/** Verifies a mined anchor transaction object (eth_getTransactionByHash shape) against the registry anchor address. */
function verifyAnchorTx(tx, anchorAddress) {
  if (!tx || !E.isAddr(tx.from) || !E.isAddr(tx.to)) return { ok: false, reason: 'shape' };
  if (E.lc(tx.from) !== E.lc(anchorAddress) || E.lc(tx.to) !== E.lc(anchorAddress)) return { ok: false, reason: 'address' };
  if (BigInt(tx.value || 0) !== 0n) return { ok: false, reason: 'value' };
  const dec = E.decodeAnchorCalldata(tx.input || tx.data);
  return dec ? { ok: true, root: dec.root, date: dec.date } : { ok: false, reason: 'calldata' };
}

module.exports = { rlpEncode, rlpDecode, signLegacy, decodeSigned, anchorTransaction, verifyAnchorTx, MAX_GAS_LIMIT, MAX_GAS_PRICE_WEI, ANCHOR_DATA_BYTES };
