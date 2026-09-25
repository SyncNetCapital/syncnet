# SyncNet v2

V2 is organized around one simple product idea:

**Make SYNC a verb.**

Create a project. Choose what it syncs with. Each selected eligible token creates a market with the new project. SyncNet then makes those relationships visible as a network.

`SYNC` is the action. `$SYNC`, USDG and other eligible tokens are assets a creator can choose.

## V2.5 Final Release Candidate (`v2.5-rc`, 23 Sep 2026)

This is the build to deploy.

| Document | For |
|---|---|
| `FINAL_RELEASE_REPORT.md` | What changed, the tests, PAR assumptions, trust assumptions, limitations and the two launch gates |
| `FIRST_LIVE_LAUNCH_CHECKLIST.md` | Open this right before the first real launch |
| `AUDIT_FINDINGS_CLOSED.md` | Every audit finding (H1–L15): fix, test, verification level |
| `RECOVERY_GUIDE.md` | Lifecycle states, MY LAUNCHES / RECOVER, publishing, incidents |
| `docs/DEPLOYMENT.md` | Environment variables, the server-side rollout gate, smoke checks, rotation |
| `docs/ARCHITECTURE.md`, `docs/REGISTRY.md`, `docs/REGISTRY_PROOF_SCHEMA.json`, `docs/KNOWN_LIMITATIONS.md` | How it works |

Key properties:

- The launcher is generic. No project, ticker or market is built in.
- The only transaction SyncNet requests is the PAR launch. It never requests token approvals.
- Every launch is recorded before the wallet is asked, and recovered from the chain afterwards.
- Public live launching, public uploads and registry submissions stay **off** until they are enabled server-side (`docs/DEPLOYMENT.md`).
- Run every test suite with `node tests/run-all.mjs`. It needs Node ≥ 20, Python 3 and Playwright with Chromium. Nothing touches a real network.

## Primary pages

- `/` — thesis: create, choose, sync.
- `/build.html` — simplified 4-step multi-market builder.
- `/network.html` — Explore: search a contract and map its token topology.
- `/registry.html` — public catalog of projects with recorded SyncNet provenance.
- `/token/<contract>` — individual token context page.
- `/sync.html` — $SYNC-specific markets, supply and distribution data.

- `/marketplace.html` — Project Marketplace V1: real, signed, server-persisted listings/offers/operator transfers (non-custodial, manual settlement). See `RELEASE_REPORT.md` and `MARKETPLACE_SECURITY.md`.

Secondary product experiments stay out of the primary navigation:
- `/labs.html` — experiments, currently SYNC Duel practice.

## Token topology

Explore accepts any valid Robinhood Chain contract address and builds a source-based relationship map from PAR launch/indexer data:

- what the token itself is synced with,
- which recent projects are synced directly with that token,
- which nearby projects share one of the same direct connections ("same branch").

The map describes observable economic relationships. It does not infer endorsement or official affiliation, and it is limited by the current indexer window.

## Attention Radar

Explore also includes a source-first Attention Radar. The current build opens:
- Google Trends,
- X live search,
- Google News.

It intentionally does **not** fabricate an attention score. A direct Google Trends chart can be added when API access is available.

## Builder

The builder accepts between 1 and 5 quote assets. $SYNC and USDG are presets; another Robinhood Chain token can be added if PAR's quote pricer accepts it. V2 constructs the exact `pairTokens[]` array and runs a PAR `eth_call` simulation.

**Default V2 remains simulation-first.** A guarded live test live-launch path is now available only when the builder URL includes an operator-gated live-test mode. It reuses the exact successfully simulated calldata and requires an IPFS-pinned image, metadata preflight, connected wallet and exact ticker confirmation before requesting `eth_sendTransaction`.

The creator chooses one of PAR’s four fee destinations at launch — fees to holders (HolderVault), creator/operator wallet, buyback & burn (BurnVault) or price floor (FloorVault). SyncNet preselects none. Pairing creates the market; fee routing is a separate mechanism and any distribution depends on actual activity.


