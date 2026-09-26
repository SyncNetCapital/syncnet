// Real-Redis atomicity suite. Starts a throwaway local redis-server (no persistence) and bridges the Upstash REST
// protocol to it, so the PRODUCTION Upstash adapter code path — including the exact cas() Lua script sent with EVAL —
// runs against genuine Redis semantics. Proves: the script is atomic under heavy concurrency, it matches the in-memory
// adapter operation for operation, keys/values are inert data, and one chain payment can never activate two projects.
// Requires redis-server on PATH (Ubuntu: apt install redis-server). Run: node tests/project-home/redis-atomic.test.mjs
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { A, ROOT, SINK, PRICING, ENV, DEPLOYMENT, clock, pc, resetPc, resetChain, pay, setTags, rpc, signDigest, lc, rnd32 } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } }
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);
const finish = (code) => {
  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync(path.join(ROOT, 'tests/project-home/redis-atomic.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
  console.log(`${passed}/${results.length} project-home real-Redis checks passed`);
  process.exit(code);
};

if (spawnSync('redis-server', ['--version']).status !== 0) {
  results.push({ name: 'redis-server available', ok: false, detail: 'redis-server not installed' });
  console.log('redis-server is not installed: install it (apt install redis-server) to run this suite');
  failures++; finish(1);
}

// ---------------------------------------------------------------- throwaway redis-server
const port = 20000 + crypto.randomInt(20000);
const server = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--protected-mode', 'yes'], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 50; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); })) break; await new Promise((r) => setTimeout(r, 100)); }

// ---------------------------------------------------------------- minimal RESP client (a small pool, one command at a time per socket)
function encode(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) { const b = Buffer.from(String(a), 'utf8'); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')); }
  return Buffer.concat(parts);
}
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
class Conn {
  constructor() { this.q = []; this.buf = Buffer.alloc(0); this.s = net.connect(port, '127.0.0.1'); this.s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); }); }
  drain() { while (this.q.length) { const r = parseReply(this.buf); if (!r) return; this.buf = this.buf.slice(r.n); this.q.shift()(r.v); } }
  cmd(args) { return new Promise((res) => { this.q.push(res); this.s.write(encode(args)); }); }
}
const pool = Array.from({ length: 8 }, () => new Conn());
let rr = 0;
const redis = (args) => pool[rr++ % pool.length].cmd(args);
/** Upstash REST bridge: POST / {command array} and POST /pipeline [[...], ...]. */
async function upstashFetch(url, init) {
  const u = new URL(url);
  const body = JSON.parse(init.body);
  const wrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v ? { error: v.error } : { result: v });
  if (u.pathname === '/pipeline') { const out = []; const c = pool[rr++ % pool.length]; for (const cmd of body) out.push(wrap(await c.cmd(cmd))); return new Response(JSON.stringify(out), { status: 200 }); }
  return new Response(JSON.stringify(wrap(await redis(body))), { status: 200 });
}

const { createStore, CAS_SCRIPT } = require(path.join(ROOT, 'netlify/lib/store.js'));
const UP_ENV = { UPSTASH_REDIS_REST_URL: 'https://upstash.bridge', UPSTASH_REDIS_REST_TOKEN: 't' };
const up = createStore({ env: UP_ENV, fetch: upstashFetch, timeoutMs: 5000 });
check('R01 the production Upstash adapter is under test (durable, kind upstash)', up.durable === true && up.kind === 'upstash');
await redis(['FLUSHALL']);

