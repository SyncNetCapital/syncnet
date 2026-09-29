// LIVE, read-only probe of the Robinhood Chain RPC capabilities EARLY depends on (docs §13.3 task E-1, §21 #40).
// It touches the real network (public RPC or SYNCNET_RPC_URL) and is NOT part of run-all.mjs. It sends nothing.
//   node tests/live/early-rpc-capability.mjs [--rpc https://…]
// Writes tests/live/early-rpc-capability.results.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const Chain = require(path.join(ROOT, 'lib/syncnet-chain.js'));
const E = require(path.join(ROOT, 'lib/syncnet-early.js'));
const args = process.argv.slice(2);
const url = args.includes('--rpc') ? args[args.indexOf('--rpc') + 1] : (process.env.SYNCNET_RPC_URL || Chain.ROBINHOOD.rpcUrl);
const rpc = Chain.makeRpc(url, { timeoutMs: 20000, retries: 0 });
const out = { at: new Date().toISOString(), rpc: url.replace(/\/\/([^@/]+@)/, '//'), checks: [] };
const add = (id, ok, detail) => { out.checks.push({ id, ok: Boolean(ok), detail }); console.log((ok ? 'PASS ' : 'FAIL ') + id + '  ' + (detail || '')); };
const hex = (n) => '0x' + BigInt(n).toString(16);
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const t0 = Date.now();
try {
  const chainId = await rpc('eth_chainId', []);
  add('chain-id', chainId === '0x1237', chainId);
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  const headN = BigInt(head.number);
  add('latest', Boolean(head && head.hash), 'block ' + headN + ' ts ' + Number(BigInt(head.timestamp)));
  let safe = null, fin = null;
  try { safe = await rpc('eth_getBlockByNumber', ['safe', false]); add('safe-tag', safe && safe.number, safe ? 'lag ' + (headN - BigInt(safe.number)) + ' blocks, ' + (Number(BigInt(head.timestamp)) - Number(BigInt(safe.timestamp))) + ' s' : 'null'); } catch (e) { add('safe-tag', false, String(e.message)); }
  try { fin = await rpc('eth_getBlockByNumber', ['finalized', false]); add('finalized-tag', fin && fin.number, fin ? 'lag ' + (headN - BigInt(fin.number)) + ' blocks, ' + (Number(BigInt(head.timestamp)) - Number(BigInt(fin.timestamp))) + ' s' : 'null'); } catch (e) { add('finalized-tag', false, String(e.message)); }
  // block time estimate over the last 1000 blocks
  const older = await rpc('eth_getBlockByNumber', [hex(headN - 1000n), false]);
  const perBlock = (Number(BigInt(head.timestamp)) - Number(BigInt(older.timestamp))) / 1000;
  add('block-time', perBlock > 0, perBlock.toFixed(3) + ' s/block → 2 h window ≈ ' + Math.round(7200 / perBlock) + ' blocks');
  out.blockTimeSeconds = perBlock;
  // (a) the EXACT EARLY filter: Transfer on the canonical token from ONE sender to ONE receiver (three topics). This is
  //     what the sweep sends; results are tiny, so only a block-RANGE cap can bind.
  const pad = (a) => '0x' + '0'.repeat(24) + a.slice(2);
  const sender = '0x000000000000000000000000000000000000ea51', receiver = '0x000000000000000000000000000000000000ea52';
  const exact = [E.TRANSFER_TOPIC, pad(sender), pad(receiver)];
  out.getLogsRangeMax = 0;
  for (const range of [1000n, 5000n, 10000n, 20000n, 50000n, 100000n, 200000n]) {
    const from = headN - range, to = headN;
    const s = Date.now();
    try { const logs = await rpc('eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(to), address: USDG, topics: exact }]); add('getLogs-exact-filter-' + range, Array.isArray(logs), (Array.isArray(logs) ? logs.length + ' logs' : 'non-array') + ' in ' + (Date.now() - s) + ' ms'); out.getLogsRangeMax = Number(range); }
    catch (e) { add('getLogs-exact-filter-' + range, false, String(e.message).slice(0, 120)); break; }
  }
  // (b) the RESULT cap: a broad filter (every USDG Transfer) shows how the RPC limits results, which EARLY never hits
  //     with its three-topic filter unless one fan floods one creator with > 10,000 transfers in a window.
  for (const range of [1000n, 5000n]) {
    const s = Date.now();
    try { const logs = await rpc('eth_getLogs', [{ fromBlock: hex(headN - range), toBlock: hex(headN), address: USDG, topics: [E.TRANSFER_TOPIC] }]); add('getLogs-broad-' + range, true, logs.length + ' logs in ' + (Date.now() - s) + ' ms'); }
    catch (e) { add('getLogs-broad-' + range, true, 'result cap observed: ' + String(e.message).slice(0, 100)); out.resultCap = String(e.message).slice(0, 100); }
  }
  out.getLogsMax = out.getLogsRangeMax;
  // EIP-1271 / getCode work as used by sig-verify.js
  const code = await rpc('eth_getCode', [USDG, 'latest']);
  add('getCode', typeof code === 'string' && code.length > 2, code.slice(0, 12) + '…');
  const needCalls = out.getLogsMax ? Math.ceil((7200 / perBlock) / Math.min(out.getLogsMax, 50000)) : null;
  out.recommendation = out.getLogsMax >= 10000 ? 'The exact three-topic filter spans ≥ ' + out.getLogsMax + ' blocks per call: EARLY_GETLOGS_CHUNK=' + Math.min(out.getLogsMax, 50000) + ' covers a 2 h window in ' + needCalls + ' call(s) (budget 24).' : out.getLogsMax ? 'Set EARLY_GETLOGS_CHUNK=' + out.getLogsMax + ' and consider a private RPC: a 2 h window needs ' + needCalls + ' calls.' : 'eth_getLogs failed at 1000 blocks: a private RPC (SYNCNET_RPC_URL) is required.';
  console.log(out.recommendation);
} catch (e) { add('rpc', false, String(e && e.message)); }
out.ms = Date.now() - t0;
fs.writeFileSync(path.join(ROOT, 'tests/live/early-rpc-capability.results.json'), JSON.stringify(out, null, 2));
process.exit(out.checks.every((c) => c.ok) ? 0 : 1);
