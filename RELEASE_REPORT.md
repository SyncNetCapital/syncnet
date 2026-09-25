# SyncNet V2.5 — Marketplace V1 + IPFS display release report

**Release:** `v2.5-marketplace-v1` · 24 September 2026
**Baseline:** `syncnet_v2.5_FINAL_RELEASE_CANDIDATE_IPFS_HOTFIX 2.zip` (sha256 `2a00f385…`) — the exact build that launched PONSYNC.
**Non-regression:** the launch engine is byte-identical. `launch-engine-v2.js`, `launch-records.js`, `launches-v2.js`, `lib/syncnet-core.js`, `lib/syncnet-chain.js`, `vendor/viem.js` and every launch/guard/registry/upload function have **zero diff** against the baseline. In `builder-v2.js` only the two logo-display functions changed; calldata, salts, simulation, signatures, gates and recovery paths are untouched and re-proven by the full battery (206/206 regressions, 297/297 e2e, 0 launch-PoCs reproduced).

## What this release does

1. **Fixes IPFS image display everywhere** with one canonical utility.
2. **Replaces the Marketplace prototype with Marketplace V1** — real, signed, persistent, non-custodial.
3. **Removes every lab/test/simulated artifact** from production surfaces and makes all copy truthful.

## 1. IPFS display (`lib/syncnet-ipfs.js`)

- One renderer used by the token page, Registry, map, Marketplace, builder preview, final review and kit: strict `ipfs://<CID>[/path]` parsing → display via **gateway.pinata.cloud → ipfs.io → dweb.link**, automatic per-image fallback on error, then a deterministic SVG placeholder (seeded by the CID — same placeholder every time, no broken-image icons).
- **Stored metadata is never rewritten**: drafts, intents, calldata, records, registry entries and marketplace snapshots keep the immutable `ipfs://` URI; gateway URLs exist only in `<img src>` at render time. Regression-tested against the live PONSYNC CID, including malicious-URI non-transformation (`javascript:`, `data:`, traversal, query injection, attribute breakout).

## 2. Marketplace V1

### Architecture

| Piece | Role |
|---|---|
| `lib/syncnet-market.js` | Canonical EIP-712 schema (domain `SyncNet Marketplace` · `1` · chainId `4663`), typed structures, canonical-JSON hashing, terms/amount/expiry bounds — the same file runs in the page and in the function, so client and server can never disagree about what was signed. |
| `netlify/functions/marketplace.js` → `/api/marketplace` | The only write path. Verifies every signature server-side (ECDSA + EIP-1271), rebuilds messages from named fields, enforces nonces/expiries/status transitions, reads PAR facts **live from the chain** for claims, fee-right and payment verification. |
| `marketplace-v2.js` + `marketplace.html` | The product: browse/sell/offer/deal-room UI. Writes nothing to browser storage — every record comes from the server. |
| `v2-token.js` | Project pages now show the Project Passport: recognised operator, append-only operator history, for-sale status — labelled `SYNCNET OPERATOR VERIFIED`, never conflated with `PAR INDEXED`. |

### Persistence

Upstash Redis (the store the Registry and rate limits already use), keys `mp:*`: passports, listings (+index), offers, deals, single-use nonces, used payment txs. Record IDs are the EIP-712 digests themselves — deterministic, duplicate-proof. **No localStorage marketplace data exists anywhere.** Cross-browser persistence is proven by the walkthrough suite with two isolated browser contexts.

### Trust model (honest by construction)

- Signature-only auth; no transaction, gas, approval or permit is ever requested for marketplace records.
- Claims: deployer / current transferable fee-recipient wallet / recognised operator — all read live from the PAR factory.
- Project Passport = SyncNet's signed operator record (**not** an NFT, not an on-chain right); history is append-only, prior operators are never deleted.
- Non-custodial settlement: no funds held, no escrow, no custody contract. ETH payment = plain wallet-to-wallet transfer verified from the chain (`from`=buyer, `to`=seller, `value`≥price, tx single-use). Creator-fee right moves only through PAR's own `transferCreatorFeeRecipient`, verified by re-reading the on-chain recipient — a tx hash alone proves nothing.
- Everything SyncNet cannot verify is labelled `MANUAL / OFF-CHAIN` and needs both parties' signatures; a deal is COMPLETED only when both sign the exact final checklist state. X accounts are never represented as transferable.

