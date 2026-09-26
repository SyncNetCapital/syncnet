// Static/adversarial audit of the Project Home contracts (contracts/project-home-sink):
//   SyncNetProjectHomeSink               — dumb 60/40 settlement: burn + forward SYNC to an immutable converter
//   SyncNetProjectHomeTreasuryConverter  — SYNC -> USDG through ONE fixed PAR route, USDG only to the immutable treasury
// Proves from the source (comments stripped) and the ABIs that neither contract has an owner/admin, setters, rescue,
// withdrawal, upgrade path, arbitrary call, arbitrary recipient or generic swap, and that the sink has no DEX/price
// logic at all. If forge + solc 0.8.28 are available, the committed ABIs are re-derived and compared.
// Run: node tests/project-home/sink-static-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'contracts/project-home-sink');
const results = []; let failures = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; console.log('FAIL ' + name + ' :: ' + detail); } };
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // comments never count as code
const src = (f) => strip(fs.readFileSync(path.join(DIR, 'src', f), 'utf8'));
const sink = src('SyncNetProjectHomeSink.sol');
const conv = src('SyncNetProjectHomeTreasuryConverter.sol');
const convBody = () => conv.slice(conv.indexOf('contract SyncNetProjectHomeTreasuryConverter'));
const callsIn = (code) => [...code.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\s*\(/g)].map((m) => m[1] + '.' + m[2]);

