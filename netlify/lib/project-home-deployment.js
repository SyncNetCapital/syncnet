'use strict';
/*
 * Project Home PAYMENT DEPLOYMENT VALIDATION — the server never quotes a payment to an address it has not verified.
 *
 * Reviewed configuration: syncnet-project-home-deployment.json (git). It pins the canonical SYNC, USDG, PAR router and
 * market, the approved SyncNet Protocol Treasury, the immutable-aware code fingerprints of the audited build, and the
 * list of reviewed deployments {sink, converter}. PROJECT_HOME_SINK_ADDRESS must be one of those sinks.
 *
 * On-chain checks (all must pass, bounded to 12 RPC calls, any RPC failure = FAIL):
 *   chain      eth_chainId == 4663
 *   sink       has code; runtime length and keccak256(runtime with every immutable range zeroed) equal the audited
 *              fingerprint; the immutable words IN THE DEPLOYED CODE equal SYNC and the reviewed converter;
 *              SYNC() == canonical SYNC, BURN_PERCENT() == 60, TREASURY_CONVERTER() == reviewed converter
 *   converter  has code; fingerprint as above; immutable words equal SYNC, USDG, TREASURY, ROUTER, MARKET;
 *              SYNC(), USDG(), ROUTER() canonical, MARKET() == 1, TREASURY() == reviewed treasury
 * Why both code identity AND getters: the fingerprint proves the deployed code is exactly the audited build (not a
 * look-alike that merely answers the same getters); the getters prove the live contract answers as reviewed.
 * Solidity immutables are written into the runtime at compile-time-known offsets, so the fingerprint zeroes exactly
 * those ranges (deployedBytecode.immutableReferences) and the values are checked separately — no raw-artifact compare.
 *
 * Cache: a PASS is reused for OK_TTL (10 min); a FAIL is remembered for FAIL_TTL (30 s) only to bound RPC load and is
 * never turned into a pass. The key is a hash of the whole reviewed deployment configuration plus the sink, so any
 * configuration change misses the cache. Concurrent validations of one key share a single in-flight check.
 */
const crypto = require('crypto');
const Core = require('../../lib/syncnet-core.js');
const PhChain = require('./project-home-chain');
const FILE = require('../../syncnet-project-home-deployment.json');

const CHAIN_ID = 4663;
// The canonical infrastructure is ALSO pinned here: the reviewed file must agree with it (it cannot redirect anything).
const CANONICAL = Object.freeze({
  sync: '0x6368e007b9f0b941560ed1f3bceb20247f5eca37',
  usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  router: '0x458d2a59c2f3dd32775a64ee72004561440d64df',
  market: 1,
});
const BURN_PERCENT = 60n;
const IMMUTABLES = Object.freeze({ sink: ['SYNC', 'TREASURY_CONVERTER'], converter: ['MARKET', 'ROUTER', 'SYNC', 'TREASURY', 'USDG'] });
const OK_TTL_MS = 10 * 60 * 1000;
const FAIL_TTL_MS = 30 * 1000;
const MAX_ENTRIES = 16;
const RPC_BUDGET = 12;

const lc = (v) => String(v == null ? '' : v).toLowerCase();
const isAddr = (v) => /^0x[0-9a-f]{40}$/.test(lc(v));
const ZERO = '0x' + '0'.repeat(40);
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

class DeploymentConfigError extends Error { constructor(m) { super(m); this.name = 'DeploymentConfigError'; } }
class DeploymentMismatch extends Error { constructor(m) { super(m); this.name = 'DeploymentMismatch'; } }

function addr(v, what) {
  const s = String(v == null ? '' : v);
  if (!isAddr(s) || lc(s) === ZERO) throw new DeploymentConfigError(what + ' is not a valid address');
  const body = s.slice(2); // mixed case means EIP-55: it must be the exact checksum form
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && Core.toChecksumAddress(lc(s)) !== s) throw new DeploymentConfigError(what + ' has an invalid EIP-55 checksum');
  return lc(s);
}

