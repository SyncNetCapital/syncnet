/*
 * SyncNet Project Home — activation pricing (browser + Netlify functions). Integer arithmetic only (BigInt).
 *
 * PRODUCT PRICE is denominated in USD:  PROJECT HOME ACTIVATION = $49 USD (priceUsdCents 4900, priceVersion 1).
 * It is paid EXCLUSIVELY in $SYNC, converted with the SYNCNET REFERENCE RATE — a server-controlled, versioned
 * SYNC/USD rate reviewed in git (syncnet-project-home-rates.json). It is NOT an oracle and is never called one.
 *
 * Fixed-point representation
 *   priceUsdCents  integer US cents                               4900        = $49.00
 *   rateUsdE18     integer: USD per 1 whole SYNC × 10^18          5e13        = $0.00005 / SYNC
 *                  (parsed from a decimal string with <= 18 fractional digits, never via floating point)
 *   amounts        integer SYNC wei (18 decimals)                 9.8e23      = 980,000 SYNC
 *
 *   baseSyncWei = ceil( priceUsdCents × 10^18 (wei per SYNC) × 10^18 (rate scale) / (100 × rateUsdE18) )
 *               = ceil( priceUsdCents × 10^34 / rateUsdE18 )                  — ROUNDED UP, never undercharges
 *
 * Payment tag (distinguishes concurrent payments to the one sink; chosen by the server, never by the client)
 *   exactTaggedSyncAmount = roundUpTo(baseSyncWei, TAG_MODULUS) + tag,  TAG_MODULUS = 10^12 wei (10^-6 SYNC),
 *   tag uniform in [1, TAG_MODULUS − 1] from a CSPRNG (rejection sampling, no modulo bias).
 *   => exact > baseSyncWei always (the tag can never lower the price); exact − base < 2 × 10^-6 SYNC (negligible);
 *      exact % TAG_MODULUS == tag (the tag lives in the 12 lowest decimals); the full 18-decimal amount is displayed.
 *   Uniqueness is not left to chance: the server reserves every exact amount (SET-if-absent) for longer than any
 *   window in which a payment could match it, so two live intents can never share an amount.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SyncNetProjectHomePricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DECIMALS = 18;
  const WEI_PER_SYNC = 10n ** 18n;
  const RATE_SCALE = 10n ** 18n;
  const TAG_MODULUS = 10n ** 12n;
  const LOCK_SECONDS = 30 * 60; // rate lock of a payment intent

  // Range validation (fail closed outside these bounds).
  const MIN_PRICE_CENTS = 1;
  const MAX_PRICE_CENTS = 10_000_000; // $100,000
  const MIN_RATE_E18 = 10n ** 6n; // $0.000000000001 per SYNC
  const MAX_RATE_E18 = 10n ** 24n; // $1,000,000 per SYNC
  const MAX_SYNC_WEI = 10n ** 12n * WEI_PER_SYNC; // 1,000,000,000,000 SYNC: any quote above this is refused
  const UINT256_MAX = (1n << 256n) - 1n;

  const DECIMAL = /^(0|[1-9]\d{0,6})(?:\.(\d{1,18}))?$/; // <= 7 integer digits, <= 18 decimals, no sign/exponent

  class PricingError extends Error {
    constructor(code, message) { super(message || code); this.name = 'PricingError'; this.code = code; }
  }

  /** Decimal USD string -> rateUsdE18 BigInt. Rejects floats, exponents, signs, >18 decimals, zero, out of range. */
  function parseRate(text) {
    if (typeof text !== 'string') throw new PricingError('rate_invalid', 'rate must be a decimal string');
    const m = DECIMAL.exec(text);
    if (!m) throw new PricingError('rate_invalid', 'rate must be a plain decimal with at most 18 decimals');
    const e18 = BigInt(m[1]) * RATE_SCALE + BigInt((m[2] || '').padEnd(18, '0') || '0');
    if (e18 <= 0n) throw new PricingError('rate_zero', 'rate must be positive');
    if (e18 < MIN_RATE_E18 || e18 > MAX_RATE_E18) throw new PricingError('rate_range', 'rate outside the accepted range');
    return e18;
  }

  /** rateUsdE18 -> canonical decimal string (no trailing zeros). parseRate(formatRate(x)) === x. */
  function formatRate(e18) { return formatUnits(e18, 18); }

  /** Integer wei -> exact decimal string (no rounding, no trailing zeros). */
  function formatUnits(value, decimals) {
    const v = BigInt(value);
    if (v < 0n) throw new PricingError('amount_invalid', 'negative amount');
    const d = decimals == null ? DECIMALS : decimals;
    const base = 10n ** BigInt(d);
    const whole = v / base;
    const frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : `${whole}`;
  }

  /** Exact decimal string with thousands separators in the integer part (display only). */
  function displaySync(value) {
    const [w, f] = formatUnits(value).split('.');
    const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return f ? `${grouped}.${f}` : grouped;
  }

  function checkPriceCents(cents) {
    if (!Number.isSafeInteger(cents) || cents < MIN_PRICE_CENTS || cents > MAX_PRICE_CENTS) throw new PricingError('price_invalid', 'priceUsdCents out of range');
    return cents;
  }

  /** ceil(priceUsdCents × 10^34 / rateUsdE18) with range checks. */
  function baseSyncWei(priceUsdCents, rateUsdE18) {
    checkPriceCents(priceUsdCents);
    const rate = BigInt(rateUsdE18);
    if (rate <= 0n) throw new PricingError('rate_zero', 'rate must be positive');
    if (rate < MIN_RATE_E18 || rate > MAX_RATE_E18) throw new PricingError('rate_range', 'rate outside the accepted range');
    const num = BigInt(priceUsdCents) * WEI_PER_SYNC * RATE_SCALE; // <= 1e7 × 1e36: far below 2^256
    const den = 100n * rate;
    const q = (num + den - 1n) / den; // ceiling division: round UP, never undercharge
    if (q <= 0n || q > MAX_SYNC_WEI) throw new PricingError('amount_range', 'quote outside the accepted range');
    return q;
  }

  /** roundUpTo(base, TAG_MODULUS) + tag. tag must be in [1, TAG_MODULUS − 1]. */
  function taggedAmount(base, tag) {
    const b = BigInt(base), t = BigInt(tag);
    if (b <= 0n || b > MAX_SYNC_WEI) throw new PricingError('amount_range', 'base amount out of range');
    if (t < 1n || t >= TAG_MODULUS) throw new PricingError('tag_invalid', 'tag out of range');
    const rounded = ((b + TAG_MODULUS - 1n) / TAG_MODULUS) * TAG_MODULUS;
    const exact = rounded + t;
    if (exact <= b || exact > UINT256_MAX) throw new PricingError('amount_range', 'tagged amount invalid');
    return exact;
  }

  /** Uniform tag in [1, TAG_MODULUS − 1] from `randomBytes(n) -> Uint8Array` (CSPRNG). Rejection sampling. */
  function randomTag(randomBytes) {
    const LIMIT = (1n << 40n) - ((1n << 40n) % (TAG_MODULUS - 1n)); // largest multiple of (MOD−1) below 2^40
    for (let i = 0; i < 64; i++) {
      const bytes = randomBytes(5);
      let x = 0n;
      for (const b of bytes) x = (x << 8n) | BigInt(b);
      if (x < LIMIT) return 1n + (x % (TAG_MODULUS - 1n));
    }
    throw new PricingError('tag_rng', 'random source failed');
  }

  const tagOf = (exact) => BigInt(exact) % TAG_MODULUS;

  // ------------------------------------------------------------------ versioned configuration (git-reviewed file)
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;

  /**
   * Validates the whole rate/price file. ANY malformed entry, duplicate version or ambiguous value makes the whole
   * table invalid (fail closed) — a typo can never silently select a different rate.
   * Returns {prices: Map<priceVersion,{priceUsdCents}>, rates: Map<rateVersion, rate>}.
   */
  function loadTable(file) {
    if (!file || typeof file !== 'object' || file.schema !== 'syncnet.project-home.pricing.v1') throw new PricingError('config_invalid', 'unknown pricing file schema');
    const prices = new Map();
    for (const p of Array.isArray(file.prices) ? file.prices : []) {
      if (!p || !isPosInt(p.priceVersion) || prices.has(p.priceVersion)) throw new PricingError('config_invalid', 'bad or duplicate priceVersion');
      checkPriceCents(p.priceUsdCents);
      prices.set(p.priceVersion, Object.freeze({ priceVersion: p.priceVersion, priceUsdCents: p.priceUsdCents, product: String(p.product || '') }));
    }
    const rates = new Map();
    for (const r of Array.isArray(file.rates) ? file.rates : []) {
      if (!r || !isPosInt(r.rateVersion) || rates.has(r.rateVersion)) throw new PricingError('config_invalid', 'bad or duplicate rateVersion');
      const e18 = parseRate(r.syncUsd);
      if (formatRate(e18) !== r.syncUsd) throw new PricingError('config_invalid', 'rate must be written in canonical form (no trailing zeros)');
      if (!ISO.test(String(r.effectiveAt)) || !ISO.test(String(r.expiresAt))) throw new PricingError('config_invalid', 'effectiveAt/expiresAt must be ISO-8601 UTC');
      const eff = Date.parse(r.effectiveAt), exp = Date.parse(r.expiresAt);
      if (!(exp > eff)) throw new PricingError('config_invalid', 'expiresAt must be after effectiveAt');
      rates.set(r.rateVersion, Object.freeze({ rateVersion: r.rateVersion, syncUsdReferenceRate: r.syncUsd, rateUsdE18: e18.toString(), rateEffectiveAt: new Date(eff).toISOString(), rateExpiresAt: new Date(exp).toISOString(), source: String(r.source || '') }));
    }
    return { prices, rates };
  }

  /** Canonical, immutable identity of a rate version (what the server snapshots on first use). */
  const rateIdentity = (r) => ({ rateVersion: r.rateVersion, syncUsdReferenceRate: r.syncUsdReferenceRate, rateUsdE18: r.rateUsdE18, rateEffectiveAt: r.rateEffectiveAt });
  const priceIdentity = (p) => ({ priceVersion: p.priceVersion, priceUsdCents: p.priceUsdCents });

  return Object.freeze({
    DECIMALS, WEI_PER_SYNC, RATE_SCALE, TAG_MODULUS, LOCK_SECONDS, MIN_PRICE_CENTS, MAX_PRICE_CENTS, MIN_RATE_E18, MAX_RATE_E18, MAX_SYNC_WEI,
    PricingError, parseRate, formatRate, formatUnits, displaySync, baseSyncWei, taggedAmount, randomTag, tagOf, checkPriceCents,
    loadTable, rateIdentity, priceIdentity,
  });
});
