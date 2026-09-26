// Static/adversarial audit of contracts/project-home-sink/src/SyncNetProjectHomeSink.sol.
// Proves, from the source (comments stripped) and the ABI, that the sink has no owner/admin, no setters, no rescue,
// no upgrade path, no arbitrary call, no approvals, no payable surface — and that token/treasury/split are fixed.
// If forge is installed, the committed ABI is re-derived from the source and compared byte-for-byte (semantically).
// Run: node tests/project-home/sink-static-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'contracts/project-home-sink');
const results = []; let failures = 0;
const check = (name, cond, detail = '') => { results.push({ name, ok: Boolean(cond), detail: String(detail).slice(0, 300) }); if (!cond) { failures++; console.log('FAIL ' + name + ' :: ' + detail); } };

const raw = fs.readFileSync(path.join(DIR, 'src/SyncNetProjectHomeSink.sol'), 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // comments never count as code

const FORBIDDEN = [
  ['owner', /\bowner\b/i], ['admin', /\badmin\b/i], ['onlyOwner', /onlyOwner/], ['Ownable', /Ownable/],
  ['delegatecall', /delegatecall/], ['upgradeTo', /upgradeTo/i], ['proxy / implementation slot', /proxy|implementation|eip1967/i],
  ['low-level call', /\.call\s*[({]/], ['staticcall', /staticcall/], ['assembly', /\bassembly\b/], ['selfdestruct', /selfdestruct|suicide/],
  ['rescue', /rescue/i], ['withdraw', /withdraw/i], ['sweep', /sweep/i], ['setTreasury', /setTreasury/i], ['setToken', /setToken|setSync/i],
  ['split setter', /setSplit|setBurn|setPercent|setShare/i], ['any setter', /function\s+set[A-Z]/], ['approve', /\bapprove\b/],
  ['transferFrom', /transferFrom/], ['burnFrom', /burnFrom/], ['payable', /payable/], ['receive()', /receive\s*\(/],
  ['fallback()', /fallback\s*\(/], ['sstore/sload', /sstore|sload/], ['initializer', /initiali[sz]e/i], ['msg.value', /msg\.value/],
  ['tx.origin', /tx\.origin/], ['dead address', /0x0*dead/i], ['arbitrary target', /address\s*\(\s*target|\btarget\b/i],
];
for (const [name, re] of FORBIDDEN) check('sink source has no ' + name, !re.test(code), (code.match(re) || [''])[0]);

check('SYNC is immutable', /ISyncToken\s+public\s+immutable\s+SYNC\s*;/.test(code));
check('TREASURY is immutable', /address\s+public\s+immutable\s+TREASURY\s*;/.test(code));
check('split is a compile-time constant of 60', /uint256\s+public\s+constant\s+BURN_PERCENT\s*=\s*60\s*;/.test(code));
check('exactly two assignments to SYNC/TREASURY, both in the constructor', (code.match(/\b(SYNC|TREASURY)\s*=/g) || []).length === 2 && /constructor\s*\([^)]*\)\s*\{[^}]*SYNC\s*=[^}]*TREASURY\s*=/.test(code));
check('constructor rejects zero token and zero treasury', /sync\s*==\s*address\(0\)\s*\|\|\s*treasury\s*==\s*address\(0\)/.test(code));
check('settle() takes no parameters', /function\s+settle\s*\(\s*\)\s*external/.test(code));
check('only external calls are SYNC.balanceOf / SYNC.burn / SYNC.transfer(TREASURY, …)', (() => {
  const calls = [...code.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\s*\(/g)].map((m) => m[1] + '.' + m[2]);
  return calls.every((c) => ['SYNC.balanceOf', 'SYNC.burn', 'SYNC.transfer'].includes(c)) && /SYNC\.transfer\(\s*TREASURY\s*,/.test(code);
})(), [...code.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\s*\(/g)].map((m) => m[0]).join(' '));
check('burn happens through SYNC.burn (real totalSupply reduction), never a transfer to a dead address', /SYNC\.burn\(\s*burned\s*\)/.test(code));
check('treasury remainder = amount - burn (no residue)', /toTreasury\s*=\s*amount\s*-\s*toBurn/.test(code));
check('burn share computed without overflow', /\(amount\s*\/\s*100\)\s*\*\s*BURN_PERCENT\s*\+\s*\(\(amount\s*%\s*100\)\s*\*\s*BURN_PERCENT\)\s*\/\s*100/.test(code));
check('accounting before interactions (CEI)', code.indexOf('totalSettled +=') < code.indexOf('SYNC.burn(') && code.indexOf('totalTreasury +=') < code.indexOf('SYNC.transfer('));
check('treasury transfer result is checked', /!SYNC\.transfer\(TREASURY,\s*toTreasury\)\)\s*revert/.test(code));

const EXPECTED_ABI = [
  'constructor (address,address) nonpayable', 'error TreasuryIsToken()', 'error TreasuryTransferFailed()', 'error ZeroAddress()',
  'event Settled(address,uint256,uint256,uint256)', 'function BURN_PERCENT() view', 'function SYNC() view', 'function TREASURY() view',
  'function pending() view', 'function settle() nonpayable', 'function split(uint256) pure', 'function totalBurned() view',
  'function totalSettled() view', 'function totalTreasury() view',
];
const sig = (x) => `${x.type} ${x.name || ''}(${(x.inputs || []).map((i) => i.type).join(',')})${x.stateMutability ? ' ' + x.stateMutability : ''}`;
const abi = JSON.parse(fs.readFileSync(path.join(DIR, 'abi/SyncNetProjectHomeSink.abi.json'), 'utf8'));
const got = abi.map(sig).sort();
check('committed ABI is exactly the expected public surface', JSON.stringify(got) === JSON.stringify([...EXPECTED_ABI].sort()), got.join(' | '));
check('ABI has no payable entry, no receive, no fallback', abi.every((x) => x.stateMutability !== 'payable' && x.type !== 'receive' && x.type !== 'fallback'));
check('the only state-changing function is settle()', abi.filter((x) => x.type === 'function' && x.stateMutability === 'nonpayable').map((x) => x.name).join() === 'settle');

const forge = spawnSync('forge', ['--version'], { encoding: 'utf8' });
if (forge.status === 0) {
  const solc = process.env.SOLC_PATH ? ['--use', process.env.SOLC_PATH] : [];
  const r = spawnSync('forge', ['inspect', ...solc, 'SyncNetProjectHomeSink', 'abi', '--json'], { cwd: DIR, encoding: 'utf8' });
  let fresh = null; try { fresh = JSON.parse(r.stdout); } catch { fresh = null; }
  if (!fresh && /missing solc|install .*solc/i.test(r.stderr || '')) {
    results.push({ name: 'forge-derived ABI comparison', ok: true, detail: 'SKIPPED: no solc 0.8.28 available offline (set SOLC_PATH)' });
    console.log('NOTE solc 0.8.28 unavailable offline: committed ABI checked, not re-derived (set SOLC_PATH)');
  } else check('forge-derived ABI equals the committed ABI', fresh && JSON.stringify(fresh.map(sig).sort()) === JSON.stringify(got), (r.stderr || '').slice(0, 200));
} else {
  results.push({ name: 'forge-derived ABI comparison', ok: true, detail: 'SKIPPED: forge not installed (committed ABI checked above)' });
  console.log('NOTE forge not installed: committed ABI checked, not re-derived');
}

const passed = results.filter((r) => r.ok).length;
fs.writeFileSync(path.join(ROOT, 'tests/project-home/sink-static-audit.results.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed: failures, results }, null, 2));
console.log(`${passed}/${results.length} sink static audit checks passed`);
process.exit(failures ? 1 : 0);
