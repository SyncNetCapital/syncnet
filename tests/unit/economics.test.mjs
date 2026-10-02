// SyncNet Economics — unit tests for lib/syncnet-economics.js: supply/burn math, distribution parsing, 24h coverage
// rule, formatting, and the "unknown is null, never 0" contract. No network. Run: node tests/unit/economics.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const E = require(path.join(ROOT, 'lib/syncnet-economics.js'));

let passed = 0, failed = 0;
const check = (name, ok) => { if (ok) passed++; else { failed++; console.error('FAIL', name); } };

const NOW = 1790835894;
const H = (n) => '0x' + String(n).padStart(64, '0');
const item = (asset, symbol, decimals, total, ageSec, n) => ({ asset, symbol, decimals, total: String(total), timestamp: NOW - ageSec, txHash: H(n), recipients: 3 });
const body = (items, totals) => ({
  token: E.SYNC, lastAt: NOW - 100,
  totals: totals || [
    { asset: E.NET, symbol: 'NET', decimals: 9, total: '2133431137' },
    { asset: E.USDG, symbol: 'USDG', decimals: 6, total: '2713682853' },
    { asset: E.SYNC, symbol: 'SYNC', decimals: 18, total: '57731490081776133967731322' },
  ],
  items,
});

// supply / burn
check('supply parses a 32-byte word', E.parseSupply('0x0000000000000000000000000000000000000000032a82dc7aa10774dc2c2563') === 0x032a82dc7aa10774dc2c2563n);
check('supply rejects garbage / empty / error', E.parseSupply('0x') === null && E.parseSupply(undefined) === null && E.parseSupply('nope') === null && E.parseSupply('0x' + 'f'.repeat(65)) === null);
check('burned = initial - supply', E.burnedFromSupply(E.INITIAL_SUPPLY - 5n) === 5n);
check('burned is a real zero when nothing burned', E.burnedFromSupply(E.INITIAL_SUPPLY) === 0n);
check('supply above initial → unknown, not 0', E.burnedFromSupply(E.INITIAL_SUPPLY + 1n) === null && E.burnedFromSupply(null) === null);

// distributions: totals matched by address
const spans = [item(E.NET, 'NET', 9, 1000000000, 3600, 1), item(E.USDG, 'USDG', 6, 2000000, 7200, 2), item(E.NET, 'NET', 9, 500000000, 90000, 3), item(E.SYNC, 'SYNC', 18, 10n ** 18n, 100, 4), item(E.NET, 'NET', 9, 250000000, 400000, 5)];
const p = E.parseDistributions(body(spans), NOW);
check('NET total', p.net.amount === 2133431137n && p.net.decimals === 9);
check('USDG total', p.usdg.amount === 2713682853n && p.usdg.decimals === 6);
check('24h NET sums only the last 24h', p.net24.amount === 1000000000n);
check('24h USDG', p.usdg24.amount === 2000000n);
check('events are NET/USDG only, newest first', p.events.length === 4 && p.events[0].txHash === H(1) && p.events.every((e) => e.symbol === 'NET' || e.symbol === 'USDG'));
check('symbol spoof is ignored (matched by address)', (() => { const b = body([item('0x' + '1'.repeat(40), 'NET', 9, 5, 100, 9), item(E.NET, 'NET', 9, 7, 200000, 8)]); const q = E.parseDistributions(b, NOW); return q.net24.amount === 0n && q.events.length === 1; })());
check('known 24h zero is a real zero', E.parseDistributions(body([item(E.NET, 'NET', 9, 5, 200000, 1)]), NOW).net24.amount === 0n);
check('24h unavailable when rounds do not reach back 24h', (() => { const q = E.parseDistributions(body([item(E.NET, 'NET', 9, 5, 3600, 1)]), NOW); return q.net24 === null && q.usdg24 === null && q.net.amount === 2133431137n; })());
check('24h unavailable when there are no rounds', E.parseDistributions(body([]), NOW).net24 === null);
check('a malformed round disables 24h (cannot prove coverage)', E.parseDistributions(body([item(E.NET, 'NET', 9, 5, 200000, 1), { asset: E.NET, total: 'x', timestamp: NOW - 10, txHash: 'bad' }]), NOW).net24 === null);
check('missing asset total → null, never 0', (() => { const q = E.parseDistributions(body([], [{ asset: E.NET, symbol: 'NET', decimals: 9, total: '5' }]), NOW); return q.usdg === null && q.net.amount === 5n; })());
check('bad total / decimals → null', (() => { const q = E.parseDistributions(body([], [{ asset: E.NET, decimals: 9, total: '-1' }, { asset: E.USDG, decimals: 'x', total: '5' }]), NOW); return q.net === null && q.usdg === null; })());
check('wrong token / non-object body rejected', E.parseDistributions({ token: '0x' + '2'.repeat(40), totals: [], items: [] }, NOW) === null && E.parseDistributions(null, NOW) === null && E.parseDistributions('x', NOW) === null);

