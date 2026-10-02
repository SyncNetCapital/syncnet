// SyncNet Explore · PAR token images. PAR rows carry `logo` (ipfs://) and `logoUrl` (https gateway); Explore used to
// read `logoUrl || logo` through an ipfs/assets-only filter, so the https `logoUrl` won and was rejected (letter tile).
// Loads the real explore.js in a vm with a stub DOM and a counting fetch. No network.
// Run: node tests/unit/explore-media.test.mjs
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Ipfs = require(path.join(ROOT, 'lib/syncnet-ipfs.js'));
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else { failed++; console.error('FAIL', name, detail); } };

const hex = (n) => '0x' + n.toString(16).padStart(40, '0');
const CID1 = 'bafkreig6x2dvsrlfn2tvfsky2eretn772uqhsjj5gllihbq6pgynx3ljry';
const CID2 = 'bafybeib6cx76sjv62wsh7j5aygz6aembyje55srgzu4kt5ijafmp6giw6q';
const T = { both: hex(0xa1), twin: hex(0xa2), urlOnly: hex(0xa3), https: hex(0xa4), none: hex(0xa5), evil: hex(0xa6), spoof: hex(0xa7), reg: hex(0xa8), badCid: hex(0xa9) };
const row = (token, symbol, extra = {}) => ({ token, name: symbol + ' Token', symbol, createdAt: 1790000000, markets: [{ pairToken: hex(0x1) }], ...extra });
const LAUNCHES = [
  row(T.both, 'DUP', { logo: 'ipfs://' + CID1, logoUrl: 'https://ipfs.io/ipfs/' + CID1 }),     // the bug: https logoUrl used to win and be rejected
  row(T.twin, 'DUP'),                                                                          // same ticker, other contract, no media
  row(T.urlOnly, 'OLD', { logoUrl: 'https://ipfs.io/ipfs/' + CID2 }),                           // stale cached payload: only logoUrl
  row(T.https, 'HTTP', { logo: 'https://cdn.example/a.png', logoUrl: 'https://cdn.example/a.png' }),
  row(T.none, 'NONE'),
  row(T.evil, 'EVIL', { logo: 'javascript:alert(1)', logoUrl: 'http://insecure.example/x.png' }),
  row(T.spoof, 'SPOOF', { logo: '/assets/syncnet-logo-thumb.webp', logoUrl: '/assets/syncnet-logo-thumb.webp' }), // PAR must not borrow a same-origin brand asset
  row(T.reg, 'REG', { logo: 'ipfs://' + CID2, logoUrl: 'https://ipfs.io/ipfs/' + CID2 }),     // Registry image must still override
  row(T.badCid, 'BADC', { logo: 'ipfs://not-a-real-cid', logoUrl: 'https://ipfs.io/ipfs/' + CID1 }), // bad ipfs logo -> falls through to https logoUrl
];
const REGISTRY = { projects: [{ token: T.reg, symbol: 'REG', name: 'Reg', profile: { name: 'Reg', image: '/assets/syncat-thumb.webp' }, registry: { canonical: true, status: 'origin' } }] };

const calls = [];
const els = new Map();
const el = (id) => { if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', hidden: false, value: '', addEventListener() {}, focus() {}, setAttribute() {}, querySelector: () => null }); return els.get(id); };
const doc = { getElementById: el, addEventListener() {}, querySelectorAll: () => [], readyState: 'complete' };
const ok = (json) => ({ ok: true, json: async () => json });
const fetchStub = async (url) => {
  const u = String(url); calls.push(u);
  if (u.includes('/api/par-launches-all')) return ok({ launches: LAUNCHES });
  if (u.includes('syncnet-projects.json')) return ok(REGISTRY);
  return { ok: false, status: 404, json: async () => ({}) };
};
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UI = { // the real logoHtml contract (sn-ui.js): imgHtml or the initial letter
  esc, isAddr: (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim()), short: (a) => String(a), LABEL: { synced: 'Synced', unclaimed: 'Unclaimed' }, stateHtml: () => '',
  logoHtml: (uri, letter) => { const img = uri ? Ipfs.imgHtml(uri, { letter, alt: '' }) : ''; return `<span class="sn-logo">${img || esc(String(letter || '·').charAt(0).toUpperCase())}</span>`; },
};
const sandbox = { fetch: fetchStub, setTimeout, clearTimeout, URLSearchParams, Promise, console, location: { search: '', pathname: '/' }, history: { replaceState() {} }, document: doc, SyncNetUI: UI, SyncNetCore: Core, SyncNetIpfs: Ipfs };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'explore.js'), 'utf8'), sandbox, { filename: 'explore.js' });
for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));

const html = el('exploreList').innerHTML;
const rowOf = (t) => html.split('<li>').find((x) => x.includes(`/project/${t}"`)) || '';
const logoOf = (t) => (rowOf(t).match(/<span class="sn-logo">(.*?)<\/span>/s) || [])[1] || '';
const srcOf = (t) => (logoOf(t).match(/<img src="([^"]*)"/) || [])[1] || '';
const isLetter = (t) => !logoOf(t).includes('<img');

check('rows rendered', html.split('<li>').length - 1 === LAUNCHES.length, String(html.split('<li>').length - 1));
check('PAR ipfs:// logo wins over the https logoUrl (the bug) and keeps the gateway chain', srcOf(T.both) === 'https://gateway.pinata.cloud/ipfs/' + CID1 && /data-ipfs="/.test(logoOf(T.both)), logoOf(T.both));
check('same ticker / different contract does NOT inherit the image (letter tile)', isLetter(T.twin) && !logoOf(T.twin).includes(CID1), logoOf(T.twin));
check('logoUrl-only row (stale cached payload) now renders its image', srcOf(T.urlOnly) === 'https://ipfs.io/ipfs/' + CID2, logoOf(T.urlOnly));
check('https-only PAR logo renders as-is', srcOf(T.https) === 'https://cdn.example/a.png');
check('no media -> letter tile', isLetter(T.none));
check('javascript:/http: media -> letter tile, nothing unsafe in the DOM', isLetter(T.evil) && !/javascript:|insecure\.example/.test(rowOf(T.evil)));
check('PAR cannot borrow a same-origin /assets/ brand image', isLetter(T.spoof), logoOf(T.spoof));
check('Registry profile.image still overrides PAR media', srcOf(T.reg) === '/assets/syncat-thumb.webp', logoOf(T.reg));
check('malformed ipfs:// logo falls through to a valid https logoUrl', srcOf(T.badCid) === 'https://ipfs.io/ipfs/' + CID1, logoOf(T.badCid));
check('no per-row requests: only the 3 page-level loads + batch enrichment', !calls.some((u) => /rpc\.|readTokenMetadata|eth_call|ipfs|\/launches\/0x/.test(u)) && calls.filter((u) => u.includes('/api/par-launches-all')).length === 1, calls.join(' | '));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
