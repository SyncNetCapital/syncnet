// Project Home pricing: USD-denominated price, SYNC/USD reference rate, fixed-point conversion (round UP), payment tag,
// versioned configuration and the fail-closed rollout gate. Pure — no network. Run: node tests/project-home/pricing.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const P = require(path.join(ROOT, 'lib/syncnet-project-home-pricing.js'));
const { projectHomeConfig } = require(path.join(ROOT, 'netlify/lib/project-home-config.js'));
console.log = ((orig) => (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"ts"')) return; orig(...a); })(console.log);

const results = []; let failures = 0;
function check(name, cond, detail = '') { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; process.stdout.write('FAIL ' + name + ' :: ' + String(detail).slice(0, 300) + '\n'); } }
const throwsCode = (fn, code) => { try { fn(); return false; } catch (e) { return e.code === code; } };
const E18 = 10n ** 18n;

// ---------------------------------------------------------------- fixed-point conversion
check('$39 at $0.00005 = exactly 780,000 SYNC', P.baseSyncWei(3900, P.parseRate('0.00005')) === 780000n * E18);
check('$39 at $0.0005 = exactly 78,000 SYNC', P.baseSyncWei(3900, P.parseRate('0.0005')) === 78000n * E18);
check('$39 at $0.005 = exactly 7,800 SYNC', P.baseSyncWei(3900, P.parseRate('0.005')) === 7800n * E18);
const odd = P.baseSyncWei(3900, P.parseRate('0.000037'));
check('non-terminating quotient rounds UP (never undercharges)', odd * 37n * 10n ** 12n >= 3900n * 10n ** 34n && (odd - 1n) * 37n * 10n ** 12n < 3900n * 10n ** 34n, odd);
check('rounding up: $39 / $0.07 = 557.142857… → 557.142857142857142858 SYNC', P.formatUnits(P.baseSyncWei(3900, P.parseRate('0.07'))) === '557.142857142857142858');
check('$39 / $0.03 divides exactly: 1300 SYNC, not bumped', P.formatUnits(P.baseSyncWei(3900, P.parseRate('0.03'))) === '1300');
check('exact division is not bumped', P.baseSyncWei(100, P.parseRate('1')) === E18);
check('$0.01 at $1e-12 would exceed the range cap → refused', throwsCode(() => P.baseSyncWei(3900, P.parseRate('0.000000000001')), 'amount_range'));
check('smallest accepted rate still quotes a small price', P.baseSyncWei(1, P.parseRate('0.000000000001')) === 10n ** 28n);
check('max rate $1,000,000: $39 = 0.000039 SYNC', P.formatUnits(P.baseSyncWei(3900, P.parseRate('1000000'))) === '0.000039');
check('rate above $1,000,000 refused', throwsCode(() => P.parseRate('1000000.000000000000000001'), 'rate_range'));
check('rate with 18 decimals parses exactly', P.parseRate('0.123456789012345678') === 123456789012345678n);
check('1 wei-of-rate (1e-18) is syntactically exact but refused by the range bound', throwsCode(() => P.parseRate('0.000000000000000001'), 'rate_range'));
check('rate below 1e-12 refused (range)', throwsCode(() => P.parseRate('0.0000000000001'), 'rate_range'));
check('zero rate refused', throwsCode(() => P.parseRate('0'), 'rate_zero') && throwsCode(() => P.parseRate('0.000'), 'rate_zero'));
for (const badRate of ['-0.1', '1e-5', '0.1e1', '.5', '5.', '0x10', ' 0.5', '0.5 ', '0,5', 'NaN', 'Infinity', '00.5', '0.0000000000000000001', '12345678']) check('malformed rate refused: ' + JSON.stringify(badRate), throwsCode(() => P.parseRate(badRate), 'rate_invalid'));
check('non-string rate (a JS number) refused — no floating point anywhere', throwsCode(() => P.parseRate(0.00005), 'rate_invalid'));
check('formatRate(parseRate(x)) is canonical', P.formatRate(P.parseRate('0.000050')) === '0.00005' && P.formatRate(P.parseRate('12.5')) === '12.5');
for (const c of [0, -1, 3900.5, 10_000_001, NaN, '3900']) check('invalid price cents refused: ' + String(c), throwsCode(() => P.baseSyncWei(c, P.parseRate('1')), 'price_invalid'));
check('negative / zero rateUsdE18 refused', throwsCode(() => P.baseSyncWei(3900, 0n), 'rate_zero') && throwsCode(() => P.baseSyncWei(3900, -5n), 'rate_zero'));
check('no Number() / parseFloat / Math in the arithmetic', !/parseFloat|Math\.(round|ceil|floor|pow)|toFixed|Number\(/.test(fs.readFileSync(path.join(ROOT, 'lib/syncnet-project-home-pricing.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
// exhaustive-ish random round-up property
let prop = true;
for (let i = 0; i < 2000; i++) {
  const cents = 1 + Number(crypto.randomBytes(3).readUIntBE(0, 3) % 100000);
  const rate = 10n ** 6n + BigInt('0x' + crypto.randomBytes(9).toString('hex')) % (10n ** 22n);
  let q; try { q = P.baseSyncWei(cents, rate); } catch (e) { if (e.code === 'amount_range') continue; prop = false; break; }
  const need = BigInt(cents) * 10n ** 34n; // q * rate must cover it, q-1 must not
  if (!(q * rate >= need && (q - 1n) * rate < need)) { prop = false; break; }
}
check('property (2000 random quotes): q = ceil(price·10^34 / rate) exactly', prop);

// ---------------------------------------------------------------- payment tag
const base = 780000n * E18;
check('tag lives in the 12 lowest decimals; exact > base', (() => { const x = P.taggedAmount(base, 123456789n); return x === base + 123456789n && x > base && P.tagOf(x) === 123456789n; })());
check('base not on a tag boundary is rounded UP before tagging', (() => { const b = base + 1n; const x = P.taggedAmount(b, 1n); return x === base + P.TAG_MODULUS + 1n && x > b; })());
check('tag 0 refused (would allow exact == base)', throwsCode(() => P.taggedAmount(base, 0n), 'tag_invalid'));
check('tag == modulus refused', throwsCode(() => P.taggedAmount(base, P.TAG_MODULUS), 'tag_invalid'));
check('economic difference < 2e-6 SYNC', P.taggedAmount(base + 1n, P.TAG_MODULUS - 1n) - (base + 1n) < 2n * P.TAG_MODULUS);
check('exact amount displays as a finite 18-decimal string', P.formatUnits(P.taggedAmount(base, 482117093551n)) === '780000.000000482117093551' && P.displaySync(P.taggedAmount(base, 1n)) === '780,000.000000000000000001');
let tagsOk = true; const seen = new Set();
for (let i = 0; i < 5000; i++) { const t = P.randomTag((n) => crypto.randomBytes(n)); if (t < 1n || t >= P.TAG_MODULUS) tagsOk = false; seen.add(t); }
check('5000 CSPRNG tags all in [1, 10^12-1]', tagsOk);
check('5000 CSPRNG tags: no collision (uniqueness is still enforced by reservation)', seen.size === 5000);
check('rejection sampling rejects out-of-range draws (no modulo bias)', (() => { let calls = 0; const t = P.randomTag(() => { calls++; return calls === 1 ? new Uint8Array([255, 255, 255, 255, 255]) : new Uint8Array([0, 0, 0, 0, 7]); }); return t === 8n && calls === 2; })());
check('a broken RNG fails closed', throwsCode(() => P.randomTag(() => new Uint8Array([255, 255, 255, 255, 255])), 'tag_rng'));

// ---------------------------------------------------------------- versioned configuration
const good = { schema: 'syncnet.project-home.pricing.v1', prices: [{ priceVersion: 1, priceUsdCents: 3900 }], rates: [{ rateVersion: 1, syncUsd: '0.00005', effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' }] };
check('valid table loads', P.loadTable(good).rates.get(1).rateUsdE18 === (5n * 10n ** 13n).toString());
check('duplicate rateVersion → whole table invalid', throwsCode(() => P.loadTable({ ...good, rates: [...good.rates, { ...good.rates[0], syncUsd: '0.0001' }] }), 'config_invalid'));
check('duplicate priceVersion → invalid', throwsCode(() => P.loadTable({ ...good, prices: [...good.prices, { priceVersion: 1, priceUsdCents: 100 }] }), 'config_invalid'));
check('non-canonical rate text → invalid', throwsCode(() => P.loadTable({ ...good, rates: [{ ...good.rates[0], syncUsd: '0.000050' }] }), 'config_invalid'));
check('rate written as a JSON number → invalid', throwsCode(() => P.loadTable({ ...good, rates: [{ ...good.rates[0], syncUsd: 0.00005 }] }), 'rate_invalid'));
check('expiresAt <= effectiveAt → invalid', throwsCode(() => P.loadTable({ ...good, rates: [{ ...good.rates[0], expiresAt: '2025-01-01T00:00:00Z' }] }), 'config_invalid'));
check('unknown schema → invalid', throwsCode(() => P.loadTable({ ...good, schema: 'x' }), 'config_invalid'));
const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'syncnet-project-home-pricing.json'), 'utf8'));
check('repo pricing file: price v2 = 1200 cents ($12 USD) — the ACTIVE public price; v1 (3900) kept unchanged as reviewed history', P.loadTable(repo).prices.get(2).priceUsdCents === 1200 && P.loadTable(repo).prices.get(1).priceUsdCents === 3900 && P.loadTable(repo).prices.size === 2);
// V3 canary: exactly ONE reviewed SYNCNET REFERENCE RATE (v1), short-lived (≤ 6 h), never an oracle claim.
const repoRate = P.loadTable(repo).rates.get(1);
check('repo pricing file: v1 = 0.0000457 USD/SYNC kept unchanged (versions are immutable)', P.loadTable(repo).rates.size === 4 && repo.rates[0].syncUsd === '0.0000457' && repoRate.rateUsdE18 === (457n * 10n ** 11n).toString());
check('repo rate v1 window: 2026-09-26T20:15Z → 2026-09-27T02:15Z (6 h, the 30-min quote lock is separate)', repoRate.rateEffectiveAt === '2026-09-26T20:15:00.000Z' && repoRate.rateExpiresAt === '2026-09-27T02:15:00.000Z' && Date.parse(repoRate.rateExpiresAt) - Date.parse(repoRate.rateEffectiveAt) === 6 * 3600e3);
check('every repo rate source is labelled SYNCNET REFERENCE RATE and never claims to be an oracle', repo.rates.every((r) => /SYNCNET REFERENCE RATE/.test(r.source) && !/oracle/i.test(r.source.replace(/not an oracle/gi, ''))));
const repoRate2 = P.loadTable(repo).rates.get(2);
check('repo rate v2 = 0.0000409 USD/SYNC (fresh canary SYNCNET REFERENCE RATE)', repo.rates[1].rateVersion === 2 && repo.rates[1].syncUsd === '0.0000409' && repoRate2.rateUsdE18 === (409n * 10n ** 11n).toString());
check('repo rate v2 window: 2026-09-27T05:05Z → 11:05Z (6 h), starts after v1 expired', repoRate2.rateEffectiveAt === '2026-09-27T05:05:00.000Z' && repoRate2.rateExpiresAt === '2026-09-27T11:05:00.000Z' && Date.parse(repoRate2.rateExpiresAt) - Date.parse(repoRate2.rateEffectiveAt) === 6 * 3600e3 && Date.parse(repoRate2.rateEffectiveAt) >= Date.parse(repoRate.rateExpiresAt));
check('$12 at rate v2 = 293,398.533007334963325184 SYNC (rounded UP)', BigInt(P.baseSyncWei(1200, repoRate2.rateUsdE18)) === 293398533007334963325184n);
check('$39 at rate v2 = 953,545.232273838630806846 SYNC (rounded UP)', BigInt(P.baseSyncWei(3900, repoRate2.rateUsdE18)) === 953545232273838630806846n);
check('$39 at rate v1 = 853,391.684901531728665208 SYNC (rounded UP, never undercharges)', BigInt(P.baseSyncWei(3900, repoRate.rateUsdE18)) === 853391684901531728665208n);
check('repo pricing file has no fixed-SYNC price anywhere', !/1,?000,?000|syncAmount|priceSync/i.test(JSON.stringify(repo.prices)));

// ---------------------------------------------------------------- rollout gate (fail closed)
const SINK = '0x' + '5e'.repeat(20);
const durable = { durable: true };
const ENV = { SYNCNET_PROJECT_HOME_ENABLED: 'true', SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: 'true', PROJECT_HOME_PRICE_VERSION: '1', PROJECT_HOME_PRICE_USD_CENTS: '3900', PROJECT_HOME_SINK_ADDRESS: SINK };
const T = Date.parse('2026-06-01T00:00:00Z');
// P1-2: a fully configured gate also needs the sink to be a REVIEWED deployment (on-chain validation happens per quote).
const REVIEWED_DEPLOYMENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'syncnet-project-home-deployment.json'), 'utf8'));
const reviewed = { ...REVIEWED_DEPLOYMENT, deployments: [{ sink: SINK, converter: '0x' + 'c0'.repeat(20) }] };
const gate = (env, extra = {}) => projectHomeConfig({ env, store: durable, file: good, deploymentFile: reviewed, now: () => T, ...extra });
check('fully configured → site and payments open', gate(ENV).siteEnabled && gate(ENV).paymentsEnabled);
check('sink not in the reviewed deployments → payments closed (site unaffected)', gate(ENV, { deploymentFile: REVIEWED_DEPLOYMENT }).siteEnabled && !gate(ENV, { deploymentFile: REVIEWED_DEPLOYMENT }).paymentsEnabled && gate(ENV, { deploymentFile: REVIEWED_DEPLOYMENT }).sink === null);
check('empty environment → everything closed', !projectHomeConfig({ env: {}, store: durable }).siteEnabled && !projectHomeConfig({ env: {}, store: durable }).paymentsEnabled);
// AUTOMATIC SYNCNET REFERENCE RATE: the gate no longer depends on a manual rate version or its time window.
const CANARY_ENV = { ...ENV, PROJECT_HOME_SINK_ADDRESS: '0xc32fb194a0a2bc5fa313febd2de5096ca467213d' };
const ACTIVE_ENV = { ...CANARY_ENV, PROJECT_HOME_PRICE_VERSION: '2', PROJECT_HOME_PRICE_USD_CENTS: '1200' };
const live = (iso, env = ACTIVE_ENV) => projectHomeConfig({ env, store: durable, now: () => Date.parse(iso) });
check('ACTIVE config ($12 = price v2, reviewed sink, NO rate version) → payments open, rate mode automatic', live('2026-10-01T00:00:00Z').paymentsEnabled && live('2026-10-01T00:00:00Z').price.priceUsdCents === 1200 && live('2026-10-01T00:00:00Z').rateMode === 'automatic' && !('rate' in live('2026-10-01T00:00:00Z')));
check('no time window: payments stay open at any date (the rate is read per quote, not configured)', ['2026-09-27T20:51:00Z', '2027-06-01T00:00:00Z', '2030-01-01T00:00:00Z'].every((t) => live(t).paymentsEnabled));
check('PROJECT_HOME_RATE_VERSION is obsolete: unknown, expired or junk values change nothing', ['99', '1', '1; DROP'].every((v) => live('2026-10-01T00:00:00Z', { ...ACTIVE_ENV, PROJECT_HOME_RATE_VERSION: v }).paymentsEnabled));
check('the historical manual rates (v1–v4) may be removed without closing payments', projectHomeConfig({ env: ACTIVE_ENV, store: durable, file: { ...repo, rates: [] }, now: () => T }).paymentsEnabled);
check('price v2 selected with the OLD cents (3900) → payments closed (env can never re-introduce $39)', !live('2026-10-01T00:00:00Z', { ...ACTIVE_ENV, PROJECT_HOME_PRICE_USD_CENTS: '3900' }).paymentsEnabled);
check('ACTIVE config without SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED → payments closed', !live('2026-10-01T00:00:00Z', { ...ACTIVE_ENV, SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: undefined }).paymentsEnabled);
check('no durable store → closed', !projectHomeConfig({ env: ENV, store: { durable: false }, file: good, now: () => T }).siteEnabled);
for (const k of Object.keys(ENV)) { const e = { ...ENV }; delete e[k]; check('missing ' + k + ' → payments closed', !gate(e).paymentsEnabled); }
check('SYNCNET_PROJECT_HOME_ENABLED=TRUE-ish values other than "true" stay closed', !gate({ ...ENV, SYNCNET_PROJECT_HOME_ENABLED: '1' }).siteEnabled && !gate({ ...ENV, SYNCNET_PROJECT_HOME_ENABLED: 'yes' }).siteEnabled);
check('price cents env must equal the reviewed price', !gate({ ...ENV, PROJECT_HOME_PRICE_USD_CENTS: '100' }).paymentsEnabled);
check('unknown price version → closed', !gate({ ...ENV, PROJECT_HOME_PRICE_VERSION: '2' }).paymentsEnabled);
check('sink = zero address → closed', !gate({ ...ENV, PROJECT_HOME_SINK_ADDRESS: '0x' + '0'.repeat(40) }).paymentsEnabled);
check('sink = the SYNC token → closed', !gate({ ...ENV, PROJECT_HOME_SINK_ADDRESS: '0x6368e007b9f0b941560ed1f3bceb20247f5eca37' }).paymentsEnabled);
check('malformed sink → closed', !gate({ ...ENV, PROJECT_HOME_SINK_ADDRESS: 'sink' }).paymentsEnabled);
check('invalid pricing file → closed', !projectHomeConfig({ env: ENV, store: durable, file: { schema: 'nope' }, now: () => T }).paymentsEnabled);

// ---------------------------------------------------------------- automatic SYNCNET REFERENCE RATE (canonical PAR market)
{
  const Rate = require(path.join(ROOT, 'netlify/lib/project-home-rate.js'));
  const { createStore } = require(path.join(ROOT, 'netlify/lib/store.js'));
  const H = await import('../e2e/harness.mjs');
  const HEAD = 74000000n;
  let calls = 0, chainHex = '0x1237', mangle = null;
  const rpc = async (method, params = []) => {
    calls++;
    if (method === 'eth_chainId') return chainHex;
    if (method === 'eth_getBlockByNumber') return { number: '0x' + HEAD.toString(16), hash: '0x' + '1'.repeat(64), timestamp: '0x' + (1790500000).toString(16) };
    if (method === 'eth_call') { if (mangle) return mangle; const r = H.ratePoolCall(params[0].to, params[0].data, params[1], HEAD); if (r === undefined) throw new Error('unexpected call'); return r; }
    throw new Error('unexpected ' + method);
  };
  const store = createStore({ env: {} });
  const T0 = Date.parse('2026-10-01T12:00:00Z');
  const derive = (at = T0) => { calls = 0; return Rate.deriveReferenceRate({ rpc, store, now: () => at }); };
  const code = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code || e.message; } };
  const reset = () => { H.resetRatePool(); chainHex = '0x1237'; mangle = null; };
  reset();
  const r = await derive();
  check('auto rate: canonical market at $0.00005 → SYNCNET REFERENCE RATE 0.00005, rateVersion AUTO', r.syncUsdReferenceRate === '0.00005' && r.rateUsdE18 === (5n * 10n ** 13n).toString() && r.rateVersion === 'AUTO' && r.source.label === 'SYNCNET REFERENCE RATE');
  check('auto rate: audit source = chain 4663, market 1, SYNC/USDG direct, pinned pool id, block + time, lagged block, both mids', r.source.chainId === 4663 && r.source.market === 1 && r.source.route === 'SYNC/USDG direct' && r.source.poolId === Rate.CONSTANTS.POOL_ID && r.source.block === HEAD.toString() && r.source.blockTimestamp === new Date(1790500000 * 1000).toISOString() && r.source.laggedBlock === (HEAD - 1200n).toString() && Boolean(r.source.midUsdE18Latest && r.source.midUsdE18Lagged));
  check('auto rate: bounded — at most 9 RPC reads (7 used)', calls <= 9, calls);
  check('auto rate: $12 at 0.00005 = 240,000 SYNC base', P.baseSyncWei(1200, r.rateUsdE18) === 240000n * E18);
  reset(); H.ratePool.usd = '0.0000366948'; MAPDEL();
  check('auto rate: rounded DOWN to 3 significant figures (0.0000366948 → 0.0000366, never above the mid)', (await derive()).syncUsdReferenceRate === '0.0000366');
  reset(); H.ratePool.usd = '0.00005'; H.ratePool.lagged = '0.000048'; MAPDEL();
  check('auto rate: two reads ≈2 minutes apart → the LOWER mid is used (more SYNC charged, never less)', (await derive()).syncUsdReferenceRate === '0.000048');
  const bad = async (label, setup, want) => { reset(); MAPDEL(); setup(); check('auto rate fails closed: ' + label + ' → ' + want, (await code(derive())) === want); reset(); };
  await bad('lagged mid differs by >10 %', () => { H.ratePool.lagged = '0.000044'; }, 'volatile');
  await bad('wrong chain id', () => { chainHex = '0x1'; }, 'wrong_chain');
  await bad('factory pool id is not the canonical pool', () => { H.ratePool.badPoolId = true; }, 'not_canonical_market');
  await bad('market 1 pool key is not the reviewed route (hooks)', () => { H.ratePool.badKey = true; }, 'not_canonical_market');
  await bad('slot0 tick inconsistent with its price', () => { H.ratePool.badTick = true; }, 'inconsistent_slot0');
  await bad('in-range liquidity below the floor', () => { H.ratePool.liquidity = 10n ** 16n; }, 'thin_liquidity');
  await bad('rate outside the hard pricing bounds', () => { H.ratePool.usd = '5000000'; }, 'out_of_bounds');
  await bad('malformed read (short result)', () => { mangle = '0x1234'; }, 'malformed_read');
  await bad('RPC failure', () => { H.ratePool.down = true; }, 'rpc_failed');
  // one-step jump guard vs the last ACCEPTED reference
  reset(); MAPDEL(); await derive(T0); // accepted reference 0.00005 at T0
  H.ratePool.usd = '0.00007'; // +40 %
  check('jump guard: >+25 % above an accepted reference younger than 1 h → refused', (await code(derive(T0 + 10 * 60e3))) === 'jump');
  check('jump guard: the refused rate is NOT recorded as the reference', JSON.parse(await store.get(Rate.CONSTANTS.REF_KEY)).rateUsdE18 === (5n * 10n ** 13n).toString());
  check('jump guard: the same rise is accepted once the reference is older than 1 h (real repricing)', (await derive(T0 + 61 * 60e3)).syncUsdReferenceRate === '0.00007');
  H.ratePool.usd = '0.00004'; // −43 % vs the new reference
  check('jump guard: a FALL is always accepted (more SYNC is charged, never less)', (await derive(T0 + 62 * 60e3)).syncUsdReferenceRate === '0.00004');
  H.ratePool.usd = '0.000048'; // +20 %
  check('jump guard: normal movement within +25 % is accepted', (await derive(T0 + 63 * 60e3)).syncUsdReferenceRate === '0.000048');
  const src = fs.readFileSync(path.join(ROOT, 'netlify/lib/project-home-rate.js'), 'utf8');
  check('no fallback: the automatic rate never reads the manual rate table, an env rate or a third-party API', !/pricing\.json|\.rates\b|PROJECT_HOME_RATE_VERSION|coingecko|dexscreener|https?:\/\//i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
  check('never labelled an oracle price', !/oracle price/i.test(src) && /SYNCNET REFERENCE RATE/.test(src));
  reset();
  function MAPDEL() { store.del(Rate.CONSTANTS.REF_KEY); }
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/project-home/pricing.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} project-home pricing checks passed`);
process.exit(failures ? 1 : 0);
