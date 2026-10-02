// Shared fixtures for the EARLY server suites: a controllable Robinhood Chain mock (chain id, head/safe/finalized tags,
// blocks with timestamps, receipts with ERC-20 Transfer logs, eth_getLogs with topic filters, reorgs, outages, budget
// probes), an in-memory durable store, a controllable clock, test wallets and a test attestation/anchor key pair
// whose PUBLIC addresses go into a test key registry. Nothing touches a real network.
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
export const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
export const E = require(path.join(ROOT, 'lib/syncnet-early.js'));
export const ASSETS = require(path.join(ROOT, 'syncnet-early-assets.json'));
export const lc = (v) => String(v == null ? '' : v).toLowerCase();
export const hex = (n) => '0x' + BigInt(n).toString(16);
export const pad = (a) => '0x' + '0'.repeat(24) + lc(a).slice(2);
export const rnd32 = () => '0x' + crypto.randomBytes(32).toString('hex');
const addrOf = (k) => lc(Core._internal.secp256k1.privateKeyToAddress(k));

// ---- test keys (never used anywhere real)
export const KEYS = {
  fan: '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
  fan2: '0x' + '11'.repeat(32),
  creator: '0x' + '22'.repeat(32),
  creator2: '0x' + '23'.repeat(32),
  attacker: '0x' + '33'.repeat(32),
  attest: '0x' + '44'.repeat(32),
  anchor: '0x' + '55'.repeat(32),
};
export const W = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, addrOf(v)]));
const KEY_BY_ADDR = new Map(Object.entries(KEYS).map(([k, v]) => [W[k], v]));
export function signDigest(address, digest) { const k = KEY_BY_ADDR.get(lc(address)); if (!k) throw new Error('no test key for ' + address); return Core._internal.secp256k1.sign(digest, k); }
export const sign = (kind, message, who) => signDigest(who, E.digest(kind, message));

export const TEST_KEYS_FILE = { schema: 'syncnet.early.keys.v1', attestation: [{ keyId: 'early-att-test-k1', address: W.attest, validFrom: '2026-01-01T00:00:00Z', validUntil: null, status: 'active' }], anchor: [{ address: W.anchor, validFrom: '2026-01-01T00:00:00Z', validUntil: null }] };
export const ENV = {
  SYNCNET_EARLY_ENABLED: 'true', SYNCNET_EARLY_SESSION_KEY: 'early-session-test-key-0123456789abcdef0123456789',
  SYNCNET_EARLY_ATTESTATION_KEY: KEYS.attest, SYNCNET_EARLY_ATTESTATION_KEY_ID: 'early-att-test-k1', SYNCNET_EARLY_ANCHOR_KEY: KEYS.anchor,
  SYNCNET_GOOGLE_CLIENT_ID: 'test-client', SYNCNET_GOOGLE_CLIENT_SECRET: 'test-secret', SYNCNET_EARLY_OAUTH_REDIRECT: 'https://example.test/api/early-youtube-auth',
  SYNCNET_YOUTUBE_API_KEY: 'test-yt-key',
};
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
export const CH = 'UC_x5XG1OV2P6uZZ5FSM9Ttw', CH2 = 'UCabcdefghijklmnopqrstuv';
export const TRANSFER = E.TRANSFER_TOPIC;

/** Controllable clock (ms). */
export const clock = { t: Math.floor(Date.now() / 1000) * 1000, now() { return clock.t; }, advance(s) { clock.t += s * 1000; } };

// ---- chain mock: one block per second of clock time (block n has timestamp genesisTs + n)
export const pc = { chainHex: '0x1237', head: 1000n, safe: 990n, finalized: 900n, genesisTs: 0n, blocks: new Map(), receipts: new Map(), logs: [], mode: 'ok', calls: 0, methods: [], reorged: new Set() };
export function resetPc() {
  Object.assign(pc, { chainHex: '0x1237', head: 1000n, safe: 990n, finalized: 900n, blocks: new Map(), receipts: new Map(), logs: [], mode: 'ok', calls: 0, methods: [], reorged: new Set() });
  pc.genesisTs = BigInt(Math.floor(clock.t / 1000)) - pc.head;
}
resetPc();
const blockHash = (n, v = 0) => Core.keccak256Utf8('early-block|' + n + '|' + v);
export function blockAt(n) { return pc.blocks.get(n) || { number: n, hash: blockHash(n), timestamp: pc.genesisTs + n }; }
/** Keep the head in step with the clock (called by tests after clock.advance). */
export function syncHead() { const n = BigInt(Math.floor(clock.t / 1000)) - pc.genesisTs; if (n > pc.head) pc.head = n; }
export function setTags({ safe, finalized } = {}) { if (safe !== undefined) pc.safe = BigInt(safe); if (finalized !== undefined) pc.finalized = BigInt(finalized); }
export const makeSafe = (n) => setTags({ safe: n });
export const makeFinal = (n) => setTags({ safe: n, finalized: n });

/**
 * Put an ERC-20 transfer on the mock chain (mined "now" by default: block = head+1 with the clock's timestamp).
 * opts: {from, to, token, amount, blockNumber, timestamp, status, txHash, extraLogs:[{from,to,token,amount}]}
 */
