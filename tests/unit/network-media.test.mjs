// SyncNet Network · token media. Token/project avatars on the Network page resolve through ONE address-keyed path
// (logoFor): Registry profile.image first, then the PAR launch logo, never by ticker, rendered by SyncNetIpfs.
// Also covers /api/par-launches-all keeping PAR's ipfs:// `logo` beside `logoUrl`.
// Loads the real v2-network.js in a vm with a stub DOM and a counting fetch. No network.
// Run: node tests/unit/network-media.test.mjs
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Ipfs = require(path.join(ROOT, 'lib/syncnet-ipfs.js'));
const launchesFn = require(path.join(ROOT, 'netlify/functions/par-launches-all.js'));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else { failed++; console.error('FAIL', name, detail); } };

const SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37';
const hex = (n) => '0x' + n.toString(16).padStart(40, '0');
const CID1 = 'bafkreig6x2dvsrlfn2tvfsky2eretn772uqhsjj5gllihbq6pgynx3ljry';
const CID2 = 'bafkreig5hyt4po3peiq3cpezer2yuki57l3wnq4qztjphf4lp7tsq6m6si';
const CID_SYNC_PAR = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const A = hex(0xa1), B = hex(0xb2), D = hex(0xd4), E = hex(0xe5), F = hex(0xf6), H = hex(0x77);
const mk = (token, symbol, extra = {}) => ({ token, name: symbol + ' token', symbol, markets: [{ pairToken: SYNC, quoteSymbol: 'SYNC' }], ...extra });
const LAUNCHES = [
  mk(A.toUpperCase().replace('0X', '0x'), 'DUP', { logo: 'ipfs://' + CID1, logoUrl: 'https://ipfs.io/ipfs/' + CID1 }), // mixed-case address, ipfs:// preserved
  mk(B, 'DUP'),                                                                                                          // same symbol, other contract, no logo
  mk(D, 'BAD', { logo: 'javascript:alert(1)', logoUrl: 'http://insecure.example/x.png' }),                              // unsafe schemes
  mk(E, 'HTTPS', { logoUrl: 'https://cdn.example/e.png' }),                                                              // https only (no ipfs form)
  mk(F, 'TRAV', { logo: '/assets/../secret.png' }),                                                                      // path traversal
  mk(SYNC, 'SYNC', { logo: 'ipfs://' + CID_SYNC_PAR }),                                                                  // PAR logo that the profile must beat
];
const PROFILES = { projects: [{ token: SYNC, symbol: 'SYNC', name: 'SyncNet', profile: { name: 'SYNC', image: '/assets/syncnet-logo-thumb.webp' }, registry: { status: 'network', label: 'SYNCNET NETWORK ASSET', canonical: true } }] };

