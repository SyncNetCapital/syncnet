// Solana discovery V0 (backend) · chain-qualified identity, base58, Pump truth model (real finalized mainnet fixtures),
// generic Solana launch index (same-slot pagination, idempotency, checkpoint), Pump adapter, scheduled indexer gate,
// /api/pump-economy, pump-backfill. Memory store + stub Solana RPC; no real network.
// Run: node tests/unit/solana-discovery.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } else process.stdout.write('ok   ' + name + '\n'); }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
globalThis.fetch = () => { throw new Error('real network access in tests'); };

const Assets = require(path.join(ROOT, 'lib/syncnet-assets.js'));
const Pump = require(path.join(ROOT, 'lib/syncnet-pump.js'));
const Index = require(path.join(ROOT, 'netlify/lib/solana-launch-index.js'));
const Launches = require(path.join(ROOT, 'netlify/lib/pump-launches.js'));
const SolRpc = require(path.join(ROOT, 'netlify/lib/solana-rpc.js'));
const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const api = require(path.join(ROOT, 'netlify/functions/pump-economy.js'));
const indexer = require(path.join(ROOT, 'netlify/functions/pump-indexer.js'));
const Backfill = require(path.join(ROOT, 'netlify/scripts/pump-backfill.js'));
const F = require(path.join(ROOT, 'tests/fixtures/solana/pump-fixtures.json'));

