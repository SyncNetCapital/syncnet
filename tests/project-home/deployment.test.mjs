// P1-2 — Project Home PAYMENT DEPLOYMENT VALIDATION (adversarial).
// The real project-home handler, the real validation module and deployed runtimes built from the audited bytecode
// (contracts/project-home-sink/abi/runtime.json, pinned by code-fingerprint.mjs). A quote (payable amount + sink) may
// be produced ONLY after the configured sink, its converter and the treasury verify on-chain; every other case must
// return no quote, store no intent and expose no payment recipient.
// Run: node tests/project-home/deployment.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  A, ROOT, Core, SYNC, SINK, CONVERTER, TREASURY_FIXTURE, USDG, PAR_ROUTER, PRICING, ENV, DEPLOYMENT, clock, pc, resetPc, resetChain, rpc, signDigest, lc, rnd32,
} from './fixtures.mjs';
import { deploymentFile, deployedRuntime } from './deployment-fixture.mjs';

const require = createRequire(import.meta.url);
const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; console.error('FAIL ' + name + ' :: ' + String(detail).slice(0, 300)); } else console.error('ok   ' + name); }
const logs = [];
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) { logs.push(JSON.parse(a[0])); return; } orig(...a); })(console.log);
for (const n of ['https', 'http', 'net', 'tls']) { const m = require(n); for (const f of ['request', 'get', 'connect', 'createConnection']) if (typeof m[f] === 'function') m[f] = () => { throw new Error('real network access in tests'); }; }

const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const Site = require(path.join(ROOT, 'lib/syncnet-site.js'));
const ph = require(path.join(ROOT, 'netlify/functions/project-home.js'));
const Dep = require(path.join(ROOT, 'netlify/lib/project-home-deployment.js'));
const SEL = (s) => Core.functionSelector(s);

