# SyncNet V2 — Post-Claude hardening

This build merges the interactive Marketplace work with the validated canary patch and additional hardening derived from the adversarial review.

## Included

- stale-simulation race guard and draft-equality check before send
- fresh Robinhood Chain check at send time and explicit `chainId` in the wallet request
- immediate transaction-hash persistence, reload recovery, and a hard lock after any sent transaction
- second-launch guard for a previously attempted ticker
- IPFS upload fails closed when the private upload key is not configured
- still-image normalization to a square PNG up to 512 px, stripping normal EXIF/GPS metadata
- two-gateway metadata preflight
- full-history PAR discovery via paged server function instead of the old 200-launch window
- canonical/collision-aware search with bidi/zero-width sanitization
- honest SYNCAT origin copy and a canonical $SYNC Registry record
- browser-only launch proofs separated from public Registry records
- server-checked operator access gate for real-launch controls
- SyncNet launch-intent commitment embedded in the PAR salt
- wallet-signed launch intent (EIP-712 when supported, `personal_sign` fallback only when EIP-712 is unavailable)
- optional reason/intent per connection included in the commitment, not PAR token metadata
- post-launch PAR configuration verification when the indexer row is available
- Marketplace seller claims no longer render as verified; live PAR lookup can lock non-transferable fee-right rows
- salted local Sealed Project commitment with a retained local reveal for verification
- Marketplace acquisition sequence corrected so settlement does not depend on buyer launching later and operator/Passport settlement is last
- mobile overflow fixes, larger tap targets, key accessibility fixes, and hero performance reductions
- legal/privacy wording synchronized with the experimental/operator-test state

## Netlify environment variables

> Superseded by the V2.5 release candidate: see `docs/DEPLOYMENT.md` for the full table.

The main changes:

- There are no anonymous uploads any more. `SYNCNET_PUBLIC_UPLOADS=true` opens **wallet-signed** upload sessions, and only when Upstash is configured.
- Founder sessions last 2 h, not 4 h.
- Both SyncNet keys must be at least 32 characters.

- `PINATA_JWT`: a Pinata key scoped to `pinFileToIPFS`, used only by the server-side upload function.
- `SYNCNET_UPLOAD_KEY`: the server-side HMAC secret for upload sessions (≥ 32 characters). It is never typed into the UI. Uploads fail closed if it is missing.
- `SYNCNET_CANARY_KEY`: the operator key checked server-side before real-launch controls are shown (≥ 32 characters).
- `SYNCNET_PUBLIC_LAUNCH`, `SYNCNET_PUBLIC_UPLOADS`, `SYNCNET_REGISTRY_SUBMISSIONS`: the public rollout gate. Leave them unset for the first launch.

Use long random values for both SyncNet keys and rotate them after the first launch. An unlisted URL is not access control.

## First live launch

Follow `FIRST_LIVE_LAUNCH_CHECKLIST.md`. It works for any project: no project, ticker or market is built into the launcher. Summary:

1. Deploy, set the variables, and check `/api/config`.
2. Unlock with the operator key and upload the image.
3. Choose the markets **by contract address** and the fee destination on purpose.
4. Simulate. The PAR live preflight must show only ✓, and the duplicate check must pass.
5. Sign the launch intent (gas-free).
6. Read the immutable final review, tick "I UNDERSTAND THIS LAUNCH IS REAL AND IRREVERSIBLE." and type the ticker.
7. Confirm in the wallet only if the network, destination and value match the review.
8. Export the evidence. If anything goes wrong, never retry blindly: use MY LAUNCHES / RE-VERIFY (`RECOVERY_GUIDE.md`).

## Deliberately not implemented yet

- ~~a public server-backed/signed Registry database~~: done in the V2.5 RC as `/api/registry`. Every proof is verified on-chain, and the feature is gated by `SYNCNET_REGISTRY_SUBMISSIONS` + Upstash.
- ~~operator-history / Passport backend~~: done in Marketplace V1 as `/api/marketplace` (signed Project Passports with append-only history).
- ~~real Marketplace listings/offers/operator transfers~~: done in Marketplace V1 (signed, server-persisted, non-custodial). Escrow/custody remains deliberately NOT implemented.
- WalletConnect for mobile browsers outside wallet apps
- server-rendered canonical project pages / per-project OG images
- a dedicated long-term chain indexer and historical database (the current complete first-degree map is cached from PAR)

(Historical note: at the time of this report the Marketplace was an interactive product lab. Since Marketplace V1 — see `RELEASE_REPORT.md` — listings, offers, operator transfers and deal records are real, signed and server-persisted; settlement is non-custodial and SyncNet still executes no payment and holds no escrow.)
