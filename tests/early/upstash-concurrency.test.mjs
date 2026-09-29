// EARLY concurrency / race suite against REAL Redis semantics through the PRODUCTION Upstash adapter code path
// (netlify/lib/store.js incl. the cas() Lua script sent with EVAL). Two targets, chosen by environment:
//
//   real Upstash (the pilot gate):  UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN of a PREVIEW-ONLY database and
//                                   EARLY_TEST_UPSTASH_CONFIRM=preview   (never point this at production)
//   a local/throwaway Redis:        EARLY_TEST_REDIS=host:port  (a RESP bridge emulates the Upstash REST protocol,
//                                   so the same adapter, pipelines and EVAL script run against genuine Redis)
//
// Every scenario fires N concurrent requests at the real /api/early handler sharing one store and checks that exactly
// one wins where exactly one must win, and that every loser answers idempotently or with a fixed conflict code:
// duplicate nonces, simultaneous intent creation for one tuple, simultaneous matching of one transfer, duplicate
// finalisation, Count me in duplicates, manifest version races, rotation cancel races, session nonces.
// Keys are namespaced per run (fresh channel ids / wallets), nothing is flushed. Run: node tests/early/upstash-concurrency.test.mjs
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT, Core, E, ASSETS, lc, rnd32, KEYS, TEST_KEYS_FILE, ENV, USDG, clock, pc, resetPc, pay, makeSafe, syncHead, rpc, Session } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const early = require(path.join(ROOT, 'netlify/functions/early.js'));
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 400) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 400) + '\n'); } else process.stdout.write('ok   ' + name + '\n'); }
const finish = (target) => { fs.writeFileSync(path.join(ROOT, 'tests/early/upstash-concurrency.results.json'), JSON.stringify({ at: new Date().toISOString(), target, passed: results.length - failures, failed: failures, results }, null, 2)); console.log(`${results.length - failures}/${results.length} early real-Redis concurrency checks passed (${target})`); process.exit(failures ? 1 : 0); };

// ---------------------------------------------------------------- target selection
let store, target;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  if (process.env.EARLY_TEST_UPSTASH_CONFIRM !== 'preview') { console.log('Refusing: set EARLY_TEST_UPSTASH_CONFIRM=preview to confirm this is a preview-only Upstash database, never production.'); process.exit(2); }
  store = createStore({ env: process.env, timeoutMs: 8000 }); target = 'upstash:' + new URL(process.env.UPSTASH_REDIS_REST_URL).hostname;
} else if (process.env.EARLY_TEST_REDIS) {
  const [host, portText] = process.env.EARLY_TEST_REDIS.split(':'); const port = Number(portText || 6379);
  // minimal RESP client pool + Upstash REST bridge (the same approach as tests/project-home/redis-atomic.test.mjs)
  const encode = (args) => Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...args.flatMap((a) => { const b = Buffer.from(String(a), 'utf8'); return [Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')]; })]);
  function parseReply(buf, i = 0) {
    const t = String.fromCharCode(buf[i]); const e = buf.indexOf('\r\n', i); if (e < 0) return null;
    const line = buf.slice(i + 1, e).toString('utf8');
    if (t === '+') return { v: line, n: e + 2 };
    if (t === '-') return { v: { error: line }, n: e + 2 };
    if (t === ':') return { v: Number(line), n: e + 2 };
    if (t === '$') { const len = Number(line); if (len < 0) return { v: null, n: e + 2 }; if (buf.length < e + 2 + len + 2) return null; return { v: buf.slice(e + 2, e + 2 + len).toString('utf8'), n: e + 2 + len + 2 }; }
    if (t === '*') { const len = Number(line); if (len < 0) return { v: null, n: e + 2 }; const arr = []; let j = e + 2; for (let k = 0; k < len; k++) { const r = parseReply(buf, j); if (!r) return null; arr.push(r.v); j = r.n; } return { v: arr, n: j }; }
    throw new Error('bad RESP');
  }
  class Conn { constructor() { this.q = []; this.buf = Buffer.alloc(0); this.s = net.connect(port, host); this.s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); }); } drain() { while (this.q.length) { const r = parseReply(this.buf); if (!r) return; this.buf = this.buf.slice(r.n); this.q.shift()(r.v); } } cmd(args) { return new Promise((res) => { this.q.push(res); this.s.write(encode(args)); }); } }
  const pool = Array.from({ length: 16 }, () => new Conn()); let rr = 0;
  const wrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v ? { error: v.error } : { result: v });
  const bridge = async (url, init) => { const u = new URL(url); const body = JSON.parse(init.body); if (u.pathname === '/pipeline') { const c = pool[rr++ % pool.length]; const out = []; for (const cmd of body) out.push(wrap(await c.cmd(cmd))); return new Response(JSON.stringify(out), { status: 200 }); } return new Response(JSON.stringify(wrap(await pool[rr++ % pool.length].cmd(body))), { status: 200 }); };
  store = createStore({ env: { UPSTASH_REDIS_REST_URL: 'https://redis.bridge', UPSTASH_REDIS_REST_TOKEN: 't' }, fetch: bridge, timeoutMs: 8000 }); target = 'redis:' + host + ':' + port;
  process.on('exit', () => pool.forEach((c) => c.s.destroy()));
} else { console.log('No target: set UPSTASH_REDIS_REST_URL/TOKEN (+EARLY_TEST_UPSTASH_CONFIRM=preview) or EARLY_TEST_REDIS=host:port'); process.exit(2); }
check('store is the production Upstash adapter (durable)', store.kind === 'upstash' && store.durable === true, store.kind);