const clone = (x) => JSON.parse(JSON.stringify(x));
const durable = () => { const map = new Map(); return { ...createStore({ env: {}, map }), durable: true, kind: 'test-durable', _map: map }; };
const randKey = () => { let b; do { b = crypto.randomBytes(32); } while (b[0] === 0); return Assets.base58Encode(b); };
const randSig = () => { let b; do { b = crypto.randomBytes(64); } while (b[0] === 0); return Assets.base58Encode(b); };
const J = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
let ip = 0;
const get = (query) => ({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': `198.51.100.${(ip++ % 250) + 1}` }, queryStringParameters: query });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NONSOL = { sig: F.nonSolV1.signature, tx: F.nonSolV1.tx, mint: 'D4bSpUBfJsAQxdxWVNJ71mrDLB1XXSG4qPgeg5cKvbfp', curve: 'FgDkKszfXGPaNvcR2cfso7svowNbTwoew1Bo4E7iXwc9', quote: 'HNg5PYJmtqcmzXrv6S9zP1CDKk5BgDuyFBxbvNApump' };
const CURVE = { owner: F.curveNonSol.owner, data: Buffer.from(F.curveNonSol.data, 'base64') };
const curveWithQuote = (quote) => { const d = Buffer.from(CURVE.data); Buffer.from(Assets.base58Decode(quote)).copy(d, 83); return { owner: Pump.PROGRAM, data: d }; };

// ================================================================ Phase 1 · identity + base58
{
  const z = new Uint8Array(32);
  check('base58: 32 zero bytes <-> native SOL placeholder', Assets.base58Encode(z) === Assets.NATIVE_SOL && Assets.base58Decode(Assets.NATIVE_SOL).every((b) => b === 0) && Assets.base58Decode(Assets.NATIVE_SOL).length === 32);
  let rt = true;
  for (let i = 0; i < 300; i++) { const b = crypto.randomBytes(1 + (i % 64)); if (i % 5 === 0) b[0] = 0; if (i % 7 === 0 && b.length > 1) b[1] = 0; const e = Assets.base58Encode(b); const d = Assets.base58Decode(e); if (!d || Buffer.compare(Buffer.from(d), b) !== 0) rt = false; }
  check('base58: random round trips (leading zeros included)', rt);
  check('base58: rejects 0 O I l and empty', ['0abc', 'O1', 'I1', 'l1', ''].every((s) => Assets.base58Decode(s) === null));
  check('Solana pubkey: program / mints valid, case preserved', [Pump.PROGRAM, USDC, NONSOL.quote, NONSOL.mint].every(Assets.isSolanaPubkey));
  check('Solana mint: native SOL placeholder is a pubkey but not a mint', Assets.isSolanaPubkey(Assets.NATIVE_SOL) && !Assets.isSolanaMint(Assets.NATIVE_SOL));
  check('Solana pubkey: 31/33-byte keys and non-canonical spellings rejected', !Assets.isSolanaPubkey(Assets.base58Encode(crypto.randomBytes(31).fill(1, 0, 1))) && !Assets.isSolanaPubkey(Assets.base58Encode(Buffer.concat([Buffer.from([1]), crypto.randomBytes(32)]))) && !Assets.isSolanaPubkey('1' + USDC));
  const lower = NONSOL.quote.toLowerCase(), upper = NONSOL.quote.toUpperCase();
  check('case matters: lower/upper-cased mint is never the same key', Assets.normalizeAsset(Assets.SOLANA_MAINNET + ':' + lower) !== Assets.SOLANA_MAINNET + ':' + NONSOL.quote && Assets.normalizeAsset(Assets.SOLANA_MAINNET + ':' + upper) !== Assets.SOLANA_MAINNET + ':' + NONSOL.quote);
  const sid = Assets.formatAssetId({ chain: Assets.SOLANA_MAINNET, address: NONSOL.quote });
  check('formatAssetId solana keeps exact case', sid === 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:' + NONSOL.quote);
  const p = Assets.parseAssetId(sid);
  check('parseAssetId solana', p && p.kind === 'solana' && p.address === NONSOL.quote && p.id === sid);
  const evm = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
  check('bare 0x address = Robinhood Chain, lowercased (today\'s behaviour)', Assets.parseAssetId(evm).id === 'eip155:4663:' + evm.toLowerCase() && Assets.parseAssetId(evm).address === evm.toLowerCase());
  check('eip155:4663 id normalizes to lowercase', Assets.normalizeAsset('eip155:4663:' + evm) === 'eip155:4663:' + evm.toLowerCase());
  check('unknown chains / symbols / junk rejected', [
    'eip155:1:' + evm, 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:' + USDC, 'USDC', '$SYNC', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:', 'eip155:4663:0x12', null, undefined,
  ].every((x) => Assets.parseAssetId(x) === null));
  check('isEvmAddress / isSolanaMint do not cross', !Assets.isSolanaMint(evm) && !Assets.isEvmAddress(USDC));
}

// ================================================================ Phase 2 · Pump truth model
{
  check('PDA: BondingCurve of the Phase-0-style launch mint', Pump.bondingCurveOf(NONSOL.mint) === NONSOL.curve);
  check('PDA: BondingCurve of the first USDC launch', Pump.bondingCurveOf('4DBh3jCm57FDEu91mMkmgTCgGqZFicNKkUysfhvqmYyr') === 'EYtpqU2m8QUvWkdWhet8dMVLAVj2XBQ4F4rAQ6Tgb2td');
  check('ed25519: known pubkeys (program authority keys) are on curve; PDAs are not', !Pump.isOnCurve(Buffer.from(Assets.base58Decode(NONSOL.curve))) && Pump.isOnCurve(Buffer.from(Assets.base58Decode('Cshm2TvYdfPxdkqroiW28pocX1uNARzKC4u4XoKJU2bi'))));

  const x = Pump.extractCreateEvents(NONSOL.tx);
  check('v1 transaction (version 1): canonical non-SOL CreateEvent via self-CPI', F.nonSolV1.tx.version === 1 && x.events.length === 1 && x.events[0].mint === NONSOL.mint && x.events[0].quoteMint === NONSOL.quote && x.events[0].quotePresent && x.events[0].bondingCurve === NONSOL.curve && x.events[0].instruction === 'create_v2', JSON.stringify(x));
  check('decoded event never carries name/symbol/uri', !('name' in x.events[0]) && !('symbol' in x.events[0]) && !('uri' in x.events[0]));
  const u = Pump.extractCreateEvents(F.firstNonSol.tx);
  check('first non-SOL launch (USDC, slot 445675307) decodes', u.events.length === 1 && u.events[0].quoteMint === USDC && u.events[0].slot === Pump.NON_SOL_START_SLOT);
  const s = Pump.extractCreateEvents(F.solDirect.tx), c = Pump.extractCreateEvents(F.solCpi.tx);
  check('native SOL launch (direct) = default pubkey, never wSOL', s.events.length === 1 && s.events[0].quoteMint === Assets.NATIVE_SOL && !Pump.isNonSolQuote(s.events[0]));
  check('native SOL launch through a wrapper program (CPI create, stack 2 -> event stack 3)', c.events.length === 1 && c.events[0].quoteMint === Assets.NATIVE_SOL);
  const f = Pump.extractCreateEvents(F.failed.tx);
  check('failed transaction never yields an event', f.failed && f.events.length === 0);

  // Forgeries
  const keys = Pump.accountKeysOf(NONSOL.tx);
  const findEvent = (tx) => { for (const g of tx.meta.innerInstructions) for (const ix of g.instructions) { const d = Assets.base58Decode(ix.data); if (d && Buffer.from(d.slice(0, 16)).toString('hex') === Pump.EVENT_TAG + Pump.DISC.createEvent) return { g, ix }; } return null; };
  const t1 = clone(NONSOL.tx); const e1 = findEvent(t1); e1.ix.accounts[0] = keys.indexOf(Pump.GLOBAL);
  check('forged: event authority is not the first account -> rejected', Pump.extractCreateEvents(t1).events.length === 0 && Pump.extractCreateEvents(t1).rejected === 1);
  const t2 = clone(NONSOL.tx); const e2 = findEvent(t2); t2.transaction.message.accountKeys[e2.ix.programIdIndex] = randKey();
  check('forged: same bytes emitted to another program -> ignored', Pump.extractCreateEvents(t2).events.length === 0);
  const t3 = clone(NONSOL.tx); t3.transaction.message.instructions[findEvent(t3).g.index].data = Assets.base58Encode(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  check('forged: parent is not a Pump create -> rejected', Pump.extractCreateEvents(t3).events.length === 0);
  const t4 = clone(NONSOL.tx); const e4 = findEvent(t4); const d4 = Buffer.from(Assets.base58Decode(e4.ix.data)); Buffer.from(Assets.base58Decode(randKey())).copy(d4, 16 + (4 + 8) + (4 + 4) + (4 + 80)); e4.ix.data = Assets.base58Encode(d4);
  check('forged: event mint differs from the create instruction mint -> rejected', Pump.extractCreateEvents(t4).events.length === 0);
  const t5 = clone(NONSOL.tx); const e5 = findEvent(t5); delete e5.ix.stackHeight;
  check('event without stack information -> rejected', Pump.extractCreateEvents(t5).events.length === 0);
  const t6 = clone(NONSOL.tx); const g6 = findEvent(t6).g; const evIx = clone(findEvent(t6).ix); t6.meta.innerInstructions = []; t6.meta.logMessages = ['Program data: ' + Buffer.from(Assets.base58Decode(evIx.data)).subarray(8).toString('base64')];
  check('"Program data:" logs alone are never trusted', Pump.extractCreateEvents(t6).events.length === 0 && g6);
  const t7 = clone(NONSOL.tx); t7.meta.err = { InstructionError: [0, { Custom: 1 }] };
  check('meta.err -> failed, no events', Pump.extractCreateEvents(t7).failed && Pump.extractCreateEvents(t7).events.length === 0);

  // Version tolerance
  const raw = Buffer.from(Assets.base58Decode(findEvent(clone(NONSOL.tx)).ix.data));
  const baseEnd = 16 + (4 + 8) + (4 + 4) + (4 + 80) + 96; // name, symbol, uri, mint, bonding_curve, user
  const legacy = Pump.decodeCreateEvent(raw.subarray(0, baseEnd));
  check('legacy CreateEvent (no quote_mint field) decodes as native SOL', legacy && legacy.mint === NONSOL.mint && legacy.quoteMint === Assets.NATIVE_SOL && !legacy.quotePresent);
  check('truncated CreateEvent -> null', Pump.decodeCreateEvent(raw.subarray(0, baseEnd - 5)) === null && Pump.decodeCreateEvent(raw.subarray(0, 30)) === null);
  const longer = Pump.decodeCreateEvent(Buffer.concat([raw, Buffer.alloc(40)]));
  check('newer CreateEvent with extra trailing fields still decodes', longer && longer.quoteMint === NONSOL.quote);

  // BondingCurve
  const ev = x.events[0];
  check('BondingCurve decode: quote_mint @83', Pump.decodeBondingCurve(CURVE.data).quoteMint === NONSOL.quote);
  check('verifyLaunch: real curve account -> ok', Pump.verifyLaunch(ev, CURVE).ok);
  check('verifyLaunch: owner not Pump -> rejected', Pump.verifyLaunch(ev, { ...CURVE, owner: randKey() }).reason === 'curve-owner');
  const badDisc = Buffer.from(CURVE.data); badDisc[0] ^= 1;
  check('verifyLaunch: wrong discriminator -> rejected', Pump.verifyLaunch(ev, { owner: Pump.PROGRAM, data: badDisc }).reason === 'curve-discriminator');
  check('verifyLaunch: quote mismatch -> rejected', Pump.verifyLaunch(ev, curveWithQuote(USDC)).reason === 'quote-mismatch');
  check('verifyLaunch: curve account missing -> rejected', Pump.verifyLaunch(ev, null).reason === 'curve-missing');
  check('verifyLaunch: bonding curve that is not the PDA -> rejected', Pump.verifyLaunch({ ...ev, bondingCurve: randKey() }, CURVE).reason === 'curve-not-pda');
  const shortCurve = CURVE.data.subarray(0, 82);
  check('legacy BondingCurve (no quote_mint) reads as native SOL', Pump.decodeBondingCurve(shortCurve).quoteMint === Assets.NATIVE_SOL);
}

// ================================================================ Solana RPC client
{
  check('no SYNCNET_SOLANA_RPC_URL -> no client (no fallback)', SolRpc.createSolanaRpc({ env: {} }) === null && SolRpc.createSolanaRpc({ env: { SYNCNET_SOLANA_RPC_URL: 'http://insecure.example' } }) === null);
  const seen = [];
  const secretUrl = 'https://rpc.example/?api-key=SECRET123';
  const client = SolRpc.createSolanaRpc({ env: { SYNCNET_SOLANA_RPC_URL: secretUrl }, retries: 1, sleep: async () => {}, fetch: async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: seen[seen.length - 1].method === 'getSignaturesForAddress' ? [] : null }) }; } });
  await client.getTransaction(NONSOL.sig);
  await client.getSignaturesForAddress(Pump.MINT_AUTHORITY, { limit: 5000, until: NONSOL.sig });
  const gt = seen[0].params[1], gs = seen[1].params[1];
  check('getTransaction: finalized + maxSupportedTransactionVersion 1 + json', gt.commitment === 'finalized' && gt.maxSupportedTransactionVersion === 1 && gt.encoding === 'json');
  check('getSignaturesForAddress: finalized, limit capped at 1000, until passed', gs.commitment === 'finalized' && gs.limit === 1000 && gs.until === NONSOL.sig);
  let n = 0;
  const flaky = SolRpc.createSolanaRpc({ env: { SYNCNET_SOLANA_RPC_URL: secretUrl }, retries: 2, sleep: async () => {}, fetch: async () => { n++; return { ok: false, status: 429 }; } });
  let err = null; try { await flaky.getAccountInfo(USDC); } catch (e) { err = e; }
  check('bounded retries (retries=2 -> 3 attempts) then a generic error without the URL/secret', n === 3 && err && !/SECRET123|rpc\.example/.test(err.message + String(err.stack)), n + ' ' + (err && err.message));
}

