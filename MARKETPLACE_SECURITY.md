# SyncNet Marketplace V1 — security model

Everything the Marketplace stores is a **wallet-signed record verified server-side**. SyncNet holds no funds, deploys no contracts, requests no approvals, and never marks anything verified that it did not verify itself. This document is the reference for the signature schemas, replay rules, state machines and trust boundaries.

## 1. Authentication: EIP-712 signatures only

Every write to `/api/marketplace` carries one EIP-712 typed signature (`eth_signTypedData_v4`).

- **Domain** (pinned in `lib/syncnet-market.js`, shared verbatim by page and server):
  `{ name: "SyncNet Marketplace", version: "1", chainId: 4663 }` — no `verifyingContract` (there is no contract; these records are off-chain).
- **Never** a transaction, gas, `approve`, `permit`, or `personal_sign`. If a wallet shows gas for a listing signature, something is wrong — the UI says so.
- Verification: ECDSA recovery first; if the signer address holds contract code (and is not an EIP-7702 delegation), **EIP-1271** `isValidSignature` via `eth_call`. Contract wallets can therefore claim, list and settle.
- The server **rebuilds every message from named fields**. Extra body fields are ignored, so nothing unsigned can ride along.

### Typed structures

| Structure | Fields | Signed by |
|---|---|---|
| `OperatorClaim` | token, operator, basis (string), nonce (bytes32), expiry (uint256) | claiming wallet |
| `Listing` | token, seller, price (string), currency (string), termsHash (bytes32), nonce, expiry | operator |
| `ListingCancel` | listingId (bytes32), seller, nonce | seller |
| `Offer` | listingId, termsHash, token, buyer, amount (string), currency, nonce, expiry | buyer |
| `OfferDecision` | offerId, listingId, seller, decision (string), nonce | seller |
| `TransferIntent` | dealId, token, from, to, nonce, expiry | seller (current operator) |
| `TransferAccept` | dealId, token, from, to, intentHash (bytes32), nonce, expiry | buyer |
| `DealConfirm` | dealId, wallet, role (string), item (string), stateHash (bytes32), nonce | either party |
| `DealCancel` | dealId, wallet, reason (string), nonce | either party |

Notes on binding:

- Every structure binds the **token and/or the specific record id**, so a signature for one project or deal can never act on another. The chain is bound by the domain (`chainId 4663`).
- `Offer.termsHash` binds the offer to the exact listing terms the buyer saw; if the terms differ at acceptance time, the server refuses (`terms_changed`).
- `TransferAccept.intentHash` binds the buyer's acceptance to the seller's exact signed intent digest — the two-party handover cannot be spliced from unrelated signatures.
- `DealConfirm.stateHash` for `item: "complete"` must equal the server's current checklist hash; any change to the deal after review makes the completion signature unusable (`stale_state`).

## 2. Replay protection (two independent layers)

1. **Deterministic IDs**: a record's id **is** its EIP-712 digest. Re-submitting the same signed payload maps to the same id and is refused as a duplicate (`409`). There is nothing to replay into a second record.
2. **Per-wallet nonces**: every structure carries a client-random `bytes32` nonce; the server consumes `wallet+nonce` (single use, 90-day retention) after signature verification. A captured payload cannot be replayed even across record types.

Expiries are signed and enforced server-side with hard caps: claim ≤ 1 h, listing ≤ 90 d, offer ≤ 30 d, transfer intent/accept ≤ 7 d. Expired records refuse action and render as EXPIRED.

## 3. Claim rules (who may sell a project)

A Project Passport (recognised-operator record) is created or refreshed only when the signing wallet **proves an on-chain relationship, read live from the PAR factory record on Robinhood Chain** — never from client-supplied facts:

- the token's **deployer**, or
- the **current creator-fee recipient**, when that recipient is a plain wallet (EOA or 7702-delegated) — a PAR vault or unknown contract recipient gives no claim, or
- the **already-recognised operator** (refresh).

**Passport authority.**

| Situation | Who may claim | Result |
|---|---|---|
| No Passport yet | the on-chain **deployer**, or the **current creator-fee recipient** if it is a directly controlled wallet | the first Passport is established |
| Passport exists | **only its recognised operator** (any evidence basis) | refresh; operator unchanged |
| Passport exists, any other wallet (deployer, current or new fee recipient, anyone) | nobody | `409 operator_exists`, nothing written, nonce not consumed |

Once a Passport exists, its operator changes **only** through the signed Marketplace transfer (seller `TransferIntent` +
buyer `TransferAccept`). The creator-fee right and operational control are separate: keeping, receiving or transferring the
fee right never moves the Passport. A buyer who buys only the Passport stays operator even though the seller keeps the fee
right; this also holds between the Passport transfer and an included fee-right transfer in an open deal. A recovery/dispute
mechanism, if ever needed, will be designed separately.

*Retired rule (security fix).* Previously, a wallet proving it was the current fee recipient could supersede a different
recorded operator (`operator-superseded`), which let a seller who sold only the Passport take it back. No code path writes
such entries anymore. Existing ones stay in the append-only history unchanged (records are never rewritten); the public view
annotates them `legacy: true` with a note that they grant no authority.