// ---------------------------------------------------------------- helpers (unique namespace per run)
const RUN = crypto.randomBytes(4).toString('hex');
const CH = 'UC' + crypto.randomBytes(16).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x').slice(0, 22);
const keyOf = (seed) => '0x' + crypto.createHash('sha256').update('early-conc-' + RUN + '-' + seed).digest('hex');
const KEY = { fan: keyOf('fan'), fan2: keyOf('fan2'), creator: keyOf('creator'), creator2: keyOf('creator2'), creator3: keyOf('creator3') };
const W = Object.fromEntries(Object.entries(KEY).map(([k, v]) => [k, lc(Core._internal.secp256k1.privateKeyToAddress(v))]));
const signAs = (who, digest) => Core._internal.secp256k1.sign(digest, KEY[who]);
const sign = (kind, m, who) => signAs(who, E.digest(kind, m));
let ipSeq = 0; const ip = () => `198.18.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const nowSec = () => Math.floor(clock.now() / 1000);
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body }; };
const call = async (method, body, query, over = {}) => parse(await early._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip(), ...(over.session ? { 'x-syncnet-early-session': over.session } : {}) }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null }, { store, env: ENV, rpc, now: () => clock.now(), keysFile: TEST_KEYS_FILE }));
const post = (b, over) => call('POST', b, null, over);
const get = (view, params, over) => call('GET', null, { view, ...(params || {}) }, over);
const creatorSession = async (wallet, who) => { const token = Session.issue({ scope: 'creator', wallet, channelId: CH, now: () => clock.now(), env: ENV }); const sid = token.split('.')[4]; await store.set('early:oauth:v1:' + sid, JSON.stringify({ wallet: lc(wallet), channelId: CH, title: 'Conc ' + who, avatarUrl: '', handle: '@conc', subscriberCount: 10, hiddenSubscriberCount: false, at: nowSec() }), { ttlSeconds: 900 }); return token; };
const acceptedRaw = [{ token: USDG, minAmount: '1000000' }];
const na = E.normalizeAcceptedAssets(acceptedRaw, E.parseAssetList(ASSETS));
const manifestBody = (wallet, who, version, prev) => { const m = { schema: E.SCHEMA.manifest, creatorId: E.creatorIdOf(CH), platform: 'youtube', channelId: CH, chainId: 4663, receivingWallet: wallet, acceptedAssetsHash: na.hash, manifestVersion: version, previousManifestHash: prev, issuedAt: nowSec(), nonce: rnd32() }; return { body: { action: 'creator-manifest', creatorId: m.creatorId, channelId: CH, receivingWallet: wallet, acceptedAssets: na.assets, acceptedAssetsHash: na.hash, manifestVersion: version, previousManifestHash: prev, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('CreatorManifest', m, who) }, hash: E.digest('CreatorManifest', m) }; };
const N = 20;
const tally = (rs) => rs.reduce((a, r) => { const k = r.s + ':' + (r.j.code || (r.j.idempotent ? 'idempotent' : r.j.status || 'ok')); a[k] = (a[k] || 0) + 1; return a; }, {});
resetPc();

// ============================================================================================ 1. Count me in: same nonce × N, different nonces × N
{
  const m = { schema: E.SCHEMA.countMeIn, platform: 'youtube', channelId: CH, fan: W.fan, issuedAt: nowSec(), expiry: nowSec() + E.CONST.CMI_TTL_S, nonce: rnd32() };
  const sig = sign('CountMeIn', m, 'fan');
  // the per-wallet signal budget is 20/day and every verified attempt counts (race losers included): 10 + 10 requests
  // stay inside it, so every answer below is a real race outcome, never a rate limit
  const rs = await Promise.all(Array.from({ length: 10 }, () => post({ action: 'count-me-in', channelId: CH, fan: W.fan, issuedAt: m.issuedAt, expiry: m.expiry, nonce: m.nonce, signature: sig })));
  const created = rs.filter((r) => r.s === 201).length, idem = rs.filter((r) => r.s === 200 && r.j.idempotent).length, replay = rs.filter((r) => r.s === 409).length;
  check('1a same signed signal × 10: exactly one creates, the rest idempotent/replay', created === 1 && created + idem + replay === 10, JSON.stringify(tally(rs)));
  const rs2 = await Promise.all(Array.from({ length: 10 }, () => { const mm = { ...m, issuedAt: nowSec(), nonce: rnd32() }; return post({ action: 'count-me-in', channelId: CH, fan: W.fan, issuedAt: mm.issuedAt, expiry: mm.expiry, nonce: mm.nonce, signature: sign('CountMeIn', mm, 'fan') }); }));
  const members = await store.smembers('early:cmi-set:v1:' + CH);
  check('1b 10 concurrent renewals with fresh nonces: still ONE record for (channel, fan); losers answer conflict', members.length === 1 && rs2.every((r) => r.s === 200 || r.s === 409) && rs2.some((r) => r.s === 200), JSON.stringify(tally(rs2)));
}

// ============================================================================================ 2. creator activation race × N
let M1;
{
  // the per-channel manifest budget is 20/day: 12 here + 4 in scenario 6 stay inside it
  const M = 12;
  const sessions = await Promise.all(Array.from({ length: M }, (_, i) => creatorSession(W.creator, 'creator')));
  const bodies = sessions.map(() => manifestBody(W.creator, 'creator', 1, E.ZERO32));
  const rs = await Promise.all(bodies.map((b, i) => post(b.body, { session: sessions[i] })));
  const wins = rs.filter((r) => r.s === 201);
  const manifests = await store.smembers('early:manifests:v1:' + E.creatorIdOf(CH));
  check('2 ' + M + ' concurrent first-manifest activations: exactly one ACTIVE creator, one manifest, losers 409', wins.length === 1 && manifests.length === 1 && rs.filter((r) => r.s === 409).length === M - 1, JSON.stringify(tally(rs)));
  M1 = wins.length ? wins[0].j.manifest.manifestHash : manifests[0];
}

// ============================================================================================ 3. simultaneous intent creation for one tuple
let I1;
{
  const drafts = await Promise.all(Array.from({ length: N }, () => post({ action: 'intent-draft', manifestHash: M1, sender: W.fan, token: USDG, amount: '1500000' })));
  const ok = drafts.filter((d) => d.s === 201);
  check('3a ' + N + ' concurrent drafts for one tuple: every draft may be issued (drafts are unsigned)', ok.length >= 1, JSON.stringify(tally(drafts)));
  const stores = await Promise.all(ok.map((d) => post({ action: 'intent-store', intentId: d.j.intentId, signature: signAs('fan', Core.hashTypedData(d.j.typedData)) })));
  const stored = stores.filter((r) => r.s === 201);
  const open = await store.get('early:open:v1:' + W.fan + ':' + W.creator + ':' + USDG + ':1500000');
  check('3b storing them concurrently: exactly ONE intent becomes OPEN for the tuple; the rest 409 intent_open', stored.length === 1 && open === stored[0].j.intent.intentId && stores.filter((r) => r.s === 409).length === ok.length - 1, JSON.stringify(tally(stores)));
  I1 = stored[0].j.intent;
}

// ============================================================================================ 4. simultaneous matching of one transfer × N
{
  const p = pay({ from: W.fan, to: W.creator, token: USDG, amount: '1500000' }); makeSafe(p.blockNumber);
  const rs = await Promise.all(Array.from({ length: N }, () => post({ action: 'verify', intentId: I1.intentId, txHash: p.txHash })));
  const fresh = rs.filter((r) => r.s === 200 && r.j.ok && !r.j.idempotent), idem = rs.filter((r) => r.s === 200 && r.j.idempotent), conflict = rs.filter((r) => r.s === 409);
  const ids = new Set(rs.filter((r) => r.j.receiptId).map((r) => r.j.receiptId));
  const claim = await store.get('early:txlog:v1:' + p.txHash + ':0');
  check('4 ' + N + ' concurrent verifies: exactly one creates the receipt, others idempotent/conflict, one receipt id, log claimed once', fresh.length === 1 && ids.size === 1 && fresh.length + idem.length + conflict.length === N && claim === I1.intentId, JSON.stringify(tally(rs)));
}

// ============================================================================================ 5. duplicate finalisation × N (ambiguous intent)
{
  clock.advance(2); syncHead();
  const d = await post({ action: 'intent-draft', manifestHash: M1, sender: W.fan, token: USDG, amount: '2000000' });
  const st = await post({ action: 'intent-store', intentId: d.j.intentId, signature: signAs('fan', Core.hashTypedData(d.j.typedData)) });
  const I2 = st.j.intent;
  const a = pay({ from: W.fan, to: W.creator, token: USDG, amount: '2000000' }); const b = pay({ from: W.fan, to: W.creator, token: USDG, amount: '2000000' }); makeSafe(b.blockNumber);
  const amb = await post({ action: 'verify', intentId: I2.intentId });
  check('5a two transfers → AMBIGUOUS', amb.j.status === 'AMBIGUOUS', amb.body);
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => { const tx = i % 2 ? a.txHash : b.txHash; const m = { schema: E.SCHEMA.finalize, intentId: I2.intentId, txHash: tx, logIndex: 0, issuedAt: nowSec(), nonce: rnd32() }; return post({ action: 'finalize', intentId: I2.intentId, txHash: tx, logIndex: 0, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('SupportFinalize', m, 'fan') }); }));
  const fresh = rs.filter((r) => r.s === 200 && r.j.ok && !r.j.idempotent);
  const receiptIds = new Set(rs.filter((r) => r.j.receiptId).map((r) => r.j.receiptId));
  const bound = [await store.get('early:txlog:v1:' + a.txHash + ':0'), await store.get('early:txlog:v1:' + b.txHash + ':0')].filter(Boolean);
  check('5b ' + N + ' concurrent finalisations naming both candidates: exactly one receipt, exactly one transfer bound, no double-bind', fresh.length === 1 && receiptIds.size === 1 && bound.length === 1, JSON.stringify(tally(rs)) + ' bound=' + bound.length);
}

// ============================================================================================ 6. manifest version race: two rotations at once
let pendingHash;
{
  const s2 = await creatorSession(W.creator2, 'creator2'), s3 = await creatorSession(W.creator3, 'creator3');
  const b2 = manifestBody(W.creator2, 'creator2', 2, M1), b3 = manifestBody(W.creator3, 'creator3', 2, M1);
  const rs = await Promise.all([post(b2.body, { session: s2 }), post(b3.body, { session: s3 }), post(b2.body, { session: s2 }), post(b3.body, { session: s3 })]);
  const wins = rs.filter((r) => r.s === 201);
  const c = JSON.parse(await store.get('early:creator:v1:' + E.creatorIdOf(CH)));
  check('6 concurrent rotations to two different wallets: exactly one ROTATION_PENDING, one pending manifest', wins.length === 1 && c.status === 'ROTATION_PENDING' && [b2.hash, b3.hash].includes(c.pendingManifestHash), JSON.stringify(tally(rs)));
  pendingHash = c.pendingManifestHash;
}

// ============================================================================================ 7. rotation cancel race × 10 (session + wallet)
{
  const s = await creatorSession(W.creator, 'creator');
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => { if (i % 2) return post({ action: 'rotation-cancel', creatorId: E.creatorIdOf(CH), pendingManifestHash: pendingHash }, { session: s }); const m = { schema: E.SCHEMA.rotationCancel, creatorId: E.creatorIdOf(CH), pendingManifestHash: pendingHash, issuedAt: nowSec(), nonce: rnd32() }; return post({ action: 'rotation-cancel', creatorId: m.creatorId, pendingManifestHash: pendingHash, issuedAt: m.issuedAt, nonce: m.nonce, signature: sign('RotationCancel', m, 'creator') }); }));
  const wins = rs.filter((r) => r.s === 200);
  const c = JSON.parse(await store.get('early:creator:v1:' + E.creatorIdOf(CH)));
  check('7 ten concurrent cancels (wallet + session): exactly one takes effect, creator ACTIVE, manifest CANCELLED once', wins.length === 1 && c.status === 'ACTIVE' && c.pendingManifestHash === null && JSON.parse(await store.get('early:manifest:v1:' + pendingHash)).status === 'CANCELLED', JSON.stringify(tally(rs)));
}

// ============================================================================================ 8. session nonce × N
{
  const m = { schema: E.SCHEMA.session, wallet: W.fan2, issuedAt: nowSec(), nonce: rnd32() };
  const sig = sign('EarlySession', m, 'fan2');
  // session budget: 10/h per wallet (every verified attempt counts) → 10 concurrent replays
  const rs = await Promise.all(Array.from({ length: 10 }, () => post({ action: 'session', wallet: W.fan2, issuedAt: m.issuedAt, nonce: m.nonce, signature: sig })));
  check('8 one signed session request replayed × 10: exactly one token, the rest 409 replay', rs.filter((r) => r.s === 200).length === 1 && rs.filter((r) => r.s === 409).length === 9, JSON.stringify(tally(rs)));
}

// ============================================================================================ 9. raw cas semantics on this Redis (the script itself)
{
  const k = 'early:conc:v1:' + RUN;
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => store.cas({ expect: [[k, null]], set: [[k, 'w' + i, 60]] })));
  check('9 50 concurrent set-if-absent cas on one key: exactly one true', rs.filter(Boolean).length === 1 && /^w\d+$/.test(await store.get(k)));
}

finish(target);
