# Solana discovery V0 (backend): Pump.fun non-SOL launches

Everything is behind `SYNCNET_PUMP_DISCOVERY_ENABLED=true` (and a durable store). The flag is unset by default. While
it is unset, `/api/pump-economy` answers `404 {enabled:false}` and the scheduled `pump-indexer` does nothing. The
indexer also needs `SYNCNET_SOLANA_RPC_URL` (https). That URL is never logged or returned, and there is no public
fallback. EVM, PONS and PAR behaviour is unchanged.

## Relationship

```
ROOT MINT (quote_mint)
  └── LAUNCHED_AGAINST · PUMP_FUN · Solana mainnet ── CHILD MINT
```

A child is indexed only if a successful, finalized transaction contains all of the following:

1. **CreateEvent provenance.** The CreateEvent is an instruction to the Pump program
   `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. Its data starts with tag `e445a52e51cb9a1d` followed by the
   CreateEvent discriminator. Its first account is the event authority
   `Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1`. `Program data:` log lines are never read.
2. **Parent create.** The instruction one stack level above the event is a Pump `create` or `create_v2` for the same
   mint and bonding curve. Its mint authority is `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`. This also covers
   creates made through a wrapper program's CPI.
3. **BondingCurve check.** The bonding curve is the PDA `["bonding-curve", mint]`. When read (finalized), the account
   is owned by Pump, has discriminator `17b7f83760d8ac60`, and holds the same `quote_mint` (offset 83) as the event.
4. **Non-SOL quote.** `quote_mint` is not native SOL (`111…1`, the default pubkey). Native SOL is never rewritten to
   wrapped SOL. Native-SOL launches are not indexed in V0.

CreateEvent decoding is version-tolerant. The fields are name, symbol and uri (skipped), then mint, bonding_curve,
user, creator, timestamp, four u64 values, token_program, is_mayhem_mode, is_cashback_enabled and quote_mint. An event
without quote_mint predates non-SOL quotes, so it is treated as native SOL. Metadata URIs are never fetched.

## Key schema (Upstash)

The prefix is `sollaunch:v1:mainnet:`, which is separate from `pons2:*`, PAR, `mp:*` (Marketplace/Passport) and
`site:*` (Project Home). Base58 identifiers keep their case.

| key | type | content |
|---|---|---|
| `sollaunch:v1:mainnet:<SOURCE>:<RELATIONSHIP>:root:<rootMint>` | ZSET | member `<childMint>:<launchSignature>`, score `launchSlot` |
| `sollaunch:v1:mainnet:<SOURCE>:checkpoint` | STRING | `{"signature","slot","at"}`: newest signature fully processed; never moves to an older slot (CAS) |
| `sollaunch:v1:mainnet:<SOURCE>:backfill` | STRING | `{"address","headSignature","headSlot","fromSlot","stopSlot","before","scanned","done","at"}` |
| `sollaunch:v1:mainnet:<SOURCE>:lock` | STRING, TTL 55 s | only one indexer run at a time |

`SOURCE` is `PUMP_FUN` for now. A later adapter (for example `STONKFUN`) is added to `SOURCES` in
`netlify/lib/solana-launch-index.js` and writes through the same keys and API.

**Pagination.** Several launches can share a slot, so the score alone is not a cursor. Redis orders equal scores by
member, descending, so `(slot, member)` is a total order. The cursor is `<slot>:<childMint>:<signature>`, the last
item returned. The next page is:

1. the members of that same slot below the cursor member (a bounded read of one slot, at most 1,000 entries), then
2. the slots strictly below the cursor slot.

Tests cover every page size over same-slot groups, and inserts made while paging.

## Historical start: slot 445,675,307

This is the first slot with a non-SOL launch. `QuoteControl` (`6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP`) is passed
by every non-SOL `create_v2` and by no SOL create (checked on recent launches). Its full signature history
(77,864 signatures, paged to the end) starts at slot 445,675,307 (2026-09-09T18:07:54Z). That first transaction is a
USDC-quoted `create_v2`: signature `xHCSEK1o…JmJ`, mint `4DBh3jCm…YyYr`. In that transaction QuoteControl held 0
lamports, which shows it was only an address then.

Limit: the last Pump program upgrade before that slot was at slot 439,294,082. A non-SOL create that did not reference
QuoteControl before 445,675,307 cannot be ruled out without a full scan. If in doubt, pass `--from-slot`.

## Writers

- **Backfill** (`netlify/scripts/pump-backfill.js`). Dry run by default. Writing needs `--write` and
  `--confirm-store-host=<host>`. It walks signatures from newest to oldest down to `--from-slot`, in bounded runs
  (`--max-signatures`), and resumes from its stored progress.
  - `--candidates=mint-authority` (the default) walks every Pump create, about 52k per day, which is about 1M
    signatures since the start slot.
  - `--candidates=quote-control` walks QuoteControl, about 78k signatures in total. Every candidate is verified the
    same way either way.
  - The first write run moves the checkpoint forward to the newest mint-authority signature (read before the walk's
    own head), so the indexer can follow new launches while the history fills in. This holds for either candidate
    address.
  - `--catch-up` walks back only as far as the stored checkpoint's slot, for after an indexer backlog.
- **Indexer** (`netlify/functions/pump-indexer.js`). Runs every minute.
  - It reads signatures newer than the checkpoint, looking back at most 10 pages of 1,000.
  - It processes them oldest first, at most 300 per run, in chunks of 50, within a 20 s budget.
  - After each chunk it writes the relationships, then moves the checkpoint.
  - An RPC failure stops the run at the last signature that fully succeeded.
  - If there is more backlog than the look-back window, it reports `backlog` and makes no changes (run
    `--catch-up`).

## API

`GET /api/pump-economy?root=<mint>&cursor=…&limit=…`

- Default page size is 24, hard maximum 50. Rate limit: 60 requests per minute per client. Response budget: 32 KB.
- Native SOL is refused as a root.
- Each item returns `mint`, `assetId`, `source`, `launchSlot` and `launchSignature`.
- The page also carries `nextCursor`, `indexedThroughSlot`, `indexedAt`, `historyComplete`, `historyFromSlot` and
  `stale` (true if there has been no indexer progress for 15 min, or the backfill has not finished).
