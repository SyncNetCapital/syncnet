# SyncNet Project Home: secure foundation

Status: **foundation only, closed by default**. No UI, no navigation entry, and no deployed contract. No rate has been
approved and no treasury wallet has been supplied yet. Nothing is live until every step in "Enabling" below has been done deliberately.

A project already on Robinhood Chain (a PAR launch or a Pons V2 launch) has its origin and **Project Passport** resolved
by SyncNet. The **current Passport operator** can publish a structured, SyncNet-hosted page at `/site/<token>`,
labelled:

> **SYNCED WEBSITE · PASSPORT OPERATOR VERIFIED**

It is never labelled "official website". A Project Passport proves SyncNet-recognised operational authority. It does
not prove the identity of the historical or original team.

## 1. Economic model

| | |
|---|---|
| Product | PROJECT HOME · ONE-TIME ACTIVATION, per token/project |
| Price | **$12 USD** (`priceUsdCents 1200`, `priceVersion 2`: the ACTIVE public price; `priceVersion 1` = 3900 is kept as reviewed history and never selected) |
| Paid in | **$SYNC only** (`0x6368e007b9f0b941560ed1f3bceb20247f5eca37`, 18 decimals), chain 4663 |
| Conversion | SYNCNET REFERENCE RATE: server-controlled and versioned. It is **not an oracle** |
| Rate lock | 30 minutes, judged by the **block timestamp of the payment** |
| Split | 60% burned by `SYNC.burn()` on `settle()`. 40% allocated to the SyncNet protocol treasury, forwarded as SYNC to the treasury converter and **converted to USDG**. The treasury wallet receives **USDG only** |
| Refunds | none. Non-refundable after successful activation. There is no refund mechanism |
| Bound to | the **token**, never the payer. It is inherited through Passport transfer |
| Free after activation | edits, revisions, unpublish, republish, preset changes, adoption after a Passport transfer |
| Lifetime | active for as long as SyncNet operates the Project Home service |

Customer-facing copy (Phase 2): **"$12 one-time · Pay with $SYNC · ≈ X SYNC · SyncNet reference rate · locked for
30 minutes · 60% burned · 40% converted to USDG for SyncNet treasury."** Never promise a USDG amount (for example
"treasury receives $15.60"): the treasury receives whatever the conversion actually produces.

Two different rates are involved and must never be conflated:

- The **SYNCNET REFERENCE RATE** (reviewed, versioned) decides how much SYNC the customer pays for $12.
- The **ACTUAL DEX EXECUTION RATE** (the live PAR SYNC/USDG pool, after its ~2.1% fee and price impact) decides how much
  USDG the treasury later receives for its 40% allocation.

SyncNet's own projects (SYNC, SYNCAT, …) are not exempt. A complimentary entitlement exists only as an ops-level function
with no HTTP route (`grantComplimentary`). It is labelled `COMPLIMENTARY` and never counts as revenue, burn or treasury.

## 2. Pricing: fixed-point representation (`lib/syncnet-project-home-pricing.js`)

All arithmetic is BigInt. No floating point is used anywhere.

```
priceUsdCents   integer US cents                           1200   = $12.00
rateUsdE18      integer USD per 1 whole SYNC × 10^18         5e13   = $0.00005 / SYNC   (decimal string, <= 18 decimals)
amounts         integer SYNC wei (18 decimals)

baseSyncWei = ceil(priceUsdCents × 10^34 / rateUsdE18)          ROUND UP: never undercharges
```

Accepted ranges (anything outside fails closed): price 1 to 10,000,000 cents; rate $10^-12 to $10^6 per SYNC; a quote
must be at most 10^12 SYNC. A rate string must be canonical: no sign, no exponent, no trailing zeros, at most 7 integer
digits.

**Payment tag.** Concurrent payments to the one sink are distinguished by amount:

```
exactTaggedSyncAmount = roundUpTo(baseSyncWei, 10^12 wei) + tag,     tag ∈ [1, 10^12 − 1] from a CSPRNG
```

This gives the following properties:

- The exact amount is always greater than the base, so the tag never lowers the price.
- The surcharge is below 2 × 10^-6 SYNC.
- The tag occupies the 12 lowest decimals, and the full amount is shown as an exact 18-decimal string, e.g.
  `780000.000000482117093551` ($39 at an illustrative $0.00005/SYNC = 780,000 SYNC).
- The server reserves every exact amount with a set-if-absent key (`site:amt:v1:<wei>`) for longer than any window in
  which a payment could match it. Two live intents therefore never share an amount, and uniqueness does not rely on
  chance.
- The client never chooses the tag.

## 3. Rate provider (`syncnet-project-home-pricing.json` + `netlify/lib/project-home-config.js`)

**Decision:** the values live in a git-reviewed file, and the environment selects which reviewed version is active.

- Prices and rates exist **only** in `syncnet-project-home-pricing.json`, so every value change is a reviewed commit.
  Versions are immutable: to change a rate, add a new version and never edit an old one.
- (Superseded for rates by §18: the rate is now automatic.) The deployment selects `PROJECT_HOME_PRICE_VERSION`. It must also repeat
  `PROJECT_HOME_PRICE_USD_CENTS`, which has to equal the reviewed value. No environment variable can introduce a new
  number.
- Every rate has `effectiveAt` and `expiresAt`. An expired rate closes payments, which forces a periodic, explicit
  re-approval instead of silently charging a stale rate.
- On the first use of a version the server stores an immutable snapshot (`site:rate:v1:<v>`, `site:price:v1:<v>`). If
  the same version number later appears with different values, intent creation **fails closed** (`config_conflict`).
- A missing or expired rate keeps payments closed. The V3 canary ships exactly one short-lived rate (v1, §16).
- To replace the provider later (for example with a real oracle), implement the same `{rateVersion,
  syncUsdReferenceRate, rateUsdE18, rateEffectiveAt}` shape. The sink, the entitlement records, the activation registry
  and the site architecture do not change, because every intent and activation already records the exact rate and
  version it used.