A token that is not a PAR launch cannot be claimed at all (`not_par`). Claims prove **control of a wallet**, not the quality of a project — the UI says exactly that.

## 4. Listings and offers

- Only the recognised operator can list (`not_operator` otherwise), and only with a fresh live PAR read succeeding.
- `terms` are normalised and bounded (description 10–2000 chars, ≤ 20 included / ≤ 20 excluded items, labels ≤ 140 chars); `termsHash` is the keccak-256 of the canonical (sorted-key) JSON. What is **not** sold is part of the signed terms.
- `includeFeeRight: true` is refused (`fee_right`, 422) unless the **live** chain shows the recipient is a transferable wallet **and** it is the seller. A vault or contract recipient can never be listed as transferable — the UI locks the checkbox and labels it truthfully (`NOT TRANSFERABLE`, `REQUIRES MANUAL VERIFICATION`).
- Prices/amounts: positive decimal strings, ≤ 18 decimals, ≤ 1e9; currencies `ETH | USDG | USD | EUR`. Only ETH is verifiable on-chain; the others are labelled "settled outside SyncNet".
- One ACTIVE listing per token; a buyer cannot offer on their own listing; accepting one offer supersedes all other pending offers on that listing atomically.
- Public reads never include signatures or nonces of other parties beyond what the record's proof requires (listings expose terms and status, not raw offer signatures).

## 5. Deal settlement (state machines)

```
Listing: ACTIVE → OFFER_ACCEPTED → (IN_TRANSFER) → COMPLETED
              ↘ CANCELLED / EXPIRED
Offer:   PENDING → ACCEPTED | REJECTED | SUPERSEDED | DEAL_CANCELLED | EXPIRED
Deal:    OPEN → COMPLETED | CANCELLED
```

A deal's checklist is fixed at acceptance from the signed terms:

| Step | Verified by |
|---|---|
| Operator transfer (Passport) | two signatures — seller `TransferIntent` + buyer `TransferAccept` binding `intentHash`; history append-only |
| Creator-fee right (if included) | the server **re-reads the PAR factory**: the on-chain recipient must equal the buyer. The transaction hash alone proves nothing and is stored only as reference |
| Payment in ETH | the server reads the transaction on-chain: mined, succeeded, `from` = buyer wallet, `to` = seller wallet, `value` ≥ price; each payment tx hash is single-use across all deals |
| Payment in USDG/USD/EUR | not verifiable by SyncNet — labelled so; requires both parties' `DealConfirm(item:"payment")` |
| Each MANUAL / OFF-CHAIN item | both parties' `DealConfirm` signatures, one per item |
| Completion | both parties sign `DealConfirm(item:"complete", stateHash)` over the **exact final checklist state**; all steps must already be done |

Cancellation (`DealCancel`, either party, reason recorded): offers become `DEAL_CANCELLED`; the listing reopens to ACTIVE **only if the operator transfer has not happened** — a completed transfer is never unwound by a cancellation.

**Non-custodial, by design**: SyncNet never holds or forwards funds and provides no escrow, so payment and delivery are not atomic. The "Pay seller" button builds a **plain value transfer** (`to` = seller wallet, exact price, `data: 0x`) that the buyer reviews and sends in their own wallet; the fee-right button builds **PAR's own** `transferCreatorFeeRecipient(token, buyer)` to the PAR factory, sendable only by the current on-chain recipient. Both are optional conveniences — the same evidence can be verified from any externally sent transaction hash.

## 6. Abuse resistance

- **Rate limits** (durable, per fixed window): reads 120/min/IP; writes 20/min + 200/h per IP and 120/h per wallet. Store outage = **fail closed** with an honest `503 unavailable` (never "too many requests", never fake data).
- **Kill switch**: `SYNCNET_MARKETPLACE_DISABLED=true` closes every write and reads answer `enabled:false`. No durable store → same fail-closed behaviour.
- **Input hygiene**: strict schema validation on every field (addresses, bytes32, decimal strings, enum values, byte-bounded text), request bodies capped at 32 KB, all rendered text HTML-escaped and passed through the display sanitiser (bidi/zero-width/control characters rejected).
- **Error hygiene**: upstream/internal error text never reaches clients (fixed public messages + hashed log ids); responses carry `nosniff` and a deny-all CSP.
- **No approval phishing surface**: the marketplace never requests `approve`/`permit`/`eth_sign`; the static audit enforces that the only two `eth_sendTransaction` calls in the marketplace client are the plain seller payment and PAR's fee transfer.

## 7. Trust assumptions (stated, not hidden)

1. **Robinhood Chain RPC** answers honestly for live reads (same assumption as the launcher; `SYNCNET_RPC_URL` can pin a private RPC).
2. **The durable store (Upstash)** preserves records; if it lies or loses data, records disappear but nothing can be forged (every record is wallet-signed).
3. **Off-chain items depend on the counterparty.** SyncNet verifies signatures and chain facts; it cannot verify a domain handover or a Discord admin transfer, and the UI labels every such item MANUAL / OFF-CHAIN.
4. **The Passport is a SyncNet record**, not an on-chain right. It confers no power the underlying contracts do not provide, and the pages say so.
5. **X accounts are never represented as transferable.**