// ================================================================ Phase 3 · generic index
const rel = (root, slot, child = randKey(), sig = randSig(), source = 'PUMP_FUN') => ({ source, relationship: 'LAUNCHED_AGAINST', rootMint: root, childMint: child, launchSlot: slot, launchSignature: sig });
async function pageAll(store, root, limit) {
  const out = []; let cursor = null, guard = 0;
  do { const p = await Index.readRootPage(store, { source: 'PUMP_FUN', relationship: 'LAUNCHED_AGAINST', rootMint: root, cursor, limit }); out.push(...p.items); cursor = p.nextCursor; } while (cursor && ++guard < 10000);
  return out;
}
{
  const store = durable();
  store._map.set('pons2:root:v1:0xabc', { type: 'string', value: 'PONS', expiresAt: null });
  const R = NONSOL.quote;
  const one = rel(R, 100);
  const w1 = await Index.writeRelationships(store, [one]);
  const w2 = await Index.writeRelationships(store, [one, one]);
  check('idempotent: rewriting a launch adds nothing', w1.added === 1 && w2.added === 0 && (await store.zcard(Index.K.root('PUMP_FUN', 'LAUNCHED_AGAINST', R))) === 1);
  const bad = (r) => { try { Index.checkRelationship(r); return false; } catch { return true; } };
  check('native SOL root / unknown source / bad slot / bad signature / root==child rejected', bad(rel(Assets.NATIVE_SOL, 1)) && bad(rel(R, 1, undefined, undefined, 'STONKFUN')) && bad({ ...rel(R, 1), launchSlot: -1 }) && bad({ ...rel(R, 1), launchSignature: 'x' }) && bad(rel(R, 1, R)));
  const keys = [...store._map.keys()];
  check('keys: only sollaunch:v1:mainnet:* written; PONS key untouched', keys.filter((k) => !k.startsWith('pons2:')).every((k) => k.startsWith('sollaunch:v1:mainnet:PUMP_FUN:LAUNCHED_AGAINST:root:')) && store._map.get('pons2:root:v1:0xabc').value === 'PONS');
  check('key preserves the exact mint case', keys.includes('sollaunch:v1:mainnet:PUMP_FUN:LAUNCHED_AGAINST:root:' + R));

  // Same-slot pagination: many launches share slots; every page size must return each launch exactly once, in order.
  const S = durable(); const R2 = USDC; const all = [];
  for (const slot of [500, 500, 500, 500, 500, 500, 500, 499, 498, 498, 498, 10, 10, 9]) all.push(rel(R2, slot));
  for (let i = 0; i < 60; i++) all.push(rel(R2, 1000 + (i % 7)));
  await Index.writeRelationships(S, all);
  const expected = all.map((r) => ({ slot: r.launchSlot, m: r.childMint + ':' + r.launchSignature })).sort((a, b) => b.slot - a.slot || (a.m < b.m ? 1 : a.m > b.m ? -1 : 0)).map((x) => x.m);
  let allOk = true;
  for (const lim of [1, 2, 3, 5, 7, 24, 50]) {
    const got = (await pageAll(S, R2, lim)).map((i) => i.childMint + ':' + i.launchSignature);
    if (got.length !== expected.length || got.some((m, k) => m !== expected[k])) { allOk = false; process.stdout.write(`   limit ${lim}: ${got.length}/${expected.length}\n`); }
  }
  check('same-slot pagination: no skips, no duplicates, deterministic order, every page size', allOk);
  const p1 = await Index.readRootPage(S, { source: 'PUMP_FUN', relationship: 'LAUNCHED_AGAINST', rootMint: R2, limit: 3 });
  await Index.writeRelationships(S, [rel(R2, 99999), rel(R2, 1005)]);
  const rest = await pageAll(S, R2, 3).then(() => null);
  let c = p1.nextCursor, cont = [];
  do { const p = await Index.readRootPage(S, { source: 'PUMP_FUN', relationship: 'LAUNCHED_AGAINST', rootMint: R2, cursor: c, limit: 4 }); cont.push(...p.items); c = p.nextCursor; } while (c);
  const firstIds = p1.items.map((i) => i.launchSignature);
  check('cursor stays exact after concurrent newer inserts (no skip, no repeat)', rest === null && cont.length === expected.length - 3 + 1 && !cont.some((i) => firstIds.includes(i.launchSignature)));
  check('page limit hard-capped at 50', (await Index.readRootPage(S, { source: 'PUMP_FUN', relationship: 'LAUNCHED_AGAINST', rootMint: R2, limit: 5000 })).items.length === 50);
  let threw = false; try { await Index.readRootPage(S, { source: 'PUMP_FUN', relationship: 'LAUNCHED_AGAINST', rootMint: R2, cursor: '12:abc' }); } catch { threw = true; }
  check('malformed cursor rejected', threw && Index.parseCursor('1:' + NONSOL.mint + ':' + NONSOL.sig) && !Index.parseCursor('1:' + NONSOL.mint.toLowerCase() + ':' + NONSOL.sig.slice(1)));

  // Checkpoint
  const C = durable();
  const a = await Index.advanceCheckpoint(C, 'PUMP_FUN', { signature: randSig(), slot: 50, at: 1 }, null);
  const { raw } = await Index.readCheckpoint(C, 'PUMP_FUN');
  const back = await Index.advanceCheckpoint(C, 'PUMP_FUN', { signature: randSig(), slot: 49, at: 2 }, raw);
  const stale = await Index.advanceCheckpoint(C, 'PUMP_FUN', { signature: randSig(), slot: 60, at: 2 }, null);
  const fwd = await Index.advanceCheckpoint(C, 'PUMP_FUN', { signature: randSig(), slot: 60, at: 3 }, raw);
  check('checkpoint: seeds, never moves to an older slot, compare-and-set refuses a stale writer', a && !back && !stale && fwd && (await Index.readCheckpoint(C, 'PUMP_FUN')).checkpoint.slot === 60);
}

