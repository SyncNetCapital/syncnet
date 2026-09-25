// SyncNet V2.5 RC local E2E harness.
// Static server + the REAL Netlify functions (config, canary-auth, ipfs-upload, upload-auth, launch-guard, registry)
// + a stateful mock of PAR on Robinhood Chain (factory, router, pricer, vaults, tokens, receipts, logs)
// + a mocked PAR indexer, Pinata, a pinning service and Upstash (durable store)
// + an EIP-1193 wallet that signs with real secp256k1 keys.
// Nothing here touches a real network: every outbound fetch of the server process is intercepted and every
// browser request to a third-party host is routed. Run: node tests/e2e/run.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
export const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
export const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const R = Chain.ROBINHOOD;
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x' + '00'.repeat(32);
const hex = (n) => '0x' + BigInt(n).toString(16);

// ---- test keys (never used anywhere real)
const KEY = { main: '0x' + '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', second: '0x' + '11'.repeat(32), owner: '0x' + '22'.repeat(32), attacker: '0x' + '33'.repeat(32) };
const addrOf = (k) => lc(Core._internal.secp256k1.privateKeyToAddress(k));
export const FOUNDER_KEY = 'founder-key-0123456789abcdef-0123456789abcdef';

export const A = {
  SYNC: '0x6368e007b9f0b941560ed1f3bceb20247f5eca37',
  SYNCAT: '0xb0a3d82Bf46AE6303Aee263fc4d48E5c657fC967',
  CASHCAT: '0x1111111111111111111111111111111111111111',
  NET: '0x2222222222222222222222222222222222222222',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
  PONS: '0x39dbed3a2bd333467115de45665cc57f813c4571',
  PONS_FAKE: '0x3333333333333333333333333333333333333333',
  EVIL: '0x4444444444444444444444444444444444444444',
  CREATORLIVE: '0x5555555555555555555555555555555555555555',
  NOCODE: '0x6666666666666666666666666666666666666666',
  FAKESYNC: '0x9999999999999999999999999999999999999999',
  RANDOM_CONTRACT: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  SAFE: '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe',
  OTHER_EOA: '0x1234567890123456789012345678901234567890',
  FACTORY: '0x3ea29975a79900179F3e1aEF93347Ba4210c29C1',
  HOLDER: '0x4B79B8298cd890A82dC9De1dE5dBb745Cf04353C',
  BURN: '0x16c83D36539b6C92E6FC998D2a039fD7Ff31958E',
  FLOOR: '0xA5e805856e513F01d6aC992aC45FE54E5e601829',
  ROUTER: '0x458D2a59c2F3dd32775a64eE72004561440d64Df',
  PRICER: '0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563',
  WALLET: addrOf(KEY.main),
  WALLET2: addrOf(KEY.second),
  SAFE_OWNER: addrOf(KEY.owner),
  ATTACKER: addrOf(KEY.attacker),
};
const KEY_BY_ADDR = new Map([[A.WALLET, KEY.main], [A.WALLET2, KEY.second], [A.SAFE_OWNER, KEY.owner], [A.ATTACKER, KEY.attacker]]);
export function signDigest(address, digest) {
  const k = KEY_BY_ADDR.get(lc(address));
  if (!k) throw new Error('no test key for ' + address);
  return Core._internal.secp256k1.sign(digest, k);
}

const now = Date.now();
const iso = (d) => new Date(now - d * 864e5).toISOString();
const m = (addr, sym) => ({ pairToken: addr, quoteSymbol: sym });
export const LAUNCHES = [
  { token: A.SYNCAT, name: 'SYNCAT', symbol: 'SYNCAT', createdAt: iso(20), deployer: A.WALLET, feeMode: 'holders', markets: [m(A.CASHCAT, 'CASHCAT'), m(A.SYNC, 'SYNC')] },
  { token: A.SYNC, name: 'SyncNet', symbol: 'SYNC', createdAt: iso(40), deployer: A.WALLET, feeMode: 'creator', markets: [m(A.NET, 'NET'), m(A.USDG, 'USDG')] },
  { token: A.PONS, name: 'PONS', symbol: 'PONS', createdAt: iso(30), deployer: A.OTHER_EOA, feeMode: 'creator', markets: [m(ZERO, 'ETH')] },
  { token: A.PONS_FAKE, website: 'https://fakepons.example', name: 'PONS', symbol: 'PONS', deployer: A.ATTACKER, createdAt: iso(2), feeMode: 'holders', markets: [m(A.SYNC, 'SYNC')] },
  { token: A.EVIL, name: '\u202eEVIL' + 'X'.repeat(400), symbol: '\u200bSYNC\u202e' + 'Y'.repeat(300), deployer: A.ATTACKER, createdAt: iso(1), markets: [m(A.SYNC, 'SYNC')] },
  { token: A.FAKESYNC, name: 'SyncNet', symbol: 'SYNC', deployer: A.ATTACKER, createdAt: iso(1), feeMode: 'creator', markets: [m(A.USDG, 'USDG')] },
  { token: A.CREATORLIVE, website: 'https://oplive.example/', name: 'Operator Live', symbol: 'OPLIVE', deployer: A.WALLET, createdAt: iso(3), feeMode: 'creator', creatorFeeRecipient: A.WALLET, markets: [m(A.CASHCAT, 'CASHCAT')] },
  ...Array.from({ length: 6 }, (_, i) => ({ token: '0x8' + String(i).repeat(39), name: 'Cat Friend ' + i, symbol: 'CATF' + i, deployer: A.OTHER_EOA, createdAt: iso(i + 1), feeMode: 'holders', markets: [m(A.CASHCAT, 'CASHCAT'), m(A.SYNC, 'SYNC')] })),
];
const byAddr = new Map(LAUNCHES.map((l) => [lc(l.token), l]));
const ERC = { [lc(A.SYNC)]: ['SyncNet', 'SYNC'], [lc(A.USDG)]: ['Global Dollar', 'USDG'], [lc(A.PONS)]: ['PONS', 'PONS'], [lc(A.CASHCAT)]: ['CASHCAT', 'CASHCAT'], [lc(A.SYNCAT)]: ['SYNCAT', 'SYNCAT'], [lc(A.NET)]: ['NET', 'NET'], [lc(A.FAKESYNC)]: ['SyncNet', 'SYNC'], [lc(A.RANDOM_CONTRACT)]: ['Random', 'RND'] };

