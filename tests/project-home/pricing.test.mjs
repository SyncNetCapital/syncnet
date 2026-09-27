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
check('repo pricing file: v1 = 0.0000457 USD/SYNC kept unchanged (versions are immutable)', P.loadTable(repo).rates.size === 2 && repo.rates[0].syncUsd === '0.0000457' && repoRate.rateUsdE18 === (457n * 10n ** 11n).toString());
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
const ENV = { SYNCNET_PROJECT_HOME_ENABLED: 'true', SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: 'true', PROJECT_HOME_PRICE_VERSION: '1', PROJECT_HOME_PRICE_USD_CENTS: '3900', PROJECT_HOME_RATE_VERSION: '1', PROJECT_HOME_SINK_ADDRESS: SINK };
const T = Date.parse('2026-06-01T00:00:00Z');
// P1-2: a fully configured gate also needs the sink to be a REVIEWED deployment (on-chain validation happens per quote).
const REVIEWED_DEPLOYMENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'syncnet-project-home-deployment.json'), 'utf8'));
const reviewed = { ...REVIEWED_DEPLOYMENT, deployments: [{ sink: SINK, converter: '0x' + 'c0'.repeat(20) }] };
const gate = (env, extra = {}) => projectHomeConfig({ env, store: durable, file: good, deploymentFile: reviewed, now: () => T, ...extra });
check('fully configured → site and payments open', gate(ENV).siteEnabled && gate(ENV).paymentsEnabled);
check('sink not in the reviewed deployments → payments closed (site unaffected)', gate(ENV, { deploymentFile: REVIEWED_DEPLOYMENT }).siteEnabled && !gate(ENV, { deploymentFile: REVIEWED_DEPLOYMENT }).paymentsEnabled && gate(ENV, { deploymentFile: REVIEWED_DEPLOYMENT }).sink === null);
check('empty environment → everything closed', !projectHomeConfig({ env: {}, store: durable }).siteEnabled && !projectHomeConfig({ env: {}, store: durable }).paymentsEnabled);
check('repo defaults (real pricing file, env set) before rate v1 is effective → payments closed', !projectHomeConfig({ env: ENV, store: durable, now: () => T }).paymentsEnabled);
// The real canary configuration: repo pricing file + repo reviewed deployment + the canary sink.
const CANARY_ENV = { ...ENV, PROJECT_HOME_SINK_ADDRESS: '0xc32fb194a0a2bc5fa313febd2de5096ca467213d' };
const ACTIVE_ENV = { ...CANARY_ENV, PROJECT_HOME_PRICE_VERSION: '2', PROJECT_HOME_PRICE_USD_CENTS: '1200', PROJECT_HOME_RATE_VERSION: '2' };
const canary = (iso, env = CANARY_ENV) => projectHomeConfig({ env, store: durable, now: () => Date.parse(iso) });
check('canary config inside the rate v1 window → payments open, sink = reviewed canary sink, rate v1', canary('2026-09-26T21:00:00Z').paymentsEnabled && canary('2026-09-26T21:00:00Z').sink === '0xc32fb194a0a2bc5fa313febd2de5096ca467213d' && String(canary('2026-09-26T21:00:00Z').rate.rateVersion) === '1');
check('canary config 1 s before rate v1 effectiveAt → payments closed', !canary('2026-09-26T20:14:59Z').paymentsEnabled);
check('canary config at rate v1 expiresAt → payments closed (expired rate never charges)', !canary('2026-09-27T02:15:00Z').paymentsEnabled);
check('canary config without SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED → payments closed', !canary('2026-09-26T21:00:00Z', { ...CANARY_ENV, SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED: undefined }).paymentsEnabled);
const CANARY_ENV_V2 = { ...CANARY_ENV, PROJECT_HOME_RATE_VERSION: '2' };
check('ACTIVE config (price v2 = $12, rate v2) inside the rate window → payments open at 1200 cents', canary('2026-09-27T06:00:00Z', ACTIVE_ENV).paymentsEnabled && canary('2026-09-27T06:00:00Z', ACTIVE_ENV).price.priceUsdCents === 1200 && canary('2026-09-27T06:00:00Z', ACTIVE_ENV).price.priceVersion === 2);
check('price v2 selected with the OLD cents (3900) → payments closed (env can never re-introduce $39)', !canary('2026-09-27T06:00:00Z', { ...ACTIVE_ENV, PROJECT_HOME_PRICE_USD_CENTS: '3900' }).paymentsEnabled);
check('ACTIVE config after rate v2 expired → payments closed naturally (no new rate in this pass)', !canary('2026-09-27T11:05:00Z', ACTIVE_ENV).paymentsEnabled && !canary('2026-10-01T00:00:00Z', ACTIVE_ENV).paymentsEnabled);
check('canary config with rate v2 inside its window → payments open, sink = reviewed canary sink, rate v2 = 0.0000409', canary('2026-09-27T06:00:00Z', CANARY_ENV_V2).paymentsEnabled && canary('2026-09-27T06:00:00Z', CANARY_ENV_V2).sink === '0xc32fb194a0a2bc5fa313febd2de5096ca467213d' && String(canary('2026-09-27T06:00:00Z', CANARY_ENV_V2).rate.rateVersion) === '2' && canary('2026-09-27T06:00:00Z', CANARY_ENV_V2).rate.syncUsdReferenceRate === '0.0000409');
check('rate v2 1 s before effectiveAt → payments closed', !canary('2026-09-27T05:04:59Z', CANARY_ENV_V2).paymentsEnabled);
check('rate v2 at expiresAt → payments closed', !canary('2026-09-27T11:05:00Z', CANARY_ENV_V2).paymentsEnabled);
check('rate v2 selected during the old v1 window → payments closed (not yet effective)', !canary('2026-09-26T21:00:00Z', CANARY_ENV_V2).paymentsEnabled);
check('expired rate v1 still selected after v2 exists → payments closed (never falls back or forward silently)', !canary('2026-09-27T06:00:00Z').paymentsEnabled);
check('no durable store → closed', !projectHomeConfig({ env: ENV, store: { durable: false }, file: good, now: () => T }).siteEnabled);
for (const k of Object.keys(ENV)) { const e = { ...ENV }; delete e[k]; check('missing ' + k + ' → payments closed', !gate(e).paymentsEnabled); }
check('SYNCNET_PROJECT_HOME_ENABLED=TRUE-ish values other than "true" stay closed', !gate({ ...ENV, SYNCNET_PROJECT_HOME_ENABLED: '1' }).siteEnabled && !gate({ ...ENV, SYNCNET_PROJECT_HOME_ENABLED: 'yes' }).siteEnabled);
check('price cents env must equal the reviewed price', !gate({ ...ENV, PROJECT_HOME_PRICE_USD_CENTS: '100' }).paymentsEnabled);
check('unknown price version → closed', !gate({ ...ENV, PROJECT_HOME_PRICE_VERSION: '2' }).paymentsEnabled);
check('unknown rate version → closed', !gate({ ...ENV, PROJECT_HOME_RATE_VERSION: '9' }).paymentsEnabled);
check('rate not yet effective → closed', !gate(ENV, { now: () => Date.parse('2025-12-31T23:59:59Z') }).paymentsEnabled);
check('rate expired → closed', !gate(ENV, { now: () => Date.parse('2027-01-01T00:00:00Z') }).paymentsEnabled);
check('sink = zero address → closed', !gate({ ...ENV, PROJECT_HOME_SINK_ADDRESS: '0x' + '0'.repeat(40) }).paymentsEnabled);
check('sink = the SYNC token → closed', !gate({ ...ENV, PROJECT_HOME_SINK_ADDRESS: '0x6368e007b9f0b941560ed1f3bceb20247f5eca37' }).paymentsEnabled);
check('malformed sink → closed', !gate({ ...ENV, PROJECT_HOME_SINK_ADDRESS: 'sink' }).paymentsEnabled);
check('invalid pricing file → closed', !projectHomeConfig({ env: ENV, store: durable, file: { schema: 'nope' }, now: () => T }).paymentsEnabled);
check('rate env with junk → closed', !gate({ ...ENV, PROJECT_HOME_RATE_VERSION: '1; DROP' }).paymentsEnabled);

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/project-home/pricing.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} project-home pricing checks passed`);
process.exit(failures ? 1 : 0);
