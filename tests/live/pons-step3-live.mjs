// Step 3 · LIVE Pons verification against Robinhood Chain mainnet (REAL NETWORK — not part of tests/run-all.mjs).
// Authoritative sources: live bytecode, the Blockscout-verified deployment, live RPC answers (not a GitHub checkout).
//   - chain id 4663; PonsV2LaunchFactory code present and byte-identical to the Blockscout-verified runtime bytecode
//     (sha256 pinned below, read from robinhoodchain.blockscout.com/api/v2/smart-contracts/<factory> on 2026-09-26);
//   - the three selectors SyncNet depends on are in the live dispatcher;
//   - resolveProject() on the release tokens gives the expected classification;
//   - real signed claim / list attempts for Pons V1 are refused by the Marketplace handler (in-memory store only).
// Run: node tests/live/pons-step3-live.mjs   → writes tests/live/pons-step3-live.results.json
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const Origins = require(path.join(ROOT, 'lib/syncnet-origins.js'));
const Market = require(path.join(ROOT, 'lib/syncnet-market.js'));
const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
const mp = require(path.join(ROOT, 'netlify/functions/marketplace.js'));
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);

const VERIFIED_V2_RUNTIME_SHA256 = '226a042e6d68a69a6038d4fda211925b03eb5299399434b87a7877f79f6e3848'; // Blockscout, verified 2026-08-04
const T = {
  TEST: '0x52a03cd2fee18216ee45c66d9be8c0ee2cd8399b', // Pons V2 · bonding curve · native ETH
  PONSI: '0x7f241b9d177826bfc3e8aa9ab87f2d0ac911d164', // Pons V2 · graduated · native ETH
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // not a launch
  PONS: '0x39dbed3a2bd333467115de45665cc57f813c4571', // Pons V1 · LEGACY factory
  V1_ACTIVE_SAMPLE: '0x97133372cc4391a4f6889b4d52387649b76bc7ec', // Pons V1 · ACTIVE factory (TokenLaunched event)
};
const lc = (v) => String(v).toLowerCase();
const rpc = Chain.makeRpc(Chain.ROBINHOOD.rpcUrl, { retries: 5, timeoutMs: 20000 });
const pause = (ms) => new Promise((r) => setTimeout(r, ms)); // the public RPC rate-limits (429)
const results = []; let failures = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 600) }); if (!cond) failures++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (cond ? '' : ' :: ' + String(detail).slice(0, 300))); };
const out = { at: new Date().toISOString(), rpc: Chain.ROBINHOOD.rpcUrl, tokens: {}, marketplace: {} };

out.chainId = parseInt(await rpc('eth_chainId', []), 16); out.block = parseInt(await rpc('eth_blockNumber', []), 16);
check('1 chainId == 4663', out.chainId === 4663, out.chainId);
const code = lc(await Chain.getCode(rpc, Origins.PONS_V2_FACTORY));
out.v2RuntimeSha256 = crypto.createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
check('2 Pons V2 factory has code', code.length > 2, code.length);
check('3/4 live runtime bytecode == Blockscout-verified bytecode (sha256)', out.v2RuntimeSha256 === VERIFIED_V2_RUNTIME_SHA256, out.v2RuntimeSha256);
for (const k of ['getLaunchedToken', 'pendingCreatorFeeRecipient', 'transferCreatorFeeRecipient']) check(`4/7/8 selector ${k} ${Origins.SEL[k]} is in the live dispatcher`, code.includes('63' + Origins.SEL[k].slice(2)));

for (const [n, a] of Object.entries(T)) {
  await pause(1500);
  const p = await Origins.resolveProject(rpc, a);
  let lf; try { const h = await Chain.ethCall(rpc, a, Origins.SEL.launchFactory); lf = h && h !== '0x' ? lc(Core.abiDecode(['address'], h)[0]) : '(empty)'; } catch (e) { lf = e.revert ? '(reverts)' : 'ERR ' + e.message; }
  const { raw, ...rest } = p || {};
  out.tokens[n] = { address: a, tokenLaunchFactory: lf, resolved: p ? rest : null, raw: raw || null };
  if (p && p.supported) { await pause(800); out.tokens[n].feeRight = await Origins.classifyFeeRight(rpc, p); }
}
const r = (n) => out.tokens[n].resolved, raw = (n) => out.tokens[n].raw;
check('5 TEST → PONS_V2 / supported / bonding curve / native ETH', r('TEST') && r('TEST').origin === 'PONS_V2' && r('TEST').supported && r('TEST').state.code === 'NotGraduated' && r('TEST').pair.native, JSON.stringify(r('TEST')));
check('5 TEST record: token == TEST, pairToken == 0, no pending override', raw('TEST').token === T.TEST && raw('TEST').pairToken === '0x' + '00'.repeat(20) && r('TEST').pendingOverride === null);
check('6 PONSI → PONS_V2 / supported / graduated (PoolCreated) / native ETH', r('PONSI') && r('PONSI').origin === 'PONS_V2' && r('PONSI').supported && r('PONSI').state.code === 'PoolCreated' && r('PONSI').pair.native, JSON.stringify(r('PONSI')));
check('6 PONSI record: token == PONSI, pairToken == 0, no pending override', raw('PONSI').token === T.PONSI && raw('PONSI').pairToken === '0x' + '00'.repeat(20) && r('PONSI').pendingOverride === null);
check('9 WETH → unsupported (null)', r('WETH') === null);
check('10 PONS → PONS_V1 / detected / unsupported / LEGACY factory', r('PONS') && r('PONS').origin === 'PONS_V1' && r('PONS').supported === false && r('PONS').generation === 'LEGACY' && r('PONS').factory === Origins.PONS_V1_FACTORIES[1].address, JSON.stringify(r('PONS')));
check('10 control: an ACTIVE-factory V1 token → PONS_V1 / unsupported / ACTIVE factory', r('V1_ACTIVE_SAMPLE') && r('V1_ACTIVE_SAMPLE').origin === 'PONS_V1' && r('V1_ACTIVE_SAMPLE').supported === false && r('V1_ACTIVE_SAMPLE').generation === 'ACTIVE', JSON.stringify(r('V1_ACTIVE_SAMPLE')));