// ---- mutable chain state
const SUPPLY = 10n ** 27n;
const TOKENS_PER_WEI = 400000000n; // 1 ETH -> 4e26 tokens (40% of supply) in the mock pool
function freshChain() {
  return {
    tokens: new Map(), // token -> {deployer, params, pairTokens, buy, txHash, block}
    txs: new Map(), // hash -> {tx, receipt}
    pending: new Map(), // hash -> {tx, run}  broadcast but not mined
    nonces: new Map(),
    block: 0x100,
    fees: { launchFee: 100000000000000n, baseFeeBps: 100n, protocolFeeShareBps: 5000n, maxCreatorTaxBps: 1000n },
    configEnabled: true, canLaunch: true, forwarder: null, factoryPricer: null, spotEpoch: 0, curated: new Set(), noRoute: new Set(),
    routeHooks: new Map(), allowedHooks: new Set(), routeNotQualified: new Set(), routeHops: new Map(), balanceWei: 100n * 10n ** 18n, factoryOverride: null,
    sendMode: 'ok', lastLaunchCall: null, lastRouterCall: null, lastSentTo: null, lastSentValue: 0n, lastPredicted: null, sent: [],
    rpcDown: false, indexerDown: false, indexerLag: false, sendDelayMs: 0,
  };
}
export const chain = freshChain();
export function resetChain() { Object.assign(chain, freshChain()); }

class Revert extends Error {}
const CONTRACTS = new Set([A.SYNC, A.SYNCAT, A.CASHCAT, A.NET, A.USDG, A.PONS, A.PONS_FAKE, A.EVIL, A.CREATORLIVE, A.FAKESYNC, A.RANDOM_CONTRACT, A.SAFE, R.multiFactory, R.multiRouter, R.quotePricer, R.holderVault, R.burnVault, R.floorVault, R.factory, R.weth, R.poolManager, R.swapRouter02, R.feeEscrow, ...LAUNCHES.map((l) => l.token)].map(lc));
function hasCode(a) {
  a = lc(a);
  if (chain.tokens.has(a)) return true;
  return CONTRACTS.has(a);
}
export function predictedFor(deployer, salt) {
  return '0x' + Core.keccak256(Core.abiEncode(['address', 'bytes32'], [lc(deployer), salt])).slice(-40);
}
function phantomFor(q) { return chain.curated.has(lc(q)) ? 10n ** 21n : 10n ** 20n + BigInt(chain.spotEpoch) * 7n; }
function economicsDigest(pairTokens) {
  return Core.keccak256(Core.abiEncode(['uint256[]', 'uint256', 'int24', 'uint256', 'uint256'], [pairTokens.map(phantomFor), SUPPLY, 200n, chain.fees.baseFeeBps, chain.fees.protocolFeeShareBps]));
}
const LIMITS = { name: 64, symbol: 16, logo: 512, description: 2048, social: 256 };
function checkLaunch(from, value, d, viaRouter) {
  const p = d.params;
  if (!chain.configEnabled) throw new Revert('LaunchConfigDisabled');
  if (!chain.canLaunch) throw new Revert('LaunchNotAllowed');
  if (!viaRouter && BigInt(value || 0) !== chain.fees.launchFee) throw new Revert('InsufficientLaunchValue');
  if (BigInt(p.creatorTaxBps) > chain.fees.maxCreatorTaxBps) throw new Revert('CreatorTaxTooHigh');
  const b = (s) => Buffer.byteLength(String(s), 'utf8');
  if (b(p.name) > LIMITS.name || b(p.name) === 0 || b(p.symbol) > LIMITS.symbol || b(p.symbol) === 0 || b(p.logo) > LIMITS.logo || b(p.description) > LIMITS.description) throw new Revert('MetadataTooLong');
  for (const k of ['twitter', 'telegram', 'discord', 'website', 'farcaster']) if (b(p.socials[k]) > LIMITS.social) throw new Revert('MetadataTooLong');
  if (!d.pairTokens.length || d.pairTokens.length > 5) throw new Revert('BadMarkets');
  if (new Set(d.pairTokens.map(lc)).size !== d.pairTokens.length) throw new Revert('DuplicateMarket');
  if (d.pairTokens.some((q) => lc(q) === lc(A.NOCODE))) throw new Revert('NotPriceable');
  if (lc(p.creatorFeeRecipient) === ZERO) throw new Revert('ZeroRecipient');
  if (p.expectedEconomics !== ZERO32 && lc(p.expectedEconomics) !== lc(economicsDigest(d.pairTokens))) throw new Revert('EconomicsChanged');
  const token = predictedFor(from, p.salt);
  if (chain.tokens.has(token)) throw new Revert('TokenAlreadyLaunched');
  return token;
}
function routerQuote(from, value, d) {
  value = BigInt(value || 0);
  if (value < chain.fees.launchFee) throw new Revert('InsufficientLaunchValue');
  const buy = value - chain.fees.launchFee;
  const sum = d.legs.reduce((a, l) => a + BigInt(l.amountIn), 0n);
  if (buy !== sum) throw new Revert('NativeValueMismatch');
  const token = checkLaunch(from, value, d, true);
  const tokensOut = buy * TOKENS_PER_WEI;
  if (BigInt(d.minTokensOut) > tokensOut) throw new Revert('SlippageExceeded');
  return { ...d, token, value, tokensOut };
}

const S = {};
for (const sig of ['transferCreatorFeeRecipient(address,address)', 'launchForwarder()', 'route(address)', 'balanceOf(address)', 'name()', 'symbol()', 'decimals()', 'totalSupply()', 'canLaunch(address)', 'launchFee()', 'baseFeeBps()',
  'maxCreatorTaxBps()', 'protocolFeeShareBps()', 'isPriceable(address)', 'getLaunchedToken(address)', 'getMarkets(address)', 'logo()', 'description()', 'socials()', 'deployer()', 'launchFactory()',
  'contractURI()', 'weth()', 'quotePricer()', 'factory()', 'swapRouter()', 'manager()', 'launchEnabled()', 'owner()', 'getLaunchConfig(uint256)', 'pairTokenEconomics(address)',
  'previewLaunchEconomics(uint256,address[])', 'previewQuoteEconomics(uint256,address[])', 'escrow()', 'multiFactory()', 'allowedV4Hooks(address)', 'isValidSignature(bytes32,bytes)']) S[sig.split('(')[0]] = Core.functionSelector(sig);