const MAP = new Map();
const store = { ...createStore({ map: MAP, now: () => clock.now() }), durable: true, kind: 'test-durable' };
let ipSeq = 0;
const ip = () => `203.0.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const parse = (r) => { let j = {}; try { j = JSON.parse(r.body); } catch { j = {}; } return { s: r.statusCode, j, body: r.body }; };
let rpcCalls = { getCode: 0, total: 0 };
const countingRpc = async (m, p) => { rpcCalls.total++; if (m === 'eth_getCode') rpcCalls.getCode++; return rpc(m, p); };
const api = (method, body, query, over = {}) => ph._handler({ httpMethod: method, headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: query || {}, body: body ? JSON.stringify(body) : null },
  { store, env: over.env || ENV, rpc: over.rpc || countingRpc, now: () => clock.now(), pricingFile: PRICING, deploymentFile: over.deploymentFile || DEPLOYMENT }).then(parse);
const W = lc(A.WALLET);
const cat = (i) => '0x8' + String(i).repeat(39);
const T_FAIL = cat(0), T_OK = cat(1), T_REUSE = cat(2);
resetChain(); resetPc();
for (const t of [T_FAIL, T_OK, T_REUSE]) MAP.set('mp:passport:v1:' + t, { type: 'string', value: JSON.stringify({ schema: 'syncnet.passport.v1', token: t, chainId: 4663, launchpad: 'PAR', operator: W, operatorSince: new Date(clock.now()).toISOString(), claims: [], listing: null, history: [] }), expiresAt: null });
const quote = (token, over = {}) => { const m = { token, operator: W, issuedAt: Math.floor(clock.now() / 1000), nonce: rnd32() }; return api('POST', { action: 'intent', ...m, signature: signDigest(W, Site.digest('ActivationRequest', m)) }, null, over); };
const noIntentStored = async (t) => !(await store.get('site:open:v1:' + t)) && (await store.smembers('site:intents:v1:' + t)).length === 0;
const reset = () => { Dep._internals.reset(); resetPc(); };
const OTHER = '0x' + '42'.repeat(20);

/** Every misconfiguration: no quote, no stored intent, no payment instruction, no recipient in the config view. */
async function mustRefuse(label, arrange, over = {}) {
  reset(); logs.length = 0;
  arrange();
  const amountsBefore = [...MAP.keys()].filter((k) => k.startsWith('site:amt:v1:')).length;
  const r = await quote(T_FAIL, over);
  const cfg = await api('GET', null, { view: 'config' }, over);
  const refused = r.s === 503 && ['payments_unverified', 'payments_closed'].includes(r.j.code) && !r.j.intent && !/exactTaggedSyncAmount|0x5111c0/.test(r.body);
  check(`${label} → FAIL: no quote`, refused, r.body);
  check(`${label} → FAIL: no intent stored, no amount reserved`, await noIntentStored(T_FAIL) && [...MAP.keys()].filter((k) => k.startsWith('site:amt:v1:')).length === amountsBefore);
  check(`${label} → FAIL: config view exposes no recipient and no quote`, cfg.j.payments === false && cfg.j.sink === null && cfg.j.quote === null && cfg.j.deploymentVerified === false, cfg.body);
  return { r, log: logs.find((l) => l.event === 'payments-unverified' || l.event === 'payments-closed') };
}

// ===================================================================== PASS
{
  reset(); rpcCalls = { getCode: 0, total: 0 };
  const r = await quote(T_OK);
  check('correct audited sink + converter + treasury → PASS: quote issued', r.s === 201 && r.j.intent && r.j.intent.sink === SINK, r.body);
  check('PASS used both code reads (sink + converter) within the bounded budget', rpcCalls.getCode === 2);
  const cfg = await api('GET', null, { view: 'config' });
  check('PASS: config view exposes the verified sink and an indicative quote', cfg.j.payments === true && cfg.j.deploymentVerified === true && cfg.j.sink === SINK && cfg.j.quote && cfg.j.quote.baseSyncAmount);
  const direct = await Dep._internals.validateOnChain(rpc, Dep.loadDeployment(DEPLOYMENT), SINK);
  check('PASS: the validator reads at most 12 RPC calls', direct.ok && direct.rpcCalls <= Dep._internals.RPC_BUDGET, JSON.stringify(direct));
}

// ===================================================================== cache
{
  reset(); rpcCalls = { getCode: 0, total: 0 };
  await quote(T_REUSE); // validates
  const first = rpcCalls.getCode;
  await quote(T_REUSE); // reuses the open intent → must still pass the (cached) gate
  await api('GET', null, { view: 'config' });
  check('cache hit: a second quote and the config view reuse the PASS (no new code reads)', first === 2 && rpcCalls.getCode === 2, `${first} → ${rpcCalls.getCode}`);
  clock.advance(Dep._internals.OK_TTL_MS / 1000 + 1);
  await api('GET', null, { view: 'config' });
  check('cache expiry: after the TTL the deployment is validated on-chain again', rpcCalls.getCode === 4, String(rpcCalls.getCode));
  // Changed reviewed configuration (a different treasury) must not reuse the cached PASS — and it fails on-chain.
  const changed = deploymentFile({ treasury: OTHER, deployments: [{ sink: SINK, converter: CONVERTER }] });
  const before = rpcCalls.getCode;
  const r = await quote(T_FAIL, { deploymentFile: changed });
  check('changed deployment config cannot reuse the previous PASS (re-validated, and refused)', r.s === 503 && r.j.code === 'payments_unverified' && rpcCalls.getCode > before, r.body);
  const k1 = Dep._internals.keyOf(Dep.loadDeployment(DEPLOYMENT), SINK), k2 = Dep._internals.keyOf(Dep.loadDeployment(changed), SINK);
  check('cache key covers the whole reviewed configuration', k1 !== k2);
}

// ===================================================================== configuration-level refusals (no chain read needed)
await mustRefuse('PROJECT_HOME_SINK_ADDRESS not in the reviewed deployments', () => {}, { env: { ...ENV, PROJECT_HOME_SINK_ADDRESS: OTHER } });
await mustRefuse('treasury address used as sink (reviewed file refuses it)', () => {}, { env: { ...ENV, PROJECT_HOME_SINK_ADDRESS: TREASURY_FIXTURE }, deploymentFile: { ...DEPLOYMENT, deployments: [{ sink: TREASURY_FIXTURE, converter: CONVERTER }] } });
await mustRefuse('reviewed deployment file invalid (non-canonical router)', () => {}, { deploymentFile: { ...DEPLOYMENT, router: OTHER } });
await mustRefuse('empty reviewed deployments (the committed production state)', () => {}, { deploymentFile: { ...DEPLOYMENT, deployments: [] } });

// ===================================================================== on-chain refusals
const EOA = '0x' + '5e'.repeat(20);
const eoaAsSink = { env: { ...ENV, PROJECT_HOME_SINK_ADDRESS: EOA }, deploymentFile: deploymentFile({ treasury: TREASURY_FIXTURE, deployments: [{ sink: EOA, converter: CONVERTER }] }) };
const e = await mustRefuse('EOA used as sink (no code)', () => {}, eoaAsSink);
check('diagnostics: the operations log names the reason and the sink', e.log && /no contract code/.test(e.log.reason) && e.log.sink === EOA, JSON.stringify(e.log));
await mustRefuse('treasury address used as sink on-chain (EOA, no code)', () => {}, { env: { ...ENV, PROJECT_HOME_SINK_ADDRESS: '0x' + '7e'.repeat(20) }, deploymentFile: deploymentFile({ treasury: TREASURY_FIXTURE, deployments: [{ sink: '0x' + '7e'.repeat(20), converter: CONVERTER }] }) });
await mustRefuse('wrong contract used as sink (another runtime)', () => { pc.dep.code.set(SINK, '0x6080604052' + 'ab'.repeat(1773)); });
await mustRefuse('converter address used as sink', () => {}, { env: { ...ENV, PROJECT_HOME_SINK_ADDRESS: CONVERTER }, deploymentFile: deploymentFile({ treasury: TREASURY_FIXTURE, deployments: [{ sink: CONVERTER, converter: OTHER }] }) });
await mustRefuse('sink code altered in one non-immutable byte (fingerprint)', () => { const c = pc.dep.code.get(SINK); pc.dep.code.set(SINK, c.slice(0, 22) + (c.slice(22, 24) === 'ff' ? '00' : 'ff') + c.slice(24)); });
await mustRefuse('sink built with a wrong SYNC immutable', () => { pc.dep.code.set(SINK, deployedRuntime('sink', { SYNC: OTHER, TREASURY_CONVERTER: CONVERTER })); });
await mustRefuse('sink SYNC() getter answers a wrong token', () => { pc.dep.getters.set(SINK + ':' + SEL('SYNC()'), BigInt(OTHER)); });
await mustRefuse('sink BURN_PERCENT() != 60', () => { pc.dep.getters.set(SINK + ':' + SEL('BURN_PERCENT()'), 50n); });
await mustRefuse('sink pointing to a wrong converter (immutable)', () => { pc.dep.code.set(SINK, deployedRuntime('sink', { SYNC, TREASURY_CONVERTER: OTHER })); });
await mustRefuse('sink TREASURY_CONVERTER() answers a wrong converter', () => { pc.dep.getters.set(SINK + ':' + SEL('TREASURY_CONVERTER()'), BigInt(OTHER)); });
const conv = (over) => deployedRuntime('converter', { SYNC, USDG, TREASURY: TREASURY_FIXTURE, ROUTER: PAR_ROUTER, MARKET: 1, ...over });
for (const [name, value] of [['SYNC', OTHER], ['USDG', OTHER], ['ROUTER', OTHER], ['MARKET', 0], ['TREASURY', OTHER]]) {
  await mustRefuse(`converter built with a wrong ${name}`, () => { pc.dep.code.set(CONVERTER, conv({ [name]: value })); });
  await mustRefuse(`converter ${name}() getter answers a wrong value`, () => { pc.dep.getters.set(CONVERTER + ':' + SEL(name + '()'), BigInt(name === 'MARKET' ? 2 : OTHER)); });
}
await mustRefuse('converter with no code', () => { pc.dep.code.set(CONVERTER, '0x'); });
await mustRefuse('a getter call reverts (sink)', () => { pc.dep.getters.set(SINK + ':' + SEL('BURN_PERCENT()'), 'revert'); });
await mustRefuse('a getter call reverts (converter)', () => { pc.dep.getters.set(CONVERTER + ':' + SEL('TREASURY()'), 'revert'); });
await mustRefuse('RPC on the wrong chain', () => { pc.chainHex = '0x1'; });
const down = await mustRefuse('RPC unavailable → FAIL CLOSED', () => { pc.mode = 'down'; });
check('RPC outage is logged as unavailable (not as a pass)', down.log && down.log.kind === 'unavailable', JSON.stringify(down.log));
{
  // A failure is remembered briefly (bounded RPC load) and NEVER becomes a pass; once it expires, a healthy chain passes.
  reset(); pc.mode = 'down';
  await quote(T_FAIL);
  pc.mode = 'ok';
  const soon = await quote(T_FAIL);
  check('a recent failure is not retried within FAIL_TTL and is never treated as valid', soon.s === 503 && soon.j.code === 'payments_unverified' && await noIntentStored(T_FAIL), soon.body);
  clock.advance(Dep._internals.FAIL_TTL_MS / 1000 + 1);
  const later = await quote(T_FAIL);
  check('after FAIL_TTL a healthy deployment validates and quotes', later.s === 201 && later.j.intent, later.body);
}
{
  // A quote that was already open is NOT returned again once the deployment stops verifying.
  reset();
  const first = await quote(T_REUSE);
  Dep._internals.reset();
  pc.dep.getters.set(CONVERTER + ':' + SEL('TREASURY()'), BigInt(OTHER));
  const again = await quote(T_REUSE);
  check('an open intent is never re-served after validation fails (reuse path is gated too)', (first.s === 200 || first.s === 201) && again.s === 503 && !again.j.intent && !/exactTaggedSyncAmount/.test(again.body), again.body);
}
{
  // Concurrent first quotes share ONE on-chain validation (no stampede).
  reset(); rpcCalls = { getCode: 0, total: 0 };
  const dep = Dep.loadDeployment(DEPLOYMENT);
  const all = await Promise.all(Array.from({ length: 8 }, () => Dep.deploymentStatus(countingRpc, dep, SINK, { now: () => clock.now() })));
  check('8 concurrent validations: one on-chain check, all PASS', all.every((x) => x.ok) && rpcCalls.getCode === 2, String(rpcCalls.getCode));
}
{
  // The committed production file: approved treasury, canonical infrastructure, nothing deployed → payments closed.
  const prod = Dep.loadDeployment();
  check('committed file: canonical SYNC / USDG / router / market 1', prod.sync === lc(SYNC) && prod.usdg === lc(USDG) && prod.router === lc(PAR_ROUTER) && prod.market === 1);
  check('committed file: the approved treasury is the ONLY accepted converter TREASURY()', prod.treasury === '0x65fac39a7a672afebba404aecddb34a1eddc879b');
  check('committed file: no reviewed deployment yet (payments stay closed until one is reviewed)', prod.deployments.size === 0);
}

console.log(`${results.length - failures}/${results.length} deployment validation checks passed`);
process.exit(failures ? 1 : 0);
