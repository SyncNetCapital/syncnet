# SyncNet Marketplace V1 — security model

Everything the Marketplace stores is a **wallet-signed record verified server-side**. SyncNet holds no funds, deploys no contracts, requests no approvals, and never marks anything verified that it did not verify itself. This document is the reference for the signature schemas, replay rules, state machines and trust boundaries.

## 0. Supported origin factories

The Marketplace is launchpad-agnostic. A project's **origin** is established only by a live read of that launchpad's
canonical factory on Robinhood Chain (chain 4663), in `lib/syncnet-origins.js`, shared by the browser and the server:

| Origin | Canonical factory | Record read | Status |
|---|---|---|---|
| **PAR** | `PairPadMultiLaunchFactory` `0x3ea29975a79900179F3e1aEF93347Ba4210c29C1`, then `PairPadLaunchFactory` `0x9d33Ba78389c8772bC114Cba47Dc1985E933e76F` | `getLaunchedToken(token)` (exists flag) | supported (unchanged) |
| **PONS V2** | `PonsV2LaunchFactory` `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` (ponsdotdev/pons-labs README, commit `162310f`; EIP-55 checksum verified) | `getLaunchedToken(token)` → 15-field `LaunchedToken`; accepted only if `exists == true` **and** `record.token == token`; plus `pendingCreatorFeeRecipient(token)` | supported |
| PONS V1 | `PonsLaunchFactory` `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | `getLaunchedToken(token)` (13 fields, `exists`) | **detected only** — "PONS V1 DETECTED · not enabled yet" |

- The origin is **server-derived** and stored on new Passports (`launchpad`) and listings (`origin`). It is never part of a
  signature and never taken from a request: a client-supplied `launchpad`/`origin`/`factory` field is ignored.
- Records written before multi-origin support have no such field; they are read as PAR (their recorded `factory` is a PAR
  factory). Nothing is migrated or rewritten; the EIP-712 domain and every signed structure are unchanged.
- **Fail closed**: `resolveProject` throws when any canonical factory cannot be read, so an RPC failure is a `503`, never
  "unsupported" and never a guessed origin. A token is "unsupported" only after every factory positively answered.
- A Passport is SyncNet-recognised operational control. For Pons it confers no Pons protocol control and no ownership of the
  token contract; SyncNet implies no partnership with or endorsement by any launchpad.

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

A Project Passport (recognised-operator record) is created or refreshed only when the signing wallet **proves an on-chain relationship, read live from the canonical factory record of the token's verified origin (PAR or Pons V2) on Robinhood Chain** — never from client-supplied facts:

- the token's **deployer**, or
- the **current creator-fee recipient**, when that recipient is a plain wallet (EOA or 7702-delegated) — a PAR vault or unknown contract recipient gives no claim, or
- the **already-recognised operator** (refresh).

Precedence and takeover: an existing operator blocks a deployer claim (`operator_exists`); only the current on-chain fee recipient can supersede a recorded operator, and that supersession is itself an append-only history entry (`operator-superseded`). A token that is not a supported launch cannot be claimed at all (`not_par`; a positively identified Pons V1 launch gets `unsupported_origin`). Evidence texts name the venue: PAR texts are unchanged ("wallet is the on-chain deployer (PAR factory record)"), Pons texts end in "(Pons V2 factory record)". Claims prove **control of a wallet**, not the quality of a project — the UI says exactly that.

## 4. Listings and offers

- Only the recognised operator can list (`not_operator` otherwise), and only with a fresh live read of the token's canonical factory succeeding.
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
| Creator-fee right (if included) | the server **re-reads the canonical factory of the token's origin** (PAR or Pons V2): the on-chain recipient must equal the buyer. For Pons V2 there must also be **no active pending protocol override** (see below). The transaction hash alone proves nothing and is stored only as reference |
| Payment in ETH | the server reads the transaction on-chain: mined, succeeded, `from` = buyer wallet, `to` = seller wallet, `value` ≥ price; each payment tx hash is single-use across all deals |
| Payment in USDG/USD/EUR | not verifiable by SyncNet — labelled so; requires both parties' `DealConfirm(item:"payment")` |
| Each MANUAL / OFF-CHAIN item | both parties' `DealConfirm` signatures, one per item |
| Completion | both parties sign `DealConfirm(item:"complete", stateHash)` over the **exact final checklist state**; all steps must already be done |

Cancellation (`DealCancel`, either party, reason recorded): offers become `DEAL_CANCELLED`; the listing reopens to ACTIVE **only if the operator transfer has not happened** — a completed transfer is never unwound by a cancellation.

**Non-custodial, by design**: SyncNet never holds or forwards funds and provides no escrow, so payment and delivery are not atomic. The "Pay seller" button builds a **plain value transfer** (`to` = seller wallet, exact price, `data: 0x`) that the buyer reviews and sends in their own wallet; the fee-right button builds the launchpad's own `transferCreatorFeeRecipient(token, buyer)` through a single validated builder (`SyncNetOrigins.feeTransferTx`): destination = the canonical factory of the token's **freshly re-read** origin (PAR single/multi factory, or the Pons V2 factory — nothing else is accepted), calldata bound to the exact deal token and buyer, value 0. It is sendable only by the current on-chain recipient. Both are optional conveniences — the same evidence can be verified from any externally sent transaction hash.

### Creator-fee right: classification and routes

| Recipient (live) | Classification | Can be included in a listing |
|---|---|---|
| PAR holders/burn/floor vault | `vault` · NOT TRANSFERABLE | no |
| contract / unreadable | `contract` / `unknown` · REQUIRES MANUAL VERIFICATION | no |
| Pons V2 wallet recipient with an **active pending protocol override** | `encumbered` · ENCUMBERED | no |
| wallet (EOA or EIP-7702 account) | `wallet` · CREATOR FEE TRANSFERABLE | yes, only by that wallet |

| Origin | Transfer call | Sent to | Verified by |
|---|---|---|---|
| PAR | `transferCreatorFeeRecipient(token, buyer)` | the PAR factory that recorded the launch | re-read `getLaunchedToken`: `creatorFeeRecipient == buyer` |
| Pons V2 | `transferCreatorFeeRecipient(token, buyer)` (only `msg.sender == creatorFeeRecipient`, any phase) | `PonsV2LaunchFactory` | re-read `getLaunchedToken`: `creatorFeeRecipient == buyer` **and** no active `pendingCreatorFeeRecipient` |

**Pons V2 pending override.** The Pons V2 factory owner can propose `setCreatorFeeRecipient(token, x)`: a 3-day timelock, then
a 3-day window in which anyone can execute it, and — per the Pons source — "a matured proposal takes precedence over any
creator transfer made while it was pending". A creator's `transferCreatorFeeRecipient` does not cancel it. SyncNet therefore
treats a Pons fee right as **encumbered** while a proposal exists that can still execute (not yet expired; unreadable answers
count as pending): the fee right cannot be included in a listing, the Deal Room refuses to send the transfer, and the server
refuses to mark the fee-right step verified even when the buyer is already the recipient. Listings without the fee right are
unaffected.

**PAR has the same owner power** (`setCreatorFeeRecipient` with a timelock on the PAR factories). The Marketplace does not read
it for PAR today; this release documents it and deliberately does not change PAR behaviour. Recommended follow-up: apply the same
`encumbered` rule to PAR after review.

## 6. Abuse resistance

- **Rate limits** (durable, per fixed window): reads 120/min/IP; writes 20/min + 200/h per IP and 120/h per wallet. Store outage = **fail closed** with an honest `503 unavailable` (never "too many requests", never fake data).
- **Kill switch**: `SYNCNET_MARKETPLACE_DISABLED=true` closes every write and reads answer `enabled:false`. No durable store → same fail-closed behaviour.
- **Input hygiene**: strict schema validation on every field (addresses, bytes32, decimal strings, enum values, byte-bounded text), request bodies capped at 32 KB, all rendered text HTML-escaped and passed through the display sanitiser (bidi/zero-width/control characters rejected).
- **Error hygiene**: upstream/internal error text never reaches clients (fixed public messages + hashed log ids); responses carry `nosniff` and a deny-all CSP.
- **No approval phishing surface**: the marketplace never requests `approve`/`permit`/`eth_sign`; the static audit enforces that the only two `eth_sendTransaction` calls in the marketplace client are the plain seller payment and the launchpad fee transfer from `feeTransferTx`, whose destination whitelist is exactly the canonical PAR and Pons V2 factories.

## 7. Trust assumptions (stated, not hidden)

1. **Robinhood Chain RPC** answers honestly for live reads (same assumption as the launcher; `SYNCNET_RPC_URL` can pin a private RPC).
2. **The durable store (Upstash)** preserves records; if it lies or loses data, records disappear but nothing can be forged (every record is wallet-signed).
3. **Off-chain items depend on the counterparty.** SyncNet verifies signatures and chain facts; it cannot verify a domain handover or a Discord admin transfer, and the UI labels every such item MANUAL / OFF-CHAIN.
4. **The Passport is a SyncNet record**, not an on-chain right. It confers no power the underlying contracts do not provide, and the pages say so.
5. **X accounts are never represented as transferable.**
6. **Launchpad protocol owners keep their own powers.** PAR and Pons V2 factory owners can propose creator-fee-recipient
   overrides (timelocked). SyncNet reads the Pons V2 override live and treats an active one as an encumbrance; it cannot
   prevent a launchpad from exercising powers its contracts grant. A sale never transfers launchpad protocol control.
