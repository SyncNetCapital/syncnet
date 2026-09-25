# SyncNet V2.5 RC: recovery guide

**The rule: never launch again because a page lost track of a launch.** The chain decides.

SyncNet records a launch before your wallet is asked. It treats any ambiguous wallet answer as SENT until the chain proves otherwise. It blocks a second launch of the same ticker from the same wallet while an earlier one is unresolved.

## Where the evidence lives

| What | Where | Notes |
|---|---|---|
| Launch records (full evidence) | This browser: `localStorage["syncnet_launch_records_v1"]`. Rehearsal records live under `syncnet_rehearsal_<chainId>_launch_records_v1`. | SyncNet never deletes records. Clearing site data does. **Export after every launch.** |
| Exported evidence | `syncnet-launch-evidence-<ticker>.json` / `syncnet-launch-records.json` | Import it in MY LAUNCHES on any browser. |
| Public proof | `syncnet-launch-proof-<ticker>.json` (`syncnet.launch.proof.v2`) | Anyone can verify it against the chain. |
| The truth | Robinhood Chain: PAR factory `getLaunchedToken(token)`, the transaction and its receipt | Authoritative. The PAR indexer is secondary. |

Each record contains the following:

- The predicted token, recordHash, salt, exact calldata, target, value, gas and chainId.
- The draft and normalized metadata.
- The deployer, fee recipient, tax, markets and expected economics.
- The intent JSON, typed data and signature.
- The tx hash, receipt and verification, when known.
- A history with a timestamp for every state change.

## States and what to do

| State | Meaning | Blocks a new $TICKER from this wallet? | What you do |
|---|---|---|---|
| PREPARED / SIGNATURE_VALID | Simulated or signed. Nothing sent. | No | Nothing. |
| BROADCAST_ATTEMPTED | The wallet was asked, and SyncNet saw no answer. The tab closed or reloaded, or the browser crashed. | **Yes** | Open MY LAUNCHES and press RE-VERIFY. It checks the predicted address on-chain. Check your wallet activity. |
| BROADCAST_UNKNOWN | The wallet returned an error or no hash. The transaction may have been broadcast. | **Yes** | The same. SyncNet keeps watching the predicted address. |
| TX_HASH_RECEIVED | There is a hash but no receipt yet. It is pending, or the RPC lags. | **Yes** | Wait and RE-VERIFY, or paste the hash into RECOVER A LAUNCH. |
| MINED | The token exists on-chain. Verification has not finished. | Yes (it exists) | RE-VERIFY. |
| ONCHAIN_VERIFIED | The factory record, markets, fees and metadata match the signed intent. | Yes (it exists) | Export the proof. |
| INDEXER_PENDING | Verified on-chain; the PAR indexer has not caught up. | Yes (it exists) | Nothing. RE-VERIFY later. The on-chain result already stands. |
| FULLY_VERIFIED | On-chain verified, and the indexer agrees. | Yes (it exists) | Export the proof, then publish it (below). |
| FAILED_PRE_BROADCAST | You rejected the request, or you confirmed "not sent" after an on-chain check. | No | You can run a fresh simulation. The record is kept. |
| FAILED_POST_BROADCAST | Mined but reverted. No token was created (checked on-chain). | No | Find out why (e.g. PAR parameters changed), then run a fresh simulation. |

A "Yes (it exists)" in the blocks column means SyncNet shows **ALREADY LAUNCHED FROM THIS WALLET**. A second, separate token then needs a checkbox plus typing `TICKER AGAIN`.

## Situations

**The wallet showed an error after you confirmed.**

1. Do not press LAUNCH again.
2. The builder shows "treated as SENT" and checks the predicted address.
3. If the token appears, the builder finishes verification by itself.
4. Otherwise, open `/launches.html` and press RE-VERIFY.

**You closed or reloaded the tab while the wallet popup was open.**

1. Reload `/build.html` or open `/launches.html`. Unresolved launches are re-verified automatically, read-only.
2. The record shows UNRESOLVED with the predicted token.
3. RE-VERIFY settles it as soon as the chain knows.

**You have a tx hash but no confirmation.**

