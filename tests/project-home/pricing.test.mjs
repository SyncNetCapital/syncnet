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
check('repo pricing file: price v1 = 3900 cents ($39 USD) — the initial launch price', P.loadTable(repo).prices.get(1).priceUsdCents === 3900 && P.loadTable(repo).prices.size === 1);
check('repo pricing file ships NO approved rate (payments closed until one is reviewed in)', P.loadTable(repo).rates.size === 0);
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
check('repo defaults (real pricing file, env set) → payments closed: no approved rate', !projectHomeConfig({ env: ENV, store: durable, now: () => T }).paymentsEnabled);
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
