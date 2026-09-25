// Audit PoC for launch-engine-v2.js (runs in Node, no browser, no network).
// Loads the real engine file into a VM with a mock PAR chain and inspects the exact calldata it builds.
// Run: node tests/audit/poc-engine.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viem = await import(pathToFileURL(path.join(ROOT, 'vendor/viem.js')).href);
const sandbox = { window: {}, crypto: webcrypto, URL, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'launch-engine-v2.js'), 'utf8'), sandbox);
const E = sandbox.window.SyncNetLaunchV2;

const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdef0001';
const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const PREDICTED = '0x7777777777777777777777777777777777777777';
const FEE = 500000000000000n; // 0.0005 ETH, par.family/docs

let results = []; let fails = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); if (!cond) fails++; console.log((cond ? 'CONFIRMED ' : 'not-reproduced ') + name + (detail ? ' :: ' + detail : '')); };

// Independent selectors (pure-Python keccak over the Solidity signatures, see audit notes).
const SEL_LAUNCH = '0x5a4b7ef0', SEL_LAUNCH_AND_BUY = '0x5fe889a4';

const TP = { name: 'params', type: 'tuple', components: [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'logo', type: 'string' }, { name: 'description', type: 'string' },
  { name: 'socials', type: 'tuple', components: ['twitter', 'telegram', 'discord', 'website', 'farcaster'].map((n) => ({ name: n, type: 'string' })) },
  { name: 'creatorFeeRecipient', type: 'address' }, { name: 'creatorTaxBps', type: 'uint16' }, { name: 'expectedEconomics', type: 'bytes32' }, { name: 'salt', type: 'bytes32' }] };
const KEY = { name: 'key', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const LEGS = { name: 'legs', type: 'tuple[]', components: [{ name: 'market', type: 'uint8' }, { name: 'hops', type: 'tuple[]', components: [KEY, { name: 'v3', type: 'bool' }] }, { name: 'amountIn', type: 'uint256' }] };
const dec = (types, data) => viem.decodeFunctionResult({ abi: [{ type: 'function', name: 'x', inputs: [], outputs: types }], functionName: 'x', data: '0x' + data.slice(10) });

// Mock chain. routes: quote -> hops (sell order, quote first), as PairPadQuotePricer.route returns them.
function mockClient({ routes = {}, tokensOut = 4n * 10n ** 26n } = {}) {
  const calls = [];
  return {
    calls,
    async getChainId() { return 4663; },
    async getBytecode() { return '0x6080'; },
    async estimateGas() { return 900000n; },
    async request({ method }) { return method === 'eth_getBalance' ? '0x' + (100n * 10n ** 18n).toString(16) : '0x5f5e100'; },
    async readContract({ functionName, args }) {
      switch (functionName) {
        case 'canLaunch': return true;
        case 'launchFee': return FEE;
        case 'baseFeeBps': return 100n;
        case 'maxCreatorTaxBps': return 1000n;
        case 'protocolFeeShareBps': return 5000n;
        case 'isPriceable': return true;
        case 'launchForwarder': return E.ROUTER;
        case 'route': return [routes[String(args[0]).toLowerCase()] || [], (routes[String(args[0]).toLowerCase()] || []).length > 0];
        default: throw new Error('unexpected read ' + functionName);
      }
    },
    async call(req) {
      calls.push(req);
      const s = req.data.slice(0, 10);
      if (s === SEL_LAUNCH) return { data: viem.encodeAbiParameters([{ type: 'address' }], [PREDICTED]) };
      if (s === SEL_LAUNCH_AND_BUY) return { data: viem.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [PREDICTED, tokensOut]) };
      throw new Error('unexpected call selector ' + s);
    },
  };
}
const provider = { async request({ method }) { return method === 'eth_chainId' ? '0x1237' : [ACCOUNT]; } };
const base = (over = {}) => ({ account: ACCOUNT, name: 'PONSYNC', symbol: 'PONSYNC', description: 'd', logo: 'ipfs://bafytest', twitter: '', website: '', tax: 100, feeMode: 'holders', quotes: [{ address: PONS, symbol: 'PONS' }, { address: SYNC, symbol: 'SYNC' }], openingBuyWei: '0', slippageBps: 100, ...over });
const prep = (draft, client = mockClient()) => E.prepare({ client, provider, draft, viem, chainId: 4663 });
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------- 1. calldata shape (positive checks)
{
  const c = mockClient(); const p = await prep(base(), c);
  check('direct path: selector is launchToken(TokenParams,uint256,address[]) = 0x5a4b7ef0', p.request.data.startsWith(SEL_LAUNCH));
  check('direct path: to = multi factory 0x3ea2…29C1, value = launchFee exactly', p.request.to === E.FACTORY && p.request.value === FEE);
  const d = dec([TP, { name: 'id', type: 'uint256' }, { name: 'pairTokens', type: 'address[]' }], p.request.data);
  check('direct path: pairTokens keep the chosen order (market index = quote index)', d[2][0].toLowerCase() === PONS && d[2][1].toLowerCase() === SYNC);
  check('F-TX1 expectedEconomics is always 0x00…00 (PAR economics guard waived)', /^0x0{64}$/.test(d[0].expectedEconomics), d[0].expectedEconomics);
  check('salt = keccak(abi.encode("SYNCNET/1", keccak(intent JSON)))', d[0].salt === viem.keccak256(viem.encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], ['SYNCNET/1', viem.keccak256(viem.stringToHex(p.provenanceJson))])));
}

