// Test isolation guard: no automated suite may read or write a real Upstash database merely because the shell carries
// production credentials. Proves, with FAKE "production" values (no real host is ever contacted):
//   S. static  : every suite that can load server code imports tests/lib/isolate.mjs FIRST; every createStore() in a test
//                names its env explicitly; run-all strips the store variables from every child process
//   R. runtime : with UPSTASH_REDIS_REST_* / SYNCNET_UPSTASH_* set, createStore()/getStore()/the EARLY fixture store are
//                in-memory, and fetch to *.upstash.io / *.upstash.com is refused before it leaves the process
//   O. opt-in  : a hosted test database needs SYNCNET_TEST_UPSTASH_* + SYNCNET_TEST_UPSTASH_CONFIRM=non-production and is
//                refused when it is the same database as a production variable
// Run: node tests/unit/test-isolation.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond) }); if (!cond) { failures++; console.log('FAIL', name, '::', String(detail).slice(0, 400)); } else console.log('ok  ', name); }

// ---------------------------------------------------------------- S. static
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const SELF = fileURLToPath(import.meta.url); // this guard only names the patterns it looks for; it imports isolate dynamically, after faking the variables
const testFiles = walk(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.mjs') && !f.includes(path.sep + 'lib' + path.sep) && f !== SELF);
const rel = (f) => path.relative(ROOT, f);
const loadsServer = (src) => /netlify\/|harness\.mjs|fixtures\.mjs|createStore|getStore/.test(src);
const firstImport = (src) => (src.match(/^import .*$/m) || [''])[0];
const needing = testFiles.filter((f) => loadsServer(fs.readFileSync(f, 'utf8')));
const missing = needing.filter((f) => !/lib\/isolate\.mjs['"]/.test(firstImport(fs.readFileSync(f, 'utf8'))));
check('S01 every test that can load server code imports tests/lib/isolate.mjs as its FIRST import (' + needing.length + ' files)', needing.length >= 50 && missing.length === 0, missing.map(rel).join(', '));
const bare = testFiles.flatMap((f) => (fs.readFileSync(f, 'utf8').match(/createStore\(\{[^{}]*\}\)/g) || []).filter((c) => !/\benv:/.test(c)).map((c) => rel(f) + ': ' + c));
check('S02 every createStore({...}) in a test names its env explicitly (never inherits process.env)', bare.length === 0, bare.join(' | '));
const runAll = fs.readFileSync(path.join(ROOT, 'tests/run-all.mjs'), 'utf8');
check('S03 run-all spawns every suite with the store variables removed', /env: SUITE_ENV/.test(runAll) && ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SYNCNET_UPSTASH_URL', 'SYNCNET_UPSTASH_TOKEN'].every((k) => runAll.includes("'" + k + "'")));
const conc = fs.readFileSync(path.join(ROOT, 'tests/early/upstash-concurrency.test.mjs'), 'utf8');
check('S04 the real-Redis suite never reads the production variable names (only the explicit SYNCNET_TEST_UPSTASH_* opt-in)', !/process\.env\.(UPSTASH_REDIS_REST|SYNCNET_UPSTASH)/.test(conc) && /testUpstash\(\)/.test(conc));

// ---------------------------------------------------------------- R. runtime (fake values; nothing real is contacted)
const FAKE = { UPSTASH_REDIS_REST_URL: 'https://fake-prod-db.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'fake-prod-token', SYNCNET_UPSTASH_URL: 'https://fake-prod-db-2.upstash.io', SYNCNET_UPSTASH_TOKEN: 'fake-prod-token-2' };
Object.assign(process.env, FAKE);
let reached = 0;
globalThis.fetch = async () => { reached++; return new Response('{"result":null}', { status: 200 }); }; // stands in for the network
const iso = await import('../lib/isolate.mjs');
check('R01 isolate removes every store variable from process.env (names reported, values never)', Object.keys(FAKE).every((k) => process.env[k] === undefined) && JSON.stringify(iso.removedStoreVars().sort()) === JSON.stringify(Object.keys(FAKE).sort()));
const Store = require(path.join(ROOT, 'netlify/lib/store.js'));
check('R02 createStore() without env is the in-memory adapter', Store.createStore().kind === 'memory');
Store._resetForTests();
check('R03 getStore() (what every function uses when no store is injected) is the in-memory adapter', Store.getStore().kind === 'memory');
const blocked = async (url) => { const before = reached; try { await fetch(url, { method: 'POST', body: '[]' }); return false; } catch (e) { return /BLOCKED/.test(String(e.message)) && reached === before; } };
check('R04 fetch to a production-looking Upstash host is refused before it leaves the process', await blocked('https://fake-prod-db.upstash.io/pipeline') && await blocked('https://anything.upstash.io/get/k') && await blocked(new URL('https://eu1-x.upstash.com/')) && await blocked(new Request('https://y.upstash.io/set/a/b')));
await fetch('https://example.test/ok');
check('R05 other hosts pass through unchanged (suites keep their own mocks)', reached === 1);
// even an adapter built explicitly against a "production" URL cannot reach it
const explicit = Store.createStore({ env: FAKE, timeoutMs: 2000 });
let refused = false; try { await explicit.get('k'); } catch (e) { refused = true; }
check('R06 an Upstash adapter pointed at a hosted database explicitly still cannot reach it (fetch refused; nothing sent)', explicit.kind === 'upstash' && refused && reached === 1);
const fx = await import('../early/fixtures.mjs');
check('R07 the EARLY fixture store is in-memory even with production variables present', fx.makeStore().kind !== 'upstash' && /memory|test-durable/.test(fx.makeStore().kind));

// ---------------------------------------------------------------- O. explicit opt-in (child processes; fake values)
const probe = (env) => {
  const code = "globalThis.fetch=async()=>new Response('{}');const m=await import(" + JSON.stringify(path.join(ROOT, 'tests/lib/isolate.mjs')) + ");const t=m.testUpstash();let ok=false;try{await fetch((t?'https://'+t.host:'https://z.upstash.io')+'/get/k');ok=true}catch{}console.log(JSON.stringify({host:t&&t.host,fetchOk:ok}))";
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/UPSTASH/.test(k)));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...base, ...env }, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
let p = probe({ SYNCNET_TEST_UPSTASH_URL: 'https://test-db.upstash.io', SYNCNET_TEST_UPSTASH_TOKEN: 't' });
check('O01 a test database without SYNCNET_TEST_UPSTASH_CONFIRM=non-production is refused', p.status !== 0 && /SYNCNET_TEST_UPSTASH_CONFIRM=non-production/.test(p.err), p.out + p.err.slice(0, 200));
p = probe({ ...FAKE, SYNCNET_TEST_UPSTASH_URL: 'https://fake-prod-db.upstash.io', SYNCNET_TEST_UPSTASH_TOKEN: 't', SYNCNET_TEST_UPSTASH_CONFIRM: 'non-production' });
check('O02 a "test" database that is the same host as a production variable is refused', p.status !== 0 && /same database as a production/.test(p.err), p.out + p.err.slice(0, 200));
p = probe({ ...FAKE, SYNCNET_TEST_UPSTASH_URL: 'https://dedicated-test.upstash.io', SYNCNET_TEST_UPSTASH_TOKEN: 't', SYNCNET_TEST_UPSTASH_CONFIRM: 'non-production' });
check('O03 a confirmed, separate test database is the ONLY hosted Upstash a test can reach', p.status === 0 && JSON.parse(p.out || '{}').host === 'dedicated-test.upstash.io' && JSON.parse(p.out || '{}').fetchOk === true, p.out + p.err.slice(0, 200));
p = probe({ ...FAKE });
check('O04 without an opt-in, no hosted Upstash is reachable even with production variables in the environment', p.status === 0 && JSON.parse(p.out || '{}').host === null && JSON.parse(p.out || '{}').fetchOk === false, p.out + p.err.slice(0, 200));

console.log(`\n${results.length - failures}/${results.length} test isolation checks passed`);
process.exit(failures ? 1 : 0);
