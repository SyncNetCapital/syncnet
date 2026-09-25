// Server infrastructure tests for the SyncNet Netlify Functions and their shared libraries.
// No real network: DNS, HTTPS, fetch and Upstash are injected fakes, and the real network entry points are
// trapped as a safety net (any attempt fails the run).
// Run: node tests/server/infra.test.mjs   -> exit 1 on any failure; writes tests/server/infra.results.json
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const started = Date.now();

// ------------------------------------------------------------------ environment + network trap
for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SYNCNET_UPSTASH_URL', 'SYNCNET_UPSTASH_TOKEN', 'SYNCNET_SESSION_EPOCH']) delete process.env[k];
process.env.SYNCNET_LOG_SALT = 'infra-test-salt';
const UPLOAD_KEY = 'u'.repeat(48);
const CANARY_KEY = 'C4n4ry-key-for-tests-0123456789-abcdef';
process.env.SYNCNET_UPLOAD_KEY = UPLOAD_KEY;
process.env.SYNCNET_CANARY_KEY = CANARY_KEY;

const realNetwork = [];
const trap = (name) => () => {
  realNetwork.push(name);
  throw new Error(`real network access attempted in tests: ${name}`);
};
{
  const https = require('https'); const http = require('http'); const dns = require('dns'); const net = require('net'); const tls = require('tls');
  https.request = trap('https.request'); https.get = trap('https.get');
  http.request = trap('http.request'); http.get = trap('http.get');
  dns.lookup = trap('dns.lookup'); dns.promises.lookup = trap('dns.promises.lookup');
  net.connect = trap('net.connect'); net.createConnection = trap('net.createConnection'); tls.connect = trap('tls.connect');
  globalThis.fetch = trap('fetch');
}

