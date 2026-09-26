# Marketplace V1 — Netlify deploy checklist

The Marketplace ships inside the normal site deploy; there is no separate service. It turns itself on **only** when a durable store is configured, and fails closed otherwise. Follow `docs/DEPLOYMENT.md` for the site itself; this checklist covers what the Marketplace adds.

## 1. Before deploying

- [ ] Environment variables (Site settings → Environment variables):
  - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or `SYNCNET_UPSTASH_URL`/`SYNCNET_UPSTASH_TOKEN`) — **required**. Same store the Registry and rate limits already use; the Marketplace adds `mp:*` keys. Without it the Marketplace stays closed and says so.
  - `SYNCNET_MARKETPLACE_DISABLED` — leave **unset**. Setting it to `true` is the kill switch.
  - `SYNCNET_RPC_URL` — optional private RPC for the server's live origin reads: PAR and Pons V2 factories (defaults to the public Robinhood Chain RPC).
  - `netlify.toml` bundles `lib/syncnet-origins.js` with the functions (already configured).
  - No new secrets are introduced by the Marketplace, and no existing secret changes.
- [ ] Deploy the ZIP/branch as usual. The functions bundle now includes `marketplace` (routes `/api/marketplace` are already in `netlify.toml` + `_redirects`).

## 2. Smoke test after deploy (5 minutes, read-only first)

- [ ] `GET https://<site>/api/marketplace?view=config` → `{"enabled":true,"durable":true}` (with Upstash set). `enabled:false` means the store is missing or the kill switch is on.
- [ ] Open `/marketplace.html`: the page renders, BROWSE shows the polished empty state (or real listings), and the hero badge reads SIGNED LISTINGS · VERIFIED HANDOVERS · NON-CUSTODIAL (the settlement rules — no custody, no escrow, manual settlement — are stated in the three rule cards below the workspace).
- [ ] Open `/project/<any PAR token>`: the page still renders its Passport panel; no operator row appears for unclaimed projects.
- [ ] PONSYNC regression: its project page shows the logo (Pinata gateway), FULLY VERIFIED state and unchanged deployer/fee facts. Display needs no new transaction.

## 3. First real listing (operator dry run)

- [ ] Click CONNECT WALLET. With one wallet installed it connects directly; with several, a chooser lists them by name (MetaMask, Phantom, Rabby, Brave Wallet, …) and nothing is signed or sent by choosing.
- [ ] In SELL A PROJECT, enter a live token you deploy/operate → CHECK PROJECT shows the live facts → SIGN OPERATOR CLAIM. The wallet must show a **signature request, not a transaction**. If gas appears, stop: something is wrong.
- [ ] Create a listing (any price; you can cancel it right after) → it appears in BROWSE **from a different browser/device** (server persistence check).
- [ ] Cancel the listing from MY ACTIVITY. The card moves to Past listings as CANCELLED.

## 4. Operations

- **Kill switch**: set `SYNCNET_MARKETPLACE_DISABLED=true` and redeploy (or change env + trigger deploy) to close writes instantly; reads answer `enabled:false` and the page explains the marketplace is not enabled. Unset to reopen — records are untouched.
- **Data**: all Marketplace state lives under `mp:*` keys in Upstash. Records are signed and append-only where it matters (Passport history); there is no admin edit path by design.
- **Logs**: function logs use hashed IP/wallet ids; look for `marketplace` entries. `claim-bad-sig`, `rl-…` spikes indicate abuse; the rate limits are durable and per-IP + per-wallet.
- **Do not** add approval/permit flows, custody, or an escrow contract to this release. The security model (see `MARKETPLACE_SECURITY.md`) depends on the marketplace never touching funds.

## 5. Pons V2 — manual mainnet verification (before announcing Pons support)

The CI suites use a mock chain with the exact Pons ABI layouts. Run these once against Robinhood Chain mainnet:

```bash
R=https://rpc.mainnet.chain.robinhood.com; F=0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e; T=<a real Pons V2 token>
cast code $F --rpc-url $R | head -c 20                       # the factory has code
cast call $F "getLaunchedToken(address)((address,address,address,address,address,uint256,uint24,int24,uint16,bool,uint8,uint256,uint256,uint256,bool))" $T --rpc-url $R
#   expect: first field == T, last field (exists) == true; note deployer, creatorFeeRecipient, pairToken, phase
cast call $F "pendingCreatorFeeRecipient(address)(address,uint256,uint256)" $T --rpc-url $R   # expect 0x0…0,0,0 normally
cast call $T "launchFactory()(address)" --rpc-url $R                                            # expect $F
cast call 0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB "getLaunchedToken(address)" $T --rpc-url $R # V1 (ACTIVE) must NOT know a V2 token
cast call 0x39dBED3a2bd333467115dE45665cC57F813C4571 "launchFactory()(address)" --rpc-url $R     # PONS → 0x0c37…77a4 (V1 LEGACY)
```

All of the above is automated (plus Blockscout-bytecode pinning and real signed claim/list refusals for V1):
`node tests/live/pons-step3-live.mjs` (real network; last run 26 Sep 2026: 18/18).

- [ ] `/marketplace.html` → SELL A PROJECT → paste `$T`: **DETECTED PONS V2**, pair/phase/tax/deployer/fee recipient match the cast output.
- [ ] A random ERC-20 → UNSUPPORTED PROJECT. PONS `0x39dBED3a2bd333467115dE45665cC57F813C4571` (V1 LEGACY) → PONS V1 DETECTED, no claim step.
- [ ] With the deployer (or current fee-recipient wallet) claim the Passport: evidence ends in "(Pons V2 factory record)".
- [ ] List without the fee right; the card shows LIVE PONS PROJECT · PAIR · STATUS; `/project/$T` shows the Pons origin block.
- [ ] Only with a throwaway test launch: include the fee right, run a deal, send TRANSFER FEE RIGHT — the wallet shows a
      transaction **to `0x7eD598Bc…EC7e`**, 0 ETH, `transferCreatorFeeRecipient($T, buyer)`; the step turns VERIFIED ON-CHAIN
      only after the factory re-read names the buyer.
