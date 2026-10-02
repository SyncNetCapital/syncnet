# SYNC Proof · public protocol (v1)

This is the verifier-facing extract of `docs/sync-proof-early-spec.md`. Anyone can reproduce every check below with
`lib/syncnet-core.js`, `lib/syncnet-early.js`, a Robinhood Chain RPC and the public bundles. Reference verifier:
`docs/early/verify-receipt.mjs`.

## 1. Domain and structures

EIP-712 domain: `{ name: "SyncNet SYNC Proof", version: "1", chainId: 4663 }` (no `verifyingContract`).

| Structure | Signed by | Fields |
|---|---|---|
| `CreatorManifest` | the receiving wallet | schema, creatorId, platform, channelId, chainId, receivingWallet, acceptedAssetsHash, manifestVersion, previousManifestHash, issuedAt, nonce |
| `SupportIntent` | the fan (sender) | schema, intentId, manifestHash, creatorId, chainId, sender, receiver, token, amount, notBefore, expiry, privacy |
| `SupportFinalize` | the fan | schema, intentId, txHash, logIndex, issuedAt, nonce |
| `CountMeIn` / `CountMeInWithdraw` | the fan | private signals; never part of a receipt |
| `RotationCancel`, `EarlySession`, `CreatorLinkRequest`, `CardReveal` | see the spec | operational |

`manifestHash` = EIP-712 digest of `CreatorManifest`. `creatorId = keccak256("syncnet.early.creator.v1|" + platform + "|" + externalId)`.

**Creator identity is `(platform, immutable externalId)`**, never a handle, name or avatar. The signed field that carries the
external id is named `channelId` (it is part of the v1 type hash and never changes); everywhere else it is called
`externalId`. For `platform = "youtube"` the id is the immutable channel id (`^UC[A-Za-z0-9_-]{22}$`), and
`keccak256("syncnet.early.creator.v1|youtube|" + channelId)` is byte-identical to every `creatorId` issued so far. The
registry in `lib/syncnet-early.js` (`PLATFORMS`) is the single definition of an id's shape and of what the platform's audience
context counts; a verifier never needs it to check a receipt, because the receipt carries `platform` and `channelId` inside
the signed manifest and `creatorId` inside the signed intent. A deployment decides which platforms it accepts: `youtube`
always; `x` only when explicitly enabled (see §7a).
`acceptedAssetsHash = keccak256(canonicalJson([{token, minAmount}…]))` with tokens sorted ascending.

## 2. Canonical JSON

Object keys sorted by code unit, no whitespace, arrays in order, integers or strings only (amounts are strings),
`undefined` dropped, strings UTF-8. `hashJson(x) = keccak256(utf8(canonicalJson(x)))`.

## 3. Matching rule `syncnet.sync-proof.matching.v1`

A log `L` in transaction `T` in block `B` is a candidate for intent `I` iff:

1. `eth_chainId == 0x1237`;
2. `T`'s receipt `status == 0x1`;
3. `L.address == I.token`, three topics, `topics[0] == keccak("Transfer(address,address,uint256)")`, topics 1–2 are zero-padded addresses;
4. `from(L) == I.sender`, `to(L) == I.receiver`;
5. `uint256(L.data) == I.amount` (data is exactly 32 bytes);
6. `B` is canonical: `eth_getBlockByNumber(B.number).hash == receipt.blockHash == L.blockHash`, `L.removed != true`;
7. `I.notBefore ≤ B.timestamp ≤ I.expiry`;
8. confirmation: `B.number ≤ safe` for CONFIRMED, `≤ finalized` for FINALIZED;
9. `I.signature` recovers to `I.sender` (or EIP-1271), `I.receiver == manifest.receivingWallet`, and the manifest's
   ACTIVE attestation covers `B.timestamp`.

Decision: exactly one in-window candidate → `auto`; two or more → `ambiguous-finalized` with a `SupportFinalize`
signature naming `(txHash, logIndex)`; none in window but one with `expiry < B.timestamp ≤ expiry + 86400` →
`recovery-finalized` with the same signature; otherwise no receipt. A `(txHash, logIndex)` belongs to at most one receipt.

**Not proven by any of this:** that the intent was signed before the transfer. SyncNet enforces it (the transfer is
enabled only after the signed intent is persisted, and transfers mined at or before the persistence block are never
candidates) and records `ordering.createdBlock` in the receipt as its own statement.

## 4. Receipt `syncnet.sync-proof.receipt.v1`

