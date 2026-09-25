// Dumps the exact calldata the engine builds (direct + router paths) with the inputs, for an independent re-encode.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { webcrypto } from 'node:crypto'; import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viem = await import(pathToFileURL(path.join(ROOT, 'vendor/viem.js')).href);
const sb = { window: {}, crypto: webcrypto, URL, console }; vm.createContext(sb); vm.runInContext(fs.readFileSync(path.join(ROOT, 'launch-engine-v2.js'), 'utf8'), sb); const E = sb.window.SyncNetLaunchV2;
const ACCOUNT = '0xabcdefabcdefabcdefabcdefabcdefabcdef0001', PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571', SYNC = '0x6368e007b9f0b941560ed1f3bceb20247f5eca37', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const hops = { [PONS]: [{ key: { currency0: PONS, currency1: USDG, fee: 3000, tickSpacing: 0, hooks: '0x0000000000000000000000000000000000000000' }, v3: true }, { key: { currency0: '0x0000000000000000000000000000000000000000', currency1: USDG, fee: 500, tickSpacing: 10, hooks: '0x0000000000000000000000000000000000000000' }, v3: false }], [SYNC]: [{ key: { currency0: '0x0000000000000000000000000000000000000000', currency1: SYNC, fee: 10000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' }, v3: false }] };
const client = { async getChainId() { return 4663 }, async getBytecode() { return '0x60' }, async estimateGas() { return 1n }, async request({ method }) { return method === 'eth_gasPrice' ? '0x1' : '0x' + (10n ** 21n).toString(16) },
  async readContract({ functionName, args }) { return { canLaunch: true, launchFee: 500000000000000n, baseFeeBps: 100n, maxCreatorTaxBps: 1000n, protocolFeeShareBps: 5000n, isPriceable: true, launchForwarder: E.ROUTER }[functionName] ?? (functionName === 'route' ? [hops[String(args[0]).toLowerCase()] || [], true] : undefined) },
  async call(r) { return { data: r.data.startsWith('0x5fe889a4') ? viem.encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], ['0x7777777777777777777777777777777777777777', 123456789n * 10n ** 18n]) : viem.encodeAbiParameters([{ type: 'address' }], ['0x7777777777777777777777777777777777777777']) } } };
const provider = { async request({ method }) { return method === 'eth_chainId' ? '0x1237' : [ACCOUNT] } };
const out = [];
for (const buy of ['0', '100000000000000001']) {
  const draft = { account: ACCOUNT, name: 'PONSYNC ✓ ünï', symbol: 'PONSYNC', description: 'Line1\nLine2 "quoted" \\ backslash', logo: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', twitter: 'https://x.com/ponsync', website: 'https://ponsync.example/', tax: 250, feeMode: 'creator', feeRecipient: '0x1111111111111111111111111111111111111111', quotes: [{ address: PONS, symbol: 'PONS' }, { address: SYNC, symbol: 'SYNC' }], openingBuyWei: buy, slippageBps: 100 };
  const p = await E.prepare({ client, provider, draft, viem, chainId: 4663 });
  out.push({ path: buy === '0' ? 'direct' : 'router', to: p.request.to, value: String(p.request.value), data: p.request.data, params: { ...p.params, creatorTaxBps: p.params.creatorTaxBps }, pairTokens: p.pairTokens, legs: p.openingBuy ? JSON.parse(JSON.stringify(p.openingBuy.legs, (k, v) => typeof v === 'bigint' ? v.toString() : v)) : null, minTokens: p.openingBuy ? String(p.openingBuy.minTokens) : null, rawLegs: buy === '0' ? null : (hops) });
}
fs.writeFileSync(path.join(ROOT, 'tests/audit/calldata.json'), JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
console.log('dumped', out.map(o => o.path + ':' + o.data.length).join(' '));