S.launchToken = Core.LAUNCH_SELECTORS ? Core.functionSelector(Core.LAUNCH_SIGNATURES.launchToken) : null;
S.launchAndBuyWithEth = Core.functionSelector(Core.LAUNCH_SIGNATURES.launchAndBuyWithEth);
const enc = (types, vals) => Core.abiEncode(types, vals);
const MULTI_RECORD = ['address', 'address', 'address', 'uint24', 'int24', 'uint16', 'uint16', 'uint16', 'address', 'uint64', 'uint8', 'bool'];
const SINGLE_ZERO = '0x' + '00'.repeat(32 * 17);
function multiRecord(t) {
  t = lc(t);
  const f = chain.fees;
  if (chain.tokens.has(t)) {
    const x = chain.tokens.get(t); const p = x.params;
    return enc(MULTI_RECORD, [t, x.deployer, chain.factoryOverride || p.creatorFeeRecipient, Number((x.baseFeeBps + BigInt(p.creatorTaxBps)) * 100n), 200, Number(x.baseFeeBps), Number(p.creatorTaxBps), Number(x.protocolFeeShareBps), R.feeEscrow, BigInt(x.block), x.pairTokens.length, true]);
  }
  if (byAddr.has(t)) {
    const l = byAddr.get(t);
    const rcp = l.creatorFeeRecipient || (l.feeMode === 'holders' ? A.HOLDER : l.feeMode === 'burn' ? A.BURN : l.feeMode === 'floor' ? A.FLOOR : l.deployer || A.WALLET);
    return enc(MULTI_RECORD, [t, l.deployer || A.WALLET, rcp, Number((f.baseFeeBps + 100n) * 100n), 200, Number(f.baseFeeBps), 100, Number(f.protocolFeeShareBps), R.feeEscrow, 1n, l.markets.length, true]);
  }
  return enc(MULTI_RECORD, [ZERO, ZERO, ZERO, 0, 0, 0, 0, 0, ZERO, 0n, 0, false]);
}
function marketsOf(t) {
  t = lc(t);
  const MARKET = '(address,uint256,int24,int24,uint128,uint256)[]';
  if (chain.tokens.has(t)) return enc([MARKET], [chain.tokens.get(t).pairTokens.map((a, i) => [lc(a), phantomFor(a), -887200, 887200, 10n ** 20n, BigInt(1000 + i)])]);
  if (byAddr.has(t)) return enc([MARKET], [byAddr.get(t).markets.map((mk, i) => [lc(mk.pairToken), 10n ** 20n, -887200, 887200, 10n ** 20n, BigInt(2000 + i)])]);
  return enc([MARKET], [[]]);
}
function ethCall(call) {
  if (chain.rpcDown) throw new Error('rpc down');
  const to = lc(call.to); const data = String(call.data || call.input || '0x'); const s = data.slice(0, 10); const args = '0x' + data.slice(10);
  const from = lc(call.from || ZERO);
  const arg0 = () => lc('0x' + data.slice(34, 74));
  // launches
  if (s === S.launchAndBuyWithEth) {
    if (to !== lc(R.multiRouter)) throw new Revert('wrong router');
    const d = Core.decodeLaunchCalldata(data); const q = routerQuote(from, call.value, d);
    chain.lastRouterCall = q; chain.lastPredicted = q.token;
    return enc(['address', 'uint256'], [q.token, q.tokensOut]);
  }
  if (s === S.launchToken) {
    if (to !== lc(R.multiFactory)) throw new Revert('wrong factory');
    const d = Core.decodeLaunchCalldata(data); const token = checkLaunch(from, call.value, d, false);
    chain.lastLaunchCall = d; chain.lastPredicted = token;
    return enc(['address'], [token]);
  }
  // factory
  if (to === lc(R.multiFactory)) {
    if (s === S.launchForwarder) return enc(['address'], [chain.forwarder || R.multiRouter]);
    if (s === S.weth) return enc(['address'], [R.weth]);
    if (s === S.quotePricer) return enc(['address'], [chain.factoryPricer || R.quotePricer]);
    if (s === S.launchFee) return enc(['uint256'], [chain.fees.launchFee]);
    if (s === S.baseFeeBps) return enc(['uint256'], [chain.fees.baseFeeBps]);
    if (s === S.protocolFeeShareBps) return enc(['uint256'], [chain.fees.protocolFeeShareBps]);
    if (s === S.maxCreatorTaxBps) return enc(['uint256'], [chain.fees.maxCreatorTaxBps]);
    if (s === S.launchEnabled) return enc(['bool'], [true]);
    if (s === S.owner) return enc(['address'], ['0x00000000000000000000000000000000000000fa']);
    if (s === S.getLaunchConfig) return enc(['(uint256,uint256,int24,bool)'], [[SUPPLY, 10n ** 18n, 200, chain.configEnabled]]);
    if (s === S.canLaunch) return enc(['bool'], [chain.canLaunch]);
    if (s === S.pairTokenEconomics) { const q = arg0(); return enc(['uint256', 'uint8'], [chain.curated.has(q) ? 10n ** 21n : 0n, 18]); }
    if (s === S.previewLaunchEconomics) { const [, pts] = Core.abiDecode(['uint256', 'address[]'], args); return enc(['bytes32'], [economicsDigest(pts)]); }
    if (s === S.previewQuoteEconomics) { const [, pts] = Core.abiDecode(['uint256', 'address[]'], args); return enc(['uint256[]'], [pts.map(phantomFor)]); }
    if (s === S.getLaunchedToken) return multiRecord(arg0());
    if (s === S.getMarkets) return marketsOf(arg0());
  }
  if (to === lc(R.factory) && s === S.getLaunchedToken) return SINGLE_ZERO;
  if (to === lc(R.multiRouter)) {
    if (s === S.factory) return enc(['address'], [R.multiFactory]);
    if (s === S.weth) return enc(['address'], [R.weth]);
    if (s === S.swapRouter) return enc(['address'], [R.swapRouter02]);
    if (s === S.manager) return enc(['address'], [R.poolManager]);
  }
  if (to === lc(R.quotePricer)) {
    if (s === S.isPriceable) return enc(['bool'], [arg0() !== lc(A.NOCODE)]);
    if (s === S.allowedV4Hooks) return enc(['bool'], [chain.allowedHooks.has(arg0())]);
    if (s === S.route) {
      const q = arg0(); const T = ['((address,address,uint24,int24,address),bool)[]', 'bool'];
      if (chain.noRoute.has(q)) return enc(T, [[], false]);
      if (chain.routeHops.has(q)) return enc(T, [chain.routeHops.get(q).map((h) => [[h[0], h[1], h[2], h[3], h[4]], h[5]]), !chain.routeNotQualified.has(q)]);
      return enc(T, [[[[ZERO, q, 10000, 200, chain.routeHooks.get(q) || ZERO], false]], !chain.routeNotQualified.has(q)]);
    }
  }
  if (to === lc(R.holderVault) && s === S.escrow) return enc(['address'], [R.feeEscrow]);
  if ((to === lc(R.burnVault) || to === lc(R.floorVault)) && s === S.multiFactory) return enc(['address'], [R.multiFactory]);
  if (to === lc(A.SAFE) && s === S.isValidSignature) {
    const [digest, sig] = Core.abiDecode(['bytes32', 'bytes'], args);
    let ok = false; try { ok = lc(Core.recoverAddress(digest, sig)) === A.SAFE_OWNER; } catch { ok = false; }
    return ok ? '0x1626ba7e' + '00'.repeat(28) : '0xffffffff' + '00'.repeat(28);
  }
  // launched tokens
  if (chain.tokens.has(to)) {
    const x = chain.tokens.get(to); const p = x.params;
    if (s === S.name) return enc(['string'], [p.name]);
    if (s === S.symbol) return enc(['string'], [p.symbol]);
    if (s === S.decimals) return enc(['uint8'], [18]);
    if (s === S.totalSupply) return enc(['uint256'], [SUPPLY]);
    if (s === S.logo) return enc(['string'], [p.logo]);
    if (s === S.description) return enc(['string'], [p.description]);
    if (s === S.socials) return enc(['string', 'string', 'string', 'string', 'string'], [p.socials.twitter, p.socials.telegram, p.socials.discord, p.socials.website, p.socials.farcaster]);
    if (s === S.deployer) return enc(['address'], [x.deployer]);
    if (s === S.launchFactory) return enc(['address'], [R.multiFactory]);
    if (s === S.contractURI) return enc(['string'], ['data:application/json,{}']);
    if (s === S.balanceOf) return enc(['uint256'], [arg0() === x.deployer && x.buy ? x.buy.tokensOut : 0n]);
  }
  if (byAddr.has(to)) {
    const l = byAddr.get(to);
    if (s === S.socials) return enc(['string', 'string', 'string', 'string', 'string'], ['', '', '', l.website || '', '']);
    if (s === S.deployer) return enc(['address'], [l.deployer || A.WALLET]);
    if (s === S.launchFactory) return enc(['address'], [R.multiFactory]);
    if (s === S.description) return enc(['string'], [l.description || '']);
    if (s === S.logo) return enc(['string'], [l.logo || '']);
    if (s === S.decimals) return enc(['uint8'], [18]);
    if (s === S.totalSupply) return enc(['uint256'], [SUPPLY]);
  }
  if (s === S.name || s === S.symbol) { const e = ERC[to] || (byAddr.has(to) ? [byAddr.get(to).name, byAddr.get(to).symbol] : ['Token', 'TOKEN']); return enc(['string'], [s === S.name ? e[0] : e[1]]); }
  if (s === S.decimals) return enc(['uint8'], [18]);
  return '0x';
}