1. Paste the hash into RECOVER A LAUNCH and press FIND.
2. The result is one of: pending (do not launch again), reverted (no token), or success. On success, SyncNet shows the token, adds the hash to your record and re-verifies.

**The PAR indexer is slow or down.** Nothing to do. On-chain verification does not need it. The record stays INDEXER_PENDING until the indexer catches up.

**"LAUNCH EXECUTED — VERIFICATION NEEDS ATTENTION".**

- The token exists, but a field differs from the signed intent. The status box lists which fields.
- Do not launch again.
- Open the transaction in the explorer and compare. If PAR changed a fee parameter between preparation and inclusion, SyncNet records the actual values (`economicsChanged`).

**You use another browser or device, or lost site data.**

1. On the new browser, open MY LAUNCHES and choose IMPORT JSON with your exported file. Imported records are shown as unresolved until the chain re-verifies them.
2. Without an export, use RECOVER A LAUNCH with the tx hash, the token address or your wallet address. It lists your PAR launches and checks each one on-chain.
3. You can ADD TO MY LAUNCHES from chain data. Without the original intent and signature, though, it cannot become a SyncNet provenance proof.

**A launch is unresolved, but you know nothing was sent.**

1. Check your wallet activity: there must be no sent or pending transaction.
2. On the record, choose MARK AS NOT SENT… and type `NOT SENT TICKER`.
3. SyncNet re-reads the chain first. It refuses if the token exists or the tx is pending or succeeded.
4. The record is kept as FAILED_PRE_BROADCAST, and its predicted address is re-checked at every future launch of that ticker.

**Two tabs.** Only one tab can launch at a time (a cross-tab lock). The duplicate check runs again at send time, so a launch made in another tab stops this one before the wallet is asked.

## Publish a launch to the public Registry

**Option A (no public gate needed).** Add an entry to `syncnet-projects.json` and redeploy. This is a data change, not a code change:

```json
{
  "token": "0x<token>",
  "symbol": "TICKER",
  "name": "Project name",
  "profile": { "name": "Project name" },
  "registry": { "id": "SYNCNET-002", "recordedAt": "2026-09-..", "canonical": false },
  "proof": { "…": "paste the whole syncnet.launch.proof.v2 file here" }
}
```

The Registry re-verifies the proof live in every visitor's browser. It shows **BUILT WITH SYNCNET · VERIFIED** only if every check passes: signature, tx, salt, TokenLaunched log, factory record, markets and fees. `"canonical": true` additionally reserves the ticker and name: the launch guard blocks look-alike launches, and pages flag impostors. Set it only for a SyncNet-official asset.

**Option B.** Set `SYNCNET_REGISTRY_SUBMISSIONS=true` with Upstash configured, then use PUBLISH TO REGISTRY in MY LAUNCHES. The server verifies the proof on-chain before storing it.

## Server-side incidents (Netlify env vars, then redeploy)

| Incident | Action |
|---|---|
| Upload abuse or Pinata costs | `SYNCNET_UPLOADS_DISABLED=true` (kill switch; refuses every upload, founder uploads included). Then revoke the Pinata key. |
| Operator key leaked or shared | Rotate `SYNCNET_CANARY_KEY` (≥ 32 chars) and change `SYNCNET_SESSION_EPOCH`, which revokes every issued session at once. |
| Upload-session secret leaked | Rotate `SYNCNET_UPLOAD_KEY` (≥ 32 chars). All sessions and challenges become invalid. |
| Close public features again | Unset `SYNCNET_PUBLIC_LAUNCH`, `SYNCNET_PUBLIC_UPLOADS` and `SYNCNET_REGISTRY_SUBMISSIONS`. `/api/config` must then show `false` for each. |
| A bad Registry entry | Remove it from `syncnet-projects.json`, or delete `reg:token:v1:<token>` and its member of `reg:index:v1` in Upstash. Pages re-verify every entry live anyway: a proof that fails shows UNVERIFIED. |
| PAR changed an address or parameter | The builder's PAR live preflight and the pre-send re-check refuse to launch. Nothing is sent. Re-verify PAR's sources, then update `lib/syncnet-chain.js` (ROBINHOOD). |

Logs contain hashed IDs only. `SYNCNET_LOG_SALT` sets the hash salt.