// ================================================================ stub Solana chain for adapter / indexer / backfill
function stubChain({ entries, accounts = new Map(), failTx = new Set() }) {
  // entries: newest first [{signature, slot, err, tx}]
  const st = { getTransaction: 0, getSigs: 0, getMultiple: 0 };
  const byAddr = (addr) => entries.filter((e) => !e.address || e.address === addr);
  return {
    st,
    async getSignaturesForAddress(addr, { limit = 1000, before, until } = {}) {
      st.getSigs++;
      const list = byAddr(addr);
      let start = 0, end = list.length;
      if (before) { const i = list.findIndex((e) => e.signature === before); start = i < 0 ? list.length : i + 1; }
      if (until) { const i = list.findIndex((e) => e.signature === until); if (i >= 0) end = i; }
      return list.slice(start, Math.max(start, end)).slice(0, Math.min(1000, limit)).map(({ signature, slot, err }) => ({ signature, slot, err: err || null }));
    },
    async getTransaction(sig) {
      st.getTransaction++;
      if (failTx.has(sig)) throw new Error('boom');
      const e = entries.find((x) => x.signature === sig);
      return e && e.tx ? e.tx : e ? { slot: e.slot, meta: { err: null, innerInstructions: [] }, transaction: { message: { accountKeys: [], instructions: [] } } } : null;
    },
    async getMultipleAccounts(keys) { st.getMultiple++; return keys.map((k) => accounts.get(k) || null); },
  };
}
const txAt = (tx, slot) => { const t = clone(tx); t.slot = slot; return t; };
const launchEntry = (slot) => ({ signature: randSig(), slot, tx: txAt(NONSOL.tx, slot) });
const noise = (slot) => ({ signature: randSig(), slot });
const curves = new Map([[NONSOL.curve, CURVE], ['EYtpqU2m8QUvWkdWhet8dMVLAVj2XBQ4F4rAQ6Tgb2td', curveWithQuote(USDC)]]);