function nonceOf(a) { return chain.nonces.get(lc(a)) || 0; }
function mine(hash, tx, run) {
  chain.block += 1;
  let status = '0x1'; const logs = []; let token = null;
  try { token = run(); } catch (e) { if (!(e instanceof Revert)) throw e; status = '0x0'; }
  if (status === '0x1' && token) {
    const x = chain.tokens.get(token);
    logs.push({ address: lc(R.multiFactory), topics: [Chain.TOPIC.multiLaunched, '0x' + token.slice(2).padStart(64, '0'), '0x' + lc(tx.from).slice(2).padStart(64, '0')], data: enc(['uint256', 'uint24', 'address[]'], [0n, Number((x.baseFeeBps + BigInt(x.params.creatorTaxBps)) * 100n), x.pairTokens.map(lc)]), blockNumber: hex(chain.block), transactionHash: hash, logIndex: '0x0' });
  }
  const receipt = { transactionHash: hash, status, blockNumber: hex(chain.block), blockHash: '0x' + chain.block.toString(16).padStart(64, '0'), logs, gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x5f5e100', from: lc(tx.from), to: lc(tx.to), transactionIndex: '0x0', type: '0x2', contractAddress: null, logsBloom: '0x' + '0'.repeat(512) };
  const full = { hash, from: lc(tx.from), to: lc(tx.to), input: tx.data, value: hex(BigInt(tx.value || 0)), nonce: hex(tx.nonce), gas: tx.gas || '0x7a120', blockNumber: hex(chain.block), blockHash: receipt.blockHash, transactionIndex: '0x0', chainId: tx.chainId || '0x1237', type: '0x2' };
  chain.txs.set(hash, { tx: full, receipt });
  chain.pending.delete(hash);
  return receipt;
}
function executeLaunch(tx) {
  const from = lc(tx.from);
  const data = String(tx.data || '0x');
  if (data === '0x' || data === '') return () => null; // plain value transfer (Marketplace payments)
  if (data.startsWith(S.transferCreatorFeeRecipient)) {
    return () => {
      if (lc(tx.to) !== lc(R.multiFactory)) throw new Revert('wrong factory');
      const [token, newRecipient] = Core.abiDecode(['address', 'address'], '0x' + data.slice(10));
      const t = lc(token);
      const cur = chain.tokens.has(t) ? lc(chain.tokens.get(t).params.creatorFeeRecipient) : byAddr.has(t) ? lc(byAddr.get(t).creatorFeeRecipient || (byAddr.get(t).feeMode === 'holders' ? A.HOLDER : byAddr.get(t).feeMode === 'burn' ? A.BURN : byAddr.get(t).feeMode === 'floor' ? A.FLOOR : byAddr.get(t).deployer || A.WALLET)) : null;
      if (cur === null) throw new Revert('TokenNotFound');
      if (from !== cur) throw new Revert('NotCreatorFeeRecipient');
      if (chain.tokens.has(t)) chain.tokens.get(t).params.creatorFeeRecipient = lc(newRecipient);
      else byAddr.get(t).creatorFeeRecipient = lc(newRecipient);
      return null;
    };
  }
  const d = Core.decodeLaunchCalldata(data);
  return () => {
    let token, buy = null;
    if (lc(tx.to) === lc(R.multiRouter)) { const q = routerQuote(from, tx.value, d); token = q.token; buy = q; }
    else { if (lc(tx.to) !== lc(R.multiFactory)) throw new Revert('not a launch'); token = checkLaunch(from, tx.value, d, false); }
    if (chain.forceRevert) throw new Revert('forced');
    chain.tokens.set(token, { deployer: from, params: d.params, pairTokens: d.pairTokens.map(lc), buy, block: chain.block, baseFeeBps: chain.fees.baseFeeBps, protocolFeeShareBps: chain.fees.protocolFeeShareBps });
    return token;
  };
}
/** Called by the mock wallet for eth_sendTransaction. Returns a hash, or {__error:{code,message}}. */
export async function sendTx(tx) {
  if (chain.sendDelayMs) await new Promise((r) => setTimeout(r, chain.sendDelayMs));
  const mode = chain.sendMode;
  chain.sent.push({ ...tx, mode });
  chain.lastSentTo = lc(tx.to); chain.lastSentValue = BigInt(tx.value || 0);
  if (mode === 'reject') return { __error: { code: 4001, message: 'User rejected the request.' } };
  if (mode === 'error-no-broadcast') return { __error: { code: -32603, message: 'Internal JSON-RPC error.' } };
  const n = nonceOf(tx.from); chain.nonces.set(lc(tx.from), n + 1);
  const full = { ...tx, nonce: n };
  const hash = Core.keccak256(Core.abiEncode(['address', 'uint256', 'bytes32'], [lc(tx.from), BigInt(n), Core.keccak256(tx.data)]));
  const run = executeLaunch(full);
  if (mode === 'pending') { chain.pending.set(hash, { tx: full, run }); return hash; }
  mine(hash, full, run);
  if (mode === 'error-after-broadcast') return { __error: { code: -32603, message: 'Request failed after submission (connection lost).' } };
  if (mode === 'no-hash') return null;
  return hash;
}
/** Mines every pending transaction (receipt-timeout tests). */
export function minePending() { for (const [hash, p] of [...chain.pending]) mine(hash, p.tx, p.run); }

export const rpcStats = { mainnet: 0, fork: 0, server: 0 };
export function rpcHandle(body, chainHex = '0x1237') {
  const one = (q) => {
    const { method, params = [], id } = q; let result;
    if (chain.rpcDown) return { jsonrpc: '2.0', id, error: { code: -32000, message: 'upstream unavailable' } };
    try {
      switch (method) {
        case 'eth_chainId': result = chainHex; break;
        case 'eth_blockNumber': result = hex(chain.block); break;
        case 'eth_getCode': result = hasCode(params[0]) ? '0x6080604052' : '0x'; break;
        case 'eth_call': result = ethCall(params[0]); break;
        case 'eth_getBalance': result = hex(chain.balanceWei); break;
        case 'eth_gasPrice': result = '0x5f5e100'; break;
        case 'eth_maxPriorityFeePerGas': result = '0x0'; break;
        case 'eth_estimateGas': ethCall(params[0]); result = '0x7a120'; break;
        case 'eth_getTransactionCount': result = hex(nonceOf(params[0]) + (params[1] === 'pending' ? chain.pending.size : 0)); break;
        case 'eth_getTransactionReceipt': result = chain.txs.get(params[0])?.receipt || null; break;
        case 'eth_getTransactionByHash': { const h = params[0]; const t = chain.txs.get(h); if (t) result = t.tx; else if (chain.pending.has(h)) { const p = chain.pending.get(h).tx; result = { hash: h, from: lc(p.from), to: lc(p.to), input: p.data, value: hex(BigInt(p.value || 0)), nonce: hex(p.nonce), blockNumber: null, blockHash: null, transactionIndex: null }; } else result = null; break; }
        case 'eth_getBlockByNumber': { const n = params[0] === 'latest' ? chain.block : Number(params[0]); result = { number: hex(n), timestamp: hex(1758600000 + n), hash: '0x' + n.toString(16).padStart(64, '0'), baseFeePerGas: '0x5f5e100', transactions: [] }; break; }
        case 'eth_feeHistory': result = { oldestBlock: hex(chain.block), baseFeePerGas: ['0x5f5e100', '0x5f5e100'], gasUsedRatio: [0.5], reward: [['0x0']] }; break;
        default: result = null;
      }
    } catch (e) {
      if (e instanceof Revert) return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted: ' + e.message, data: '0x' } };
      return { jsonrpc: '2.0', id, error: { code: -32603, message: 'mock error: ' + e.message } };
    }
    return { jsonrpc: '2.0', id, result };
  };
  return Array.isArray(body) ? body.map(one) : one(body);
}

// ---- PAR indexer mock (browser and server share it)
function indexedRow(t) {
  t = lc(t);
  if (chain.tokens.has(t)) {
    if (chain.indexerLag) return null;
    const x = chain.tokens.get(t); const p = x.params;
    const txHash = [...chain.txs.entries()].find(([, v]) => v.receipt.logs.some((lg) => lc('0x' + lg.topics[1].slice(26)) === t))?.[0] || null;
    const rcp = lc(p.creatorFeeRecipient);
    const mode = rcp === lc(A.HOLDER) ? 'holders' : rcp === lc(A.BURN) ? 'burn' : rcp === lc(A.FLOOR) ? 'floor' : 'creator';
    return { token: t, name: p.name, symbol: p.symbol, deployer: x.deployer, feeMode: mode, creatorTaxBps: Number(p.creatorTaxBps), creatorFeeRecipient: rcp, logo: p.logo, description: p.description, socials: p.socials, launchTx: txHash, createdAt: Math.floor(Date.now() / 1000), marketCount: x.pairTokens.length, markets: x.pairTokens.map((a, i) => ({ index: i, pairToken: a })) };
  }
  return byAddr.has(t) ? { ...byAddr.get(t), token: lc(byAddr.get(t).token), deployer: lc(byAddr.get(t).deployer || '') } : null;
}
export function indexerHandle(urlString) {
  const u = new URL(urlString);
  if (chain.indexerDown) return { status: 503, json: { error: 'unavailable' } };
  if (u.pathname === '/launches/count') return { status: 200, json: { launched: LAUNCHES.length + chain.tokens.size, count: LAUNCHES.length + chain.tokens.size } };
  if (u.pathname === '/launches') {
    let rows = [...LAUNCHES.map((l) => indexedRow(l.token)), ...[...chain.tokens.keys()].map(indexedRow)].filter(Boolean);
    const dep = u.searchParams.get('deployer'); const q = u.searchParams.get('q');
    if (dep) rows = rows.filter((r) => lc(r.deployer) === lc(dep));
    if (q) rows = rows.filter((r) => lc(r.symbol).includes(lc(q)) || lc(r.name).includes(lc(q)) || lc(r.token) === lc(q));
    const limit = Number(u.searchParams.get('limit') || 100);
    return { status: 200, json: rows.slice(0, limit) };
  }
  const mm = u.pathname.match(/^\/launches\/(0x[a-fA-F0-9]{40})$/);
  if (mm) { const row = indexedRow(mm[1]); return row ? { status: 200, json: row } : { status: 404, json: { error: 'not found' } }; }
  return { status: 404, json: {} };
}

// ---- server-side state, flags and fakes
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
/** A real CIDv1 (raw, sha2-256, base32) for some bytes, like Pinata returns with cidVersion 1. */
export function cidFor(bytes) {
  const b = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash('sha256').update(bytes).digest()]);
  const ABC = 'abcdefghijklmnopqrstuvwxyz234567'; let bits = 0, val = 0, out = 'b';
  for (const x of b) { val = (val << 8) | x; bits += 8; while (bits >= 5) { bits -= 5; out += ABC[(val >> bits) & 31]; } val &= (1 << bits) - 1; }
  return bits ? out + ABC[(val << (5 - bits)) & 31] : out;
}
/** The logo CID the browser tests type in (a valid CID; the old placeholder 'bafytestcid' is correctly refused by /api/ipfs-check). */
export const TEST_CID = cidFor(PNG);
export const serverState = { pins: [], secondary: [], logs: [], fixedIp: null, pinataDown: false, upstash: new Map(), upstashDown: false, gateways: { pinata: 'ok', ipfs: 'ok', dweb: 'ok' }, gatewayHits: [] };
// What the BROWSER sees when an <img> asks a public gateway (rc-ipfs-display drives the fallback chain with this).
export const browserGateways = { pinata: 'ok', ipfs: 'ok', dweb: 'ok', hits: [] };
const BASE_ENV = {
  SYNCNET_CANARY_KEY: FOUNDER_KEY, SYNCNET_UPLOAD_KEY: 'u'.repeat(48), PINATA_JWT: 'test-pinata-jwt', SYNCNET_LOG_SALT: 'e2e-salt',
  UPSTASH_REDIS_REST_URL: 'https://upstash.mock', UPSTASH_REDIS_REST_TOKEN: 'upstash-test-token',
  SYNCNET_PIN_SECONDARY_URL: 'https://psa.mock', SYNCNET_PIN_SECONDARY_TOKEN: 'psa-token',
};
const FLAG_ENV = ['SYNCNET_PUBLIC_LAUNCH', 'SYNCNET_PUBLIC_UPLOADS', 'SYNCNET_REGISTRY_SUBMISSIONS', 'SYNCNET_UPLOADS_DISABLED', 'SYNCNET_ECONOMY_CURATION', 'SYNCNET_ECONOMIES_DISABLED'];
export function setFlags({ publicLaunch = false, publicUploads = false, registry = false, uploadsDisabled = false, economyCuration = false, durable = true } = {}) {
  Object.assign(process.env, BASE_ENV);
  for (const k of FLAG_ENV) delete process.env[k];
  if (publicLaunch) process.env.SYNCNET_PUBLIC_LAUNCH = 'true';
  if (publicUploads) process.env.SYNCNET_PUBLIC_UPLOADS = 'true';
  if (registry) process.env.SYNCNET_REGISTRY_SUBMISSIONS = 'true';
  if (uploadsDisabled) process.env.SYNCNET_UPLOADS_DISABLED = 'true';
  if (economyCuration) process.env.SYNCNET_ECONOMY_CURATION = 'true';
  const store = require(path.join(ROOT, 'netlify/lib/store.js'));
  store.getStore(durable ? { env: process.env } : { env: {} });
}
export function resetServer() { serverState.pins = []; serverState.secondary = []; serverState.logs = []; serverState.fixedIp = null; serverState.pinataDown = false; serverState.upstash.clear(); serverState.upstashDown = false; serverState.gateways = { pinata: 'ok', ipfs: 'ok', dweb: 'ok' }; serverState.gatewayHits = []; browserGateways.pinata = 'ok'; browserGateways.ipfs = 'ok'; browserGateways.dweb = 'ok'; browserGateways.hits = []; ipfsCheckFn()._internals.passed.clear(); setFlags(); }

