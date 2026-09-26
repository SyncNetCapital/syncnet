# NET in SyncNet — can a global NET metric be derived truthfully? (V3 canary: not yet)

Decision: **no NET metric is built or displayed.** No trustworthy, SyncNet-attributable definition exists with the
data SyncNet verifies today. This note records why, and exactly what would be needed.

## What is verified today (and shown)

* **Markets.** A project's direct markets come from its launch factory record (PAR `readMarkets`, Pons V2 pair) and the
  quote tokens' own `symbol()`. `$SYNC` (0x6368…5eca37) has two PAR markets, read live on 26 Sep 2026:
  market 0 `SYNC/NET` (NET = 0xca9c78dd337a67f6e0077f65f5e9218719d30edf), market 1 `SYNC/USDG`.
  The Project Page CONNECTIONS row shows these as `Markets · NET · USDG`, each linking to the asset's own page.
* **Fee destination.** A PAR project's creator-fee recipient is read live. `$SYNC`'s is PAR's holder vault
  (0x4b79b8…353c). For holder-vault projects the ECONOMY row says `Holder rewards · <its traded assets> · $<itself>`
  with the mechanism ("PAR's distributor pays holders in the traded assets, in rounds. Not guaranteed.") — the same
  statement the reviewed Builder copy already makes. No amount is ever shown.
* **SyncNet's own contracts never touch NET.** Project Home: `$SYNC` → 60% burned, 40% → converter → USDG → treasury.

## Why "NET distributed / routed through SyncNet" is not derivable yet

| Candidate definition | Problem |
|---|---|
| NET volume in pools pairing a project with NET (e.g. SYNC/NET) | PAR's Uniswap v4 pools, traded through PAR/any router. SyncNet does not route these trades; calling it "through SyncNet" would be false. |
| NET paid to holders of SyncNet-related projects | Payouts come from **PAR's distributor**, an operator wallet shared by **all** PAR holder-mode projects, in batched rounds. A NET transfer from it cannot be attributed to one project without PAR's round manifests. Unrelated wallet transfers are indistinguishable. |
| NET creator fees credited for SyncNet-built projects | Plausible, but needs a verified per-token, per-currency credit event from PAR's fee escrow (0x1c27e8…4386). Its event ABI is **not verified** in this codebase. |
| NET moved by SyncNet contracts | Always zero (by design). |

Historical calculation is only feasible for the third definition, and only with a bounded, topic-filtered log index
(token + currency indexed), processed from finalized blocks with a stored cursor. Today SyncNet deliberately performs
no log scans anywhere in the payment path.

## What would be required before any number is shown

1. **Definition** (one sentence, reviewed): e.g. "NET credited as creator fees to PAR's holder vault for projects whose
   provenance is BUILT WITH SYNCNET · VERIFIED". Nothing else counted.
2. **Source ABI**: the verified PAR fee-escrow (or holder-vault) event that credits fees per token and per currency,
   with `token` and `currency` indexed, confirmed against PAR's published source/bytecode.
3. **Attribution set**: the SyncNet provenance registry (server-verified proofs), frozen per block height.
4. **Indexer**: a scheduled server job (not the browser) reading `eth_getLogs` over bounded finalized block ranges,
   filtered by escrow address + event topic + token topics; cursor and totals in the durable store; reorg-safe
   (finalized only); idempotent per `(txHash, logIndex)`.
5. **Canonical NET identity** pinned in reviewed configuration (by contract address, never by symbol).
6. **Display rules**: labelled with its exact definition and "as of block N"; never estimated, never client-side,
   never manually entered.

Until all six exist, NET stays visible only as verified **relationships** (markets, fee-flow assets), never as a volume.