// ---------------------------------------------------------------- shared forbidden surface
const FORBIDDEN = [
  ['owner', /\bowner\b/i], ['admin', /\badmin\b/i], ['onlyOwner', /onlyOwner/], ['Ownable', /Ownable/], ['delegatecall', /delegatecall/],
  ['upgradeTo', /upgradeTo/i], ['proxy / implementation slot', /proxy|implementation|eip1967/i], ['low-level call', /\.call\s*[({]/],
  ['staticcall', /staticcall/], ['assembly', /\bassembly\b/], ['selfdestruct', /selfdestruct|suicide/], ['rescue', /rescue/i],
  ['withdraw', /withdraw/i], ['sweep', /sweep/i], ['any setter', /function\s+set[A-Z]/], ['setOwner', /setOwner/], ['setTreasury', /setTreasury/i],
  ['setExecutor', /setExecutor/i], ['setRouter', /setRouter/i], ['setToken', /setToken|setSync/i], ['setUSDG', /setUsdg/i],
  ['transferFrom', /transferFrom/], ['burnFrom', /burnFrom/], ['payable', /payable/], ['receive()', /receive\s*\(/], ['fallback()', /fallback\s*\(/],
  ['sstore/sload', /sstore|sload/], ['initializer', /initiali[sz]e/i], ['msg.value', /msg\.value/], ['tx.origin', /tx\.origin/],
  ['dead address', /0x0*dead/i], ['multicall / execute', /multicall|function\s+execute/i],
];
for (const [label, code] of [['sink', sink], ['converter', conv]]) for (const [name, re] of FORBIDDEN) check(`${label} source has no ${name}`, !re.test(code), (code.match(re) || [''])[0]);

// ---------------------------------------------------------------- sink: dumb, DEX-free, immutable
check('sink: SYNC is immutable', /ISyncToken\s+public\s+immutable\s+SYNC\s*;/.test(sink));
check('sink: TREASURY_CONVERTER is immutable', /address\s+public\s+immutable\s+TREASURY_CONVERTER\s*;/.test(sink));
check('sink: split is a compile-time constant of 60', /uint256\s+public\s+constant\s+BURN_PERCENT\s*=\s*60\s*;/.test(sink));
check('sink: exactly two immutable assignments, both in the constructor', (sink.match(/\b(SYNC|TREASURY_CONVERTER)\s*=/g) || []).length === 2 && /constructor\s*\([^)]*\)\s*\{[^}]*SYNC\s*=[^}]*TREASURY_CONVERTER\s*=/.test(sink));
check('sink: constructor rejects zero token and zero converter', /sync\s*==\s*address\(0\)\s*\|\|\s*treasuryConverter\s*==\s*address\(0\)/.test(sink));
check('sink: settle() takes no parameters', /function\s+settle\s*\(\s*\)\s*external/.test(sink));
check('sink: knows no USDG, router, pool, price, slippage or swap', !/usdg|router|pool|price|slippage|swap|minOut|deadline|oracle|rate/i.test(sink));
check('sink: only external calls are SYNC.balanceOf / SYNC.burn / SYNC.transfer(TREASURY_CONVERTER, …)', callsIn(sink).every((c) => ['SYNC.balanceOf', 'SYNC.burn', 'SYNC.transfer'].includes(c)) && /SYNC\.transfer\(\s*TREASURY_CONVERTER\s*,/.test(sink), callsIn(sink).join(' '));
check('sink: burn through SYNC.burn (real totalSupply reduction), never a dead-address transfer', /SYNC\.burn\(\s*burned\s*\)/.test(sink));
check('sink: remainder = amount - burn (no residue)', /toConverter\s*=\s*amount\s*-\s*toBurn/.test(sink));
check('sink: burn share computed without overflow', /\(amount\s*\/\s*100\)\s*\*\s*BURN_PERCENT\s*\+\s*\(\(amount\s*%\s*100\)\s*\*\s*BURN_PERCENT\)\s*\/\s*100/.test(sink));
check('sink: accounting before interactions (CEI)', sink.indexOf('totalSettledSync +=') < sink.indexOf('SYNC.burn(') && sink.indexOf('totalTreasurySyncForwarded +=') < sink.indexOf('SYNC.transfer('));
check('sink: converter transfer result is checked', /!SYNC\.transfer\(TREASURY_CONVERTER,\s*forwarded\)\)\s*revert/.test(sink));
check('sink: no misleading "totalTreasury" name remains', !/\btotalTreasury\b|\bTREASURY\b(?!_CONVERTER)/.test(sink));

// ---------------------------------------------------------------- converter: narrow, fixed route, treasury-only
for (const v of ['IERC20Minimal public immutable SYNC', 'IERC20Minimal public immutable USDG', 'address public immutable TREASURY', 'IPairPadMultiRouter public immutable ROUTER', 'uint8 public immutable MARKET']) {
  check('converter: ' + v.split(' ').pop() + ' is immutable', conv.includes(v + ';'));
}
check('converter: every immutable is assigned once, in the constructor', ['SYNC', 'USDG', 'TREASURY', 'ROUTER', 'MARKET'].every((n) => (conv.match(new RegExp('\\b' + n + '\\s*=[^=]', 'g')) || []).length === 1) && /constructor\s*\([^)]*\)\s*\{[\s\S]*?MARKET\s*=\s*market;[\s\S]*?\}/.test(conv));
check('converter: only ONE state-changing entry point, convert(amount, minOut, deadline)', (convBody().match(/function\s+\w+\s*\([^)]*\)\s*external(?!\s+view)/g) || []).length === 1 && /function\s+convert\s*\(\s*uint256\s+syncAmount,\s*uint256\s+minUsdgOut,\s*uint256\s+deadline\s*\)\s*external/.test(conv));
check('converter: convert has no recipient / token / route / pool parameter', !/function\s+convert\s*\([^)]*address/.test(conv));
check('converter: caller must be the immutable TREASURY', /if\s*\(\s*msg\.sender\s*!=\s*TREASURY\s*\)\s*revert\s+NotTreasury\(\)/.test(conv));
check('converter: minUsdgOut = 0 is refused', /if\s*\(\s*minUsdgOut\s*==\s*0\s*\)\s*revert\s+ZeroMinOut\(\)/.test(conv));
check('converter: deadline enforced', /if\s*\(\s*block\.timestamp\s*>\s*deadline\s*\)\s*revert\s+DeadlineExpired\(\)/.test(conv));
check('converter: its own floor on the MEASURED output (independent of the router)', /usdgOut\s*=\s*USDG\.balanceOf\(address\(this\)\)\s*-\s*usdgBefore/.test(conv) && /if\s*\(\s*usdgOut\s*<\s*minUsdgOut\s*\)\s*revert\s+SlippageExceeded/.test(conv));
check('converter: router is paid out to the converter itself (address(this)), never a caller-chosen address', /ROUTER\.sellToQuotes\(\s*address\(SYNC\),\s*legs,\s*minOuts,\s*address\(this\)\s*\)/.test(conv));
check('converter: USDG only ever transferred to TREASURY', (conv.match(/USDG\.transfer\(/g) || []).length === 1 && /USDG\.transfer\(\s*TREASURY\s*,/.test(conv));
check('converter: SYNC is never transferred out (only approved to the fixed ROUTER)', !/SYNC\.transfer\(/.test(conv) && (conv.match(/SYNC\.approve\(/g) || []).every(() => true) && [...conv.matchAll(/SYNC\.approve\(\s*([^,]+),/g)].every((m) => m[1].trim() === 'address(ROUTER)'));
check('converter: allowance reset to 0 after every swap', /SYNC\.approve\(address\(ROUTER\),\s*0\)/.test(conv));
check('converter: the leg uses the immutable MARKET and no hops (direct SYNC/USDG pool)', /Leg\(\{\s*market:\s*MARKET,\s*hops:\s*new\s+Hop\[\]\(0\),\s*amountIn:\s*syncAmount\s*\}\)/.test(conv));
check('converter: route re-verified from the live factory on every conversion and at deployment', (conv.match(/_checkRoute\(\)/g) || []).length === 3 && /poolKeysFor\(address\(SYNC\)\)/.test(conv) && /k\.hooks\s*!=\s*address\(0\)/.test(conv));
check('converter: only external calls are the fixed token/router/factory reads and the one swap', callsIn(conv).every((c) => ['SYNC.balanceOf', 'SYNC.approve', 'USDG.balanceOf', 'USDG.transfer', 'ROUTER.factory', 'ROUTER.sellToQuotes'].includes(c)) && (conv.match(/\)\.poolKeysFor\(/g) || []).length === 1, callsIn(conv).join(' '));
check('converter: re-entry guard on convert', /if\s*\(\s*_entered\s*!=\s*0\s*\)\s*revert\s+Reentrancy\(\)/.test(conv));
check('converter: constructor rejects zero and aliased roles', /revert\s+ZeroAddress\(\)/.test(conv) && /treasury\s*==\s*sync\s*\|\|\s*treasury\s*==\s*usdg\s*\|\|\s*treasury\s*==\s*router/.test(conv));
check('converter: no price / oracle / reference-rate logic', !/oracle|referenceRate|priceUsd|sqrtPrice|getReserves|slot0/i.test(conv));

// ---------------------------------------------------------------- ABIs (exact public surfaces)
const sig = (x) => `${x.type} ${x.name || ''}(${(x.inputs || []).map((i) => i.type).join(',')})${x.stateMutability ? ' ' + x.stateMutability : ''}`;
const EXPECTED = {
  SyncNetProjectHomeSink: [
    'constructor (address,address) nonpayable', 'error ConverterIsToken()', 'error ConverterTransferFailed()', 'error ZeroAddress()',
    'event Settled(address,uint256,uint256,uint256)', 'function BURN_PERCENT() view', 'function SYNC() view', 'function TREASURY_CONVERTER() view',
    'function pending() view', 'function settle() nonpayable', 'function split(uint256) pure', 'function totalBurnedSync() view',
    'function totalSettledSync() view', 'function totalTreasurySyncForwarded() view',
  ],
  SyncNetProjectHomeTreasuryConverter: [
    'constructor (address,address,address,address,uint8) nonpayable', 'error ApproveFailed()', 'error DeadlineExpired()', 'error InsufficientSync()',
    'error InvalidConfiguration()', 'error NotTreasury()', 'error Reentrancy()', 'error RouteMismatch()', 'error SlippageExceeded(uint256,uint256)',
    'error UsdgTransferFailed()', 'error ZeroAddress()', 'error ZeroAmount()', 'error ZeroMinOut()', 'event Converted(address,uint256,uint256,uint256,uint256)',
    'function MARKET() view', 'function ROUTER() view', 'function SYNC() view', 'function TREASURY() view', 'function USDG() view',
    'function convert(uint256,uint256,uint256) nonpayable', 'function pendingSync() view', 'function totalSyncConverted() view',
    'function totalUsdgDelivered() view', 'function totalUsdgFromConversions() view',
  ],
};
const abis = {};
for (const name of Object.keys(EXPECTED)) {
  const abi = JSON.parse(fs.readFileSync(path.join(DIR, 'abi', name + '.abi.json'), 'utf8'));
  abis[name] = abi;
  const got = abi.map(sig).sort();
  check(`${name}: committed ABI is exactly the expected public surface`, JSON.stringify(got) === JSON.stringify([...EXPECTED[name]].sort()), got.join(' | '));
  check(`${name}: no payable entry, no receive, no fallback`, abi.every((x) => x.stateMutability !== 'payable' && x.type !== 'receive' && x.type !== 'fallback'));
}
check('sink: the only state-changing function is settle()', abis.SyncNetProjectHomeSink.filter((x) => x.type === 'function' && x.stateMutability === 'nonpayable').map((x) => x.name).join() === 'settle');
check('converter: the only state-changing function is convert()', abis.SyncNetProjectHomeTreasuryConverter.filter((x) => x.type === 'function' && x.stateMutability === 'nonpayable').map((x) => x.name).join() === 'convert');
check('converter ABI: no function takes an address argument (no recipient, token, router or executor can be passed)', abis.SyncNetProjectHomeTreasuryConverter.filter((x) => x.type === 'function').every((x) => (x.inputs || []).every((i) => i.type !== 'address')));

// ---------------------------------------------------------------- deployment gate pins the reviewed canonical route
const checks = strip(fs.readFileSync(path.join(DIR, 'script/DeployChecks.sol'), 'utf8'));
check('deploy gate pins SYNC, USDG, the PAR multi router and market 1', checks.includes('CANONICAL_SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37') && checks.includes('CANONICAL_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168') && checks.includes('CANONICAL_PAR_MULTI_ROUTER = 0x458D2a59c2F3dd32775a64eE72004561440d64Df') && checks.includes('SYNC_USDG_MARKET = 1'));
const deploy = strip(fs.readFileSync(path.join(DIR, 'script/DeployProjectHome.s.sol'), 'utf8'));
check('deploy order: converter first, then the sink pointing at it', deploy.indexOf('new SyncNetProjectHomeTreasuryConverter(') < deploy.indexOf('new SyncNetProjectHomeSink(') && /new SyncNetProjectHomeSink\(c\.sync,\s*address\(converter\)\)/.test(deploy));
check('deploy script has no default treasury (env required) and checks before broadcasting', /vm\.envAddress\("TREASURY"\)/.test(deploy) && /vm\.envAddress\("TREASURY_CONFIRM"\)/.test(deploy) && deploy.indexOf('DeployChecks.check(c)') < deploy.indexOf('vm.startBroadcast()'));
check('no deployment broadcast exists', !fs.existsSync(path.join(DIR, 'broadcast')));

const forge = spawnSync('forge', ['--version'], { encoding: 'utf8' });
if (forge.status === 0) {
  const solc = process.env.SOLC_PATH ? ['--use', process.env.SOLC_PATH] : [];
  for (const name of Object.keys(EXPECTED)) {
    const r = spawnSync('forge', ['inspect', ...solc, name, 'abi', '--json'], { cwd: DIR, encoding: 'utf8' });
    let fresh = null; try { fresh = JSON.parse(r.stdout); } catch { fresh = null; }
    if (!fresh && /missing solc|install .*solc/i.test(r.stderr || '')) {
      results.push({ name: `${name}: forge-derived ABI comparison`, ok: true, detail: 'SKIPPED: no solc 0.8.28 available offline (set SOLC_PATH)' });
      console.log('NOTE solc 0.8.28 unavailable offline: committed ABI checked, not re-derived (set SOLC_PATH)');
    } else check(`${name}: forge-derived ABI equals the committed ABI`, fresh && JSON.stringify(fresh.map(sig).sort()) === JSON.stringify(abis[name].map(sig).sort()), (r.stderr || '').slice(0, 200));
  }
} else {
  results.push({ name: 'forge-derived ABI comparison', ok: true, detail: 'SKIPPED: forge not installed (committed ABIs checked above)' });
  console.log('NOTE forge not installed: committed ABIs checked, not re-derived');
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/project-home/sink-static-audit.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} sink static audit checks passed`);
process.exit(failures ? 1 : 0);