Why not environment-only: a rate typed into Netlify's environment is not reviewable, not versioned in history, and
easy to mistype. The only thing this design adds is a redeploy per rate change, which is a benefit for an economic
parameter.

Wording is always "SYNCNET REFERENCE RATE · Version X · Updated <effectiveAt> · Locked until <expiresAt of intent>",
never "oracle price".

## 4. Payment sink and treasury converter (`contracts/project-home-sink/`)

### Lifecycle

```
customer pays the exact tagged SYNC amount (ONE transfer to the sink, no approval)
   │  server verifies the canonical SYNC Transfer at SAFE  ──▶  entitlement ACTIVE  ──▶  the site can publish
   ▼                                     (nothing below is required for activation or publication)
SyncNetProjectHomeSink       SYNC committed; 60% COMMITTED TO BURN              (state A)
   │  settle()  — permissionless, no parameters
   ├── floor(60%) ──▶ SYNC.burn()                    totalSupply decreases       (state B: BURNED)
   └── remainder  ──▶ SyncNetProjectHomeTreasuryConverter, as SYNC               (state C: awaiting conversion)
                           │  convert(amount, minUsdgOut, deadline) — ONLY the treasury wallet
                           ▼  PAR multi-market router · sellToQuotes · market 1 = PAR SYNC/USDG Uniswap v4 pool
                        USDG ──▶ SyncNet protocol treasury wallet (immutable)     (state D: USDG delivered)
```

### Sink: `SyncNetProjectHomeSink(address sync, address treasuryConverter)`

- Immutable `SYNC` and `TREASURY_CONVERTER` (both non-zero, and the converter must differ from the token) and a
  constant `BURN_PERCENT = 60`.
- `settle()` reads its whole balance and burns `floor(balance × 60 / 100)` with `SYNC.burn()`. It then transfers the
  remainder (40% plus every rounding residue) **as SYNC** to `TREASURY_CONVERTER`, and updates `totalSettledSync`,
  `totalBurnedSync` and `totalTreasurySyncForwarded`.
- It knows no USDG, router, pool, price or slippage. It still has no owner, admin, setter, rescue, proxy, arbitrary
  call, approval, payable function, receive or fallback.

### Converter: `SyncNetProjectHomeTreasuryConverter(sync, usdg, treasury, router, market)`

- Every constructor value is immutable. The constructor re-reads the live PAR factory and reverts unless `market` is
  the hook-less SYNC/USDG pool. Every conversion re-checks this, so a changed route fails closed.
- `convert(syncAmount, minUsdgOut, deadline)` is the **only** state-changing function:
  - it runs only if `msg.sender == TREASURY`;
  - `minUsdgOut` must be non-zero, and the deadline is enforced;
  - `syncAmount` can be at most the converter's SYNC balance, which allows partial or batched conversions;
  - it approves the router for exactly `syncAmount`, calls `sellToQuotes(SYNC, [{market, hops: [], syncAmount}],
    [minUsdgOut], address(this))` and resets the allowance to 0;
  - it measures the SYNC actually sold and the USDG actually received from its own balances, and enforces its own floor
    on that measured output (independently of the router);
  - it then transfers **all** USDG it holds to `TREASURY`.
- Anything that fails reverts the whole call and leaves the SYNC where it was. This covers a router revert, too little
  liquidity, a missed floor, an expired deadline, a changed route and a USDG transfer failure.
- There is no owner, setter, rescue, sweep, withdrawal, generic swap, recipient parameter, arbitrary call or payable
  surface. No function takes an address argument.
- Accounting: `totalSyncConverted` and `totalUsdgFromConversions` record real measured values. `totalUsdgDelivered` also
  includes any USDG sent to the converter directly, which is always forwarded to the treasury only. `pendingSync()` is
  the SYNC awaiting conversion.

### Executor and slippage model (why it is safe)

- The **treasury wallet itself is the only executor**: execution authority, not custody authority. It chooses when to
  convert, how much, the floor and the deadline. It cannot choose the route, pool, tokens or recipient, and it cannot
  withdraw SYNC.
- A third party cannot trigger a conversion at all, so nobody can force a dump at `minOut = 1`, and `minOut = 0` is
  refused outright.
- If the treasury key is compromised, the attacker can at worst convert at a poor floor into the wallet it already
  controls. It cannot redirect anything.
- If the treasury key is lost, the SYNC can no longer be converted, but it could not have been spent either. Rotating
  the treasury means deploying a new converter and a new sink (both immutable), then pointing
  `PROJECT_HOME_SINK_ADDRESS` at the new sink. Metrics then span both generations.
- Robinhood Chain orders transactions by a sequencer, and a fresh quote-based floor plus a short deadline bounds any
  sandwich.

**Operational procedure for one conversion (no new tooling needed):**

1. Quote by simulation from the treasury address. This is read-only and changes nothing:
   `cast call <converter> "convert(uint256,uint256,uint256)(uint256,uint256,uint256)" <amount> 1 <now+300> --from <treasury>`.
2. Send `convert(amount, quote × (1 − tolerance), now + 300)` from the treasury wallet.
3. If the market moved below the floor, the transaction reverts and nothing is lost.

### Route verification (26 Sep 2026, read-only)

- **USDG** is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. It is the `usdg` entry of PAR's SDK address book
  (pardotfamily/par-sdk `f5a5beb`, "all verified on Blockscout") and of this repo. It is also market 1 of the canonical
  SYNC launch. On-chain it reads `name()` "Global Dollar", `symbol()` "USDG" and `decimals()` 6; it is a 170-byte proxy
  (upgradeable by its issuer).