// ================================================================ adapter
{
  const entries = [
    { signature: F.failed.signature, slot: 30, err: { InstructionError: [0, 'x'] } },
    { signature: F.solCpi.signature, slot: F.solCpi.tx.slot, tx: F.solCpi.tx },
    { signature: F.solDirect.signature, slot: F.solDirect.tx.slot, tx: F.solDirect.tx },
    { signature: NONSOL.sig, slot: NONSOL.tx.slot, tx: NONSOL.tx },
    { signature: F.firstNonSol.signature, slot: F.firstNonSol.tx.slot, tx: F.firstNonSol.tx },
  ];
  const chain = stubChain({ entries, accounts: curves });
  const v = await Launches.verify(chain, entries.map(({ signature, slot, err }) => ({ signature, slot, err: err || null })));
  const roots = v.relationships.map((r) => r.rootMint).sort();
  check('adapter: 2 verified non-SOL launches, SOL launches + failed tx skipped', v.processed === 5 && v.relationships.length === 2 && roots.join() === [NONSOL.quote, USDC].sort().join() && v.stats.skipped['sol-quote'] === 2 && v.stats.skipped['failed-tx'] === 1, JSON.stringify(v.stats));
  check('adapter: failed signature never fetched; curves read in one batch', chain.st.getTransaction === 4 && chain.st.getMultiple === 1);
  check('adapter: relationship = provenance only', Object.keys(v.relationships[0]).sort().join() === 'childMint,launchSignature,launchSlot,relationship,rootMint,source');
  const noCurve = await Launches.verify(stubChain({ entries }), entries.map(({ signature, slot }) => ({ signature, slot, err: null })).slice(3));
  check('adapter: unverifiable curve -> nothing stored for it', noCurve.relationships.length === 0 && noCurve.stats.rejected['curve-missing'] === 2);
  const failing = stubChain({ entries, accounts: curves, failTx: new Set([NONSOL.sig]) });
  const part = await Launches.verify(failing, entries.map(({ signature, slot, err }) => ({ signature, slot, err: err || null })));
  check('adapter: RPC failure stops at the last contiguous signature', part.processed === 3 && part.relationships.length === 0);
}

