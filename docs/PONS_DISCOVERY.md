# PONS V2 discovery

SyncNet already understands a PONS V2 token opened by contract (`lib/syncnet-origins.js`: canonical factory
record, phases, Project Passport claims, Marketplace listings and fee-right transfers). Discovery adds the missing
layer: **which canonical PONS V2 launches were launched against a given pair token**, so that relationship can be
shown in Economy views and the Network Map.

Everything is behind `SYNCNET_PONS_DISCOVERY_ENABLED=true` (plus a durable store). With the flag unset, production
behaves exactly as before: `/api/pons-economy` answers `404 {enabled:false}`, the scheduled indexer does nothing,
the pages render no PONS section, and Economy curation / claim requests follow the PAR-only rules.

## Truth model

```
pairToken (root)
  └── LAUNCHED_AGAINST · PONS V2 ── child token
```

A child belongs to root R's PONS V2 connections exactly when a verified PONS V2 factory emitted
`TokenLaunched(token = child, curve, deployer, pairToken = R, launchConfigId, graduationThreshold)`.
The event is the evidence. Nothing is inferred from tickers, names, websites, the PONS website or a token's own
claims. Graduation changes a launch's **state** (phase), never its membership. It is never described as a
partnership, affiliation, endorsement or official membership.

`pairToken == address(0)` is native ETH: indexed under the sentinel root `native`, never mapped to WETH, never
served by the API (roots must be non-zero addresses), never linked as `/project/0x000…`, never a Passport.

## Verified stacks

`lib/syncnet-origins.js` `PONS_V2_STACKS` is a list (PONS replaces a V2 stack as a complete set):

| id | factory | deployment block | hook |
|---|---|---|---|
| `v2a` | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | 26,841,846 (tx `0x3817f297…deddeb`, receipt `contractAddress` = factory, 2026-08-03T14:41:19Z) | `memeHook()` = `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044` |

A new stack is added by code review with a new id. Every indexed launch keeps its stack id, so it stays
attributable to the factory that emitted it. `readPonsV2Launch(rpc, token)` reads the live record from every
verified stack.

## Index (Upstash sorted sets)

| key | type | content |
|---|---|---|
| `pons2:root:v1:<pairToken \| native>` | ZSET | member `"<stackId>:<token>"`, score `block × 10⁶ + logIndex` |
| `pons2:cursor:v1:<stackId>` | STRING | `{"block":n,"hash":"0x…","at":ms}` — last fully indexed block |
| `pons2:journal:v1:<stackId>` | ZSET | member `"<root>\|<stackId>:<token>"`, same score; last 20,000 blocks only (reorg undo) |
| `pons2:lock:v1` | STRING (55 s TTL) | one scheduled run at a time |

- Scores are unique per launch, so descending score = newest launch first, deterministically, and a score is an
  exact pagination cursor. Members are ~46 bytes of immutable identity; names, symbols, logos and phases are
  read lazily for the requested page and never stored.
- No reader ever uses `SMEMBERS` or reads a whole root: `ZREVRANGEBYSCORE key (cursor -inf WITHSCORES LIMIT 0 n+1`
  plus `ZCARD`. There is no endpoint returning the complete PONS history.
- New generic store primitives (`netlify/lib/store.js`, Upstash + in-memory, tested against real Redis):
  `zaddMany` (one `ZADD key s1 m1 s2 m2 …` per key per 1,000 members, ≤ 100 commands per pipeline request),
  `zrevrangeByScore` (limit ≤ 1,000), `zcard`, `zrem`, `zremRangeByScore`.

## Writers

**Backfill — offline, dry-run by default** (`netlify/scripts/pons-backfill.js`):

```
node netlify/scripts/pons-backfill.js [--rpc=https://…] [--out=launches.jsonl] [--json]
node netlify/scripts/pons-backfill.js --write --confirm-store-host=<exact Upstash host>   # controlled write only
```

