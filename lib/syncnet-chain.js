/*
 * SyncNet chain layer — PAR constants for Robinhood Chain (4663), a small JSON-RPC client,
 * on-chain readers and the two verifiers everything else relies on:
 *
 *   verifyDeployment(rpc, expected)  authoritative post-launch check of a token SyncNet prepared
 *   verifyEvidence(rpc, proof)       provenance check behind "BUILT WITH SYNCNET · VERIFIED"
 *
 * The on-chain factory state is authoritative. Indexers are never consulted here.
 * Shared by the browser (window.SyncNetChain) and the Netlify Functions (require()).
 * Depends only on lib/syncnet-core.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'));
  else root.SyncNetChain = factory(root.SyncNetCore);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  if (!Core) throw new Error('SyncNetChain requires SyncNetCore (lib/syncnet-core.js) to be loaded first.');

  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ZERO32 = '0x' + '00'.repeat(32);
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));
  const same = (a, b) => isAddr(a) && isAddr(b) && lc(a) === lc(b);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------------------------
  // PAR deployment on Robinhood Chain — pardotfamily/par-sdk src/addresses.ts (v0.3.0, f5a5beb) and
  // par.family/docs, re-read 23 Sep 2026. Every value is re-checked live by readParState() before a launch.
  const ROBINHOOD = Object.freeze({
    chainId: 4663,
    chainHex: '0x1237',
    rpcUrl: 'https://rpc.mainnet.chain.robinhood.com/',
    explorer: 'https://robinhoodchain.blockscout.com',
    indexer: 'https://api.par.family',
    factory: '0x9d33ba78389c8772bc114cba47dc1985e933e76f', // single-market PairPadLaunchFactory
    router: '0x73d84bdbb1983fa7ed8fcbce40bc308997ced120',
    locker: '0x8a6d37b2e6a2ac7970ef69d2932757f04be0a231',
    multiFactory: '0x3ea29975a79900179f3e1aef93347ba4210c29c1',
    multiRouter: '0x458d2a59c2f3dd32775a64ee72004561440d64df',
    multiLocker: '0x5826fbb6201daacd924a3d292841da9142952d59',
    feeEscrow: '0x1c27e8f0c2a754db23ab1608fa09c068d54d4386',
    quotePricer: '0x9efc6efa4c5f31e2bec6cc174ba7bb8f0b57d563',
    feeSplitter: '0x85a1cbbe2933f15f2599b9e0e03e6f89655fa4c1',
    feeSplitterV1: '0x913a93cc2676f49454173323b85762b3e5906c43',
    holderVault: '0x4b79b8298cd890a82dc9de1de5dbb745cf04353c',
    burnVault: '0x16c83d36539b6c92e6fc998d2a039fd7ff31958e',
    floorVault: '0xa5e805856e513f01d6ac992ac45fe54e5e601829',
    disperse: '0x28a5f3f898e99753e322fdce6efa8b294c215b9b',
    disperseV1: '0xf09e4997ca8ac5869de8b1c63acc4a3180c087ec',
    buybackWallet: '0x5ba4a4a197111ce8b6a2c2776d7836a9e1868033',
    holdersWallet: '0xb1a7a3a37f41e4dc9507f9b0f946b7f786c4afb4',
    parToken: '0x507b6f349a80114097a67b8b4677367acc15b220',
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    v3Factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    swapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
    weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    multiFactoryDeployBlock: 55587224,
  });

  /** Addresses that can never be a sensible creator-fee recipient: fees credited to them are unreachable or go to PAR. */
  const INFRA_LABELS = Object.freeze({
    [ROBINHOOD.factory]: 'PAR single-market factory', [ROBINHOOD.router]: 'PAR router', [ROBINHOOD.locker]: 'PAR locker',
    [ROBINHOOD.multiFactory]: 'PAR multi-market factory', [ROBINHOOD.multiRouter]: 'PAR multi-market router', [ROBINHOOD.multiLocker]: 'PAR multi-market locker',
    [ROBINHOOD.feeEscrow]: 'PAR fee escrow', [ROBINHOOD.quotePricer]: 'PAR quote pricer', [ROBINHOOD.feeSplitter]: 'PAR fee splitter',
    [ROBINHOOD.feeSplitterV1]: 'PAR fee splitter (v1)', [ROBINHOOD.disperse]: 'PAR disperser', [ROBINHOOD.disperseV1]: 'PAR disperser (v1)',
    [ROBINHOOD.buybackWallet]: 'PAR buyback wallet', [ROBINHOOD.holdersWallet]: 'PAR holders wallet', [ROBINHOOD.parToken]: 'the $par token contract',
    [ROBINHOOD.poolManager]: 'Uniswap v4 PoolManager', [ROBINHOOD.positionManager]: 'Uniswap v4 PositionManager', [ROBINHOOD.v3Factory]: 'Uniswap v3 factory',
    [ROBINHOOD.swapRouter02]: 'Uniswap SwapRouter02', [ROBINHOOD.permit2]: 'Permit2', [ROBINHOOD.multicall3]: 'Multicall3',
    [ROBINHOOD.weth]: 'WETH', [ROBINHOOD.usdg]: 'USDG',
    '0x000000000000000000000000000000000000dead': 'a burn address', '0xdead000000000000000042069420694206942069': 'a burn address',
  });
  const VAULT_MODES = Object.freeze({ [ROBINHOOD.holderVault]: 'holders', [ROBINHOOD.burnVault]: 'burn', [ROBINHOOD.floorVault]: 'floor' });

  /**
   * Static checks for a creator-fee recipient. Returns {ok, error} — error is a user-facing sentence.
   * Contracts are handled separately (needs eth_getCode): see classifyRecipient().
   */
  function recipientStaticCheck(addr, { quotes = [], extraBlocked = {} } = {}) {
    if (!isAddr(addr)) return { ok: false, error: 'Enter a valid 0x fee recipient address.' };
    const a = lc(addr);
    if (a === ZERO) return { ok: false, error: 'The zero address cannot receive fees.' };
    if (BigInt(a) < 0x10000n) return { ok: false, error: 'That is a precompile/system address. Fees sent there would be unreachable.' };
    if (VAULT_MODES[a]) return { ok: false, error: 'That address is a PAR fee vault. Choose that fee destination instead of typing its address.' };
    if (INFRA_LABELS[a]) return { ok: false, error: `That address is ${INFRA_LABELS[a]}. Creator fees sent there could not be claimed by you.` };
    const extra = Object.keys(extraBlocked).find((k) => lc(k) === a);
    if (extra) return { ok: false, error: `That address is ${extraBlocked[extra]}. Choose a wallet you control.` };
    if (quotes.some((q) => lc(q) === a)) return { ok: false, error: 'The fee recipient cannot be one of the tokens you sync with.' };
    if (/^0x(?:0{38}|f{38}).{2}$/i.test(a) || /^0x(?:dead){10}$/i.test(a) || /^0x0{8,}/i.test(a) && BigInt(a) < 2n ** 64n) {
      return { ok: false, error: 'That looks like a burn or placeholder address. Fees sent there would be unreachable.' };
    }
    return { ok: true, error: '' };
  }

  // ---------------------------------------------------------------------------------------------
  // Selectors and ABI shapes (verified against pardotfamily/par v3/ and v2/ sources and par-sdk abi/*.json)
  const SIG = {
    getLaunchedToken: 'getLaunchedToken(address)', getMarkets: 'getMarkets(address)', launchForwarder: 'launchForwarder()',
    launchFee: 'launchFee()', baseFeeBps: 'baseFeeBps()', protocolFeeShareBps: 'protocolFeeShareBps()', maxCreatorTaxBps: 'maxCreatorTaxBps()',
    canLaunch: 'canLaunch(address)', launchEnabled: 'launchEnabled()', getLaunchConfig: 'getLaunchConfig(uint256)', owner: 'owner()',
    previewLaunchEconomics: 'previewLaunchEconomics(uint256,address[])', previewQuoteEconomics: 'previewQuoteEconomics(uint256,address[])',
    pairTokenEconomics: 'pairTokenEconomics(address)', quotePricer: 'quotePricer()', weth: 'weth()', factory: 'factory()',
    swapRouter: 'swapRouter()', manager: 'manager()', multiFactory: 'multiFactory()', escrow: 'escrow()',
    isPriceable: 'isPriceable(address)', route: 'route(address)', allowedV4Hooks: 'allowedV4Hooks(address)',
    name: 'name()', symbol: 'symbol()', decimals: 'decimals()', totalSupply: 'totalSupply()', logo: 'logo()', description: 'description()',
    socials: 'socials()', deployer: 'deployer()', launchFactory: 'launchFactory()', contractURI: 'contractURI()', balanceOf: 'balanceOf(address)',
    isValidSignature: 'isValidSignature(bytes32,bytes)',
  };
  const SEL = {};
  for (const k of Object.keys(SIG)) SEL[k] = Core.functionSelector(SIG[k]);
  const MULTI_RECORD = '(address,address,address,uint24,int24,uint16,uint16,uint16,address,uint64,uint8,bool)';
  const SINGLE_RECORD = '(address,address,address,address,uint256,uint24,int24,int24,int24,uint128,uint256,uint16,uint16,uint16,address,uint64,bool)';
  const MARKET = '(address,uint256,int24,int24,uint128,uint256)';
  const HOP = '((address,address,uint24,int24,address),bool)';
  const TOPIC = Object.freeze({
    multiLaunched: Core.keccak256Utf8('TokenLaunched(address,address,uint256,uint24,address[])'),
    singleLaunched: Core.keccak256Utf8('TokenLaunched(address,bytes32,address,address,uint256,uint24)'),
  });

  const enc = (sel, types, values) => sel + (types && types.length ? Core.abiEncode(types, values).slice(2) : '');
  const topicAddr = (t) => '0x' + String(t || '').slice(-40).toLowerCase();

  // ---------------------------------------------------------------------------------------------
  // JSON-RPC
  class RpcError extends Error {
    constructor(message, extra) { super(message); this.name = 'RpcError'; Object.assign(this, extra || {}); }
  }
  function makeRpc(url, opts) {
    const o = opts || {};
    const doFetch = o.fetch || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    const timeoutMs = o.timeoutMs || 12000;
    const retries = o.retries == null ? 1 : o.retries;
    let id = 0;
    const rpc = async function rpc(method, params) {
      let lastErr = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
        try {
          const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params || [] }), signal: ctl ? ctl.signal : undefined });
          if (!res.ok) throw new RpcError('RPC HTTP ' + res.status, { transient: res.status === 429 || res.status >= 500 });
          const j = await res.json();
          if (j && j.error) {
            const msg = String(j.error.message || 'RPC error');
            throw new RpcError(msg, { code: j.error.code, data: j.error.data, revert: j.error.code === 3 || /revert/i.test(msg) });
          }
          return j ? j.result : null;
        } catch (e) {
          lastErr = e && e.name === 'AbortError' ? new RpcError('RPC timeout', { transient: true }) : e;
          if (lastErr && lastErr.revert) throw lastErr;
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (attempt < retries) await sleep(350 * (attempt + 1));
      }
      throw lastErr || new RpcError('RPC unavailable', { transient: true });
    };
    rpc.url = url;
    return rpc;
  }
  async function ethCall(rpc, to, data, block) {
    return rpc('eth_call', [{ to, data }, block || 'latest']);
  }
  async function callDecode(rpc, to, sel, argTypes, args, outTypes) {
    const hex = await ethCall(rpc, to, enc(sel, argTypes, args));
    if (!hex || hex === '0x') return null;
    return Core.abiDecode(outTypes, hex);
  }
  async function tryRead(rpc, to, sel, argTypes, args, outTypes) {
    try {
      const r = await callDecode(rpc, to, sel, argTypes, args, outTypes);
      return r ? (r.length === 1 ? r[0] : r) : null;
    } catch (e) {
      return null;
    }
  }
  const num = (v) => (v == null ? null : typeof v === 'bigint' ? Number(v) : Number(v));
  const str = (v) => (v == null ? null : typeof v === 'bigint' ? v.toString() : String(v));

  // ---------------------------------------------------------------------------------------------
  // Readers
  async function getCode(rpc, address) {
    const c = await rpc('eth_getCode', [address, 'latest']);
    return typeof c === 'string' ? c : '0x';
  }
  /** Classifies an address: eoa | delegated-eoa (EIP-7702) | contract | par-launch-token. */
  async function classifyRecipient(rpc, address) {
    const code = lc(await getCode(rpc, address));
    if (!code || code === '0x') return { kind: 'eoa', code };
    if (code.startsWith('0xef0100') && code.length === 48) return { kind: 'delegated-eoa', code };
    const launch = await readLaunch(rpc, address).catch(() => null);
    if (launch) return { kind: 'par-launch-token', code, launch };
    return { kind: 'contract', code };
  }

  /** getLaunchedToken on the multi factory, then the single factory. null when neither knows the token. */
  async function readLaunch(rpc, token) {
    if (!isAddr(token)) return null;
    const multi = await callDecode(rpc, ROBINHOOD.multiFactory, SEL.getLaunchedToken, ['address'], [token], [MULTI_RECORD]);
    const m = multi && multi[0];
    if (m && m[11] === true) {
      return {
        kind: 'multi', factory: ROBINHOOD.multiFactory, token: m[0], deployer: m[1], creatorFeeRecipient: m[2], poolFee: num(m[3]),
        tickSpacing: num(m[4]), baseFeeBps: num(m[5]), creatorTaxBps: num(m[6]), protocolFeeShareBps: num(m[7]),
        protocolFeeRecipient: m[8], launchedAt: num(m[9]), marketCount: num(m[10]), exists: true,
      };
    }
    const single = await callDecode(rpc, ROBINHOOD.factory, SEL.getLaunchedToken, ['address'], [token], [SINGLE_RECORD]);
    const s = single && single[0];
    if (s && s[16] === true) {
      return {
        kind: 'single', factory: ROBINHOOD.factory, token: s[0], deployer: s[1], creatorFeeRecipient: s[2], pairToken: s[3],
        phantomQuote: str(s[4]), poolFee: num(s[5]), tickSpacing: num(s[6]), baseFeeBps: num(s[11]), creatorTaxBps: num(s[12]),
        protocolFeeShareBps: num(s[13]), protocolFeeRecipient: s[14], launchedAt: num(s[15]), marketCount: 1, exists: true,
      };
    }
    return null;
  }
  async function readMarkets(rpc, token, launch) {
    if (launch && launch.kind === 'single') return [{ index: 0, pairToken: launch.pairToken, phantomQuote: launch.phantomQuote }];
    const r = await callDecode(rpc, ROBINHOOD.multiFactory, SEL.getMarkets, ['address'], [token], [MARKET + '[]']);
    return (r ? r[0] : []).map((m, i) => ({ index: i, pairToken: m[0], phantomQuote: str(m[1]), tickLower: num(m[2]), tickUpper: num(m[3]), liquidity: str(m[4]), positionId: str(m[5]) }));
  }
  async function readTokenMetadata(rpc, token) {
    const [name, symbol, decimals, totalSupply, logo, description, socials, deployer, launchFactory, contractURI] = await Promise.all([
      tryRead(rpc, token, SEL.name, [], [], ['string']), tryRead(rpc, token, SEL.symbol, [], [], ['string']),
      tryRead(rpc, token, SEL.decimals, [], [], ['uint8']), tryRead(rpc, token, SEL.totalSupply, [], [], ['uint256']),
      tryRead(rpc, token, SEL.logo, [], [], ['string']), tryRead(rpc, token, SEL.description, [], [], ['string']),
      tryRead(rpc, token, SEL.socials, [], [], ['string', 'string', 'string', 'string', 'string']),
      tryRead(rpc, token, SEL.deployer, [], [], ['address']), tryRead(rpc, token, SEL.launchFactory, [], [], ['address']),
      tryRead(rpc, token, SEL.contractURI, [], [], ['string']),
    ]);
    const s = Array.isArray(socials) ? socials : [];
    return {
      name, symbol, decimals: num(decimals), totalSupply: str(totalSupply), logo, description, deployer, launchFactory, contractURI,
      socials: socials ? { twitter: s[0] || '', telegram: s[1] || '', discord: s[2] || '', website: s[3] || '', farcaster: s[4] || '' } : null,
    };
  }
  async function readBalance(rpc, token, owner) {
    return str(await tryRead(rpc, token, SEL.balanceOf, ['address'], [owner], ['uint256']));
  }

  /**
   * Everything the launcher relies on about PAR, read live. Missing values stay null (and fail the checks below).
   * opts: { account, quotes: [addr], feeMode }
   */
  async function readParState(rpc, opts) {
    const o = opts || {};
    const F = ROBINHOOD.multiFactory, R = ROBINHOOD.multiRouter, P = ROBINHOOD.quotePricer;
    const q = (o.quotes || []).filter(isAddr);
    const [chainHex, factoryCode, routerCode, pricerCode, launchForwarder, routerFactory, routerWeth, routerSwap, routerManager, factoryWeth, factoryPricer,
      launchFee, baseFeeBps, protocolFeeShareBps, maxCreatorTaxBps, launchEnabled, owner, config0, canLaunch,
      holderEscrow, burnFactory, floorFactory] = await Promise.all([
      rpc('eth_chainId', []).catch(() => null), getCode(rpc, F).catch(() => null), getCode(rpc, R).catch(() => null), getCode(rpc, P).catch(() => null),
      tryRead(rpc, F, SEL.launchForwarder, [], [], ['address']), tryRead(rpc, R, SEL.factory, [], [], ['address']), tryRead(rpc, R, SEL.weth, [], [], ['address']),
      tryRead(rpc, R, SEL.swapRouter, [], [], ['address']), tryRead(rpc, R, SEL.manager, [], [], ['address']), tryRead(rpc, F, SEL.weth, [], [], ['address']),
      tryRead(rpc, F, SEL.quotePricer, [], [], ['address']), tryRead(rpc, F, SEL.launchFee, [], [], ['uint256']), tryRead(rpc, F, SEL.baseFeeBps, [], [], ['uint256']),
      tryRead(rpc, F, SEL.protocolFeeShareBps, [], [], ['uint256']), tryRead(rpc, F, SEL.maxCreatorTaxBps, [], [], ['uint256']),
      tryRead(rpc, F, SEL.launchEnabled, [], [], ['bool']), tryRead(rpc, F, SEL.owner, [], [], ['address']),
      tryRead(rpc, F, SEL.getLaunchConfig, ['uint256'], [0n], ['(uint256,uint256,int24,bool)']),
      isAddr(o.account) ? tryRead(rpc, F, SEL.canLaunch, ['address'], [o.account], ['bool']) : Promise.resolve(null),
      o.feeMode === 'holders' ? tryRead(rpc, ROBINHOOD.holderVault, SEL.escrow, [], [], ['address']) : Promise.resolve(undefined),
      o.feeMode === 'burn' ? tryRead(rpc, ROBINHOOD.burnVault, SEL.multiFactory, [], [], ['address']) : Promise.resolve(undefined),
      o.feeMode === 'floor' ? tryRead(rpc, ROBINHOOD.floorVault, SEL.multiFactory, [], [], ['address']) : Promise.resolve(undefined),
    ]);
    const curated = await Promise.all(q.map((a) => tryRead(rpc, F, SEL.pairTokenEconomics, ['address'], [a], ['uint256', 'uint8'])));
    return {
      chainId: chainHex ? Number(chainHex) : null,
      code: { factory: factoryCode && factoryCode !== '0x', router: routerCode && routerCode !== '0x', pricer: pricerCode && pricerCode !== '0x' },
      launchForwarder, routerFactory, routerWeth, routerSwap, routerManager, factoryWeth, factoryPricer,
      launchFee: str(launchFee), baseFeeBps: num(baseFeeBps), protocolFeeShareBps: num(protocolFeeShareBps), maxCreatorTaxBps: num(maxCreatorTaxBps),
      launchEnabled, owner, canLaunch,
      launchConfig: config0 ? { supply: str(config0[0]), phantomQuote: str(config0[1]), tickSpacing: num(config0[2]), enabled: config0[3] === true } : null,
      vault: { holderEscrow, burnFactory, floorFactory },
      curated: q.map((a, i) => ({ address: lc(a), phantomQuote: curated[i] ? str(curated[i][0]) : null, decimals: curated[i] ? num(curated[i][1]) : null, curated: Boolean(curated[i] && BigInt(curated[i][0]) > 0n) })),
      readAt: new Date().toISOString(),
    };
  }

  /** Turns readParState() output into a checklist. severity 'block' stops the launch; 'warn' is shown. */
  function parChecks(state, opts) {
    const o = opts || {};
    const expectedChain = o.chainId || ROBINHOOD.chainId;
    const router = Boolean(o.openingBuy);
    const out = [];
    const add = (id, label, ok, expected, actual, severity) => out.push({ id, label, ok: Boolean(ok), expected, actual: actual == null ? 'not readable' : actual, severity: ok ? 'ok' : severity });
    add('chain', 'RPC chain id', state.chainId === expectedChain, String(expectedChain), state.chainId == null ? null : String(state.chainId), 'block');
    add('factory-code', 'PAR multi factory deployed', state.code.factory, 'contract code', state.code.factory ? 'present' : 'missing', 'block');
    add('pricer', 'Factory quote pricer', same(state.factoryPricer, ROBINHOOD.quotePricer), ROBINHOOD.quotePricer, state.factoryPricer, 'block');
    add('factory-weth', 'Factory WETH', same(state.factoryWeth, ROBINHOOD.weth), ROBINHOOD.weth, state.factoryWeth, 'warn');
    add('forwarder', 'launchForwarder() is PAR multi router', same(state.launchForwarder, ROBINHOOD.multiRouter), ROBINHOOD.multiRouter, state.launchForwarder, router ? 'block' : 'warn');
    add('router-factory', 'Router factory() is the multi factory', same(state.routerFactory, ROBINHOOD.multiFactory), ROBINHOOD.multiFactory, state.routerFactory, router ? 'block' : 'warn');
    add('router-weth', 'Router WETH', same(state.routerWeth, ROBINHOOD.weth), ROBINHOOD.weth, state.routerWeth, router ? 'block' : 'warn');
    add('router-swap', 'Router SwapRouter02', same(state.routerSwap, ROBINHOOD.swapRouter02), ROBINHOOD.swapRouter02, state.routerSwap, 'warn');
    add('router-manager', 'Router PoolManager', same(state.routerManager, ROBINHOOD.poolManager), ROBINHOOD.poolManager, state.routerManager, 'warn');
    add('config', 'Launch config 0 enabled', Boolean(state.launchConfig && state.launchConfig.enabled), 'enabled', state.launchConfig ? (state.launchConfig.enabled ? 'enabled' : 'disabled') : null, 'block');
    add('fee', 'Launch fee readable', state.launchFee != null, 'uint256', state.launchFee, 'block');
    add('base-fee', 'Base fee readable', state.baseFeeBps != null, 'bps', state.baseFeeBps == null ? null : String(state.baseFeeBps), 'block');
    add('protocol-share', 'Protocol share readable', state.protocolFeeShareBps != null, 'bps', state.protocolFeeShareBps == null ? null : String(state.protocolFeeShareBps), 'block');
    add('max-tax', 'Creator tax within PAR maximum', state.maxCreatorTaxBps != null && (o.tax == null || o.tax <= state.maxCreatorTaxBps), `≤ ${state.maxCreatorTaxBps}`, o.tax == null ? null : String(o.tax), 'block');
    if (o.account) add('can-launch', 'PAR allows this wallet to launch', state.canLaunch === true, 'true', state.canLaunch == null ? null : String(state.canLaunch), 'block');
    if (o.feeMode === 'holders') add('vault', 'Holder vault escrow', same(state.vault.holderEscrow, ROBINHOOD.feeEscrow), ROBINHOOD.feeEscrow, state.vault.holderEscrow, 'block');
    if (o.feeMode === 'burn') add('vault', 'Burn vault factory', same(state.vault.burnFactory, ROBINHOOD.multiFactory), ROBINHOOD.multiFactory, state.vault.burnFactory, 'block');
    if (o.feeMode === 'floor') add('vault', 'Floor vault factory', same(state.vault.floorFactory, ROBINHOOD.multiFactory), ROBINHOOD.multiFactory, state.vault.floorFactory, 'block');
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Transactions and receipts
  async function readTx(rpc, hash) {
    const [tx, receipt] = await Promise.all([rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash])]);
    return { tx: tx || null, receipt: receipt || null };
  }
  /** The TokenLaunched log of a receipt (multi or single factory) → {token, deployer, factory}. */
  function launchedFromReceipt(receipt) {
    for (const log of (receipt && receipt.logs) || []) {
      const t = log.topics || [];
      if (same(log.address, ROBINHOOD.multiFactory) && lc(t[0]) === TOPIC.multiLaunched && t.length >= 3) return { token: topicAddr(t[1]), deployer: topicAddr(t[2]), factory: ROBINHOOD.multiFactory, kind: 'multi' };
      if (same(log.address, ROBINHOOD.factory) && lc(t[0]) === TOPIC.singleLaunched && t.length >= 4) return { token: topicAddr(t[1]), deployer: topicAddr(t[3]), factory: ROBINHOOD.factory, kind: 'single' };
    }
    return null;
  }
  async function findLaunchByTx(rpc, hash) {
    const { tx, receipt } = await readTx(rpc, hash);
    const launched = receipt ? launchedFromReceipt(receipt) : null;
    let decoded = null;
    try { decoded = tx && tx.input ? Core.decodeLaunchCalldata(tx.input) : null; } catch (e) { decoded = null; }
    return {
      tx, receipt, launched, decoded,
      status: !tx && !receipt ? 'unknown' : receipt ? (receipt.status === '0x1' ? 'success' : 'reverted') : 'pending',
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Post-launch verification (authoritative)
  const sameText = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b);
  /**
   * expected: { token, deployer, name, symbol, logo, description, twitter, website, creatorFeeRecipient, creatorTaxBps,
   *             pairTokens:[addr], economics:{ baseFeeBps, protocolFeeShareBps, launchFee }, openingBuy:{ minTokens } | null }
   * Returns { status: 'verified'|'mismatch'|'not-found'|'unavailable', checks:[{id,label,expected,actual,ok,hard}], actual }.
   */
  async function verifyDeployment(rpc, expected, opts) {
    const o = opts || {};
    const attempts = o.attempts == null ? 8 : o.attempts;
    const delayMs = o.delayMs == null ? 1500 : o.delayMs;
    let launch = null, code = '0x', lastErr = null, readOk = false;
    for (let i = 0; i < attempts; i++) {
      try {
        code = await getCode(rpc, expected.token);
        launch = await readLaunch(rpc, expected.token);
        readOk = true;
        if (launch && code && code !== '0x') break;
      } catch (e) { lastErr = e; }
      if (i < attempts - 1) await sleep(delayMs);
    }
    if (!launch) {
      // 'unavailable' = the chain could not be read at all; 'not-found' = read fine, token not recorded (yet).
      return { status: readOk ? 'not-found' : 'unavailable', checks: [{ id: 'exists', label: 'Token recorded by the PAR factory', expected: 'exists', actual: readOk ? 'not found' : 'chain not readable', ok: false, hard: true }], actual: { code }, error: lastErr ? String(lastErr.message || lastErr) : '' };
    }
    const [markets, meta] = await Promise.all([readMarkets(rpc, expected.token, launch).catch(() => null), readTokenMetadata(rpc, expected.token)]);
    const checks = [];
    const add = (id, label, exp, act, ok, hard = true) => checks.push({ id, label, expected: exp, actual: act, ok: Boolean(ok), hard });
    add('exists', 'Token recorded by the PAR factory', 'exists', launch.kind + ' factory', true);
    add('factory', 'Launch factory', ROBINHOOD.multiFactory, launch.factory, same(launch.factory, ROBINHOOD.multiFactory));
    add('deployer', 'Deployer', lc(expected.deployer), lc(launch.deployer), same(launch.deployer, expected.deployer));
    add('recipient', 'Creator-fee recipient', lc(expected.creatorFeeRecipient), lc(launch.creatorFeeRecipient), same(launch.creatorFeeRecipient, expected.creatorFeeRecipient));
    add('tax', 'Creator tax (bps)', String(expected.creatorTaxBps), String(launch.creatorTaxBps), Number(expected.creatorTaxBps) === launch.creatorTaxBps);
    const exPairs = (expected.pairTokens || []).map(lc);
    const acPairs = (markets || []).map((m) => lc(m.pairToken));
    add('market-count', 'Market count', String(exPairs.length), String(launch.marketCount), exPairs.length === launch.marketCount);
    add('markets', 'Market pair tokens (in order)', exPairs.join(','), markets ? acPairs.join(',') : 'not readable', markets && exPairs.length === acPairs.length && exPairs.every((a, i) => a === acPairs[i]));
    const econ = expected.economics || {};
    const expPoolFee = econ.baseFeeBps != null ? (Number(econ.baseFeeBps) + Number(expected.creatorTaxBps)) * 100 : null;
    add('base-fee', 'PAR base fee (bps) · expected = read at preparation', econ.baseFeeBps == null ? '—' : String(econ.baseFeeBps), String(launch.baseFeeBps), econ.baseFeeBps == null || Number(econ.baseFeeBps) === launch.baseFeeBps, false);
    add('protocol-share', 'Protocol share of base fee (bps)', econ.protocolFeeShareBps == null ? '—' : String(econ.protocolFeeShareBps), String(launch.protocolFeeShareBps), econ.protocolFeeShareBps == null || Number(econ.protocolFeeShareBps) === launch.protocolFeeShareBps, false);
    add('pool-fee', 'Pool fee (hundredths of a bip)', expPoolFee == null ? '—' : String(expPoolFee), String(launch.poolFee), expPoolFee == null || expPoolFee === launch.poolFee, false);
    add('code', 'Token bytecode', 'present', code && code !== '0x' ? 'present' : 'missing', code && code !== '0x');
    add('name', 'Name', expected.name, meta.name, sameText(meta.name, expected.name));
    add('symbol', 'Symbol', expected.symbol, meta.symbol, sameText(String(meta.symbol || '').toUpperCase(), String(expected.symbol || '').toUpperCase()));
    add('logo', 'Logo URI', expected.logo, meta.logo, sameText(meta.logo, expected.logo));
    add('description', 'Description', expected.description, meta.description, sameText(meta.description, expected.description));
    add('twitter', 'X link', expected.twitter || '', meta.socials ? meta.socials.twitter : null, meta.socials && sameText(meta.socials.twitter, expected.twitter || ''));
    add('website', 'Website', expected.website || '', meta.socials ? meta.socials.website : null, meta.socials && sameText(meta.socials.website, expected.website || ''));
    add('token-deployer', 'Token deployer()', lc(expected.deployer), lc(meta.deployer), same(meta.deployer, expected.deployer));
    add('token-factory', 'Token launchFactory()', ROBINHOOD.multiFactory, lc(meta.launchFactory), same(meta.launchFactory, ROBINHOOD.multiFactory));
    let balance = null;
    if (expected.openingBuy && expected.openingBuy.minTokens != null) {
      balance = await readBalance(rpc, expected.token, expected.deployer);
      add('opening-buy', 'Opening buy: deployer balance ≥ minimum', String(expected.openingBuy.minTokens), balance == null ? 'not readable' : balance, balance != null && BigInt(balance) >= BigInt(expected.openingBuy.minTokens), false);
    }
    const hardFail = checks.some((c) => c.hard && !c.ok);
    return {
      status: hardFail ? 'mismatch' : 'verified', checks,
      economicsChanged: checks.some((c) => !c.hard && !c.ok && ['base-fee', 'protocol-share', 'pool-fee'].includes(c.id)),
      actual: { launch, markets, metadata: meta, openingBuyBalance: balance, verifiedAt: new Date().toISOString() },
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Provenance evidence (public proof) verification
  function parseIntent(intentJson) {
    const j = JSON.parse(intentJson);
    if (!j || typeof j !== 'object' || j.schema !== 'syncnet.intent.v1') throw new Error('Unknown intent record schema.');
    return j;
  }
  /**
   * proof = { schema:'syncnet.launch.proof.v2', chainId, token, deployer, txHash, recordHash, salt, intentJson,
   *           signature:{ scheme:'EIP-712'|'personal_sign', typedData?, message?, signature } }
   * → { status:'VERIFIED'|'UNVERIFIED'|'UNAVAILABLE', checks:[{id,label,ok,detail}], actual }
   * UNAVAILABLE means the chain could not be read; it is never shown as verified.
   */
  async function verifyEvidence(rpc, proof, opts) {
    const o = opts || {};
    const checks = [];
    const add = (id, label, ok, detail) => checks.push({ id, label, ok: Boolean(ok), detail: detail || '' });
    const done = (actual) => ({ status: checks.every((c) => c.ok) ? 'VERIFIED' : 'UNVERIFIED', checks, actual: actual || null, verifiedAt: new Date().toISOString() });
    try {
      if (!proof || proof.schema !== 'syncnet.launch.proof.v2') { add('schema', 'Proof format', false, 'expected syncnet.launch.proof.v2'); return done(); }
      const chainId = Number(proof.chainId);
      add('chain-id', 'Chain', chainId === (o.chainId || ROBINHOOD.chainId), `proof chain ${chainId}`);
      const deployer = lc(proof.deployer), token = lc(proof.token);
      add('addresses', 'Token and deployer addresses', isAddr(deployer) && isAddr(token));
      // 1. commitment chain: intent JSON → recordHash → salt
      const recordHash = Core.recordHashOf(String(proof.intentJson || ''));
      add('record-hash', 'Intent record hashes to recordHash', lc(recordHash) === lc(proof.recordHash), recordHash);
      const salt = Core.intentSalt(recordHash);
      add('salt', 'recordHash commits to salt (keccak("SYNCNET/1", recordHash))', lc(salt) === lc(proof.salt), salt);
      let intent = null;
      try { intent = parseIntent(String(proof.intentJson)); } catch (e) { add('intent', 'Intent record readable', false, String(e.message || e)); return done(); }
      add('intent-operator', 'Intent operator is the deployer', same(intent.operator, deployer), lc(intent.operator));
      add('intent-chain', 'Intent chain id', Number(intent.chainId) === chainId, String(intent.chainId));
      // 2. signature by the deployer over (operator, token, recordHash, salt)
      const sig = proof.signature || {};
      let signer = '';
      try {
        if (sig.scheme === 'EIP-712') {
          const expectedTyped = Core.launchIntentTypedData({ chainId, operator: deployer, token, recordHash: lc(proof.recordHash), salt: lc(proof.salt) });
          add('typed-data', 'Signed EIP-712 message is exactly this launch', Core.sameTypedIntent(sig.typedData, expectedTyped));
          signer = Core.recoverTypedDataAddress(sig.typedData, sig.signature);
        } else if (sig.scheme === 'personal_sign') {
          const m = /^SyncNet Launch Intent v1\nchainId:(\d+)\noperator:(0x[0-9a-fA-F]{40})\ntoken:(0x[0-9a-fA-F]{40})\nrecordHash:(0x[0-9a-fA-F]{64})\nsalt:(0x[0-9a-fA-F]{64})$/.exec(String(sig.message || ''));
          const ok = Boolean(m) && Number(m[1]) === chainId && same(m[2], deployer) && same(m[3], token) && lc(m[4]) === lc(proof.recordHash) && lc(m[5]) === lc(proof.salt);
          add('typed-data', 'Signed text message is exactly this launch', ok);
          signer = Core.recoverPersonalSignAddress(String(sig.message), sig.signature);
        } else {
          add('typed-data', 'Signature scheme', false, 'unknown scheme');
        }
      } catch (e) {
        add('signature-format', 'Signature readable', false, String(e.message || e));
      }
      // EOAs (including EIP-7702-delegated ones) must recover to the deployer. A contract-wallet deployer (e.g. a Safe)
      // may approve the digest through EIP-1271 isValidSignature(bytes32,bytes) == 0x1626ba7e, checked at the current block.
      let sigOk = same(signer, deployer), sigDetail = signer || 'no signer';
      if (!sigOk && sig.signature && isAddr(deployer)) {
        try {
          const code = lc(await getCode(rpc, deployer));
          if (code && code !== '0x' && !code.startsWith('0xef0100')) {
            const digest = sig.scheme === 'EIP-712' ? Core.hashTypedData(sig.typedData) : Core.hashPersonalMessage(String(sig.message || ''));
            const out = await ethCall(rpc, deployer, SEL.isValidSignature + Core.abiEncode(['bytes32', 'bytes'], [digest, sig.signature]).slice(2));
            if (lc(out).slice(0, 10) === '0x1626ba7e') { sigOk = true; sigDetail = 'EIP-1271 approval by contract wallet ' + deployer; }
          }
        } catch (e) { /* stays unverified */ }
      }
      add('signature', 'Signature by the deployer (ECDSA, or EIP-1271 for a contract wallet)', sigOk, sigDetail);
      // 3. the launch transaction carried this salt and launched this token
      const { tx, receipt } = await readTx(rpc, proof.txHash);
      if (!tx || !receipt) { add('tx', 'Launch transaction found on-chain', false, 'not found'); return done(); }
      add('tx-from', 'Transaction sent by the deployer', same(tx.from, deployer), lc(tx.from));
      add('tx-to', 'Transaction sent to the PAR multi factory or router', same(tx.to, ROBINHOOD.multiFactory) || same(tx.to, ROBINHOOD.multiRouter), lc(tx.to));
      add('tx-status', 'Transaction succeeded', receipt.status === '0x1', receipt.status);
      let decoded = null;
      try { decoded = Core.decodeLaunchCalldata(tx.input); } catch (e) { add('tx-input', 'Transaction input is a PAR launch', false, String(e.message || e)); }
      if (decoded) {
        const p = decoded.params;
        add('tx-salt', 'Transaction salt equals the committed salt', lc(p.salt) === lc(proof.salt), lc(p.salt));
        add('tx-metadata', 'Transaction metadata equals the intent record', p.name === intent.name && p.symbol === intent.symbol && p.logo === intent.logo && p.description === intent.description && p.socials.twitter === (intent.twitter || '') && p.socials.website === (intent.website || ''));
        add('tx-fees', 'Transaction fee recipient and creator tax equal the intent record', same(p.creatorFeeRecipient, intent.creatorFeeRecipient) && Number(p.creatorTaxBps) === Number(intent.creatorTaxBps));
        const want = (intent.connections || []).map((c) => lc(c.address));
        add('tx-markets', 'Transaction markets equal the intent record', want.length === decoded.pairTokens.length && want.every((a, i) => a === lc(decoded.pairTokens[i])), decoded.pairTokens.map(lc).join(','));
      }
      const launched = launchedFromReceipt(receipt);
      add('tx-launched', 'The transaction launched this token (TokenLaunched log)', launched && launched.token === token && same(launched.deployer, deployer) && launched.kind === 'multi', launched ? launched.token : 'no TokenLaunched log');
      // 4. current factory state and metadata
      const launch = await readLaunch(rpc, token);
      add('factory-record', 'PAR factory records the token with this deployer', launch && launch.kind === 'multi' && same(launch.deployer, deployer), launch ? lc(launch.deployer) : 'not found');
      let markets = null, meta = null;
      if (launch) {
        add('factory-tax', 'Creator tax on the factory record', launch.creatorTaxBps === Number(intent.creatorTaxBps), String(launch.creatorTaxBps));
        markets = await readMarkets(rpc, token, launch).catch(() => null);
        const want = (intent.connections || []).map((c) => lc(c.address));
        add('factory-markets', 'Factory markets equal the intent record', markets && want.length === markets.length && want.every((a, i) => a === lc(markets[i].pairToken)), markets ? markets.map((m) => lc(m.pairToken)).join(',') : 'not readable');
        meta = await readTokenMetadata(rpc, token);
        add('token-metadata', 'Token metadata equals the intent record', meta.name === intent.name && meta.symbol === intent.symbol && meta.logo === intent.logo && meta.description === intent.description);
      }
      let block = null;
      try { block = receipt.blockNumber ? await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) : null; } catch (e) { block = null; }
      return done({
        launch, markets, metadata: meta, blockNumber: receipt.blockNumber ? Number(receipt.blockNumber) : null,
        launchedAt: block && block.timestamp ? Number(block.timestamp) : null,
        creatorFeeRecipientNow: launch ? lc(launch.creatorFeeRecipient) : null,
        creatorFeeRecipientAtLaunch: decoded ? lc(decoded.params.creatorFeeRecipient) : null,
      });
    } catch (e) {
      return { status: 'UNAVAILABLE', checks: checks.concat([{ id: 'rpc', label: 'Chain readable', ok: false, detail: String((e && e.message) || e).slice(0, 160) }]), actual: null };
    }
  }

  return Object.freeze({
    ROBINHOOD, INFRA_LABELS, VAULT_MODES, SEL, SIG, TOPIC, ZERO, ZERO32,
    RpcError, makeRpc, ethCall, getCode, classifyRecipient, recipientStaticCheck,
    readLaunch, readMarkets, readTokenMetadata, readBalance, readParState, parChecks,
    readTx, launchedFromReceipt, findLaunchByTx, verifyDeployment, verifyEvidence, parseIntent,
    same, isAddr,
  });
});
