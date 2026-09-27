// Test helper: the reviewed Project Home deployment file with fixture addresses, and deployed runtime code built
// EXACTLY as the constructors produce it — the audited runtime (contracts/project-home-sink/abi/runtime.json, verified
// against a fresh compilation by code-fingerprint.mjs) with every immutable word written at its compiler offset.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REVIEWED = JSON.parse(fs.readFileSync(path.join(ROOT, 'syncnet-project-home-deployment.json'), 'utf8'));
const RUNTIME = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts/project-home-sink/abi/runtime.json'), 'utf8'));
const NAMES = { sink: 'SyncNetProjectHomeSink', converter: 'SyncNetProjectHomeTreasuryConverter' };
const lc = (v) => String(v == null ? '' : v).toLowerCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');

/** The deployed runtime of `kind` ('sink' | 'converter') for the given immutable values. */
export function deployedRuntime(kind, values) {
  let hex = RUNTIME[NAMES[kind]].slice(2);
  for (const [name, ranges] of Object.entries(REVIEWED.code[kind].immutables)) {
    if (!(name in values)) throw new Error('deployedRuntime: missing immutable ' + name);
    for (const [s] of ranges) hex = hex.slice(0, s * 2) + word(values[name]) + hex.slice(s * 2 + 64);
  }
  return '0x' + hex;
}

/** The reviewed deployment file with a fixture treasury and fixture deployments (canonical infrastructure unchanged). */
export function deploymentFile({ treasury, deployments }) {
  return { ...REVIEWED, treasury: lc(treasury), deployments: deployments.map((d) => ({ sink: lc(d.sink), converter: lc(d.converter) })) };
}

/**
 * The on-chain view of a correct deployment: code + getter answers keyed by address / `${address}:${selector}`.
 * Tests mutate the returned maps to simulate every misconfiguration.
 */
export function deploymentChain({ sink, converter, treasury, sync, usdg, router, market = 1 }, selector) {
  const code = new Map([[lc(sink), deployedRuntime('sink', { SYNC: sync, TREASURY_CONVERTER: converter })],
    [lc(converter), deployedRuntime('converter', { SYNC: sync, USDG: usdg, TREASURY: treasury, ROUTER: router, MARKET: market })]]);
  const getters = new Map([
    [lc(sink) + ':' + selector('SYNC()'), BigInt(sync)], [lc(sink) + ':' + selector('BURN_PERCENT()'), 60n], [lc(sink) + ':' + selector('TREASURY_CONVERTER()'), BigInt(converter)],
    [lc(converter) + ':' + selector('SYNC()'), BigInt(sync)], [lc(converter) + ':' + selector('USDG()'), BigInt(usdg)], [lc(converter) + ':' + selector('ROUTER()'), BigInt(router)],
    [lc(converter) + ':' + selector('MARKET()'), BigInt(market)], [lc(converter) + ':' + selector('TREASURY()'), BigInt(treasury)],
  ]);
  return { code, getters };
}
