// Runs every SyncNet V2.5 RC test suite in sequence and writes tests/RESULTS.json + a summary table.
// Nothing touches a real network. Run: node tests/run-all.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = [
  ['static audit', 'python3', ['tests/static_audit.py'], /PASS/],
  ['core unit (keccak, secp256k1, EIP-712, ABI, text policy)', 'node', ['tests/unit/core.test.mjs'], /(\d+) passed, (\d+) failed/],
  ['image sanitizer', 'node', ['tests/server/image-sanitize.test.mjs'], /(\d+) passed, (\d+) failed/],
  ['server infrastructure', 'node', ['tests/server/infra.test.mjs'], /(\d+) passed, (\d+) failed/],
  ['server endpoint abuse (RC)', 'node', ['tests/server/rc-server.test.mjs'], /(\d+)\/(\d+) server checks passed/],
  ['server IPFS check /api/ipfs-check (hotfix)', 'node', ['tests/server/ipfs-check.test.mjs'], /(\d+)\/(\d+) ipfs-check checks passed/],
  ['server Marketplace /api/marketplace (V1)', 'node', ['tests/server/marketplace.test.mjs'], /(\d+)\/(\d+) marketplace server checks passed/],
  ['server Passport authority (no fee-recipient takeover)', 'node', ['tests/server/passport-authority.test.mjs'], /(\d+)\/(\d+) passport authority checks passed/],
  ['server Marketplace × Pons V2 (origins)', 'node', ['tests/server/marketplace-pons.test.mjs'], /(\d+)\/(\d+) marketplace Pons checks passed/],
  ['Economies unit (EIP-712 domain, fold, derived membership)', 'node', ['tests/unit/economy.test.mjs'], /(\d+) passed, (\d+) failed/],
  ['server Economies /api/economies (V0)', 'node', ['tests/server/economies.test.mjs'], /(\d+)\/(\d+) economies server checks passed/],
  ['PONS V2 discovery unit (decode, adaptive scan, reorg, sorted sets)', 'node', ['tests/unit/pons-discovery.test.mjs'], /(\d+)\/(\d+) pons discovery checks passed/],
  ['PONS V2 index sorted sets on real Redis (Upstash adapter == memory)', 'node', ['tests/unit/pons-redis-zset.test.mjs'], /(\d+)\/(\d+) pons real-Redis sorted-set checks passed/],
  ['server PONS V2 discovery /api/pons-economy + curation', 'node', ['tests/server/pons-economy.test.mjs'], /(\d+)\/(\d+) pons economy server checks passed/],
  ['Solana discovery V0 (identity, Pump truth model, launch index, indexer, /api/pump-economy, backfill)', 'node', ['tests/unit/solana-discovery.test.mjs'], /(\d+)\/(\d+) solana discovery checks passed/],
  ['audit PoCs · engine (AFTER)', 'node', ['tests/audit/poc-engine.mjs'], /(\d+)\/(\d+) reproduced/],
  ['audit PoCs · server (AFTER)', 'node', ['tests/audit/poc-server.mjs'], /(\d+)\/(\d+) reproduced/],
  ['audit PoCs · pages (AFTER)', 'node', ['tests/audit/poc-e2e.mjs'], /(\d+)\/(\d+) vulnerability checks reproduced/],
  ['E2E (existing product suites, updated)', 'node', ['tests/e2e/run.mjs'], /(\d+)\/(\d+) checks passed/],
  ['Network Map child connections (show all / collapse, batches)', 'node', ['tests/e2e/network-children.mjs'], /(\d+)\/(\d+) network children checks passed/],
  ['PONS V2 discovery UI (Economy + Network Map, flag on/off)', 'node', ['tests/e2e/pons-discovery-ui.mjs'], /(\d+)\/(\d+) pons discovery UI checks passed/],
  ['required regressions R01–R28', 'node', ['tests/regression/rc-regressions.mjs'], /(\d+)\/(\d+) regression checks passed/],
  ['IPFS display (canonical utility, PONSYNC CID)', 'node', ['tests/regression/rc-ipfs-display.mjs'], /(\d+)\/(\d+) ipfs-display checks passed/],
  ['Marketplace walkthrough (two browsers, full deal)', 'node', ['tests/regression/rc-marketplace.mjs'], /(\d+)\/(\d+) marketplace walkthrough checks passed/],
  ['Marketplace × Pons V2 walkthrough (detect, claim, list, fee right)', 'node', ['tests/regression/rc-marketplace-pons.mjs'], /(\d+)\/(\d+) marketplace Pons walkthrough checks passed/],
  ['Marketplace wallet selection (multi-wallet chooser)', 'node', ['tests/regression/rc-wallet-select.mjs'], /(\d+)\/(\d+) wallet-selection checks passed/],
  ['Phantom EVM-account notice (Solana-only account)', 'node', ['tests/regression/rc-wallet-evm.mjs'], /(\d+)\/(\d+) wallet EVM-account checks passed/],
  ['mobile 320/360/390/430', 'node', ['tests/regression/rc-mobile.mjs'], /(\d+)\/(\d+) mobile checks passed/],
  ['Economy walkthrough (derived membership, recognize/revoke)', 'node', ['tests/regression/rc-economy.mjs'], /(\d+)\/(\d+) economy walkthrough checks passed/],
  ['Project Home · contracts: sink + converter (Foundry, incl. fuzzing)', 'node', ['tests/project-home/foundry.mjs'], /(\d+) foundry tests passed, (\d+) failed, (\d+) skipped/],
  ['Project Home · contract static/ABI audit (sink + converter)', 'node', ['tests/project-home/sink-static-audit.mjs'], /(\d+)\/(\d+) sink static audit checks passed/],
  ['Project Home · pricing ($12 USD active, fixed point, tags, gate)', 'node', ['tests/project-home/pricing.test.mjs'], /(\d+)\/(\d+) project-home pricing checks passed/],
  ['Project Home · site schema, EIP-712, renderer audit', 'node', ['tests/project-home/site.test.mjs'], /(\d+)\/(\d+) project-home site checks passed/],
  ['Project Home · server (intents, activation, sites)', 'node', ['tests/project-home/server.test.mjs'], /(\d+)\/(\d+) project-home server checks passed/],
  ['Project Home · atomic commit on real Redis', 'node', ['tests/project-home/redis-atomic.test.mjs'], /(\d+)\/(\d+) project-home real-Redis checks passed/],
  ['Project Home · payment deployment validation (P1-2, adversarial)', 'node', ['tests/project-home/deployment.test.mjs'], /(\d+)\/(\d+) deployment validation checks passed/],
  ['Project Home · code identity (immutable-aware fingerprints vs fresh build)', 'node', ['tests/project-home/code-fingerprint.mjs'], /(\d+)\/(\d+) code fingerprint checks passed/],
  ['Phase 2 UI · Explore, Project Page, You, Project Home editor/payment/adoption', 'node', ['tests/e2e/phase2-ui.mjs'], /(\d+)\/(\d+) phase 2 UI checks passed/],
  ['EARLY · protocol primitives (domain, canonical JSON, assets, Merkle, attestations, matching rule)', 'node', ['tests/early/unit.test.mjs'], /(\d+)\/(\d+) early unit checks passed/],
  ['EARLY · server /api/early (Count me in, creator, intents, matching, receipts, cards, rotation)', 'node', ['tests/early/server.test.mjs'], /(\d+)\/(\d+) early server checks passed/],
  ['EARLY · identity/context (YouTube client, OAuth function, daily snapshots)', 'node', ['tests/early/identity.test.mjs'], /(\d+)\/(\d+) early identity checks passed/],
  ['EARLY · anchoring (RLP/EIP-155, anchor tx, OpenTimestamps, bundle job, verifier)', 'node', ['tests/early/anchor.test.mjs'], /(\d+)\/(\d+) early anchor checks passed/],
  ['EARLY · platform identity (pinned YouTube vectors, platform helpers, sessions, closed-platform gate, legacy-state replay)', 'node', ['tests/early/platform.test.mjs'], /(\d+)\/(\d+) early platform checks passed/],
  ['EARLY · X platform (OAuth PKCE, resolver, follower snapshots, spend guard, feature gate)', 'node', ['tests/early/x.test.mjs'], /(\d+)\/(\d+) early X checks passed/],
  ['EARLY · UI + mobile (two prompts, resume, receipt, card; 320–430 px)', 'node', ['tests/e2e/early-ui.mjs'], /(\d+)\/(\d+) early UI checks passed/],
];
const out = [];
for (const [name, cmd, args, re] of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const text = (r.stdout || '') + (r.stderr || '');
  const m = text.match(re);
  const last = text.trim().split('\n').slice(-1)[0];
  out.push({ suite: name, command: [cmd, ...args].join(' '), exit: r.status, seconds: Math.round((Date.now() - t0) / 1000), summary: m ? m[0] : last.slice(0, 160) });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${m ? m[0] : last.slice(0, 120)}  (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const fp = spawnSync('node', ['tests/fingerprint.mjs'], { cwd: ROOT, encoding: 'utf8' });
const fingerprint = ((fp.stdout || '').match(/sha256:[0-9a-f]{64} \(\d+ deployable files\)/) || ['unknown'])[0];
console.log('\nTested site: ' + fingerprint);
fs.writeFileSync(path.join(ROOT, 'tests/RESULTS.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, site: fingerprint, suites: out }, null, 2));
const failed = out.filter((s) => s.exit !== 0);
console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\nALL SUITES PASSED');
process.exit(failed.length ? 1 : 0);
