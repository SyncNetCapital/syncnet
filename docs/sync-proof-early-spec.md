# SYNC Proof · EARLY — implementation specification (Phase 0)

Status: **Phase 0 specification, adversarially self-reviewed (§24). No code written.** Built behind `/labs/early`.
Date: 28 September 2026. Chain: Robinhood Chain, chain id 4663.

> **Money moves directly. SyncNet proves the relationship.**
> EARLY: *I was there when.*

This document turns the frozen product decisions into an implementation-grade specification for the existing SyncNet
repository (static Netlify site, Netlify Functions, Upstash, no build step, CSP `script-src 'self'`). It does not
redesign SyncNet and does not reopen the product thesis. Every section is written to be implemented as-is; where the
repository already has the mechanism, the section names the file to reuse.

---

## 0. Repository inventory: reuse vs. add

### 0.1 Reused as-is (no changes)

| Existing | Used for |
|---|---|
| `netlify/lib/store.js` | Upstash adapter, in-memory test adapter, **`cas()` atomic compare-and-set** (the only multi-key atomic primitive; every EARLY state transition that matters is one `cas`). |
| `netlify/lib/ratelimit.js` | Fixed-window limits (fail closed on store outage). |
| `netlify/lib/respond.js`, `body.js`, `log.js` | Fixed JSON error messages, `nosniff`, deny-all CSP, bounded bodies, hashed identifiers in logs. |
| `netlify/lib/chain-rpc.js` | Read-only Robinhood Chain RPC (`SYNCNET_RPC_URL` or public). |
| `netlify/lib/sig-verify.js` | ECDSA recovery then EIP-1271 for contract wallets, per digest. |
| `netlify/lib/project-home-chain.js` | `bounded()` RPC call budget, `assertChain`, `block(tag|number)`, `receipt`, the Transfer-log decoding pattern. |
| `netlify/lib/flags.js` | Server-side rollout gate (an EARLY flag is added, §17). |
| `lib/syncnet-core.js` | keccak-256, sha-256, HMAC, secp256k1 recover **and sign**, EIP-712 hashing, ABI encoding, canonical text policy, `sanitizeForDisplay`. |
| `lib/syncnet-market.js` → pattern | `canonicalJson`, `hashJson`, `typedData`/`digest` shape. EARLY gets its **own** shared schema module with its **own** EIP-712 domain, so no signature can cross products. |
| `sn-wallet.js` | EIP-6963 discovery, `connect`, `ensureChain` (4663), `signTyped` (`eth_signTypedData_v4`), `sendTransaction`. |
| `sn-ui.js`, `ui.css`, `v2.css`, top bar, tab bar, footer | Page chrome, wallet button, escaping helpers. |
| `netlify/lib/upload-session.js` → pattern | HMAC session tokens with epoch revocation. EARLY uses the same construction with a **separate secret** (§19). |
| Project Home verification (`netlify/functions/project-home.js` §486–652) | The reference implementation of: exact-amount ERC-20 Transfer-log verification from the canonical contract, SAFE/FINALIZED policy, atomic claim of a `(txHash, logIndex)`, reorg reconciliation, idempotent verify. EARLY's matcher generalises it (any accepted token, sender-bound, receiver from the manifest). |
| Test harness (`tests/e2e/harness.mjs`, `tests/project-home/fixtures.mjs`) | Mock chain with receipts, Transfer logs, safe/finalized tags, reorgs, outages; EIP-1193 wallet mock with real secp256k1 keys; in-process Netlify functions. |

### 0.2 Added (new files, §22)

One shared schema module, one API function, one OAuth function, two scheduled functions, three small server libs
(attestation signing, Merkle bundle, minimal anchor transaction), the YouTube client, two pages, one page script, one
git-reviewed asset allowlist, one git-reviewed key registry, tests, and one amendment each to `netlify.toml`,
`_redirects`, `flags.js`, `config.js` and `tests/static_audit.py`.

### 0.3 Not touched

Marketplace, Economies, Project Home, Registry, builder, uploads, and their rate limits and gates. EARLY's Upstash
keys use the prefix `early:` and never read or write `mp:`, `site:`, `eco:` or `reg:` keys.

### 0.4 One deliberate policy exception

`netlify/lib/chain-rpc.js` states that functions never sign or send transactions. EARLY adds **exactly one** server-sent
transaction: the daily anchor, a zero-value self-transfer from a dedicated anchoring key carrying the Merkle root as
calldata (§10.5). It is isolated in the scheduled function `early-anchor.js`, the key controls no user funds and holds
only gas, the destination is hard-wired to its own address, and it has a kill switch. No other function signs anything
with a chain key.

---

## 1. Product invariants

I-1. **Direct payment.** The only money path is `fan wallet → creator receiving wallet`, a standard ERC-20 `transfer`
on chain 4663. SyncNet never custodies, receives, forwards, escrows, swaps, guarantees, or fee-shares. There is no
router, vault, escrow, token, or intermediary contract. No percentage fee in the pilot.

I-2. **Standard transfers only.** `transfer(address,uint256)` with exactly 68 bytes of calldata (`0xa9059cbb` + two
words). SyncNet does not append trailing calldata. Trailing calldata is technically tolerated by some token
implementations, but it is non-standard and non-portable, behaves differently across token contracts and wallets,
and worsens UX and auditability; that is why it is not used, not because it is impossible.

I-3. **Four separate layers, never collapsed.**
1. *Transaction = fact* (chain): value moved from A to B in block N.
2. *Intent = meaning* (fan signature, before the transfer): what the fan intended the transfer to mean.
3. *Identity/context = SyncNet attestation* (anchored): this receiving wallet was verified for this YouTube channel;
   the channel's audience on that day was approximately X.
4. *Publication = consent* (fan opt-in): a relationship becomes visible only through an explicit share action.

I-4. **Creator identity = immutable YouTube channel ID.** Handles, names, avatars are mutable metadata.

I-5. **Token identity = `chainId + contract address`.** Symbols are display only.

I-6. **Historical manifests are immutable.** Rotation creates a new version; old proofs stay interpretable.

I-7. **EARLY is established only by a successful direct transfer that matches a stored, previously signed intent, after
the creator is ACTIVE.** The EARLY date is the block timestamp. Count me in never confers EARLY.

I-8. **No rankings.** No "Supporter #N", leaderboards, public supporter counts, ROI/multiple/investment framing.

I-9. **Private by default.** No public support graph. Supporter wallets, who-supports-whom, receipt counts,
cross-creator relationships and rankings are never public.

I-10. **Independently verifiable receipts.** A receipt verifies from the chain, the fan's signature, the creator's
signature and anchored SyncNet attestations; never from trust in a mutable database. SyncNet's signing key never
proves the transfer.

I-11. **Never guess.** Exactly one deterministic match finalises; zero → failed/expired/recovery; more than one →
the fan chooses with a signature.

I-12. **No happy-path third signature.** Happy path = sign intent, send transfer.

I-13. **Honest context.** Audience size is a rounded, dated, YouTube-sourced SyncNet attestation, shown as
approximate/hidden/unavailable, never a later value presented as historical.

I-14. **Honest metrics.** "card generated", "share link copied", "verification-page visits". Views are not shares.

I-15. **Pilot scope.** Behind `/labs/early`, 30 days, a handful of crypto-native YouTube creators. No audience graph,
recommendations, perks, token funnel, CRM.

---

## 2. Trust model

