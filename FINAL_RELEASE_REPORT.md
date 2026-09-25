# SyncNet V2.5: final release report

> Historical record of the `v2.5-rc` release (23 Sep 2026) — the build that launched PONSYNC. Marketplace statements below describe the prototype of that date; since 24 Sep 2026 the Marketplace is the real, non-custodial **Marketplace V1** — see `RELEASE_REPORT.md`.

## Summary

This is **SyncNet V2.5 Final Release Candidate**, build **`v2.5-rc`**, dated 23 Sep 2026.

- It is a stabilization and completion of V2.5. There is no V3, no redesign and no new products. Visual identity and existing features are preserved.
- All 21 audit findings (H1, H2, M1–M4, L1–L15) are fixed. Each has an explicit verification level in `AUDIT_FINDINGS_CLOSED.md`.
- All 11 automated suites pass: 1,577 checks, 0 failed.
- None of the audit's 61 vulnerability PoC checks reproduces against this build. Against the original build, the audit's PoCs reproduced 73/73 (engine 27, server 11, pages 35).
- Nothing was broadcast, deployed or spent while preparing this build.

Two items need your wallet or the live chain, which this build environment cannot reach:

- The live-chain reads. SyncNet runs them itself in your browser before the LAUNCH button unlocks.
- The first real transaction.

---

## 1. Version and build identifier

| Item | Value |
|---|---|
| Product | SyncNet V2.5 Final Release Candidate |
| Build id | `v2.5-rc`. `GET /api/config` returns it (`"version":"v2.5-rc"`), and every launch proof records it (`createdBy: "SyncNet v2.5-rc"`). |
| Site fingerprint | `sha256:be6ed508bf9c96a4bf64b9f57265d1562b4b5abde8255eb290432ec93502caf4`: SHA-256 over every deployable file (pages, scripts, styles, assets, functions, config). Tests and docs are excluded. Recompute with `node tests/fingerprint.mjs`. The same value is in `tests/RESULTS.json` → `site`, so the tests ran against exactly this site. |
| Baseline | `07a9a77e-syncnet_v2.5.zip`: the V2.5 build that `syncnet_v2.5_audit_ro.md` audited (23 Sep 2026). It is git commit `5c37581` in the working history, which is not shipped. |
| **Assumption** | Your message said the latest build ZIP was attached, but only `syncnet_v2.5_audit_ro.md` and `syncnet_v2.5_audit_poc.zip` arrived. I therefore used the V2.5 ZIP you uploaded earlier in this conversation, the exact build the audit covers. If a newer build exists, its changes must be merged into this one. |
| Test environment | Node v22.22.2, Python 3, Playwright Chromium (headless), Linux. |

## 2. Files modified

The baseline had 59 files. This release adds 44 and modifies 39 (`git diff --name-status 5c37581`, generated test-result JSONs excluded), and deletes none.

These files are unchanged: `kit.html`, `kit.js`, `labs.html`, `labs-v2.js`, `sync.html`, `v2-sync.js`, `contact.html`, `v2-common.js`, `legal.css`, `vendor/viem.js` and `assets/*`.

**Pages and browser scripts**

| File | Status | Why |
|---|---|---|
| `build.html`, `builder-v2.js` | M | H1, M1, L1, L3, L5, L6, L7, L13, L15. Final review, network banner, duplicate guard, PAR preflight, recovery panel. |
| `launch-engine-v2.js` | M | H1 (frozen P, `presendCheck`), L2, L5–L7, L13, calldata cross-check, route `qualifies` |
| `launch-records.js` | **A** | M2 / H1 durable records, lifecycle, re-verify, proofs, cross-tab lock |
| `launches.html`, `launches-v2.js` | **A** | MY LAUNCHES / RECOVER A LAUNCH |
| `lib/syncnet-core.js` | **A** | Shared primitives: keccak, secp256k1, EIP-712, ABI encode/decode, byte limits, text policy, confusables |
| `lib/syncnet-chain.js` | **A** | PAR addresses and selectors, live preflight, verification, recipient safety, proof verification (EIP-1271) |
| `lib/syncnet-provenance.js` | **A** | The six Registry statuses, operator claims, control challenges |
| `token.html`, `v2-token.js` | M | M3, M4, L8, L13 |
| `registry.html`, `v2-registry.js` | M | Registry statuses, live proof verification, local records kept apart |
| `index.html`, `network.html`, `v2-network.js` | M | M4 (address identity, impostor flag), L11 degraded states |
| `marketplace.html`, `marketplace-v2.js` | M | L4 control and transferability proofs |
| `v2.css` | M | Styles for the new states (banner, final review, evidence, badges), mobile, text ≥ 11 px |
| `404.html` | **A** | Internal files return 404 |
| `privacy.html`, `terms.html`, `risk.html` | M | Data flows, operator dependencies, as-is, eligibility, prohibited uses, legal-review note |
| `syncnet-projects.json` | M | `symbol` and `name` on canonical entries (M4) |