// ---------------------------------------------------------------- basic semantics
check('R02 expect-nil set on an absent key succeeds', await up.cas({ expect: [['a', null]], set: [['a', '1']] }) === true && await up.get('a') === '1');
check('R03 expect-nil on an existing key fails and writes nothing', await up.cas({ expect: [['a', null]], set: [['a', '2'], ['b', 'x']] }) === false && await up.get('a') === '1' && await up.get('b') === null);
check('R04 expect-eq compare-and-set', await up.cas({ expect: [['a', '1']], set: [['a', '2']], sadd: [['s', 'm']] }) === true && await up.get('a') === '2' && (await up.smembers('s')).includes('m'));
check('R05 multi-key all-or-nothing: one failing expectation blocks every write', await up.cas({ expect: [['a', '2'], ['zz', 'nope']], set: [['a', '3'], ['c', '1']], sadd: [['s', 'n']] }) === false && await up.get('a') === '2' && await up.get('c') === null && !(await up.smembers('s')).includes('n'));
await up.cas({ expect: [], set: [['ttl', 'v', 2]] });
check('R06 TTL is applied with EX', Number(await redis(['TTL', 'ttl'])) > 0 && Number(await redis(['TTL', 'ttl'])) <= 2);
const nasty = "x'); redis.call('FLUSHALL') --\n]]\"\u0000\u202e";
check('R07 keys and values are data (a Lua-looking value is stored verbatim, nothing executed)', await up.cas({ expect: [[nasty, null]], set: [[nasty, nasty]] }) === true && await up.get(nasty) === nasty && await up.get('a') === '2');
await redis(['SADD', 'aset', 'm']);
let threw = false; try { await up.cas({ expect: [['aset', null]], set: [['q', '1']] }); } catch (e) { threw = e.name === 'StoreUnavailable'; }
check('R08 a Redis error inside the script surfaces as StoreUnavailable (fail closed) and writes nothing', threw && await up.get('q') === null);
check('R09 the script text is fixed: no key or value is interpolated into it', !/\$\{/.test(CAS_SCRIPT) && CAS_SCRIPT.includes("redis.call('GET', KEYS[i])"));

// ---------------------------------------------------------------- concurrency: one winner
await redis(['FLUSHALL']);
const N = 300;
const outcomes = await Promise.all(Array.from({ length: N }, (_, i) => up.cas({ expect: [['site:paylog:v1:0xabc:0', null]], set: [['site:paylog:v1:0xabc:0', 'req' + i], ['site:entitlement:v1:t' + i, 'e']] })));
const winners = outcomes.filter(Boolean).length;
const owner = await up.get('site:paylog:v1:0xabc:0');
const ents = (await redis(['KEYS', 'site:entitlement:v1:*'])).length;
check(`R10 ${N} concurrent claims of one payment log over 8 connections: exactly one wins`, winners === 1, winners);
check('R11 the winner is the only one whose entitlement exists (no partial writes by losers)', ents === 1 && (await up.get('site:entitlement:v1:t' + owner.slice(3))) === 'e');

// ---------------------------------------------------------------- differential: real Redis Lua == in-memory adapter
await redis(['FLUSHALL']);
const mem = createStore({ env: {}, map: new Map() });
const KEYS = ['k1', 'k2', 'k3', 'k4'];
const VALS = [null, 'a', 'b', 'c'];
let same = true, trace = '';
for (let i = 0; i < 400; i++) {
  const pick = (arr) => arr[crypto.randomInt(arr.length)];
  const spec = { expect: Array.from({ length: crypto.randomInt(3) }, () => [pick(KEYS), pick(VALS)]), set: Array.from({ length: 1 + crypto.randomInt(2) }, () => [pick(KEYS), pick(VALS.slice(1))]), sadd: crypto.randomInt(2) ? [['set1', pick(VALS.slice(1))]] : [] };
  const [a, b] = [await up.cas(spec), await mem.cas(spec)];
  const sa = await Promise.all(KEYS.map((k) => up.get(k))), sb = await Promise.all(KEYS.map((k) => mem.get(k)));
  const setA = (await up.smembers('set1')).sort().join(), setB = (await mem.smembers('set1')).sort().join();
  if (a !== b || JSON.stringify(sa) !== JSON.stringify(sb) || setA !== setB) { same = false; trace = JSON.stringify(spec) + ` redis=${a} mem=${b}`; break; }
}
check('R12 400 random multi-key operations: the Redis Lua script and the in-memory adapter agree exactly', same, trace);

// ---------------------------------------------------------------- end to end: two projects racing for ONE payment, on real Redis
await redis(['FLUSHALL']);
resetChain(); resetPc();
const ph = require(path.join(ROOT, 'netlify/functions/project-home.js'));
const Site = require(path.join(ROOT, 'lib/syncnet-site.js'));
const W = lc(A.WALLET);
const TA = '0x8' + '0'.repeat(39), TB = '0x8' + '1'.repeat(39);
for (const t of [TA, TB]) await up.set('mp:passport:v1:' + t, JSON.stringify({ token: t, operator: W, operatorSince: new Date(clock.now()).toISOString(), history: [] }));
let ipn = 0;
const call = async (body) => { const r = await ph._handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.' + (ipn++ % 250) }, body: JSON.stringify(body) }, { store: up, env: ENV, rpc, now: () => clock.now(), pricingFile: PRICING, deploymentFile: DEPLOYMENT }); return { s: r.statusCode, j: JSON.parse(r.body || '{}') }; };
const intentFor = async (token) => { const m = { token, operator: W, issuedAt: Math.floor(clock.now() / 1000), nonce: rnd32() }; return call({ action: 'intent', ...m, signature: signDigest(W, Site.digest('ActivationRequest', m)) }); };
const ia = await intentFor(TA), ib = await intentFor(TB);
check('R13 intents created through the Upstash adapter on real Redis', ia.s === 201 && ib.s === 201, JSON.stringify(ia.j) + JSON.stringify(ib.j));
check('R14 the two concurrent intents received different exact amounts (tag reservation)', ia.j.intent.exactTaggedSyncAmount !== ib.j.intent.exactTaggedSyncAmount);
// Force B's intent to demand A's exact amount — the worst case a tag collision could produce.
const rawB = JSON.parse(await up.get('site:intent:v1:' + ib.j.intent.requestId));
rawB.exactTaggedSyncAmount = ia.j.intent.exactTaggedSyncAmount;
await up.set('site:intent:v1:' + ib.j.intent.requestId, JSON.stringify(rawB));
const p = pay({ amount: BigInt(ia.j.intent.exactTaggedSyncAmount), from: W });
setTags({ safe: p.blockNumber });
const racers = await Promise.all(Array.from({ length: 24 }, (_, i) => call({ action: 'verify', requestId: (i % 2 ? ib : ia).j.intent.requestId, txHash: p.txHash })));
const activated = racers.filter((r) => r.s === 200 && r.j.idempotent === false).length;
const entA = await up.get('site:entitlement:v1:' + TA), entB = await up.get('site:entitlement:v1:' + TB);
check('R15 24 concurrent verifications, two projects, one payment: exactly ONE activation', activated === 1, racers.map((r) => r.s + (r.j.code ? ':' + r.j.code : '')).join(','));
check('R16 exactly one project is entitled; the claim, registry and intent agree with it', (entA ? 1 : 0) + (entB ? 1 : 0) === 1 && (await up.smembers('site:acts:v1')).length === 1 && (await up.get(`site:paylog:v1:${p.txHash}:0`)) === JSON.parse(entA || entB).requestId);
check('R17 every loser got a truthful answer (idempotent 200 for the winner request, 409 payment_already_used for the other project)', racers.every((r) => r.s === 200 || (r.s === 409 && r.j.code === 'payment_already_used')));

for (const c of pool) c.s.destroy();
server.kill('SIGKILL');
finish(failures ? 1 : 0);