// Upstash REST emulation (the subset store.js uses).
function upstashExec(cmd) {
  const [op, key, ...rest] = cmd.map(String); const U = serverState.upstash; const t = Date.now();
  const live = (k) => { const e = U.get(k); if (e && e.exp && e.exp <= t) { U.delete(k); return null; } return e || null; };
  switch (op.toUpperCase()) {
    case 'INCR': { const e = live(key); const n = (e ? parseInt(e.v, 10) : 0) + 1; U.set(key, { v: String(n), exp: e ? e.exp : 0 }); return n; }
    case 'EXPIRE': { const e = live(key); if (!e) return 0; if (rest[1] === 'NX' && e.exp) return 0; e.exp = t + Number(rest[0]) * 1000; return 1; }
    case 'GET': { const e = live(key); return e && !e.set ? e.v : null; }
    case 'SET': { U.set(key, { v: rest[0], exp: rest[1] === 'EX' ? t + Number(rest[2]) * 1000 : 0 }); return 'OK'; }
    case 'DEL': return U.delete(key) ? 1 : 0;
    case 'SADD': { const e = live(key) || { set: new Set(), exp: 0 }; const had = e.set.has(rest[0]); e.set.add(rest[0]); U.set(key, e); return had ? 0 : 1; }
    case 'SMEMBERS': { const e = live(key); return e && e.set ? [...e.set] : []; }
    default: return null;
  }
}
const realFetch = globalThis.fetch;
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function serverFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const u = new URL(url);
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return realFetch(input, init); // the test's own static server
  if (u.hostname === 'upstash.mock') {
    if (serverState.upstashDown) return jsonResponse(503, { error: 'down' });
    const body = JSON.parse(init.body || '[]');
    if (u.pathname === '/pipeline') return jsonResponse(200, body.map((c) => ({ result: upstashExec(c) })));
    return jsonResponse(200, { result: upstashExec(body) });
  }
  if (u.hostname === 'api.par.family') { const r = indexerHandle(url); return jsonResponse(r.status, r.json); }
  if (u.hostname === 'rpc.mainnet.chain.robinhood.com') { rpcStats.server++; return jsonResponse(200, rpcHandle(JSON.parse(init.body || '{}'))); }
  if (u.hostname === 'api.pinata.cloud') {
    if (serverState.pinataDown) return jsonResponse(500, { error: { reason: 'INTERNAL', details: 'pinata internal stack trace 0xdeadbeef' } });
    const file = init.body.get('file'); const buf = Buffer.from(await file.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest();
    const cid = cidFor(buf);
    serverState.pins.push({ type: file.type, size: buf.length, hasExif: buf.includes(Buffer.from('Exif')), hasText: /tEXt|iTXt|zTXt|eXIf/.test(buf.toString('latin1')), cid, auth: (init.headers || {}).Authorization, meta: JSON.parse(init.body.get('pinataMetadata')) });
    return jsonResponse(200, { IpfsHash: cid, PinSize: buf.length });
  }
  if (u.hostname === 'psa.mock') { serverState.secondary.push(JSON.parse(init.body)); return jsonResponse(202, { requestid: 'r1', status: 'queued' }); }
  if (u.hostname === 'gateway.pinata.cloud' || u.hostname === 'ipfs.io' || u.hostname === 'dweb.link' || /\.ipfs\.dweb\.link$/.test(u.hostname)) return gatewayFetch(u, init);
  throw new Error('BLOCKED outbound fetch in tests: ' + url);
}
// IPFS gateways as seen by the ipfs-check function. serverState.gateways.{pinata,ipfs,dweb}: ok | down | 429 | html | timeout.
// Like the real dweb.link, the apex answers path requests with a redirect to its <cid>.ipfs.dweb.link subdomain gateway.
async function gatewayFetch(u, init = {}) {
  serverState.gatewayHits.push(u.hostname + u.pathname);
  const mode = u.hostname === 'gateway.pinata.cloud' ? serverState.gateways.pinata : u.hostname === 'ipfs.io' ? serverState.gateways.ipfs : serverState.gateways.dweb;
  if (mode === '429') return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60' } });
  if (mode === 'timeout') return new Promise((_, reject) => { const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); if (init.signal?.aborted) fail(); else init.signal?.addEventListener('abort', fail); });
  if (mode === 'down') return new Response('upstream 504: internal gateway trace 0xdeadbeef', { status: 504 });
  if (mode === 'html') return new Response('<!doctype html><html><body>gateway error page</body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.hostname === 'dweb.link') { const m = u.pathname.match(/^\/ipfs\/([A-Za-z0-9]+)(\/.*)?$/); return new Response('', { status: 301, headers: { location: `https://${m[1].toLowerCase()}.ipfs.dweb.link${m[2] || '/'}` } }); }
  return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
}
globalThis.fetch = serverFetch;
export { realFetch };