- **SYNC** is a live PAR multi-market launch in `multiFactory 0x3ea2…29C1` with two markets. `poolKeysFor(SYNC)[1]` is
  `(USDG, SYNC, fee 20000, tickSpacing 10, hooks 0)` in the Uniswap v4 PoolManager `0x8366…0951`. This is the PAR-created
  SYNC/USDG pool, and the route is **direct** (one hop).
- **Router:** `PairPadMultiRouter 0x458D2a59c2F3dd32775a64eE72004561440d64Df`. Its live runtime bytecode equals
  `pardotfamily/par` commit `ab64911` `src/v3/PairPadMultiRouter.sol` compiled with solc 0.8.26 via-IR (11,316 bytes).
  The only differences are the metadata hash and the four immutables, which are PoolManager, the multi-factory,
  SwapRouter02 and WETH. `sellToQuotes` looks the pool up from the factory itself, so a caller cannot name a pool. PAR's
  own SDK uses the same call for quote-market sells.
- **Fork rehearsal** (`fork/SinkFork.t.sol`, local, never broadcast) ran on real bytecode and state:
  - the sink burned exactly floor(60%) and totalSupply fell by that amount;
  - the converter received the exact remainder;
  - 800 SYNC converted to 0.038329 USDG, which went to the treasury fixture;
  - no USDG remained in the converter;
  - a stranger's conversion, and a floor one unit above the quote, both reverted.
