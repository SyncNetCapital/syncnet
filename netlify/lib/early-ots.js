'use strict';
/*
 * Minimal OpenTimestamps client for the EARLY daily bundle root (docs §10.6). No dependency.
 *
 *   submit(rootHex, {fetch, calendars, timeoutMs})      POST the 32-byte digest to each calendar -> partial proofs
 *   upgrade(rootHex, proofBytes, {fetch, timeoutMs})    replace pending attestations with what the calendar now holds
 *   status(rootHex, proofBytes)                         'submitted' | 'bitcoin-verifiable'
 *   otsFile(rootHex, proofBytes)                        a complete detached .ots file (keccak256 digest op + timestamp)
 *
 * Wording everywhere: "submitted to OpenTimestamps at <time>; becomes Bitcoin-verifiable later". A proof is called
 * Bitcoin-verifiable ONLY after an upgrade produced a Bitcoin attestation; `ots verify` on the file is the final word.
 * Serialization follows the OpenTimestamps format: ops (append 0xf0, prepend 0xf1, sha256 0x08, ripemd160 0x03,
 * sha1 0x02, keccak256 0x67, reverse 0xf2, hexlify 0xf3), 0xff = fork, 0x00 = attestation (8-byte tag + varbytes).
 */
const crypto = require('crypto');
const Core = require('../../lib/syncnet-core.js');
const E = require('../../lib/syncnet-early.js');

const DEFAULT_CALENDARS = Object.freeze(['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org', 'https://alice.btc.calendar.opentimestamps.org']);
const MAGIC = Uint8Array.from([0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0xe4, 0x9b, 0xc4]);
const TAG = Object.freeze({ PENDING: '83dfe30d2ef90c8e', BITCOIN: '0588960d73d71901', LITECOIN: '06869a0d73d71b45', ETHEREUM: '30c46b5d9f6a5ec3' });
const OP = Object.freeze({ APPEND: 0xf0, PREPEND: 0xf1, REVERSE: 0xf2, HEXLIFY: 0xf3, SHA1: 0x02, RIPEMD160: 0x03, SHA256: 0x08, KECCAK256: 0x67 });
const MAX_PROOF = 64 * 1024;
const hex = Core.bytesToHex, unhex = Core.hexToBytes;

