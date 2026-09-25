// Audit PoC for launch-engine-v2.js — AFTER version for the V2.5 release candidate.
// Same attacks as tests/audit/before/poc-engine.mjs (run against the original V2.5 build: 27/27 reproduced).
// The engine now needs lib/syncnet-core.js + lib/syncnet-chain.js and reads PAR live, so it runs in a VM against
// the stateful PAR mock of tests/e2e/harness.mjs (no network). Each line prints CONFIRMED when the ISSUE reproduces.
// Positive "calldata shape" checks must stay CONFIRMED; vulnerability checks must print not-reproduced.
// Run: node tests/audit/poc-engine.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { A, chain, resetChain, rpcHandle, Core } from '../e2e/harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viem = await import(pathToFileURL(path.join(ROOT, 'vendor/viem.js')).href);
const sandbox = { crypto: webcrypto, URL, console, TextEncoder, TextDecoder, setTimeout, clearTimeout, AbortController };
sandbox.window = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['lib/syncnet-core.js', 'lib/syncnet-chain.js', 'launch-engine-v2.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox);
const E = sandbox.window.SyncNetLaunchV2;

const ACCOUNT = A.WALLET;
const SYNC = A.SYNC.toLowerCase(), PONS = A.PONS.toLowerCase(), USDG = A.USDG.toLowerCase();
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const results = []; let reproduced = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail: String(detail).slice(0, 300) }); if (cond) reproduced++; console.log((cond ? 'CONFIRMED ' : 'not-reproduced ') + name + (detail ? ' :: ' + String(detail).slice(0, 200) : '')); };
const SEL_LAUNCH = '0x5a4b7ef0', SEL_LAUNCH_AND_BUY = '0x5fe889a4';