**Server**

| File | Status | Why |
|---|---|---|
| `netlify.toml`, `_redirects` | M | New `/api/*` routes, internal-file 404s, the tokenlist proxy removed (L14) |
| `netlify/functions/config.js` | **A** | Server-side rollout gate |
| `netlify/functions/upload-auth.js` | **A** | Wallet-signed upload sessions (H2) |
| `netlify/functions/ipfs-upload.js` | M (rewritten) | H2, L12 |
| `netlify/functions/canary-auth.js` | M | L9 |
| `netlify/functions/site-check.js` | M | L10 |
| `netlify/functions/par-launches-all.js` | M | L11 |
| `netlify/functions/par-tokenlist.js` | **A** | L14 |
| `netlify/functions/launch-guard.js` | **A** | Server-side duplicate and impersonation check |
| `netlify/functions/registry.js` | **A** | Chain-verified public Registry |
| `netlify/lib/flags.js`, `body.js`, `chain-rpc.js`, `image-sanitize.js`, `log.js`, `ratelimit.js`, `respond.js`, `store.js` | **A** | Gate, request parsing, server RPC, image re-encoding, hashed logs, limits, generic responses, Upstash store |
| `netlify/lib/upload-session.js` | M | Scoped v2 sessions, epoch revocation, ≥ 32-character secret |

**Tests**

| Files | Status |
|---|---|
| `tests/run-all.mjs`, `tests/fingerprint.mjs` | A |
| `tests/regression/rc-regressions.mjs` (R01–R25), `tests/regression/rc-mobile.mjs` | A |
| `tests/server/rc-server.test.mjs`, `infra.test.mjs`, `image-sanitize.test.mjs`, `tests/unit/core.test.mjs`, `tests/fixtures/launch-fixture.json` | A |
| `tests/audit/before/*` (the original PoCs), `tests/audit/poc-*.mjs` (AFTER ports) | A |
| `tests/e2e/harness.mjs`, `tests/e2e/run.mjs`, `tests/static_audit.py` | M |
| `tests/e2e/smoke.mjs` | A |

**Documentation**

| Files | Status |
|---|---|
| `FINAL_RELEASE_REPORT.md`, `FIRST_LIVE_LAUNCH_CHECKLIST.md`, `AUDIT_FINDINGS_CLOSED.md`, `RECOVERY_GUIDE.md` | A |
| `README.md`, `CHANGELOG.md`, `SECURITY.md`, `TESTING.md`, `POST_CLAUDE_HARDENING.md` | M |
| `docs/DEPLOYMENT.md`, `ARCHITECTURE.md`, `KNOWN_LIMITATIONS.md`, `REGISTRY.md`, `REGISTRY_PROOF_SCHEMA.json` (now proof v2), `REHEARSAL.md`, `V21_PROVENANCE_AND_INDEXER.md` | M |

Generated test results are refreshed by every run: `tests/RESULTS.json`, `tests/**/*.results.json`, `tests/e2e/last-run.json` and `tests/audit/*.json`.

## 3. Tests executed

`node tests/run-all.mjs` runs everything and writes `tests/RESULTS.json`. The last full run was 2026-09-23 21:39 UTC against site `sha256:be6ed508bf9c96a4bf64b9f57265d1562b4b5abde8255eb290432ec93502caf4`. It was repeated from the extracted release ZIP in a clean directory with the same result: ALL SUITES PASSED, 1,577/1,577 checks and 0/61 PoC vulnerabilities reproduced, on the same site fingerprint, at 2026-09-23 21:48 UTC. The final ZIP differs from that tested copy only in the text of this report. No site, function or test file changed, which a file-by-file comparison of the two ZIPs confirms.

How the suites run:

- The **real** pages, scripts and Netlify functions are exercised.
- The environment is mocked:
  - a **stateful mock of PAR on Robinhood Chain**: factory, router, quote pricer, `getLaunchedToken`/`getMarkets`, receipts, logs, the indexer;
  - an **EIP-1193 mock wallet** that signs with real secp256k1 keys (EIP-712 and `personal_sign`) and can broadcast then throw, hang, lag, switch account or chain, disconnect, or return no hash;
  - fake Pinata, IPFS gateways and Upstash.
- No test touches a real network.

| # | Suite | File | Covers (spec list) |
|---|---|---|---|
| 1 | Static audit | `tests/static_audit.py` | Structural invariants (record before `eth_sendTransaction`, signature binding, **no approve/permit/other calls**, routes, gate, CSP, invisible characters) |
| 2 | Core unit | `tests/unit/core.test.mjs` | keccak, secp256k1, EIP-712, launch ABI encode/decode, UTF-8 limits, text policy, confusables (metadata validation) |
| 3 | Image sanitizer | `tests/server/image-sanitize.test.mjs` | Fake images, polyglots, bombs, EXIF, dimensions |
| 4 | Server infrastructure | `tests/server/infra.test.mjs` | Sessions, limits, lockouts, SSRF, caching, error hygiene |
| 5 | Server endpoint abuse | `tests/server/rc-server.test.mjs` | Every function under abuse, the gate closed and open (**server endpoint abuse**) |
| 6–8 | Audit PoCs (AFTER) | `tests/audit/poc-engine.mjs`, `poc-server.mjs`, `poc-e2e.mjs` | The audit's own attacks against this build (**audit PoCs**) |
| 9 | E2E | `tests/e2e/run.mjs` | Every page and flow: home, build, map, registry, marketplace, project pages, kit, labs, rehearsal, uploads, wallet connect, account and chain switch (**existing E2E, no regression**) |
| 10 | Required regressions | `tests/regression/rc-regressions.mjs` | R01–R20 from the brief, plus R21 (final review = wallet request), R22 (two-tab race), R23 (imported evidence neutral), R24 (wallet disconnect) and R25 (hostile HTML in metadata). Covers **wallet-state races, reload and recovery, duplicate detection, Registry provenance**. |
| 11 | Mobile | `tests/regression/rc-mobile.mjs` | The whole launch and recovery flow at 320/360/390/430 px, plus every page at 320 px (**mobile**) |

BEFORE behaviour: the audit's original PoCs are kept unchanged in `tests/audit/before/`. Their results against the original V2.5 were re-run on 23 Sep 2026: 27/27 engine, 11/11 server and 35/35 page checks reproduced.

## 4. Passed and failed

| Suite | Passed | Failed |
|---|---|---|
| Static audit | PASS (all assertions) | 0 |
| Core unit | 333/333 | 0 |
| Image sanitizer | 129/129 | 0 |
| Server infrastructure | 434/434 | 0 |
| Server endpoint abuse | 82/82 | 0 |
| E2E | 299/299 | 0 |
| Required regressions R01–R25 | 188/188 | 0 |
| Mobile | 112/112 | 0 |
| **Total checks** | **1,577** | **0** |

Audit PoCs, BEFORE → AFTER:

| PoC | BEFORE (original V2.5) | AFTER (this build) |
|---|---|---|
| Engine | 27/27 reproduced | **0 of 16** vulnerability checks reproduce. 10/10 correctness controls still pass. 1 informational item stays (native-ETH market not selectable, NOT APPLICABLE). |
| Server | 11/11 reproduced | **0 of 11** reproduce |
| Pages (browser) | 35/35 reproduced | **0 of 34** reproduce. 5/5 setup checks confirm each attack really ran. |

The check counts differ slightly between BEFORE and AFTER. `AUDIT_FINDINGS_CLOSED.md` explains why: checks were split, reworded or turned into setup checks. No PoC was deleted or bypassed.

## 5. Current PAR assumptions

Sources:

- **par.family/docs**, re-read today at 21:10 UTC.
- **pardotfamily/par** contracts @ `ab64911` (2026-09-08).
- **pardotfamily/par-sdk** @ `f5a5beb`, v0.3.0 (2026-09-20).

Both repositories were cloned 23 Sep 2026.

**Difference from the previous audit (Robinhood Chain):** none. Every address, selector and parameter in the audit's §3 table is unchanged in today's docs and in the source snapshots.

The current PAR sources also contain things the original V2.5 code did not use at all:

- The SDK lists deployments on Arc, Base and BNB Chain. SyncNet stays on chain 4663 and refuses other chains.
- PAR has fee-routing contracts: fee splitter `0x85a1…a4C1` (plus v1), Disperse V2 `0x28a5…9B9b` (plus v1), and the buyback and holders wallets.
- Holder rewards are now "paid in the asset earned" (par `ab64911`).

SyncNet now blocks all of these addresses as creator-fee recipients. Its holder copy says PAR's distributor pays in rounds.

| Item | Current value | Source | How SyncNet uses it |
|---|---|---|---|
| Chain | Robinhood Chain **4663** (`0x1237`), RPC `https://rpc.mainnet.chain.robinhood.com`, explorer `robinhoodchain.blockscout.com` | SDK `chain.ts`, docs | Read live (`eth_chainId`) from the RPC and the wallet. Anything else blocks. |
| Multi factory | `0x3ea29975a79900179F3e1aEF93347Ba4210c29C1` | docs, SDK, README | Launch target (no opening buy). Code presence checked live. |
| Multi router (**launchForwarder**) | `0x458D2a59c2F3dd32775a64eE72004561440d64Df` | docs, SDK, README | Launch target with an opening buy. `factory.launchForwarder()` must equal it (checked live; blocking for an opening buy). |
| Single factory / router / locker | `0x9d33…e76F` / `0x73d8…d120` / `0x8a6d…A231` | docs, SDK | Read-only fallback for older launches. Blocked as recipients. |
| Quote pricer | `0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563` | docs, SDK | `factory.quotePricer()` must equal it (live, blocking). `isPriceable`, and `route(quote)` → `(Hop[], qualifies)` for buy legs. |
| WETH / USDG | `0x0Bd7D308…AD73` / `0x5fc5360D…1168` | SDK, README | Router and factory `weth()` checked live. USDG preset by address. |
| Swap router | Uniswap SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2` | SDK, README | `router.swapRouter()` checked live (warning) |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | SDK, README | `router.manager()` checked live (warning) |
| Multi locker / fee escrow | `0x5826…2D59` / `0x1C27…4386` | docs, SDK | Blocked as recipients. HolderVault `escrow()` must equal the escrow (live). |
| HolderVault / BurnVault / FloorVault | `0x4B79…353C` / `0x16c8…958E` / `0xA5e8…1829` | docs, SDK | Fee destinations. Their `escrow()` / `multiFactory()` links checked live. The FloorVault source is not published. |
| Launch fee | **0.0005 ETH** | docs | Read live (`launchFee()`). Direct path: `msg.value == launchFee`. Router path: `launchFee + Σ legs`. |
| Launch config 0 | supply 1,000,000,000 (18 decimals), phantom reserve 1.3557 ETH, tick spacing 10, no hook | docs, README | `getLaunchConfig(0).enabled` checked live (blocking) |
| baseFeeBps / protocolFeeShareBps / maxCreatorTaxBps | **100 / 5000 / 1000** (1%, 50% of base, 10%) | docs, README | Read live at simulation and re-read before sending. A change refuses the send. Never hard-coded. |
| Economics | Pool fee `= (base + tax) × 100` (hundredths of a bip). Creator gets `base × (1 − share) + tax`. The fee split is frozen per launch. | factory source | Shown in the final review. Verified after inclusion (`economicsChanged` records any difference). |
| `expectedEconomics` | PAR: "a launch quoted in an actively traded asset should not pin `expectedEconomics` (leave it zero)" | README | Committed (`previewLaunchEconomics`) when every market is PAR-curated. Otherwise not committed, with the reason shown. |
| Metadata limits (UTF-8 bytes) | name 64, symbol 16, logo 512, description 2048, each social 256 | `PairPadLaunchDeployer.sol:37-41` | Checked with `TextEncoder` before simulation |
| Markets | 1–5 `pairTokens`, no duplicates, WETH not alongside native ETH | `MAX_MARKETS = 5`, README | SyncNet allows 1–5 ERC-20 markets, chosen by address |
| Selectors | `launchToken(TokenParams,uint256,address[])` `0x5a4b7ef0`. `launchAndBuyWithEth(TokenParams,uint256,address[],Leg[],uint256)` `0x5fe889a4`. `getLaunchedToken` `0x3cf28b5a`. `route(address)` `0x07e9caea`. | source, SDK ABI | Encoded by viem and decoded again by SyncNet's own decoder (cross-check) |
| Structures | TokenParams (name, symbol, logo, description, Socials(twitter, telegram, discord, website, farcaster), creatorFeeRecipient, creatorTaxBps, expectedEconomics, salt). `LaunchedToken` (token, deployer, creatorFeeRecipient, poolFee, tickSpacing, baseFeeBps, creatorTaxBps, protocolFeeShareBps, protocolFeeRecipient, launchedAt, marketCount, exists). `Market` (pairToken, phantomQuote, tickLower, tickUpper, liquidity, positionId). `Leg` (uint8, Hop[], uint256). `Hop` (PoolKey, bool). `PoolKey` (c0, c1, fee, tickSpacing, hooks). | `ILaunchpadV3.sol`, router | Decoding and verification |
| Deployer and address | The router calls `launchTokenFor(…, msg.sender)`: the deployer stays your wallet. CREATE2 salt is `keccak(abi.encode(originalDeployer, salt))`. | factory, router | Predicted address; the SyncNet salt commitment survives the router path |
| Permissions | `canLaunch = launchEnabled || whitelisted` | factory | `canLaunch(yourWallet)` checked live (blocking) |
| Governance | The owner can change base fee, protocol share and max tax **for future launches**, disable launching, and move fee recipients by CTO with a 3-day notice plus a 3-day execution window. It "cannot touch the pool, the locked position, the token or fees already credited". "The contracts are not audited." | docs (quoted) | Stated on the Risk page and in the builder |
| Token and lock | Metadata is written into the contract and cannot change. The token has no owner. The locker has no withdraw or remove-liquidity function. | docs, source | Project-page claims are made only after the factory record is verified on-chain |

## 6. Live-read verification results

Read-only calls were attempted from this build environment today (23 Sep 2026, 21:10 UTC). Nothing was broadcast.

| Target | Result | Label |
|---|---|---|
| `https://par.family/docs` (WebFetch) | **Read OK.** Addresses, launch fee, fee terms, supply, tick spacing, vault behaviour, CTO rules, owner powers and "not audited" match §5 exactly. | VERIFIED (docs) |
| `https://rpc.mainnet.chain.robinhood.com` (`eth_chainId`) | **Blocked** by this environment's egress proxy (CONNECT 403). Not worked around. | REQUIRES OPERATOR LIVE CHECK |
| `https://api.par.family/health` | **Blocked** (CONNECT 403) | REQUIRES OPERATOR LIVE CHECK |
| `https://robinhoodchain.blockscout.com` | **Blocked** (CONNECT 403) | REQUIRES OPERATOR LIVE CHECK |
| GitHub web pages (WebFetch) | Refused (`PROVENANCE_REQUIRED`). Not worked around. The source snapshots cloned on 23 Sep 2026 were used instead (§5). | Sources: snapshot |