// ---------------------------------------------------------------- varints / bytes
function varint(n) { const out = []; let v = BigInt(n); if (v < 0n) throw new RangeError('varint'); while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; } out.push(Number(v)); return Uint8Array.from(out); }
function readVarint(buf, pos) { let v = 0n, shift = 0n, p = pos; for (;;) { if (p >= buf.length || shift > 63n) throw new Error('ots: varint'); const b = buf[p++]; v |= BigInt(b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7n; } return [Number(v), p]; }
const varbytes = (b) => Core.concatBytes(varint(b.length), b);
function readVarbytes(buf, pos, max = 4096) { const [len, p] = readVarint(buf, pos); if (len > max || p + len > buf.length) throw new Error('ots: varbytes'); return [buf.subarray(p, p + len), p + len]; }
const nodeHash = (alg, b) => Uint8Array.from(crypto.createHash(alg).update(b).digest());

function applyOp(op, arg, msg) {
  switch (op) {
    case OP.APPEND: return Core.concatBytes(msg, arg);
    case OP.PREPEND: return Core.concatBytes(arg, msg);
    case OP.REVERSE: return Uint8Array.from(msg).reverse();
    case OP.HEXLIFY: return Core.utf8Bytes(hex(msg).slice(2));
    case OP.SHA256: return nodeHash('sha256', msg);
    case OP.SHA1: return nodeHash('sha1', msg);
    case OP.RIPEMD160: return nodeHash('ripemd160', msg);
    case OP.KECCAK256: return unhex(Core.keccak256(msg));
    default: throw new Error('ots: unknown op 0x' + op.toString(16));
  }
}
const BINARY = new Set([OP.APPEND, OP.PREPEND]);

// ---------------------------------------------------------------- timestamp tree: {attestations:[{tag, payload}], ops:[{op, arg, child}]}
function parseTimestamp(buf, pos = 0) {
  const node = { attestations: [], ops: [] };
  let p = pos;
  for (;;) {
    if (p >= buf.length) throw new Error('ots: truncated');
    const tag = buf[p++];
    if (tag === 0xff) { p = parseStep(buf, p, node); continue; }
    p = parseStep(buf, p, node, tag);
    break;
  }
  return [node, p];
}
function parseStep(buf, pos, node, knownTag) {
  let p = pos, tag = knownTag;
  if (tag === undefined) { if (p >= buf.length) throw new Error('ots: truncated'); tag = buf[p++]; }
  if (tag === 0x00) {
    if (p + 8 > buf.length) throw new Error('ots: attestation');
    const atag = hex(buf.subarray(p, p + 8)).slice(2); p += 8;
    const [payload, next] = readVarbytes(buf, p, 8192);
    node.attestations.push({ tag: atag, payload });
    return next;
  }
  let arg = null;
  if (BINARY.has(tag)) { const [a, next] = readVarbytes(buf, p); arg = a; p = next; }
  else if (![OP.REVERSE, OP.HEXLIFY, OP.SHA1, OP.RIPEMD160, OP.SHA256, OP.KECCAK256].includes(tag)) throw new Error('ots: unknown op 0x' + tag.toString(16));
  const [child, next] = parseTimestamp(buf, p);
  node.ops.push({ op: tag, arg, child });
  return next;
}
function serializeAttestation(a) { return Core.concatBytes(Uint8Array.of(0x00), unhex('0x' + a.tag), varbytes(a.payload)); }
function serializeTimestamp(node) {
  const parts = [];
  const items = [...node.attestations.map((a) => ({ kind: 'att', a })), ...node.ops.map((o) => ({ kind: 'op', o }))];
  if (!items.length) throw new Error('ots: empty timestamp');
  items.forEach((it, i) => {
    if (i < items.length - 1) parts.push(Uint8Array.of(0xff));
    if (it.kind === 'att') parts.push(serializeAttestation(it.a));
    else parts.push(Uint8Array.of(it.o.op), it.o.arg ? varbytes(it.o.arg) : new Uint8Array(0), serializeTimestamp(it.o.child));
  });
  return Core.concatBytes(...parts);
}
/** Walks the tree from `msg`; returns [{tag, payload, commitment, node, index}] for every attestation. */
function attestationsOf(node, msg, out = []) {
  node.attestations.forEach((a, index) => out.push({ tag: a.tag, payload: a.payload, commitment: hex(msg), node, index }));
  for (const o of node.ops) attestationsOf(o.child, applyOp(o.op, o.arg, msg), out);
  return out;
}
const pendingUri = (payload) => { const [uri] = readVarbytes(payload, 0, 1000); const s = new TextDecoder().decode(uri); if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~\/-]*)?$/i.test(s)) throw new Error('ots: calendar uri'); return s.replace(/\/+$/, ''); };
const bitcoinHeight = (payload) => readVarint(payload, 0)[0];

// ---------------------------------------------------------------- network
async function httpBytes(doFetch, url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { ...init, signal: ctl.signal, redirect: 'error' });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (buf.length > MAX_PROOF) throw new Error('proof too large');
    return buf;
  } finally { clearTimeout(timer); }
}