export function pay(opts) {
  syncHead();
  const n = BigInt(opts.blockNumber != null ? opts.blockNumber : pc.head + 1n);
  if (n > pc.head) pc.head = n;
  const b = { number: n, hash: blockHash(n), timestamp: opts.timestamp != null ? BigInt(opts.timestamp) : BigInt(Math.floor(clock.t / 1000)) };
  pc.blocks.set(n, b);
  const txHash = opts.txHash || rnd32();
  const mk = (i, o) => ({ address: lc(o.token || USDG), topics: [TRANSFER, pad(o.from || W.fan), pad(o.to || W.creator)], data: '0x' + BigInt(o.amount).toString(16).padStart(64, '0'), logIndex: hex(i), transactionHash: txHash, blockHash: b.hash, blockNumber: hex(n), removed: false });
  const logs = [...(opts.extraLogs || []).map((o, i) => mk(i, o)), mk((opts.extraLogs || []).length, opts)];
  pc.receipts.set(txHash, { transactionHash: txHash, status: opts.status || '0x1', blockNumber: hex(n), blockHash: b.hash, logs });
  for (const l of logs) pc.logs.push(l);
  return { txHash, blockNumber: n, timestamp: b.timestamp };
}
/** Reorg: block n gets a new hash; its txs disappear or are re-included at `reincludeAt`. */
export function reorg(n, { reincludeAt } = {}) {
  n = BigInt(n);
  const old = blockAt(n);
  pc.blocks.set(n, { number: n, hash: blockHash(n, 1 + pc.reorged.size), timestamp: old.timestamp }); pc.reorged.add(String(n));
  for (const [h, r] of [...pc.receipts]) {
    if (BigInt(r.blockNumber) !== n) continue;
    pc.logs = pc.logs.filter((l) => l.transactionHash !== h);
    if (reincludeAt == null) { pc.receipts.delete(h); continue; }
    const m = BigInt(reincludeAt);
    const b2 = { number: m, hash: blockHash(m, 7), timestamp: old.timestamp + (m - n) };
    pc.blocks.set(m, b2); if (m > pc.head) pc.head = m;
    const logs = r.logs.map((l) => ({ ...l, blockHash: b2.hash, blockNumber: hex(m) }));
    pc.receipts.set(h, { ...r, blockNumber: hex(m), blockHash: b2.hash, logs });
    for (const l of logs) pc.logs.push(l);
  }
}

/** The rpc(method, params) injected into the functions. */
export async function rpc(method, params = []) {
  pc.calls++; pc.methods.push(method);
  if (pc.mode === 'down') throw Object.assign(new Error('RPC HTTP 503'), { name: 'RpcError', transient: true });
  const q = (b) => ({ number: hex(b.number), hash: b.hash, timestamp: hex(b.timestamp), transactions: [] });
  switch (method) {
    case 'eth_chainId': return pc.chainHex;
    case 'eth_blockNumber': syncHead(); return hex(pc.head);
    case 'eth_getBlockByNumber': {
      syncHead();
      const tag = params[0];
      if (tag === 'safe') return pc.mode === 'no-safe' ? null : q(blockAt(pc.safe));
      if (tag === 'finalized') { if (pc.mode === 'no-finalized') throw new Error('finalized unsupported'); return q(blockAt(pc.finalized)); }
      if (tag === 'latest') return q(blockAt(pc.head));
      const n = BigInt(tag);
      return n > pc.head ? null : q(blockAt(n));
    }
    case 'eth_getTransactionReceipt': return pc.receipts.get(lc(params[0])) || null;
    case 'eth_getLogs': {
      const f = params[0] || {};
      const from = BigInt(f.fromBlock), to = BigInt(f.toBlock);
      if (pc.maxRange && to - from + 1n > BigInt(pc.maxRange)) throw Object.assign(new Error('query returned more than 10000 results'), { name: 'RpcError' });
      const topics = f.topics || [];
      return pc.logs.filter((l) => { const n = BigInt(l.blockNumber); return n >= from && n <= to && (!f.address || lc(l.address) === lc(f.address)) && topics.every((t, i) => t == null || lc(l.topics[i]) === lc(t)); });
    }
    case 'eth_getCode': return '0x'; // every test wallet is an EOA
    case 'eth_call': return '0x';
    case 'eth_getTransactionCount': return hex(pc.nonce || 0);
    case 'eth_gasPrice': return '0x5f5e100';
    case 'eth_estimateGas': return '0x5208';
    case 'eth_sendRawTransaction': { pc.sent = pc.sent || []; pc.sent.push(params[0]); const h = Core.keccak256(params[0]); pc.receipts.set(h, { transactionHash: h, status: '0x1', blockNumber: hex(pc.head + 1n), blockHash: blockAt(pc.head + 1n).hash, logs: [] }); pc.nonce = (pc.nonce || 0) + 1; return h; }
    default: throw new Error('rpc mock: ' + method);
  }
}

// ---- store (in-memory adapter, flagged durable)
export const MAP = new Map();
export function makeStore() {
  const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
  return { ...createStore({ map: MAP, now: () => clock.now() }), durable: true, kind: 'test-durable' };
}
export const resetStore = () => MAP.clear();

// ---- sessions (issued exactly like the OAuth callback would)
export const Session = require(path.join(ROOT, 'netlify/lib/early-session.js'));
export const sidOf = (token) => token.split('.')[4];
/** A creator session plus a fresh OAuth link record (what early-youtube-auth.js stores after channels.mine). */
export function creatorSession(store, { channelId = CH, wallet = W.creator, title = 'Alice', subscriberCount = 1234, hidden = false, at, link = true } = {}) {
  const token = Session.issue({ scope: 'creator', wallet, channelId, now: () => clock.now(), env: ENV });
  const sid = sidOf(token);
  if (link) MAP.set('early:oauth:v1:' + sid, { type: 'string', value: JSON.stringify({ wallet: lc(wallet), channelId, title, avatarUrl: 'https://yt.example/a.png', handle: '@alice', subscriberCount, hiddenSubscriberCount: hidden, at: at != null ? at : Math.floor(clock.now() / 1000) }), expiresAt: clock.now() + 15 * 60 * 1000 });
  return token;
}
export const fanSession = (wallet = W.fan) => Session.issue({ scope: 'fan', wallet, now: () => clock.now(), env: ENV });
