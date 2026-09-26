// Runs the SyncNetProjectHomeSink Foundry suite (contracts/project-home-sink). forge is required: this suite FAILS,
// it never skips, when forge or a solc 0.8.28 is unavailable. SOLC_PATH may point forge at a local solc 0.8.28
// (for offline sandboxes). Run: node tests/project-home/foundry.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'contracts/project-home-sink');
const v = spawnSync('forge', ['--version'], { encoding: 'utf8' });
if (v.status !== 0) { console.log('forge is not installed (https://book.getfoundry.sh, or npm i -g @foundry-rs/forge): 0 foundry tests passed, 1 failed'); process.exit(1); }
const args = ['test', ...(process.env.SOLC_PATH ? ['--use', process.env.SOLC_PATH] : []), '--fuzz-seed', '0x5eed'];
const r = spawnSync('forge', args, { cwd: DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const out = (r.stdout || '') + (r.stderr || '');
const m = out.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped/);
const tests = [...out.matchAll(/\[(PASS|FAIL)[^\]]*\] (\w+)\(/g)].map((x) => ({ name: x[2], ok: x[1] === 'PASS' }));
fs.writeFileSync(path.join(ROOT, 'tests/project-home/foundry.results.json'), JSON.stringify({ at: new Date().toISOString(), forge: v.stdout.split('\n')[0], summary: m ? m[0] : null, tests }, null, 2));
console.log(m ? `${m[1]} foundry tests passed, ${m[2]} failed, ${m[3]} skipped` : out.slice(-600));
process.exit(r.status === 0 && m && m[2] === '0' && m[3] === '0' ? 0 : 1);