Full schemas, replay rules and state machines: `MARKETPLACE_SECURITY.md`.

### API

`/api/marketplace` — GET views: `config`, `listings`, `listing`, `passport`, `deal`, `wallet`. POST actions: `claim`, `list`, `cancel-listing`, `offer`, `offer-decision`, `transfer-intent`, `transfer-accept`, `fee-right-evidence`, `payment-evidence`, `deal-confirm`, `deal-cancel`. Rate limits: 120 reads/min/IP; 20 writes/min + 200/h per IP, 120/h per wallet. Fail-closed: no durable store or kill switch → writes 503, reads `enabled:false`; store outage → honest `503 unavailable`.

## 3. Production copy

`MARKETPLACE LAB`, `LOCAL TEST LISTINGS`, `NO REAL PAYMENTS`, fake listings and simulated purchases are **deleted, not hidden** (no `?lab=1` mode remains — the prototype had no production value to preserve). An empty marketplace shows a polished empty state. Terms, Risk, Privacy, README, TESTING, ARCHITECTURE, KNOWN_LIMITATIONS and DEPLOYMENT now describe the real model; deliberately kept: honest safety copy (launch simulation, SYNC Duel's "SIMULATED MARKET PATH" practice label) and historical release/audit reports (marked as historical where they made present-tense claims).

## Environment variables

| Variable | Status | Effect |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **required for the Marketplace** (already required for Registry/limits) | durable store; without it the Marketplace fails closed |
| `SYNCNET_MARKETPLACE_DISABLED` | new, optional | `true` = kill switch (writes refuse, reads say `enabled:false`) |
| `SYNCNET_RPC_URL` | existing, optional | server-side live PAR reads |
| all other existing variables | unchanged | — |

**No secret values are included in this ZIP.** Verified: the packaged tree contains no `.env`, no key material and no live tokens; every secret is referenced by environment-variable name only.

## Tests (all run against this exact tree; `node tests/run-all.mjs`)

| Suite | Result |
|---|---|
| Static audit (incl. new marketplace/IPFS invariants) | PASS |
| Core unit (keccak, secp256k1, EIP-712, ABI, text policy) | 333/333 |
| Image sanitizer | 129/129 |
| Server infrastructure | 434/434 |
| Server endpoint abuse (RC) | 82/82 |
| `/api/ipfs-check` | 100/100 |
| **`/api/marketplace` abuse suite (new)** | **77/77** |
| Audit PoCs (engine / server / pages, incl. adapted F-P1 forged-fee-right attack) | 0 vulnerabilities reproduced (engine suite's 11 design-fact confirmations unchanged from baseline) |
| E2E product suites (marketplace suite rewritten for V1) | 297/297 |
| Required regressions R01–R28 (launch engine, PONSYNC flows) | 206/206 |
| **IPFS display (new, real PONSYNC CID end-to-end)** | **23/23** |
| **Marketplace walkthrough (new: two real browsers, claim → list → offer → deal → two-party transfer → on-chain fee right → wallet-to-wallet payment → both-party confirmations → COMPLETED → provenance; plus cancel/authz/stale/malformed/disconnect/account-change/RPC-down/storage-down/image-failure)** | **45/45** |
| Mobile 320/360/390/430 (new marketplace UI included) | 112/112 |

**ALL SUITES PASSED** — 1,838 individual product checks + 74 attack checks, plus the battery re-run from the extracted ZIP in a clean directory (see below).

## Known limitations (stated in-product where relevant)

- Payment and delivery are **not atomic** (no escrow by design). The deal room orders steps and verifies what a chain can prove; off-chain items rest on both-party confirmation and counterparty honesty.
- Only ETH payments are chain-verified; USDG/USD/EUR are labelled "settled outside SyncNet" and confirmed by both parties.
- The recognised-operator record is SyncNet-scoped: it cannot grant powers the underlying contracts do not provide, and PAR's factory owner retains its own timelocked recipient override (documented on-page).
- Listings require the durable store; a deployment without Upstash has a closed marketplace (by design, never fake data).