// viem public client whose transport is the stateful PAR mock.
const prevFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).startsWith('http://mock-rpc') ? new Response(JSON.stringify(rpcHandle(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } }) : prevFetch(url, init);
const client = viem.createPublicClient({ chain: viem.defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://mock-rpc/'] } } }), transport: viem.http('http://mock-rpc/', { retryCount: 0 }) });
const provider = { async request({ method }) { return method === 'eth_chainId' ? '0x1237' : [ACCOUNT]; } };
const base = (over = {}) => ({ account: ACCOUNT, name: 'Engine Test', symbol: 'ENGT', description: 'd', logo: 'ipfs://bafytest', twitter: '', website: '', tax: 100, feeMode: 'holders', quotes: [{ address: PONS, symbol: 'PONS' }, { address: SYNC, symbol: 'SYNC' }], openingBuyWei: '0', slippageBps: 100, ...over });
const prep = (draft) => E.prepare({ client, provider, draft, viem, chainId: 4663 });
const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };

// ---------------------------------------------------------------- 1. calldata shape (positive: must stay CONFIRMED)
resetChain();
{
  const p = await prep(base());
  const d = Core.decodeLaunchCalldata(p.request.data);
  check('direct path: selector is launchToken(TokenParams,uint256,address[]) = 0x5a4b7ef0', p.request.data.startsWith(SEL_LAUNCH));
  check('direct path: to = multi factory 0x3ea2…29C1, value = launchFee exactly (read live)', p.request.to === E.FACTORY && p.request.value === chain.fees.launchFee);
  check('direct path: pairTokens keep the chosen order (market index = quote index)', d.pairTokens[0] === PONS && d.pairTokens[1] === SYNC);
  check('F-TX1 expectedEconomics is 0x00…00 WITHOUT a documented reason (spot-priced markets)', /^0x0{64}$/.test(d.params.expectedEconomics) && !(p.economics.commitment.mode === 'waived' && p.economics.commitment.reason.length > 40), p.economics.commitment.mode + ': ' + p.economics.commitment.reason.slice(0, 120));
  check('salt = keccak(abi.encode("SYNCNET/1", keccak(intent JSON)))', d.params.salt === viem.keccak256(viem.encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], ['SYNCNET/1', viem.keccak256(viem.stringToHex(p.provenanceJson))])));
}
{
  chain.curated.add(PONS); chain.curated.add(SYNC);
  const p = await prep(base());
  const d = Core.decodeLaunchCalldata(p.request.data);
  check('F-TX1 expectedEconomics is 0x00…00 even when every market is PAR-curated (guard waived)', /^0x0{64}$/.test(d.params.expectedEconomics), d.params.expectedEconomics.slice(0, 18) + '… committed=' + (p.economics.commitment.mode === 'committed'));
  chain.curated.clear();
}
// ---------------------------------------------------------------- 2. opening buy legs (positive + edge)
{
  resetChain();
  // PONS: 2-hop route (PONS/USDG V3, then USDG/ETH V4) in pricer (sell) order; SYNC: no ETH route.
  chain.routeHops.set(PONS, [[PONS, USDG, 3000, 0, '0x0000000000000000000000000000000000000000', true], ['0x0000000000000000000000000000000000000000', USDG, 500, 10, '0x0000000000000000000000000000000000000000', false]]);
  chain.noRoute.add(SYNC);
  const buy = 10n ** 17n + 1n;
  const p = await prep(base({ openingBuyWei: String(buy), slippageBps: 200 }));
  const d = Core.decodeLaunchCalldata(p.request.data);
  check('router path: selector launchAndBuyWithEth = 0x5fe889a4, to = PairPadMultiRouter', p.request.data.startsWith(SEL_LAUNCH_AND_BUY) && p.request.to === E.ROUTER);
  check('router path: value = launchFee + opening buy', p.request.value === chain.fees.launchFee + buy);
  check('router path: unreachable market (SYNC) skipped and disclosed', d.legs.length === 1 && Number(d.legs[0].market) === 0 && p.openingBuy.unreachable.includes('SYNC'));
  check('router path: legs sum exactly to the buy (dust kept)', d.legs.reduce((a, l) => a + BigInt(l.amountIn), 0n) === buy);
  check('router path: hops reversed for a buy (ETH side first)', d.legs[0].hops[0].key.currency1 === USDG && d.legs[0].hops[0].v3 === false && d.legs[0].hops[1].v3 === true);
  check('router path: minTokensOut = simulated * (1 - 2%)', d.minTokensOut === (buy * 400000000n * 9800n) / 10000n);
  check('F-TX1 router path sends expectedEconomics = 0 without a documented reason', /^0x0{64}$/.test(d.params.expectedEconomics) && !(p.economics.commitment.reason || '').length);
  // route().qualifies must be honoured: hops present but qualifies=false → market skipped.
  chain.routeNotQualified.add(PONS);
  let msg = ''; try { await prep(base({ openingBuyWei: String(buy) })); } catch (e) { msg = e.message; }
  check('route().qualifies is ignored by the engine (only hops.length is used)', !/None of the selected markets can be reached/.test(msg), msg.slice(0, 120));
  resetChain();
}
// ---------------------------------------------------------------- 3. validation gaps vs PAR on-chain limits (L5)
{
  const name = '界'.repeat(40);
  const e1 = throws(() => E.normalize(base({ name })));
  check('F-TX2 name of 40 chars / ' + utf8(name) + ' UTF-8 bytes passes normalize (PAR limit 64 bytes)', !e1, e1);
  const desc = '界'.repeat(1000);
  const e2 = throws(() => E.normalize(base({ description: desc })));
  check('F-TX2 description of 1000 chars / ' + utf8(desc) + ' bytes passes (PAR limit 2048 bytes)', !e2, e2);
  const logo = 'https://example.com/' + 'a'.repeat(600);
  const e3 = throws(() => E.normalize(base({ logo })));
  check('F-TX2 https logo of ' + logo.length + ' chars passes (PAR limit 512 bytes)', !e3, e3);
  const website = 'https://example.com/' + 'b'.repeat(300);
  const e4 = throws(() => E.normalize(base({ website })));
  check('F-TX2 website of ' + website.length + ' chars passes (PAR social limit 256 bytes)', !e4, e4);
}
// ---------------------------------------------------------------- 4. invisible / bidi characters (L7)
{
  const hidden = 'Engine\u202e\u200b';
  const e1 = throws(() => E.normalize(base({ name: hidden })));
  check('F-C1 name with U+202E (RTL override) + U+200B (zero width) is accepted and would go on-chain', !e1, e1);
  const e2 = throws(() => E.normalize(base({ description: 'safe \u202eevil' })));
  check('F-C1 description with U+202E accepted', !e2, e2);
}
// ---------------------------------------------------------------- 5. unsafe fee recipients (L6)
{
  const bad = { router: E.ROUTER, poolManager: POOL_MANAGER, dead: '0x000000000000000000000000000000000000dEaD', weth: WETH, multiLocker: '0x5826FBB6201DaAcD924A3d292841DA9142952D59', feeEscrow: '0x1C27e8F0c2a754DB23ab1608fA09c068D54d4386' };
  for (const [k, a] of Object.entries(bad)) {
    const err = throws(() => E.normalize(base({ feeMode: 'creator', feeRecipient: a })));
    check(`F-TX3 creator fee recipient = ${k} (${a.slice(0, 10)}…) is accepted`, !err, err.slice(0, 120));
  }
}
// ---------------------------------------------------------------- 6. http:// website (L13 at creation)
{
  const err = throws(() => E.normalize(base({ website: 'http://ponsync.example:8080/' })));
  check('F-P5 http:// website with a custom port is accepted as permanent metadata', !err, err);
}
// ---------------------------------------------------------------- 7. info (documented limitation, not a vulnerability)
{
  const err = throws(() => E.normalize(base({ quotes: [{ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' }] })));
  check('info: native-ETH market (pairToken 0x0, allowed by PAR) cannot be selected', /invalid contract address/.test(err), err);
}

fs.writeFileSync(path.join(ROOT, 'tests/audit/poc-engine.json'), JSON.stringify({ at: new Date().toISOString(), version: 'v2.5-rc', results }, null, 2));
console.log(`\n${reproduced}/${results.length} reproduced (expected after the fixes: only the 10 positive calldata-shape checks and the 1 info check)`);