### Launch clarity patch
The homepage now exposes the same contract mapper used by Explore. Token discovery now pages the current PAR launch history (with a disclosed 200-record emergency fallback) and uses first-degree neighbour discovery with common hubs dampened. Profile provenance labels describe SyncNet metadata state only and never imply endorsement or affiliation. No audio or background music is included.

## V2 launch candidate fixes — 22 September 2026

### Builder compatibility fix
The vendored viem browser bundle is intentionally minimal and does not export `getAddress()`. The earlier V2 builder called that missing export after a token passed contract and priceability checks, producing `v.getAddress is not a function` and preventing assets from being added. The builder now lower-case normalizes already-regex-validated addresses locally before using them.

### SYNC DUEL restored
`/labs.html` again contains the original full walletless SYNC DUEL rather than the stripped-down V2 practice-only replacement:
- Practice against a deterministic ghost.
- Real Duel via a shareable URL carrying the same deterministic five-round seed.
- Local browser record and off-chain, non-transferable SYNC XP.
- No wallet, blockchain calls, stake, payment, prize, token transfer, or redeemable reward.

### Marketplace boundary
As of V2.5 the Marketplace is a real product (Marketplace V1): live PAR projects only, listed by their recognised operator, with signed persistent records and non-custodial manual settlement. What can change hands is only the operational layer and the rights that are actually transferable:

A standard PAR launch cannot be deployed and then kept unbuyable: PAR creates ordinary Uniswap v4 markets that are tradable from the first block. Fee rights depend on the chosen destination: a wallet recipient can transfer the creator-fee right on-chain (`transferCreatorFeeRecipient`); the holder, burn and floor vaults cannot, so those rights cannot follow a future operator. The token contract itself has no owner in every mode. PAR’s factory owner keeps a 3-day-timelocked override over any recipient.


## Project Registry — 22 September 2026

V2 now separates **discovery** from **provenance**. `/registry.html` renders every project record carrying SyncNet provenance from `syncnet-projects.json`; the same record is surfaced in Explore topology and `/token/<contract>`. SYNCAT is backfilled as `SYNCNET-001 · SYNCNET ORIGIN`. This record does not imply CASHCAT affiliation.

Simulations do not enter the public Registry. Guarded live test live launches store a local proof after transaction confirmation and metadata verification; the production public Registry should register a project only after confirmed launch provenance and operator proof. See `docs/REGISTRY.md`.


## V2 launch cleanup

- Public beta SyncNet network fee is **$0 for every connection set**. $SYNC is optional and should be selected only when its market relationship is intentional. No $10 buy-and-burn policy is active in this build.
- Explore/Home now accept **name, ticker, or contract**. Name/ticker matching searches the SyncNet Registry plus the current capped PAR discovery window; a full contract still performs a direct lookup.
- Auto-detected relationships are labeled **INDEXED FROM CHAIN**, not “discovered by SyncNet.” This is market data, not provenance or endorsement.
- `/project/<contract>` is now the canonical project-context URL (with `/token/<contract>` retained as a compatibility alias).
- `SYNCNET ORIGIN · #001` is explicitly defined as foundational provenance recorded before the V2 live launcher; it is not evidence of a launch through the current V2 builder.
- Marketplace was a research preview at the V2 core launch; since V2.5 it is the real Marketplace V1 (see “Marketplace V1” below). Attention tools are collapsed and source-first.

### Still not implemented in this static beta
A persistent historical graph indexer and wallet-signed automatic Registry provenance require backend/live-launch infrastructure. The UI continues to disclose the capped recent PAR discovery window rather than claiming exhaustive history.


Search note: name/ticker discovery now searches Registry records, PAR-launched token metadata and quote-side assets observed in indexed markets. Address lookup remains the authoritative path until the persistent graph indexer is deployed.


