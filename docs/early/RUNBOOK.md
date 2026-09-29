# EARLY (SYNC Proof) · operator runbook

Feature flag OFF by default. Nothing below is live until every step is done deliberately, on a Deploy Preview first.

## 1. Keys (generate locally, never commit, never paste into chat or logs)

1. Attestation key: 32 random bytes, hex. Derive its address (for example with `node -e` using
   `lib/syncnet-core.js` `_internal.secp256k1.privateKeyToAddress`). Choose a key id like `early-att-2026-10-k1`.
2. Anchor key: a **different** 32 random bytes. Derive its address. It will hold gas only (≈0.005 ETH is months of
   daily anchors on Robinhood Chain); never send anything else to it.
3. Session key: ≥ 32 random characters (`SYNCNET_EARLY_SESSION_KEY`). Not the upload key, not an attestation key.
4. Commit the **public** addresses to `syncnet-early-keys.json` in a reviewed commit:
   ```json
   { "schema": "syncnet.early.keys.v1", "attestation": [{ "keyId": "early-att-2026-10-k1", "address": "0x…", "validFrom": "2026-10-01T00:00:00Z", "validUntil": null, "status": "active" }], "anchor": [{ "address": "0x…", "validFrom": "2026-10-01T00:00:00Z", "validUntil": null }] }
   ```
   The static audit refuses any 32-byte hex value in that file. The server refuses to attest unless the address derived
   from `SYNCNET_EARLY_ATTESTATION_KEY` matches the registry entry named by `SYNCNET_EARLY_ATTESTATION_KEY_ID`.

## 2. Google / YouTube

1. Google Cloud project → enable **YouTube Data API v3**.
2. OAuth consent screen: External, **Testing**; add the pilot creators' Google accounts as test users (the
   `youtube.readonly` scope is sensitive; Testing mode avoids app verification for ≤ 100 test users).
3. OAuth client (Web application): authorised redirect URI = exactly `https://<site>/api/early-youtube-auth`.
4. API key restricted to YouTube Data API v3 (resolver + daily snapshots).

## 3. Environment (Netlify; scope to the preview context first)

```
SYNCNET_EARLY_ENABLED=true
SYNCNET_EARLY_SESSION_KEY=…                   (≥ 32 chars)
SYNCNET_EARLY_ATTESTATION_KEY=0x…             (32-byte hex; address in syncnet-early-keys.json)
SYNCNET_EARLY_ATTESTATION_KEY_ID=early-att-2026-10-k1
SYNCNET_EARLY_ANCHOR_KEY=0x…                  (32-byte hex; address in syncnet-early-keys.json)
SYNCNET_GOOGLE_CLIENT_ID=…
SYNCNET_GOOGLE_CLIENT_SECRET=…
SYNCNET_EARLY_OAUTH_REDIRECT=https://<site>/api/early-youtube-auth
SYNCNET_YOUTUBE_API_KEY=…
UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN     (required; use a preview-only database first)
SYNCNET_RPC_URL=https://…                     (recommended private RPC; the public one works, see §5)
optional: SYNCNET_EARLY_WRITES_DISABLED=true (kill writes), SYNCNET_EARLY_ANCHOR_DISABLED=true (kill the anchor tx),
          SYNCNET_EARLY_DISABLED=true (kill everything), EARLY_GETLOGS_CHUNK (default 50000)
```
`GET /api/early?view=config` shows the effective state (`enabled`, `writes`, `attestations`, `anchoring`, `oauth`,
`resolver`). `GET /api/config` shows `early`.

## 4. Smoke checks after a deploy

1. `/labs/early` loads; `/labs/early/creator` loads; `/api/early?view=config` says `enabled:true`, `attestations:true`.
2. Canary creator (an owner-controlled YouTube channel): creator setup end to end; the creator page shows the wallet.
3. Canary fan (a second wallet, on a phone, from a link in the channel description): sign, send a minimum USDG
   amount, receipt CONFIRMED within ≈ 13 min, FINALIZED within ≈ 20 min, card, public page.
4. Next day 00:20 UTC: `node netlify/ops/early-ops.mjs bundle <yesterday>` shows `rootMatches:true`, a Robinhood anchor
   tx (check it on Blockscout: from = to = anchor address, value 0, input starts with `0x53594e4301`), and an
   OpenTimestamps `submitted` status. Later runs upgrade it.
5. `node docs/early/verify-receipt.mjs receipt.json --rpc <url> --keys syncnet-early-keys.json --bundle <date>=<bundle.json>`
   prints `RECEIPT VERIFIED` for a downloaded receipt.

