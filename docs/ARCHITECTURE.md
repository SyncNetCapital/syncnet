# Architecture (V2.5 release candidate)

SyncNet is a static multi-page site on Netlify with a small set of Netlify Functions. There are no build step, no framework, no accounts and no server-side wallet. The CSP is `script-src 'self'`.

## Browser modules

| File | Role |
|---|---|
| `lib/syncnet-core.js` | Dependency-free primitives, also used by the functions: keccak-256, secp256k1 recovery, EIP-712 hashing, ABI encoding and decoding (including a full `launchToken` / `launchAndBuyWithEth` decoder), UTF-8 byte limits, NFC text policy (bidi, zero-width and control characters rejected), display sanitising, confusable skeletons. |
| `lib/syncnet-chain.js` | Robinhood Chain and PAR knowledge: canonical addresses, selectors, `readParState` + `parChecks` (the live PAR preflight), `readLaunch`/`readMarkets`, recipient safety (`recipientStaticCheck`, `classifyRecipient`), `verifyDeployment` (expected vs actual), `verifyEvidence` (public proof verification, EIP-1271 aware). |
| `lib/syncnet-provenance.js` | The six Registry statuses and operator claims. |
| `lib/syncnet-ipfs.js` | The one canonical IPFS display utility: strict `ipfs://` parsing, gateway order (gateway.pinata.cloud → ipfs.io → dweb.link), automatic per-image fallback, deterministic SVG placeholder. Stored metadata always stays `ipfs://` — gateways are display-only. |
| `lib/syncnet-market.js` | Marketplace EIP-712 schema (domain `SyncNet Marketplace` v1 · chainId 4663): typed structures for claims, listings, offers, transfers and deal confirmations, canonical JSON hashing, terms normalisation, amount/expiry bounds. Shared verbatim by the page and the server. |
| `netlify/functions/marketplace.js` | `/api/marketplace`: signature-verified persistent records (Upstash), live PAR reads for claim evidence and fee-right/payment verification, per-wallet nonces, server-enforced state machines, fail-closed without a durable store. |
| `launch-engine-v2.js` | `prepare()` builds the exact launch: normalized draft → intent record → recordHash → salt → calldata (viem, cross-checked by the core decoder) → `eth_call` + gas. It returns a deep-frozen P. `presendCheck()` re-reads PAR and re-simulates right before sending. |
| `launch-records.js` | Durable launch records: lifecycle states, merge-only history, cross-tab lock, import/export, `toProof()`, and `reverify()` (on-chain authoritative, indexer secondary). |
| `builder-v2.js` | The builder UI: wallet, simulation, duplicate/impersonation guard, signature binding (`signatureValidFor(P)`), the immutable final review, the send flow, and verification. |
| `launches-v2.js` | MY LAUNCHES / RECOVER A LAUNCH. |
| `v2-token.js`, `v2-registry.js`, `v2-network.js`, `marketplace-v2.js` | Project page (PAR-verified claims + Project Passport), Registry, map and search (canonical identity by address), Marketplace V1 (signed listings/offers/deal rooms against `/api/marketplace`). |

## Launch sequence

1. `prepare()` produces P, the only object that can be sent.
2. Guard and signature: the duplicate guard runs against local records, the chain and `/api/launch-guard`. The wallet signs `LaunchIntent(operator, token, recordHash, salt)`, and the signature is bound to `P.id`.
3. Final review: an immutable view generated from P, plus "I UNDERSTAND THIS LAUNCH IS REAL AND IRREVERSIBLE." and the typed ticker.
4. LAUNCH, in this order:
   - `const P = lastPrepared` is snapshotted, and the cross-tab lock is taken.
   - Wallet, account and chain checks.
   - The guard runs again.
   - `presendCheck` re-reads PAR and re-simulates.
   - The signature is re-verified.
   - A **durable record (BROADCAST_ATTEMPTED) is written and read back**.
   - `eth_sendTransaction(P.request)`.
5. After the wallet answers:
   - A hash → TX_HASH_RECEIVED, then receipt → MINED, then `verifyDeployment` → ONCHAIN_VERIFIED → INDEXER_PENDING / FULLY_VERIFIED.
   - A non-rejection error → BROADCAST_UNKNOWN, and the chain is watched for the predicted token.

The only transaction SyncNet ever requests is this launch, to the PAR multi factory or the PAR multi router. There are no approvals, permits or other contract calls. The static audit enforces this.

## Netlify Functions (`netlify/functions`, shared helpers in `netlify/lib`)

| Route | Purpose |
|---|---|
| `/api/config` | The effective server-side rollout gate (`flags.js`) and the build version. |
| `/api/canary-auth` | Founder unlock: HMAC-compared key, rate limits and lockouts, a 2 h scoped session. |
| `/api/upload-auth` | Wallet upload sessions: single-use HMAC challenge, `personal_sign` or EIP-1271, 30 min. Public gate only. |
| `/api/ipfs-upload` | Session-bound upload. Every image is decoded and re-encoded (`image-sanitize.js`) with metadata stripped, then pinned to Pinata plus an optional second pinning service. Quotas are enforced. |
| `/api/launch-guard` | Duplicate and impersonation check. Uses the PAR indexer (cached, single flight) and canonical identities (confusable skeleton). |
| `/api/registry` | The chain-verified public Registry (GET, and POST only when its gate is open). |
| `/api/site-check` | SSRF-safe read of `https://<site>/syncnet.json`: pinned DNS, blocked ranges, streamed 16 KiB cap. |
| `/api/par-launches-all`, `/api/par-tokenlist` | Cached, schema-validated PAR data. These are JSON only and never a proxy. |

Every function answers with fixed JSON messages, `nosniff`, and a CSP of `default-src 'none'`. Logs use hashed identifiers. Rate limits and quotas need Upstash to be durable. Every public feature stays closed without it.

## Concepts kept separate

- Market relationship ≠ provenance ≠ endorsement.
- Fee beneficiary ≠ operator.
- Browser-local evidence ≠ public proof.