// ================================================================ Phase 5 · incremental indexer
{
  const ON = { SYNCNET_PUMP_DISCOVERY_ENABLED: 'true', SYNCNET_SOLANA_RPC_URL: 'https://rpc.example' };
  const store = durable();
  const chain = stubChain({ entries: [launchEntry(1000)], accounts: curves });
  const off = await indexer._handler({}, { store, env: {}, rpc: chain });
  check('flag OFF: indexer does nothing (no RPC, no writes)', J(off).skipped === 'disabled' && chain.st.getSigs === 0 && store._map.size === 0);
  const nd = await indexer._handler({}, { store: createStore({ env: {} }), env: ON, rpc: chain });
  check('no durable store: indexer does nothing', J(nd).skipped === 'disabled' && chain.st.getSigs === 0);
  const norpc = await indexer._handler({}, { store, env: { SYNCNET_PUMP_DISCOVERY_ENABLED: 'true' } });
  check('no SYNCNET_SOLANA_RPC_URL: indexer does nothing', J(norpc).skipped === 'no-rpc' && store._map.size === 0);
  const nb = await indexer._handler({}, { store, env: ON, rpc: chain });
  check('no checkpoint: not-backfilled, never scans history', J(nb).report.status === 'not-backfilled' && chain.st.getTransaction === 0 && ![...store._map.keys()].some((k) => k.includes(':root:')));

  // checkpoint at slot 100; newer: noise 101, launch 102, noise 103, launch 104, noise 105 (newest first in the list)
  const cp = noise(100);
  const entries = [noise(105), launchEntry(104), noise(103), launchEntry(102), noise(101), cp, launchEntry(99)];
  const ch = stubChain({ entries, accounts: curves });
  await Index.advanceCheckpoint(store, 'PUMP_FUN', { signature: cp.signature, slot: 100, at: 1 }, null);
  const r1 = J(await indexer._handler({}, { store, env: ON, rpc: ch, maxSignatures: 2, now: () => 5000 }));
  const c1 = (await Index.readCheckpoint(store, 'PUMP_FUN')).checkpoint;
  check('bounded work: oldest first, maxSignatures honoured, checkpoint on last processed', r1.report.processed === 2 && c1.signature === entries[3].signature && c1.slot === 102 && r1.report.written === 1, JSON.stringify(r1));
  const r2 = J(await indexer._handler({}, { store, env: ON, rpc: ch, now: () => 6000 }));
  const c2 = (await Index.readCheckpoint(store, 'PUMP_FUN')).checkpoint;
  const key = Index.K.root('PUMP_FUN', 'LAUNCHED_AGAINST', NONSOL.quote);
  check('next run resumes after the checkpoint; slot 99 (before checkpoint) never indexed', r2.report.processed === 3 && c2.slot === 105 && (await store.zcard(key)) === 2);
  const r3 = J(await indexer._handler({}, { store, env: ON, rpc: ch, now: () => 7000 }));
  check('no new signatures: current, checkpoint time refreshed, slot unchanged', r3.report.status === 'current' && (await Index.readCheckpoint(store, 'PUMP_FUN')).checkpoint.at === 7000 && (await Index.readCheckpoint(store, 'PUMP_FUN')).checkpoint.slot === 105);

  // RPC failure mid-run
  const s2 = durable(); const cp2 = noise(10);
  const e2 = [launchEntry(14), launchEntry(13), launchEntry(12), launchEntry(11), cp2];
  await Index.advanceCheckpoint(s2, 'PUMP_FUN', { signature: cp2.signature, slot: 10, at: 1 }, null);
  const fr = J(await indexer._handler({}, { store: s2, env: ON, rpc: stubChain({ entries: e2, accounts: curves, failTx: new Set([e2[1].signature]) }) }));
  const fc = (await Index.readCheckpoint(s2, 'PUMP_FUN')).checkpoint;
  check('RPC failure: checkpoint stops before the failed signature; retried next run', fr.report.status === 'rpc-incomplete' && fc.slot === 12 && fr.report.processed === 2);
  const retry = J(await indexer._handler({}, { store: s2, env: ON, rpc: stubChain({ entries: e2, accounts: curves }) }));
  check('retry completes; idempotent zcard', retry.report.processed === 2 && (await s2.zcard(Index.K.root('PUMP_FUN', 'LAUNCHED_AGAINST', NONSOL.quote))) === 4);
  // Re-processing from an older checkpoint writes nothing new.
  const s2raw = (await Index.readCheckpoint(s2, 'PUMP_FUN')).raw;
  await s2.set(Index.K.checkpoint('PUMP_FUN'), JSON.stringify({ signature: cp2.signature, slot: 10, at: 1 }));
  const again = J(await indexer._handler({}, { store: s2, env: ON, rpc: stubChain({ entries: e2, accounts: curves }) }));
  check('idempotent re-processing (checkpoint rewound by an operator)', again.report.processed === 4 && again.report.written === 0 && s2raw);

  // Backlog beyond the look-back bound
  const s3 = durable(); const cp3 = noise(1);
  const many = []; for (let i = 0; i < 10 * 1000 + 5; i++) many.push(noise(100000 - i));
  await Index.advanceCheckpoint(s3, 'PUMP_FUN', { signature: cp3.signature, slot: 1, at: 1 }, null);
  const bl = J(await indexer._handler({}, { store: s3, env: ON, rpc: stubChain({ entries: [...many, cp3] }) }));
  check('backlog beyond 10 pages: nothing processed, checkpoint unchanged (backfill --catch-up)', bl.report.status === 'backlog' && (await Index.readCheckpoint(s3, 'PUMP_FUN')).checkpoint.slot === 1);

  // Lock
  const s4 = durable();
  await s4.set(Index.K.lock('PUMP_FUN'), 'x', { ttlSeconds: 55 });
  check('overlapping run skipped (lock)', J(await indexer._handler({}, { store: s4, env: ON, rpc: chain })).skipped === 'running');
}

