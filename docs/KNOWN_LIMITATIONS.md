# Known limitations (V2.5 release candidate)

## Launching

- **Live launching is gated.** Without the founder unlock or `SYNCNET_PUBLIC_LAUNCH=true`, the builder only simulates. The launch is a transaction from the creator's own wallet to PAR, so nothing prevents anyone from calling PAR directly outside SyncNet.
- **Launch evidence lives in the browser that launched.** Records are written before the wallet is asked and SyncNet never deletes them, but clearing site data or switching devices loses them unless they were exported. RECOVER A LAUNCH rebuilds the on-chain facts from a tx hash, token or wallet. Provenance, i.e. the intent and signature, needs the exported file.
- **Duplicate detection across devices depends on PAR's indexer.** On the same device, local records and the chain block a repeat. On another device, the server guard lists the wallet's earlier launches with that ticker from `api.par.family`, and each is then checked on-chain. When both the SyncNet guard and the indexer are unreachable, the builder shows a warning that needs an explicit acknowledgement instead of blocking.
- **Mobile.** Supported widths are 320–430 px in a wallet's in-app browser, or any mobile browser with an injected EIP-1193 wallet. WalletConnect is not included.
- **Economics commitment.** PAR's `expectedEconomics` is committed only when every market is PAR-curated. Spot-priced markets move with every trade, so committing would revert on normal price movement; for them SyncNet re-reads the parameters right before sending and states NOT COMMITTED in the final review.
- **Native-ETH market** (`pairToken = 0x0`, allowed by PAR) cannot be selected in SyncNet. This is by design.
- **Contract wallets.** EIP-1271 signatures are verified at the current block. A smart wallet that later changes its signers can make an old proof stop verifying.

## Trust in third parties

- PAR's contracts are not audited, per PAR's docs. PAR's owner can change fees for *future* launches, disable launching, and run a Community Takeover of a fee recipient with a 3-day notice.
- Holder, burn and floor vault payouts depend on PAR's operator wallets. The floor vault's source is not published.
- The public Robinhood Chain RPC, `api.par.family`, the IPFS gateways (`ipfs.io`, `dweb.link`), Pinata and Upstash can be slow or unavailable. SyncNet degrades to "unavailable" states and never to false claims.
- `vendor/viem.js` is a vendored, minimal bundle that could not be compared with upstream offline. Every calldata it encodes is decoded again by SyncNet's own ABI decoder and must match field by field before simulation.

## Product scope

- Marketplace V1 is real but deliberately non-custodial: SyncNet never holds funds and there is no escrow, so payment and delivery are not atomic — the deal room orders the steps and verifies what it can (operator transfer signatures, on-chain fee-right recipient, on-chain ETH payment), but off-chain items (domains, repos, communities) rest on both-party confirmation and counterparty honesty. Listings require a durable store (Upstash); without one the Marketplace fails closed and says so. X accounts are never represented as transferable.
- Topology and name/ticker search are limited to what PAR's indexer exposes. Contract lookups are authoritative.
- There are no hosted accounts, server-side profiles or automated posting.
- Legal pages (Terms, Privacy, Risk) were updated for this build but are not legal advice. Have them reviewed before opening to the public.

## Labs · EARLY (pilot, off by default)

- **Ordering is an application guarantee.** A receipt proves the fan signature, the creator manifest and the matching transfer independently; it does not prove that the intent was signed before the transfer (SyncNet enforces persist-then-enable and records `createdBlock`).
- **Default cards are attested, not independently verifiable.** Hiding the transaction hides wallet and amount, so a public card without a revealed transaction rests on SyncNet's anchored attestations. Revealing is a Phase 2 signed action.
- **Mobile depends on wallets' in-app browsers.** Path A (universal links into MetaMask / Coinbase Wallet / Trust) is the primary phone path; WalletConnect is not included. The real-device matrix (`docs/early-device-matrix.md`) has not been run yet and is the Phase 1 exit gate.
- **Confirmation latency.** Measured on the public RPC: SAFE ≈ 12.5 min, FINALIZED ≈ 19 min behind the head. A receipt is CONFIRMED at SAFE; the card unlocks at FINALIZED.
- **OpenTimestamps is "submitted" until upgraded.** Bitcoin verifiability arrives later. The `.ots` file stamps `sha256(root)` and was validated with the reference client (0.7.2): `ots info`, `ots verify -f root.bin`, `ots upgrade` all parse it and report the pending state.
- **Count me in is not Sybil-resistant.** Counts are of signed records; rate limits bound flooding only.
- **Attestations need the key.** Without `SYNCNET_EARLY_ATTESTATION_KEY` no creator can join, no snapshot is taken and no rotation completes (fail closed); verification of existing receipts keeps working.
- **Real-Redis atomicity test not run here.** The `cas` script is the same one Project Home tests on a real `redis-server`; this environment had none, so EARLY's races were tested on the in-memory adapter only.

## Economies V0

- **Membership is only as complete as the PAR index window.** `/api/par-launches-all` covers at most 5,000 launches; older connected projects are not listed. A recognized project outside the window is shown as *connection previously verified · outside current index window*, never as indexer-confirmed.
- **Recognition is one-sided.** It is signed by the root's current operator (or a reviewed curator); the recognized project does not co-sign (child acknowledgement is planned for V1.1). SyncNet endorses nothing.
- **Roots without a provable curator stay unclaimed.** Non-PAR roots need a reviewed entry in `syncnet-economies.json`; none is assumed (including $SYNC if it cannot claim a Passport).
- **Operator changes reset recognitions.** After a Marketplace transfer, earlier recognitions are inert until the new operator signs again.
- **Per-root event cap (500).** At the cap new recognitions pause; revoking a current recognition always works. There is no compaction yet.
- **Inherited Marketplace race.** Curator authority reads the Marketplace Passport, which still has read-modify-write races in the Marketplace itself (out of scope for Economies, which only uses SADD).