// ---------------------------------------------------------------- 2. opening buy legs (positive checks + edge)
{
  // PONS: 2-hop route (PONS/USDG V3, USDG/WETH V4) in pricer (sell) order; SYNC: no ETH route.
  const hopA = { key: { currency0: PONS, currency1: USDG, fee: 3000, tickSpacing: 0, hooks: '0x0000000000000000000000000000000000000000' }, v3: true };
  const hopB = { key: { currency0: '0x0000000000000000000000000000000000000000', currency1: USDG, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' }, v3: false };
  const c = mockClient({ routes: { [PONS]: [hopA, hopB] } });
  const buy = 10n ** 17n + 1n; // 0.1 ETH + 1 wei
  const p = await prep(base({ openingBuyWei: String(buy), slippageBps: 200 }), c);
  const d = dec([TP, { name: 'id', type: 'uint256' }, { name: 'pairTokens', type: 'address[]' }, LEGS, { name: 'min', type: 'uint256' }], p.request.data);
  check('router path: selector launchAndBuyWithEth = 0x5fe889a4, to = PairPadMultiRouter', p.request.data.startsWith(SEL_LAUNCH_AND_BUY) && p.request.to === E.ROUTER);
  check('router path: value = launchFee + opening buy', p.request.value === FEE + buy);
  const legs = d[3];
  check('router path: unreachable market (SYNC) skipped and disclosed', legs.length === 1 && Number(legs[0].market) === 0 && p.openingBuy.unreachable.includes('SYNC'));
  check('router path: legs sum exactly to the buy (dust kept)', legs.reduce((a, l) => a + BigInt(l.amountIn), 0n) === buy);
  check('router path: hops reversed for a buy (ETH side first)', legs[0].hops[0].key.currency1.toLowerCase() === USDG.toLowerCase() && legs[0].hops[0].v3 === false && legs[0].hops[1].v3 === true);
  check('router path: minTokensOut = simulated * (1 - 2%)', d[4] === (4n * 10n ** 26n * 9800n) / 10000n);
  check('F-TX1 router path also sends expectedEconomics = 0', /^0x0{64}$/.test(d[0].expectedEconomics));
  // qualifies flag from pricer.route() is not read; isPriceable is read separately (a different call/block).
  check('route().qualifies is ignored by the engine (only hops.length is used)', /hops\.length\)reachable/.test(fs.readFileSync(path.join(ROOT, 'launch-engine-v2.js'), 'utf8')));
}

// ---------------------------------------------------------------- 3. validation gaps vs PAR on-chain limits
{
  // PairPadLaunchDeployer: name<=64 BYTES, symbol<=16, logo<=512, description<=2048, each social<=256 (bytes).
  const name = '界'.repeat(40);
  const n = E.normalize(base({ name }));
  check('F-TX2 name of 40 chars / ' + utf8(name) + ' UTF-8 bytes passes normalize (PAR limit 64 bytes → MetadataTooLong at simulation)', n.name === name && utf8(n.name) > 64);
  const desc = '界'.repeat(1000);
  check('F-TX2 description of 1000 chars / ' + utf8(desc) + ' bytes passes (PAR limit 2048 bytes)', E.normalize(base({ description: desc })).description.length === 1000);
  const logo = 'https://example.com/' + 'a'.repeat(600);
  check('F-TX2 https logo of ' + logo.length + ' chars passes (PAR limit 512 bytes)', E.normalize(base({ logo })).logo.length > 512);
  const website = 'https://example.com/' + 'b'.repeat(300);
  check('F-TX2 website of ' + website.length + ' chars passes (PAR social limit 256 bytes)', E.normalize(base({ website })).website.length > 256);
}
{
  const hidden = 'PONSYNC\u202e\u200b';
  check('F-C1 name with U+202E (RTL override) + U+200B (zero width) is accepted and would go on-chain', E.normalize(base({ name: hidden })).name === hidden);
  check('F-C1 description with U+202E accepted', E.normalize(base({ description: 'safe \u202eevil' })).description.includes('\u202e'));
}
{
  const bad = { router: E.ROUTER, poolManager: POOL_MANAGER, dead: '0x000000000000000000000000000000000000dEaD', weth: WETH, multiLocker: '0x5826FBB6201DaAcD924A3d292841DA9142952D59', feeEscrow: '0x1C27e8F0c2a754DB23ab1608fA09c068D54d4386' };
  for (const [k, a] of Object.entries(bad)) {
    let ok = false; try { ok = E.normalize(base({ feeMode: 'creator', feeRecipient: a })).feeRecipient === a; } catch (e) { ok = false; }
    check(`F-TX3 creator fee recipient = ${k} (${a.slice(0, 10)}…) is accepted`, ok);
  }
}
{
  const w = E.normalize(base({ website: 'http://ponsync.example:8080/' })).website;
  check('F-P5 http:// website with a custom port is accepted as permanent metadata', w === 'http://ponsync.example:8080/', w);
}
{
  let err = ''; try { E.normalize(base({ quotes: [{ address: '0x0000000000000000000000000000000000000000', symbol: 'ETH' }] })); } catch (e) { err = e.message; }
  check('info: native-ETH market (pairToken 0x0, allowed by PAR) cannot be selected', /invalid contract address/.test(err), err);
}

fs.writeFileSync(path.join(ROOT, 'tests/audit/poc-engine.json'), JSON.stringify({ results }, null, 2));
console.log(`\n${results.length - fails}/${results.length} reproduced`);