// ================================================================ Phase 6 · API
{
  const ON = { SYNCNET_PUMP_DISCOVERY_ENABLED: 'true' };
  const store = durable();
  const off = await api._handler(get({ root: NONSOL.quote }), { store, env: {} });
  check('flag OFF: 404 {enabled:false}', off.statusCode === 404 && J(off).enabled === false && store._map.size === 0);
  const offNd = await api._handler(get({ root: NONSOL.quote }), { store: createStore({ env: {} }), env: ON });
  check('flag ON without durable store: disabled', offNd.statusCode === 404);
  const bad = async (q) => (await api._handler(get(q), { store, env: ON })).statusCode;
  check('validation: native SOL root refused', (await bad({ root: Assets.NATIVE_SOL })) === 400);
  check('validation: EVM address / symbol / non-base58 / wrong length refused', (await bad({ root: '0x' + 'a'.repeat(40) })) === 400 && (await bad({ root: 'USDC' })) === 400 && (await bad({})) === 400 && (await bad({ root: NONSOL.quote.slice(0, -1) + 'l' })) === 400 && (await bad({ root: NONSOL.quote + 'xx' })) === 400);
  const lowered = NONSOL.quote.toLowerCase(), lr = await api._handler(get({ root: lowered }), { store, env: ON });
  check('validation: a case-changed mint is never mapped onto the original', lr.statusCode === 400 || (J(lr).root.mint === lowered && lowered !== NONSOL.quote));
  check('validation: limit 0 / non-numeric, bad cursor refused', (await bad({ root: USDC, limit: '0' })) === 400 && (await bad({ root: USDC, limit: 'ten' })) === 400 && (await bad({ root: USDC, cursor: '5' })) === 400);
  const post = await api._handler({ httpMethod: 'POST', headers: {}, queryStringParameters: {} }, { store, env: ON });
  check('GET only', post.statusCode === 405);

  const all = []; for (let i = 0; i < 120; i++) all.push(rel(USDC, 7000 + Math.floor(i / 10)));
  await Index.writeRelationships(store, all);
  await Index.advanceCheckpoint(store, 'PUMP_FUN', { signature: randSig(), slot: 7011, at: 1000 }, null);
  await Index.writeBackfill(store, 'PUMP_FUN', { fromSlot: Pump.NON_SOL_START_SLOT, done: true });
  const r = await api._handler(get({ root: USDC, limit: '500' }), { store, env: ON, now: () => 2000 });
  const b = J(r);
  check('page: default contract fields', r.statusCode === 200 && b.chain === 'SOLANA_MAINNET' && b.chainId === Assets.SOLANA_MAINNET && b.source === 'PUMP_FUN' && b.relationship === 'LAUNCHED_AGAINST' && b.root.mint === USDC && b.total === 120, r.body.slice(0, 300));
  check('page: hard max 50 and a cursor', b.items.length === 50 && typeof b.nextCursor === 'string');
  check('page: provenance per item', b.items.every((it) => Assets.isSolanaMint(it.mint) && Number.isSafeInteger(it.launchSlot) && Index.isSignature(it.launchSignature) && it.source === 'PUMP_FUN' && it.assetId === Assets.SOLANA_MAINNET + ':' + it.mint));
  check('page: freshness fields', b.indexedThroughSlot === 7011 && b.indexedAt === new Date(1000).toISOString() && b.historyComplete === true && b.stale === false);
  check('page: no metadata fields stored or served', b.items.every((it) => !('name' in it) && !('symbol' in it) && !('uri' in it)));
  check('page: fixed response-size budget', Buffer.byteLength(r.body) <= api._internals.MAX_BODY_BYTES);
  const seen = new Set(b.items.map((i) => i.launchSignature)); let cur = b.nextCursor, pages = 1;
  while (cur) { const x = J(await api._handler(get({ root: USDC, cursor: cur, limit: '7' }), { store, env: ON })); x.items.forEach((i) => seen.add(i.launchSignature)); cur = x.nextCursor; pages++; }
  check('API pagination through same-slot groups returns every launch once', seen.size === 120 && pages > 2);
  const staleB = J(await api._handler(get({ root: USDC }), { store, env: ON, now: () => 1000 + api._internals.STALE_MS + 1 }));
  check('stale when the indexer has not advanced recently', staleB.stale === true);
  const empty = J(await api._handler(get({ root: NONSOL.mint }), { store, env: ON }));
  check('unknown root: empty page, not an error', empty.total === 0 && empty.items.length === 0 && empty.nextCursor === null);
  const rl = durable(); let last;
  for (let i = 0; i < 61; i++) last = await api._handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '192.0.2.9' }, queryStringParameters: { root: USDC } }, { store: rl, env: ON });
  check('rate limited (60/min per client)', last.statusCode === 429);
}