// formatting
check('format whole + grouping', E.formatUnits(20152112n * 10n ** 18n, 18) === '20,152,112');
check('format truncates, never rounds up', E.formatUnits(2713682853n, 6) === '2,713.68' && E.formatUnits(1999999999n, 9) === '1.9999');
check('format small values keep 4 dp, trim zeros', E.formatUnits(2133431137n, 9) === '2.1334' && E.formatUnits(1000000000n, 9) === '1');
check('format zero is "0", unknown is em dash', E.formatUnits(0n, 6) === '0' && E.formatUnits(null, 6) === '—' && E.formatAmount(null) === '—');
check('explorer link only for a real hash', E.txUrl(H(7)) === 'https://robinhoodchain.blockscout.com/tx/' + H(7) && E.txUrl('0x12') === '');

// load(): each source fails independently; unknown stays null
const real = globalThis.fetch;
const run = async (impl) => { globalThis.fetch = impl; try { return await E.load({ force: true }); } finally { globalThis.fetch = real; } };
const supplyHex = '0x' + (E.INITIAL_SUPPLY - 20n * 10n ** 18n).toString(16).padStart(64, '0');
const ok = (j) => Promise.resolve({ ok: true, json: () => Promise.resolve(j) });
const router = (rpc, api) => (url) => (String(url).includes('rpc.mainnet') ? rpc() : api());
const both = await run(router(() => ok({ result: supplyHex }), () => ok(body(spans, undefined))));
// body() with the real clock: rounds are relative to NOW (fixed in the past) so 24h is correctly unavailable here
check('load: burned live, index totals present', both.burned.amount === 20n * 10n ** 18n && both.net.amount === 2133431137n && !both.errors.chain && !both.errors.index);
const rpcDown = await run(router(() => Promise.reject(new Error('down')), () => ok(body(spans))));
check('load: RPC down → burned null + chain error, index intact', rpcDown.burned === null && rpcDown.errors.chain && !rpcDown.errors.index && rpcDown.net.amount === 2133431137n);
const apiDown = await run(router(() => ok({ result: supplyHex }), () => ok({}).then(() => ({ ok: false, status: 503 }))));
check('load: indexer down → net/usdg null + index error, burned intact', apiDown.net === null && apiDown.usdg === null && apiDown.errors.index && apiDown.burned.amount === 20n * 10n ** 18n);
const bothDown = await run(() => Promise.reject(new Error('offline')));
check('load: everything down → all null, never 0', bothDown.burned === null && bothDown.net === null && bothDown.usdg === null && bothDown.events.length === 0);
const badRpc = await run(router(() => ok({ error: { code: -32000 } }), () => ok(body(spans))));
check('load: RPC error reply → burned null', badRpc.burned === null && badRpc.errors.chain);

// pages: strip + page are wired to the shared loader, link correctly, and hard-code no figures
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const home = read('index.html'), stats = read('stats.html'), ui = read('economics-ui.js');
check('home strip links to /stats and NET (external, noopener)', home.includes('href="/stats">View economics →</a>') && home.includes('href="https://netnet.capital/" target="_blank" rel="noopener noreferrer">About NET ↗</a>'));
check('home strip has the three live slots', ['burned', 'net', 'usdg'].every((k) => home.includes(`data-econ="${k}"`)) && home.includes('SYNC burned') && home.includes('NET → holders') && home.includes('USDG → holders'));
check('home strip carries no NET price / NAV / APY', !/NAV|APY|reserve|NET price/i.test(home.slice(home.indexOf('ex-econ"'), home.indexOf('ex-create'))));
check('stats page: heading, copy, three primary slots, NET link', stats.includes('SYNCNET <span class="cyan">ECONOMICS</span>') && stats.includes('Live network economics from Robinhood Chain.') && ['burned', 'net', 'usdg'].every((k) => stats.includes(`data-econ="${k}"`)) && stats.includes('href="https://netnet.capital/" target="_blank" rel="noopener noreferrer">About NET ↗</a>'));
check('stats page: provenance + non-affiliation + last updated', stats.includes('Read from Robinhood Chain.') && stats.includes('id="econUpdated"') && stats.includes('SyncNet is independent and unaffiliated with NetNet Capital. Learn more about NET at <a href="https://netnet.capital/" target="_blank" rel="noopener noreferrer">NetNet Capital ↗</a>.'));
check('no wallet scripts required for data (loader is wallet-free)', !/ethereum|sn-wallet|SyncNetWallet/.test(read('lib/syncnet-economics.js') + ui));
check('no inline scripts (CSP script-src self)', !/<script(?![^>]*\bsrc=)/.test(home + stats));
check('/stats redirect + footer link present', read('_redirects').includes('/stats /stats.html 200') && home.includes('<a href="/stats">Stats</a>') && stats.includes('<a href="/stats">Stats</a>'));
check('every figure in the UI is rendered from data (no digit literals in economics-ui)', !/[1-9]\d{3,}/.test(ui.replace(/129600|86400|5400|3600|1000/g, '')));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