Scans each stack's factory from its deployment block to `head − 120` with adaptive `eth_getLogs` windows (halved on
any range / result-limit / rate-limit error, grown while small), ignores `removed` logs, dedupes by
`txHash + logIndex`, verifies `log.address` is the verified factory, decodes every preserved fact (token, curve,
deployer, pairToken, launchConfigId, graduationThreshold, block, blockHash, txHash, logIndex, factory) and reports
launches, distinct roots, launches per root, native-ETH count, USDG count, estimated writes/commands/bytes, runtime
and RPC requests. `--write` additionally requires `--confirm-store-host` to equal the configured store host.

**Incremental — scheduled** (`netlify/functions/pons-indexer.js`, every 10 min, no public route): skips any stack
without a backfilled cursor (never scans history); checks the cursor's block hash (mismatch → rewind 2,000 blocks,
undo journaled launches, rescan); indexes only blocks ≤ `head − 120`; ≤ 150,000 blocks and 20 s per run; per chunk
the block header is fetched before its logs, launches are written in one pipeline, then the cursor. One bad log is
counted and skipped; one failing stack never stops another; PAR data is never touched.

## Read API

`GET /api/pons-economy?root=0x…&cursor=…&limit=…` (`netlify/functions/pons-economy.js`)

- `root` mandatory non-zero address · `limit` default 24, hard maximum 50 · `cursor` = previous `nextCursor`.
- 60 requests / min / IP. Response ≤ 64 KiB (logos are dropped first if ever exceeded).

```json
{ "enabled": true, "source": "PONS_V2", "relationship": "LAUNCHED_AGAINST", "root": "0x…", "total": 123,
  "items": [{ "token": "0x…", "source": "PONS_V2", "factory": "0x7ed5…", "stack": "v2a", "launchBlock": 74000000,
              "phase": 0, "phaseLabel": "PONS · BONDING CURVE", "name": "…", "symbol": "…", "logo": "…", "verified": true }],
  "nextCursor": "74000000000003", "indexedThroughBlock": 74889000, "indexedAt": "…", "stale": false,
  "coverage": [{ "stack": "v2a", "factory": "0x7ed5…", "fromBlock": 26841846, "throughBlock": 74889000 }] }
```

Only the requested page is enriched, with ONE Multicall3 `eth_call` (live `getLaunchedToken` per item via
`Origins.ponsV2RecordCall`/`decodePonsV2Record`, plus `name()`, `symbol()`, `logo()`). Per-instance cache:
metadata 24 h; phase 60 s (bonding curve), 5 min (curve closed), 24 h (graduated / rescued). A phase is reported only
when the live record still names this root (`verified`). A broken token degrades to contract address + PONS V2
provenance; an enrichment outage never fails the page; an index outage is a 503 here and nowhere else.

Phase labels (shared, `Origins.PONS_PHASES`): `BONDING CURVE` · `CURVE CLOSED · POOL PENDING` · `GRADUATED · V4` ·
`RESCUED`. The Swept phase is never called graduated. No graduation percentage.

## Curation (see ECONOMIES.md)

With the flag on, a curator may recognize a child when either the child has a live PAR market paired with the root,
or a verified PONS V2 factory's **live** record of the child has `pairToken == root`. The discovery index is never
consulted for authorization, so a forged or corrupted index record cannot authorize anything, and an index outage
cannot invalidate a stored recognition. A PONS V2 root is curated by its Project Passport operator
(`mp:passport:v1:<root>`, unchanged); without a Passport, the claim-request path sends it to the existing Passport
claim instead of a generic manual request. PONS V1 is unchanged (detection only, not indexed).

## Surfaces

Direct `/project/<contract>` (unchanged), Economy (`CONNECTED VIA PONS V2`) and Network Map. PONS launches are not
added to Explore, and ticker/name search across the PONS universe is deferred: contract lookup stays authoritative.

## Rollout (not done by this change)

1. Deploy with the flag unset (no behaviour change).
2. Run the backfill dry-run from a network-enabled machine and review the report.
3. Run `--write --confirm-store-host=<host>` against the production store once, in a controlled window.
4. Set `SYNCNET_PONS_DISCOVERY_ENABLED=true`; the scheduled indexer then keeps the cursor current.
