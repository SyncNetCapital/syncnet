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
| Price | **$39 USD** (`priceUsdCents 3900`, `priceVersion 1`: the initial launch price) |
| Paid in | **$SYNC only** (`0x6368e007b9f0b941560ed1f3bceb20247f5eca37`, 18 decimals), chain 4663 |
| Conversion | SYNCNET REFERENCE RATE: server-controlled and versioned. It is **not an oracle** |
| Rate lock | 30 minutes, judged by the **block timestamp of the payment** |
| Split | 60% burned by `SYNC.burn()` on `settle()`. 40% allocated to the SyncNet protocol treasury, forwarded as SYNC to the treasury converter and **converted to USDG**. The treasury wallet receives **USDG only** |
| Refunds | none. Non-refundable after successful activation. There is no refund mechanism |
| Bound to | the **token**, never the payer. It is inherited through Passport transfer |
| Free after activation | edits, revisions, unpublish, republish, preset changes, adoption after a Passport transfer |
| Lifetime | active for as long as SyncNet operates the Project Home service |

Customer-facing copy (Phase 2): **"$39 one-time · Pay with $SYNC · ≈ X SYNC · SyncNet reference rate · locked for
30 minutes · 60% burned · 40% converted to USDG for SyncNet treasury."** Never promise a USDG amount (for example
"treasury receives $15.60"): the treasury receives whatever the conversion actually produces.

Two different rates are involved and must never be conflated:

- The **SYNCNET REFERENCE RATE** (reviewed, versioned) decides how much SYNC the customer pays for $39.
- The **ACTUAL DEX EXECUTION RATE** (the live PAR SYNC/USDG pool, after its ~2.1% fee and price impact) decides how much
  USDG the treasury later receives for its 40% allocation.

SyncNet's own projects (SYNC, SYNCAT, …) are not exempt. A complimentary entitlement exists only as an ops-level function
with no HTTP route (`grantComplimentary`). It is labelled `COMPLIMENTARY` and never counts as revenue, burn or treasury.

## 2. Pricing: fixed-point representation (`lib/syncnet-project-home-pricing.js`)

All arithmetic is BigInt. No floating point is used anywhere.

```
priceUsdCents   integer US cents                           3900   = $39.00
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
- The deployment selects `PROJECT_HOME_PRICE_VERSION` and `PROJECT_HOME_RATE_VERSION`. It must also repeat
  `PROJECT_HOME_PRICE_USD_CENTS`, which has to equal the reviewed value. No environment variable can introduce a new
  number.
- Every rate has `effectiveAt` and `expiresAt`. An expired rate closes payments, which forces a periodic, explicit
  re-approval instead of silently charging a stale rate.
- On the first use of a version the server stores an immutable snapshot (`site:rate:v1:<v>`, `site:price:v1:<v>`). If
  the same version number later appears with different values, intent creation **fails closed** (`config_conflict`).
- The file ships with **no rate**, so payments stay closed until a rate is reviewed in.
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
PROJECT_HOME_PRICE_VERSION=1
PROJECT_HOME_PRICE_USD_CENTS=3900            # must equal the reviewed price ($39)
PROJECT_HOME_RATE_VERSION=<n>                # must be reviewed, effective, not expired
PROJECT_HOME_SINK_ADDRESS=<deployed sink>    # no default
SYNCNET_RPC_URL=https://…                    # preferred private RPC (public RPC works for development)
UPSTASH_REDIS_REST_URL / _TOKEN              # durable store (required)
```

If any of these is missing or inconsistent, payments stay closed. Without the durable store, everything is closed.

## 13. Enabling (not done in this phase)

1. Create a **dedicated** SyncNet protocol treasury wallet. A simple EOA is acceptable for V1; it must never be a
   founder or deployer wallet. Supply its address.
2. Deploy with `script/DeployProjectHome.s.sol`, which deploys the **converter first**, then the **sink pointing at
   it**. It requires `CHAIN_ID=4663`, the canonical `SYNC`, `USDG` and `PAR_MULTI_ROUTER`, `SYNC_USDG_MARKET=1`, and
   `TREASURY` plus `TREASURY_CONFIRM`. It refuses the deployer and any infrastructure address as treasury. The
   converter constructor re-verifies the live route, and the script re-reads every immutable after deployment.
3. Verify both contracts on Blockscout.
4. Set `PROJECT_HOME_SINK_ADDRESS` to the deployed sink. Metrics find the converter through the sink.
5. Review and commit the first SYNC/USD reference-rate version, with `effectiveAt` and `expiresAt`.
6. Canary on a preview deploy with the flags on, then build and review the Phase 2 UI.
7. Only then enable production.

Conversion is never part of activation. The treasury converts at its own cadence, in batches, with a floor.