// ================================================================ Phase 4 · backfill
{
  check('args: dry run by default; write needs confirmation; flags validated', !Backfill.parseArgs([]).write && Backfill.parseArgs([]).fromSlot === Pump.NON_SOL_START_SLOT
    && (() => { try { Backfill.parseArgs(['--write', '--dry-run']); return false; } catch { return true; } })()
    && (() => { try { Backfill.parseArgs(['--catch-up']); return false; } catch { return true; } })()
    && (() => { try { Backfill.parseArgs(['--candidates=global']); return false; } catch { return true; } })());
  let e1 = null; try { await Backfill.main([], { }); } catch (e) { e1 = e; }
  check('no SYNCNET_SOLANA_RPC_URL: refuses', e1 && /SYNCNET_SOLANA_RPC_URL/.test(e1.message));
  const entries = [noise(500), launchEntry(450), noise(400), launchEntry(300), noise(250), launchEntry(150), noise(90)];
  let e2 = null; try { await Backfill.main(['--write'], { UPSTASH_REDIS_REST_URL: 'https://prod.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }, { rpc: stubChain({ entries }) }); } catch (e) { e2 = e; }
  check('write without --confirm-store-host: refuses', e2 && /confirm-store-host/.test(e2.message));
  const dry = await Backfill.main(['--from-slot=100'], {}, { rpc: stubChain({ entries, accounts: curves }) });
  check('dry run: verifies down to --from-slot, writes nothing', dry.mode === 'DRY-RUN' && dry.verified === 3 && dry.done && dry.oldestSlotReached === 150 && dry.signatures === 6, JSON.stringify(dry));

  const store = durable();
  const chain = stubChain({ entries, accounts: curves, failTx: new Set([entries[3].signature]) });
  const w1 = await Backfill.main(['--write', '--from-slot=100'], {}, { rpc: chain, store });
  const cp = (await Index.readCheckpoint(store, 'PUMP_FUN')).checkpoint;
  const bf = await Index.readBackfill(store, 'PUMP_FUN');
  check('write: checkpoint seeded at the head; partial run stops at the RPC failure with resume state', w1.incomplete && !w1.done && cp.slot === 500 && bf.before === entries[2].signature && !bf.done, JSON.stringify(w1));
  const w2 = await Backfill.main(['--write', '--from-slot=100'], {}, { rpc: stubChain({ entries, accounts: curves }), store });
  const key = Index.K.root('PUMP_FUN', 'LAUNCHED_AGAINST', NONSOL.quote);
  check('write: resumes from stored progress and completes', w2.resumed && w2.done && (await Index.readBackfill(store, 'PUMP_FUN')).done === true && (await store.zcard(key)) === 3, JSON.stringify(w2));
  await Index.advanceCheckpoint(store, 'PUMP_FUN', { signature: randSig(), slot: 900, at: 5 }, (await Index.readCheckpoint(store, 'PUMP_FUN')).raw);
  const w3 = await Backfill.main(['--write', '--from-slot=100'], {}, { rpc: stubChain({ entries, accounts: curves }), store });
  check('write: re-run is idempotent and never moves the checkpoint backwards', w3.done && w3.written === 0 && (await Index.readCheckpoint(store, 'PUMP_FUN')).checkpoint.slot === 900);
  const bounded = await Backfill.main(['--from-slot=100', '--max-signatures=2'], {}, { rpc: stubChain({ entries, accounts: curves }) });
  check('bounded batch: --max-signatures honoured, resume point reported', bounded.signatures === 2 && !bounded.done && bounded.resumeBefore === entries[1].signature);
  // quote-control candidates: the indexer checkpoint must still be a MINT-AUTHORITY signature it can find with `until`.
  const MA = Pump.MINT_AUTHORITY, QC = Pump.QUOTE_CONTROL;
  const maHead = { ...noise(800), address: MA }, qcL = { ...launchEntry(700), address: QC }, qcOld = { ...launchEntry(50), address: QC };
  const qs = durable();
  const qrun = await Backfill.main(['--write', '--candidates=quote-control', '--from-slot=100'], {}, { rpc: stubChain({ entries: [maHead, qcL, qcOld], accounts: curves }), store: qs });
  const qcp = (await Index.readCheckpoint(qs, 'PUMP_FUN')).checkpoint;
  check('quote-control backfill seeds the checkpoint with the mint-authority head (indexer can resume from it)', qrun.done && qrun.verified === 1 && qcp.signature === maHead.signature && qcp.slot === 800, JSON.stringify(qrun));
  const cu = durable();
  await Index.advanceCheckpoint(cu, 'PUMP_FUN', { signature: randSig(), slot: 300, at: 1 }, null);
  const cur = await Backfill.main(['--write', '--catch-up', '--from-slot=100'], {}, { rpc: stubChain({ entries, accounts: curves }), store: cu });
  check('catch-up walks back only to the checkpoint slot', cur.done && cur.verified === 2 && cur.oldestSlotReached === 300, JSON.stringify(cur));
  const sol = [noise(20), { signature: F.solDirect.signature, slot: F.solDirect.tx.slot, tx: F.solDirect.tx }];
  const solRun = await Backfill.main(['--from-slot=0'], {}, { rpc: stubChain({ entries: sol, accounts: curves }) });
  check('native SOL launches are never indexed by the backfill', solRun.verified === 0 && solRun.skipped['sol-quote'] === 1);
}

const passed = results.filter((r) => r.ok).length;
process.stdout.write(`\n${passed}/${results.length} solana discovery checks passed\n`);
process.exit(failures ? 1 : 0);