// Function logs go to serverState.logs instead of the console.
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) { try { serverState.logs.push(JSON.parse(a[0])); } catch { serverState.logs.push(a[0]); } return; } origLog(...a); };

const FUNCTIONS = ['config', 'canary-auth', 'ipfs-upload', 'upload-auth', 'launch-guard', 'registry', 'par-tokenlist', 'ipfs-check', 'marketplace', 'economies'];
const fnModules = Object.fromEntries(FUNCTIONS.map((n) => [n, require(path.join(ROOT, 'netlify/functions', n + '.js'))]));
function ipfsCheckFn() { return fnModules['ipfs-check']; }
let ipCounter = 0;
async function runFunction(name, req, u, body, res) {
  const ip = serverState.fixedIp || `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;
  const event = { httpMethod: req.method, path: u.pathname, rawUrl: 'http://localhost' + req.url, headers: { ...req.headers, 'x-nf-client-connection-ip': ip }, queryStringParameters: Object.fromEntries(u.searchParams), body: body || null, isBase64Encoded: false };
  const out = await fnModules[name].handler(event);
  res.writeHead(out.statusCode, out.headers || {}); res.end(out.body || '');
}

export function startServer(port = 8931) {
  setFlags();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = u.pathname;
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const api = p.match(/^\/api\/([a-z-]+)$/);
    if (api && FUNCTIONS.includes(api[1]) && api[1] !== 'par-tokenlist') {
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => runFunction(api[1], req, u, Buffer.concat(chunks).toString('utf8'), res).catch((e) => { origLog('FUNCTION CRASH', api[1], e); json(500, { error: 'crash' }); }));
      return;
    }
    if (p === '/api/par-launches-all') { if (chain.indexerDown) return json(503, { error: 'The PAR index is temporarily unavailable.' }); const r = indexerHandle('https://api.par.family/launches?limit=500'); return json(200, { count: r.json.length, indexed: r.json.length, launches: r.json }); }
    if (p === '/api/par-tokenlist') return json(200, { tokens: [] });
    if (p === '/api/site-check') {
      const url = u.searchParams.get('url') || '';
      if (/oplive\.example/.test(url)) return json(200, { found: true, origin: 'https://oplive.example', declaration: { schema: 'syncnet.site.v1', token: lc(A.CREATORLIVE) } });
      if (/fakepons\.example/.test(url)) return json(200, { found: true, origin: 'https://fakepons.example', declaration: { schema: 'syncnet.site.v1', token: lc(A.PONS) } });
      if (/declarer\.example/.test(url)) return json(200, { found: true, origin: 'https://declarer.example', declaration: { schema: 'syncnet.site.v1', token: lc(A.CREATORLIVE) } });
      return json(200, { found: false, origin: url, reason: 'http-404' });
    }
    if (p.startsWith('/project/') || p.startsWith('/token/')) p = '/token.html';
    if (p === '/') p = '/index.html';
    const f = path.join(ROOT, path.normalize(p));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}

// ---- browser-side mocks
export async function installRoutes(context) {
  await context.route('https://api.par.family/**', (route) => { const r = indexerHandle(route.request().url()); return route.fulfill({ status: r.status, json: r.json }); });
  await context.route('https://par.family/**', (r) => r.fulfill({ json: { tokens: [] } }));
  await context.route('https://rpc.mainnet.chain.robinhood.com/**', (route) => { rpcStats.mainnet++; return route.fulfill({ json: rpcHandle(JSON.parse(route.request().postData() || '{}')) }); });
  await context.route('http://127.0.0.1:8545/**', (route) => { rpcStats.fork++; return route.fulfill({ json: rpcHandle(JSON.parse(route.request().postData() || '{}'), '0xb626') }); });
  await context.route(/https:\/\/(gateway\.pinata\.cloud|ipfs\.io|dweb\.link|[a-z0-9]+\.ipfs\.dweb\.link)\/.*/, (r) => {
    const host = new URL(r.request().url()).hostname;
    const mode = host === 'gateway.pinata.cloud' ? browserGateways.pinata : host === 'ipfs.io' ? browserGateways.ipfs : browserGateways.dweb;
    browserGateways.hits.push(host);
    if (mode === 'down') return r.abort('failed');
    if (mode === 'html') return r.fulfill({ status: 200, contentType: 'text/html', body: '<html>not an image</html>' });
    return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await context.route(/https:\/\/(x\.com|trends\.google\.com|www\.google\.com|robinhoodchain\.blockscout\.com)\/.*/, (r) => r.fulfill({ status: 200, body: 'external' }));
  await context.exposeBinding('__mockSendTx', (_src, tx) => sendTx(tx));
  await context.exposeBinding('__mockSign', (_src, { kind, data, account, as }) => {
    const signer = lc(as || account);
    if (kind === 'typed') return signDigest(signer, Core.hashTypedData(JSON.parse(data)));
    return signDigest(signer, Core.hashPersonalMessage(Core.hexToBytes(data)));
  });
  await context.addInitScript(({ WALLET }) => {
    const listeners = {};
    const emit = (e, v) => (listeners[e] || []).forEach((f) => { try { f(v); } catch (err) { console.warn(err); } });
    window.__mockEmit = emit;
    window.__mockSetAccount = (a) => { window.__mockAccount = a; emit('accountsChanged', a ? [a] : []); };
    window.__mockSetChain = (c) => { window.__mockChainId = c; emit('chainChanged', c); };
    const provider = {
      isMetaMask: true,
      on: (e, f) => ((listeners[e] ||= []).push(f)),
      removeListener: () => {},
      async request({ method, params }) {
        window.__walletCalls = (window.__walletCalls || []).concat(method);
        const acct = window.__mockAccount || WALLET;
        switch (method) {
          case 'eth_requestAccounts': case 'eth_accounts': return [acct];
          case 'eth_chainId': return window.__mockChainId || '0x1237';
          case 'wallet_switchEthereumChain': window.__mockChainId = params[0].chainId; emit('chainChanged', params[0].chainId); return null;
          case 'wallet_addEthereumChain': return null;
          case 'eth_signTypedData_v4': {
            window.__typed = params[1];
            if (window.__mockSignHook) await window.__mockSignHook('typed');
            if (window.__mockNoTypedData) throw Object.assign(new Error('Method not found'), { code: -32601 });
            if (window.__mockSignReject) throw Object.assign(new Error('User rejected'), { code: 4001 });
            return window.__mockSign({ kind: 'typed', data: params[1], account: params[0], as: window.__mockSignAs || null });
          }
          case 'personal_sign': {
            window.__personal = params[0];
            if (window.__mockSignHook) await window.__mockSignHook('personal');
            return window.__mockSign({ kind: 'personal', data: params[0], account: params[1], as: window.__mockSignAs || null });
          }
          case 'eth_sendTransaction': {
            const tx = params[0]; window.__sentTx = tx; window.__sentTxs = (window.__sentTxs || []).concat([tx]);
            if (tx.chainId && String(tx.chainId).toLowerCase() !== String(window.__mockChainId || '0x1237').toLowerCase()) throw Object.assign(new Error('chainId does not match the wallet network'), { code: -32602 });
            if (window.__mockSendHook) await window.__mockSendHook();
            const r = await window.__mockSendTx(tx);
            if (r && r.__error) throw Object.assign(new Error(r.__error.message), { code: r.__error.code });
            return r;
          }
          default: throw Object.assign(new Error('unsupported ' + method), { code: -32601 });
        }
      },
    };
    window.ethereum = provider;
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { name: 'Mock Wallet', rdns: 'test.mock', uuid: '1', icon: '' }, provider } })));
  }, { WALLET: A.WALLET });
}