## 5. Chain / RPC findings (29 Sep 2026, `tests/live/early-rpc-capability.mjs`, read-only)

| Check | Public RPC result |
|---|---|
| chain id | 0x1237 |
| block time | ≈ 0.10 s |
| `safe` tag | supported, lag ≈ 12.5 min |
| `finalized` tag | supported, lag ≈ 19 min |
| `eth_getLogs`, exact EARLY filter (token + Transfer + sender + receiver) | 200,000 blocks in one call, ≈ 120 ms |
| `eth_getLogs`, broad filter | capped at 10,000 **results** per call (never hit by the exact filter) |

Consequences: CONFIRMED ≈ 13 min after the transfer, FINALIZED ≈ 20 min; the default chunk (50,000 blocks) sweeps a
2 h window in 2 calls.

## 5b. Independent validation record (29 Sep 2026, final hardening pass)

| What | How | Result |
|---|---|---|
| Custom RLP / EIP-155 anchor signing (`netlify/lib/early-tx.js`) | `tests/early/anchor-crosscheck.mjs` against **ethers v6.17.0**: the EIP-155 vector, 300 random anchor transactions compared byte for byte, ethers decoding our raw bytes, our decoder on ethers bytes | 10/10. The first run found a real bug (`r`/`s` zero-padded instead of minimal RLP integers, ≈1 in 128 signatures); fixed, re-verified. |
| OpenTimestamps artifact (`netlify/lib/early-ots.js`) | a real root submitted to a.pool / b.pool / alice calendars, `.ots` written by our code, checked with the **reference client opentimestamps-client 0.7.2** (`ots info`, `ots verify -f root.bin`, `ots verify -d`, `ots upgrade`) | Parses; all calendars answer "Pending confirmation in Bitcoin blockchain". The first run found a wrong header magic and an `ots info` incompatibility with a keccak file digest; the message is now `sha256(root)`, fixed, re-verified. |
| Real Redis semantics (production Upstash adapter incl. the `cas` Lua script) | `tests/early/upstash-concurrency.test.mjs` against Redis 8.0.5 (WSL) through a REST bridge: duplicate nonces, simultaneous intent creation, simultaneous matching, duplicate finalisation, Count me in duplicates, manifest version race, rotation cancel race, session replay, 50-way cas | 13/13. **Still owed: the same suite against the preview-only Upstash database** (`UPSTASH_REDIS_REST_URL/TOKEN` + `EARLY_TEST_UPSTASH_CONFIRM=preview`). |
| Robinhood Chain RPC capabilities | `tests/live/early-rpc-capability.mjs` | chain 0x1237; ≈0.10 s/block; `safe` ≈12.5 min, `finalized` ≈19 min; `eth_getLogs` result-capped (10k), exact filter fine over 200k blocks. |

## 6. Daily operations

- `node netlify/ops/early-metrics.mjs --days 30` — pilot metrics (aggregates only).
- `node netlify/ops/early-ops.mjs bundle <date>` — inspect a bundle; `ots-file <date> out.ots` — export the proof.
  To check it with the official client: write the bundle root's 32 bytes to `root.bin`, then `ots verify -f root.bin out.ots`
  ("Pending confirmation in Bitcoin blockchain" until upgraded), `ots upgrade out.ots` later. The stamped message is `sha256(root)`.
- `node netlify/ops/early-ops.mjs card-suspend <shareId> --actor <you>` — hide a public card (moderation); it never
  touches receipts.
- Watch function logs for `public-feature-closed`, `anchor-failed`, `bundle-root-mismatch`, `youtube-unavailable`.

## 7. Key rotation / incident

- Planned: add `k2` to the registry (validFrom now), deploy with `k2`, later set `k1.validUntil`. Old attestations in
  bundles anchored before `validUntil` stay valid.
- Compromise of the attestation key: set `validUntil` to the last trusted anchor time, deploy a new key, re-issue
  affected attestations (creator records, snapshot values and OAuth link facts are all stored). Fan and creator
  signatures and transfers cannot be forged by that key.
- Compromise of the anchor key: it can only self-transfer; add a new anchor address to the registry, move the gas.
- Sessions: change `SYNCNET_SESSION_EPOCH` to revoke every EARLY session and OAuth state at once.

## 8. Never

- Never put a private key, seed, token or secret in the repository, a page, a log line or a chat.
- Never add a payment router, escrow, fee or swap. The only money path is fan wallet → creator wallet.
- Never expose per-creator supporter counts or any supporter wallet.
