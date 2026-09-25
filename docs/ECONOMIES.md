# SyncNet Economies V0

An **Economy** is a view over existing PAR market data, not a stored object.

| Concept | Source | Stored? |
|---|---|---|
| Economy of root `R` | Every PAR launch with a market whose `pairToken == R`, matched by **contract address** (never ticker). Any address can be opened. | No — derived in the browser from `/api/par-launches-all` (`SyncNetEconomy.childrenOf`). |
| CONNECTED | The on-chain PAR market relationship (indexer view). | No. |
| Curator of `R` | 1) the Project Passport operator (`mp:passport:v1:R`, **read only**); else 2) a reviewed entry in `syncnet-economies.json`; else none. | No new state. |
| PARENT-RECOGNIZED | The latest signed decision of the **current** curator for that child is `recognize`. | `eco:cur:v1:<R>` — one append-only Redis SET. |
| Curator request | Signed request for a root that is not a PAR launch and has no curator. **Grants nothing.** | `eco:req:v1:<R>` — one append-only Redis SET. |

There is no "active" Economy state, no stored child list, no `officialChildren[]`, no ranking of Economies,
no volume/TVL/fee aggregate, and no recursive graph.

## Files

- `lib/syncnet-economy.js` — shared browser/server schema: EIP-712 domain + types, validation, canonical members, the fold, derived membership, labels.
- `netlify/functions/economies.js` — `GET/POST /api/economies`.
- `syncnet-economies.json` — manual curator grants (ships empty; changes go through code review).
- `economy.html`, `economy-v2.js` — `/economy.html?root=0x…` (also `/economy?root=0x…`).
- Rollout gate in `netlify/lib/flags.js`: `economyCuration`.

## EIP-712

```
domain: { name: "SyncNet Economies", version: "1", chainId: 4663 }        (not the Marketplace domain)

EconomyCuration(address root, address child, address curator, string decision, uint256 issuedAt, bytes32 nonce)
  decision ∈ { "recognize", "revoke" }
EconomyClaimRequest(address root, address claimant, string evidenceUrl, uint256 issuedAt, bytes32 nonce)
```

`issuedAt` must be within ±300 s of the server clock when submitted. The event ID is the EIP-712 digest.

## Storage and the absence of read-modify-write

A stored member is the canonical JSON (sorted keys) of `{v:1, kind, id, ...message, signature}` — nothing
server-generated — so resubmitting the same signed event is the same member and `SADD` returns 0.

The only Economies write is `SADD`, which is atomic. The current state is computed at read time:

1. Parse each member; drop anything malformed or whose `id` is not the digest of its own fields.
2. Keep events whose `curator` is the **current** curator and whose `issuedAt + 300 ≥ since` (start of the
   current curatorship: `passport.operatorSince`, or the grant's `since`).
3. Per child, the event with the highest `(issuedAt, id)` wins; `recognize` → PARENT-RECOGNIZED.

Because the result depends only on the set's contents and signed fields, concurrent writes cannot lose each
other and replaying an old signed event cannot override a newer one. **No new store primitive was needed**
(`store.js` is unchanged). The two check-then-act steps on the write path — the "stale" rejection and the
soft cap — only decide whether an event is accepted; they cannot corrupt the fold.

### Soft cap

`MAX_EVENTS_PER_ROOT = 500`. Below the cap, every non-stale event is stored, so the fold always equals the
curator's latest signed intent regardless of arrival order. At the cap, new recognitions and no-op revokes are
refused, but **a revoke that removes a current recognition is always accepted**. Each such revoke needs a
recognition stored before the cap, so the set stays bounded (~2× the cap). Reaching the cap permanently pauses
new recognitions for that root until a compaction mechanism exists (see limitations).

## Write rules (`POST /api/economies`)

`curate`: gate open → IP rate limits (20/min + 200/h) → body ≤ 8 KB → field validation, `root ≠ child`
→ `issuedAt` skew → resolve curator (none: 403) → `curator` must equal it (403) → signed within the current
curatorship (409) → signature (ECDSA, or EIP-1271 by live chain call) (401) → **wallet limit (120/h, charged only now)** → stale check (409) → cap →
for `recognize`: live `readLaunch(child)` + `readMarkets(child)` must include `R` (422; chain down 503) → `SADD`.

`claim-request`: gate → IP rate limit (5/h) → validation (https evidence URL ≤ 200 chars) → the
root must have no curator (409), must NOT be a PAR launch (409 — PAR roots use the Passport claim), must be a
contract (422) → signature → wallet limit (120/h) → global verified-claim limit (50/h) → per-root cap 20 → `SADD`. Status `PENDING`; approval is a reviewed
commit to `syncnet-economies.json`.

**Pending requests are private.** The claimant, evidence URL and signature are never served over HTTP and never
shown in the UI. V0 has no maintainer-authenticated read endpoint (and does not add an admin auth system), so
maintainers inspect `eco:req:v1:<root>` directly in the durable store (Upstash console / `SMEMBERS`).

**Rate-limit ordering.** Before any signature is checked, only per-IP limits apply. The per-wallet `eco-wallet`
bucket and the global `eco-claim-all` bucket are charged only after the signature has verified, so a request that
merely names someone else's address (e.g. the public curator) cannot exhaust their bucket, and invalid claim
requests from many IPs cannot exhaust the global claim budget.

## Display rules

- CONNECTED · ON-CHAIN PAR MARKET — the child is in the current indexer data with a market paired with `R`.
- PARENT-RECOGNIZED + "RECOGNIZED BY $R OPERATOR" (or "CURATOR" for a manual grant) — never "OFFICIAL".
- A recognized child missing from the current indexer data keeps PARENT-RECOGNIZED (its connection was verified
  on-chain when recorded; PAR markets are immutable) but is labelled
  **CONNECTION PREVIOUSLY VERIFIED · OUTSIDE CURRENT INDEX WINDOW** (or **… · INDEXER UNAVAILABLE**), never CONNECTED.
- "Create a project in the $R Economy" is only `/build.html?with=<R>` (the Builder's existing prefill).
- A root whose ticker matches a canonical asset but whose address does not is flagged as not canonical.

## Security model

- Authority never comes from client input: curator = Passport operator (Marketplace evidence rules) or a reviewed
  file entry; relationship = live chain read. No ticker, no `owner()`, no body field is trusted.
- Recognition is one-sided: SyncNet does not endorse, and the child has not necessarily agreed.
- Operator changes (Marketplace transfer or fee-recipient supersession) make every earlier recognition inert.
- Separate EIP-712 domain: signatures cannot be replayed between Marketplace and Economies.
- Fail closed: writes need `SYNCNET_ECONOMY_CURATION=true` and a durable store and no `SYNCNET_ECONOMIES_DISABLED`;
  limiter/store outages → 503 with fixed messages.
- Namespace: Economies writes only `eco:cur:v1:*`, `eco:req:v1:*` (and `rl:eco-*` counters); it reads `mp:passport:v1:*`.
- Non-custodial: signatures only; no transaction, approval, launch or send path is touched.

## Known limitations

- **Inherited Marketplace race.** Economies trusts `passport.operator`. The Marketplace still has
  read-modify-write races (`consumeNonce` GET→SET; Passport updates). Every writer there already needs chain
  evidence or a signed transfer, so a lost update chooses between evidenced operators; fixing it needs a
  Marketplace change (minimal primitive: `SET NX EX`) and is out of scope.
- **Indexer window.** `/api/par-launches-all` covers at most 5,000 launches; older children are not discovered
  (the page states the coverage).
- **Cap exhaustion** pauses new recognitions for a root; a future compaction (e.g. a signed snapshot) is needed.
- **Unclaimed roots.** A root with no Passport and no reviewed grant (possibly $SYNC) stays UNCLAIMED until the
  correct curator wallet is confirmed and committed. Nothing is hard-coded.
- **Child acknowledgement** (bilateral relationships) is deferred to V1.1.
- The EIP-6963 wallet chooser is a third copy (Builder, Marketplace, Economy) to avoid editing the Marketplace client.
