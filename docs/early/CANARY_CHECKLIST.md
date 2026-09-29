# EARLY · Deploy Preview canary checklist (one owner-controlled channel, one owner-controlled fan wallet)

Preconditions: PR #9 Deploy Preview built; preview-only Upstash; preview OAuth client (Testing mode, redirect =
`https://<preview-host>/api/early-youtube-auth`); test attestation + anchor keys whose PUBLIC addresses are committed in
`syncnet-early-keys.json`; anchor address funded with a little gas; `SYNCNET_EARLY_ENABLED=true` on the preview context
only. Production keeps EARLY OFF. **Stop at the first violated invariant.**

Record for every step: time (UTC), URL, response code, and the value asked for. Never paste a private key or token.

| # | Step | Where | Expected | Invariant checked |
|---|---|---|---|---|
| 0 | `GET /api/early?view=config` | preview | `enabled:true, writes:true, attestations:true, anchoring:true, oauth:true, resolver:true` | gate |
| 1 | Creator: `/labs/early/creator` → Connect wallet → Continue with YouTube → Google consent (test user) | phone or desktop | back on `/labs/early/creator` with the manifest step, channel title shown | identity via OAuth only; no token stored |
| 2 | Sign CreatorManifest (USDG, minimum 1) | creator wallet | 201; dashboard `ACTIVE`; wallet = the connected wallet | manifest signed by receiving wallet |
| 3 | `GET /api/early?view=creator&channelId=<UC…>` | any | `acceptsSupport:true`, `currentManifest.receivingWallet` = creator wallet, no supporter data | recipient = signed manifest |
| 4 | (optional) Count me in from a third wallet for a second, unclaimed channel | fan | 201, `creatorOnEarly:false`; `view=creator` for that channel stays `{onEarly:false}` | private signals, no public trace |
| 5 | Fan on a phone: open `/labs/early/c/<UC…>` from the channel description link → Connect → amount → **Sign what you mean** | fan wallet | wallet prompt = typed data, domain "SyncNet SYNC Proof", receiver = creator wallet, exact amount | intent bound to manifest |
| 6 | Send button appears only after "stored" | page | `intent` view shows `status:OPEN`, `createdBlock` | persist-then-enable |
| 7 | **Send to the creator** (one small real USDG transfer) | fan wallet | wallet prompt = token transfer to creator wallet, value 0; tx hash; page moves to the receipt | fan → creator only; 2 prompts total |
| 8 | Receipt page: "Transfer seen · confirming" → after ≈13 min "Verified" | page / `verify` | `status:CONFIRMED`, `mode:auto`, no signature asked | unique match at SAFE finalises without a signature |
| 9 | After ≈20 min: reload → "Verified and final" | page / `reconcile` | `status:FINALIZED` | finality policy |
| 10 | Download receipt (JSON) | page | file contains fact, intent, creatorManifest, attestations, `ordering.note` | receipt schema |
| 11 | `node docs/early/verify-receipt.mjs receipt.json --rpc <rpc> --keys syncnet-early-keys.json` | operator machine | `RECEIPT VERIFIED` (inclusion/anchor checks appear once the bundle exists: rerun after step 15 with `--bundle <date>=<bundle.json>`) | independent verification |
| 12 | Make my EARLY card (one session signature) → copy link → open the link in a private window | page | card shows creator, date, audience; no wallet, amount or tx; `verification.notShown` lists the transaction | opt-in, hidden by default |
| 13 | Daily snapshot: wait for the next hourly run (or check `early:snap` via `view=receipt` context) | job | receipt `context.audienceThen.state` = `approximate` with the join-day value | UTC snapshot rule |
| 14 | Next day after 00:20 UTC: `node netlify/ops/early-ops.mjs bundle <yesterday>` | operator | `rootMatches:true`, leaves ≥ 3 | deterministic bundle |
| 15 | Robinhood anchor: bundle `anchors.robinhood.status` = `sent` then `confirmed` | job / Blockscout | tx from = to = anchor address, value 0, input starts `0x53594e4301` + root | one server tx, self-transfer only |
| 16 | OpenTimestamps: `anchors.opentimestamps.status` = `submitted`; `node netlify/ops/early-ops.mjs ots-file <date> out.ots`; `ots info out.ots` | operator | pending attestations listed by the reference client; hours later `ots upgrade` → Bitcoin attestation | honest OTS wording |
| 17 | Independent anchor check: decode the anchor tx input (`E.decodeAnchorCalldata`) → root == bundle root; recompute the root from `view=bundle` leaves | operator | equal | anchoring reproducible |

Abort conditions (any one): a wallet prompt shows a recipient other than the creator wallet, a value other than 0 on the
transfer, calldata longer than 68 bytes, a third signature on the happy path, a receipt appearing without a matching
transfer, any public page or API showing the fan wallet/amount/tx, an anchor tx whose `to` differs from `from`.