`receiptId = keccak256(utf8("syncnet.sync-proof.receipt.v1|4663|" + txHash + "|" + logIndex))`. Document sections:
`fact` (chain), `intent` (typed data + signature), `finalize` (or null), `creatorManifest` (typed data + accepted
assets + signature), `attestations` (each with `inclusion` when its bundle is built), `anchors`, `ordering`, `context`,
`privacy`. Verification steps: §8 of the spec (signatures → chain facts → attestations → inclusion → anchor → manifest window).

## 5. Attestations `syncnet.attestation.v1`

`id = hashJson({schema, type, subject, claims, issuedAt, bundleDate})`; signature = secp256k1 over
`keccak256(utf8("SYNCNET-ATTESTATION/1") ‖ id)` by the key registered under `keyId` in `syncnet-early-keys.json`
(served at `/api/early?view=keys`). Types: `creator-identity`, `creator-manifest`, `audience-snapshot`, `key-registry`.
Valid only if the signature verifies, `issuedAt` lies in the key's validity window, and the attestation is included in
an anchored bundle.

## 6. Bundles and anchors

Per UTC day `D`: `leaf = keccak256(0x00 ‖ utf8("attestation") ‖ 0x00 ‖ attestationId)`; leaves sorted ascending as
256-bit integers, de-duplicated; node = `keccak256(0x01 ‖ left ‖ right)`, odd levels duplicate the last node. A day with
no leaves has **no bundle**: nothing is persisted, anchored or submitted to OpenTimestamps for it (so "no bundle for D" =
"no attestations on D"). Public: `/api/early?view=bundle&date=D` → leaves, root, anchors (or `built:false`).

Robinhood anchor: a transaction from the registry anchor address to **itself**, value 0, `data = "SYNC" ‖ 0x01 ‖ root ‖ utf8(D)`
(47 bytes). Anchor time = its block timestamp. OpenTimestamps: the message stamped is `sha256(root bytes)` (the
reference client's default file digest), submitted to public calendars; the stored proof is **submitted** until an
upgrade yields a Bitcoin attestation. Verify with the official client: write the 32 root bytes to `root.bin`, then
`ots verify -f root.bin bundle.ots` (or `ots verify -d <sha256(root) hex> bundle.ots`); `ots upgrade bundle.ots` fetches
the Bitcoin attestation once it exists. Validated against opentimestamps-client 0.7.2 on 29 Sep 2026.

## 7. Audience snapshot

`S(D)` for a channel is the first successful YouTube Data API read on UTC day `D` (or the enrolment read on the join
day). It is never replaced and never backfilled. A receipt's `context.audienceThen` is `S(utcDate(blockTimestamp))`:
`approximate` (YouTube's rounded public count), `hidden`, or `unavailable`, plus `kind` (`subscribers` for YouTube: what the
snapshot counted; a platform whose audience is followers is always labelled as that platform's followers, never as a generic
audience). It is dated, approximate context; it is never part of payment validity.

### 7a. X (platform `x`)

Identity is the immutable **numeric X user id, carried as a string** (`^[1-9][0-9]{0,19}$`; ids exceed 2^53 and are never
parsed as numbers), proved by an authenticated `GET /2/users/me` after OAuth 2.0 Authorization Code with PKCE (S256) with
the two scopes `tweet.read users.read` and nothing else (X's `GET /2/users/me` requires both; no `offline.access`; the access token is used once and discarded). The `@username`, display name
and avatar are mutable display metadata, never identity: the handle and avatar appear in no attestation or signature; the display
name is recorded once, as a dated `title` label, in the `creator-identity` attestation (as for YouTube). The manifest reuses the v1
`CreatorManifest` with `platform = "x"` and the numeric id in the signed `channelId` field; receipts are ordinary v1
receipts and verify with the same verifier. The `creator-identity` attestation uses `method = "x-oauth2-pkce tweet.read users.read GET /2/users/me"`
and names the id as `externalId` (subject and claims).

`audience-snapshot` for X (same type, same first-success-of-the-UTC-day rule, never backfilled):
`claims = {platform:"x", externalId, dateUTC, audienceKind:"followers", followerCount, fetchedAt, source}`, `subject = {externalId}`.
It deliberately holds no name, handle or avatar. `source` is `x-api-v2 users public_metrics.followers_count` (daily read) or
`... users/me ... (oauth link, enrolment)` (join day). A day without a follower figure has no snapshot, and the receipt reads
`unavailable`. `context.audienceThen` for X has `kind: "followers"` and is presented as `Followers on X then: ~12K`.