Every live item the brief lists is therefore checked **automatically in your browser** by the builder's PAR LIVE PREFLIGHT, which runs at every simulation and again right before sending. A failure disables LAUNCH LIVE. The same items can be checked independently with `cast` (commands in `FIRST_LIVE_LAUNCH_CHECKLIST.md`).

| Brief item | Preflight check (id) | Blocking? | Offline expectation |
|---|---|---|---|
| Chain | `chain` | yes | 4663 |
| Contracts | `factory-code` | yes | code present |
| Quote pricer | `pricer` | yes | `0x9EfC…d563` |
| Factory/router relationships | `forwarder`, `router-factory`, `router-weth` | yes, with an opening buy; otherwise a warning | router `0x458D…4Df`, factory `0x3ea2…29C1`, WETH `0x0Bd7…AD73` |
| Swap router, PoolManager | `router-swap`, `router-manager` | warning | `0xCaf6…5cb2`, `0x8366…0951` |
| WETH | `factory-weth` | warning | `0x0Bd7…AD73` |
| Launch config | `config` | yes | config 0 enabled |
| Fees | `fee`, `base-fee`, `protocol-share`, `max-tax` | yes | 0.0005 ETH, 100, 5000, 1000 (values are shown, not assumed) |
| Your wallet may launch | `can-launch` | yes | true |
| Vault wiring (holders/burn/floor) | `vault` | yes | escrow / multi factory |
| Routes (opening buy) | engine: `route(quote)` hops + `qualifies` | market skipped and disclosed | — |
| Selected real launch inputs | engine: token code, `isPriceable`, `eth_call` simulation + `estimateGas` of the exact calldata, `presendCheck` | yes | — |
| Canonical addresses ($SYNC `0x6368…ca37`, SYNCAT `0xb0a3…C967`) | not automatic | — | **manual:** `getLaunchedToken` shows the SyncNet deployer (checklist) |