// ------------------------------------------------------------------ tiny harness
const checks = [];
const print = (s) => process.stdout.write(s + '\n');
function check(name, ok, detail) {
  const entry = { name, ok: Boolean(ok) };
  if (!ok && detail !== undefined) entry.detail = String(detail).slice(0, 500);
  checks.push(entry);
  print(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : ''}`);
}
// A section that throws or hangs (e.g. a deadline that no longer fires) fails instead of stalling the run.
async function section(title, fn, timeoutMs = 30_000) {
  print(`\n# ${title}`);
  let timer;
  try {
    await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`section timed out after ${timeoutMs} ms`)), timeoutMs); })]);
  } catch (err) {
    check(`${title}: completes without exception or hang`, false, (err && err.stack) || err);
  } finally {
    clearTimeout(timer);
  }
}
const logs = [];
console.log = (...args) => { logs.push(args.map(String).join(' ')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (res) => JSON.parse(res.body);
const hdr = (res, name) => res.headers[name.toLowerCase()];
function clock(start) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  fn.set = (v) => { t = v; };
  return fn;
}
async function rejects(promise, Cls) {
  try { await promise; return false; } catch (err) { return !Cls || err instanceof Cls; }
}
let ipCounter = 0;
const nextIp = () => { const n = ipCounter++; return `10.250.${(n >> 8) & 255}.${n & 255}`; }; // every client IP starts with 10.250.
const T0 = Date.UTC(2026, 8, 23, 12, 1, 0); // 12:01:00Z: one minute into an hour and into a 15-minute window
const BIDI_ZW = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const SECURITY_HEADERS = (res) => hdr(res, 'content-type') === 'application/json; charset=utf-8'
  && hdr(res, 'x-content-type-options') === 'nosniff'
  && hdr(res, 'content-security-policy') === "default-src 'none'; frame-ancestors 'none'"
  && hdr(res, 'referrer-policy') === 'no-referrer';

const respond = require(path.join(ROOT, 'netlify/lib/respond.js'));
const logLib = require(path.join(ROOT, 'netlify/lib/log.js'));
const storeLib = require(path.join(ROOT, 'netlify/lib/store.js'));
const rl = require(path.join(ROOT, 'netlify/lib/ratelimit.js'));
const us = require(path.join(ROOT, 'netlify/lib/upload-session.js'));
const siteCheck = require(path.join(ROOT, 'netlify/functions/site-check.js'));
const launchesFn = require(path.join(ROOT, 'netlify/functions/par-launches-all.js'));
const tokenlistFn = require(path.join(ROOT, 'netlify/functions/par-tokenlist.js'));
const canary = require(path.join(ROOT, 'netlify/functions/canary-auth.js'));
const { createStore, getStore, StoreUnavailable, _resetForTests } = storeLib;
const memStore = (now) => createStore({ env: {}, now });
const hmacHex = (key, text) => crypto.createHmac('sha256', key).update(text).digest('hex');

// ================================================================== respond.js
await section('respond.js', async () => {
  const r = respond.json(200, { a: '<script>&</script>\u2028' });
  check('json(): content-type, nosniff, CSP, referrer-policy', SECURITY_HEADERS(r));
  check('json(): cache-control defaults to no-store', hdr(r, 'cache-control') === 'no-store');
  check('json(): body escapes < > & U+2028 and parses back to the same value', !/[<>&\u2028]/.test(r.body) && body(r).a === '<script>&</script>\u2028');
  const r2 = respond.json(200, {}, { 'Cache-Control': 'public, max-age=5', 'Content-Type': 'text/html', 'X-Content-Type-Options': 'sniff', 'content-security-policy': 'none', 'x-extra': 'y', 'x-bad': 'a\r\nset-cookie: z' });
  check('json(): cache-control overridable (case-insensitive, single header)', hdr(r2, 'cache-control') === 'public, max-age=5' && !('Cache-Control' in r2.headers));
  check('json(): security headers cannot be overridden', SECURITY_HEADERS(r2));
  check('json(): extra headers added, CR/LF values dropped', r2.headers['x-extra'] === 'y' && !('x-bad' in r2.headers));
  const e = respond.publicError(502, 'upstream_unavailable', 'Try again later.');
  check('publicError(): {error, code} only', e.statusCode === 502 && same(body(e), { error: 'Try again later.', code: 'upstream_unavailable' }) && SECURITY_HEADERS(e));
  const e2 = respond.publicError(500, 'x', new Error('connect ECONNREFUSED 10.0.0.1 SECRET'));
  check('publicError(): an Error object is replaced by a generic message', !/ECONNREFUSED|SECRET/.test(e2.body) && typeof body(e2).error === 'string');
  const t = respond.tooManyRequests(12.2);
  check('tooManyRequests(): 429 + retry-after (rounded up) + generic body', t.statusCode === 429 && hdr(t, 'retry-after') === '13' && body(t).code === 'rate_limited' && body(t).retryAfter === 13 && /too many requests/i.test(body(t).error) && hdr(t, 'cache-control') === 'no-store');
  check('tooManyRequests(): invalid input -> 60 s', hdr(respond.tooManyRequests('x'), 'retry-after') === '60');
});

// ================================================================== log.js
await section('log.js', async () => {
  const h = logLib.hashId('203.0.113.7');
  check('hashId(): 16 hex chars', /^[0-9a-f]{16}$/.test(h));
  check('hashId(): HMAC-SHA256 keyed with SYNCNET_LOG_SALT', h === hmacHex('infra-test-salt', '203.0.113.7').slice(0, 16));
  const saved = process.env.SYNCNET_LOG_SALT;
  delete process.env.SYNCNET_LOG_SALT;
  check('hashId(): default salt syncnet-log-v1', logLib.hashId('203.0.113.7') === hmacHex('syncnet-log-v1', '203.0.113.7').slice(0, 16));
  process.env.SYNCNET_LOG_SALT = saved;
  const n = logs.length;
  logLib.log('fn-x', 'evt', { a: 1, ts: 'forged', fn: 'forged', event: 'forged' });
  let line = null;
  try { line = JSON.parse(logs[n]); } catch {}
  check('log(): exactly one JSON line with ts/fn/event + fields', logs.length === n + 1 && line && line.fn === 'fn-x' && line.event === 'evt' && line.a === 1 && !Number.isNaN(Date.parse(line.ts)));
  check('log(): fields cannot override ts/fn/event', line && line.ts !== 'forged' && line.fn === 'fn-x' && line.event === 'evt');
  logLib.logError('fn-y', 'boom', Object.assign(new Error('bad thing'), { code: 'EBAD', cause: new Error('root cause') }), { k: 'v' });
  let le = null;
  try { le = JSON.parse(logs[logs.length - 1]); } catch {}
  check('logError(): name/message/code (+cause) server side', le && le.error.name === 'Error' && le.error.message === 'bad thing' && le.error.code === 'EBAD' && le.error.cause.message === 'root cause' && le.k === 'v');
});

// ================================================================== store.js
await section('store.js: memory adapter', async () => {
  const c = clock(T0);
  const m = memStore(c);
  check('no Upstash env -> memory adapter (durable:false)', m.kind === 'memory' && m.durable === false);
  check('incrWindow counts 1, 2, 3', (await m.incrWindow('k', 10)) === 1 && (await m.incrWindow('k', 10)) === 2 && (await m.incrWindow('k', 10)) === 3);
  check('incrWindow stores the count as a string (like Redis)', (await m.get('k')) === '3');
  c.advance(10_001);
  check('incrWindow key expires after its ttl', (await m.incrWindow('k', 10)) === 1);
  await m.set('s', 'v', { ttlSeconds: 5 });
  const before = await m.get('s');
  c.advance(5_001);
  check('set with ttlSeconds expires', before === 'v' && (await m.get('s')) === null);
  await m.set('p', 'x');
  c.advance(1e9);
  check('set without ttl persists', (await m.get('p')) === 'x');
  check('del', (await m.del('p')) === 1 && (await m.get('p')) === null && (await m.del('p')) === 0);
  check('sadd/smembers', (await m.sadd('set', 'a')) === 1 && (await m.sadd('set', 'a')) === 0 && (await m.sadd('set', 'b')) === 1 && same((await m.smembers('set')).sort(), ['a', 'b']) && same(await m.smembers('none'), []));
  check('get missing -> null', (await m.get('missing')) === null);
});

function fakeUpstash(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (typeof reply === 'function') return reply(url, init);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}
const UPSTASH_ENV = { UPSTASH_REDIS_REST_URL: 'https://fake-upstash.test/', UPSTASH_REDIS_REST_TOKEN: 'tok-123' };
const headerOf = (headers, name) => Object.entries(headers || {}).find(([k]) => k.toLowerCase() === name)?.[1];

await section('store.js: Upstash REST adapter (fake fetch)', async () => {
  const u1 = fakeUpstash([{ result: 7 }, { result: 1 }]);
  const s = createStore({ env: UPSTASH_ENV, fetch: u1.fetch });
  check('Upstash env -> upstash adapter (durable:true)', s.kind === 'upstash' && s.durable === true);
  const n = await s.incrWindow('rl:x:abc:5', 60);
  check('incrWindow returns the INCR result', n === 7);
  check('incrWindow: POST <url>/pipeline', u1.calls.length === 1 && u1.calls[0].url === 'https://fake-upstash.test/pipeline' && u1.calls[0].init.method === 'POST');
  check('incrWindow: body [["INCR",k],["EXPIRE",k,ttl,"NX"]]', same(u1.calls[0].body, [['INCR', 'rl:x:abc:5'], ['EXPIRE', 'rl:x:abc:5', 60, 'NX']]), JSON.stringify(u1.calls[0].body));
  check('Authorization: Bearer <token>', headerOf(u1.calls[0].init.headers, 'authorization') === 'Bearer tok-123');
  check('request carries an AbortSignal and refuses redirects', u1.calls[0].init.signal instanceof AbortSignal && u1.calls[0].init.redirect === 'error');

  const replies = { GET: { result: 'v1' }, SET: { result: 'OK' }, DEL: { result: 1 }, SADD: { result: 1 }, SMEMBERS: { result: ['a', 'b'] } };
  const u2 = fakeUpstash((url, init) => new Response(JSON.stringify(replies[JSON.parse(init.body)[0]]), { status: 200 }));
  const s2 = createStore({ env: UPSTASH_ENV, fetch: u2.fetch });
  const got = await s2.get('k1');
  await s2.set('k2', 'v', { ttlSeconds: 30 });
  await s2.set('k3', 'v');
  const deleted = await s2.del('k4');
  const added = await s2.sadd('k5', 'm');
  const members = await s2.smembers('k6');
  check('single commands: POST to the base URL', u2.calls.every((c) => c.url === 'https://fake-upstash.test' && c.init.method === 'POST'));
  check('GET body ["GET",k] -> result', same(u2.calls[0].body, ['GET', 'k1']) && got === 'v1');
  check('SET with ttl body ["SET",k,v,"EX",ttl]', same(u2.calls[1].body, ['SET', 'k2', 'v', 'EX', 30]));
  check('SET without ttl body ["SET",k,v]', same(u2.calls[2].body, ['SET', 'k3', 'v']));
  check('DEL / SADD / SMEMBERS bodies and results', same(u2.calls[3].body, ['DEL', 'k4']) && same(u2.calls[4].body, ['SADD', 'k5', 'm']) && same(u2.calls[5].body, ['SMEMBERS', 'k6']) && deleted === 1 && added === 1 && same(members, ['a', 'b']));

  const errStore = (reply, extra = {}) => createStore({ env: UPSTASH_ENV, fetch: fakeUpstash(reply).fetch, ...extra });
  check('pipeline {error} entry -> StoreUnavailable', await rejects(errStore([{ error: 'ERR boom' }, { result: 1 }]).incrWindow('k', 1), StoreUnavailable));
  check('any entry carrying an error field fails, even with a result', await rejects(errStore([{ result: 3, error: 'ERR partial' }, { result: 1 }]).incrWindow('k', 1), StoreUnavailable) && await rejects(errStore(() => new Response(JSON.stringify({ result: 'v', error: 'ERR' }), { status: 200 })).get('k'), StoreUnavailable));
  check('single {error} reply -> StoreUnavailable', await rejects(errStore(() => new Response(JSON.stringify({ error: 'WRONGTYPE' }), { status: 200 })).get('k'), StoreUnavailable));
  check('HTTP 401 -> StoreUnavailable', await rejects(errStore(() => new Response('unauthorized', { status: 401 })).get('k'), StoreUnavailable));
  check('network error -> StoreUnavailable', await rejects(errStore(() => { throw new TypeError('fetch failed'); }).get('k'), StoreUnavailable));
  check('non-JSON reply -> StoreUnavailable', await rejects(errStore(() => new Response('<html>', { status: 200 })).get('k'), StoreUnavailable));
  check('malformed pipeline reply -> StoreUnavailable', await rejects(errStore({ result: 1 }).incrWindow('k', 1), StoreUnavailable));
  let t0 = Date.now();
  check('timeout (injected 40 ms, fetch ignores the signal) -> StoreUnavailable', await rejects(createStore({ env: UPSTASH_ENV, fetch: () => new Promise(() => {}), timeoutMs: 40 }).get('k'), StoreUnavailable) && Date.now() - t0 < 1000);
  t0 = Date.now();
  const timedOut = await rejects(createStore({ env: UPSTASH_ENV, fetch: () => new Promise(() => {}) }).get('k'), StoreUnavailable);
  const elapsed = Date.now() - t0;
  check('default timeout is 2 s', timedOut && elapsed >= 1900 && elapsed < 3500, `${elapsed} ms`);
  const insecure = fakeUpstash({ result: 'x' });
  check('http:// Upstash URL refused, token never sent', await rejects(createStore({ env: { UPSTASH_REDIS_REST_URL: 'http://insecure.test', UPSTASH_REDIS_REST_TOKEN: 't' }, fetch: insecure.fetch }).get('k'), StoreUnavailable) && insecure.calls.length === 0);
  check('SYNCNET_UPSTASH_URL / SYNCNET_UPSTASH_TOKEN also select Upstash', createStore({ env: { SYNCNET_UPSTASH_URL: 'https://x.test', SYNCNET_UPSTASH_TOKEN: 't' } }).kind === 'upstash');
  check('URL without token -> memory', createStore({ env: { UPSTASH_REDIS_REST_URL: 'https://x.test' } }).kind === 'memory');

  _resetForTests();
  const a = getStore();
  check('getStore(): singleton (memory without env)', a === getStore() && a.kind === 'memory');
  const injected = getStore({ env: UPSTASH_ENV, fetch: fakeUpstash({ result: null }).fetch });
  check('getStore({env, fetch}) replaces the singleton for later getStore() calls', injected.kind === 'upstash' && getStore() === injected);
  _resetForTests();
  check('_resetForTests() drops the singleton', getStore().kind === 'memory' && getStore() !== injected);
  _resetForTests();
});

// ================================================================== ratelimit.js
await section('ratelimit.js', async () => {
  check('clientIp(): x-nf-client-connection-ip first', rl.clientIp({ headers: { 'x-nf-client-connection-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' } }) === '1.2.3.4');
  check('clientIp(): then first x-forwarded-for entry', rl.clientIp({ headers: { 'x-forwarded-for': ' 5.6.7.8 , 9.9.9.9' } }) === '5.6.7.8');
  check('clientIp(): header names case-insensitive', rl.clientIp({ headers: { 'X-NF-Client-Connection-IP': '1.2.3.4' } }) === '1.2.3.4');
  check("clientIp(): 'unknown' otherwise", rl.clientIp({ headers: {} }) === 'unknown' && rl.clientIp({}) === 'unknown');

  const minute = T0 - (T0 % 60_000);
  const c = clock(minute + 10_000); // 10 s into a 60 s window
  const st = memStore(c);
  const spec = { bucket: 'unit', id: '1.2.3.4', limit: 3, windowSeconds: 60, now: c };
  const r = [];
  for (let i = 0; i < 4; i += 1) r.push(await rl.limit(st, spec));
  check('memory windows: first 3 allowed with counts 1..3', r.slice(0, 3).every((x, i) => x.allowed && x.count === i + 1 && x.limit === 3));
  check('memory windows: 4th denied, retryAfter = seconds left in the window', !r[3].allowed && r[3].count === 4 && r[3].retryAfter === 50);
  check('key format rl:<bucket>:<hashId(id)>:<windowIndex>', (await st.get(`rl:unit:${logLib.hashId('1.2.3.4')}:${Math.floor(c() / 60_000)}`)) === '4');
  check('other ids have their own counter', (await rl.limit(st, { ...spec, id: '4.3.2.1' })).count === 1);
  c.advance(50_000);
  const next = await rl.limit(st, spec);
  check('memory windows: next window starts again at 1', next.allowed && next.count === 1);

  const broken = { incrWindow: async () => { throw new StoreUnavailable('down'); } };
  const fc = await rl.limit(broken, spec);
  check('StoreUnavailable -> fails closed {allowed:false, reason:store-unavailable, retryAfter:60}', fc.allowed === false && fc.reason === 'store-unavailable' && fc.retryAfter === 60);
  const upstashDown = createStore({ env: UPSTASH_ENV, fetch: async () => new Response('bad gateway', { status: 502 }) });
  const fc2 = await rl.limit(upstashDown, spec);
  check('Upstash HTTP 502 -> StoreUnavailable -> rate limit fails closed', fc2.allowed === false && fc2.reason === 'store-unavailable');
  const upstashOk = createStore({ env: UPSTASH_ENV, fetch: fakeUpstash([{ result: 2 }, { result: 0 }]).fetch });
  const okUp = await rl.limit(upstashOk, spec);
  check('Upstash adapter drives the limiter', okUp.allowed && okUp.count === 2);

  const st2 = memStore(c);
  const A = { bucket: 'a', id: 'x', limit: 1, windowSeconds: 60, now: c };
  const B = { bucket: 'b', id: 'x', limit: 5, windowSeconds: 60, now: c };
  const first = await rl.limitAll(st2, [A, B]);
  const second = await rl.limitAll(st2, [A, B]);
  const bCount = await st2.get(`rl:b:${logLib.hashId('x')}:${Math.floor(c() / 60_000)}`);
  check('limitAll(): allowed when every spec allows', first.allowed === true);
  check('limitAll(): first denial returned, later specs not incremented', second.allowed === false && second.bucket === 'a' && bCount === '1');
});

// ================================================================== upload-session.js
await section('upload-session.js: sessions', async () => {
  const now = T0;
  const nowS = Math.floor(now / 1000);
  const tok = us.issue({ scope: 'founder', subject: '-', ttlSeconds: 7200, now });
  const p = tok.split('.');
  check('issue(): v2.<scope>.<subject>.<exp>.<sid>.<mac>', /^v2\.founder\.-\.\d+\.[0-9a-f]{16}\.[0-9a-f]{64}$/.test(tok), tok);
  check('issue(): exp = now + ttl', Number(p[3]) === nowS + 7200);
  check('issue(): mac = HMAC(SYNCNET_UPLOAD_KEY, syncnet-session|v2|scope|subject|exp|sid|epoch)', p[5] === hmacHex(UPLOAD_KEY, `syncnet-session|v2|founder|-|${p[3]}|${p[4]}|1`));
  check('issue(): sid is random', us.issue({ scope: 'founder', now }).split('.')[4] !== us.issue({ scope: 'founder', now }).split('.')[4]);
  const v = us.verify(tok, { scope: 'founder', now });
  check('verify(): accepts a founder token', v && same(v, { scope: 'founder', subject: '-', exp: nowS + 7200, sid: p[4] }));
  check('verify(): wrong scope option -> null', us.verify(tok, { scope: 'wallet', now }) === null);
  check('verify(): scope option may be a list; no option = any scope', us.verify(tok, { scope: ['wallet', 'founder'], now }) !== null && us.verify(tok, { now }) !== null);
  check('TTL = {founder: 7200, wallet: 1800}', same({ ...us.TTL }, { founder: 7200, wallet: 1800 }));

  const W = '0x' + 'Ab'.repeat(20);
  const wt = us.issue({ scope: 'wallet', subject: W, now });
  const wv = us.verify(wt, { scope: 'wallet', now });
  check('wallet token: lowercase address subject, default ttl 30 min', wt.split('.')[2] === W.toLowerCase() && wv && wv.subject === W.toLowerCase() && wv.exp === nowS + 1800);
  check('ttlSeconds capped at TTL[scope]', Number(us.issue({ scope: 'wallet', subject: W, ttlSeconds: 99_999, now }).split('.')[3]) === nowS + 1800);
  const ft = us.issue({ scope: 'founder', subject: W, now });
  check('scope binding: founder token relabelled wallet -> null', us.verify(ft.replace('v2.founder.', 'v2.wallet.'), { now }) === null);
  check('subject binding: other address -> null', us.verify(wt.replace(W.toLowerCase(), '0x' + '1'.repeat(40)), { now }) === null);
  check('subject binding: founder "-" token rewritten to an address -> null', us.verify(tok.replace('.-.', `.${'0x' + '2'.repeat(40)}.`), { now }) === null);
  check('issue(): wallet scope needs an address subject', us.issue({ scope: 'wallet', subject: '-', now }) === '');
  check('issue(): invalid subject / unknown scope -> ""', us.issue({ scope: 'founder', subject: 'bob', now }) === '' && us.issue({ scope: 'admin', now }) === '');

  check('expiry: valid 1 s before exp', us.verify(tok, { now: now + 7199 * 1000 }) !== null);
  check('expiry: rejected at/after exp', us.verify(tok, { now: now + 7200 * 1000 }) === null && us.verify(tok, { now: now + 9e6 }) === null);
  const forge = (scope, subject, exp) => {
    const sid = 'a'.repeat(16);
    return `v2.${scope}.${subject}.${exp}.${sid}.${hmacHex(UPLOAD_KEY, `syncnet-session|v2|${scope}|${subject}|${exp}|${sid}|1`)}`;
  };
  const addr = W.toLowerCase();
  check('correctly signed but exp beyond founder max (2 h) -> null', us.verify(forge('founder', '-', nowS + 7200 + 3600), { now }) === null && us.verify(forge('founder', '-', nowS + 7200), { now }) !== null);
  check('correctly signed but exp beyond wallet max (30 min) -> null', us.verify(forge('wallet', addr, nowS + 1800 + 3600), { now }) === null && us.verify(forge('wallet', addr, nowS + 1800), { now }) !== null);

  process.env.SYNCNET_SESSION_EPOCH = '2';
  const revoked = us.verify(tok, { now }) === null;
  const newEpochTok = us.issue({ scope: 'founder', now });
  const newOk = us.verify(newEpochTok, { now }) !== null;
  delete process.env.SYNCNET_SESSION_EPOCH;
  check('epoch bump revokes every earlier session', revoked && newOk);
  check('epoch back to default -> new-epoch tokens invalid, old ones valid again', us.verify(newEpochTok, { now }) === null && us.verify(tok, { now }) !== null);

  const flip = (s, i) => s.slice(0, i) + (s[i] === '0' ? '1' : '0') + s.slice(i + 1);
  check('tampered mac -> null', us.verify(flip(tok, tok.length - 1), { now }) === null);
  check('tampered sid -> null', us.verify(tok.replace(`.${p[4]}.`, `.${flip(p[4], 0)}.`), { now }) === null);
  check('tampered exp -> null', us.verify(tok.replace(`.${p[3]}.`, `.${Number(p[3]) - 1}.`), { now }) === null);
  check('malformed / old v1 / non-string -> null', us.verify(tok.slice(0, -2), { now }) === null && us.verify(`v1.${p[3]}.${'c'.repeat(64)}`, { now }) === null && us.verify(null) === null && us.verify(12345) === null);

  process.env.SYNCNET_UPLOAD_KEY = 'x'.repeat(31);
  const weakIssue = us.issue({ scope: 'founder', now });
  const weakVerify = us.verify(tok, { now });
  delete process.env.SYNCNET_UPLOAD_KEY;
  const missingIssue = us.issue({ scope: 'founder', now });
  process.env.SYNCNET_UPLOAD_KEY = UPLOAD_KEY;
  check('secret shorter than 32 chars: issue() -> "" and verify() -> null', weakIssue === '' && weakVerify === null);
  check('missing secret: issue() -> ""', missingIssue === '');
});

await section('upload-session.js: wallet challenges', async () => {
  const now = T0;
  const nowS = Math.floor(now / 1000);
  const W = '0x' + 'Cd'.repeat(20);
  const w = W.toLowerCase();
  const ch = us.issueChallenge(W, { now });
  const lines = ch.message.split('\n');
  check('issueChallenge(): exact human-readable format', lines.length === 6 && lines[0] === 'SyncNet upload session' && lines[1] === `Wallet: ${w}` && lines[2] === 'Purpose: image upload for a token launch' && lines[3] === `Expires: ${ch.exp}` && /^Nonce: [0-9a-f]{16}$/.test(lines[4]) && /^Check: [0-9a-f]{64}$/.test(lines[5]), ch.message);
  check('issueChallenge(): default ttl 600 s', ch.exp === nowS + 600);
  check('issueChallenge(): Check is an HMAC over the other lines', lines[5].slice(7) === hmacHex(UPLOAD_KEY, `syncnet-challenge|v1|1|${lines.slice(0, 5).join('\n')}`));
  const pc = us.parseChallenge(ch.message, { now });
  check('parseChallenge(): {address, exp, nonce}', pc && same(pc, { address: w, exp: ch.exp, nonce: lines[4].slice(7) }));
  const edit = (i, text) => lines.map((l, k) => (k === i ? text : l)).join('\n');
  check('tampered wallet -> null', us.parseChallenge(edit(1, `Wallet: 0x${'1'.repeat(40)}`), { now }) === null);
  check('tampered purpose -> null', us.parseChallenge(edit(2, 'Purpose: something else'), { now }) === null);
  check('tampered expiry -> null', us.parseChallenge(edit(3, `Expires: ${ch.exp + 60}`), { now }) === null);
  check('tampered nonce -> null', us.parseChallenge(edit(4, `Nonce: ${'0'.repeat(16)}`), { now }) === null);
  check('tampered check -> null', us.parseChallenge(edit(5, `Check: ${'0'.repeat(64)}`), { now }) === null);
  check('extra text / CRLF -> null', us.parseChallenge(ch.message + '\n', { now }) === null && us.parseChallenge(ch.message.replace(/\n/g, '\r\n'), { now }) === null);
  check('expired challenge -> null', us.parseChallenge(ch.message, { now: now + 601_000 }) === null && us.parseChallenge(ch.message, { now: now + 599_000 }) !== null);
  const custom = us.issueChallenge(W, { ttlSeconds: 60, origin: 'syncnet.example', now });
  check('custom origin/ttl', custom.message.startsWith('syncnet.example upload session\n') && custom.exp === nowS + 60 && us.parseChallenge(custom.message, { now }) !== null);
  check('origin with a newline refused (no line injection)', us.issueChallenge(W, { origin: `SyncNet\nWallet: 0x${'1'.repeat(40)}`, now }) === null);
  check('invalid address / ttl out of range -> null', us.issueChallenge('0x123', { now }) === null && us.issueChallenge(W, { ttlSeconds: 3601, now }) === null && us.issueChallenge(W, { ttlSeconds: 0, now }) === null);
  process.env.SYNCNET_SESSION_EPOCH = '9';
  const epochRevoked = us.parseChallenge(ch.message, { now }) === null;
  delete process.env.SYNCNET_SESSION_EPOCH;
  check('epoch bump revokes outstanding challenges', epochRevoked);
  process.env.SYNCNET_UPLOAD_KEY = 'short';
  const weak = us.issueChallenge(W, { now }) === null && us.parseChallenge(ch.message, { now }) === null;
  process.env.SYNCNET_UPLOAD_KEY = UPLOAD_KEY;
  check('weak secret: no challenges issued or accepted', weak);

  const sig = '0x' + '1b'.repeat(65);
  const seen = [];
  const recoverMatch = (m, s) => { seen.push([m, s]); return W; }; // checksum-cased on purpose
  check('verifyChallengeSignature(): matching recovered address -> lowercase address', us.verifyChallengeSignature(ch.message, sig, recoverMatch, { now }) === w);
  check('verifyChallengeSignature(): recoverFn receives the exact message and signature', seen.length === 1 && seen[0][0] === ch.message && seen[0][1] === sig);
  check('verifyChallengeSignature(): other address -> null', us.verifyChallengeSignature(ch.message, sig, () => '0x' + '9'.repeat(40), { now }) === null);
  check('verifyChallengeSignature(): recoverFn throws -> null', us.verifyChallengeSignature(ch.message, sig, () => { throw new Error('bad sig'); }, { now }) === null);
  let called = 0;
  const counting = () => { called += 1; return W; };
  check('verifyChallengeSignature(): tampered message rejected before recoverFn runs', us.verifyChallengeSignature(edit(1, `Wallet: 0x${'1'.repeat(40)}`), sig, counting, { now }) === null && called === 0);
  check('verifyChallengeSignature(): expired challenge -> null', us.verifyChallengeSignature(ch.message, sig, counting, { now: now + 601_000 }) === null && called === 0);
  check('verifyChallengeSignature(): malformed signature / missing recoverFn -> null', us.verifyChallengeSignature(ch.message, '0x1234', counting, { now }) === null && us.verifyChallengeSignature(ch.message, sig, null, { now }) === null && called === 0);
  const asyncResult = us.verifyChallengeSignature(ch.message, sig, async () => W.toUpperCase().replace('0X', '0x'), { now });
  check('verifyChallengeSignature(): async recoverFn -> Promise of the address', asyncResult instanceof Promise && (await asyncResult) === w);
});

// ================================================================== site-check.js
const PUBLIC4 = '93.184.216.34';
function fakeLookup(answers) {
  const calls = [];
  const fn = async (host, opts) => {
    calls.push({ host, opts });
    const a = typeof answers === 'function' ? answers(calls.length) : answers;
    if (a instanceof Error) throw a;
    return a;
  };
  fn.calls = calls;
  return fn;
}
function fakeHttps(behavior) {
  const state = { calls: 0, options: null, produced: 0, reqDestroyed: false, res: null };
  const request = (options, onResponse) => {
    state.calls += 1;
    state.options = options;
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = (err) => {
      if (req.destroyed) return req;
      req.destroyed = true;
      state.reqDestroyed = true;
      if (err) process.nextTick(() => req.emit('error', err));
      process.nextTick(() => req.emit('close'));
      return req;
    };
    req.end = () => {
      process.nextTick(() => behavior({ options, onResponse, req, state }));
      return req;
    };
    return req;
  };
  return { request, state };
}
function bodyResponse(status, text, headers = {}) {
  let sent = false;
  const res = new Readable({ read() { if (!sent) { sent = true; this.push(Buffer.from(text)); } else this.push(null); } });
  res.statusCode = status;
  res.headers = { 'content-type': 'application/json', ...headers };
  return res;
}
function countingResponse(state, { status = 200, chunk = 4096, total = 64 * 1024 * 1024, headers = {} } = {}) {
  const res = new Readable({
    read() {
      if (state.produced >= total) { this.push(null); return; }
      state.produced += chunk;
      this.push(Buffer.alloc(chunk, 0x20));
    },
  });
  res.statusCode = status;
  res.headers = { 'content-type': 'application/json', ...headers };
  state.res = res;
  return res;
}
const serveJson = (obj, status = 200, headers) => ({ onResponse }) => onResponse(bodyResponse(status, JSON.stringify(obj), headers));
async function runSite(url, { lookup, https, store, ip, now, deadlineMs, dnsTimeoutMs, method } = {}) {
  return siteCheck._handler(
    { httpMethod: method || 'GET', headers: { 'x-nf-client-connection-ip': ip || nextIp() }, queryStringParameters: url === undefined ? {} : { url } },
    { lookup: lookup || fakeLookup([{ address: PUBLIC4, family: 4 }]), request: https ? https.request : fakeHttps(serveJson({})).request, store: store || memStore(), now, deadlineMs, dnsTimeoutMs },
  );
}

await section('site-check.js: happy path, request options, sanitising', async () => {
  const lk = fakeLookup([{ address: PUBLIC4, family: 4 }]);
  const h = fakeHttps(serveJson({
    schema: 'syncnet.site.v1\u202e', project: '  My\u200b Project\u0007 ' + 'x'.repeat(100), symbol: 'SY\u202eNC\u2066', chainId: 4663,
    token: '0x' + 'AB'.repeat(20), extra: '<script>alert(1)</script>', declaration: { evil: true },
  }));
  const r = await runSite('https://Example.COM.:443/some/path?q=1', { lookup: lk, https: h });
  const b = body(r);
  check('200 found:true for a public host', r.statusCode === 200 && b.found === true);
  check('origin normalised (lowercase, no trailing dot, path ignored)', b.origin === 'https://example.com');
  check('response shape {found, origin, declaration{schema,project,symbol,chainId,token}} only', same(Object.keys(b).sort(), ['declaration', 'found', 'origin']) && same(Object.keys(b.declaration).sort(), ['chainId', 'project', 'schema', 'symbol', 'token']));
  check('declaration fields sanitised', b.declaration.schema === 'syncnet.site.v1' && b.declaration.project === ('My Project ' + 'x'.repeat(100)).slice(0, 60) && b.declaration.symbol === 'SYNC' && b.declaration.chainId === 4663 && b.declaration.token === '0x' + 'ab'.repeat(20), JSON.stringify(b.declaration));
  check('no bidi/zero-width characters and no markup in the response', !BIDI_ZW.test(r.body) && !r.body.includes('<script'));
  check('DNS resolved once, {all:true}, for the hostname', lk.calls.length === 1 && lk.calls[0].host === 'example.com' && lk.calls[0].opts && lk.calls[0].opts.all === true);
  const o = h.state.options;
  check('https.request: hostname + servername = host, port 443, GET /syncnet.json', o.hostname === 'example.com' && o.servername === 'example.com' && o.port === 443 && o.method === 'GET' && o.path === '/syncnet.json');
  check('https.request: pinned lookup, fresh socket, TLS verification on', typeof o.lookup === 'function' && o.agent === false && o.rejectUnauthorized === true);
  check('https.request: identity encoding requested', o.headers && o.headers['accept-encoding'] === 'identity');
  check('200 cache-control public, max-age=60 + security headers', hdr(r, 'cache-control') === 'public, max-age=60' && SECURITY_HEADERS(r));
  check('non-JSON-object declaration -> found with null fields', same(body(await runSite('https://arr.example.org', { https: fakeHttps(serveJson([1, 2])) })).declaration, { schema: null, project: null, symbol: null, chainId: null, token: null }));
  const bad = body(await runSite('https://bad.example.org', { https: fakeHttps(serveJson({ token: '0x1234', chainId: '4663', symbol: 7 })) })).declaration;
  check('invalid token / non-integer chainId / non-string symbol -> null', bad.token === null && bad.chainId === null && bad.symbol === null);
  check('constants: MAX = 16 KiB, deadline 5 s, 30/60 s rate limit', siteCheck._internals.MAX === 16384 && siteCheck._internals.DEADLINE_MS === 5000 && siteCheck._internals.RATE_LIMIT.limit === 30 && siteCheck._internals.RATE_LIMIT.windowSeconds === 60);
});

await section('site-check.js: DNS rebinding (connection pinned to the validated address)', async () => {
  const lk = fakeLookup((n) => (n === 1 ? [{ address: PUBLIC4, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]));
  const seen = {};
  const h = fakeHttps(({ options, onResponse }) => {
    options.lookup(options.hostname, {}, (err, address, family) => {
      seen.single = { err, address, family };
      options.lookup(options.hostname, { all: true }, (err2, list) => {
        seen.all = { err: err2, list };
        options.lookup(options.hostname, (err3, address3) => {
          seen.noOptions = { err: err3, address: address3 };
          options.lookup('attacker.example.net', {}, (err4) => {
            seen.other = err4;
            onResponse(bodyResponse(200, JSON.stringify({ token: '0x' + '1'.repeat(40) })));
          });
        });
      });
    });
  });
  const r = await runSite('https://rebind.example.org', { lookup: lk, https: h });
  check('dns lookup called exactly once', lk.calls.length === 1);
  check('pinned lookup returns the validated IP (single-address form)', seen.single && !seen.single.err && seen.single.address === PUBLIC4 && seen.single.family === 4);
  check('pinned lookup returns ONLY the validated IP ({all:true} form)', seen.all && !seen.all.err && same(seen.all.list, [{ address: PUBLIC4, family: 4 }]));
  check('pinned lookup works without an options argument', seen.noOptions && seen.noOptions.address === PUBLIC4);
  check('pinned lookup refuses any other hostname', seen.other instanceof Error);
  check('still exactly one DNS resolution after the connection lookups', lk.calls.length === 1);
  check('check completes against the pinned address', r.statusCode === 200 && body(r).found === true);

  const both = fakeHttps(({ options, onResponse }) => options.lookup(options.hostname, {}, (e, a, f) => { both.state.pinned = [a, f]; onResponse(bodyResponse(200, '{}')); }));
  await runSite('https://dual.example.org', { lookup: fakeLookup([{ address: '2606:4700:4700::1111', family: 6 }, { address: PUBLIC4, family: 4 }]), https: both });
  check('both families public -> IPv4 answer is the one pinned', same(both.state.pinned, [PUBLIC4, 4]));
});

const BLOCKED_ADDRESSES = [
  ['0.0.0.0', 4], ['0.255.255.255', 4], ['10.0.0.1', 4], ['10.255.255.255', 4], ['100.64.0.1', 4], ['100.127.255.254', 4],
  ['127.0.0.1', 4], ['127.255.255.254', 4], ['169.254.169.254', 4], ['169.254.0.1', 4], ['172.16.0.1', 4], ['172.31.255.255', 4],
  ['192.0.0.8', 4], ['192.0.0.255', 4], ['192.0.2.1', 4], ['192.88.99.1', 4], ['192.168.0.1', 4], ['192.168.255.255', 4],
  ['198.18.0.1', 4], ['198.19.255.255', 4], ['198.51.100.7', 4], ['203.0.113.9', 4], ['224.0.0.251', 4], ['239.255.255.250', 4],
  ['240.0.0.1', 4], ['254.1.2.3', 4], ['255.255.255.255', 4],
  ['::', 6], ['::1', 6], ['0:0:0:0:0:0:0:1', 6],
  ['::ffff:127.0.0.1', 6], ['::ffff:7f00:1', 6], ['::ffff:10.0.0.1', 6], ['::ffff:169.254.169.254', 6], ['::ffff:192.168.1.1', 6], ['::ffff:100.64.0.1', 6], ['::FFFF:0:1', 6],
  ['::127.0.0.1', 6], ['::8.8.8.8', 6], ['::a00:1', 6], ['::2', 6],
  ['64:ff9b::7f00:1', 6], ['64:ff9b::8.8.8.8', 6], ['64:ff9b::a9fe:a9fe', 6], ['64:ff9b:1::1', 6], ['64:ff9b:1:ffff::1', 6],
  ['100::1', 6], ['100::ffff:ffff:ffff:ffff', 6],
  ['2001::1', 6], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 6], ['2001:2::1', 6], ['2001:2:0:ffff::1', 6],
  ['2001:10::1', 6], ['2001:1f::1', 6], ['2001:20::1', 6], ['2001:2f:ffff::1', 6],
  ['2001:db8::1', 6], ['2001:db8:85a3::8a2e:370:7334', 6],
  ['2002::1', 6], ['2002:7f00:1::1', 6], ['2002:c0a8:101::1', 6],
  ['fc00::1', 6], ['fd12:3456:789a::1', 6], ['fe80::1', 6], ['febf:ffff::1', 6], ['fe80::1%eth0', 6],
  ['fec0::1', 6], ['feff::1', 6], ['ff02::1', 6], ['ff05::1:3', 6],
  ['1::1', 6], ['4000::1', 6], ['3fff::1', 6], ['5f00::1', 6], ['e000::1', 6],
  ['not-an-ip', 4], ['1.2.3', 4], ['::g', 6], ['1::2::3', 6], ['', 4],
];
const PUBLIC_ADDRESSES = [
  [PUBLIC4, 4], ['8.8.8.8', 4], ['1.1.1.1', 4], ['11.0.0.1', 4], ['100.63.255.255', 4], ['100.128.0.0', 4], ['172.15.255.255', 4], ['172.32.0.0', 4],
  ['192.0.1.1', 4], ['192.88.98.1', 4], ['192.169.0.1', 4], ['198.17.255.255', 4], ['198.20.0.1', 4], ['223.255.255.254', 4],
  ['2606:4700:4700::1111', 6], ['2001:4860:4860::8888', 6], ['2a00:1450:4001:82b::200e', 6], ['2001:200::1', 6], ['2003::1', 6], ['3fff:1000::1', 6],
  ['::ffff:93.184.216.34', 6, PUBLIC4, 4], ['::ffff:5db8:d822', 6, PUBLIC4, 4],
];

await section('site-check.js: every non-public range is rejected before connecting', async () => {
  for (const [address, family] of BLOCKED_ADDRESSES) {
    const h = fakeHttps(serveJson({ token: '0x' + '1'.repeat(40) }));
    const r = await runSite('https://blocked.example.org', { lookup: fakeLookup([{ address, family }]), https: h });
    const ok = r.statusCode === 400 && body(r).code === 'non_public_address' && h.state.calls === 0;
    check(`blocked ${address || '(empty)'}`, ok, `status ${r.statusCode} ${r.body} request calls ${h.state.calls}`);
  }
  check('privateIp() agrees for every blocked sample', BLOCKED_ADDRESSES.every(([a]) => siteCheck._internals.privateIp(a) === true));
});

await section('site-check.js: public addresses are allowed and pinned', async () => {
  for (const [address, family, pinnedAddress = address, pinnedFamily = family] of PUBLIC_ADDRESSES) {
    const h = fakeHttps(({ options, onResponse }) => options.lookup(options.hostname, {}, (e, a, f) => { h.state.pinned = [a, f]; onResponse(bodyResponse(200, '{}')); }));
    const r = await runSite('https://public.example.org', { lookup: fakeLookup([{ address, family }]), https: h });
    check(`allowed ${address} (pinned ${pinnedAddress})`, r.statusCode === 200 && body(r).found === true && h.state.calls === 1 && same(h.state.pinned, [pinnedAddress, pinnedFamily]), `${r.statusCode} ${JSON.stringify(h.state.pinned)}`);
  }
});

await section('site-check.js: mixed / malformed DNS answers', async () => {
  const cases = [
    ['public + private IPv4', [{ address: PUBLIC4, family: 4 }, { address: '10.0.0.5', family: 4 }]],
    ['private first, then public', [{ address: '169.254.169.254', family: 4 }, { address: PUBLIC4, family: 4 }]],
    ['public IPv6 + loopback IPv6', [{ address: '2606:4700:4700::1111', family: 6 }, { address: '::1', family: 6 }]],
    ['public IPv4 + mapped loopback', [{ address: PUBLIC4, family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }]],
    ['empty answer', []],
    ['malformed answer entry', [{ address: PUBLIC4, family: 4 }, { nope: true }]],
    ['non-array answer', { address: PUBLIC4 }],
  ];
  for (const [label, answers] of cases) {
    const h = fakeHttps(serveJson({}));
    const r = await runSite('https://mixed.example.org', { lookup: fakeLookup(answers), https: h });
    check(`rejected: ${label}`, r.statusCode === 400 && h.state.calls === 0, `${r.statusCode} ${h.state.calls}`);
  }
});

await section('site-check.js: URL rules', async () => {
  const rejected = [
    'http://example.com', 'https://example.com:8443', 'https://user:pass@example.com', 'https://user@example.com',
    'https://127.0.0.1', 'https://8.8.8.8', 'https://[::1]', 'https://[2606:4700:4700::1111]', 'https://0x7f.1', 'https://2130706433', 'https://127.1',
    'https://localhost', 'https://localhost.', 'https://app.localhost', 'https://app.localhost.', 'https://printer.local', 'https://printer.local.',
    'https://db.internal', 'https://db.internal.', 'https://nas.lan', 'https://nas.lan.', 'https://router.home', 'https://router.home.',
    'https://dc.corp', 'https://dc.corp.', 'https://intranet', 'https://nodots.', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd',
    '', 'not a url', 'https://exa mple.com', 'https://-bad-.example.org', 'https://a..b.example.org', 'https://' + 'a'.repeat(64) + '.example.org',
  ];
  for (const url of rejected) {
    const lk = fakeLookup([{ address: PUBLIC4, family: 4 }]);
    const h = fakeHttps(serveJson({}));
    const r = await runSite(url, { lookup: lk, https: h });
    check(`rejected URL ${JSON.stringify(url).slice(0, 60)}`, r.statusCode === 400 && lk.calls.length === 0 && h.state.calls === 0 && typeof body(r).error === 'string', `${r.statusCode} ${r.body}`);
  }
  const missing = await runSite(undefined);
  check('missing url parameter -> 400', missing.statusCode === 400);
  const lk = fakeLookup([{ address: PUBLIC4, family: 4 }]);
  const ok = await runSite('https://www.Example.org:443', { lookup: lk });
  check('explicit :443 and mixed case are accepted', ok.statusCode === 200 && body(ok).origin === 'https://www.example.org' && lk.calls[0].host === 'www.example.org');
  const idn = fakeLookup([{ address: PUBLIC4, family: 4 }]);
  const r2 = await runSite('https://b\u00fccher.example.org', { lookup: idn });
  check('IDN hosts are looked up in punycode', r2.statusCode === 200 && idn.calls[0].host === 'xn--bcher-kva.example.org');
});

await section('site-check.js: redirects, status codes, body handling', async () => {
  const redirState = { produced: 0 };
  const redir = fakeHttps(({ onResponse }) => onResponse(countingResponse(redirState, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })));
  const r = await runSite('https://redirect.example.org', { https: redir });
  check('3xx -> {found:false, reason:"redirect"}', r.statusCode === 200 && same(body(r), { found: false, origin: 'https://redirect.example.org', reason: 'redirect' }));
  check('3xx: not followed, body never read', redir.state.calls === 1 && redirState.produced === 0);
  const r404 = await runSite('https://missing.example.org', { https: fakeHttps(serveJson({ x: 1 }, 404)) });
  check('404 -> reason http-404', body(r404).found === false && body(r404).reason === 'http-404');
  const html = await runSite('https://html.example.org', { https: fakeHttps(({ onResponse }) => onResponse(bodyResponse(200, '<!doctype html><title>hi</title>', { 'content-type': 'text/html' }))) });
  check('non-JSON body -> reason not-json', body(html).reason === 'not-json' && !html.body.includes('<title'));
  const gz = await runSite('https://gzip.example.org', { https: fakeHttps(({ onResponse }) => onResponse(bodyResponse(200, '\u001f\u008b', { 'content-encoding': 'gzip' }))) });
  check('compressed body (identity was requested) -> not-json', body(gz).reason === 'not-json');
  const bom = await runSite('https://bom.example.org', { https: fakeHttps(({ onResponse }) => onResponse(bodyResponse(200, '\ufeff{"schema":"s"}'))) });
  check('UTF-8 BOM tolerated', body(bom).found === true && body(bom).declaration.schema === 's');
});