/** submit(root, opts) -> {submittedAt, calendars:[{url, ok, error?}], proof: base64 | null} (the first successful proof is kept; others are recorded as ok). */
async function submit(root, options = {}) {
  if (!E.isBytes32(root)) throw new TypeError('ots: root');
  const doFetch = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const calendars = Array.isArray(options.calendars) && options.calendars.length ? options.calendars : DEFAULT_CALENDARS;
  const submittedAt = new Date(typeof options.now === 'function' ? options.now() : Date.now()).toISOString();
  const out = { submittedAt, calendars: [], proof: null };
  const digest = unhex(root);
  let merged = null;
  for (const url of calendars) {
    try {
      const bytes = await httpBytes(doFetch, url.replace(/\/+$/, '') + '/digest', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/vnd.opentimestamps.v1' }, body: digest }, timeoutMs);
      const [node, end] = parseTimestamp(bytes);
      if (end !== bytes.length) throw new Error('trailing bytes');
      if (!attestationsOf(node, digest).length) throw new Error('no attestation');
      merged = merged ? mergeInto(merged, node) : node;
      out.calendars.push({ url, ok: true });
    } catch (err) { out.calendars.push({ url, ok: false, error: String(err && err.message).slice(0, 120) }); }
  }
  if (merged) out.proof = Buffer.from(serializeTimestamp(merged)).toString('base64');
  return out;
}
function mergeInto(a, b) { // union of two timestamps for the same message
  for (const att of b.attestations) if (!a.attestations.some((x) => x.tag === att.tag && hex(x.payload) === hex(att.payload))) a.attestations.push(att);
  for (const o of b.ops) { const same = a.ops.find((x) => x.op === o.op && hex(x.arg || new Uint8Array(0)) === hex(o.arg || new Uint8Array(0))); if (same) mergeInto(same.child, o.child); else a.ops.push(o); }
  return a;
}
/** upgrade(root, proofBase64, opts) -> {proof, upgraded: n, bitcoin: bool, errors:[…]} */
async function upgrade(root, proofBase64, options = {}) {
  const doFetch = options.fetch || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
  const bytes = Uint8Array.from(Buffer.from(String(proofBase64 || ''), 'base64'));
  const [node] = parseTimestamp(bytes);
  const digest = unhex(root);
  let upgraded = 0; const errors = [];
  for (const a of attestationsOf(node, digest)) {
    if (a.tag !== TAG.PENDING) continue;
    let uri;
    try { uri = pendingUri(a.payload); } catch (err) { errors.push(String(err.message)); continue; }
    try {
      const more = await httpBytes(doFetch, uri + '/timestamp/' + a.commitment.slice(2), { method: 'GET', headers: { accept: 'application/vnd.opentimestamps.v1' } }, timeoutMs);
      const [sub, end] = parseTimestamp(more);
      if (end !== more.length) throw new Error('trailing bytes');
      a.node.attestations.splice(a.node.attestations.indexOf(a.node.attestations[a.index]), 1);
      mergeInto(a.node, sub);
      upgraded++;
    } catch (err) { errors.push(uri + ': ' + String(err && err.message).slice(0, 100)); }
  }
  const proof = Buffer.from(serializeTimestamp(node)).toString('base64');
  return { proof, upgraded, bitcoin: hasBitcoin(root, proof), errors };
}
function hasBitcoin(root, proofBase64) {
  try { const [node] = parseTimestamp(Uint8Array.from(Buffer.from(String(proofBase64 || ''), 'base64'))); return attestationsOf(node, unhex(root)).some((a) => a.tag === TAG.BITCOIN); } catch { return false; }
}
const status = (root, proofBase64) => (proofBase64 ? (hasBitcoin(root, proofBase64) ? 'bitcoin-verifiable' : 'submitted') : 'failed');
function bitcoinHeights(root, proofBase64) {
  try { const [node] = parseTimestamp(Uint8Array.from(Buffer.from(String(proofBase64 || ''), 'base64'))); return attestationsOf(node, unhex(root)).filter((a) => a.tag === TAG.BITCOIN).map((a) => bitcoinHeight(a.payload)); } catch { return []; }
}
/** A complete detached .ots file: magic ‖ version(1) ‖ keccak256 op ‖ digest ‖ timestamp. Verify with the OpenTimestamps client. */
function otsFile(root, proofBase64) {
  if (!E.isBytes32(root)) throw new TypeError('ots: root');
  return Core.concatBytes(MAGIC, varint(1), Uint8Array.of(OP.KECCAK256), unhex(root), Uint8Array.from(Buffer.from(String(proofBase64 || ''), 'base64')));
}
/** Test/verifier helper: a synthetic pending-attestation timestamp for `uri`. */
function pendingTimestamp(uri, prefix) {
  const node = { attestations: [], ops: [] };
  const leaf = { attestations: [{ tag: TAG.PENDING, payload: varbytes(Core.utf8Bytes(uri)) }], ops: [] };
  if (prefix) node.ops.push({ op: OP.APPEND, arg: prefix, child: { attestations: [], ops: [{ op: OP.SHA256, arg: null, child: leaf }] } });
  else Object.assign(node, leaf);
  return serializeTimestamp(node);
}
function bitcoinTimestamp(height, prefix) {
  const leaf = { attestations: [{ tag: TAG.BITCOIN, payload: varint(height) }], ops: [] };
  return serializeTimestamp(prefix ? { attestations: [], ops: [{ op: OP.PREPEND, arg: prefix, child: { attestations: [], ops: [{ op: OP.SHA256, arg: null, child: leaf }] } }] } : leaf);
}

module.exports = { DEFAULT_CALENDARS, TAG, OP, MAGIC, varint, readVarint, varbytes, parseTimestamp, serializeTimestamp, attestationsOf, applyOp, submit, upgrade, status, hasBitcoin, bitcoinHeights, otsFile, pendingTimestamp, bitcoinTimestamp };
