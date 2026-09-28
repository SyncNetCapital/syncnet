/*
 * SyncNet project origins — one launchpad-agnostic resolver for the Marketplace and the Project Page
 * (browser + Netlify functions). A token's origin is established ONLY by a live read of a canonical factory;
 * nothing the client says ("launchpad=…", deployer, fee recipient, pair, phase) is ever evidence.
 *
 *   PAR      lib/syncnet-chain.js readLaunch(): PairPadMultiLaunchFactory, then PairPadLaunchFactory.
 *   PONS_V2  PonsV2LaunchFactory 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
 *            ponsdotdev/pons-labs @ 162310f (17 Sep 2026), contractsV2/src/v2/interfaces/ILaunchpadV2.sol:
 *            getLaunchedToken(address) -> LaunchedToken{token, curve, deployer, creatorFeeRecipient, pairToken,
 *              graduationThreshold, poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase, sweptQuote,
 *              sweptTokens, sweptAt, exists}   (all static types: a 15-word tuple)
 *            pendingCreatorFeeRecipient(address) -> (newRecipient, effectiveAt, expiresAt)  — protocol-owner
 *              override; "a matured proposal takes precedence over any creator transfer made while it was pending".
 *            transferCreatorFeeRecipient(address token, address newRecipient) — only the current recipient.
 *            pairToken == address(0) means native ETH.
 *            Discovery (PONS_V2_STACKS): event TokenLaunched(address indexed token, address indexed curve,
 *              address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
 *              (contractsV2/src/v2/PonsV2LaunchFactory.sol @ 162310f). Pons replaces a V2 stack as a complete set, so
 *              discovery knows a LIST of verified stacks; a launch stays attributed to the factory that emitted it.
 *   PONS_V1  DETECTED ONLY, NEVER SUPPORTED (no Passport claim, listing, fee transfer, trading or settlement).
 *            Two canonical factory generations, both listed in the official Pons documentation:
 *              ACTIVE  PonsLaunchFactory 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB (Blockscout-verified)
 *              LEGACY  0x0c37a24F5D23A486FA692d1500881d698B1F77a4 (NOT source-verified; tokens deployed before the
 *                      current version, e.g. PONS 0x39dBED3a2bd333467115dE45665cC57F813C4571)
 *            Both return the same 13-word getLaunchedToken record. Origin requires BIDIRECTIONAL evidence: the token's
 *            own launchFactory() must name a factory on this allowlist AND that factory's record must name the token
 *            with exists == true. A factory named by the token but absent from the allowlist never counts.
 *
 * resolveProject() THROWS when the chain cannot be read, so every caller fails closed; it returns null only when
 * every canonical factory answered and none knows the token.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./syncnet-core.js'), require('./syncnet-chain.js'));
  else root.SyncNetOrigins = factory(root.SyncNetCore, root.SyncNetChain);
})(typeof self !== 'undefined' ? self : this, function (Core, Chain) {
  'use strict';
  if (!Core || !Chain) throw new Error('SyncNetOrigins requires SyncNetCore and SyncNetChain.');

  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const ZERO = '0x0000000000000000000000000000000000000000';
  const isAddr = (v) => /^0x[0-9a-fA-F]{40}$/.test(String(v || ''));

  const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
  /**
   * Verified Pons V2 stacks, oldest first. `fromBlock` is the factory's deployment block, verified on-chain:
   *   v2a  deploy tx 0x3817f297aa7c2ef78789bffac57491ceedc218fef962d47ed36c272699deddeb (receipt.contractAddress =
   *        the factory, block 26841846, 2026-08-03T14:41:19Z); memeHook() = 0xe5e7…e044.
   * A new stack is added here (code review) with its own id, factory, deployment block and hook; ids never change.
   */
  const PONS_V2_STACKS = Object.freeze([
    Object.freeze({ id: 'v2a', factory: PONS_V2_FACTORY, fromBlock: 26841846, hook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044' }),
  ]);
  const PONS_V2_TOKEN_LAUNCHED = Core.keccak256Utf8('TokenLaunched(address,address,address,address,uint256,uint256)');
  /** Internal Economy-root sentinel for a native-ETH pair (pairToken == address(0)). Never an address, never WETH. */
  const PONS_NATIVE = 'native';
  /** Canonical Pons V1 factories (detection only). Only these may establish PONS_V1 origin. */
  const PONS_V1_FACTORIES = Object.freeze([
    Object.freeze({ address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', generation: 'ACTIVE' }),
    Object.freeze({ address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4', generation: 'LEGACY' }),
  ]);
  const PONS_V1_FACTORY = PONS_V1_FACTORIES[0].address; // the ACTIVE generation
  const PAR_FACTORIES = Object.freeze([lc(Chain.ROBINHOOD.multiFactory), lc(Chain.ROBINHOOD.factory)]);
  /** The ONLY destinations a Marketplace creator-fee transfer may ever be sent to. */
  const FEE_FACTORIES = Object.freeze(PAR_FACTORIES.concat([PONS_V2_FACTORY]));

  const ORIGINS = Object.freeze({
    PAR: Object.freeze({ id: 'PAR', label: 'PAR', badge: 'LIVE PAR PROJECT', venue: 'PAR factory record' }),
    PONS_V2: Object.freeze({ id: 'PONS_V2', label: 'PONS V2', badge: 'LIVE PONS PROJECT', venue: 'Pons V2 factory record' }),
    PONS_V1: Object.freeze({ id: 'PONS_V1', label: 'PONS V1', badge: 'PONS V1 PROJECT', venue: 'Pons V1 factory record' }),
  });

  const SEL = Object.freeze({
    getLaunchedToken: Core.functionSelector('getLaunchedToken(address)'),
    pendingCreatorFeeRecipient: Core.functionSelector('pendingCreatorFeeRecipient(address)'),
    transferCreatorFeeRecipient: Core.functionSelector('transferCreatorFeeRecipient(address,address)'),
    launchFactory: Core.functionSelector('launchFactory()'),
    symbol: Core.functionSelector('symbol()'),
    decimals: Core.functionSelector('decimals()'),
  });
  const PONS_V2_RECORD = '(address,address,address,address,address,uint256,uint24,int24,uint16,bool,uint8,uint256,uint256,uint256,bool)';
  const PONS_V1_RECORD = '(address,address,address,address,uint256,uint256,uint256,uint256,uint256,bool,uint24,bool,uint256)';
  /**
   * GraduationPhase, in enum order. Transitional and rescue states are never shown as "graduated": Swept means the
   * curve is closed and its reserves were swept, but the V4 pool does not exist yet.
   */
  const PONS_PHASES = Object.freeze([
    Object.freeze({ code: 'NotGraduated', label: 'BONDING CURVE' }),
    Object.freeze({ code: 'Swept', label: 'CURVE CLOSED · POOL PENDING' }),
    Object.freeze({ code: 'PoolCreated', label: 'GRADUATED · V4' }),
    Object.freeze({ code: 'Rescued', label: 'RESCUED' }),
  ]);
  const phaseOf = (n) => PONS_PHASES[n] || { code: 'Unknown(' + n + ')', label: 'UNKNOWN PHASE' };
  /** Clock tolerance when deciding whether a pending override can still execute (err on "still pending"). */
  const PENDING_GRACE_SECONDS = 600;

  const enc = (sel, types, values) => sel + Core.abiEncode(types, values).slice(2);
  async function call(rpc, to, data) {
    const hex = await Chain.ethCall(rpc, to, data); // throws on RPC failure / revert
    return !hex || hex === '0x' ? null : hex;
  }

  const verifiedFactory = (factory) => {
    const f = factory == null ? PONS_V2_FACTORY : lc(factory);
    if (!PONS_V2_STACKS.some((s) => s.factory === f)) throw new Error('Not a verified Pons V2 factory.');
    return f;
  };
  /** getLaunchedToken(token) calldata for a verified factory (used by batched readers). */
  const ponsV2RecordCall = (token, factory) => ({ to: verifiedFactory(factory), data: enc(SEL.getLaunchedToken, ['address'], [lc(token)]) });
  /** Decodes a getLaunchedToken answer: the record, or null unless it names exactly `token` with exists == true. */
  function decodePonsV2Record(hex, token, factory) {
    const t = lc(token), f = verifiedFactory(factory);
    if (!hex || hex === '0x') return null;
    const r = Core.abiDecode([PONS_V2_RECORD], hex)[0];
    if (r[14] !== true || lc(r[0]) !== t) return null;
    return {
      token: lc(r[0]), curve: lc(r[1]), deployer: lc(r[2]), creatorFeeRecipient: lc(r[3]), pairToken: lc(r[4]),
      graduationThreshold: String(r[5]), poolFee: Number(r[6]), tickSpacing: Number(r[7]), creatorTaxBps: Number(r[8]),
      buybackEnabled: r[9] === true, phase: Number(r[10]), sweptQuote: String(r[11]), sweptTokens: String(r[12]), sweptAt: String(r[13]),
      factory: f,
    };
  }
  /**
   * Pons V2 factory record, or null when the factory does not know the token. Throws when unreadable.
   * `factory` (default: the current PONS_V2_FACTORY) must be a verified stack's factory.
   */
  async function readPonsV2(rpc, token, factory) {
    const c = ponsV2RecordCall(token, factory);
    return decodePonsV2Record(await call(rpc, c.to, c.data), token, c.to);
  }
  /**
   * The launch record of `token` in ANY verified Pons V2 stack (newest stack first), or null when every verified
   * factory answered and none knows it. Throws when a factory cannot be read (callers fail closed). This is the live
   * authority for a Pons pair relationship; a discovery-index entry never is.
   */
  async function readPonsV2Launch(rpc, token) {
    for (const s of PONS_V2_STACKS.slice().reverse()) {
      const rec = await readPonsV2(rpc, token, s.factory);
      if (rec) return { ...rec, stack: s.id };
    }
    return null;
  }

  const HEX32 = /^0x[0-9a-f]{64}$/;
  const wordAddr = (w) => (/^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null);
  const hexInt = (v) => (typeof v === 'string' && /^0x[0-9a-f]{1,16}$/i.test(v) ? Number.parseInt(v, 16) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  /**
   * One eth_getLogs entry -> a canonical Pons V2 launch fact, or null. Accepted only when the log was emitted by a
   * verified stack's factory (log.address, never a token's claim), is not `removed`, carries the exact TokenLaunched
   * topic and layout, and names non-zero token/curve/deployer addresses. The pair relationship (token LAUNCHED_AGAINST
   * pairToken) is this event, nothing else: no ticker, no metadata, no website.
   */
  function decodePonsV2Launch(log) {
    if (!log || typeof log !== 'object' || log.removed === true) return null;
    const stack = PONS_V2_STACKS.find((s) => s.factory === lc(log.address));
    if (!stack) return null;
    const topics = Array.isArray(log.topics) ? log.topics.map(lc) : [];
    if (topics.length !== 4 || topics[0] !== PONS_V2_TOKEN_LAUNCHED || !topics.every((t) => HEX32.test(t))) return null;
    const data = lc(log.data);
    if (!/^0x[0-9a-f]{192}$/.test(data)) return null;
    const [token, curve, deployer] = topics.slice(1).map((t) => wordAddr(t.slice(2)));
    const pairToken = wordAddr(data.slice(2, 66));
    if (!token || !curve || !deployer || !pairToken || token === ZERO || curve === ZERO || deployer === ZERO) return null;
    const block = hexInt(log.blockNumber), logIndex = hexInt(log.logIndex);
    const blockHash = lc(log.blockHash), txHash = lc(log.transactionHash);
    if (block === null || logIndex === null || !HEX32.test(blockHash) || !HEX32.test(txHash)) return null;
    const native = pairToken === ZERO;
    return {
      token, curve, deployer, pairToken, root: native ? PONS_NATIVE : pairToken, native,
      launchConfigId: BigInt('0x' + data.slice(66, 130)).toString(), graduationThreshold: BigInt('0x' + data.slice(130, 194)).toString(),
      block, blockHash, txHash, logIndex, factory: stack.factory, stack: stack.id,
    };
  }
  /** The protocol-owner creator-fee-recipient override for a Pons V2 launch. Throws when unreadable. */
  async function readPonsV2Pending(rpc, token, nowSec) {
    const hex = await call(rpc, PONS_V2_FACTORY, enc(SEL.pendingCreatorFeeRecipient, ['address'], [lc(token)]));
    // An empty answer from the canonical factory is unexpected: treat it as an override we could not rule out.
    if (!hex) return { newRecipient: null, effectiveAt: null, expiresAt: null, active: true, unreadable: true };
    const [newRecipient, effectiveAt, expiresAt] = Core.abiDecode(['address', 'uint256', 'uint256'], hex);
    const now = BigInt(Math.floor(Number.isFinite(nowSec) ? nowSec : Date.now() / 1000));
    const exists = lc(newRecipient) !== ZERO;
    // Pending until it can no longer execute (after expiresAt nobody can apply it). A not-yet-matured proposal is
    // pending too: once matured it supersedes any transfer the creator made in the meantime.
    const active = exists && BigInt(expiresAt) + BigInt(PENDING_GRACE_SECONDS) >= now;
    return exists ? { newRecipient: lc(newRecipient), effectiveAt: Number(effectiveAt), expiresAt: Number(expiresAt), active } : null;
  }
  /**
   * Pons V1 identification (detection only), or null. Bidirectional: token.launchFactory() must name a canonical V1
   * factory AND that factory's record must name this token with exists == true. A token without launchFactory()
   * (revert / empty / malformed answer) is not V1. Throws when the chain cannot be read.
   */
  async function readPonsV1(rpc, token) {
    const t = lc(token);
    let h;
    try { h = await call(rpc, t, SEL.launchFactory); } catch (err) {
      if (err && err.revert) return null; // the token has no launchFactory(): not a Pons V1 token
      throw err; // any other failure is an unreadable chain: fail closed
    }
    let claimed = null;
    try { claimed = h ? lc(Core.abiDecode(['address'], h)[0]) : null; } catch { claimed = null; } // malformed token answer
    const factory = PONS_V1_FACTORIES.find((f) => f.address === claimed);
    if (!factory) return null; // only allowlisted factories establish origin, never one the token names on its own
    const hex = await call(rpc, factory.address, enc(SEL.getLaunchedToken, ['address'], [t]));
    if (!hex) return null;
    const r = Core.abiDecode([PONS_V1_RECORD], hex)[0];
    if (r[11] !== true || lc(r[0]) !== t) return null;
    return { token: lc(r[0]), deployer: lc(r[1]), pairedToken: lc(r[2]), factory: factory.address, generation: factory.generation };
  }

  function normalizePar(launch, token) {
    return {
      origin: 'PAR', label: ORIGINS.PAR.label, supported: true, token, factory: lc(launch.factory),
      deployer: lc(launch.deployer), creatorFeeRecipient: lc(launch.creatorFeeRecipient),
      creatorTaxBps: launch.creatorTaxBps, pair: null, state: null, buybackEnabled: null, pendingOverride: null,
      raw: launch, kind: launch.kind, // kept so existing PAR consumers see the same fields they always read
    };
  }
  function normalizePonsV2(rec, pending, token) {
    const phase = phaseOf(rec.phase);
    return {
      origin: 'PONS_V2', label: ORIGINS.PONS_V2.label, supported: true, token, factory: PONS_V2_FACTORY,
      deployer: rec.deployer, creatorFeeRecipient: rec.creatorFeeRecipient, creatorTaxBps: rec.creatorTaxBps,
      pair: { address: rec.pairToken, native: rec.pairToken === ZERO },
      state: { phase: rec.phase, code: phase.code, label: phase.label }, buybackEnabled: rec.buybackEnabled,
      pendingOverride: pending, raw: rec,
    };
  }

  /**
   * token -> normalized project | {origin:'PONS_V1', supported:false, …} | null. Throws if any canonical factory
   * cannot be read, so "unsupported" is only ever reported after every factory positively answered.
   */
  async function resolveProject(rpc, token, opts) {
    if (!isAddr(token)) return null;
    const t = lc(token);
    const par = await Chain.readLaunch(rpc, t);
    if (par) return normalizePar(par, t);
    const v2 = await readPonsV2(rpc, t);
    if (v2) return normalizePonsV2(v2, await readPonsV2Pending(rpc, t, opts && opts.nowSec), t);
    const v1 = await readPonsV1(rpc, t);
    if (v1) return { origin: 'PONS_V1', label: ORIGINS.PONS_V1.label, supported: false, token: t, factory: v1.factory, generation: v1.generation, deployer: v1.deployer };
    return null;
  }

  /**
   * Conservative creator-fee-right classification (same shapes the Marketplace has always stored):
   *  vault (PAR vault, never transferable) · contract / unknown (manual verification) · encumbered (Pons override
   *  pending) · wallet (EOA or EIP-7702 account: transferable by the current recipient itself).
   */
  async function classifyFeeRight(rpc, project) {
    const recipient = lc(project.creatorFeeRecipient);
    if (project.origin === 'PAR') {
      const vault = Chain.VAULT_MODES[recipient];
      if (vault) return { recipient, kind: 'vault', vault, transferable: false, label: 'NOT TRANSFERABLE · fixed to a PAR vault' };
    }
    let code = '';
    try { code = lc(await Chain.getCode(rpc, recipient)); } catch { code = null; }
    if (code === null) return { recipient, kind: 'unknown', transferable: false, label: 'REQUIRES MANUAL VERIFICATION · recipient could not be read' };
    const wallet = code === '0x' || code.startsWith('0xef0100');
    if (!wallet) return { recipient, kind: 'contract', transferable: false, label: 'REQUIRES MANUAL VERIFICATION · recipient is a contract' };
    const p = project.pendingOverride;
    if (project.origin === 'PONS_V2' && p && p.active) {
      return { recipient, kind: 'encumbered', transferable: false, label: 'ENCUMBERED · a Pons protocol override of the fee recipient is pending', pending: { newRecipient: p.newRecipient, effectiveAt: p.effectiveAt, expiresAt: p.expiresAt } };
    }
    return { recipient, kind: 'wallet', transferable: true, label: 'Transferable on-chain by the current recipient wallet' };
  }

  /** Display-only pair info (never security-relevant): ETH for the native pair, else the ERC-20's own symbol. */
  async function pairInfo(rpc, address) {
    const a = lc(address);
    if (!isAddr(a) || a === ZERO) return { address: ZERO, symbol: 'ETH', decimals: 18, native: true };
    let symbol = '', decimals = null;
    try { const h = await call(rpc, a, SEL.symbol); if (h) symbol = String(Core.abiDecode(['string'], h)[0] || ''); } catch { symbol = ''; }
    try { const h = await call(rpc, a, SEL.decimals); if (h) decimals = Number(Core.abiDecode(['uint8'], h)[0]); } catch { decimals = null; }
    const clean = Core.sanitizeForDisplay(symbol, { maxLength: 16 }).replace(/^\$/, '').toUpperCase();
    return { address: a, symbol: clean || '', decimals, native: false };
  }

  /** Server-derived, display-safe origin facts stored on listings (no raw chain data). */
  function publicOrigin(project, pair) {
    const base = { launchpad: project.origin, label: project.label, factory: project.factory };
    if (project.origin !== 'PONS_V2') return base;
    return {
      ...base,
      pair: pair ? { address: pair.address, symbol: pair.symbol || '', native: Boolean(pair.native) } : { address: project.pair.address, symbol: project.pair.native ? 'ETH' : '', native: project.pair.native },
      phase: { code: project.state.code, label: project.state.label },
      creatorTaxBps: project.creatorTaxBps, buybackEnabled: project.buybackEnabled,
    };
  }
  /** Origin of a stored record: its server-derived field, or (records written before origins existed) its factory. */
  function originOfFactory(factory) {
    const f = lc(factory);
    if (PAR_FACTORIES.includes(f)) return 'PAR';
    if (f === PONS_V2_FACTORY) return 'PONS_V2';
    return null;
  }
  function recordOrigin(rec) {
    const o = rec && rec.origin && ORIGINS[rec.origin.launchpad] ? rec.origin.launchpad : rec && ORIGINS[rec.launchpad] ? rec.launchpad : originOfFactory(rec && rec.factory);
    return o || 'PAR'; // every record written before multi-origin support was a verified PAR launch
  }

  /**
   * The single builder for a creator-fee-right transfer transaction. Destination = the canonical factory of the
   * project's VERIFIED origin (never client input), calldata = transferCreatorFeeRecipient(exact token, exact buyer).
   */
  function feeTransferTx(project, token, newRecipient) {
    if (!project || !project.supported || !(project.origin === 'PAR' || project.origin === 'PONS_V2')) throw new Error('Unsupported project origin.');
    const to = lc(project.factory);
    if (!FEE_FACTORIES.includes(to)) throw new Error('Refusing to send to a non-canonical factory.');
    if (project.origin === 'PONS_V2' && to !== PONS_V2_FACTORY) throw new Error('Pons V2 fee transfers go to the Pons V2 factory only.');
    if (project.origin === 'PAR' && !PAR_FACTORIES.includes(to)) throw new Error('PAR fee transfers go to a PAR factory only.');
    if (!isAddr(token) || lc(token) !== lc(project.token)) throw new Error('Token mismatch.');
    if (!isAddr(newRecipient) || lc(newRecipient) === ZERO) throw new Error('Invalid new recipient.');
    return { to, data: enc(SEL.transferCreatorFeeRecipient, ['address', 'address'], [lc(token), lc(newRecipient)]), value: '0x0' };
  }

  return Object.freeze({
    PONS_V2_FACTORY, PONS_V2_STACKS, PONS_V2_TOKEN_LAUNCHED, PONS_NATIVE, PONS_V1_FACTORY, PONS_V1_FACTORIES, PAR_FACTORIES, FEE_FACTORIES,
    ORIGINS, PONS_PHASES, SEL, PENDING_GRACE_SECONDS, phaseOf, decodePonsV2Launch, readPonsV2Launch, ponsV2RecordCall, decodePonsV2Record,
    resolveProject, readPonsV2, readPonsV2Pending, readPonsV1, classifyFeeRight, pairInfo, publicOrigin,
    originOfFactory, recordOrigin, feeTransferTx,
  });
});