await section('site-check.js: 16 KiB streaming cap', async () => {
  const state = { produced: 0 };
  const h = fakeHttps(({ onResponse }) => onResponse(countingResponse(state, { total: 64 * 1024 * 1024 })));
  const r = await runSite('https://huge.example.org', { https: h });
  check('64 MiB body -> {found:false, reason:"too-large"}', r.statusCode === 200 && body(r).found === false && body(r).reason === 'too-large');
  check('stopped reading early (< 1 MiB of the 64 MiB consumed)', state.produced > 16 * 1024 && state.produced < 1024 * 1024, `${state.produced} bytes`);
  check('response and request destroyed after the cap', state.res.destroyed === true && h.state.reqDestroyed === true);
  const declared = { produced: 0 };
  const r2 = await runSite('https://declared.example.org', { https: fakeHttps(({ onResponse }) => onResponse(countingResponse(declared, { headers: { 'content-length': String(64 * 1024 * 1024) } }))) });
  check('content-length above 16 KiB -> too-large without reading the body', body(r2).reason === 'too-large' && declared.produced === 0);
  const exact = JSON.stringify({ schema: 's', pad: '' });
  const fill = 'x'.repeat(16 * 1024 - exact.length);
  const atCap = await runSite('https://exact.example.org', { https: fakeHttps(serveJson({ schema: 's', pad: fill })) });
  const overCap = await runSite('https://over.example.org', { https: fakeHttps(serveJson({ schema: 's', pad: fill + 'x' })) });
  check('exactly 16 KiB accepted, 16 KiB + 1 byte rejected', body(atCap).found === true && body(overCap).reason === 'too-large');
});