- **Depth** (`fork/ConversionImpactFork.t.sol`), each size quoted from the same pre-trade state:

  | SYNC sold | USDG received | Price impact vs 1,000 SYNC |
  |---|---|---|
  | 1,000 | 0.047912 | (reference) |
  | 100,000 | 4.787648 | ≈0.1% |
  | 320,000 (≈ one $39 activation's treasury share) | 15.295168 | ≈0.2% |
  | 1,000,000 | 47.554593 | ≈0.75% |

  The pool fee is about 2.1%.

## 5. Payment state machine

```
                ActivationRequest (EIP-712, current Passport operator)
   (none) ───────────────────────────────────────────────▶ INTENT OPEN        (30-min lock, exact tagged amount)
                                                               │
      verify(requestId, txHash)  — targeted chain reads only   │
        not mined ................................. 202 NOT_MINED (retry any time)
        mined, not SAFE ........................... 202 PENDING_CONFIRMATION (intent.observed; blocks new quotes ≤ 6 h)
        mined after lock / before intent .......... 409 (never activates at the locked rate)
        mined in lock, SAFE ─────── ATOMIC CAS ──▶ entitlement ACTIVE (or FINALIZED if already final)
                                                               │  reconcile(token)  (permissionless)
                                              finalized ≥ block│               block hash replaced at that height
                                                               ▼                               ▼
                                                          FINALIZED                  INVALIDATED_BY_REORG
                                                                                   (history kept; publication off;
                                                                                    the SAME request re-verifies
                                                                                    if the tx is re-included)
```

Verification checks, all server-side:

1. the intent exists;
2. the receipt exists;
3. `status == 0x1`;
4. `eth_chainId == 0x1237`;
5. the block exists and its canonical hash equals the receipt's block hash;
6. a log **emitted by the canonical SYNC contract** has the exact Transfer topic layout;
7. its recipient is the configured sink;
8. its amount equals `exactTaggedSyncAmount`;
9. that log has not been claimed;
10. `block > createdBlock`, and the block timestamp lies within `[createdAt − 120 s, expiresAt]`;
11. the block is at or below the `safe` tag;
12. no paid entitlement already exists.

The client's decoded receipt, logs, amount, token or sink are never trusted.

**Finality policy:** a payment becomes usable at SAFE, which on Robinhood Chain was about 8 minutes behind head when
checked live. It is rechecked to FINALIZED (about 15 minutes) by `reconcile`. The lock is judged by block time, so
waiting for SAFE never pushes a timely payment out of its window.

## 6. Atomicity: why one payment cannot activate two projects

The critical transition is **one** `store.cas()` call: a single fixed Lua script executed with `EVAL`. Redis runs a
script atomically, with no other command interleaved.

```
expect  site:paylog:v1:<tx>:<logIndex>  == (absent | this requestId after a reorg)
expect  site:entitlement:v1:<token>     == the value read (absent | INVALIDATED_BY_REORG record)
expect  site:intent:v1:<requestId>      == the exact raw value read (OPEN | REORGED)
set     paylog = requestId · entitlement · intent CONSUMED · site:act:v1:<tx>:<logIndex>
sadd    site:acts:v1 · site:acts:v1:<token> · site:audit:v1:<token>
```

- A log can be claimed by at most one request (the `paylog` expectation), and a request belongs to exactly one token.
  So one payment cannot activate two projects, even if two intents somehow shared an amount. This is tested with 24
  concurrent verifications on real Redis.
- A token can be activated at most once (the entitlement expectation).
- There is no partial state. Either all keys are written or none are. A crash or store failure before the commit
  changes nothing, and a retry of the same `(requestId, txHash)` succeeds. A crash after the commit is answered as an
  idempotent success.
- Concurrent identical verifications produce one activation. Every loser re-reads and answers from the truth
  (idempotent 200, `payment_already_used` or `already_active`).
- Stale replica reads (for example on Upstash Global) can only make a CAS fail, which means a retry. They can never
  make it succeed wrongly.

The in-memory adapter implements the same semantics in one await-free block. `tests/project-home/redis-atomic.test.mjs`
runs the production Upstash adapter against a real `redis-server`, and checks that the Lua script and the in-memory
adapter agree over 400 random multi-key operations.

**Requirement:** the Upstash database must accept multi-key `EVAL`, which the standard single-region and Global Upstash
databases do.

## 7. Entitlement

`site:entitlement:v1:<token>` holds these fields:

- `status` (`ACTIVE` | `FINALIZED` | `INVALIDATED_BY_REORG`) and `kind` (`paid` | `complimentary`)
- `chainId`, `txHash`, `logIndex`, `blockNumber`, `blockHash`, `payer`, `sink`, `canonicalSync`
- `exactAmount`, `baseSyncAmount`, `priceUsdCents`, `priceVersion`, `syncUsdReferenceRate`, `rateVersion`
- `requestId`, `activatedAt`, `safeAt`, `finalizedAt`, `operatorAtActivation` (**history only**)
- `previous`: the prior invalidated payment, if any

Site suspension or takedown is a separate matter. Unpublishing, Passport transfer and suspension never touch the
entitlement.

## 8. Project Home model (`lib/syncnet-site.js`)

- Presets: CLEAN, DARK, TERMINAL. Accent: a fixed palette.
- Headline: at most 80 characters. About: at most 800 characters, plain text.
- Logo and hero: sanitised-image CIDs only.
- Social handles: X, Telegram, Discord, Farcaster. SyncNet builds the URLs.
- One CTA with a fixed label and an https destination.
- Fixed section order: Hero, About, Token Facts, Origin / Markets, Socials, Project Passport. Sections can be toggled
  but not reordered.

Unknown fields are rejected, never dropped. That covers HTML, CSS, JS, iframes, embeds, SVG, lore, FAQ, analytics and
domains.

EIP-712 domain `{name: 'SyncNet Website', version: '1', chainId: 4663}` has three types:

- `SitePublish(token, operator, configHash, issuedAt, nonce)`
- `SiteUnpublish(token, operator, issuedAt, nonce)`
- `ActivationRequest(token, operator, issuedAt, nonce)`

Marketplace and Economy signatures cannot be replayed here, and these cannot be replayed there.

URL policy:

- https only;
- ASCII only, so an IDN must be entered and is **displayed** in its `xn--` form, with a notice;
- no userinfo, no port, no IP literal (including decimal and hex forms), no reserved suffixes;
- at most 300 characters.

Operator text may not contain authority claims such as "official website" or "verified by SyncNet". These are matched
on confusable skeletons. Operator text also may not contain control, bidi, zero-width, invisible or private-use
characters.

**Renderer:** it is pure and emits zero JavaScript. It uses one static stylesheet, allowed by its SHA-256 hash, and
never a `style=` attribute. Every value is escaped, and `:` is entity-encoded in text nodes, so no user value can
spell `javascript:` or `data:`. The verified identity header (name, ticker, contract, origin, Passport) always comes
first and is never operator-editable. Operator content is labelled "Written by the Passport operator". An on-chain
website field is shown as text and never as a link.

`/site/<lowercase-token>` is sent with this CSP:

```
default-src 'none'; style-src 'sha256-…'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

It also sends `nosniff`, `X-Frame-Options: DENY`, `no-referrer` and `cache-control: no-store`.

Images come from `/site-img/<cid>`. That route serves only CIDs recorded by the upload sanitizer, and only when the
bytes fetched from the pinning gateway hash to the SHA-256 recorded at sanitisation. It serves them with an exact
PNG/GIF type and a sandbox CSP.

**Preview:** `render({mode: 'preview'})` shows a `PREVIEW · NOT PUBLISHED` watermark, sets noindex, implies no
authority and makes no link clickable. It is meant for the browser. The server never stores or serves a preview.

## 9. Authority and Passport transfer

- **Write time:** the signer must equal the current `mp:passport:v1:<token>` operator. The Passport's raw value is an
  expectation inside the same atomic CAS as the write, so a transfer that lands between the check and the commit
  aborts the write (`409 conflict`).
- **Render time:** on every request, the revision signer is compared with the current operator.

After a transfer:

- the entitlement stays and no payment is due;
- the page shows `SYNCED WEBSITE / PUBLISHED BY PREVIOUS OPERATOR · AWAITING CONFIRMATION` and is noindex;
- **every operator-authored external link (CTA, X, Telegram, Discord, Farcaster) is rendered with no `href` at all**,
  while text and verified facts remain;
- the old operator fails every write immediately;
- the new operator adopts the exact current config with a new `SitePublish` signature. This is free.

Authority never derives from the payer, a holder, the deployer, the fee recipient after a Passport exists,
`operatorAtActivation`, or social accounts.

## 10. Storage keys (Upstash; no second database)

| Key | Content |
|---|---|
| `site:intent:v1:<requestId>` | payment intent (90-day TTL; activations are copied to the registry) |
| `site:intents:v1:<token>` | set of the token's intent ids (recovery after a browser crash) |
| `site:open:v1:<token>` | the one open intent (TTL 30 min) |
| `site:amt:v1:<wei>` | exact-amount reservation (TTL 44 min) |
| `site:rate:v1:<v>`, `site:price:v1:<v>` | immutable first-use snapshots |
| `site:paylog:v1:<tx>:<logIndex>` | payment-log claim → requestId |
| `site:entitlement:v1:<token>` | entitlement |
| `site:act:v1:<tx>:<logIndex>` | immutable activation registry record |
| `site:acts:v1`, `site:acts:v1:<token>` | registry indexes (exportable: `GET ?view=activations`) |
| `site:audit:v1:<token>` | append-only audit events (activated, finalized, invalidated, publish, adopt, restore, unpublish) |
| `site:comp:v1` | complimentary grants (never revenue) |
| `site:cfg:v1:<configHash>` | content-addressed config |
| `site:rev:v1:<revisionId>` | immutable revision: config, facts snapshot, signer, signature, issuedAt, nonce, configHash |
| `site:cur:v1:<token>` | current pointer or tombstone |
| `site:revs:v1:<token>` | revision index |
| `site:nonce:v1:<wallet>:<nonce>` | replay protection (90 days) |
| `site:img:v1:<cid>` | sanitised-image allowlist (sha256, type, size) |
| `mp:passport:v1:<token>` | **read only**: owned by the Marketplace |

## 11. Metrics (`GET /api/project-home?view=metrics`)

| Metric | Source |
|---|---|
| Project Homes activated | the activation registry. Complimentary grants and reorg-invalidated activations are excluded |
| SYNC paid for verified activations | the registry sum of exact amounts |
| Activations by rate version | the registry |
| SYNC currently in the sink | `SYNC.balanceOf(sink)` (committed, not burned) |
| SYNC actually burned | the sink's `totalBurnedSync` (executed `SYNC.burn()`) |
| SYNC forwarded to the treasury converter | the sink's `totalTreasurySyncForwarded` |
| SYNC awaiting treasury conversion | `SYNC.balanceOf(converter)`. The converter address is read from the sink's immutable `TREASURY_CONVERTER` |
| SYNC actually converted | the converter's `totalSyncConverted` |
| USDG actually delivered to the SyncNet treasury | the converter's `totalUsdgDelivered` (6 decimals), with `totalUsdgFromConversions` shown separately as swap output only |
| Unattributed sink inflow | `totalSettledSync + balance − verified payments`. Shown only when non-negative |
| Unsolicited converter inflow | `totalSyncConverted + pending − totalTreasurySyncForwarded`. Shown only when non-negative |

USDG is **never** computed from the reference rate. There is no "$15.60 per activation" figure anywhere, because only
real on-chain output is reported. The sink and the converter process every token they receive, so the metrics never
claim that all burned SYNC or all USDG came from Project Home customers. Conversion output cannot be attributed per
activation, because allocations are pooled before they are converted.

## 12. Configuration

```
SYNCNET_PROJECT_HOME_ENABLED=true            # default: closed (site reads/writes, /site, /site-img)
SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED=true   # default: closed
PROJECT_HOME_PRICE_VERSION=2
PROJECT_HOME_PRICE_USD_CENTS=1200            # must equal the reviewed price ($12, price version 2)
PROJECT_HOME_SINK_ADDRESS=<deployed sink>    # no default
SYNCNET_RPC_URL=https://…                    # preferred private RPC (public RPC works for development)
UPSTASH_REDIS_REST_URL / _TOKEN              # durable store (required)
```

If any of these is missing or inconsistent, payments stay closed. Without the durable store, everything is closed.

**Payment deployment validation (before every quote).** `PROJECT_HOME_SINK_ADDRESS` must also be listed in the
git-reviewed `syncnet-project-home-deployment.json` (with its converter). That file pins the canonical SYNC, USDG, PAR
router and market 1, the approved SyncNet Protocol Treasury, and immutable-aware code fingerprints of the audited build.
Before any quote (new or re-served), `netlify/lib/project-home-deployment.js` verifies on-chain, within 12 RPC reads:
chain 4663; the sink and the converter have code whose runtime — with every immutable range zeroed — hashes to the
audited fingerprint; every immutable word in the deployed code equals the reviewed value; sink `SYNC()`,
`BURN_PERCENT() == 60`, `TREASURY_CONVERTER()`; converter `SYNC()`, `USDG()`, `ROUTER()`, `MARKET() == 1`,
`TREASURY()`. A PASS is cached for 10 minutes per exact configuration; a FAIL (including any RPC failure) is remembered
for 30 seconds and never becomes a pass. Until it passes, no quote is issued, no intent is stored, and the config view
exposes no payment recipient (`sink: null`, `payments: false`). Why both bytecode identity and getters: the fingerprint
proves the code is exactly the audited build, the getters prove the live contract answers as reviewed. The fingerprints
are checked against a fresh compilation (`tests/project-home/code-fingerprint.mjs`) and against code produced by the
real constructors (`contracts/project-home-sink/test/CodeFingerprint.t.sol`).

## 13. Enabling (not done in this phase)

1. Create a **dedicated** SyncNet protocol treasury wallet. A simple EOA is acceptable for V1; it must never be a
   founder or deployer wallet. Supply its address.
   **Approved intended V1 treasury (public address only; supplied by the owner, not yet used anywhere on-chain):**
   `0x65FAc39A7A672afEbba404aecdDB34a1Eddc879B`. It is deliberately NOT written into any contract, script default or
   application code: it is passed only as `TREASURY` / `TREASURY_CONFIRM` at deploy time. Read-only checks on
   26 Sep 2026: valid EIP-55 checksum; Robinhood Chain `eth_chainId` = `0x1237` (4663); `eth_getCode` = `0x` (no code:
   a plain EOA); nonce 0; balance 0. Repeat all four checks immediately before deploying. **Deployment stays blocked
   until the owner explicitly authorises it.** SyncNet never requests or stores a private key or seed phrase.
2. Deploy with `script/DeployProjectHome.s.sol`, which deploys the **converter first**, then the **sink pointing at
   it**. It requires `CHAIN_ID=4663`, the canonical `SYNC`, `USDG` and `PAR_MULTI_ROUTER`, `SYNC_USDG_MARKET=1`,
   `TREASURY` plus `TREASURY_CONFIRM`, and `TREASURY_EXPECT_EOA` (1 = plain wallet, which must have **no code** — this
   also refuses an EIP-7702 delegated account; 0 = contract wallet, which must have code; no default). It refuses the
   deployer and any infrastructure address as treasury. The converter constructor re-verifies the live route, and the
   script re-reads every immutable after deployment.
3. Verify both contracts on Blockscout.
4. Add the deployed `{sink, converter}` to `syncnet-project-home-deployment.json` in a reviewed commit, then set
   `PROJECT_HOME_SINK_ADDRESS` to that sink. The server verifies the pair on-chain before it quotes any payment.
5. Review and commit the first SYNC/USD reference-rate version, with `effectiveAt` and `expiresAt`.
6. Canary on a preview deploy with the flags on, using the Phase 2 UI (section 14).
7. Only then enable production.

Conversion is never part of activation. The treasury converts at its own cadence, in batches, with a floor.

## 14. Product UI (Phase 2)

Global navigation is **Explore / Create / You**. SYNC means one thing: **SYNC PROJECT** = verify control and establish
the Project Passport (the existing Marketplace `OperatorClaim`, a free EIP-712 signature the server re-verifies against
the live factory record). A Project Home is reached from the Project Page's HOME row and edited in
`/home-editor.html?token=0x…` (Edit → Activate → Publish).

### Browser-only preview (how, and why the CSP is unchanged)

The editor renders the draft with **the same pure renderer** the server uses — `SyncNetSite.render({config, facts,
authority, mode: 'preview'})` — and writes the HTML into `<iframe sandbox="allow-same-origin" srcdoc>`:

* **No script can run.** The sandbox grants no script permission, and the renderer emits zero JavaScript anyway. Forms,
  popups, top-level navigation and plugins are blocked by the sandbox as well.
* **Same origin only for images.** `/site-img/<cid>` answers with `Cross-Origin-Resource-Policy: same-origin`; an
  opaque-origin sandbox would be refused. Keeping that image policy strict mattered more than a fully opaque preview.
* **The page CSP is untouched.** A `srcdoc` document inherits the embedding page's CSP (`default-src 'self'; script-src
  'self'; img-src 'self' …`), so the preview is bound by the same policy; the E2E suite serves the editor with the exact
  `netlify.toml` header and asserts zero CSP violations.
* **Not published.** Preview mode adds the `PREVIEW · NOT PUBLISHED` watermark and `noindex`, never makes a link
  clickable, and the document has no URL (`about:srcdoc`): nothing is stored or served by SyncNet. Project facts in the
  preview are read by the browser from Robinhood Chain; at publish time the server reads its own.
* **Images** go through the existing path only: `/api/upload-auth` (wallet `personal_sign` session) → `/api/ipfs-upload`
  (decode, re-encode, strip metadata, pin, record `site:img:v1:<cid>`). Only a CID returned by that sanitizer enters the
  config, and `publish` refuses any CID that is not recorded.

### Payment UX, recovery and finality

`QUOTE READY → PAYMENT SEEN (confirming) → ACTIVATED → FINALIZED (later)`.

* The quote is a signed `ActivationRequest`; the server returns the exact tagged amount and a 30-minute lock. The UI
  shows the amount, the sink, the SYNCNET REFERENCE RATE, a countdown and the warning *"Send only the exact quoted amount
  before the quote expires. Late or duplicate payments cannot be automatically refunded."* It refuses to start a payment
  in the last 90 seconds of the lock, and refuses any quote whose sink, token, chain or asset differ from the served
  configuration.
* One ERC-20 `transfer(sink, exactAmount)` on canonical `$SYNC`. The tx hash is remembered in this browser
  (`syncnet_home_pay_<token>`) so a second transfer for the same quote is never offered.
* **Leave and return.** On load the editor resumes from (1) this browser's tx record, or (2) the server's own
  request state — `view=status` returns the open intent and, once a payment was seen, its `observed.txHash` (while the
  30-minute open pointer lasts) — so a payment made from another device is picked up too. A manual *Recover a payment* field checks a pasted tx hash
  against the project's recent requests. All of this calls the existing idempotent `verify`; nothing new on the server.
* **Finality is UI-triggered.** While an operator has the editor open, it calls the permissionless `reconcile` action
  (about once a minute, bounded) to move ACTIVE → FINALIZED, or to record an invalidation after a reorg. Trade-off: no
  scheduled job exists yet, so an entitlement advances only when someone opens the editor (or calls `reconcile`).
  Activation never waits for it — publishing needs SAFE only — and nothing is lost meanwhile; a scheduled reconciler
  is listed as a production blocker.

### Adoption

After a Passport transfer, the previous operator's home shows *Awaiting confirmation* to visitors, and its links stay
disabled (render-time authority check). The new operator sees **REVIEW & ADOPT**: a preview of that exact version and one
**ADOPT HOME** action — a fresh `SitePublish` over the stored `configHash`. There is no payment (the entitlement belongs to
the token) and no transaction. The previous operator can no longer edit (the server checks the current operator at write
time; the editor shows why).

### Backend changes made for the UI (additive, read-only)

* `GET /api/marketplace?view=passports&tokens=…` (≤100): batch sync/control state for list rows.
* `GET /api/marketplace?view=wallet` additionally returns the Passports that wallet **currently** operates.
* `GET /api/project-home?view=homes&tokens=…` (≤100): batch HOME state (`live | awaiting | unpublished | paused | none`).

No write path, signature domain, atomic transition, entitlement or image rule changed.

## 15. V3 canary deployment (Robinhood Chain 4663) — deployed, payments still OFF

| | Address | Transaction | Block |
|---|---|---|---|
| Treasury Converter | `0xd917bd053d3152e6de10ad8279ddbaf20302a403` | `0x47365dce78ed9cb1c7ecc17583c90680042ebeed4296d564f113059677ea5572` | 73343761 |
| Project Home Sink | `0xc32fb194a0a2bc5fa313febd2de5096ca467213d` | `0x70b7e2069e8c989bac4a6f5e99e5c8196025f3fd452dfe4dae56953e28eb7575` | 73343786 |

Deployer `0xd0ef7d4ffffaf82f59e105c40ea97d8857b633c3` (converter nonce 0, then sink nonce 1). Treasury
`0x65FAc39A7A672afEbba404aecdDB34a1Eddc879B` (EOA, no code). Verified on-chain: both creation inputs equal the audited
initcode plus the exact constructor arguments; the reviewed validator passes (immutable-aware runtime fingerprints,
every immutable word, every getter: converter SYNC/USDG/ROUTER/MARKET=1/TREASURY, sink SYNC/BURN_PERCENT=60/
TREASURY_CONVERTER). Recorded in `syncnet-project-home-deployment.json`. Blockscout source verification could not be
submitted from the CI environment (Cloudflare challenge); run `forge verify-contract --verifier blockscout` from an
operator machine. Payments stay CLOSED on every deployment until the preview-only configuration of §16 is set.

## 16. First SYNCNET REFERENCE RATE (v1) and the preview-only canary configuration

**Rate v1 = 0.0000457 USD per SYNC** (≈ 21,881.84 SYNC per USD). Valid 2026-09-26T20:15:00Z → 2026-09-27T02:15:00Z
(6 h). The 30-minute quote lock is unchanged. This is a canary SYNCNET REFERENCE RATE, not an oracle.

Derivation (read-only, bounded): the canonical PAR SYNC/USDG market 1 (PoolManager `0x8366…0951`, pool
`0xeaff358a…13792`, dynamic fee 2.098%) at block 73363740 (2026-09-26T20:19:11Z). Mid from `sqrtPriceX96`
= 0.00004572 USD/SYNC. A simulated 1,000-SYNC sale executes at 0.000044761 USDG/SYNC, which is the mid less the fee. The last
swaps printed 4.52e-5–4.57e-5 over ~1.5 h and 4.90e-5 ~5 h earlier (−7%). Depth: an 800k-SYNC sale adds ~0.6% price
impact. Activity is thin (14 swaps in ~5.5 h). The mid is rounded **down** to 0.0000457 so SyncNet charges slightly more
SYNC, never less.

$39 at v1 = base **853,391.684901531728665208 SYNC** (rounded up). Each quote adds a random tag of less than 2×10⁻⁶ SYNC.

Rules: re-check the live mid immediately before the canary payment. If it moved more than 3%, or the rate has expired, add
rate v2 (never edit v1) and redeploy the preview. An expired rate closes payments automatically.

Preview-only configuration (Netlify UI → Environment variables → scope to **Deploy Previews / branch deploys of
`feature/syncnet-project-home` only**; production values stay unset; `netlify.toml` is not used for these):

| Variable | Value |
|---|---|
| `SYNCNET_PROJECT_HOME_ENABLED` | `true` |
| `SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED` | `true` |
| `PROJECT_HOME_PRICE_VERSION` | `2` |
| `PROJECT_HOME_PRICE_USD_CENTS` | `1200` (price version 2, $12) |
| `PROJECT_HOME_RATE_VERSION` | obsolete since §18 (automatic rate); leave unset |
| `PROJECT_HOME_SINK_ADDRESS` | `0xc32fb194a0a2bc5fa313febd2de5096ca467213d` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | a durable store (preferably a preview-only database) |

### Rate v2 (2026-09-27), replaces the expired v1 for the canary

v1 expired at 02:15Z and is kept unchanged. **Rate v2 = 0.0000409 USD per SYNC** (≈ 24,449.88 SYNC per USD). Valid
2026-09-27T05:05:00Z → 11:05:00Z (6 h). The 30-minute quote lock is unchanged.

Derivation (read-only, bounded) at block 73672789 (2026-09-27T05:00:06Z): a simulated 1,000-SYNC sale on market 1 executes
at 0.000040125 USDG/SYNC. Grossed up for the 2.098% fee, that is a mid of 0.000040985, equal to the last swap. Pool
liquidity is unchanged since yesterday. Price history: 4.94e-5 at 15:07Z, 4.57e-5 when v1 was set, then steady selling to 4.08e-5
by 00:38Z (−10.3% since v1, −17% over 14 h). The last 3 swaps (00:38–02:54Z) were within 4.083–4.099e-5, with none
since. Depth: a 950k-SYNC sale (≈ $39) adds 0.65% price impact, 5M adds 3.3%. The mid is rounded **down** to 0.0000409 (0.2% below).

$39 at v2 = base **953,545.232273838630806846 SYNC** (rounded up). Each quote adds its random tag of less than 2×10⁻⁶ SYNC.
Before paying, re-check the mid. If it moved more than 3% from 0.000040985, add v3 and leave v2 unchanged.

## 17. V3 product refinement (27 Sep 2026): $12 price, website renderer, builder, identity

**Price.** The active public price is **$12 one-time** (`priceVersion 2` = 1200 cents), paid in $SYNC: 60% burned, 40%
converted to USDG for the SyncNet treasury. `priceVersion 1` (3900) stays in the reviewed file as history and is never
selected. Deployments select it with `PROJECT_HOME_PRICE_VERSION=2` and `PROJECT_HOME_PRICE_USD_CENTS=1200`. No new
reference rate was added: rate v2 has expired, so payments stay closed until a fresh rate is reviewed in before the next
canary. The payment, quote, rate, split, entitlement and contract architecture is unchanged.

**Public renderer** (`lib/syncnet-site.js`, still zero JavaScript, one hashed stylesheet, same CSP). The page is now a
project website, and verification supports it rather than leading it:
1. authority bar (`SYNCED WEBSITE · PASSPORT OPERATOR VERIFIED`, or `SYNCED WEBSITE · PUBLISHED BY PREVIOUS OPERATOR ·
   AWAITING CONFIRMATION` with every operator link disabled) and a site header (logo or monogram, name, ticker, origin);
2. hero: the operator headline set large, the CTA with its destination host, social links, and the hero image. Without
   an image, an identity tile keeps the hero complete;
3. About, set editorially (the first paragraph as a lead);
4. Markets & economy: pairs shown as `$TOKEN / $QUOTE` (quote assets recognised BY ADDRESS: USDG, NET, SYNC, ETH) and
   the fee flow in human terms (e.g. "Creator fees fund holder rewards", no amounts);
5. Verified facts: a compact strip (chain, token, origin, markets, Passport state) and the Passport disclaimer;
6. Verified details, collapsed: every raw address in full (contract, factory, deployer, pairs, Passport operator, site
   signer, signed configuration), select-to-copy (the page has no JavaScript, so there is no copy button).

Presets differ structurally: **CLEAN** (bone, serif display, generous editorial space, side image), **DARK** (near-black,
heavy sans display, full-width cinematic image band) and **TERMINAL** (mono, compact, framed `hero.png` / `token.json`
windows, `>` prompt, `##` section rules).

**Identity.** Black field, white/bone type, CYAN as the only accent. The operator accent is limited to Cyan or Mono;
stored legacy accent values render cyan. For-sale, warning, error and impostor states use marks, borders and weight,
never a second colour (legacy `v2.css` warm states are neutralised in `ui.css`).

**Editor.** A site builder: grouped controls on the left (Style with preset cards and accent, Content with image
thumbnails, Links, Sections) and the live website on a canvas at its REAL width (1280px desktop or 390px phone, scaled
to fit) in the same sandboxed `srcdoc` iframe. The action bar stays in view. The activation panel shows what $12
includes.

**Images in a Deploy Preview.** The upload path is unchanged (wallet-signed upload session → server sanitiser → pin →
`site:img:v1:<cid>` → same-origin `/site-img/<cid>` with SHA-256 verification). It is closed unless ALL of these are set
for the preview context only:

| Variable | Value |
|---|---|
| `SYNCNET_PUBLIC_UPLOADS` | `true` (wallet-signed uploads; per-wallet, per-IP and global quotas apply) |
| `PINATA_JWT` | a Pinata JWT scoped to `pinFileToIPFS` only |
| `SYNCNET_UPLOAD_KEY` | a random secret of at least 32 characters (signs upload sessions) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | the preview durable store (also required for quotas and `site:img` records) |
| `SYNCNET_PROJECT_HOME_ENABLED` | `true` (`/site-img` serves only while Project Home is enabled) |

Optional: `SYNCNET_PIN_SECONDARY_URL` / `_TOKEN` (redundant pin). Without `SYNCNET_PUBLIC_UPLOADS`, only a founder upload
session (`/api/canary-auth`, `SYNCNET_CANARY_KEY`) can upload. The editor then says "Image uploads are not open on this
deployment", and a home works without images. Note: a Deploy Preview URL is reachable by anyone who has it, so
`SYNCNET_PUBLIC_UPLOADS=true` there lets any wallet upload within the quotas.

## 18. Automatic SYNCNET REFERENCE RATE (production)

The manual, git-reviewed rate versions (v1–v4) were canary tooling: payments stopped whenever a reviewed rate expired.
Production now derives the rate automatically, server-side, for each NEW payment intent
(`netlify/lib/project-home-rate.js`). Rates v1–v4 stay in `syncnet-project-home-pricing.json` as historical records
only. `PROJECT_HOME_RATE_VERSION` is obsolete and ignored.

**Source.** Only the canonical PAR SYNC/USDG market: the PAR multi-market factory's SYNC market 1, which is Uniswap v4
pool `0xeaff358aa176be51e27a562f77ba12265490af09813ff1f71a3f8d796cb13792` on the PoolManager, read directly from
Robinhood Chain (4663). No third-party price API.

**Algorithm** (at most 9 read-only RPC calls; 7 in practice):
1. The chain id must be 4663. Read the latest block `L`.
2. At `L`, `factory.poolKeysFor(SYNC)[1]` must be the reviewed key (currency0 USDG, currency1 SYNC, no hooks).
   `keccak256(abi.encode(key))` must equal `factory.poolIdFor(SYNC, 1)` AND the pinned pool id.
3. Read `PoolManager.extsload(slot0)` and `extsload(liquidity)` at `L`. `sqrtPriceX96` must be > 0, the slot0 tick
   must agree with the price (±1), and in-range liquidity must be ≥ 1e17.
4. Read slot0 again at `L − 1200` blocks (≈2 minutes earlier).
5. Compute the mid (USD per SYNC, ×1e18) = 10^30 · 2^192 / sqrtPriceX96² (USDG has 6 decimals, SYNC 18).
6. The two mids may differ by at most 10%. The LOWER one is used, so more SYNC is charged, never less.
7. Round DOWN to 3 significant figures, the same method as the canary rates.
8. The rate must lie within the pricing library's hard bounds. It must also not be more than +25% above the last
   ACCEPTED reference when that reference is younger than 1 hour (Upstash key `site:rateref:v1`, written only by
   accepted derivations, TTL 2 hours). Falls are always accepted.

**Locking and audit.** The rate is snapshotted into the intent: `syncUsdReferenceRate`, `rateUsdE18`,
`rateVersion: "AUTO"`, `rateEffectiveAt`, and `rateSource` (chain, factory, PoolManager, market, route, pool id, block,
block time, lagged block, both mids, liquidity, LP fee, method, derivedAt). It is copied into the entitlement and the
activation record. The exact tagged amount stays locked for the 30-minute quote window. A reused open intent never
re-reads the market. Verification uses only the intent's own exact amount, never the current market.

**Fail closed.** If the chain id is wrong, the RPC fails, a read is malformed, the market or route is not canonical,
slot0 is inconsistent, liquidity is too thin, the price is too volatile, it jumps, or it is out of bounds, then NO quote
is issued (`503 rate_unavailable`, reason logged). There is never a fallback to a manual or stale rate. Existing
intents stay verifiable.

**Production environment for payments:** `SYNCNET_PROJECT_HOME_ENABLED=true`,
`SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED=true`, `PROJECT_HOME_PRICE_VERSION=2`, `PROJECT_HOME_PRICE_USD_CENTS=1200`,
`PROJECT_HOME_SINK_ADDRESS=0xc32fb194a0a2bc5fa313febd2de5096ca467213d`, and `UPSTASH_REDIS_REST_URL` /
`UPSTASH_REDIS_REST_TOKEN`. `SYNCNET_RPC_URL` is recommended: a private RPC for the reads, which also needs ≈2 minutes
of recent state, as the public RPC provides.