## 7. Remaining external trust assumptions

1. **PAR contracts** behave as their published source. PAR states they are not audited. The FloorVault source is not published.
2. **PAR governance:**
   - The owner can change fee terms for *future* launches, disable launching, and CTO a fee recipient with a 3-day notice.
   - PAR's operator and keeper wallets run holder payouts, burn buybacks and floor rebalances.
3. **Robinhood Chain RPC** (public endpoint): simulation, preflight and verification read it. A dishonest or stale RPC could mislead the pre-send checks, but not the wallet's own signing. You can cross-check on the explorer or with another RPC.
4. **PAR indexer** (`api.par.family`): secondary evidence only. It is used for cross-device duplicate detection, the map, and a tx hash recovered after an on-chain confirmation. On-chain state stays authoritative.
5. **Your wallet software** shows the request faithfully and signs what it shows.
6. **Netlify**: hosting, function runtime, secrecy of environment variables, delivery of the CSP and headers.
7. **Pinata** (plus the optional second pinning provider) and the **IPFS gateways**: availability of the image behind the permanent `ipfs://` URI.
8. **Upstash**: durable limits, quotas and registry storage. Needed only for public features.
9. **`vendor/viem.js`**: could not be compared with upstream offline. Mitigated: every calldata is independently decoded and compared field by field before simulation.
10. **Browser storage**: local launch evidence lasts only as long as the site data does. Export it.

## 8. What still requires manual verification

Everything below is in `FIRST_LIVE_LAUNCH_CHECKLIST.md`, in order.

1. **Deployment:**
   - `/api/config` shows `v2.5-rc` with every public flag `false`.
   - Internal files return 404.
   - The CSP header is present.
   - Env secrets are ≥ 32 characters, and the Pinata key is scoped.
2. **PAR LIVE PREFLIGHT** shows ✓ on every line in your browser (§6 table).
3. **$SYNC and USDG addresses** match `0x6368e007b9f0b941560ed1f3bceb20247f5eca37` and `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`. $SYNC's PAR record shows the SyncNet deployer wallet (`cast` command in the checklist).
4. **`/api/launch-guard`** reports `"indexer":"ok"` from Netlify. Otherwise, check the ticker on par.family yourself; the builder asks for this.
5. **Wallet behaviour:**
   - EIP-712 signing shows `SyncNet Launch Provenance` / `LaunchIntent`.
   - The transaction popup shows the target and value from the final review.
   - The wallet never asks for an approval.
6. **The launch itself:** see checklist steps 7–10, then RE-VERIFY → `ONCHAIN_VERIFIED` / `FULLY_VERIFIED`, then publish the proof and see **BUILT WITH SYNCNET · VERIFIED** on `/registry.html`.
7. **Legal review** of Terms, Privacy and Risk before opening to the public.

## 9. Known limitations

The full list is in `docs/KNOWN_LIMITATIONS.md`. The main ones:

- **Local evidence and devices.** Launch evidence lives in the launching browser until you export it. Recovery by tx hash, token or wallet works everywhere; provenance needs the exported file.
- **Cross-device duplicates.** Detection depends on PAR's indexer. When both SyncNet's guard and the indexer are down, the builder asks for an explicit acknowledgement instead of blocking.
- **Wallets.** Mobile needs a wallet's in-app browser or an injected wallet; there is no WalletConnect.
- **Contract wallets.** EIP-1271 proofs are checked at the current block.
- **Economics.** `expectedEconomics` is committed only for all-curated markets, following PAR's own guidance. Otherwise SyncNet re-checks right before sending.
- **Native ETH.** A native-ETH market (`0x0`) is not selectable, by design.
- **Upload abuse.** Many wallets from one IP are bounded by the IP and global caps. That is a cost bound, not a Sybil proof.
- **Canonical protection.** Only identities marked `canonical` in `syncnet-projects.json` are *blocked* from imitation. Other shared tickers get a warning, as the brief asks.
- **What "BUILT WITH SYNCNET · VERIFIED" proves.** The deployer signed a SyncNet intent that the launch transaction committed to. It does not prove which website was used: a technically skilled deployer could build the same commitment by hand.
- **Marketplace.** It stays a prototype with no payments, escrow or rights transfer.