| Party / component | Trusted for | Not trusted for |
|---|---|---|
| **Robinhood Chain (RPC)** | Facts: transactions, receipts, logs, block hashes/timestamps, `safe`/`finalized` tags. `SYNCNET_RPC_URL` may pin a private RPC. | Nothing else. An RPC failure is "unavailable", never a state change. |
| **Fan wallet** | Meaning: the `SupportIntent` (and, conditionally, `SupportFinalize`, `CardReveal`) signatures. | Anything about the creator, the token, the chain state. |
| **Creator wallet** | The `CreatorManifest` (receiving wallet, accepted assets, minimums) and `RotationCancel`. | The creator's YouTube identity (that is proven through OAuth and attested by SyncNet). |
| **Google / YouTube** | Who controls a channel (OAuth), public channel statistics and title (Data API). | Historical values (the API returns current values only; SyncNet snapshots daily). |
| **SyncNet attestation key** | Identity ↔ wallet verification, manifest lifecycle (`effectiveAt`, supersession), daily audience snapshots, the key registry. Every attestation is anchored (§10). | The transfer, the intent, the creator's signature. A compromised key cannot fabricate any of those. |
| **SyncNet database (Upstash)** | Availability and privacy of private records. | Truth: nothing verifies from it; it stores signed/chain-derived records that anyone with the receipt can re-verify. |
| **SyncNet anchoring key** | Publishing daily roots on Robinhood Chain (identity = the key's address in the git-reviewed registry). | Anything else; it can only send zero-value self-transfers. |
| **OpenTimestamps calendars** | Later Bitcoin-verifiable timestamps of the same root. | Immediate finality; a pending `.ots` proves only submission. |

**What silently depends on SyncNet, stated explicitly** (each mitigated by anchoring, §10):
1. That a receiving wallet belonged to channel C at time T (identity attestation, anchored).
2. When a manifest became effective / was superseded (manifest attestation, anchored).
3. The audience snapshot value for day D (snapshot attestation, anchored; source = YouTube).
4. **That the intent was signed and persisted before the transfer was enabled.** This is an *application*
   guarantee (the server persists the signed intent, then the transfer button is enabled; the server records
   `createdBlock` and refuses transfers mined at or before it). It is **not** independently verifiable from the
   receipt: an independent verifier proves the fan signature, the creator manifest and the matching chain transfer,
   and nothing about the temporal order of the intent signature and the transfer. EARLY chronology is the block
   timestamp of the transfer, never the intent time. (Precision correction, 29 Sep 2026: daily anchoring of intent
   digests would prove only that an intent existed no later than that day's anchor time, which does not order it
   against a transfer in the same day; it is therefore **not** used, see §10.3.)
5. A default (hidden-transaction) public card is a SyncNet-attested claim, not an independently verifiable one
   (§14.3). Full independent verification requires the holder to reveal the transaction.

---

## 3. Threat model

Assets: (a) funds in transit fan → creator; (b) the truth of "who supported whom, when"; (c) fan privacy; (d) creator
identity; (e) integrity of historical context; (f) SyncNet's regulatory surface.

Adversaries: an attacker holding a creator's old or new wallet; an attacker holding a creator's Google account; a fan
forging status; a colluding fan+creator; a malicious or compromised SyncNet operator or attestation key; a
compromised database; a hostile RPC; spammers/Sybils on Count me in; a snooper reading public pages/APIs; a
phishing site imitating `/labs/early`.

Security goals (mapped to §21 failure cases):
- G1 Money can be redirected only by a party who controls **both** the creator's YouTube account and a wallet they
  chose, after a visible 48-hour cooldown that the current wallet can cancel (§12).
- G2 EARLY status cannot be forged without a real transfer and a fan signature that predates it (anchored).
- G3 No public page, API or leaf reveals a supporter wallet, a pair (fan, creator), a per-creator count or a ranking
  unless the fan explicitly revealed it.
- G4 A SyncNet key compromise cannot fabricate fan signatures, creator signatures or transfers, and cannot
  retroactively alter anchored attestations.
- G5 Replay, reuse and race conditions on intents, nonces, transfers and manifests are refused atomically.
- G6 Matching is deterministic and public; ambiguity is surfaced, never guessed.
- G7 SyncNet never touches funds (no custody, no fee, no swap, no balance), so no payment-processor surface is added.

Out of scope for the pilot (stated): Sybil resistance of Count me in; protection when both the creator's Google
account and their current wallet are compromised together; privacy against chain analysis of the fan's own public
transactions (the transfer itself is public on chain; SyncNet only avoids adding the *meaning* to public view).

---

## 4. Data and privacy model

### 4.1 Classification

| Data | Class | Where | Public? |
|---|---|---|---|
| YouTube channel ID, title, avatar URL, rounded subscriber count | Public platform data | `early:creator:*`, snapshots | Yes, for ACTIVE/ROTATION_PENDING/PAUSED creators only |
| Creator receiving wallet, accepted assets, minimums, manifest signatures | Creator-published | manifests | Yes (needed to pay) |
| Count me in signals (fan wallet ↔ channel) | **Private relationship** | `early:cmi:*` | Never. Only an aggregate count to the creator after claim. |
| Intents, receipts (fan wallet ↔ creator, amount, tx) | **Private relationship** | `early:intent:*`, `early:receipt:*` | Never by default. Only via the fan's card, only the fields revealed. |
| Google access token | Secret, transient | memory during the callback only | Never stored. No refresh token requested. |
| Creator session token, fan session token | Secret, short-lived | browser `sessionStorage`; never in URLs except the OAuth return fragment | — |
| IP addresses | Abuse prevention | hashed rate-limit keys | Never |
| Attestation/anchor private keys | Secret | Netlify env only | Never |

### 4.2 Sensitivity as a first-class threat

Support relationships can reveal political, religious, sexual, health or other sensitive interests (a fan supporting a
niche creator). Consequences in this design:
- No endpoint lists a wallet's intents/receipts/signals without a **fresh wallet-signed session** (§16.5).
- No endpoint lists a creator's supporters at all. Creators see only aggregate counts of signals at claim time.
- Intent/receipt reads by id require the 256-bit `intentId` capability, which appears only in the fan's own browser
  storage and the fan's own recovery URL.
- Merkle leaves contain no fan data: creator-side attestations and unlinkable intent digests only (§10.3).
- Public cards default to wallet hidden, identity hidden, amount hidden; revealing the transaction is a separate
  signed decision, explained as irreversible.
- Logs use hashed identifiers (`log.js`); intent ids are logged truncated.
- Data minimisation: no email, no Google user id, no refresh token, no fan identity beyond the wallet address.
- Retention: drafts 20 min; unmatched intents 90 days; signals 180 days (re-signable); receipts for as long as the
  service runs (they are the fan's proof); OAuth link records 15 min; sessions ≤ 2 h.
- `privacy.html` must gain an EARLY paragraph before the pilot opens (§22, Phase 1).

---

## 5. CreatorManifest schema

### 5.1 EIP-712 domain (shared by every EARLY structure)

```
{ name: 'SyncNet SYNC Proof', version: '1', chainId: 4663 }    // no verifyingContract: off-chain records
```

Pinned in the new shared module `lib/syncnet-early.js` (browser + functions), like `lib/syncnet-market.js`.

### 5.2 Typed structure

```
CreatorManifest(
  string  schema,               // 'syncnet.early.creator-manifest.v1'
  bytes32 creatorId,            // keccak256(utf8('syncnet.early.creator.v1|youtube|' + channelId))
  string  platform,             // 'youtube'
  string  channelId,            // ^UC[A-Za-z0-9_-]{22}$
  uint256 chainId,              // 4663 (also bound by the domain; repeated for readability in wallets)
  address receivingWallet,      // the signer
  bytes32 acceptedAssetsHash,   // keccak256(canonicalJson(acceptedAssets))  (5.3)
  uint32  manifestVersion,      // 1, 2, 3 … per creator
  bytes32 previousManifestHash, // 0x00…00 for version 1; else the EIP-712 digest of version n-1
  uint256 issuedAt,             // unix seconds, signer clock, within ±120 s of server time
  bytes32 nonce                 // 32 random bytes, single use per wallet
)
```

`manifestHash` := the EIP-712 digest of this struct in the domain above. It is the identifier every intent and
receipt references. The signer must be `receivingWallet` (ECDSA or EIP-1271).

### 5.3 Accepted assets (carried alongside, committed by hash)

```
acceptedAssets = [ { token: '0x…' (lowercase), minAmount: '<raw integer string>' }, … ]
```
- Sorted by `token` ascending; at least 1, at most 4 entries; `token` must be in the git-reviewed pilot allowlist
  `syncnet-early-assets.json` (§5.4); `minAmount` ≥ 1 raw unit, ≤ 2^128.
- `acceptedAssetsHash = Core.keccak256Utf8(canonicalJson(acceptedAssets))` with `canonicalJson` = sorted keys, no
  whitespace (the Marketplace function, copied into `lib/syncnet-early.js`).
- The wallet displays a hash rather than a nested array: fewer wallet-compatibility problems on mobile. The page
  shows the human list next to the signature request.

### 5.4 Pilot asset allowlist (`syncnet-early-assets.json`, git-reviewed)

```
{ "schema": "syncnet.early.assets.v1", "chainId": 4663, "assets": [
  { "token": "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "symbol": "USDG", "decimals": 6,  "note": "Global Dollar; PAR SDK address book; issuer-upgradeable proxy" },
  { "token": "0x6368e007b9f0b941560ed1f3bceb20247f5eca37", "symbol": "SYNC", "decimals": 18, "note": "canonical $SYNC" }
] }
```
Native ETH is excluded (no Transfer log; a different matching rule). Fee-on-transfer or rebasing tokens are never
listed: the matched fact is the Transfer event `value` emitted by the canonical contract. Decimals come from this
file, never from a live `decimals()` read, so a hostile token cannot alter the human-readable amount.

### 5.5 Stored manifest record

```
early:manifest:v1:<manifestHash> = {
  schema, struct: {…5.2 fields…}, acceptedAssets, signature, signer,
  manifestHash, creatorId, channelId,
  status: 'PENDING' | 'ACTIVE' | 'SUPERSEDED' | 'CANCELLED',
  effectiveAt: unix | null,           // server-assigned; attested (5.6)
  supersededAt: unix | null, supersededBy: manifestHash | null,
  identityAttestationId, manifestAttestationIds: [ … ],
  createdAt
}
early:manifests:v1:<creatorId>   = set of manifestHash (history, append-only)
early:creator:v1:<creatorId>     = { creatorId, channelId, status, currentManifestHash, pendingManifestHash,
                                    display: {title, avatarUrl, handle}, displayUpdatedAt, joinedAt,
                                    rotation: {…12.3…}, pausedAt, signalsWaitingAtJoin }
```
Records are never rewritten except `status`, `supersededAt/By` and `effectiveAt`, each through `cas`, each mirrored
by a new attestation. The struct and signature are immutable.

### 5.6 Attestations produced (see §9)

- `creator-identity`: `{creatorId, platform:'youtube', channelId, receivingWallet, manifestHash, verifiedAt, method:'google-oauth2 youtube.readonly channels.mine'}`
- `creator-manifest`: `{creatorId, manifestHash, manifestVersion, previousManifestHash, status, effectiveAt, supersededAt, at}` — one per status change.

---

## 6. CountMeIn schema

### 6.1 Typed structure

```
CountMeIn(
  string  schema,      // 'syncnet.early.count-me-in.v1'
  string  platform,    // 'youtube'
  string  channelId,   // the creator the fan is interested in (resolved server-side from a URL/handle, 6.3)
  address fan,         // the signer
  uint256 issuedAt,    // ±120 s
  uint256 expiry,      // issuedAt + 180 days (server-fixed; refused otherwise)
  bytes32 nonce
)
```
Free, no amount, no payment, no reserved funds, non-binding, private. Signing it is the only action. One live signal
per `(channelId, fan)`; signing again refreshes `issuedAt/expiry` (same record, `renewedAt` appended).

### 6.2 Storage (private)

```
early:cmi:v1:<channelId>:<fan>   = { struct, signature, status:'ACTIVE'|'WITHDRAWN'|'EXPIRED'|'FROZEN', createdAt, renewedAt[], withdrawnAt }
early:cmi-count:v1:<channelId>   = integer (INCR/DECR mirror of ACTIVE records; recomputed from the set on claim)
early:cmi-set:v1:<channelId>     = set of fan wallets (server-only; never served)
early:cmi-of:v1:<fan>            = set of channelIds (served only to a fan session for that wallet)
```

### 6.3 Resolver

`GET /api/early?view=resolve&yt=<url|handle|channelId>` → `{channelId, title, avatarUrl, handle}` from the YouTube
Data API (`channels.list` with `forHandle`, `id`, or a parsed `/channel/UC…` URL; `forUsername` for legacy URLs).
Cached 1 h per normalised input (`early:yt:resolve:v1:<sha256(input)>`). The fan signs over the **channelId**; the
title is display only. The resolver answers identically for channels that are or are not on EARLY (it never says
whether signals exist).

### 6.4 Lifecycle

```
(none) ──sign+store──▶ ACTIVE ──sign again──▶ ACTIVE (renewed)
   ACTIVE ──fan Withdraw (signed)──▶ WITHDRAWN          (a withdrawn signal is not counted; record kept 30 d then deleted)
   ACTIVE ──expiry passes──▶ EXPIRED                    (lazily; not counted)
   ACTIVE ──creator becomes ACTIVE──▶ FROZEN            (counted once into signalsWaitingAtJoin; the record's own
                                                        status stays readable to the fan; no further effect)
```
`Withdraw` is `CountMeInWithdraw(string schema, string channelId, address fan, uint256 issuedAt, bytes32 nonce)`.

### 6.5 What the creator sees on claim

`signalsWaitingAtJoin` = number of ACTIVE (unexpired, unwithdrawn) signals at the moment the creator became ACTIVE,
computed inside the activation `cas` from the set. Copy: **"17 signed interest signals were waiting when you joined."**
Never "17 people", never "17 verified supporters", never per-signal details. The count is stored on the creator record
and is shown only to the creator session; it is not public and not anchored.

### 6.6 What the fan sees later

When a fan opens `/labs/early/mine` (fan session), signals whose creator is now ACTIVE are listed with
"Now on EARLY → Support". No notification system exists in the pilot.

### 6.7 Public silence for unregistered creators

There is no page for an unregistered channel. `GET ?view=creator&channelId=UC…` returns the same body
`{onEarly:false}` whether zero or a thousand signals exist, with the same latency profile (no set reads on that path).
Rate limits (§18) bound enumeration of ACTIVE creators, which are public anyway.

---

## 7. SupportIntent EIP-712 schema

### 7.1 Typed structure

```
SupportIntent(
  string  schema,          // 'syncnet.early.support-intent.v1'
  bytes32 intentId,        // 32 random bytes from the server CSPRNG (never client-chosen)
  bytes32 manifestHash,    // the CreatorManifest digest the fan is paying against
  bytes32 creatorId,
  uint256 chainId,         // 4663
  address sender,          // fan wallet (signer)
  address receiver,        // manifest.receivingWallet, server-filled
  address token,           // canonical contract from the manifest's accepted assets
  uint256 amount,          // exact raw amount (≥ minAmount for that token)
  uint256 notBefore,       // unix seconds (7.3)
  uint256 expiry,          // notBefore + 7200
  string  privacy          // 'PRIVATE' (the only value in v1)
)
```
`intentDigest` := EIP-712 digest. The fan signs with `eth_signTypedData_v4` via `sn-wallet.js`.

### 7.2 Why a server draft precedes the signature

The client sends only `{manifestHash, sender, token, amount}`. The server derives `creatorId`, `receiver`, `chainId`,
`notBefore`, `expiry`, `intentId`, validates the manifest is ACTIVE and the asset/amount are accepted, stores the
**DRAFT** (TTL 20 min), and returns the exact typed data to sign. The client cannot smuggle a different receiver, chain
or token; the wallet shows the same values the server will verify. Extra body fields → 400 (`onlyFields`, as in
Project Home).

### 7.3 Windows and the same-tuple rule

- `notBefore = max(serverNow − 60, lastExpiryOfSameTuple + 1)` where the tuple is `(sender, receiver, token, amount)`.
  If that exceeds `serverNow`, the draft is refused ("wait until the earlier intent expires"). While an intent for the
  same tuple is OPEN, a second draft is refused. This makes the windows of same-tuple intents **disjoint**, so one
  transfer can satisfy at most one intent's window (§13).
- `expiry = notBefore + 7200` (2 h: enough for a mobile wallet that delays broadcast).
- `createdBlock` (head at store time) is recorded on the stored intent; the public matching rule uses only signed
  fields, `createdBlock` is an additional server-side guard against a transfer mined between draft and store.
- If the manifest has a scheduled supersession (`rotation.effectiveAt`), `expiry = min(expiry, rotation.effectiveAt)`
  and drafts are refused in the final 60 min before it.

### 7.4 Storage

```
early:draft:v1:<intentId>       = { …typed message…, status:'DRAFT', createdAt }                        TTL 20 min
early:intent:v1:<intentId>      = { schema, struct, signature, intentDigest, status, createdBlock, createdAt,
                                    bundleDate, observed?, matches?, receiptId?, closedAt?, closeReason? }  TTL 90 d (unmatched)
early:open:v1:<sender>:<receiver>:<token>:<amount> = intentId                                          TTL = expiry
early:tuple-last:v1:<…same…>    = last expiry (unix)                                                   TTL 30 d
early:intents-of:v1:<sender>    = set of intentId (served only to that wallet's session)
early:nonce:v1:<wallet>:<nonce> = 1                                                                    TTL 90 d
```
Storing the signed intent is one `cas` expecting the draft unchanged, the open-tuple key absent and the nonce absent;
it sets the intent (with `createdBlock` = the head read just before the commit), the open-tuple key and the nonce.
Nothing about an intent enters a Merkle bundle (§10.3).

A failed browser session after signing does not destroy the intent: the signature is POSTed before the transfer is
enabled; if the POST itself failed the client retries the same signature (idempotent: same `intentId`, same digest).

---

## 8. Receipt schema (`syncnet.sync-proof.receipt.v1`)

A receipt is a **self-contained, canonical JSON document** the fan can download, and which anyone can verify offline
against the chain and the published bundles. Mutable context (creator's current name, live audience, avatar) is
**referenced**, never embedded.

```
{
  "schema": "syncnet.sync-proof.receipt.v1",
  "receiptId": keccak256(utf8('syncnet.sync-proof.receipt.v1|4663|' + txHash + '|' + logIndex)),
  "matchingRule": "syncnet.sync-proof.matching.v1",
  "mode": "auto" | "ambiguous-finalized" | "recovery-finalized",

  "fact": {                                      // ── cryptographically / on-chain verifiable
    "chainId": 4663, "txHash", "logIndex", "blockNumber", "blockHash", "blockTimestamp",
    "transfer": { "token", "from", "to", "value" },   // exactly the Transfer log fields
    "confirmation": { "policy": "safe-then-finalized", "safeAt", "finalizedAt" | null }
  },
  "intent": { "typedData": {…full EIP-712 payload incl. domain/types…}, "signature", "digest" },
  "finalize": null | { "typedData": {…SupportFinalize…}, "signature", "digest" },
  "creatorManifest": { "typedData": {…CreatorManifest…}, "acceptedAssets": […], "signature", "manifestHash" },

  "attestations": [                              // ── SyncNet attestations (signed, keyed, anchored)
    { …creator-identity attestation record… , "inclusion": { "bundleDate", "root", "leafIndex", "siblings":[…] } },
    { …creator-manifest (ACTIVE) attestation… , "inclusion": {…} },
    { …audience-snapshot for utcDate(blockTimestamp) or null… , "inclusion": {…} }
  ],
  "ordering": { "createdBlock", "storedAt", "note": "SyncNet-recorded: the signed intent was persisted at this block, before the transfer was enabled. Not independently verifiable." },

  "anchors": [ { "bundleDate", "root", "robinhood": { "txHash", "blockNumber" } | null,
                 "opentimestamps": { "submittedAt", "calendars": [ … ], "status": "submitted"|"bitcoin-verifiable"|"failed" } } ],

  "context": {                                   // ── derived for display, all traceable to the above
    "earlyDate": "2026-09-28",                   // utcDate(blockTimestamp)
    "audienceThen": { "value": 1200, "display": "~1.2K", "state": "approximate" } | { "state": "hidden" } | { "state": "unavailable" },
    "creatorTitleThen": "Alice"                  // from the audience-snapshot attestation of that day (or the identity attestation if none)
  },
  "privacy": { "state": "PRIVATE", "revealed": [] },
  "keys": "https://<site>/api/early?view=keys",  // reference; the key registry is also anchored and in git
  "issuedAt": "…"
}
```

Verification procedure (`docs/` will ship it as `verify-receipt.mjs`, dependency-free, in Phase 1):
1. Recompute `intent.digest` from `intent.typedData`; recover the signer; must equal `fact.transfer.from` and
   `intent.typedData.message.sender`.
2. Recompute `manifestHash`; recover the signer; must equal `message.receiver` and `fact.transfer.to`.
3. Fetch the receipt from the chain by `txHash`; check `status == 0x1`, `blockHash`, the log at `logIndex` is emitted
   by `token` with the Transfer topic layout, `from/to/value` equal the receipt's `fact.transfer`, and the block
   timestamp is within `[notBefore, expiry]` (or, for `recovery-finalized`, within `(expiry, expiry + 86400]` with a
   valid `finalize` signature naming this `txHash`/`logIndex`).
4. For each attestation: verify the SyncNet signature against the key registry entry for `keyId`; verify the Merkle
   inclusion against the bundle root; verify the root was anchored on Robinhood Chain from the registered anchoring
   address (and optionally via OTS) at a time ≤ the key's `validUntil` if the key is retired.
5. Check the identity attestation's `manifestHash` equals the receipt's, and the manifest attestation shows ACTIVE with
   `effectiveAt ≤ blockTimestamp` and (`supersededAt` null or `> blockTimestamp`).

Steps 1–3 need no SyncNet at all. Steps 4–5 need only public bundles and the chain. **What this does not prove:**
that the intent was signed before the transfer. That ordering is enforced by the application (§7.4) and recorded in
`ordering`, which a verifier can only take as SyncNet's statement.

---

## 9. SyncNetAttestation schema (`syncnet.attestation.v1`)

```
{
  "schema": "syncnet.attestation.v1",
  "type": "creator-identity" | "creator-manifest" | "audience-snapshot" | "key-registry",
  "id": keccak256(utf8(canonicalJson({schema,type,subject,claims,issuedAt,bundleDate}))),
  "subject": { … },              // e.g. {creatorId, channelId}
  "claims": { … },               // type-specific (5.6, 13.6)
  "issuedAt": unix, "bundleDate": "YYYY-MM-DD",
  "keyId": "early-att-2026-09-k1",
  "signature": "0x…65 bytes"     // secp256k1 over keccak256(utf8('SYNCNET-ATTESTATION/1') ‖ id) with RFC-6979 deterministic k
}
```
- Signing uses `Core.sign` (secp256k1, already in `lib/syncnet-core.js`) with a deterministic nonce derived via
  `Core.hmacSha256Bytes` (RFC 6979). Verification is `Core.recoverAddress(digest, signature) == registry[keyId].address`:
  the browser and any verifier reuse existing code; no new crypto.
- **Rule:** an attestation is valid only if (a) the signature verifies for `keyId`, (b) it is included in a bundle
  whose root is anchored, and (c) the anchor time is ≤ the key's `validUntil` when the key is retired. Unanchored
  attestations are shown as "pending anchor" and never as verified.
- Attestations never contain fan data.

Audience snapshot claims: `{channelId, dateUTC, title, subscriberCount: integer|null, hiddenSubscriberCount: bool,
fetchedAt, source:'youtube-data-api-v3 channels.list statistics', rounding:'as returned by YouTube'}`.

---

## 10. AttestationBundle and Merkle format

### 10.1 Bundle

One bundle per UTC day `D`. It is built at **00:20 UTC on D+1** by `early-anchor.js` from the queue
`early:bundle-queue:v1:<D>` (set of leaves). The leaf set is then **frozen** in `early:bundle:v1:<D>`; a rebuild
must reproduce the same root (tested).

`bundleDate` assignment: at issuance, `bundleDate = utcDate(issuedAt)`; if that day's bundle is already BUILT (a
straggler), `bundleDate = the earliest date whose bundle is not built`. Recorded on the record itself, so the rule is
reproducible.

### 10.2 Leaf format

```
leaf = keccak256( 0x00 ‖ utf8(leafType) ‖ 0x00 ‖ payload )
  leafType 'attestation'      payload = 32-byte attestation id
```
Only one leaf type exists in v1. (Intent commitments were considered and removed, §10.3.)
Leaves are sorted ascending as 32-byte integers, de-duplicated. Internal node = `keccak256(0x01 ‖ left ‖ right)`;
an odd level duplicates its last node. Root of a single leaf = that leaf. **Empty day (amended 3 Oct 2026, canary
finding):** a day with no attestation leaves is not built, not anchored and not submitted to OpenTimestamps; no record is
persisted for it (it creates no on-chain transaction and no calendar request). `keccak256(0x02 ‖ D)` remains defined only
as the date-specific constant `emptyRoot(D)`; an earlier version anchored empty days and that is withdrawn. Absence of a
bundle for a day therefore means "no attestations that day", and a bundle record with zero leaves is ignored by the job.
**Gas price (same amendment):** the anchor transaction's gas price is `ceil(1.5 × max(eth_gasPrice, latest base fee))`
(the quote can already be below the block base fee at broadcast); above the 5 gwei ceiling the attempt fails closed and
is retried later; the ceiling is never raised.
**Broadcast state machine:** the attempt is written as `sent` BEFORE `eth_sendRawTransaction` (write-ahead). If the call
returns, it stays `sent` (one-hour wait, then the receipt decides). If the node answers with a JSON-RPC error naming a
never-accepted reason (base-fee / intrinsic-gas / insufficient-funds / block-gas-limit) AND `eth_getTransactionByHash` and
the receipt both return null, the exact attempt is atomically moved `sent → broadcast-failed` (txHash, nonce, gas fields,
`sentAt` kept; `failedAt` and a sanitized `broadcastError` added) and the next run may retry at once. Timeouts, HTTP errors,
"already known", "nonce too low", "replacement underpriced", unlisted messages and failed lookups never qualify: they stay
`sent` for the full hour.

Published: `GET ?view=bundle&date=D` → `{date, leafCount, leaves:[{type, payload}], root, anchors}`; anyone can
recompute. Inclusion proof: `{leaf, leafIndex, siblings:[{hash, side:'L'|'R'}], root}`.

### 10.3 What is anchored and why (and what is not)

| Anchored | Reason |
|---|---|
| creator-identity, creator-manifest attestations | Identity ↔ wallet and manifest lifecycle are SyncNet claims that could otherwise be rewritten. |
| audience-snapshot attestations | Historical context that cannot be re-derived later. |
| key-registry attestation | Fixes the set of valid keys and their validity windows. |
| **Not anchored:** transfers, receipts, Count me in, **intents** | Transfers are already on chain; receipts derive from anchored parts; signals are private and non-probative. |

**Why intents are not anchored (decision, 29 Sep 2026).** A daily anchor of an intent digest proves only that the
intent existed no later than that day's anchor time. It cannot order the intent against a transfer mined earlier the
same day, so it does not prove "signed before sent". The ordering guarantee is an application property (§7.4). The
only residual value of anchoring intents would be to bound a *colluding operator + fan* backdating of an intent to at
most one day for a transfer that really happened; that transfer would still be the fan's real support of an ACTIVE
creator on the real block date, so the EARLY claim would not be false. That marginal benefit does not justify a
public daily count of intents and extra bundle logic. No per-intent on-chain transaction or payment contract is
added either (frozen decision).

### 10.4 Canonicalisation

`canonicalJson`: object keys sorted (code-unit order), no whitespace, arrays in order, numbers as integers or strings
only (no floats anywhere; amounts are strings), strings UTF-8 NFC. The attestation `id` is the keccak of that.
The same function serialises the receipt. Test: golden vectors committed in `tests/early/vectors.json`.

### 10.5 Anchoring on Robinhood Chain

- Anchoring key: `SYNCNET_EARLY_ANCHOR_KEY` (32-byte hex), address published in `syncnet-early-keys.json` and served in
  `view=keys`. Holds only gas; funded by the operator (≈0.001 ETH covers months at Robinhood Chain gas).
- Transaction: `to = self`, `value = 0`, `data = 0x53594e43 ('SYNC') ‖ 0x01 ‖ root(32) ‖ utf8(D)(10)`, EIP-1559 or
  legacy type-0 (Robinhood Chain accepts both; type-0 is chosen for the smallest serializer). Serialisation and
  signing live in `netlify/lib/early-tx.js` (RLP + `Core.sign`, ~80 lines, tested against known vectors).
- Verification: `tx.from == anchorAddress`, `tx.to == anchorAddress`, `value == 0`, data decodes to `(root, D)`,
  receipt `status == 0x1`. Anchor time := block timestamp.
- Failure: retried hourly by the same scheduled function; the bundle stays `BUILT` (`anchor.robinhood = null`) and
  receipts show "anchor pending". Nonce handling: read `eth_getTransactionCount(pending)` each attempt; if a previous
  attempt is pending, wait, never double-send.

### 10.6 OpenTimestamps

Immediately after the Robinhood anchor (and independently of its success), the root is submitted to at least two
public calendars (`a.pool.opentimestamps.org`, `b.pool.opentimestamps.org`, `alice.btc.calendar.opentimestamps.org`)
via `POST /digest` with the 32 raw bytes. The returned partial `.ots` bodies are stored base64 in the bundle record
with `submittedAt`. Wording everywhere: **"Submitted to OpenTimestamps at <time>; becomes Bitcoin-verifiable later
(typically within hours) — verify with `ots upgrade`/`ots verify` against the stored proof."** Never "anchored in
Bitcoin at <time>". An upgrade step (`GET /timestamp/<digest>`) runs daily for the last 14 bundles and stores the
upgraded proof; status moves to `bitcoin-verifiable` only after a successful upgrade.

---

## 11. State machines

### 11.1 Creator

```
UNCLAIMED ──(OAuth link verified)──▶ VERIFYING ──(manifest v1 signed by receiving wallet, identity attested)──▶ ACTIVE
ACTIVE ──(creator session: pause)──▶ PAUSED ──(creator session: resume)──▶ ACTIVE
ACTIVE|PAUSED ──(fresh OAuth + manifest v(n+1) signed by NEW wallet)──▶ ROTATION_PENDING
ROTATION_PENDING ──(48 h cooldown elapsed, not cancelled)──▶ ACTIVE  (new manifest ACTIVE, old SUPERSEDED)
ROTATION_PENDING ──(RotationCancel signed by CURRENT wallet)──▶ ROTATION_LOCKED (7 d; rotation needs two OAuth sessions ≥24 h apart) ──▶ ACTIVE|PAUSED (as before)
ROTATION_PENDING ──(creator session cancel, i.e. fresh OAuth)──▶ ACTIVE|PAUSED (no lock)
```
- `UNCLAIMED` is not a stored state: a channel with no creator record is unclaimed. Count me in works only there or
  in any state (signals are accepted for any channel; they are counted at the UNCLAIMED→ACTIVE transition only).
- Only `ACTIVE` accepts new intent drafts. `PAUSED` and `ROTATION_PENDING` show the creator page with a warning;
  `ROTATION_PENDING` accepts drafts against the *current* manifest with the warning "This creator is changing their
  receiving wallet; support sent now goes to the current verified wallet" and the §7.3 expiry cap, unless PAUSED.
- Every transition is one `cas` on `early:creator:v1:<creatorId>` (+ manifest keys) and emits attestations.

### 11.2 Count me in

See §6.4: `ACTIVE → ACTIVE(renewed) | WITHDRAWN | EXPIRED | FROZEN`.

### 11.3 Support (intent + transfer)

```
DRAFT ──(fan signs)──▶ INTENT_SIGNED (client-side only) ──(server verifies + persists, cas)──▶ INTENT_STORED (OPEN)
INTENT_STORED ──(client sends transfer, remembers txHash)──▶ TX_SUBMITTED (client hint; server unchanged)
INTENT_STORED|TX_SUBMITTED ──(verify: match found, block ≤ safe? no)──▶ TX_CONFIRMING (server records `observed`)
TX_CONFIRMING ──(block ≤ safe, |C| == 1)──▶ CONFIRMED (receipt issued, EARLY date fixed)
CONFIRMED ──(block ≤ finalized)──▶ FINALIZED (card allowed)
INTENT_STORED ──(expiry passed, |C| == 0 in window)──▶ EXPIRED
EXPIRED ──(a transfer matching all rules but the window is found within expiry+24 h)──▶ RECOVERY_AVAILABLE
RECOVERY_AVAILABLE ──(fan signs SupportFinalize naming that tx/log)──▶ TX_CONFIRMING/CONFIRMED (mode recovery-finalized)
RECOVERY_AVAILABLE ──(expiry+24 h passes)──▶ EXPIRED (closed)
any ──(|C| ≥ 2 in window)──▶ AMBIGUOUS ──(fan signs SupportFinalize naming one)──▶ TX_CONFIRMING/CONFIRMED (mode ambiguous-finalized)
TX_SUBMITTED ──(receipt status 0x0)──▶ TX_FAILED (intent stays OPEN until expiry; fan may send again)
CONFIRMED|FINALIZED ──(reconcile: block hash replaced at that height)──▶ INVALIDATED_BY_REORG ──(same tx re-included)──▶ re-verify
```
Rules: `TX_FAILED` is informational (the intent remains OPEN); `CONFIRMED` can only be reached through §13 with the
public rule; **no admin endpoint can set CONFIRMED/FINALIZED**. The only privileged operation is the ops CLI
`early-ops.mjs receipt-suspend <receiptId>` which hides a receipt from public cards (moderation) and never creates or
alters one.

---

## 12. Wallet-rotation protocol

### 12.1 Requirements

Old manifests immutable (I-6); rotation requires (a) fresh YouTube OAuth re-verification and (b) a `CreatorManifest`
signed by the **new** wallet with `previousManifestHash` = current digest and `manifestVersion` = n+1; (c) a 48-hour
cooldown; (d) a visible warning on the creator page; (e) the current wallet can cancel; (f) a compromised old wallet
alone must not redirect payments; (g) a compromised Google account alone must not redirect payments without a window
in which the legitimate wallet holder can stop it.

### 12.2 Protocol

1. Creator opens `/labs/early/creator`, completes OAuth (§16.3) → creator session (2 h) bound to `channelId`.
2. Connects the **new** wallet, signs manifest v(n+1). Server checks: session channelId == manifest channelId;
   `previousManifestHash` == `currentManifestHash`; new wallet ≠ current wallet; accepted assets valid; nonce unused;
   creator not `ROTATION_LOCKED`.
3. `cas`: creator `status → ROTATION_PENDING`, `pendingManifestHash`, `rotation = {startedAt, effectiveAt: startedAt + 172800, newWallet, cancelledBy: null}`;
   manifest v(n+1) stored `PENDING`; attestations `creator-manifest(PENDING, effectiveAt)`.
4. Creator page shows: **"Receiving wallet change pending until <effectiveAt UTC>. Support sent before then goes to
   <current wallet>."** Intent drafts follow §7.3.
5. Cancel paths during cooldown:
   - `RotationCancel(string schema, bytes32 creatorId, bytes32 pendingManifestHash, uint256 issuedAt, bytes32 nonce)`
     signed by the **current** receiving wallet → `CANCELLED` manifest, `ROTATION_LOCKED` for 7 days. While locked, a
     new rotation needs creator sessions (fresh OAuth) on two distinct UTC days at least 24 h apart, the second one
     submitting the new manifest; the standard 48 h cooldown then applies. A second `RotationCancel` from the same
     wallet within 30 days is refused. This is the defence against a Google-account compromise (the wallet holder
     gets a stop and a delay) without letting a compromised wallet block the account holder forever.
   - Creator session (fresh OAuth) cancel → `CANCELLED`, no lock (the account holder changed their mind).
6. Activation: on the first request after `effectiveAt` (any read of the creator or the scheduled snapshot job),
   `cas`: current manifest `SUPERSEDED (supersededAt = effectiveAt, supersededBy)`, pending manifest `ACTIVE
   (effectiveAt)`, creator `ACTIVE` with `currentManifestHash` = new; attestations for both manifests and a new
   `creator-identity` for the new wallet. Old manifest and its attestations remain readable forever.
7. `PAUSED` is orthogonal: a creator who suspects the current wallet is compromised pauses immediately (session only,
   no wallet needed), then rotates; nothing new is sent to the old wallet during the cooldown.

### 12.3 Security analysis

| Attacker holds | Can they redirect future payments? |
|---|---|
| Old wallet only | No: rotation needs OAuth. The most it can do is `RotationCancel` one legitimate rotation, which costs the creator a 7-day lock and the two-session rule (§12.2 step 5); it cannot cancel a second time within 30 days. The OAuth holder is the identity; the wallet is disposable. Money sent meanwhile is protected by PAUSED. |
| Google account only | They can start a rotation to their wallet; it is visible for 48 h; the legitimate current wallet cancels it and locks. They can pause (denial of income, not theft). Detection: the creator page warning, and the creator's own dashboard. |
| New wallet (after rotation) | Payments go there. The creator rotates again (OAuth + another wallet, 48 h). No mechanism can recover funds already sent; SyncNet never held them. |
| Both Google account and current wallet | Out of scope; equivalent to being the creator. |

---

## 13. Daily audience snapshot rule and transaction matching

### 13.1 Snapshot rule (deterministic)

- Timezone convention: **UTC**, calendar day `D = YYYY-MM-DD` of the transfer's **block timestamp**.
- For every creator in `ACTIVE | PAUSED | ROTATION_PENDING`, `early-snapshot.js` runs at **00:05 UTC** and reads
  `channels.list(part=statistics,snippet, id=…)` in batches of 50 with the server API key. The first successful read
  of day D is **the** snapshot `S(D)`; it is recorded with its `fetchedAt`. If the run fails, it retries every hour
  during D; the first success wins; after 23:59 UTC no snapshot for D is ever created (a later value is never
  presented as D's).
- Enrolment snapshot: when a creator becomes ACTIVE at time T on day D and `S(D)` does not exist, the activation
  request takes `S(D)` immediately (same rule, same attestation type; `fetchedAt` = T).
- Receipt context uses `S(utcDate(blockTimestamp))`. Missing → `audienceThen.state = 'unavailable'`;
  `hiddenSubscriberCount` → `'hidden'`; else `'approximate'` with YouTube's value (YouTube already rounds counts to
  three significant figures publicly) rendered as `~1.2K`, `~15K`, `~1.2M`.
- Title in the snapshot is used for `creatorTitleThen`.

### 13.2 Public matching rule `syncnet.sync-proof.matching.v1`

Inputs: a stored intent `I` (typed data + signature), the chain. Output: the candidate set `C(I)`.

A log `L` in transaction `T` in block `B` is a **candidate** iff all hold:
1. `chainId == 4663` (`eth_chainId`).
2. `T`'s receipt has `status == 0x1`.
3. `L.address == I.token` (emitted by the canonical contract), `L.topics.length == 3`, `topics[0] ==
   keccak('Transfer(address,address,uint256)')`, `topics[1]` and `topics[2]` are zero-padded addresses.
4. `from(L) == I.sender` and `to(L) == I.receiver` (both from topics, lowercase).
5. `uint256(L.data) == I.amount` (exact raw amount; `data` is exactly 32 bytes).
6. `B` is canonical: `eth_getBlockByNumber(B.number).hash == receipt.blockHash` and `L.blockHash == receipt.blockHash`,
   `L.removed != true`.
7. `I.notBefore ≤ B.timestamp ≤ I.expiry`.
8. Confirmation: `B.number ≤ number(eth_getBlockByNumber('safe'))` for CONFIRMED; `≤ 'finalized'` for FINALIZED.
9. Signature validity: `I.signature` recovers to `I.sender` (or EIP-1271 for a contract sender), and `I.receiver ==
   manifest.receivingWallet` for the referenced `manifestHash`, whose creator-manifest attestation shows ACTIVE at
   `B.timestamp`.

`C(I)` = all candidates over the block range covering `[I.notBefore, I.expiry]`. Rules 1–8 are purely chain-derived;
rule 9 uses signatures and one anchored attestation.

Decision:
- `|C| == 1` → **finalise deterministically** (no further signature).
- `|C| == 0` → `EXPIRED` after `I.expiry` (before that: keep waiting). If a log satisfies 1–6 and 9 but with
  `I.expiry < B.timestamp ≤ I.expiry + 86400` → `RECOVERY_AVAILABLE`.
- `|C| ≥ 2` → `AMBIGUOUS`.

Cross-intent uniqueness: a `(txHash, logIndex)` can be bound to at most one receipt (`early:txlog:v1:<tx>:<idx>`
claimed inside the finalisation `cas`). With §7.3's disjoint windows this claim never has to arbitrate between two
valid intents; it exists only as a defence in depth.

### 13.3 Server implementation of the sweep (bounded, no unbounded log scans)

- Inputs: `intentId`, optional `txHash` hint.
- Block range: `fromBlock = I.createdBlock` (stored), `toBlock = min(head, blockAtOrAfter(I.expiry + 86400))` where
  `blockAtOrAfter` is estimated from head and the chain's observed block time then corrected by reading the block
  timestamp (2 reads). Robinhood Chain produces ≈10 blocks/s, so a 2 h window is ≈72,000 blocks.
- `eth_getLogs` with `address = I.token`, `topics = [Transfer, pad(sender), pad(receiver)]`, in chunks. **Task E-1
  result (29 Sep 2026, public RPC, `tests/live/early-rpc-capability.mjs`):** the RPC caps `eth_getLogs` by *result
  count* (10,000 logs), not by block range; the exact three-topic filter succeeded over 200,000 blocks in one ≈120 ms
  call. Block time ≈0.10 s, `safe` lag ≈12.5 min, `finalized` lag ≈19 min. The chunk size (`EARLY_GETLOGS_CHUNK`)
  therefore defaults to 50,000 (a 2 h window in 2 calls); the total call budget per verify is 24 (`bounded()`);
  exceeding it returns `202 VERIFY_DEFERRED` and the client retries later. The `txHash` hint is checked first with a
  targeted `eth_getTransactionReceipt` so the happy path costs ≤ 6 RPC calls; the sweep still runs once before
  CONFIRMED to rule out ambiguity, and again at FINALIZED. Late (recovery) candidates are accepted from the hint only,
  never from the sweep, so the outcome does not depend on the chunk size.
- For each candidate: rule 6 (canonical block) and 8 (safe/finalized) are checked with targeted reads.
- Any RPC failure → `503 chain_unavailable`, no state change.

### 13.4 Why the client's transaction hash is only a hint

The hash the wallet returned may be replaced (speed-up), dropped, or lost with the browser. The sweep finds the actual
transfer; the hint only shortens the happy path.

### 13.5 The server never uses the CURRENT audience, name or manifest for a historical receipt

Every derived context field cites the attestation it came from.

### 13.6 Audience snapshot storage

```
early:snap:v1:<channelId>:<D> = attestation record (audience-snapshot)
early:snap-days:v1:<channelId> = set of D
```

---

## 14. Finalization and recovery algorithm

### 14.1 `verify` (idempotent, permissionless by intentId)

```
verify(intentId, txHash?):
  I = load intent; if not OPEN/REORGED/AMBIGUOUS/RECOVERY_AVAILABLE → answer current state (idempotent)
  assertChain; C = sweep(I) (13.3)
  inWindow = C where rule 7 holds; late = candidates where expiry < ts ≤ expiry+86400
  if |inWindow| == 0:
     if now < expiry: if any candidate not yet safe → record observed (TX_CONFIRMING) → 202; else 202 WAITING
     elif late non-empty: state RECOVERY_AVAILABLE (store the late candidate list) → 200 {needsFinalize:true, candidates}
     else: state EXPIRED → 200
  if |inWindow| ≥ 2: state AMBIGUOUS (store candidates) → 200 {needsFinalize:true, candidates}
  if |inWindow| == 1:
     L = it; if L.block > safe → record observed → 202 PENDING_CONFIRMATION
     finalise(I, L, mode='auto', finalize=null)
```

### 14.2 `finalize` (only AMBIGUOUS / RECOVERY_AVAILABLE)

```
SupportFinalize(string schema, bytes32 intentId, bytes32 txHash, uint256 logIndex, uint256 issuedAt, bytes32 nonce)
```
Signed by `I.sender`. The server re-runs the sweep; the named `(txHash, logIndex)` must be in the stored candidate
list **and** still satisfy rules 1–6, 8 and 9 now (and rule 7 or the recovery window). Then `finalise(I, L,
mode='ambiguous-finalized'|'recovery-finalized', finalize=sig)`. The other candidates are left unbound: a transfer
without a receipt is still the creator's money (the UI says so plainly).

### 14.3 `finalise` (the critical transition, one `cas`)

```
expect: early:txlog:v1:<tx>:<idx> == null | intentId (re-inclusion after reorg)
        early:intent:v1:<intentId> == raw read
        early:receipt:v1:<receiptId> == null | previous INVALIDATED record
set:    txlog → intentId; intent → CONSUMED{receiptId}; receipt (CONFIRMED or FINALIZED); 
sadd:   early:receipts-of:v1:<sender>; early:receipts-of-creator:v1:<creatorId> (private; aggregate only)
```
Loser of a race re-reads and answers from the truth (idempotent), exactly as `project-home.js` does.

### 14.4 `reconcile` (permissionless by intentId; also run by the snapshot job for receipts < 24 h old)

Same as Project Home §5/§3: canonical block hash at the receipt height; replaced → `INVALIDATED_BY_REORG` (receipt
kept, intent `REORGED`, card hidden); `finalized ≥ height` → `FINALIZED`. Node views must agree (two reads) before
invalidating; missing data never invalidates.

### 14.5 Recovery UX

The receipt page is `/labs/early/receipt?intent=<intentId>`; the intentId is stored in `localStorage`
(`syncnet_early_intent_<creatorId>`), in the URL and on the "My EARLY" list (session). Opening it runs `verify`.
A manual "I sent it from another device" field accepts a tx hash hint. Nothing new on the server is needed for
recovery beyond `verify`.

---

## 15. Mobile flow

### 15.1 Reality check on the current wallet layer

`sn-wallet.js` supports injected EIP-1193 providers only (EIP-6963 + `window.ethereum`). A fan who taps a link in a
YouTube description on a phone lands in Safari/Chrome **without** an injected wallet. Two ways to proceed:

| Path | Signatures/returns | Dependencies | Chain 4663 |
|---|---|---|---|
| **A. Open inside the wallet app's browser** (universal links: MetaMask `https://metamask.app.link/dapp/<host>/<path>`, Coinbase Wallet `https://go.cb-w.com/dapp?cb_url=…`, Rabby, Trust `https://link.trustwallet.com/open_url?url=…`, Phantom `https://phantom.app/ul/browse/<url>?ref=<host>`) | 2 prompts, **no app switching between steps**: connect, sign, send all happen inside one browser | none (no new code, CSP unchanged) | `wallet_addEthereumChain` for MetaMask/Rabby/Trust works today (already used); Phantom does not add custom EVM chains (excluded on the chooser) |
| B. WalletConnect v2 / Reown AppKit from the system browser | 2 prompts, **3 app switches with returns** (connect, sign, send); the "return" step is the classic failure point | vendored bundle (~300 KB), `connect-src wss://relay.walletconnect.com https://…`, project id, session persistence | supported for wallets that accept custom chains via CAIP; per-wallet behaviour must be tested |

Decision for Phase 1: **Path A is the primary mobile path**; Path B is Phase 2 unless the Phase 1 device matrix (§15.4)
fails for the target wallets. Reasoning: A has zero return-failure surface and no new dependencies, and every step of
the frozen flow is preserved. The landing page detects "no injected provider on a mobile UA" and shows **"Open in your
wallet"** with the wallet chooser (deep links carrying the exact current URL including `creatorId`/`intentId`).
Desktop and in-wallet browsers proceed directly.

### 15.2 The tested sequence (with resume points)

```
tap link  →  /labs/early/c/<channelId>  (no wallet: "Open in wallet" chooser → same URL inside the wallet browser)
→ connect wallet (eth_requestAccounts; ensureChain 4663 → wallet_addEthereumChain if needed)
→ choose asset + amount → server draft → SIGN INTENT (prompt 1)  → POST store (retry-safe) → localStorage intentId
→ return (in-wallet: none; system browser: page resumes from localStorage/URL)
→ SEND TRANSFER (prompt 2): eth_sendTransaction {to: token, data: transfer(receiver, amount), value: 0x0}
→ return → txHash stored → verify polls (2 s, then 10 s, ≤ 15 min) → "Support confirmed" (SAFE)
→ receipt page; "Finalizing…" until FINALIZED; then "Make your EARLY card".
```
Every arrow is resumable: reload at any point re-enters at the correct state from `localStorage` + `verify`.
There is **no third signature** on this path. `SupportFinalize` appears only in AMBIGUOUS/RECOVERY.

### 15.3 Wallet prompt content

Prompt 1 shows the typed `SupportIntent` (creator id, receiver, token, amount, expiry, PRIVATE). Prompt 2 shows a
standard ERC-20 transfer to the token contract with the receiver and amount decoded by the wallet. The page shows the
same values above the button and the sentence: "You are sending directly to the creator's verified wallet. SyncNet
never receives or holds funds."

### 15.4 Phase 1 exit gate: device matrix (measured, not assumed)

| Wallet | iOS in-app browser | Android in-app browser | add chain 4663 | sign typed v4 | send ERC-20 |
|---|---|---|---|---|---|
| MetaMask Mobile | test | test | test | test | test |
| Rabby Mobile | test | test | test | test | test |
| Coinbase Wallet | test | test | test | test | test |
| Trust Wallet | test | test | test | test | test |
| Phantom (EVM) | expected fail (no custom chains) | expected fail | — | — | — |

Pass criterion: at least two wallets pass all cells on both platforms with the full sequence and both resume points.
Automated coverage: Playwright at 320/360/390/430 with the EIP-1193 mock (`tests/regression/rc-mobile.mjs` pattern)
for layout, resume and the two-prompt count; real-device passes recorded in `docs/early-device-matrix.md`.

---

## 16. Endpoints and storage

### 16.1 Routes (all JSON; `netlify.toml` + `_redirects` gain these lines)

| Route | Function | Purpose |
|---|---|---|
| `/api/early` | `netlify/functions/early.js` | Every read/write below (`?view=` / `{action}`) |
| `/api/early-youtube-auth` | `netlify/functions/early-youtube-auth.js` | OAuth start (302 to Google) and callback |
| scheduled `early-snapshot` (`5 * * * *`) | `netlify/functions/early-snapshot.js` | 00:05 UTC snapshots + hourly retries; rotation activation; reconcile of young receipts; OTS upgrades |
| scheduled `early-anchor` (`20 0 * * *` + hourly retry at `50 * * * *`) | `netlify/functions/early-anchor.js` | Build bundle D−1, anchor, OTS submit |
| `/labs/early`, `/labs/early/*` | `labs-early.html` (+ `labs-early.js`) | Fan surfaces and creator page (client-routed by path) |
| `/labs/early/creator` | `labs-early-creator.html` (+ `labs-early-creator.js`) | Creator onboarding, rotation, dashboard |

### 16.2 `GET /api/early?view=…` (rate: 120/min/IP)

| view | params | returns | auth |
|---|---|---|---|
| `config` | — | `{enabled, chainId, domain, assets, cooldownSeconds, intentWindowSeconds, keys: url}` | — |
| `keys` | — | key registry (attested) | — |
| `creator` | `channelId` or `creatorId` | `{onEarly:false}` **or** `{onEarly:true, creatorId, channelId, display, status, currentManifest:{manifestHash, receivingWallet, acceptedAssets, effectiveAt}, rotation:{pending, effectiveAt} \| null, paused}` | — |
| `manifest` | `manifestHash` | the immutable manifest record + attestations (no supporter data) | — |
| `resolve` | `yt` | `{channelId, title, avatarUrl, handle}` | rate 20/min/IP |
| `intent` | `intent` (id) | public intent state (`status, typedData, createdBlock, candidates?, receiptId?`) | capability (id) |
| `receipt` | `intent` or `receiptId` | the full receipt document (§8) | capability (id) |
| `mine` | — | `{intents:[…], receipts:[…], signals:[…]}` for the session wallet | **fan session header** |
| `card` | `shareId` | the public card view (§14.3 / §20) | — (public by design) |
| `bundle` | `date` | leaves, root, anchors | — |
| `me` | — | creator dashboard: status, manifests, rotation, `signalsWaitingAtJoin` | **creator session header** |

### 16.3 `POST /api/early {action:…}` (rate: 20/min + 200/h per IP, plus per-wallet buckets §18)

| action | body (exact fields; extras → 400) | signature / auth | effect |
|---|---|---|---|
| `count-me-in` | `channelId, fan, issuedAt, expiry, nonce, signature` | `CountMeIn` by `fan` | store/renew signal |
| `count-me-in-withdraw` | `channelId, fan, issuedAt, nonce, signature` | `CountMeInWithdraw` | withdraw |
| `intent-draft` | `manifestHash, sender, token, amount` | none (draft is unsigned) | returns typed data to sign + `intentId` |
| `intent-store` | `intentId, signature` | `SupportIntent` by `sender` | INTENT_STORED (cas) |
| `verify` | `intentId, txHash?` | none (capability) | §14.1 |
| `finalize` | `intentId, txHash, logIndex, issuedAt, nonce, signature` | `SupportFinalize` by sender | §14.2 |
| `reconcile` | `intentId` | none | §14.4 |
| `session` | `wallet, issuedAt, nonce, signature` | `EarlySession(string schema, address wallet, uint256 issuedAt, bytes32 nonce)` | 30-min fan session token (only for `mine`, `card-*`) |
| `card-create` | `receiptId` | fan session (wallet == receipt sender), receipt FINALIZED | creates `shareId`, default hidden; metric `card_generated` |
| `card-reveal` | `shareId, fields:['transaction'], issuedAt, nonce, signature` | `CardReveal(string schema, bytes32 shareId, string fields, uint256 issuedAt, bytes32 nonce)` by sender | Phase 2 (not built in Phase 1; schema reserved) |
| `card-event` | `shareId, event:'link_copied'` | fan session | metric `share_link_copied` |
| `creator-link` | `wallet, issuedAt, nonce, signature` | `CreatorLinkRequest(string schema, address wallet, uint256 issuedAt, bytes32 nonce)` | returns the OAuth start URL with a state bound to this wallet |
| `creator-manifest` | `struct fields…, acceptedAssets, signature` | `CreatorManifest` by `receivingWallet` **and** creator session for `channelId` | VERIFYING→ACTIVE, or → ROTATION_PENDING |
| `creator-pause` / `creator-resume` | — | creator session | PAUSED/ACTIVE |
| `rotation-cancel` | `creatorId, pendingManifestHash, issuedAt, nonce, signature` | `RotationCancel` by current wallet, or creator session | §12 |

### 16.4 OAuth (`early-youtube-auth.js`)

- `GET /api/early-youtube-auth?start=<stateToken>` → 302 to
  `https://accounts.google.com/o/oauth2/v2/auth?client_id&redirect_uri&response_type=code&scope=https://www.googleapis.com/auth/youtube.readonly&access_type=online&include_granted_scopes=false&prompt=select_account&state=<stateToken>`.
  `stateToken` = HMAC token (§19.2) `{wallet, nonce, exp: 10 min}` issued by `creator-link`.
- `GET /api/early-youtube-auth?code=…&state=…` → verify state (timing-safe, epoch, exp), exchange the code
  server-side (`oauth2.googleapis.com/token`, 5 s timeout), call `youtube/v3/channels?part=id,snippet,statistics&mine=true`,
  discard the access token, store `early:oauth:v1:<sid>` = `{wallet, channelId, title, avatarUrl, handle,
  subscriberCount, hidden, at}` (TTL 15 min), issue a **creator session** `{channelId, wallet, sid}` (2 h), and
  302 to `/labs/early/creator#s=<sessionToken>` (fragment: never logged, never sent to the server as a URL).
- No refresh token, no `offline` access, no scopes beyond `youtube.readonly`. Errors → 302 to
  `/labs/early/creator#e=<code>` with fixed codes (`denied`, `no_channel`, `state`, `unavailable`).
- Prerequisite (owner): a Google Cloud OAuth client (web), the exact redirect URI, YouTube Data API v3 enabled, the
  consent screen in **Testing** with the pilot creators' Google accounts as test users (the `youtube.readonly` scope
  is "sensitive"; full verification is not needed for ≤100 test users), and an API key restricted to YouTube Data API
  for the resolver and snapshots. Quota: `channels.list` costs 1 unit; the pilot uses < 500 units/day.

### 16.5 Sessions

- **Fan session** (`x-syncnet-early-session`): `EarlySession` typed signature → HMAC token `{scope:'fan', wallet,
  exp 30 min}`. Needed only for `mine`, `card-*`. Not on the happy path.
- **Creator session**: from OAuth; `{scope:'creator', channelId, wallet, exp 2 h}`; `creator-manifest`,
  `creator-pause/resume`, `rotation-cancel` (session variant), `me`.
- Token format and epoch revocation copy `upload-session.js` with secret `SYNCNET_EARLY_SESSION_KEY` (≥32 chars) and
  the shared `SYNCNET_SESSION_EPOCH`.

### 16.6 Key inventory (Upstash, prefix `early:`)

Listed in §5.5, §6.2, §7.4, §13.6, §14.3 plus:
```
early:oauth:v1:<sid>                 OAuth link record (15 min)
early:receipt:v1:<receiptId>         receipt document (immutable except status/finalizedAt/invalidated fields)
early:txlog:v1:<tx>:<logIndex>       claim → intentId
early:receipts-of:v1:<sender>        private index (session only)
early:receipts-of-creator:v1:<cid>   private index (aggregate metrics only; never served)
early:card:v1:<shareId>              {receiptId, revealed:[], createdAt, suspended}
early:card-of:v1:<receiptId>         shareId
early:att:v1:<id>                    attestation record
early:bundle-queue:v1:<D>            set of leaves (type|payload)
early:bundle:v1:<D>                  frozen bundle {leaves, root, anchors, ots}
early:bundles:v1                     set of D
early:metrics:v1:<name>:<D>          daily counters (INCR); verification-page visits deduped per (shareId, ipHash, hour)
early:yt:resolve:v1:<hash>           resolver cache (1 h)
early:rl:*                           via ratelimit.js (`rl:` prefix with bucket names `early-*`)
```
`early:ops:*` for the ops CLI (receipt/card suspension), no HTTP route.

### 16.7 Ops metrics view

`node netlify/ops/early-metrics.mjs` (like `project-home-suspension.mjs`): prints §20 aggregates from
`early:metrics:*` and the private indexes. No HTTP route in the pilot; nothing per-creator is public.

---

## 17. Gate and configuration

`flags.js` gains:
```
early: truthy(env.SYNCNET_EARLY_ENABLED) && durable && !truthy(env.SYNCNET_EARLY_DISABLED)
```
`config.js` exposes `early: f.early`. All EARLY functions answer `503 closed` / `{enabled:false}` unless `early` is on.
Writes additionally require `SYNCNET_EARLY_WRITES_DISABLED` unset (kill switch that keeps reads/verification alive).

Environment (all new, none reused from other products except the epoch and the RPC URL):
```
SYNCNET_EARLY_ENABLED=true
SYNCNET_EARLY_WRITES_DISABLED=false                (kill switch)
SYNCNET_EARLY_SESSION_KEY=<≥32 chars>              (sessions + OAuth state; NOT the attestation key)
SYNCNET_EARLY_ATTESTATION_KEY=<32-byte hex>        (secp256k1; address must match syncnet-early-keys.json)
SYNCNET_EARLY_ATTESTATION_KEY_ID=early-att-2026-09-k1
SYNCNET_EARLY_ANCHOR_KEY=<32-byte hex>             (gas-only key; address in syncnet-early-keys.json)
SYNCNET_EARLY_ANCHOR_DISABLED=false                (kill switch for the one server-sent transaction)
SYNCNET_GOOGLE_CLIENT_ID / SYNCNET_GOOGLE_CLIENT_SECRET
SYNCNET_YOUTUBE_API_KEY
SYNCNET_EARLY_OAUTH_REDIRECT=https://<site>/api/early-youtube-auth   (exact match required)
SYNCNET_SESSION_EPOCH                                (existing; revokes EARLY sessions too)
SYNCNET_RPC_URL                                      (existing; a private RPC is recommended for getLogs)
UPSTASH_REDIS_REST_URL / _TOKEN                      (existing; required)
```
Any missing prerequisite closes the feature and is logged once (`public-feature-closed`), like the other gates.
The attestation key's address is checked at start-up against the registry; mismatch → attestations disabled, writes
that would need one refused (`503 attestation_unavailable`), reads and verification unaffected.

---

## 18. Rate limits (durable, fail closed; existing production limits untouched)

| Bucket | Key | Limit |
|---|---|---|
| `early-read` | IP | 120 / min |
| `early-resolve` | IP | 20 / min, 200 / day |
| `early-write` / `early-write-h` | IP | 20 / min, 200 / h |
| `early-cmi-w` | fan wallet | 20 / day (signals + withdrawals) |
| `early-cmi-ch` | channelId | 500 / day (anti-flood of one channel's set) |
| `early-draft-w` | sender wallet | 30 / h |
| `early-draft-ip` | IP | 10 / min |
| `early-verify` | IP | 30 / min (each verify ≤ 24 RPC calls) |
| `early-session` | wallet | 10 / h |
| `early-card` | wallet | 20 / day |
| `early-card-view` | IP | 60 / min (verification pages) |
| `early-oauth` | IP | 5 / min, 30 / day |
| `early-creator-w` | channelId | 20 / day (manifests, pause/resume, cancels) |

Wallet buckets are consumed **after** signature verification, and replays/duplicates consume no quota (the pattern
enforced by the Economies static audit). Abuse prevention is not identity: the UI never calls a count "people".

---

## 19. Signing-key management and rotation

### 19.1 Keys

| Key | Purpose | Storage | Rotation |
|---|---|---|---|
| `SYNCNET_EARLY_ATTESTATION_KEY` (+ `_KEY_ID`) | signs attestations (§9) | env only | §19.3 |
| `SYNCNET_EARLY_ANCHOR_KEY` | sends the daily anchor tx | env only; balance ≤ 0.01 ETH | add a new address to the registry, move gas, retire the old |
| `SYNCNET_EARLY_SESSION_KEY` | HMAC sessions and OAuth state | env only | change value and bump `SYNCNET_SESSION_EPOCH` |
| Google client secret / YouTube API key | OAuth, Data API | env only | rotate in Google Cloud; redeploy |

`SYNCNET_UPLOAD_KEY` (the existing session secret) is **never** used by EARLY, and no session secret is ever used to
sign an attestation.

### 19.2 Key registry (`syncnet-early-keys.json`, git-reviewed, served at `view=keys`, anchored)

```
{ "schema": "syncnet.early.keys.v1",
  "attestation": [ { "keyId": "early-att-2026-09-k1", "address": "0x…", "validFrom": "2026-10-01T00:00:00Z", "validUntil": null, "status": "active" } ],
  "anchor":      [ { "address": "0x…", "validFrom": "…", "validUntil": null } ] }
```
Every change to this file produces a `key-registry` attestation signed by the **current** key (and by the new key
when one is added) in that day's bundle. Verifiers use the registry version whose attestation is anchored at or
before the attestation they are checking.

### 19.3 Rotation and compromise

- Planned rotation: add `k2` (validFrom = T), deploy with `k2`, later set `k1.validUntil = T + 24 h`. Attestations by
  `k1` in bundles anchored ≤ `validUntil` stay valid forever.
- Compromise of `k1` at time X (detected at Y): set `k1.validUntil = last trusted anchor time ≤ X`, deploy `k2`, and
  **re-issue** every attestation whose bundle was anchored after that time with `k2` (they are re-derived from stored
  facts: manifests, OAuth link records, snapshot values). Attackers cannot insert forged attestations into bundles
  already anchored before X, and everything after is re-signed. Fan/creator signatures and chain facts are untouched.
- Compromise of the anchor key: it can only send self-transfers; a forged "anchor" of a different root is detectable
  because bundles are also OTS-submitted and the stored bundle names the expected tx. Rotate the address in the
  registry.

---

## 20. Pilot metrics, success and kill criteria

Named honestly; all computed from private records as aggregates; none public per creator.

| Metric | Definition |
|---|---|
| `count_me_in_signals` | ACTIVE signals stored (deduped per (channel, wallet)) |
| `channels_with_signals` | distinct channels having ≥1 ACTIVE signal |
| `creators_claimed` | UNCLAIMED→ACTIVE transitions |
| `claims_with_signals_waiting` | claims where `signalsWaitingAtJoin ≥ 1` |
| `intents_drafted`, `intents_stored` | funnel |
| `receipts_confirmed`, `receipts_finalized` | receipts by mode (`auto`, `ambiguous-finalized`, `recovery-finalized`) |
| `intents_expired_unmatched` | expired with `|C|=0` |
| `cards_generated`, `share_links_copied`, `verification_page_visits` | as named; visits deduped per (shareId, ipHash, hour); never called "shares" |
| `repeat_supporters` | wallets with ≥2 FINALIZED receipts to the same creator; and to any creator (two numbers) |
| `distinct_supporting_wallets` | for funnel only; never shown as "people" |

Thesis checks (30 days, small creator set), owner may retune before launch:
- **A** ≥ 25 signals across ≥ 5 channels not on EARLY.
- **B** ≥ 50 % of invited creators who had ≥ 3 signals waiting claim within 7 days of invitation.
- **C** ≥ 20 FINALIZED receipts, `auto` mode ≥ 90 % of them.
- **D** ≥ 30 % of FINALIZED receipts produce a card; `share_links_copied ≥ 0.5 × cards`; `verification_page_visits ≥ 2 × cards`.
- **E** `repeat_supporters (same creator) ≥ 10 %` of supporting wallets.

Kill criteria (stop new intents, keep verification alive): any fund-redirection incident; any public leak of a private
relationship; `ambiguous + recovery` > 15 % of receipts (matching UX is broken); daily anchor failing > 3 consecutive
days; device matrix regresses below the §15.4 gate; Google OAuth unavailable > 48 h.

---

## 21. Failure and attack cases (expected behaviour)

| # | Case | Expected behaviour |
|---|---|---|
| 1 | Replayed `SupportIntent` signature (POST `intent-store` twice) | Same `intentId` → idempotent 200; a different draft with the same signature fails digest check (intentId is inside the signed struct). |
| 2 | Nonce reuse (any structure) | `early:nonce:v1:<wallet>:<nonce>` expected null inside the write `cas` → `409 replay`; no quota consumed. |
| 3 | Wrong chain (transfer on another chain) | Domain and struct bind 4663; the server asserts `eth_chainId == 0x1237` on every read; no candidate exists → EXPIRED. |
| 4 | Fake token with the same symbol | Identity is the contract address from the allowlist/manifest; rule 3 requires the log be emitted by that address; the UI never trusts `symbol()`. |
| 5 | Creator changes receiving wallet | §12: new manifest version, new wallet signature, fresh OAuth, 48 h cooldown, visible warning; old manifest immutable; intents against a to-be-superseded manifest expire no later than `effectiveAt`. |
| 6 | Compromised old creator wallet | Cannot rotate (needs OAuth). Creator pauses (session), rotates; a `RotationCancel` from the old wallet locks once, then two OAuth sessions ≥24 h apart override it (§12.3). |
| 7 | Compromised new creator wallet | Creator rotates again (OAuth + third wallet, 48 h). Funds sent to the compromised wallet are the creator's loss; SyncNet never held them and says so. |
| 8 | OAuth account mismatch (Google account owns channel X, creator claims Y) | `channelId` comes only from `channels.mine` in the callback record; manifest must name that channelId; otherwise `403 channel_mismatch`. |
| 9 | Handle change | Identity is the channel ID; display refreshed by the daily snapshot; historical receipts use the snapshot title of that day. |
| 10 | Duplicate matching transfers in one window | `AMBIGUOUS`; fan signs `SupportFinalize` naming one; the other stays a receipt-less direct gift (UI says so). |
| 11 | Transaction reverts | No Transfer log → not a candidate; intent stays OPEN until expiry; the fan may send again. `TX_FAILED` shown from the receipt status. |
| 12 | Transaction replacement (speed-up/cancel) | The sweep matches the actual mined transfer regardless of the remembered hash; a cancel produces no transfer → EXPIRED. |
| 13 | Chain reorg after CONFIRMED | `reconcile`: canonical hash differs (two agreeing reads) → `INVALIDATED_BY_REORG`; receipt kept, card hidden, intent `REORGED`; re-inclusion re-verifies (only the same tx is exempt from the window). |
| 14 | Browser closes after intent signing | Intent is stored server-side before the transfer is enabled; `localStorage` + URL carry the intentId; the client retries `intent-store` with the same signature if the POST was lost. |
| 15 | Browser closes after the transaction | The sweep finds the transfer without the hash; the receipt page (`?intent=`) resumes via `verify`. |
| 16 | Mobile deep-link return failure | Path A has no return step. For a system-browser session, the page resumes from `localStorage`; a "Recover" field accepts a tx hash. |
| 17 | Stale manifest (client caches an old `manifestHash`) | `intent-draft` refuses non-ACTIVE manifests (`409 manifest_not_active`) and returns the current one. |
| 18 | Manifest rollback (operator or DB restores an old manifest as current) | Manifest attestations (status, effectiveAt, supersededAt) are anchored; a receipt referencing the "restored" manifest fails §8 step 6 for any verifier; the creator page shows `currentManifestHash` which must have an anchored ACTIVE attestation newer than any SUPERSEDED one. |
| 19 | Attestation-key compromise | §19.3: retire with `validUntil`, re-issue, anchoring bounds the damage; fan/creator signatures and transfers cannot be forged. |
| 20 | Duplicate Count me in signals | One record per (channel, wallet); re-signing renews; counts are of records, not people. |
| 21 | Sybil signals (many wallets) | Not prevented; per-wallet/IP/channel rate limits bound flooding; copy never claims uniqueness. |
| 22 | Public-card privacy leakage | Default card: no wallet, no identity, no amount, no tx; the verification page serves only `revealed` fields + creator/date/audience + anchored public attestations; `card-reveal` is a separate signed action (Phase 2). Cards can be ops-suspended. |
| 23 | Merkle canonicalization mismatch (two implementations disagree) | Golden vectors in `tests/early/vectors.json`; leaves are hashes of canonical bytes only; a rebuild must reproduce the frozen root or the anchor job refuses to anchor and alerts (log `bundle-root-mismatch`). |
| 24 | Failed daily anchor | Bundle stays BUILT; hourly retry; receipts show "anchor pending"; kill criterion after 3 days. |
| 25 | OpenTimestamps submission failure | Recorded as `failed` per calendar; retried hourly for 48 h; never blocks the Robinhood anchor; wording never claims Bitcoin. |
| 26 | YouTube API unavailable | Snapshot retries hourly within the day; missing day → `unavailable` on receipts of that day; OAuth unavailable → onboarding closed with a fixed message; existing receipts unaffected. |
| 27 | Subscriber count hidden | `hiddenSubscriberCount:true` → `audienceThen.state='hidden'`, card shows "Audience then: hidden". |
| 28 | Snapshot missing for a day | `unavailable`; never backfilled from a later day; the enrolment snapshot covers the join day. |
| 29 | Rate-limit bypass (many IPs) | Wallet/channel buckets apply regardless of IP; signatures are required for every write that creates records; store outage fails closed. |
| 30 | Redis/data corruption or replay of an old snapshot | Nothing verifies from the DB: receipts re-verify from chain + signatures + anchored bundles; a restored DB missing receipts loses availability, not truth; the fan's downloaded receipt still verifies. |
| 31 | Two intents, same tuple, overlapping windows (pre-signed race) | §7.3 forbids overlap: one OPEN intent per tuple and `notBefore > lastExpiry`; `createdBlock` guard for the draft→store gap. |
| 32 | Backdated intent (fan signs an intent for a transfer already mined) | The server stores `createdBlock` at persist time and matching requires `block.number > createdBlock`, so the server never issues such a receipt. Independent verifiers cannot check ordering (§2 item 4) and the receipt says so; the creator must have been ACTIVE at the block time in any case. |
| 33 | Admin forces FINALIZED | No such endpoint; `finalise` is reachable only through the public rule; the ops CLI can only suspend. |
| 34 | Contract-wallet fan (Safe) | EIP-1271 verification via `sig-verify.js`; the transfer `from` is the Safe address; note: a Safe that changes owners can make old proofs stop verifying at the current block (documented, same as Marketplace). |
| 35 | Creator lists a token not in the allowlist / min amount absurd | `400 asset_not_allowed` / bounds; the allowlist is git-reviewed. |
| 36 | Fan sends the wrong amount (off by decimals) | Rule 5 is exact; no match; the UI shows the exact raw amount and human form from allowlist decimals; the transfer is still the creator's money; RECOVERY does not cover wrong amounts (deterministic rule). |
| 37 | Fan sends before signing (no intent) | No receipt is possible; the landing page says so before the transfer button appears (the button is disabled until INTENT_STORED). |
| 38 | Phishing site imitating `/labs/early` | Out of band; the manifest and intent name the creator's wallet, and the receipt verification names the SyncNet origin only as a reference; fans are told to send only to the wallet shown in the signed intent. |
| 39 | RPC returns inconsistent views (load-balanced nodes) | Canonical checks read twice before invalidating; sweeps re-run at FINALIZED; `503 chain_inconsistent` never changes state. |
| 40 | `safe`/`finalized` tags unsupported by the RPC | Fail closed (no CONFIRMED), logged; `SYNCNET_RPC_URL` must support them (Project Home already depends on this). |
| 41 | Google returns a channel with no `id`/for an account without a channel | `no_channel` error; no record. |
| 42 | Creator session stolen (fragment leaked) | Can pause/resume, start a rotation (48 h, cancellable by the wallet) and read the aggregate count; cannot move money instantly. 2 h TTL; epoch revocation. |
| 43 | Fan session stolen | Can list that wallet's private receipts/signals and create default (hidden) cards; cannot reveal fields (signature required); 30 min TTL. |
| 44 | Verification-page scraping to infer relationships | Cards carry no wallet; enumeration of `shareId` (128-bit random) is infeasible; rate-limited. |
| 45 | Clock skew between fan device and server | `issuedAt ±120 s` rule with a clear message; `notBefore` is server-set. |

---

## 22. Phased implementation plan

### Phase 1 (smallest viable pilot; behind the gate; every item has tests)

**A. Shared schema** — `lib/syncnet-early.js`: domain, all typed structures, `canonicalJson`, `hashJson`, validators,
leaf/Merkle helpers (pure), receipt canonicalisation, constants (windows, cooldown). Golden vectors.

**B. Server libs** — `netlify/lib/early-attest.js` (RFC-6979 signing on `Core.sign`, key registry check, attestation
records, bundle queue), `netlify/lib/early-merkle.js`, `netlify/lib/early-tx.js` (RLP + raw tx), `netlify/lib/early-session.js`,
`netlify/lib/early-youtube.js` (Data API + OAuth exchange, timeouts, no retries on 4xx), `netlify/lib/early-match.js`
(the public rule + bounded sweep), `netlify/lib/early-ots.js`.

**C. Functions** — `early.js`, `early-youtube-auth.js`, `early-snapshot.js`, `early-anchor.js`; routes in
`netlify.toml`/`_redirects`; `flags.js`/`config.js` gate; `included_files` for the new lib and JSON files.

**D. Pages** — `labs-early.html` + `labs-early.js` (landing, Count me in, creator page, support flow, receipt, My EARLY,
card + verification page) and `labs-early-creator.html` + `labs-early-creator.js` (OAuth, manifest, dashboard,
rotation with warning, pause). Consumer copy per §23. Link from `labs.html` ("Experiments · EARLY").

**E. Verification tooling** — `docs/early/verify-receipt.mjs` (dependency-free CLI using `lib/syncnet-core.js` and an
RPC URL) and `docs/early/PROTOCOL.md` (public rule text extracted from §8, §10, §13).

**F. Tests** — `tests/early/unit.test.mjs` (schemas, vectors, Merkle, RLP, RFC-6979), `tests/early/server.test.mjs`
(every §21 case that is server-side, atomic races on real Redis via the existing `redis-atomic` pattern),
`tests/early/matching.test.mjs` (rule 1–9 property tests incl. ambiguity/recovery/reorg), `tests/e2e/early-ui.mjs`
(happy path with exactly two wallet prompts, resume points, no third signature), `tests/regression/rc-early-mobile.mjs`
(320–430 px), `tests/static_audit.py` additions (§23 banned words, one `sendTransaction` in `labs-early.js` with
`0xa9059cbb`, no approvals, EARLY domain pinned, no `mp:`/`site:` keys in `early*.js`), and `tests/run-all.mjs` entries.

**G. Ops** — `netlify/ops/early-metrics.mjs`, `netlify/ops/early-ops.mjs` (suspend receipt/card), `docs/early/RUNBOOK.md`
(key generation, registry commit, Google setup, anchor funding, daily checks), `privacy.html` EARLY paragraph,
`docs/DEPLOYMENT.md` env table additions, `docs/early-device-matrix.md`.

**H. Phase 1 exit gate** — task E-1 (public RPC `eth_getLogs` range and `safe`/`finalized` support measured), the
device matrix (§15.4), all suites green, keys generated and registry committed, one canary creator (owner-controlled
channel) through the full flow on a Deploy Preview with a preview-only Upstash.

Deferred from Phase 1 (explicitly): `card-reveal`, WalletConnect (Path B), a notification for fans when a creator
joins, OTS proof download UI, creator display-name editing (never needed: it comes from YouTube).

### Phase 2 (after the pilot proves behaviour)
`card-reveal` with the coupled-fields explanation; WalletConnect if the matrix demands; fan notification on creator claim; ETH (native) support with a `value`-based rule
`syncnet.sync-proof.matching.v2`.

### Files Phase 1 adds

```
lib/syncnet-early.js
syncnet-early-assets.json
syncnet-early-keys.json
netlify/functions/early.js
netlify/functions/early-youtube-auth.js
netlify/functions/early-snapshot.js
netlify/functions/early-anchor.js
netlify/lib/early-attest.js
netlify/lib/early-merkle.js
netlify/lib/early-tx.js
netlify/lib/early-session.js
netlify/lib/early-youtube.js
netlify/lib/early-match.js
netlify/lib/early-ots.js
netlify/ops/early-metrics.mjs
netlify/ops/early-ops.mjs
labs-early.html
labs-early.js
labs-early-creator.html
labs-early-creator.js
docs/early/PROTOCOL.md
docs/early/RUNBOOK.md
docs/early/verify-receipt.mjs
docs/early-device-matrix.md
tests/early/vectors.json
tests/early/unit.test.mjs
tests/early/server.test.mjs
tests/early/matching.test.mjs
tests/early/fixtures.mjs
tests/e2e/early-ui.mjs
tests/regression/rc-early-mobile.mjs
```

### Files Phase 1 changes

```
netlify.toml            routes for /api/early, /api/early-youtube-auth; two scheduled functions; included_files
_redirects              /api/early*, /labs/early, /labs/early/* → labs-early.html
netlify/lib/flags.js    early gate
netlify/functions/config.js   expose `early`
labs.html               one link to /labs/early (secondary navigation only)
tests/static_audit.py   EARLY invariants (§23 banned words; single transfer send; domain; key prefixes)
tests/run-all.mjs       new suites
privacy.html            EARLY paragraph
docs/DEPLOYMENT.md      env variables
docs/ARCHITECTURE.md    one row per new function
```
No existing function, gate, rate limit, signature domain or storage key is modified.

---

## 23. Consumer language and banned words (enforced by the static audit)

Allowed framing: **EARLY · I WAS THERE WHEN.** Card lines: `ALICE` / `Supported Sep 28, 2026` / `Audience then: ~1.2K`
/ `SYNC Proof verified`. Creator copy: "17 signed interest signals were waiting when you joined."

Banned in `labs-early*.html/js` and EARLY server messages: `ROI`, `return`, `multiple`, `investor`, `investment`,
`early investor`, `Supporter #`, `rank`, `leaderboard`, `top supporters`, `people` (as a count), `verified supporters`,
`escrow`, `we hold`, `balance`, `withdraw`, `fee` (except "gas fee" in wallet help), `anchored in Bitcoin`.
Crypto jargon on fan surfaces is minimised: "wallet", "sign", "send" are allowed; "EIP-712", "Merkle", "attestation"
appear only on the verification details panel and in downloads.

---

## 24. Adversarial self-review (performed on this spec; material findings fixed above)

| # | Attack / weakness found | Resolution applied |
|---|---|---|
| R1 | **Backdated intent**: a fan could sign an intent today with `notBefore` in the past to claim an old transfer. | Server-side `createdBlock` guard at persist time (§7.4). An earlier draft of this spec also anchored intent digests daily; that was withdrawn on 29 Sep 2026 because a daily anchor does not order an intent against a same-day transfer (§10.3), and the receipt now states that ordering is not independently verifiable (§8). |
| R2 | **Overlapping windows** for the same `(sender, receiver, token, amount)` let one transfer match two intents, and the clock-skew allowance (`now − 60`) could reach into the previous intent's window. | One OPEN intent per tuple; `notBefore > lastExpiry`; `createdBlock` guard (§7.3). |
| R3 | **Receiver/token smuggling**: a client-built intent could name a receiver that is not the manifest wallet. | Server draft fills `receiver/token/chainId/creatorId`; `intent-draft` takes only `manifestHash, sender, token, amount`; extras → 400 (§7.2). |
| R4 | **Rotation via Google account alone** could redirect money. | 48 h cooldown, visible warning, `RotationCancel` by the current wallet; and PAUSED for the reverse case (§12). |
| R5 | **Rotation lock abused by the old (compromised) wallet** to block the real creator forever. | Lock is overridden by two OAuth sessions ≥24 h apart; a second cancel from the same old wallet is refused (§12.3). |
| R6 | **Third signature on the happy path** crept in through "list my receipts". | Listing moved to an off-path fan session; the happy path is intent + transfer only (§15.2, §16.5). |
| R7 | **Privacy of the hidden card vs. independent verification** were contradictory: hiding the tx hides wallet and amount, but then the public cannot verify the transfer. | Stated honestly: default cards are SyncNet-attested (with anchored public attestations shown); full independent verification requires revealing the transaction, a separate signed action (§2 item 5, §14.3, Phase 2 `card-reveal`). |
| R8 | **Unclaimed-creator inference**: deterministic `creatorId` lets anyone query whether signals exist for a channel. | `view=creator` returns an identical body/latency for unknown and unclaimed channels; no set reads on that path (§6.7). |
| R9 | **Intent-by-id read** exposes a private relationship to anyone with the id. | 256-bit server-generated ids treated as capabilities; never listed without a session; never in logs untruncated (§4.2). |
| R10 | **Merkle leaves containing fan data** would create a public support graph. | Leaves are creator attestations and unlinkable intent digests only; receipts and signals are never leaves (§10.3). Accepted leak: global daily intent count. |
| R11 | **Attestation key as the root of truth** (a verifier trusting SyncNet's signature for the transfer). | Receipt verification steps 1–3 need no SyncNet key; attestations are limited to identity/context and are anchored; the key-validity rule ties validity to anchor time (§9). |
| R12 | **Server-sent anchor tx violates the repo's "functions never sign" policy**. | Isolated single exception, self-transfer only, gas-only key, kill switch, documented in §0.4 and §10.5. |
| R13 | **`eth_getLogs` over a 2 h window** may exceed public RPC limits or the call budget. | Chunked, budgeted (24 calls), `202 VERIFY_DEFERRED`, hint-first happy path, Phase 1 task E-1 measures limits, private RPC recommended (§13.3). |
| R14 | **Late mobile transfers** (mined after expiry) would lose the receipt under a strict deterministic rule. | 2 h window plus a **recovery mode** bound by a fan signature within 24 h, still deterministic and public (§13.2, §14.2). |
| R15 | **Card before finality** could publish a card for a transfer later removed by a reorg. | Cards require FINALIZED; reorg hides the card (§11.3, §14.4). |
| R16 | **Later YouTube value presented as historical** if the snapshot job backfilled. | Snapshots never created after the day ends; enrolment snapshot covers the join day; missing → "unavailable" (§13.1). |
| R17 | **Manifest rollback** by a DB restore or operator. | Every status change is an anchored attestation; verifiers check ACTIVE/SUPERSEDED windows against `blockTimestamp` (§8 step 6, §21 #18). |
| R18 | **Payment-processor surface**: any server-side handling of amounts could look like intermediation. | SyncNet only stores an *intended* amount and reads the chain; no balances, fees, swaps, custody, or refunds; the only server-signed tx moves no value (§1, §0.4). |
| R19 | **Symbol-based token identity** in the UI. | Allowlist by address with reviewed decimals; the wallet prompt shows the contract; no live `decimals()`/`symbol()` on the payment path (§5.4). |
| R20 | **Session secret reuse** as an attestation key. | Separate `SYNCNET_EARLY_SESSION_KEY`, `SYNCNET_EARLY_ATTESTATION_KEY`, `SYNCNET_EARLY_ANCHOR_KEY`; start-up check against the registry (§17, §19). |
| R21 | **Ambiguity resolution via signature could be replayed** to bind a different log. | `SupportFinalize` names `txHash` and `logIndex`, carries a nonce, and the server re-validates the named log against the public rule at finalisation (§14.2). |
| R22 | **OAuth `state` fixation / CSRF.** | State is an HMAC token bound to the requesting wallet and a nonce, 10 min TTL, single use (`early:oauth-state:v1:<nonce>` consumed inside the callback `cas`) (§16.4). |

No contradiction preventing secure implementation was found. Two design tensions are recorded, not hidden: (1) hidden
cards are attested rather than independently verifiable (R7); (2) Path A mobile depends on wallets' in-app browsers
supporting chain 4663, which Phase 1 must measure (§15.4).
