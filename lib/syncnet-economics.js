/*
 * SyncNet Economics — the public $SYNC network numbers shown on /stats and the Explore economics strip.
 * One loader, two sources, nothing invented:
 *
 *   SYNC burned     LIVE ON-CHAIN. 1,000,000,000 (fixed initial supply) minus the token's current totalSupply(),
 *                   read with a single eth_call to the Robinhood Chain RPC.
 *   NET / USDG      INDEXED. Cumulative holder distributions and the recent rounds come from PAR's public indexer
 *                   (/distributions?token=$SYNC) — the same source the $SYNC page already uses. The indexer reads
 *                   PAR's holder-vault payouts; SyncNet does not compute them. Assets are matched by contract
 *                   address, never by symbol.
 *   24h figures     Summed from the indexer's recent rounds, and only when those rounds demonstrably cover the full
 *                   24 h window. Otherwise they are unavailable (null) — never a guessed 0.
 *
 * Every value is either a real BigInt or null ("unknown"). Callers render null as an em dash.
 * Works in the browser (window.SyncNetEconomics) and in Node (require) so the parsing is unit-testable.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncNetEconomics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
  const NET = '0xca9c78dd337a67f6e0077f65f5e9218719d30edf';
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const INITIAL_SUPPLY = 1000000000n * 10n ** 18n; // $SYNC was minted once; burns only ever reduce totalSupply()
  const RPC = 'https://rpc.mainnet.chain.robinhood.com/';
  const API = 'https://api.par.family';
  const EXPLORER = 'https://robinhoodchain.blockscout.com';
  const TOTAL_SUPPLY_SELECTOR = '0x18160ddd';
  const DAY = 86400;
  const TIMEOUT_MS = 12000;

  const lc = (v) => String(v == null ? '' : v).toLowerCase();
  const big = (v) => { try { return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null; } catch { return null; } };

  /** totalSupply() eth_call result → BigInt, or null when the reply is not a 32-byte word. */
  function parseSupply(hex) {
    return typeof hex === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(hex) ? BigInt(hex) : null;
  }
  /** Burned = initial − current. A supply above the initial one would be a broken assumption → unknown, not 0. */
  function burnedFromSupply(supply) {
    return typeof supply === 'bigint' && supply <= INITIAL_SUPPLY ? INITIAL_SUPPLY - supply : null;
  }

  /**
   * PAR /distributions body → the economics we can state. `nowSec` is injectable for tests.
   * { net:{amount,decimals}|null, usdg:…|null, net24, usdg24, events:[{asset,symbol,amount,decimals,timestamp,txHash}], lastAt }
   */
  function parseDistributions(body, nowSec) {
    if (!body || typeof body !== 'object' || lc(body.token) !== SYNC) return null;
    const totals = Array.isArray(body.totals) ? body.totals : [];
    const items = Array.isArray(body.items) ? body.items : [];
    const total = (addr) => {
      const t = totals.find((x) => x && lc(x.asset) === addr);
      const amount = t && big(t.total), decimals = t && Number(t.decimals);
      return amount != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? { amount, decimals } : null;
    };
    const stamp = (x) => { const n = Number(x && x.timestamp); return Number.isFinite(n) && n > 0 ? n : 0; };
    const valid = items.filter((x) => x && stamp(x) && big(x.total) != null && /^0x[0-9a-fA-F]{64}$/.test(String(x.txHash || '')));
    // The 24 h sum is only honest when the oldest round we hold is older than the window (nothing hidden past the page).
    const oldest = items.length && valid.length === items.length ? Math.min(...valid.map(stamp)) : 0;
    const covered = oldest > 0 && oldest <= nowSec - DAY;
    const sum24 = (addr) => (covered ? valid.filter((x) => lc(x.asset) === addr && stamp(x) >= nowSec - DAY).reduce((a, x) => a + big(x.total), 0n) : null);
    const decOf = (addr) => (total(addr) || {}).decimals;
    const events = valid
      .filter((x) => lc(x.asset) === NET || lc(x.asset) === USDG)
      .sort((a, b) => stamp(b) - stamp(a))
      .map((x) => ({ asset: lc(x.asset), symbol: lc(x.asset) === NET ? 'NET' : 'USDG', amount: big(x.total), decimals: Number(x.decimals), timestamp: stamp(x), txHash: String(x.txHash).toLowerCase() }))
      .filter((e) => Number.isInteger(e.decimals) && e.decimals >= 0 && e.decimals <= 36);
    const net24 = sum24(NET), usdg24 = sum24(USDG);
    return {
      net: total(NET), usdg: total(USDG),
      net24: net24 == null || decOf(NET) == null ? null : { amount: net24, decimals: decOf(NET) },
      usdg24: usdg24 == null || decOf(USDG) == null ? null : { amount: usdg24, decimals: decOf(USDG) },
      events, lastAt: Number(body.lastAt) > 0 ? Number(body.lastAt) : null,
    };
  }

  /** BigInt base units → "1,234.57". Truncates (never rounds up a figure). `null` → em dash. */
  function formatUnits(amount, decimals, maxFrac) {
    if (typeof amount !== 'bigint' || !Number.isInteger(decimals)) return '—';
    const base = 10n ** BigInt(decimals);
    const whole = amount / base;
    const fracFull = decimals ? (amount % base).toString().padStart(decimals, '0') : '';
    const f = maxFrac == null ? (whole >= 1000000n ? 0 : whole >= 1000n ? 2 : 4) : maxFrac;
    const frac = fracFull.slice(0, Math.min(f, decimals)).replace(/0+$/, '');
    const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return w + (frac ? '.' + frac : '');
  }
  const formatAmount = (v, maxFrac) => (v ? formatUnits(v.amount, v.decimals, maxFrac) : '—');

  const txUrl = (hash) => (/^0x[0-9a-fA-F]{64}$/.test(hash) ? EXPLORER + '/tx/' + hash : '');

  async function fetchJson(url, init) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const r = await fetch(url, Object.assign({ cache: 'no-store', signal: ctl && ctl.signal }, init));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { if (timer) clearTimeout(timer); }
  }
  async function readBurned() {
    const body = await fetchJson(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: SYNC, data: TOTAL_SUPPLY_SELECTOR }, 'latest'] }) });
    const supply = parseSupply(body && body.result);
    const burned = burnedFromSupply(supply);
    if (burned == null) throw new Error('unreadable supply');
    return { amount: burned, decimals: 18 };
  }
  async function readDistributions() {
    const parsed = parseDistributions(await fetchJson(API + '/distributions?token=' + SYNC), Math.floor(Date.now() / 1000));
    if (!parsed) throw new Error('unexpected distributions reply');
    return parsed;
  }

  // One shared in-flight request: the strip and the page (or repeat visits within a minute) never double-call.
  let inflight = null, cached = null;
  /** → { burned, net, usdg, net24, usdg24, events, lastAt, fetchedAt, errors:{chain,index} } — each failed source is null. */
  function load(opts) {
    if (!(opts && opts.force) && cached && Date.now() - cached.fetchedAt < 60000) return Promise.resolve(cached);
    if (inflight) return inflight;
    inflight = Promise.allSettled([readBurned(), readDistributions()]).then(([c, d]) => {
      const dist = d.status === 'fulfilled' ? d.value : null;
      cached = {
        burned: c.status === 'fulfilled' ? c.value : null,
        net: dist && dist.net, usdg: dist && dist.usdg, net24: dist && dist.net24, usdg24: dist && dist.usdg24,
        events: dist ? dist.events : [], lastAt: dist && dist.lastAt, fetchedAt: Date.now(),
        errors: { chain: c.status !== 'fulfilled', index: d.status !== 'fulfilled' },
      };
      inflight = null;
      return cached;
    });
    return inflight;
  }

  return { SYNC, NET, USDG, INITIAL_SUPPLY, EXPLORER, parseSupply, burnedFromSupply, parseDistributions, formatUnits, formatAmount, txUrl, load };
});