## 10. Can public launch be enabled after the first live launch without a code change?

**Yes.** Every public feature is a server-side switch read at function start-up. You change environment variables in Netlify and redeploy the same ZIP.

1. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, a scoped `PINATA_JWT`, and optionally `SYNCNET_PIN_SECONDARY_URL`/`_TOKEN`.
2. `SYNCNET_REGISTRY_SUBMISSIONS=true` → publish your first launch from MY LAUNCHES. The server verifies it on-chain first.
3. `SYNCNET_PUBLIC_UPLOADS=true` → wallet-signed uploads with per-wallet, per-IP and global quotas.
4. `SYNCNET_PUBLIC_LAUNCH=true` → the live panel is shown without the operator key.
5. `/api/config` confirms each switch. Each switch stays closed if its prerequisites are missing, and the closure is logged. `SYNCNET_UPLOADS_DISABLED=true` or unsetting a flag closes it again.

Data-only changes, such as adding a canonical identity or a curated Registry entry, are edits to `syncnet-projects.json`, not code. The step-by-step and the checks after each switch are in `docs/DEPLOYMENT.md` §5.

What would need code: supporting another chain, following a *replacement* PAR stack at new addresses (PAR replaces stacks as a set), or adding WalletConnect.

## 11. Final adversarial pass

Each attack was tried against this build, through the real pages and functions, with the mocks from §3.

| Question | Attempt | Result | Evidence | Residual |
|---|---|---|---|---|
| Can it launch twice? | Relaunch after a sent launch, after a reload, from a second tab, after a wallet error | **No.** An unresolved record blocks. An existing token needs a checkbox plus typing `SYM AGAIN`. A cross-tab lock and a guard re-run at send time. The page locks after sending. | R02, R11, R22, PoC F-R1 (0/7) | Another device with the SyncNet guard and PAR indexer both down: warning plus acknowledgement |
| Stale calldata? | Edit during the wallet popup; re-simulate | **No.** P is deep-frozen, inputs are locked, and the wallet receives `P.request` byte for byte. | R03, R21, PoC F-R1/N1 | — |
| Stale signatures? | Sign, then re-simulate or edit; replay an old recordHash; foreign signer | **No.** Bound to `P.id`, and the fields and signer are verified. | R04, R07, PoC F-P6 (0/5) | — |
| Wallet A reviews, wallet B sends? | Switch account after the review | **No.** Everything is invalidated and re-rendered from P. | R05, PoC F-UX1 | — |
| Chain state changes without invalidation? | Switch chain; change PAR fees between simulation and send | **No.** Chain change invalidates. PAR state is re-read and re-simulated before sending, and a change refuses. | R06, engine `presendCheck` | Change between send and inclusion: recorded (`economicsChanged`), not preventable |
| Editable UI alters the approved tx? | DevTools edits after the review | **No.** Only P is sent. The final review is generated from P. | R03, R21, static | — |
| Tx broadcast but disappears from SyncNet? | Throw after broadcast, reload in the popup, receipt timeout, clear notices | **No.** The record is written before the wallet is asked, never deleted, and re-verified automatically. | R01, R02, R08, R10, PoC F-R3 (0/6) | Clearing site data without an export: RECOVER by tx hash, token or wallet |
| Provenance fabricated? | Forged proof, tampered intent, other deployer, imported "verified" file | **No.** Full on-chain verification: 422 on the server, UNVERIFIED on pages. Imports are neutralised. | R20, R23, srv registry | Commitment can be built by hand (see §9) |
| Fake token shown as canonical $SYNC? | Token with the SYNC ticker or a confusable one | **No.** Identity is by address, impostors are flagged, and canonical tickers or names are blocked at launch. | R12, PoC F-P3, srv launch-guard | — |
| Random contract gets authoritative badges? | `/project/<USDG or EOA>` | **No.** Shown as NOT VERIFIED AS A PAR LAUNCH, with no claims. | R13, PoC F-P7 | — |
| Upload infrastructure abused? | Anonymous, fake image, polyglot, bomb, spam, forged session, gate closed | **No.** Sessions only; decode and re-encode; quotas; generic errors; kill switch. | R17, R18, srv (36), image (129), PoC F-S2 | Sybil wallets: cost-bounded |
| Duplicate impersonates an existing SyncNet project? | Same or confusable ticker or name as a canonical project | **Blocked** for canonical identities. Other collisions get a warning plus acknowledgement. | srv launch-guard, R11 | By design per the brief |
| Metadata spoofs users? | Bidi, zero-width, controls, look-alikes, long text, http links | **No.** Rejected before simulation. Display is sanitised. INSECURE LINK is shown for http. | R14, R15, PoC F-C1, F-P4/5 | — |
| Wrong fee recipient traps fees? | Zero, burn, precompile, PAR and Uniswap infrastructure, vaults, market tokens, other contracts | **Blocked**, or explicit confirmation for contracts. A different EOA gets a warning. | R16 (11 cases), PoC F-TX3 | A mistyped but valid EOA cannot be detected. The final review shows it. |
| PAR infrastructure change silently invalidates assumptions? | Changed forwarder, pricer, fees, config, `canLaunch` | **No.** The 15–16 check live preflight blocks or warns, and it runs again before sending. | e2e preflight, engine | A replacement PAR stack at new addresses needs a code update. The old stack is detected as disabled. |
| Indexer outage causes a second launch? | Indexer down or slow after a launch | **No.** On-chain state is authoritative. Local records plus a chain read block the repeat. | R09, R02 | See the first row (other device) |
| Mobile state loss causes a duplicate? | Reload, app switch or tab loss during the wallet popup (320–430 px) | **No.** Same as desktop: the record is persisted before the wallet is asked. | mobile suite, R02 | A private-mode wallet browser with no storage: server guard plus warning |
| Any label says VERIFIED without evidence? | Registry, Marketplace, project page, builder, imports | **No.** Every VERIFIED label names what was verified and is re-checked live. | R13, R20, R23, PoC F-P1, e2e registry and marketplace suites | — |
| Script injection via metadata? | Launch a token named `<img src=x onerror=…>` with a `<script>` description, then open the builder, project page, MY LAUNCHES, Registry and both maps. Separately, hostile bidi and oversized names in the indexer. | **No.** Rendered as plain text everywhere. `script-src 'self'` as a second layer, and a CSP of `default-src 'none'` on every function response. | R25 (14 checks), e2e hostile-indexer fixture, static | — |