// real signed Marketplace attempts (throwaway key, in-memory store — nothing is persisted anywhere)
const key = '0x' + crypto.randomBytes(32).toString('hex'), W = lc(Core._internal.secp256k1.privateKeyToAddress(key));
const sign = (kind, m) => Core._internal.secp256k1.sign(Market.digest(kind, m), key);
const store = { ...createStore({ map: new Map(), env: {} }), durable: true, kind: 'live-check' };
const deps = { store, env: {}, rpc };
const ev = (body) => ({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '192.0.2.9' }, queryStringParameters: {}, body: JSON.stringify(body) });
const rnd = () => '0x' + crypto.randomBytes(32).toString('hex'), exp = (s) => Math.floor(Date.now() / 1000) + s;
for (const n of ['PONS', 'V1_ACTIVE_SAMPLE', 'WETH']) {
  await pause(1500);
  const m = { token: T[n], operator: W, basis: 'deployer', nonce: rnd(), expiry: exp(600) };
  const res = await mp._handler(ev({ action: 'claim', ...m, signature: sign('OperatorClaim', m) }), deps);
  out.marketplace[n + '_claim'] = { status: res.statusCode, body: JSON.parse(res.body) };
}
for (const n of ['PONS', 'V1_ACTIVE_SAMPLE']) {
  await pause(1500);
  await store.set('mp:passport:v1:' + T[n], JSON.stringify({ schema: 'syncnet.passport.v1', token: T[n], chainId: 4663, launchpad: 'PONS_V2', factory: Origins.PONS_V2_FACTORY, deployer: W, operator: W, claims: [], listing: null, history: [] }));
  const TERMS = { description: 'Live check: operational control of a project, community and site included.', included: [{ label: 'Website + domain', kind: 'manual' }], notIncluded: ['Token supply'], includeFeeRight: false };
  const m = { token: T[n], seller: W, price: '1.5', currency: 'ETH', termsHash: Market.hashJson(Market.normalizeTerms(TERMS).terms), nonce: rnd(), expiry: exp(86400) };
  const res = await mp._handler(ev({ action: 'list', ...m, terms: TERMS, signature: sign('Listing', m) }), deps);
  out.marketplace[n + '_list_with_planted_passport'] = { status: res.statusCode, body: JSON.parse(res.body) };
}
const M = out.marketplace;
check('10 real PONS claim refused: 422 unsupported_origin (PONS V1 DETECTED)', M.PONS_claim.status === 422 && M.PONS_claim.body.code === 'unsupported_origin', JSON.stringify(M.PONS_claim));
check('10 real ACTIVE V1 claim refused: 422 unsupported_origin', M.V1_ACTIVE_SAMPLE_claim.status === 422 && M.V1_ACTIVE_SAMPLE_claim.body.code === 'unsupported_origin', JSON.stringify(M.V1_ACTIVE_SAMPLE_claim));
check('9 real WETH claim refused: 422 not_par', M.WETH_claim.status === 422 && M.WETH_claim.body.code === 'not_par', JSON.stringify(M.WETH_claim));
check('10 real PONS listing refused even with a planted Passport', M.PONS_list_with_planted_passport.status === 422 && M.PONS_list_with_planted_passport.body.code === 'unsupported_origin', JSON.stringify(M.PONS_list_with_planted_passport));
check('10 real ACTIVE V1 listing refused even with a planted Passport', M.V1_ACTIVE_SAMPLE_list_with_planted_passport.status === 422 && M.V1_ACTIVE_SAMPLE_list_with_planted_passport.body.code === 'unsupported_origin', JSON.stringify(M.V1_ACTIVE_SAMPLE_list_with_planted_passport));

const passed = results.filter((x) => x.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/live/pons-step3-live.results.json'), JSON.stringify({ passed, failed: failures, results, evidence: out }, null, 2));
console.log(`${passed}/${results.length} live Pons Step 3 checks passed (chain ${out.chainId}, block ${out.block})`);
process.exit(failures ? 1 : 0);