async function boot({ launches = LAUNCHES, profiles = PROFILES, failHistory = false } = {}) {
  const calls = [];
  const els = new Map();
  const el = (id) => { if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', dataset: {}, hidden: false, addEventListener() {}, setAttribute() {}, querySelectorAll: () => [], closest: () => null }); return els.get(id); };
  const doc = { getElementById: (id) => (['networkGrid', 'registryPreview'].includes(id) ? el(id) : null), addEventListener() {}, querySelector: () => null, body: {} };
  const ok = (json) => ({ ok: true, json: async () => json });
  const fetchStub = async (url, init) => {
    const u = String(url); calls.push(u);
    if (u.includes('/api/par-launches-all')) return failHistory ? { ok: false, status: 503, json: async () => ({}) } : ok({ count: launches.length, indexed: launches.length, launches });
    if (u.includes('syncnet-projects.json')) return ok(profiles);
    if (u.includes('rpc.mainnet.chain.robinhood.com')) return ok({ result: '0x' });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const sandbox = { fetch: fetchStub, setTimeout, clearTimeout, AbortController, TextDecoder, URLSearchParams, URL, Uint8Array, Promise, console, location: { search: '', hash: '' }, document: doc };
  sandbox.window = sandbox;
  sandbox.SyncNetIpfs = Ipfs;
  vm.createContext(sandbox);
  // Test-only hook appended to the IIFE tail (production source is untouched).
  const src = fs.readFileSync(path.join(ROOT, 'v2-network.js'), 'utf8').replace(/\}\)\(\);\s*$/, 'window.__t={logoFor,metaFor,node,branchCard,avatar,card,detailedRecent,ensureLogoIndex};})();');
  vm.runInContext(src, sandbox, { filename: 'v2-network.js' });
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); // let loadRecentSync / loadRegistryPreview settle
  return { t: sandbox.__t, els, calls, grid: () => els.get('networkGrid')?.innerHTML || '', registry: () => els.get('registryPreview')?.innerHTML || '' };
}
const imgSrcs = (html) => [...String(html).matchAll(/<img src="([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
const isPlaceholder = (src) => src.startsWith('data:image/svg+xml,');

const { t, calls, grid, registry } = await boot();

// ---- exact-address matching ----
check('exact address resolves (mixed-case launch row, lowercase lookup)', t.logoFor(A) === 'ipfs://' + CID1, t.logoFor(A));
check('lookup is case-insensitive on the queried address', t.logoFor(A.toUpperCase().replace('0X', '0x')) === 'ipfs://' + CID1);
check('PAR ipfs:// value is preserved (not the https gateway form) so the fallback chain can run', t.logoFor(A).startsWith('ipfs://'));
check('same symbol / different contract does NOT inherit the logo', t.logoFor(B) === '', t.logoFor(B));
check('unknown or malformed address -> empty', t.logoFor(hex(0x99)) === '' && t.logoFor('DUP') === '' && t.logoFor('') === '' && t.logoFor(null) === '');
check('https-only PAR logo is accepted', t.logoFor(E) === 'https://cdn.example/e.png');

// ---- priority ----
check('profile.image beats the PAR launch logo for the same contract', t.logoFor(SYNC) === '/assets/syncnet-logo-thumb.webp', t.logoFor(SYNC));

// ---- invalid / hostile values ----
check('javascript: / http: logo values are rejected', t.logoFor(D) === '', t.logoFor(D));
check('/assets/ path traversal rejected', t.logoFor(F) === '');
{
  const x = await boot({ launches: [mk(H, 'X', { logo: 'data:image/svg+xml,<svg onload=alert(1)>' }), mk(hex(0x88), 'Y', { logo: 'ipfs://not a cid' }), mk(hex(0x89), 'Z', { logo: 'https://' + 'a'.repeat(600) })], profiles: { projects: [] } });
  check('data:, malformed ipfs:// and over-long values rejected', [H, hex(0x88), hex(0x89)].every((a) => x.t.logoFor(a) === ''));
}

// ---- metaFor carries the logo; renderers use it ----
const mA = await t.metaFor(A, LAUNCHES[0]);
const mB = await t.metaFor(B, LAUNCHES[1]);
check('metaFor carries logo for the exact contract', mA.logo === 'ipfs://' + CID1 && mB.logo === '');
const nodeA = t.node(mA, 'child'), nodeB = t.node(mB, 'child');
check('topology node renders the ipfs logo through SyncNetIpfs (gateway + fallback attrs)', /<img src="https:\/\/gateway\.pinata\.cloud\/ipfs\/[^"]+"[^>]*data-ipfs="/.test(nodeA), nodeA);
check('node without a logo renders the deterministic placeholder, not a blank slot', isPlaceholder(imgSrcs(nodeB)[0] || ''), nodeB);
check('same-ticker node does not show the other contract\'s image', !nodeB.includes(CID1));
check('placeholder is deterministic per contract', imgSrcs(t.node(await t.metaFor(B, LAUNCHES[1])))[0] === imgSrcs(nodeB)[0]);
const chip = t.branchCard({ ...mA, via: mB });
check('branch/neighbour card renders an avatar', /class="tok-av"/.test(chip) && /gateway\.pinata\.cloud/.test(chip));
check('avatar HTML adds no extra label text', t.avatar(mB).replace(/<[^>]+>/g, '') === '');
const mSync = await t.metaFor(SYNC, LAUNCHES[5]);
check('root/profile avatar uses profile.image', /src="\/assets\/syncnet-logo-thumb\.webp"/.test(t.avatar(mSync, true)));

// ---- Recent Connections ----
const g = grid();
const cards = g.split('<article').slice(1);
check('Recent Connections rendered a card per $SYNC-connected launch', cards.length === LAUNCHES.length, String(cards.length));
const cardOf = (addr) => cards.find((c) => c.toLowerCase().includes(`/network.html?token=${addr.toLowerCase()}`)) || '';
check('Recent Connections never shows the literal SYNC text as a fallback', !/network-card-logo[^>]*>SYNC</.test(g));
check('card with PAR ipfs logo uses the gateway chain', /gateway\.pinata\.cloud\/ipfs\/bafkreig6x2/.test(cardOf(A)) && /data-ipfs=/.test(cardOf(A)));
check('card without a logo shows the deterministic placeholder', isPlaceholder(imgSrcs(cardOf(B))[0] || ''));
check('card with unsafe logo schemes falls back to the placeholder', isPlaceholder(imgSrcs(cardOf(D))[0] || '') && !/javascript:|insecure\.example/.test(cardOf(D)));
check('same-symbol cards carry different placeholders / images', imgSrcs(cardOf(A))[0] !== imgSrcs(cardOf(B))[0]);
check('https-only logo renders as-is (CSP already allows https:)', imgSrcs(cardOf(E))[0] === 'https://cdn.example/e.png');
check('card still renders (name, MAP link) when its image is invalid', /MAP<\/a>/.test(cardOf(F)) && isPlaceholder(imgSrcs(cardOf(F))[0] || ''));

// ---- Registry preview ----
check('Registry preview shows the profile image for its exact contract', /src="\/assets\/syncnet-logo-thumb\.webp"/.test(registry()), registry().slice(0, 300));

// ---- no duplicate requests ----
const count = (s) => calls.filter((u) => u.includes(s)).length;
check('history fetched once across Recent Connections, Registry preview and every metaFor', count('/api/par-launches-all') === 1, String(count('/api/par-launches-all')));
check('profiles fetched once', count('syncnet-projects.json') === 1, String(count('syncnet-projects.json')));
const before = calls.length;
await t.metaFor(A, LAUNCHES[0]); await t.metaFor(B, LAUNCHES[1]); t.logoFor(A); t.node(mA); t.card(LAUNCHES[0]);
check('resolving/rendering more tokens triggers no new request', calls.length === before, String(calls.length - before));

// ---- failure tolerance ----
{
  const f = await boot({ failHistory: true });
  check('history failure: logoFor degrades to profile images only; no throw', f.t.logoFor(A) === '' && f.t.logoFor(SYNC) === '/assets/syncnet-logo-thumb.webp');
  const m = await f.t.metaFor(A, LAUNCHES[0]);
  check('history failure: node still renders with a placeholder', isPlaceholder(imgSrcs(f.t.node(m))[0] || ''));
  const before2 = f.calls.filter((u) => u.includes('/api/par-launches-all')).length;
  await f.t.metaFor(B, LAUNCHES[1]); await f.t.metaFor(D, LAUNCHES[2]);
  check('history failure is not retried per card', f.calls.filter((u) => u.includes('/api/par-launches-all')).length === before2);
}

// ---- /api/par-launches-all keeps the ipfs:// logo ----
{
  const compact = launchesFn._internals.compactLaunch;
  const row = { token: A, name: 'N', symbol: 'S', logo: 'ipfs://' + CID1, logoUrl: 'https://ipfs.io/ipfs/' + CID1, markets: [] };
  const o = compact(row);
  check('compactLaunch keeps logo (ipfs://) alongside logoUrl', o.logo === 'ipfs://' + CID1 && o.logoUrl === 'https://ipfs.io/ipfs/' + CID1, JSON.stringify(o));
  const same = compact({ token: A, logo: 'ipfs://' + CID2, markets: [] });
  check('logo-only row: logoUrl unchanged, no duplicated logo field', same.logoUrl === 'ipfs://' + CID2 && !('logo' in same));
  check('over-long logo dropped, never truncated', !('logo' in compact({ token: A, logo: 'ipfs://' + 'a'.repeat(600), logoUrl: 'https://x.example/a.png', markets: [] })));
  check('no logo fields -> neither emitted', !('logo' in compact({ token: A, markets: [] })) && !('logoUrl' in compact({ token: A, markets: [] })));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
