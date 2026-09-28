// Real-Redis sorted-set suite for the PONS V2 discovery index. Starts a throwaway local redis-server (no persistence)
// and bridges the Upstash REST protocol to it, so the PRODUCTION Upstash adapter code path (ZADD batches, pipelines,
// ZREVRANGEBYSCORE … WITHSCORES LIMIT, ZCARD, ZREM, ZREMRANGEBYSCORE) runs against genuine Redis, and compares every
// answer with the in-memory adapter. Requires redis-server on PATH. Run: node tests/unit/pons-redis-zset.test.mjs
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; console.log('FAIL', name, String(detail).slice(0, 300)); } else console.log('ok  ', name); }
const finish = (code) => { console.log(`${results.length - failures}/${results.length} pons real-Redis sorted-set checks passed`); process.exit(code); };
if (spawnSync('redis-server', ['--version']).status !== 0) { console.log('redis-server is not installed'); failures++; results.push({ ok: false }); finish(1); }

const port = 20000 + crypto.randomInt(20000);
const server = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch { /* gone */ } });
for (let i = 0; i < 50; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); })) break; await new Promise((r) => setTimeout(r, 100)); }

function encode(args) { const parts = [Buffer.from(`*${args.length}\r\n`)]; for (const a of args) { const b = Buffer.from(String(a), 'utf8'); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')); } return Buffer.concat(parts); }
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
const conn = new Conn();
const bridge = { requests: 0, commands: [] };
async function upstashFetch(url, init) {
  const u = new URL(url); const body = JSON.parse(init.body); bridge.requests++;
  const wrap = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'error' in v ? { error: v.error } : { result: v });
  if (u.pathname === '/pipeline') { const out = []; for (const cmd of body) { bridge.commands.push(cmd[0]); out.push(wrap(await conn.cmd(cmd))); } return new Response(JSON.stringify(out), { status: 200 }); }
  bridge.commands.push(body[0]);
  return new Response(JSON.stringify(wrap(await conn.cmd(body))), { status: 200 });
}

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const Index = require(path.join(ROOT, 'netlify/lib/pons-index.js'));
const up = createStore({ env: { UPSTASH_REDIS_REST_URL: 'https://upstash.bridge', UPSTASH_REDIS_REST_TOKEN: 't' }, fetch: upstashFetch, timeoutMs: 5000 });
const mem = createStore({ env: {}, map: new Map() });
await conn.cmd(['FLUSHALL']);

// Batched ZADD: 2,345 members across 3 roots -> one ZADD per root per 1000 members, one pipeline request.
const groups = [];
for (const [k, n] of [['pons2:root:v1:0x' + 'a'.repeat(40), 2100], ['pons2:root:v1:0x' + 'b'.repeat(40), 200], ['pons2:root:v1:native', 45]]) groups.push([k, Array.from({ length: n }, (_, i) => [74000000 * 1e6 + i * 3 + (i % 2), 'v2a:0x' + crypto.createHash('sha256').update(k + i).digest('hex').slice(0, 40)])]);
bridge.requests = 0; bridge.commands = [];
const w = await up.zaddMany(groups);
await mem.zaddMany(groups);
check('real Redis: 2,345 members = 5 ZADD commands in ONE pipeline request', w.added === 2345 && w.commands === 5 && bridge.requests === 1 && bridge.commands.every((c) => c === 'ZADD'), JSON.stringify(w));
check('real Redis: re-adding is idempotent (0 added)', (await up.zaddMany(groups)).added === 0);
check('real Redis: ZCARD', (await up.zcard('pons2:root:v1:0x' + 'a'.repeat(40))) === 2100 && (await up.zcard('missing')) === 0);

// Differential pagination (same order, same scores) over real Redis vs memory, including exact cursor bounds.
let same = true, pages = 0, cur = null, seen = 0;
do {
  const [a, b] = await Promise.all([Index.readRootPage(up, '0x' + 'a'.repeat(40), { cursor: cur, limit: 50 }), Index.readRootPage(mem, '0x' + 'a'.repeat(40), { cursor: cur, limit: 50 })]);
  if (JSON.stringify(a) !== JSON.stringify(b)) { same = false; break; }
  seen += a.items.length; cur = a.nextCursor; pages++;
} while (cur && pages < 100);
check('real Redis == memory adapter across every page of a 2,100-member root', same && seen === 2100 && pages === 42, `${same} ${seen} ${pages}`);
const tie = [['t', [[5, 'b'], [5, 'a'], [5, 'c'], [7, 'z']]]];
await up.zaddMany(tie); await mem.zaddMany(tie);
check('real Redis == memory for equal scores (reverse-lexicographic ties)', JSON.stringify(await up.zrevrangeByScore('t', '+inf', '-inf', 10)) === JSON.stringify(await mem.zrevrangeByScore('t', '+inf', '-inf', 10)));
check('real Redis: exclusive bound', JSON.stringify(await up.zrevrangeByScore('t', '(7', '-inf', 10)) === JSON.stringify(await mem.zrevrangeByScore('t', '(7', '-inf', 10)));
check('real Redis: zrem / zremRangeByScore counts match memory', (await up.zrem('t', ['a', 'q'])) === (await mem.zrem('t', ['a', 'q'])) && (await up.zremRangeByScore('t', '-inf', '(7')) === (await mem.zremRangeByScore('t', '-inf', '(7')));
await conn.cmd(['SET', 'str', 'x']);
let threw = false; try { await up.zcard('str'); } catch (e) { threw = e.name === 'StoreUnavailable'; }
check('real Redis: WRONGTYPE surfaces as StoreUnavailable (fail closed)', threw);
finish(failures ? 1 : 0);