function fingerprint(fp, kind) {
  if (!fp || typeof fp !== 'object') throw new DeploymentConfigError('code.' + kind + ' missing');
  if (!Number.isSafeInteger(fp.runtimeLength) || fp.runtimeLength < 64 || fp.runtimeLength > 24576) throw new DeploymentConfigError('code.' + kind + '.runtimeLength invalid');
  if (!/^0x[0-9a-f]{64}$/.test(String(fp.normalizedKeccak))) throw new DeploymentConfigError('code.' + kind + '.normalizedKeccak invalid');
  const names = Object.keys(fp.immutables || {}).sort();
  if (names.join() !== IMMUTABLES[kind].join()) throw new DeploymentConfigError('code.' + kind + '.immutables must be exactly ' + IMMUTABLES[kind].join(', '));
  const immutables = {};
  for (const n of names) {
    const ranges = fp.immutables[n];
    if (!Array.isArray(ranges) || !ranges.length) throw new DeploymentConfigError('code.' + kind + '.immutables.' + n + ' empty');
    immutables[n] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !Number.isSafeInteger(r[0]) || r[1] !== 32 || r[0] < 0 || r[0] + 32 > fp.runtimeLength) throw new DeploymentConfigError('code.' + kind + ' immutable range invalid');
      return [r[0], 32];
    });
  }
  return Object.freeze({ runtimeLength: fp.runtimeLength, normalizedKeccak: fp.normalizedKeccak, immutables: Object.freeze(immutables) });
}

/** Validates the reviewed deployment file. Throws DeploymentConfigError on ANY inconsistency (fail closed). */
function loadDeployment(file) {
  const f = file || FILE;
  if (!f || typeof f !== 'object' || f.schema !== 'syncnet.project-home.deployment.v1') throw new DeploymentConfigError('unknown deployment file schema');
  if (f.chainId !== CHAIN_ID) throw new DeploymentConfigError('chainId must be 4663');
  const sync = addr(f.sync, 'sync'), usdg = addr(f.usdg, 'usdg'), router = addr(f.router, 'router');
  if (sync !== CANONICAL.sync || usdg !== CANONICAL.usdg || router !== CANONICAL.router || f.market !== CANONICAL.market) throw new DeploymentConfigError('sync / usdg / router / market must be the canonical values');
  const treasury = addr(f.treasury, 'treasury');
  if ([sync, usdg, router].includes(treasury)) throw new DeploymentConfigError('treasury must not be an infrastructure address');
  const code = { sink: fingerprint(f.code && f.code.sink, 'sink'), converter: fingerprint(f.code && f.code.converter, 'converter') };
  const deployments = new Map();
  for (const d of Array.isArray(f.deployments) ? f.deployments : []) {
    const sink = addr(d && d.sink, 'deployments[].sink'), converter = addr(d && d.converter, 'deployments[].converter');
    const used = [sync, usdg, router, treasury];
    if (sink === converter || used.includes(sink) || used.includes(converter) || deployments.has(sink)) throw new DeploymentConfigError('deployment ' + sink + ' is inconsistent');
    deployments.set(sink, converter);
  }
  return Object.freeze({ chainId: CHAIN_ID, sync, usdg, router, market: CANONICAL.market, treasury, code: Object.freeze(code), deployments });
}

/** Code identity: length, every immutable word equals its reviewed value, and the normalised runtime hash. */
function checkCode(codeHex, fp, expected, what) {
  const code = lc(codeHex);
  if (!/^0x([0-9a-f]{2})*$/.test(code) || code === '0x') throw new DeploymentMismatch(what + ' has no contract code');
  const bytes = Core.hexToBytes(code);
  if (bytes.length !== fp.runtimeLength) throw new DeploymentMismatch(what + ' code is not the audited build (length)');
  for (const [name, ranges] of Object.entries(fp.immutables)) {
    const want = word(expected[name]).slice(2);
    for (const [s] of ranges) {
      if (Buffer.from(bytes.slice(s, s + 32)).toString('hex') !== want) throw new DeploymentMismatch(what + ' immutable ' + name + ' is not the reviewed value');
      bytes.fill(0, s, s + 32);
    }
  }
  if (Core.keccak256(bytes) !== fp.normalizedKeccak) throw new DeploymentMismatch(what + ' code is not the audited build (fingerprint)');
}

async function read(r, to, sig) {
  const out = lc(await r('eth_call', [{ to, data: Core.functionSelector(sig) }, 'latest']));
  if (!/^0x[0-9a-f]{64}$/.test(out)) throw new DeploymentMismatch(sig + ' on ' + to + ' returned a malformed value');
  return BigInt(out);
}
const asAddr = (n) => '0x' + n.toString(16).padStart(40, '0');

