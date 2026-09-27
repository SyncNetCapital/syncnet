// Project Home contract CODE IDENTITY — immutable-aware runtime fingerprints of the audited build.
//
// Solidity writes each immutable into the deployed runtime as a 32-byte word at compiler-known offsets
// (deployedBytecode.immutableReferences). A raw hash of deployed code therefore differs per deployment; instead:
//   fingerprint = { runtimeLength, normalizedKeccak = keccak256(runtime with every immutable range zeroed), immutables }
// The server (netlify/lib/project-home-deployment.js) recomputes this from eth_getCode, and separately reads every
// immutable word out of the deployed code and compares it with the reviewed value.
//
// This script compiles the contracts with the project's own foundry.toml (solc 0.8.28, optimizer 10000 runs, cancun,
// no metadata hash) and:
//   (default)  VERIFIES that the pinned fingerprints in syncnet-project-home-deployment.json and the runtime fixture in
//              contracts/project-home-sink/abi/runtime.json equal a fresh compilation (drift = failure);
//   --print    prints the values a reviewer would pin (never writes files).
// Run: node tests/project-home/code-fingerprint.mjs [--print]
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const Core = require(path.join(ROOT, 'lib/syncnet-core.js'));
const DIR = path.join(ROOT, 'contracts/project-home-sink');
const CONTRACTS = { sink: 'SyncNetProjectHomeSink', converter: 'SyncNetProjectHomeTreasuryConverter' };
const results = []; let failures = 0;
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); if (!ok) { failures++; console.log('FAIL', name, detail); } else console.log('ok  ', name); };

// Build in a throwaway copy so the repository tree is never written.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-fp-'));
fs.cpSync(DIR, work, { recursive: true, filter: (s) => !/[\\/](out|cache|broadcast)([\\/]|$)/.test(s.slice(DIR.length)) });
const solc = process.env.SOLC_PATH || '/opt/sn-tools/solc-0.8.28';
const args = ['build', '--ast', '--skip', 'test', '--skip', 'script', ...(fs.existsSync(solc) ? ['--use', solc] : [])];
const b = spawnSync('forge', args, { cwd: work, encoding: 'utf8' });
if (b.status !== 0) { console.log('forge build failed:', (b.stderr || b.stdout || '').slice(-400)); console.log('0/1 code fingerprint checks passed'); process.exit(1); }

function fingerprintOf(name) {
  const art = JSON.parse(fs.readFileSync(path.join(work, 'out', name + '.sol', name + '.json'), 'utf8'));
  const ids = new Map();
  (function walk(n) { if (!n || typeof n !== 'object') return; if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') ids.set(String(n.id), n.name); for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v); })(art.ast);
  const code = art.deployedBytecode.object.toLowerCase();
  const bytes = Core.hexToBytes(code);
  const immutables = {};
  for (const [id, refs] of Object.entries(art.deployedBytecode.immutableReferences || {})) {
    immutables[ids.get(id)] = refs.map((r) => [r.start, r.length]).sort((x, y) => x[0] - y[0]);
  }
  // The compiler leaves immutable ranges zero-filled; normalisation zeroes them anyway (idempotent here).
  for (const ranges of Object.values(immutables)) for (const [s, l] of ranges) bytes.fill(0, s, s + l);
  return {
    fingerprint: { contract: name, runtimeLength: bytes.length, normalizedKeccak: Core.keccak256(bytes), immutables: Object.fromEntries(Object.entries(immutables).sort()) },
    runtime: Core.bytesToHex(bytes),
  };
}

const fresh = Object.fromEntries(Object.entries(CONTRACTS).map(([k, n]) => [k, fingerprintOf(n)]));
fs.rmSync(work, { recursive: true, force: true });

if (process.argv.includes('--print')) {
  console.log(JSON.stringify({ code: Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, v.fingerprint])) }, null, 2));
  console.log('\nruntime fixture:\n' + JSON.stringify(Object.fromEntries(Object.entries(fresh).map(([k, v]) => [CONTRACTS[k], v.runtime])), null, 1).slice(0, 200) + '…');
  process.exit(0);
}

const pinned = JSON.parse(fs.readFileSync(path.join(ROOT, 'syncnet-project-home-deployment.json'), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(path.join(DIR, 'abi/runtime.json'), 'utf8'));
for (const [k, v] of Object.entries(fresh)) {
  check(`${k}: pinned fingerprint equals a fresh compilation of the audited source`, JSON.stringify(pinned.code[k]) === JSON.stringify(v.fingerprint), JSON.stringify(v.fingerprint));
  check(`${k}: runtime fixture equals the fresh compilation`, fixture[CONTRACTS[k]] === v.runtime);
  check(`${k}: every immutable is a single 32-byte word, never overlapping`, Object.values(v.fingerprint.immutables).flat().every(([, l]) => l === 32) && Object.values(v.fingerprint.immutables).flat().sort((a, b) => a[0] - b[0]).every((r, i, a) => i === 0 || a[i - 1][0] + 32 <= r[0]));
}
check('sink immutables are exactly SYNC and TREASURY_CONVERTER', Object.keys(fresh.sink.fingerprint.immutables).join() === 'SYNC,TREASURY_CONVERTER');
check('converter immutables are exactly MARKET, ROUTER, SYNC, TREASURY, USDG', Object.keys(fresh.converter.fingerprint.immutables).join() === 'MARKET,ROUTER,SYNC,TREASURY,USDG');
console.log(`\n${results.length - failures}/${results.length} code fingerprint checks passed`);
process.exit(failures ? 1 : 0);