## Guarded live test live-launch setup — 22 September 2026 (historical; superseded by `FIRST_LIVE_LAUNCH_CHECKLIST.md` and `docs/DEPLOYMENT.md`)

This build is intended to let the owner perform one real launch of their chosen project before enabling public launch execution.

### Netlify environment variables

Set these in the private/unlisted Netlify site before testing:

- `PINATA_JWT` — server-side Pinata JWT used only by the Netlify Function that pins the project image to public IPFS.
- `SYNCNET_UPLOAD_KEY` — server-side secret that signs short-lived upload sessions issued by the founder unlock; never entered in the UI.
- `SYNCNET_PUBLIC_UPLOADS` — optional; `true` opens **wallet-signed** uploads, and only when Upstash, `PINATA_JWT` and a ≥ 32-character `SYNCNET_UPLOAD_KEY` are configured. Anonymous uploads no longer exist.
- `SYNCNET_CANARY_KEY` — separate operator key required before this deployment reveals real-launch controls.

Never put the Pinata JWT in browser JavaScript.

### Test flow

1. Deploy the ZIP to the private/unlisted Netlify site.
2. Open the operator test Build route and unlock it with `SYNCNET_CANARY_KEY`.
3. Upload the final project image and press **UPLOAD TO IPFS**. The builder must show an immutable `ipfs://...` URI.
4. Fill the project metadata and choose the intended connections.
5. Run **RUN LAUNCH SIMULATION**. This still sends nothing.
6. Confirm that simulation and metadata preflight both pass and that the exact on-chain image URI is shown in Review.
7. Type the exact ticker in the guarded live test confirmation field.
8. Press **LAUNCH LIVE** and approve the wallet transaction only after reviewing the wallet request.
9. The UI waits for a receipt, verifies token bytecode and immutable metadata on-chain, polls PAR’s indexer, and stores a local launch proof in the browser Registry.

The live launch is irreversible and the PAR token becomes tradable from the first block. If a transaction hash is produced and a later UI check fails, inspect that transaction on Blockscout before retrying.

## Marketplace V1 — 24 September 2026
The front-end prototype (“Marketplace Lab”, browser-local test listings) is gone. `/marketplace.html` is now **Marketplace V1**:

- **Real persistent records.** Listings, offers, operator claims, transfers and deals live server-side (`/api/marketplace`, Upstash) and are visible from any browser. Nothing marketplace-related is stored in `localStorage`.
- **Signature-only authentication.** Every record is an EIP-712 typed signature (domain `SyncNet Marketplace` v1, chainId 4663), verified server-side (ECDSA + EIP-1271). Never a transaction, never a token approval.
- **Conservative claims.** A project can be claimed only by its on-chain deployer, its current transferable creator-fee recipient wallet, or the already-recognised operator — checked live against the PAR factory record.
- **Two-party operator transfer.** Seller signs an intent, buyer signs the acceptance; the Project Passport history is append-only (prior operators are never deleted).
- **Non-custodial settlement.** SyncNet never holds funds and provides no escrow. ETH payments are plain wallet-to-wallet transfers verified from the chain; the creator-fee right moves only via PAR’s own `transferCreatorFeeRecipient`, verified by re-reading the chain; off-chain items are confirmed by both parties. A deal is COMPLETED only when both parties sign the exact final checklist state.

Details: `RELEASE_REPORT.md`, `MARKETPLACE_SECURITY.md`, `MARKETPLACE_DEPLOY_CHECKLIST.md`.


## V2.3 additions
- `/kit.html` — Project Kit: prompts for the creator's own AI, Netlify Drop guide, `syncnet.json` site declaration.
- `/project/<token>` — Project Passport panel (on-chain operator/fee-beneficiary facts, website link check).
- `netlify/functions/site-check.js` → `/api/site-check` (SSRF-guarded read of `https://<site>/syncnet.json`).
- Founder rehearsal on a local fork: `docs/REHEARSAL.md`.