async function expectAddr(r, to, sig, want, what) {
  const n = await read(r, to, sig);
  if (n >> 160n !== 0n || asAddr(n) !== want) throw new DeploymentMismatch(what + ' ' + sig + ' is not the reviewed value');
}

/** One full on-chain validation. Never throws: {ok:true} | {ok:false, kind:'mismatch'|'unavailable', reason}. */
async function validateOnChain(rpc, dep, sink) {
  const converter = dep.deployments.get(sink);
  const r = PhChain.bounded(rpc, RPC_BUDGET);
  try {
    await PhChain.assertChain(r);
    checkCode(await r('eth_getCode', [sink, 'latest']), dep.code.sink, { SYNC: dep.sync, TREASURY_CONVERTER: converter }, 'sink');
    await expectAddr(r, sink, 'SYNC()', dep.sync, 'sink');
    if ((await read(r, sink, 'BURN_PERCENT()')) !== BURN_PERCENT) throw new DeploymentMismatch('sink BURN_PERCENT() is not 60');
    await expectAddr(r, sink, 'TREASURY_CONVERTER()', converter, 'sink');
    checkCode(await r('eth_getCode', [converter, 'latest']), dep.code.converter, { SYNC: dep.sync, USDG: dep.usdg, TREASURY: dep.treasury, ROUTER: dep.router, MARKET: dep.market }, 'converter');
    await expectAddr(r, converter, 'SYNC()', dep.sync, 'converter');
    await expectAddr(r, converter, 'USDG()', dep.usdg, 'converter');
    await expectAddr(r, converter, 'ROUTER()', dep.router, 'converter');
    if ((await read(r, converter, 'MARKET()')) !== BigInt(dep.market)) throw new DeploymentMismatch('converter MARKET() is not 1');
    await expectAddr(r, converter, 'TREASURY()', dep.treasury, 'converter');
    return { ok: true, sink, converter, treasury: dep.treasury, rpcCalls: r.calls() };
  } catch (err) {
    if (err instanceof DeploymentMismatch) return { ok: false, kind: 'mismatch', reason: err.message };
    if (err && err.wrongChain) return { ok: false, kind: 'mismatch', reason: 'RPC is not Robinhood Chain (4663)' };
    // RPC outage, budget exhaustion, a reverting getter: never a pass.
    return { ok: false, kind: err && (err.revert || /revert/i.test(String(err.message))) ? 'mismatch' : 'unavailable', reason: 'on-chain read failed: ' + String((err && err.message) || err).slice(0, 120) };
  }
}

const cache = new Map();
const inflight = new Map();
function keyOf(dep, sink) {
  const material = JSON.stringify({ chainId: dep.chainId, sync: dep.sync, usdg: dep.usdg, router: dep.router, market: dep.market, treasury: dep.treasury, code: dep.code, sink, converter: dep.deployments.get(sink) });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * deploymentStatus(rpc, dep, sink, {now}) -> {ok, kind?, reason?, cached?}. Never throws.
 * PASS cached for OK_TTL; FAIL remembered for FAIL_TTL (still a FAIL); anything not a reviewed deployment fails
 * without touching the chain.
 */
async function deploymentStatus(rpc, dep, sink, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  if (!dep) return { ok: false, kind: 'config', reason: 'no valid reviewed deployment configuration' };
  const s = lc(sink);
  if (!isAddr(s) || !dep.deployments.has(s)) return { ok: false, kind: 'config', reason: 'PROJECT_HOME_SINK_ADDRESS is not a reviewed deployment' };
  const key = keyOf(dep, s);
  const hit = cache.get(key);
  if (hit && now < hit.until) return { ...hit.result, cached: true };
  if (inflight.has(key)) return inflight.get(key);
  const p = validateOnChain(rpc, dep, s).then((result) => {
    cache.delete(key);
    cache.set(key, { result, until: now + (result.ok ? OK_TTL_MS : FAIL_TTL_MS) });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return { ...result, cached: false };
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

module.exports = {
  loadDeployment, deploymentStatus, DeploymentConfigError, CANONICAL, IMMUTABLES,
  _internals: { checkCode, validateOnChain, keyOf, OK_TTL_MS, FAIL_TTL_MS, RPC_BUDGET, reset: () => { cache.clear(); inflight.clear(); } },
};
