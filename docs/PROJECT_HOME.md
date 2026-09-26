# SyncNet Project Home: secure foundation

Status: **foundation only, closed by default**. No UI, no navigation entry, and no deployed contract. No rate has been
approved and no treasury exists yet. Nothing is live until every step in "Enabling" below has been done deliberately.

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
| Price | **$49 USD** (`priceUsdCents 4900`, `priceVersion 1`) |
| Paid in | **$SYNC only** (`0x6368e007b9f0b941560ed1f3bceb20247f5eca37`, 18 decimals), chain 4663 |
| Conversion | SYNCNET REFERENCE RATE: server-controlled and versioned. It is **not an oracle** |
| Rate lock | 30 minutes, judged by the **block timestamp of the payment** |
| Split | 60% burned by `SYNC.burn()` on `settle()`, 40% to the SyncNet protocol treasury |
| Refunds | none. Non-refundable after successful activation. There is no refund mechanism |
| Bound to | the **token**, never the payer. It is inherited through Passport transfer |
| Free after activation | edits, revisions, unpublish, republish, preset changes, adoption after a Passport transfer |
| Lifetime | active for as long as SyncNet operates the Project Home service |

SyncNet's own projects (SYNC, SYNCAT, …) are not exempt. A complimentary entitlement exists only as an ops-level function
with no HTTP route (`grantComplimentary`). It is labelled `COMPLIMENTARY` and never counts as revenue, burn or treasury.

## 2. Pricing: fixed-point representation (`lib/syncnet-project-home-pricing.js`)

All arithmetic is BigInt. No floating point is used anywhere.

```
priceUsdCents   integer US cents                           4900   = $49.00
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
  `980000.000000482117093551`.
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

## 4. Payment sink (`contracts/project-home-sink/`)

`SyncNetProjectHomeSink(address sync, address treasury)` has immutable `SYNC` and `TREASURY` (both non-zero, and the
treasury must differ from the token) and a constant `BURN_PERCENT = 60`.

`settle()` is permissionless and takes no parameters. It reads its whole balance, then:

- burns `floor(balance × 60 / 100)` with `SYNC.burn()`,
- transfers the remainder (40% plus every rounding residue) to `TREASURY`,
- updates `totalSettled`, `totalBurned` and `totalTreasury`,
- emits `Settled`.

A zero balance is a no-op. The contract has no owner, admin, setter, rescue, proxy, arbitrary call, approval,
payable function, receive or fallback. See `contracts/project-home-sink/README.md` for the ABI.

**Burn language:** before `settle()`, tokens are *COMMITTED TO THE PROJECT HOME SINK* and 60% is *COMMITTED TO BURN*.
Only `totalBurned` (an executed `SYNC.burn`) is *BURNED*.

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
| SYNC currently committed in the sink | `SYNC.balanceOf(sink)` |
| Total SYNC burned by the sink | the sink's `totalBurned` (executed `SYNC.burn()`) |
| Total SYNC sent to the treasury | the sink's `totalTreasury` |
| Unattributed inflow | `totalSettled + balance − verified payments`. Shown only when this is non-negative. It covers unsolicited transfers and late or unverified payments |

The sink contract settles every token it holds. The metrics never claim that all burned SYNC came from Project Home
customers.

## 12. Configuration

```
SYNCNET_PROJECT_HOME_ENABLED=true            # default: closed (site reads/writes, /site, /site-img)
SYNCNET_PROJECT_HOME_PAYMENTS_ENABLED=true   # default: closed
PROJECT_HOME_PRICE_VERSION=1
PROJECT_HOME_PRICE_USD_CENTS=4900            # must equal the reviewed price
PROJECT_HOME_RATE_VERSION=<n>                # must be reviewed, effective, not expired
PROJECT_HOME_SINK_ADDRESS=<deployed sink>    # no default
SYNCNET_RPC_URL=https://…                    # preferred private RPC (public RPC works for development)
UPSTASH_REDIS_REST_URL / _TOKEN              # durable store (required)
```

If any of these is missing or inconsistent, payments stay closed. Without the durable store, everything is closed.

## 13. Enabling (not done in this phase)

1. Approve the SyncNet protocol treasury, for example a Safe multisig.
2. Deploy the sink with the gated script. It requires `CHAIN_ID=4663`, the canonical `SYNC`, and `TREASURY` plus
   `TREASURY_CONFIRM`.
3. Verify the deployment on Blockscout.
4. Review and commit a rate version, with its `effectiveAt` and `expiresAt`.
5. Set the environment variables above, first on a preview deploy.
6. Build and review the Phase 2 UI.
7. Only then enable production.