await section('site-check.js: deadline and generic errors', async () => {
  let t0 = Date.now();
  const hang = fakeHttps(() => {});
  const r = await runSite('https://hang.example.org', { https: hang, deadlineMs: 120 });
  const took = Date.now() - t0;
  check('no response before the deadline -> reason timeout', same(body(r), { found: false, origin: 'https://hang.example.org', reason: 'timeout' }) && took >= 100 && took < 2000, `${took} ms`);
  check('timeout: request destroyed, not cacheable', hang.state.reqDestroyed === true && hdr(r, 'cache-control') === 'no-store');
  const drip = { produced: 0 };
  const dripHttps = fakeHttps(({ onResponse }) => {
    const res = new Readable({ read() { setTimeout(() => { if (!res.destroyed) { drip.produced += 1; res.push(Buffer.from(' ')); } }, 15); } });
    res.statusCode = 200;
    res.headers = {};
    onResponse(res);
  });
  t0 = Date.now();
  const r2 = await runSite('https://drip.example.org', { https: dripHttps, deadlineMs: 150 });
  check('slow-drip body: deadline covers the body too -> timeout', body(r2).reason === 'timeout' && Date.now() - t0 < 2000 && drip.produced > 0);

  const n = logs.length;
  const err = fakeHttps(({ req }) => req.emit('error', Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443 SECRET-DETAIL'), { code: 'ECONNREFUSED' })));
  const r3 = await runSite('https://refused.example.org', { https: err });
  check('connection error -> {found:false, reason:"unreachable"}', same(body(r3), { found: false, origin: 'https://refused.example.org', reason: 'unreachable' }));
  check('connection error: no exception text in the response', !/ECONNREFUSED|SECRET/.test(r3.body));
  check('connection error: details logged server side', logs.slice(n).some((l) => l.includes('fetch-failed') && l.includes('SECRET-DETAIL')));
  const r4 = await runSite('https://nx.example.org', { lookup: fakeLookup(Object.assign(new Error('getaddrinfo ENOTFOUND nx.example.org SECRET-DNS'), { code: 'ENOTFOUND' })) });
  check('DNS failure -> 404 generic', r4.statusCode === 404 && same(body(r4), { error: 'Domain not found.', code: 'not_found' }));
  t0 = Date.now();
  const r5 = await runSite('https://slowdns.example.org', { lookup: () => new Promise(() => {}), dnsTimeoutMs: 60 });
  check('DNS timeout -> found:false timeout', body(r5).reason === 'timeout' && Date.now() - t0 < 2000);
  const r6 = await runSite('https://throws.example.org', { https: { request: () => { throw new Error('boom SECRET'); } } });
  check('synchronous request() failure -> unreachable, generic', body(r6).reason === 'unreachable' && !r6.body.includes('SECRET'));
});

await section('site-check.js: rate limit, method, store failure', async () => {
  const c = clock(T0);
  const store = memStore(c);
  const ip = nextIp();
  const codes = [];
  for (let i = 0; i < 30; i += 1) codes.push((await runSite('https://localhost', { ip, store, now: c })).statusCode);
  const r31 = await runSite('https://example.org', { ip, store, now: c });
  check('30 requests per minute per IP pass the limiter (even invalid ones count)', codes.every((s) => s === 400));
  check('31st request -> 429 with retry-after', r31.statusCode === 429 && Number(hdr(r31, 'retry-after')) > 0 && Number(hdr(r31, 'retry-after')) <= 60 && body(r31).code === 'rate_limited');
  check('other IPs are not affected', (await runSite('https://example.org', { store, now: c })).statusCode === 200);
  c.advance(60_000);
  check('next minute -> allowed again', (await runSite('https://example.org', { ip, store, now: c })).statusCode === 200);
  const down = { incrWindow: async () => { throw new StoreUnavailable('down'); } };
  const h = fakeHttps(serveJson({}));
  const rd = await runSite('https://example.org', { store: down, https: h });
  check('store unavailable -> 429 (fail closed), no outbound request', rd.statusCode === 429 && h.state.calls === 0);
  const post = await runSite('https://example.org', { method: 'POST' });
  check('POST -> 405 with allow: GET', post.statusCode === 405 && hdr(post, 'allow') === 'GET');
  const viaExport = await siteCheck.handler({ httpMethod: 'DELETE', headers: {} });
  check('exports.handler wired (405 for DELETE)', viaExport.statusCode === 405);
});

await section('site-check.js: parseIPv6', async () => {
  const p = siteCheck._internals.parseIPv6;
  check('"::" -> all zero', same(p('::'), [0, 0, 0, 0, 0, 0, 0, 0]));
  check('"1::" and "::1"', same(p('1::'), [1, 0, 0, 0, 0, 0, 0, 0]) && same(p('::1'), [0, 0, 0, 0, 0, 0, 0, 1]));
  check('full form', same(p('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]));
  check('middle compression', same(p('2001:db8::8a2e:370:7334'), [0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]));
  check('embedded IPv4 (mapped, compatible, full)', same(p('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]) && same(p('::1.2.3.4'), [0, 0, 0, 0, 0, 0, 0x102, 0x304]) && same(p('1:2:3:4:5:6:1.2.3.4'), [1, 2, 3, 4, 5, 6, 0x102, 0x304]));
  check('brackets and upper case', same(p('[FE80::1]'), [0xfe80, 0, 0, 0, 0, 0, 0, 1]));
  const invalid = ['1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', ':1::', '1::2::3', '12345::', '::1.2.3.256', '1.2.3.4', ':::', '1:2:3:4:5:6:7:', 'g::', ''];
  check('invalid forms -> null', invalid.every((s) => p(s) === null), invalid.filter((s) => p(s) !== null).join(' '));
});

// ================================================================== par-launches-all.js
function fakePar({ total = 1234, delayMs = 2, countResponse, pageStatus = () => 200, pageBody, failAll = null, hang = false } = {}) {
  const state = { calls: 0, countCalls: 0, pageOffsets: [], inFlight: 0, maxInFlight: 0, urls: [], inits: [] };
  const rowsFor = (offset) => Array.from({ length: Math.max(0, Math.min(500, total - offset)) }, (_, i) => ({
    token: '0x' + (offset + i + 1).toString(16).padStart(40, '0'), symbol: `T${offset + i}`, name: `Token ${offset + i}`, createdAt: new Date(T0 - (offset + i) * 1000).toISOString(),
  }));
  const fetch = async (url, init) => {
    state.calls += 1;
    state.urls.push(url);
    state.inits.push(init);
    if (failAll) throw failAll;
    if (hang) return new Promise(() => {});
    const u = new URL(url);
    if (u.pathname === '/launches/count') {
      state.countCalls += 1;
      if (countResponse) return countResponse();
      return new Response(JSON.stringify({ launched: total }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === '/launches') {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await sleep(delayMs);
        const offset = Number(u.searchParams.get('offset'));
        state.pageOffsets.push(offset);
        const attempt = state.pageOffsets.filter((o) => o === offset).length;
        const status = pageStatus(offset, attempt);
        if (status !== 200) return new Response(JSON.stringify({ error: 'upstream says no' }), { status, headers: { 'retry-after': '0' } });
        const payload = pageBody ? pageBody(offset, rowsFor(offset)) : rowsFor(offset);
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
      } finally {
        state.inFlight -= 1;
      }
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch, state };
}
const launchesEvent = (ip, over = {}) => ({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': ip || nextIp() }, queryStringParameters: {}, ...over });
const runLaunches = (deps, event) => launchesFn._handler(event || launchesEvent(), { sleep: async () => {}, ...deps });
const sortNum = (a) => [...a].sort((x, y) => x - y);

await section('par-launches-all.js: cache, headers, canonical URL', async () => {
  launchesFn._resetCache();
  const c = clock(T0);
  const store = memStore(c);
  const up = fakePar({ total: 1234 });
  const r1 = await runLaunches({ fetch: up.fetch, now: c, store });
  const b1 = body(r1);
  check('200 with the full history', r1.statusCode === 200 && b1.count === 1234 && b1.indexed === 1234 && b1.launches.length === 1234);
  check('shape {count, indexed, launches, fetchedAt, stale, degraded}', same(Object.keys(b1).sort(), ['count', 'degraded', 'fetchedAt', 'indexed', 'launches', 'stale']) && b1.stale === false && b1.degraded === false && b1.fetchedAt === new Date(T0).toISOString());
  check('upstream: 1 count request + 3 pages', up.state.countCalls === 1 && same(sortNum(up.state.pageOffsets), [0, 500, 1000]));
  check('upstream URLs', up.state.urls[0] === 'https://api.par.family/launches/count' && up.state.urls.includes('https://api.par.family/launches?orderBy=createdAt&orderDirection=desc&limit=500&offset=1000'));
  check('upstream redirects not followed', up.state.inits.every((i) => i.redirect === 'manual'));
  check('cache headers: public, max-age=30 + CDN s-maxage=120, stale-while-revalidate=600', hdr(r1, 'cache-control') === 'public, max-age=30' && hdr(r1, 'netlify-cdn-cache-control') === 'public, s-maxage=120, stale-while-revalidate=600');
  check('JSON + nosniff + CSP', SECURITY_HEADERS(r1));
  c.advance(119_000);
  const before = up.state.calls;
  const r2 = await runLaunches({ fetch: up.fetch, now: c, store });
  check('second call within 120 s -> 0 upstream requests', up.state.calls === before && r2.statusCode === 200 && body(r2).indexed === 1234 && body(r2).stale === false);
  const q = [
    launchesEvent(undefined, { queryStringParameters: { nocache: '1' }, rawQuery: 'nocache=1' }),
    launchesEvent(undefined, { queryStringParameters: {}, rawQuery: 'x=1' }),
    launchesEvent(undefined, { queryStringParameters: null, multiValueQueryStringParameters: { a: ['1'] } }),
    launchesEvent(undefined, { rawUrl: 'https://syncnet.example/api/par-launches-all?bust=2' }),
  ];
  launchesFn._resetCache(); // even with an empty cache a query string must not reach PAR
  const upq = fakePar();
  const rs = [];
  for (const e of q) rs.push(await runLaunches({ fetch: upq.fetch, now: c, store }, e));
  check('query string -> 301 to /api/par-launches-all', rs.every((r) => r.statusCode === 301 && hdr(r, 'location') === '/api/par-launches-all'));
  check('301 is cacheable', rs.every((r) => /public/.test(hdr(r, 'cache-control')) && /s-maxage=\d+/.test(hdr(r, 'netlify-cdn-cache-control'))));
  check('301 makes no upstream calls', upq.state.calls === 0);
  check('no query string -> no redirect', (await runLaunches({ fetch: upq.fetch, now: c, store }, launchesEvent(undefined, { queryStringParameters: {}, rawQuery: '' }))).statusCode === 200);
  const viaExport = await launchesFn.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': nextIp() }, queryStringParameters: { x: '1' } });
  check('exports.handler wired (301 for a query string, default store, no network)', viaExport.statusCode === 301);
  check('POST -> 405', (await runLaunches({ fetch: upq.fetch, now: c, store }, launchesEvent(undefined, { httpMethod: 'POST' }))).statusCode === 405);
});

await section('par-launches-all.js: single flight and concurrency', async () => {
  launchesFn._resetCache();
  const c = clock(T0);
  const up = fakePar({ total: 1234, delayMs: 15 });
  const rs = await Promise.all(Array.from({ length: 6 }, () => runLaunches({ fetch: up.fetch, now: c, store: memStore(c) })));
  check('6 concurrent invocations share one refresh (1 count + 3 pages)', up.state.countCalls === 1 && up.state.pageOffsets.length === 3, `${up.state.countCalls} / ${up.state.pageOffsets.length}`);
  check('every concurrent caller gets the data', rs.every((r) => r.statusCode === 200 && body(r).indexed === 1234));
  launchesFn._resetCache();
  const up2 = fakePar({ total: 5000, delayMs: 10 });
  const r = await runLaunches({ fetch: up2.fetch, now: c, store: memStore(c) });
  check('5000 launches -> 10 pages', same(sortNum(up2.state.pageOffsets), [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500]) && body(r).indexed === 5000);
  check('at most 3 page requests in flight', up2.state.maxInFlight <= 3, String(up2.state.maxInFlight));
  check('pages really are fetched 3 at a time', up2.state.maxInFlight === 3, String(up2.state.maxInFlight));
  launchesFn._resetCache();
  const up3 = fakePar({ total: 7000 });
  const r3 = await runLaunches({ fetch: up3.fetch, now: c, store: memStore(c) });
  check('count above 5000 -> capped at 10 pages / 5000 launches, count reported as is', body(r3).count === 7000 && body(r3).indexed === 5000 && up3.state.pageOffsets.length === 10 && Math.max(...up3.state.pageOffsets) === 4500);
  launchesFn._resetCache();
  const up4 = fakePar({ total: 1200, countResponse: () => new Response('oops', { status: 500 }) });
  const r4 = await runLaunches({ fetch: up4.fetch, now: c, store: memStore(c) });
  const walked = sortNum(up4.state.pageOffsets);
  check('count unavailable -> history walked until the first short page', r4.statusCode === 200 && body(r4).indexed === 1200 && body(r4).count === 1200 && same(walked.slice(0, 3), [0, 500, 1000]), JSON.stringify(walked));
  check('count unavailable -> at most 2 speculative pages past the end (pool of 3), none repeated', Math.max(...walked) <= 2000 && new Set(walked).size === walked.length, JSON.stringify(walked));
  launchesFn._resetCache();
  const up5 = fakePar({ total: 600, pageBody: (offset, rows) => (offset === 500 ? [...rows.slice(0, 50), ...rows.slice(0, 50).map((x, i) => ({ ...x, token: '0x' + (i + 1).toString(16).padStart(40, '0').toUpperCase() }))] : rows) });
  const r5 = await runLaunches({ fetch: up5.fetch, now: c, store: memStore(c) });
  check('duplicate token addresses (any case) are removed', body(r5).indexed === 550);
});

await section('par-launches-all.js: retries, stale, degraded, 503', async () => {
  launchesFn._resetCache();
  const c = clock(T0);
  const sleeps = [];
  const up = fakePar({ total: 1234, pageStatus: (offset, attempt) => ((offset === 500 || offset === 1000) && attempt === 1 ? (offset === 500 ? 503 : 429) : 200) });
  const r = await runLaunches({ fetch: up.fetch, now: c, store: memStore(c), sleep: async (ms) => { sleeps.push(ms); } });
  check('503 and 429 pages retried once and succeed', r.statusCode === 200 && body(r).indexed === 1234 && up.state.pageOffsets.filter((o) => o === 500).length === 2 && up.state.pageOffsets.filter((o) => o === 1000).length === 2);
  check('backoff between attempts', sleeps.length === 2);
  launchesFn._resetCache();
  const up2 = fakePar({ total: 1234, pageStatus: (offset) => (offset === 500 ? 503 : 200) });
  const r2 = await runLaunches({ fetch: up2.fetch, now: c, store: memStore(c) });
  check('only one retry (2 attempts), then the refresh fails', up2.state.pageOffsets.filter((o) => o === 500).length === 2 && r2.statusCode === 503);
  launchesFn._resetCache();
  const up3 = fakePar({ total: 1234, pageStatus: (offset) => (offset === 500 ? 404 : 200) });
  const r3 = await runLaunches({ fetch: up3.fetch, now: c, store: memStore(c) });
  check('4xx (other than 429) is not retried', up3.state.pageOffsets.filter((o) => o === 500).length === 1 && r3.statusCode === 503);
  launchesFn._resetCache();
  const up4 = fakePar({ total: 10, pageBody: () => ({ unexpected: true }) });
  check('unexpected payload shape -> failed refresh, not an empty history', (await runLaunches({ fetch: up4.fetch, now: c, store: memStore(c) })).statusCode === 503);

  launchesFn._resetCache();
  const cs = clock(T0);
  const good = fakePar({ total: 800 });
  await runLaunches({ fetch: good.fetch, now: cs, store: memStore(cs) });
  cs.advance(121_000);
  const failing = fakePar({ failAll: Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.par.family SECRET') }) });
  const n = logs.length;
  const s1 = await runLaunches({ fetch: failing.fetch, now: cs, store: memStore(cs) });
  const sb = body(s1);
  check('upstream failure after a success -> 200 stale:true, degraded:true, last good data', s1.statusCode === 200 && sb.stale === true && sb.degraded === true && sb.indexed === 800 && sb.fetchedAt === new Date(T0).toISOString());
  check('stale answer carries no exception text; failure logged server side', !/ENOTFOUND|SECRET|fetch failed/.test(s1.body) && logs.slice(n).some((l) => l.includes('refresh-failed') && l.includes('ENOTFOUND')));
  const callsAfterFailure = failing.state.calls;
  cs.advance(5_000);
  const s2 = await runLaunches({ fetch: failing.fetch, now: cs, store: memStore(cs) });
  check('within 15 s of a failed refresh PAR is not called again (stale served)', failing.state.calls === callsAfterFailure && body(s2).stale === true);
  cs.advance(3_600_000);
  const s3 = await runLaunches({ fetch: failing.fetch, now: cs, store: memStore(cs) });
  check('no successful refresh for more than 1 h -> 503', s3.statusCode === 503);

  launchesFn._resetCache();
  const bad = fakePar({ failAll: new Error('connect ECONNREFUSED 104.18.0.1:443 SECRET-DETAIL') });
  const r5 = await runLaunches({ fetch: bad.fetch, now: c, store: memStore(c) });
  check('no data at all -> 503', r5.statusCode === 503);
  check('503 body is exactly the generic message', same(body(r5), { error: 'PAR launch history is temporarily unavailable.', degraded: true }));
  check('503: no exception text, not cacheable', !/ECONNREFUSED|SECRET|Error/.test(r5.body) && hdr(r5, 'cache-control') === 'no-store' && SECURITY_HEADERS(r5));

  launchesFn._resetCache();
  let t0 = Date.now();
  const hang = fakePar({ hang: true });
  const r6 = await runLaunches({ fetch: hang.fetch, now: c, store: memStore(c), timeoutMs: 40 });
  check('hanging upstream is abandoned by the per-request timeout -> 503', r6.statusCode === 503 && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
  check('default per-request timeout is 12 s, concurrency 3, TTL 120 s / stale 1 h', launchesFn._internals.REQUEST_TIMEOUT_MS === 12000 && launchesFn._internals.PAGE_CONCURRENCY === 3 && launchesFn._internals.FRESH_MS === 120000 && launchesFn._internals.STALE_MS === 3600000);

  launchesFn._resetCache();
  const cb = clock(T0);
  await runLaunches({ fetch: fakePar({ total: 10 }).fetch, now: cb, store: memStore(cb) });
  cb.advance(121_000);
  t0 = Date.now();
  const slow = await runLaunches({ fetch: fakePar({ hang: true }).fetch, now: cb, store: memStore(cb), budgetMs: 60, timeoutMs: 300 });
  check('slow refresh with a stale copy -> degraded answer within the response budget', slow.statusCode === 200 && body(slow).stale === true && Date.now() - t0 < 1000);

  launchesFn._resetCache();
  const cn = clock(T0);
  const slowUp = fakePar({ total: 1234, delayMs: 150 });
  t0 = Date.now();
  const cold = await runLaunches({ fetch: slowUp.fetch, now: cn, store: memStore(cn), budgetMs: 50 });
  const coldMs = Date.now() - t0;
  check('slow refresh without any data -> generic 503 within the budget', cold.statusCode === 503 && same(body(cold), { error: 'PAR launch history is temporarily unavailable.', degraded: true }) && coldMs < 1000, `${cold.statusCode} ${coldMs} ms`);
  const joined = await runLaunches({ fetch: slowUp.fetch, now: cn, store: memStore(cn), budgetMs: 5000 });
  check('the next request joins the refresh still in flight (no second upstream walk)', joined.statusCode === 200 && body(joined).indexed === 1234 && slowUp.state.countCalls === 1 && slowUp.state.pageOffsets.length === 3);
  check('default response budget stays under the 10 s Netlify limit', launchesFn._internals.RESPONSE_BUDGET_MS > 0 && launchesFn._internals.RESPONSE_BUDGET_MS < 10000);
  launchesFn._resetCache();
});

await section('par-launches-all.js: rate limit', async () => {
  launchesFn._resetCache();
  const c = clock(T0);
  const store = memStore(c);
  const up = fakePar({ total: 10 });
  const ip = nextIp();
  let allOk = true;
  for (let i = 0; i < 60; i += 1) if ((await runLaunches({ fetch: up.fetch, now: c, store }, launchesEvent(ip))).statusCode !== 200) allOk = false;
  const r61 = await runLaunches({ fetch: up.fetch, now: c, store }, launchesEvent(ip));
  check('60 requests per minute per IP allowed', allOk);
  check('61st -> 429 with retry-after', r61.statusCode === 429 && Number(hdr(r61, 'retry-after')) > 0);
  check('other IPs unaffected', (await runLaunches({ fetch: up.fetch, now: c, store })).statusCode === 200);
  check('62 requests -> one upstream refresh', up.state.countCalls === 1);
  launchesFn._resetCache();
});

// ================================================================== par-tokenlist.js
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const GOOD_LIST = {
  name: 'PAR\u202e List', timestamp: '2026-09-20T10:00:00Z', version: { major: 1 }, keywords: ['x'], logoURI: 'https://par.family/logo.png', extra: '<script>',
  tokens: [
    { chainId: 4663, address: '0x' + 'AA'.repeat(20), symbol: 'SYNC', name: 'SyncNet', decimals: 18, logoURI: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', extensions: { evil: '<script>' }, tags: ['x'] },
    { chainId: 4663, address: '0x' + 'BB'.repeat(20), symbol: '\u202eCAT\u200b', name: 'Cat \u2066Coin\u2069', decimals: 6, logoURI: 'javascript:alert(1)' },
    { chainId: 4663, address: '0x' + 'CC'.repeat(20), symbol: 'USDG', name: 'Global Dollar', decimals: 6, logoURI: 'https://cdn.example.org/usdg.png?x=<y>' },
    { chainId: '4663', address: A(1), symbol: 'STR', name: 'string chainId', decimals: 18 },
    { chainId: 1, address: A(2), symbol: 'ETH1', name: 'other chain', decimals: 18 },
    { chainId: 4663.5, address: A(15), symbol: 'FRAC', name: 'fractional chainId', decimals: 18 },
    { chainId: 4663, address: '0x123', symbol: 'SHORT', name: 'bad address', decimals: 18 },
    { chainId: 4663, address: A(3), symbol: 'X'.repeat(33), name: 'long symbol', decimals: 18 },
    { chainId: 4663, address: A(4), symbol: '\u200b\u202e\u2066\u0000', name: 'invisible symbol', decimals: 18 },
    { chainId: 4663, address: A(5), symbol: 'LONGNAME', name: 'n'.repeat(97), decimals: 18 },
    { chainId: 4663, address: A(6), symbol: 'DEC37', name: 'decimals 37', decimals: 37 },
    { chainId: 4663, address: A(7), symbol: 'DECNEG', name: 'decimals -1', decimals: -1 },
    { chainId: 4663, address: A(8), symbol: 'DECSTR', name: 'decimals string', decimals: '18' },
    { chainId: 4663, address: A(9), symbol: 'DECFRAC', name: 'decimals 1.5', decimals: 1.5 },
    { chainId: 4663, address: A(10), symbol: 42, name: 'numeric symbol', decimals: 18 },
    { chainId: 4663, address: A(11), symbol: 'NONAME', decimals: 18 },
    null, 'string entry', [1, 2],
    { chainId: 4663, address: '0x' + 'aa'.repeat(20), symbol: 'DUP', name: 'duplicate address', decimals: 18 },
    { chainId: 4663, address: A(12), symbol: 'HTTP', name: 'http logo', decimals: 18, logoURI: 'http://insecure.example/logo.png' },
    { chainId: 4663, address: A(13), symbol: 'DATA', name: 'data logo', decimals: 0, logoURI: 'data:image/svg+xml,<svg onload=alert(1)>' },
    { chainId: 4663, address: A(14), symbol: 'CRED', name: 'credential logo', decimals: 36, logoURI: 'https://user:pass@example.org/x.png' },
  ],
};
const EXPECTED_TOKENS = [
  { chainId: 4663, address: '0x' + 'aa'.repeat(20), symbol: 'SYNC', name: 'SyncNet', decimals: 18, logoURI: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' },
  { chainId: 4663, address: '0x' + 'bb'.repeat(20), symbol: 'CAT', name: 'Cat Coin', decimals: 6 },
  { chainId: 4663, address: '0x' + 'cc'.repeat(20), symbol: 'USDG', name: 'Global Dollar', decimals: 6, logoURI: 'https://cdn.example.org/usdg.png?x=%3Cy%3E' },
  { chainId: 4663, address: A(12), symbol: 'HTTP', name: 'http logo', decimals: 18 },
  { chainId: 4663, address: A(13), symbol: 'DATA', name: 'data logo', decimals: 0 },
  { chainId: 4663, address: A(14), symbol: 'CRED', name: 'credential logo', decimals: 36 },
];
function fakeTokenlist(respondWith) {
  const state = { calls: 0, urls: [], inits: [] };
  const fetch = async (url, init) => {
    state.calls += 1;
    state.urls.push(url);
    state.inits.push(init);
    return respondWith(url, init, state);
  };
  return { fetch, state };
}
const jsonResponse = (obj, status = 200, headers = {}) => () => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const runTokenlist = (deps, event) => tokenlistFn._handler(event || launchesEvent(), deps);

await section('par-tokenlist.js: validation and output', async () => {
  tokenlistFn._resetCache();
  const c = clock(T0);
  const up = fakeTokenlist(jsonResponse(GOOD_LIST));
  const r = await runTokenlist({ fetch: up.fetch, now: c, store: memStore(c) });
  const b = body(r);
  check('200 from https://par.family/tokenlist.json, redirects not followed', r.statusCode === 200 && up.state.urls[0] === 'https://par.family/tokenlist.json' && up.state.inits[0].redirect === 'manual');
  check('output shape {name, timestamp, tokens} only', same(Object.keys(b).sort(), ['name', 'timestamp', 'tokens']) && b.name === 'PAR List' && b.timestamp === '2026-09-20T10:00:00.000Z');
  check('malformed entries dropped, valid ones normalised', same(b.tokens, EXPECTED_TOKENS), JSON.stringify(b.tokens));
  check('tokens never carry unknown fields', b.tokens.every((t) => Object.keys(t).every((k) => ['chainId', 'address', 'symbol', 'name', 'decimals', 'logoURI'].includes(k))));
  check('no bidi/zero-width characters in the output', !BIDI_ZW.test(r.body));
  check('no unknown/unsafe upstream content echoed', !/javascript:|data:|http:\/\/|<script|extensions|evil|keywords/.test(r.body));
  check('content-type JSON + nosniff + CSP', SECURITY_HEADERS(r));
  check('cache headers: public, max-age=300 + CDN s-maxage=600', hdr(r, 'cache-control') === 'public, max-age=300' && hdr(r, 'netlify-cdn-cache-control') === 'public, s-maxage=600');
});

await section('par-tokenlist.js: hostile or broken upstream', async () => {
  const generic = { error: 'The PAR token list is temporarily unavailable.', code: 'upstream_unavailable' };
  const cases = [
    ['HTML page', () => new Response('<!doctype html><html><script>alert(document.domain)</script></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['HTML served as application/json', () => new Response('<html><body>hi</body></html>', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['top-level array', jsonResponse([{ chainId: 4663 }])],
    ['tokens not an array', jsonResponse({ tokens: 'x' })],
    ['empty object', jsonResponse({})],
    ['only invalid tokens', jsonResponse({ tokens: [{ chainId: 1, address: A(1), symbol: 'X', name: 'x', decimals: 1 }] })],
    ['HTTP 500', jsonResponse({ tokens: [] }, 500)],
    ['302 redirect', () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })],
    ['network error', () => { throw new TypeError('fetch failed SECRET'); }],
  ];
  for (const [label, respondWith] of cases) {
    tokenlistFn._resetCache();
    const c = clock(T0);
    const r = await runTokenlist({ fetch: fakeTokenlist(respondWith).fetch, now: c, store: memStore(c) });
    check(`${label} -> 502 generic JSON`, r.statusCode === 502 && same(body(r), generic) && SECURITY_HEADERS(r) && hdr(r, 'cache-control') === 'no-store' && !/<|script|SECRET/.test(r.body), `${r.statusCode} ${r.body}`);
  }
  tokenlistFn._resetCache();
  let pulled = 0;
  const big = () => new Response(new ReadableStream({ pull(ctrl) { if (pulled >= 64 * 1024 * 1024) { ctrl.close(); return; } pulled += 65536; ctrl.enqueue(new Uint8Array(65536).fill(0x20)); } }), { status: 200 });
  const c = clock(T0);
  const r = await runTokenlist({ fetch: fakeTokenlist(big).fetch, now: c, store: memStore(c) });
  check('body above 5 MiB -> 502', r.statusCode === 502);
  check('streaming stopped at the 5 MiB cap (did not read the 64 MiB)', pulled > 5 * 1024 * 1024 && pulled < 6 * 1024 * 1024, `${pulled} bytes`);
  tokenlistFn._resetCache();
  let pulled2 = 0;
  const declared = () => new Response(new ReadableStream({ pull(ctrl) { pulled2 += 65536; ctrl.enqueue(new Uint8Array(65536)); } }), { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } });
  const r2 = await runTokenlist({ fetch: fakeTokenlist(declared).fetch, now: c, store: memStore(c) });
  check('declared content-length above 5 MiB -> 502 without reading the body', r2.statusCode === 502 && pulled2 <= 2 * 65536);
  tokenlistFn._resetCache();
  const t0 = Date.now();
  const r3 = await runTokenlist({ fetch: () => new Promise(() => {}), now: c, store: memStore(c), timeoutMs: 40 });
  check('hanging upstream -> 502 after the timeout', r3.statusCode === 502 && Date.now() - t0 < 2000);
  check('default timeout 8 s, cap 5 MiB, cache 10 min, chain 4663', tokenlistFn._internals.TIMEOUT_MS === 8000 && tokenlistFn._internals.MAX_BYTES === 5 * 1024 * 1024 && tokenlistFn._internals.FRESH_MS === 600000 && tokenlistFn._internals.CHAIN_ID === 4663);
  tokenlistFn._resetCache();
});

await section('par-tokenlist.js: cache, canonical URL, rate limit', async () => {
  tokenlistFn._resetCache();
  const c = clock(T0);
  const store = memStore(c);
  let mode = 'good';
  const up = fakeTokenlist(() => (mode === 'good' ? jsonResponse(GOOD_LIST)() : new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
  await runTokenlist({ fetch: up.fetch, now: c, store });
  c.advance(9 * 60_000);
  const r2 = await runTokenlist({ fetch: up.fetch, now: c, store });
  check('second call within 10 min -> served from memory, no upstream request', up.state.calls === 1 && r2.statusCode === 200 && same(body(r2).tokens, EXPECTED_TOKENS));
  c.advance(60_001);
  await runTokenlist({ fetch: up.fetch, now: c, store });
  check('after 10 min -> refreshed', up.state.calls === 2);
  c.advance(10 * 60_000 + 1);
  mode = 'html';
  const r3 = await runTokenlist({ fetch: up.fetch, now: c, store });
  check('refresh failure (HTML) with a cached list < 1 h old -> last good list, never the HTML', up.state.calls === 3 && r3.statusCode === 200 && same(body(r3).tokens, EXPECTED_TOKENS) && !r3.body.includes('<'));
  const q = await runTokenlist({ fetch: up.fetch, now: c, store }, launchesEvent(undefined, { queryStringParameters: { v: '2' }, rawQuery: 'v=2' }));
  check('query string -> 301 to /api/par-tokenlist, no upstream call', q.statusCode === 301 && hdr(q, 'location') === '/api/par-tokenlist' && up.state.calls === 3 && /public/.test(hdr(q, 'cache-control')));
  mode = 'good';
  tokenlistFn._resetCache();
  const ip = nextIp();
  let allOk = true;
  for (let i = 0; i < 60; i += 1) if ((await runTokenlist({ fetch: up.fetch, now: c, store }, launchesEvent(ip))).statusCode !== 200) allOk = false;
  const r61 = await runTokenlist({ fetch: up.fetch, now: c, store }, launchesEvent(ip));
  check('60 requests per minute per IP allowed, 61st -> 429', allOk && r61.statusCode === 429 && Number(hdr(r61, 'retry-after')) > 0);
  check('POST -> 405', (await runTokenlist({ fetch: up.fetch, now: c, store }, launchesEvent(undefined, { httpMethod: 'POST' }))).statusCode === 405);
  const down = { incrWindow: async () => { throw new StoreUnavailable('down'); } };
  check('store unavailable -> 429 (fail closed)', (await runTokenlist({ fetch: up.fetch, now: c, store: down })).statusCode === 429);
  tokenlistFn._resetCache();
});

// ================================================================== canary-auth.js
const post = (key, ip, extra = {}) => ({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip || nextIp(), 'content-type': 'application/json' }, body: JSON.stringify({ key }), ...extra });
const auth = (event, deps) => canary._handler(event, deps);

await section('canary-auth.js: configuration and contract', async () => {
  const c = clock(T0);
  process.env.SYNCNET_CANARY_KEY = 'c'.repeat(31);
  const n = logs.length;
  const short = await auth(post('c'.repeat(31)), { store: memStore(c), now: c });
  check('SYNCNET_CANARY_KEY shorter than 32 chars -> 503 with the generic message', short.statusCode === 503 && body(short).error === 'Live launch access is not available on this deployment.');
  check('short key: server log says the key is too short', logs.slice(n).some((l) => l.includes('"misconfigured"') && l.includes('too short')));
  check('503 body names no environment variable', !short.body.includes('SYNCNET'));
  delete process.env.SYNCNET_CANARY_KEY;
  check('missing key -> 503', (await auth(post('anything'), { store: memStore(c), now: c })).statusCode === 503);
  process.env.SYNCNET_CANARY_KEY = CANARY_KEY;

  const wrong = await auth(post('wrong-key'), { store: memStore(c), now: c });
  check('wrong key -> 401 {error:"Access denied."}', wrong.statusCode === 401 && body(wrong).error === 'Access denied.' && SECURITY_HEADERS(wrong));
  const ok = await auth(post(CANARY_KEY), { store: memStore(c), now: c });
  const b = body(ok);
  check('right key -> 200 {ok:true, uploadSession, uploadSessionTtl:7200}', ok.statusCode === 200 && b.ok === true && typeof b.uploadSession === 'string' && b.uploadSessionTtl === 7200 && hdr(ok, 'cache-control') === 'no-store');
  const v = us.verify(b.uploadSession, { scope: 'founder', now: c() });
  check('session accepted by upload-session.verify (founder, subject "-", 2 h)', v && v.scope === 'founder' && v.subject === '-' && v.exp === Math.floor(c() / 1000) + 7200);
  check('session is not a wallet session', us.verify(b.uploadSession, { scope: 'wallet', now: c() }) === null);
  delete process.env.SYNCNET_UPLOAD_KEY;
  const noUpload = await auth(post(CANARY_KEY), { store: memStore(c), now: c });
  process.env.SYNCNET_UPLOAD_KEY = UPLOAD_KEY;
  check('no upload secret -> still unlocked, uploadSession:null, ttl 0', noUpload.statusCode === 200 && same(body(noUpload), { ok: true, uploadSession: null, uploadSessionTtl: 0 }));
  check('invalid JSON -> 400', (await auth({ ...post('x'), body: '{nope' }, { store: memStore(c), now: c })).statusCode === 400);
  check('base64 body accepted', (await auth({ ...post('x'), body: Buffer.from(JSON.stringify({ key: CANARY_KEY })).toString('base64'), isBase64Encoded: true }, { store: memStore(c), now: c })).statusCode === 200);
  const get = await auth({ httpMethod: 'GET', headers: {} }, { store: memStore(c), now: c });
  check('GET -> 405 with allow: POST', get.statusCode === 405 && hdr(get, 'allow') === 'POST');
  const down = { get: async () => { throw new StoreUnavailable('down'); }, incrWindow: async () => { throw new StoreUnavailable('down'); } };
  check('store unavailable -> 429 (fail closed), key not evaluated', (await auth(post(CANARY_KEY), { store: down, now: c })).statusCode === 429);
  check('exports.handler wired (405 for GET)', (await canary.handler({ httpMethod: 'GET', headers: {} })).statusCode === 405);
});

await section('canary-auth.js: constant-time comparison', async () => {
  const c = clock(T0);
  const store = memStore(c);
  const ip = nextIp();
  const calls = [];
  const original = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return original(a, b); };
  const statuses = [];
  try {
    for (const key of ['x', 'y'.repeat(500), CANARY_KEY.slice(0, -1), CANARY_KEY]) statuses.push((await auth(post(key, ip), { store, now: c })).statusCode);
  } finally {
    crypto.timingSafeEqual = original;
  }
  check('every attempt is compared with crypto.timingSafeEqual', calls.length === 4 && same(statuses, [401, 401, 401, 200]), JSON.stringify({ calls, statuses }));
  check('always 32-byte HMAC digests on both sides (no length leak)', calls.every(([a, b]) => a === 32 && b === 32));
  check('keysMatch(): non-string input never matches', canary._internals.keysMatch(undefined, CANARY_KEY) === false && canary._internals.keysMatch({ toString: () => CANARY_KEY }, CANARY_KEY) === false && canary._internals.keysMatch(CANARY_KEY, CANARY_KEY) === true);
});

await section('canary-auth.js: attempt limit, IP lockout, global lockout', async () => {
  const c = clock(T0);
  const store = memStore(c);
  const ip = nextIp();
  const five = [];
  for (let i = 0; i < 5; i += 1) five.push((await auth(post(`wrong-${i}`, ip), { store, now: c })).statusCode);
  const sixth = await auth(post(CANARY_KEY, ip), { store, now: c });
  check('5 attempts per 15 min per IP', five.every((s) => s === 401));
  check('6th attempt within 15 min -> 429 even with the right key', sixth.statusCode === 429 && Number(hdr(sixth, 'retry-after')) > 0 && Number(hdr(sixth, 'retry-after')) <= 900);
  c.advance(15 * 60_000);
  check('next 15-minute window -> attempts allowed again', (await auth(post(CANARY_KEY, ip), { store, now: c })).statusCode === 200);

  const cl = clock(T0);
  const sl = memStore(cl);
  const lip = nextIp();
  const fails = [];
  for (let i = 0; i < 5; i += 1) fails.push((await auth(post('bad', lip), { store: sl, now: cl })).statusCode);
  cl.advance(15 * 60_000); // 12:16, same hour, new 15-minute window
  const n = logs.length;
  for (let i = 0; i < 5; i += 1) fails.push((await auth(post('bad', lip), { store: sl, now: cl })).statusCode);
  check('10 failures within the hour are answered 401', fails.length === 10 && fails.every((s) => s === 401));
  check('lockout logged with the hashed IP only', logs.slice(n).some((l) => l.includes('ip-locked') && l.includes(logLib.hashId(lip))) && !logs.slice(n).some((l) => l.includes(lip)));
  cl.advance(15 * 60_000); // 12:31, attempt window fresh again, but the IP is locked until 13:16
  const locked = await auth(post(CANARY_KEY, lip), { store: sl, now: cl });
  check('after 10 failures the IP is locked out for 1 h (429 even with the right key)', locked.statusCode === 429 && Number(hdr(locked, 'retry-after')) === 45 * 60, hdr(locked, 'retry-after'));
  check('lockout is per IP', (await auth(post(CANARY_KEY), { store: sl, now: cl })).statusCode === 200);
  cl.advance(45 * 60_000 + 1000); // 13:16:01
  check('lockout ends after 1 h', (await auth(post(CANARY_KEY, lip), { store: sl, now: cl })).statusCode === 200);

  const cg = clock(T0);
  const sg = memStore(cg);
  for (let i = 0; i < 20; i += 1) {
    const gip = nextIp();
    for (let j = 0; j < 5; j += 1) await auth(post('bad', gip), { store: sg, now: cg }); // 5 each: no single IP reaches 10
  }
  const blocked = await auth(post(CANARY_KEY), { store: sg, now: cg });
  check('100 failures in the hour -> every attempt gets 429, even a new IP with the right key', blocked.statusCode === 429 && Number(hdr(blocked, 'retry-after')) === 59 * 60, `${blocked.statusCode} ${hdr(blocked, 'retry-after')}`);
  cg.set(T0 - (T0 % 3_600_000) + 3_600_000 + 1000); // 13:00:01
  check('global lockout lifts when the hour window ends', (await auth(post(CANARY_KEY), { store: sg, now: cg })).statusCode === 200);

  const ch = clock(T0);
  const sh = memStore(ch);
  for (let i = 0; i < 19; i += 1) {
    const hip = nextIp();
    for (let j = 0; j < 5; j += 1) await auth(post('bad', hip), { store: sh, now: ch });
  }
  const lastIp = nextIp();
  for (let j = 0; j < 4; j += 1) await auth(post('bad', lastIp), { store: sh, now: ch }); // 99 failures
  const success = await auth(post(CANARY_KEY), { store: sh, now: ch });
  const hundredth = await auth(post('bad'), { store: sh, now: ch });
  const afterwards = await auth(post(CANARY_KEY), { store: sh, now: ch });
  check('a success does not reset the global failure counter', success.statusCode === 200 && hundredth.statusCode === 401 && afterwards.statusCode === 429);
});

// ================================================================== config + hygiene
await section('netlify.toml / _redirects', async () => {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const redirects = fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8').split('\n');
  check('netlify.toml: /api/par-tokenlist rewrites to the function', /\[\[redirects\]\]\n\s*from = "\/api\/par-tokenlist"\n\s*to = "\/\.netlify\/functions\/par-tokenlist"\n\s*status = 200\n\s*force = true/.test(toml));
  check('netlify.toml: no proxy to par.family/tokenlist.json left', !toml.includes('tokenlist.json'));
  check('netlify.toml: other function rewrites intact', ['par-launches-all', 'canary-auth', 'ipfs-upload', 'site-check'].every((f) => toml.includes(`from = "/api/${f}"\n  to = "/.netlify/functions/${f}"`)) && toml.includes('from = "/token/*"'));
  check('netlify.toml: CSP header unchanged', toml.includes(`Content-Security-Policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; connect-src 'self' http://127.0.0.1:8545 http://localhost:8545 https://api.par.family https://par.family https://rpc.mainnet.chain.robinhood.com https://ipfs.io https://dweb.link; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"`));
  check('_redirects: /api/par-tokenlist rewrites to the function', redirects.includes('/api/par-tokenlist /.netlify/functions/par-tokenlist 200') && !redirects.some((l) => l.includes('tokenlist.json')));
  check('_redirects: every other rule kept', ['/api/canary-auth /.netlify/functions/canary-auth 200', '/api/ipfs-upload /.netlify/functions/ipfs-upload 200', '/api/site-check /.netlify/functions/site-check 200', '/api/par-launches-all /.netlify/functions/par-launches-all 200', '/project/* /token.html 200', '/token/* /token.html 200'].every((l) => redirects.includes(l)));
});

await section('source hygiene', async () => {
  const files = ['netlify/lib/respond.js', 'netlify/lib/log.js', 'netlify/lib/store.js', 'netlify/lib/ratelimit.js', 'netlify/lib/upload-session.js', 'netlify/functions/site-check.js', 'netlify/functions/par-launches-all.js', 'netlify/functions/par-tokenlist.js', 'netlify/functions/canary-auth.js'];
  const bad = files.filter((f) => /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('no literal bidi/zero-width characters in the server sources', bad.length === 0, bad.join(', '));
  const sc = fs.readFileSync(path.join(ROOT, 'netlify/functions/site-check.js'), 'utf8');
  check('site-check.js keeps the markers tests/static_audit.py asserts', sc.includes("redirect: 'manual'") && sc.includes('privateIp') && sc.includes('MAX = 16 * 1024'));
  const ca = fs.readFileSync(path.join(ROOT, 'netlify/functions/canary-auth.js'), 'utf8');
  check('canary-auth.js keeps SYNCNET_CANARY_KEY + timingSafeEqual (static audit)', ca.includes('SYNCNET_CANARY_KEY') && ca.includes('timingSafeEqual'));
});

// ================================================================== global assertions
await section('global', async () => {
  check('no real network access was attempted', realNetwork.length === 0, realNetwork.join(', '));
  check('logs never contain a raw client IP', !logs.some((l) => l.includes('10.250.')), logs.find((l) => l.includes('10.250.')));
  check('every log line is one JSON object with ts/fn/event', logs.every((l) => { try { const j = JSON.parse(l); return j.ts && j.fn && j.event; } catch { return false; } }), logs.find((l) => { try { JSON.parse(l); return false; } catch { return true; } }));
});

const passed = checks.filter((c) => c.ok).length;
const failed = checks.length - passed;
fs.writeFileSync(path.join(HERE, 'infra.results.json'), JSON.stringify({ passed, failed, checks }, null, 2) + '\n');
print(`\n${failed ? 'FAILED' : 'OK'}: ${passed} passed, ${failed} failed (${Date.now() - started} ms)`);
process.exit(failed ? 1 : 0);