Found and fixed during this pass (details in `AUDIT_FINDINGS_CLOSED.md`):

- the two-tab race;
- an imported "FULLY VERIFIED" record;
- a simulation button that looked available after a launch;
- a stale PASS on the duplicate check;
- the missing encoder cross-check;
- the route `qualifies` flag.

Two tests were added in this pass: R24 (wallet disconnect) and R25 (hostile HTML metadata).

## 12. Launch gates

| Gate | Verdict | Basis |
|---|---|---|
| **FIRST CONTROLLED LIVE LAUNCH** | **GO** | Everything that can be verified before broadcast is implemented and tested (§3–4, §11), and no known software blocker remains. The live-chain items that this environment cannot reach are enforced in your browser: the preflight and a real `eth_call` simulation of the exact calldata must pass before LAUNCH LIVE unlocks. |
| **PUBLIC LAUNCH AFTER SUCCESSFUL FIRST LIVE LAUNCH** | **NO-GO** until the configuration and live checks in §10 are done. No code change is needed. | The public code paths are implemented and pass the abuse tests. Their production infrastructure, however, is not provisioned or observed yet: Upstash (without it the public switches stay closed by design), a scoped Pinata key and a second pin, gate behaviour and 429s on the real Netlify runtime, and a live Registry publication of the first launch. Legal review of the public terms is also outstanding. It becomes GO when `docs/DEPLOYMENT.md` §5 passes on the live site. |

**The one operator step for the blocker only you can clear:**

> Deploy this ZIP to your Netlify site with the Functions included (Netlify CLI or Git; see `docs/DEPLOYMENT.md`). Set `SYNCNET_CANARY_KEY` and `SYNCNET_UPLOAD_KEY` (both ≥ 32 random characters) and a scoped `PINATA_JWT`, and leave every `SYNCNET_PUBLIC_*` flag unset. Check that `/api/config` returns `v2.5-rc`. Then open `/build.html?live=canary` and prepare your project. Press **LAUNCH LIVE** only when four things are true:
>
> - The final review shows `PAR live preflight N/N checks passed`, `SIGNED ✓` and `no duplicate found`.
> - The line under the button says "All checks complete".
> - Your wallet popup shows Robinhood Chain.
> - The popup shows the same **to** and **value** as the final review.
>
> Then follow `FIRST_LIVE_LAUNCH_CHECKLIST.md` steps 8–10.
