# Marketplace: Pons V2 as a supported origin (`feature/syncnet-economies-v0`): 26 Sep 2026

The Project Marketplace is now launchpad-agnostic, with two supported origins: **PAR** (unchanged) and **PONS V2**.

- `lib/syncnet-origins.js` (new, browser + server): resolves a token's origin ONLY from live reads of the canonical factories
  (PAR multi/single; PonsV2LaunchFactory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`, verified against ponsdotdev/pons-labs
  `162310f`); positively detects Pons V1 as not yet supported; classifies the creator-fee right (vault / contract / unknown /
  encumbered / wallet); single validated fee-transfer builder whose destinations are exactly the canonical factories.
- Server: claims, listings and fee-right settlement use the resolver; origin is server-derived and never signed; Pons evidence
  texts name "(Pons V2 factory record)"; an active Pons protocol fee-recipient override blocks including/settling the fee right.
  EIP-712 domain and structures unchanged; legacy records read as PAR without migration.
- UI: automatic origin detection in SELL A PROJECT, LIVE PAR / LIVE PONS PROJECT badges, Pons PAIR/STATUS facts, ALL/PAR/PONS
  filter over the one shared market, "SUPPORTED ORIGINS · PAR · PONS V2"; Project Pages show a Pons V2 origin block.
- **Passport authority fix (PAR and Pons):** deployer / fee-recipient evidence only establishes the FIRST Passport; afterwards only
  the recognised operator may claim (refresh) and control changes only via the signed Marketplace transfer. The retired
  fee-recipient takeover (`operator-superseded`) let a seller who sold only the Passport take it back; legacy entries stay
  readable and are annotated as granting no authority. Same rule as the standalone main fix `455315f` (below), extended to Pons.
  Tests: `tests/server/passport-authority.test.mjs`.
- No Pons launching, trading, fees or splitter. Tests: `tests/server/marketplace-pons.test.mjs`, `tests/regression/rc-marketplace-pons.mjs`.

# Security fix: Project Passport authority (main): 26 Sep 2026

- **Fixed:** a seller who sold only the Project Passport (creator-fee right not included) could make a fee-recipient claim
  and supersede the buyer (`operator-superseded`), taking operational control back. Deployer / fee-recipient evidence now
  only establishes the FIRST Passport; afterwards only the recognised operator may claim (refresh), any other wallet gets
  `409 operator_exists` before its nonce is consumed, and the operator changes only through the signed Marketplace transfer
  (TransferIntent + TransferAccept). Legacy `operator-superseded` entries stay readable and are annotated as granting no
  authority. EIP-712 structures and settlement unchanged. Client no longer invites a conflicting wallet to sign a claim.
- Tests: `tests/server/passport-authority.test.mjs` (36 checks; 16 fail on the unpatched code).

# V2.5 Economies V0 (`feature/syncnet-economies-v0`): 25 Sep 2026

Additive. Marketplace, Registry, the launch engine, LaunchIntent and the send path are untouched.

- **Economy view** `/economy.html?root=0x…` (also `/economy?root=`): every PAR launch with a market paired with the root, derived from `/api/par-launches-all` by contract address. No stored membership, no Economy ranking, no volume/TVL figures, no recursive graph.
- **Parent recognition** via `POST /api/economies`: one EIP-712 signature (domain "SyncNet Economies") by the root's current Project Passport operator (read-only reuse) or a reviewed curator in `syncnet-economies.json` (ships empty). Stored append-only in `eco:cur:v1:<root>` Redis sets (SADD only), folded at read time from the signed `issuedAt`, so concurrent writes cannot conflict and no new store primitive is needed. Recognizing requires a live on-chain PAR market between child and root. Labels: PARENT-RECOGNIZED / RECOGNIZED BY $ROOT OPERATOR.
- **Curator requests** for non-PAR roots are stored as PENDING and grant nothing until reviewed; they are private (never served over HTTP — maintainers read them in the durable store).
- Per-wallet write limits and the global claim-request limit are charged only after the signature verifies and only for an actionable write; replays of public signed events (duplicate/stale/full) consume no quota. Only per-IP limits apply before verification.
- **Rollout gate** in `flags.js`: `SYNCNET_ECONOMY_CURATION=true` (needs the durable store), kill switch `SYNCNET_ECONOMIES_DISABLED=true`.
- Entry points: "ECONOMY VIEW" on the Map and the Project page. "Create a project in the $X Economy" uses the Builder's existing `?with=` prefill.
- Tests: `tests/unit/economy.test.mjs`, `tests/server/economies.test.mjs`, `tests/regression/rc-economy.mjs`, static-audit rules. See `docs/ECONOMIES.md`.

# V2.5 Marketplace V1 wallet hotfix (`v2.5-marketplace-v1-wallet-hotfix`): 24 Sep 2026

Two narrow changes, nothing else:

- **Wallet selection on `/marketplace.html`** now uses the Builder's proven discovery/chooser model: EIP-6963 announcements plus the legacy `window.ethereum.providers` fallback, deduplicated by provider object and rdns, labelled by advertised name or flags (Brave Wallet / Phantom / Rabby before MetaMask). One wallet → CONNECT connects it directly; several → an explicit chooser (also on CHANGE WALLET). Silent restore after a refresh happens only when exactly one wallet had authorised the page. Previously the page took `providers[0]`, which made only the first-announcing extension (e.g. Phantom) usable. Choosing a wallet is UI-only: no signature, transaction, approval or chain switch.
- **Hero badge copy:** “SIGNED LISTINGS · VERIFIED HANDOVERS · NON-CUSTODIAL”. The settlement facts (no custody, no escrow, manual settlement, wallet-to-wallet ETH, manual off-chain items) stay in the rule cards, the deal room, Terms and Risk.
- Tests: new `tests/regression/rc-wallet-select.mjs` (32 checks); existing suites unchanged apart from the three hero-copy assertions.

# V2.5 Marketplace V1 + IPFS display (`v2.5-marketplace-v1`): 24 Sep 2026

Post-launch hardening of the build that launched PONSYNC. The launch engine is untouched (byte-identical launch paths, verified by the full regression battery).

**Canonical IPFS display** — `lib/syncnet-ipfs.js` is now the ONE image renderer everywhere (token page, Registry, map, Marketplace, builder preview, final review, My Launches, kit): strict `ipfs://<CID>` parsing, display through gateway.pinata.cloud → ipfs.io → dweb.link with automatic per-image fallback, then a deterministic SVG placeholder. Stored metadata always remains `ipfs://<CID>` — gateway URLs are display-only and never written into records or calldata.

**Marketplace V1 (real, non-custodial)** — the front-end prototype (“Marketplace Lab”, browser-local test listings, simulated acquisitions) is deleted, not hidden. In its place:

- `/api/marketplace` + `lib/syncnet-market.js`: persistent server-side records (Upstash) — operator claims, listings, offers, two-party operator transfers, deal settlement checklists. IDs are the EIP-712 digests themselves.
- Everything is authenticated by free EIP-712 signatures (domain `SyncNet Marketplace` v1, chainId 4663; ECDSA + EIP-1271), with per-wallet single-use nonces, expiries and server-enforced status transitions. No transactions, no token approvals, no gas for marketplace records.
- Claims are conservative and chain-checked live: deployer, current transferable creator-fee recipient wallet, or the already-recognised operator.
- Project Passport = signed operator record with append-only history (prior operators are never deleted); shown on `/project/<token>` as SYNCNET OPERATOR VERIFIED, distinct from PAR INDEXED.
- Settlement is non-custodial and honest: ETH payment is a plain wallet-to-wallet transfer verified from the chain; the creator-fee right moves only via PAR’s own `transferCreatorFeeRecipient` and is verified by re-reading the chain (never from a tx hash alone); off-chain items are MANUAL and need both-party confirmation; completion needs both parties’ signatures over the exact checklist state. No escrow, no custody, no fake completion.
- Fail-closed: without a durable store (or with `SYNCNET_MARKETPLACE_DISABLED`) writes refuse and the page says the Marketplace is not enabled. A store outage answers 503 “unavailable”, never fake data.

**Copy** — Terms, Risk, Privacy, README and docs now describe Marketplace V1 truthfully; all “lab / local test / simulated” marketplace wording is gone from product surfaces.

**Tests** — +77 marketplace server checks, +23 IPFS display checks, +45 cross-browser marketplace walkthrough checks (two real browser contexts: claim → list → offer → deal → transfer → payment → completion → provenance, plus cancel/authz/stale/malformed/RPC-down/storage-down/image-failure modes).

# V2.5 Final Release Candidate (`v2.5-rc`): 23 Sep 2026

Stabilization and completion of V2.5. There are no new products, no redesign and no tokenomics changes. Every audit finding (H1, H2, M1–M4, L1–L15) is closed: see `AUDIT_FINDINGS_CLOSED.md`. The full report is `FINAL_RELEASE_REPORT.md`.

**Launch safety**

- Launch state is race-safe:
  - The prepared launch P is deep-frozen and snapshotted at LAUNCH.
  - A durable record is written and read back **before** `eth_sendTransaction`: calldata, target, value, gas, chainId, draft, metadata, deployer, recipient, tax, markets, expected economics, intent record, typed data, signature and timestamps.
  - Any wallet error that is not a rejection means BROADCAST_UNKNOWN, and the chain is watched.
  - Inputs are locked while the wallet is open.
  - A cross-tab launch lock prevents two tabs from launching at once.
- The signature is bound to one prepared launch. Any simulation, edit, account change or chain change invalidates it. It is checked against recordHash, salt, token, operator and chainId, and the signer is recovered (ECDSA or EIP-1271).
- Every prepared calldata is decoded again by SyncNet's own ABI decoder and must match field by field.
- Immutable **final review** generated from P, including network, wallet, predicted token, metadata, markets, recipient, tax, PAR base fee, protocol share, pool fee, launch fee, opening buy, total value, recordHash and signature status. It is followed by "I UNDERSTAND THIS LAUNCH IS REAL AND IRREVERSIBLE." and the typed ticker.
- **PAR live preflight** (15–16 on-chain checks) at simulation, and a re-read of PAR state plus re-simulation right before sending. PAR parameters are never hard-coded.
- UTF-8 byte limits (64/16/512/2048/256), NFC, and bidi, zero-width and control characters rejected. https-only links.
- Creator-fee recipient safety: PAR and Uniswap infrastructure, vault addresses, burn/zero/precompile addresses, market tokens and canonical assets are rejected. Contracts need confirmation.
- The **MAINNET · REAL FUNDS** banner comes from the RPC and wallet chain, never from the URL. A malformed rehearsal URL disables the page.

**Recovery and provenance**

- Launch lifecycle states from PREPARED to FULLY_VERIFIED. Records are never deleted. RE-VERIFY treats the chain as authoritative and the indexer as secondary.
- New page `/launches.html`: MY LAUNCHES / RECOVER A LAUNCH, by tx hash, token or wallet, with import/export. Imported claims are neutral until re-verified.
- Proof `syncnet.launch.proof.v2`, fully verifiable on-chain. Registry statuses: SYNCNET ORIGIN, BUILT WITH SYNCNET · VERIFIED, OPERATOR VERIFIED, PAR INDEXED, PROFILE ONLY, UNVERIFIED. Every signature-, proof- and chain-based status is re-checked live in the visitor's browser.
- Post-launch verification reads the actual markets, pool fee, base fee, protocol share, tax, recipient, deployer and metadata, and records EXPECTED / ACTUAL / VERIFIED.

**Identity and claims**

- Canonical identities ($SYNC, SYNCAT) are matched by contract address only. Look-alike tickers and names are blocked at launch (`/api/launch-guard`, confusable skeletons) and flagged on pages.
- The duplicate guard uses local records, the chain and the server-side PAR indexer, and runs again at send time.
- Project pages make launch claims only for verified PAR launches. Anything else shows NOT VERIFIED AS A PAR LAUNCH.
- Marketplace statuses: ON-CHAIN ADDRESS / CONTROL VERIFIED / TRANSFERABILITY VERIFIED / UNVERIFIED. Control requires a signed challenge.
- Descriptions are shown in full, and http:// links are shown as INSECURE LINK. Burn, floor and holders wording states PAR's operator dependency.

**Server**

- A server-side rollout gate (`/api/config`) covers public launch, public uploads and registry submissions. Each is off unless its env flag is exactly `true` and Upstash is configured. `SYNCNET_UPLOADS_DISABLED` is the kill switch.
- Uploads:
  - There is no anonymous path. Uploads need a founder session or a wallet-signed session.
  - Images are decoded and re-encoded server-side with metadata stripped.
  - Limits are per wallet, per IP and global.
  - An optional second pinning service is supported, and the Pinata key should be scoped.
- The founder key must be ≥ 32 characters. Rate limits, IP and global lockouts, and revocable 2 h sessions apply.
- site-check has DNS pinning (no rebinding), full IPv4/IPv6 blocklists, streamed caps and a rate limit.
- PAR data functions are cached, single-flight and have no query-string bypass. The tokenlist proxy was replaced by a validating JSON function.
- Generic errors everywhere, and logs use hashed identifiers. New functions: `config`, `upload-auth`, `launch-guard`, `registry`, `par-tokenlist`.

**Tests**

- `node tests/run-all.mjs` runs 11 suites: static audit, 333 core unit, 129 image, 434 infra, 82 server-abuse, 299 E2E, 188 regression (R01–R25) and 112 mobile checks (1,577 in total), plus the audit PoCs. All pass, and 0 audit vulnerabilities reproduce.

# V2.5 — Opening buy (dev buy inside the launch transaction) — 23 Sep 2026

- **Step 03 · Opening buy · optional** (default 0). The only buy guaranteed to land first: it executes inside the launch transaction through PAR’s `PairPadMultiRouter.launchAndBuyWithEth`, which calls `factory.launchTokenFor(…, msg.sender)` — the deployer stays your wallet and the token address is unchanged (CREATE2 salt is `keccak(originalDeployer, salt)`), so SyncNet’s salt commitment still works.
- **How the buy is built:** ETH is split equally across markets; each market’s route from ETH is read from PAR’s quote pricer (`route(quote)`, reversed for buys, as in PAR’s SDK). Markets without an ETH route are skipped and disclosed; if none is reachable the simulation refuses.
- **Safety:** SyncNet checks that the factory’s `launchForwarder()` is exactly the expected router (otherwise the buy is refused); simulates the exact output first, then sets `minTokensOut` from the chosen price protection (0.5/1/2/5%) and re-simulates; checks the wallet can pay value + gas before asking the wallet; caps the buy at 10 ETH against typos. A failed buy reverts the whole launch — no half-launched token.
- **Transparency:** amount, price protection and router are committed in the salted launch-intent record; review shows tokens, % of supply and the exact ETH leaving the wallet; the founder live panel states value and destination; buys ≥5% of supply get a neutral “public and often read as a risk signal” warning; after launch SyncNet reads the wallet’s token balance, confirms the minimum was met, and records it in the proof; the project page shows it from the proof.
- **Unchanged:** with 0 ETH the launch still goes directly to the factory, exactly as before.
- **Not yet:** public detection of opening buys for tokens not launched through this browser (needs the server-backed Registry or PAR trade data).
- Tests: 280 E2E checks (new opening-buy suite with a mocked router, pricer routes, slippage and balance paths).

# V2.4 — Website decision in the builder, saved drafts — 23 Sep 2026

- **Step 01 · Website is now an explicit, required decision** with three options: *I have a site* (URL required and validated), *Build one with my AI* (opens the Project Kit prefilled with the draft; URL optional until published) and *No website* (clears and disables the URL, explains that the token will never link to a site). http:// links are warned about.
- **Step 04 · Review reminder:** if no website URL is set, a card says the token will launch without a link — permanently — with BUILD IT WITH PROJECT KIT and ADD A URL (jumps back to step 01 and focuses the field). An explicit “No website” is shown as the creator’s choice.
- **Saved drafts:** the builder saves non-sensitive fields in this browser (name, ticker, description, X, website + choice, IPFS/HTTPS image URI, tax, fee destination, fee recipient, connections + notes) so creators can leave to build their site and return. On return a banner offers CONTINUE DRAFT / START FRESH; nothing is auto-filled without consent. Never saved: simulations, predicted addresses, salts, signatures, upload sessions, founder state or un-uploaded images. Restored connections are re-verified on-chain before they count as eligible. Drafts expire after 14 days, are cleared after a confirmed live launch, and rehearsal drafts are stored separately. A `?with=` link cannot overwrite an unanswered saved draft.
- Tests: 250 E2E checks (new website + draft suite).

# V2.3 — Rehearsal mode, Project Kit, Passport panel — 23 Sep 2026

**Founder rehearsal on a local fork** (`docs/REHEARSAL.md`)
- `build.html?live=canary&rpc=http://127.0.0.1:8545&chain=46630` runs the full launch against a local Anvil fork of Robinhood Chain: real PAR contracts, fake ETH.
- Safety: loopback RPC only, founder mode only, and the fork must use its own chain id (4663 is refused), so a wallet on the real chain can never sign a rehearsal. A malformed rehearsal URL disables simulation instead of silently falling back to mainnet. Rehearsal proofs and pending txs are stored under separate keys and never appear as real launches.
- CSP `connect-src` allows `http://127.0.0.1:8545` / `http://localhost:8545` for this.

**Project Kit** (`/kit.html`) — a free “bring your own AI” site builder
- One form → five ready prompts (website zip, permanent token description, connection notes, launch post, Marketplace listing). Each contains the verified project facts plus fixed safety rules: exact addresses only, no invented numbers, connections are never partnerships, no promises, no wallet-connect/forms/external scripts.
- Netlify Drop guide (drop zip → claim → copy URL before launch → redeploy after launch).
- `syncnet.json` site declaration generator. Builder “Website” field now explains that the value is permanent and links to the Kit (the draft is handed over for 1 hour, non-sensitive fields only).
- No AI runs on SyncNet: zero API cost, no keys, works on every device.

**Project Passport panel** on `/project/<token>`
- Read on-chain from the PAR factory: deployer, creator-fee beneficiary (holder/burn/floor vault, wallet, or contract), whether the fee right can follow a new operator, trading fee, what can still change (recipient only; wallet transfer or PAR Community Takeover).
- States explicitly that fee beneficiary ≠ operator and that operator history is not recorded yet.
- Website check via new `/api/site-check` function (https + public DNS only, no redirects, 5 s, 16 KB, sanitised fields). WEBSITE LINKED ✓ only when the token metadata points to the site AND the site’s `/syncnet.json` points back; one-sided declarations are shown as unconfirmed, a different token as a mismatch.

**Other**
- Community Takeover (CTO) is now named and explained in the builder and Marketplace instead of “3-day override”.
- Fixed a missing `;` in the project page’s HTML escaping of `"`.
- Static audit now fails on invisible/bidi characters in any source file.
- E2E: 226 checks (new suites: rehearsal, Project Kit, Passport).

# V2.2 — Map UX, fee destinations, public/founder separation — 22 Sep 2026

**Map**
- Pressing MAP now always shows a consequence: the result section appears, the page scrolls to it (instant under reduced motion) and focus moves to the result heading. Ambiguous tickers scroll/focus the chooser; no-match/error states flash the status line and keep it visible. Rapid repeat requests: the last one wins. Button shows MAPPING… while busy.
- Homepage: the token map now sits directly under the hero (hidden until first use) with SYNC A PROJECT WITH IT / OPEN PROJECT PAGE actions. Arriving via `?token=` scrolls to the result.
- Fixed: absurd token names in the Map page's “Recent $SYNC connections” cards caused ~5,000px horizontal overflow (card names now sanitised/bounded).

**Image upload / founder canary**
- Root cause of the “Canary upload key” UI seen by normal visitors: `.btn`/`.field` display rules overrode the HTML `hidden` attribute. Added a global `[hidden]{display:none!important}` + a regression test.
- Public image flow is one button: UPLOAD PROJECT IMAGE → normalise (512px PNG, EXIF/GPS stripped) → preview → upload if uploads are open, otherwise a plain-language “ready” message. No keys, env names or route hints in public UI or public API error text.
- The second secret field is gone. One server-checked founder unlock (`?live=canary`) now returns a 4-hour HMAC upload session; the raw upload key never reaches the browser. Optional `SYNCNET_PUBLIC_UPLOADS=true` opens anonymous uploads (off by default; fail-closed).
- A pending (unverified) launch notice is now visible even before the founder panel is unlocked.

**Fees**
- Verified against PAR's contracts + SDK: PAR supports four creator-fee destinations — holders (HolderVault), creator wallet, burn (BurnVault), floor (FloorVault). The builder exposes all four, preselects none, and explains each one's transferability.
- Explicit total fee (e.g. 1% base + 1% tax = 2%) with split: 0.5% PAR protocol / creator share → destination. Re-read from the factory during simulation.
- Fee mode + recipient are part of the simulation equality check, the salt-committed intent record and the exported proof.
- New post-launch check reads PAR's factory `getLaunchedToken` on-chain (recipient, tax, market count, deployer), in addition to the indexer.

**Marketplace**
- Live listings read the creator-fee recipient on-chain. Creator mode → VERIFIED TRANSFERABLE · ON-CHAIN (never seller-selectable; bound to the exact checked address; downgraded on save otherwise). Vault modes → NOT TRANSFERABLE, locked.
- Pre-launch listings record an intended fee destination (default: buyer decides at launch).

**Vocabulary** — MAP a token · SYNC a project · LAUNCH = the on-chain transaction. Nav: Map · Registry · Marketplace · $SYNC token · Labs · [SYNC A PROJECT]. “Build”/“Explore” removed from UI.

**Accessibility** — real tab/tabpanel semantics with arrow keys; fee destinations are a native radio group; tax buttons expose aria-pressed; labelled file input; no text under 11px; higher-contrast microcopy; 44px tap targets on mobile.

**Tests** — `tests/e2e/` (Playwright, fully mocked PAR/RPC/IPFS/wallet): 186 checks across map, builder public/founder/mismatch/recovery, marketplace, all pages desktop + 375px mobile.

# Post-Claude hardening — 22 Sep 2026

- Merged the validated canary safety patch into the latest interactive Marketplace build instead of reverting to the older Marketplace Lab.
- Added complete PAR-history discovery, canonical/collision-aware search, provenance corrections, server-gated operator test access, salt-committed + wallet-signed launch intent, and post-launch PAR configuration checks.
- Marketplace stays interactive but explicitly local/simulated; seller claims no longer masquerade as SyncNet verification.
- See `POST_CLAUDE_HARDENING.md` for the exact operator-test flow and environment variables.


## Marketplace Lab — operational-rights model
- Rebuilt Marketplace around **Project Control / Operational Rights**, never token-contract ownership.
- Added distinct **Pre-launch Sealed Project** and **Live Operating Project** models.
- Added interactive local test listings, SHA-256 package commitments and acquisition-step simulation.
- Added transfer-package classification: verified transferable / manual transfer / immutable / not included.
- Clarified Project Passport as canonical operational project identity that follows the project, not the person.
- Removed the awkward regulatory-status placeholder sentence from Contact.
- No ETH, escrow, Project Passport, creator-fee, domain, repo or social transfer is executed by this prototype.
# SyncNet V2 — Private Live Canary

- Added server-side image upload to public IPFS through a Netlify Function using `PINATA_JWT`; no Pinata secret is exposed client-side.
- Added image type/size/magic-byte validation and optional `SYNCNET_UPLOAD_KEY` protection.
- Added Review metadata preflight showing the exact immutable `ipfs://` URI and gateway reachability.
- Added private live-launch controls gated by operator-only test access, a successful exact PAR simulation, IPFS image preflight and exact ticker confirmation.
- Live launch reuses the exact simulated calldata/salt/value and requests `eth_sendTransaction` only after explicit confirmation.
- Added post-launch receipt, bytecode and immutable token-metadata verification, plus PAR indexer polling.
- Successful canary launches create a local browser provenance proof surfaced in the Registry for the testing browser.
- Default builder behavior remains simulation-first; real-launch controls are available only in the operator-authorized test path.

# SyncNet V2 — Animated Hero Mark

- Replaced the boxed raster homepage hero logo with a frameless inline SVG mark.
- Added a restrained 7.2s convergence loop: cyan + ivory flows meet at the sync point, then travel along the shared path.
- Kept the logo static for users with `prefers-reduced-motion: reduce`.
- No audio, video, canvas animation, or new runtime dependency was added.


## V2 launch clarity patch
- Moved the working contract/topology mapper onto the homepage as a primary utility.
- Standardized homepage actions around `MAP A TOKEN` and `SYNC A PROJECT`.
- Removed the redundant static mini-topology from the homepage.
- Replaced user-facing “quote asset / quote eligibility” jargon in Build with “eligible to sync”.
- Disclosed that discovery scans up to the 200 most recent PAR launch records and that same-branch discovery is first-degree only.
- Surfaced SyncNet profile provenance states in topology rendering without implying affiliation.
- Reframed Attention Radar as source links for checking outside interest.
- Added a visible five-token cap state and lightweight contract-format feedback in Build.
- Added reduced-motion handling. No sound effects or background music were added.

# SyncNet v2 — clarity + topology update — 21 September 2026

- Made **MAKE SYNC A VERB** the central homepage thesis.
- Reduced the primary navigation to Build, Explore and $SYNC; Marketplace and Labs moved under More / footer.
- Simplified the homepage to: create a project → choose what it syncs with → sync.
- Made the real SYNCAT example explicit by showing the resulting markets: SYNCAT / CASHCAT and SYNCAT / SYNC.
- Added a visible network/topology thesis: symbiosis is a connection; synchronicity is the visible network of connections.
- Reworked Explore around contract search rather than a generic project list.
- Added a live token topology mapper using PAR indexer data plus on-chain token metadata where needed.
- The topology shows direct quote connections, projects built around the searched token, and "same branch" projects sharing one of its connections.
- Added a source-first Attention Radar with Google Trends, X live search and Google News links.
- No synthetic attention score is generated.
- Simplified Builder step 2 to "choose up to five tokens; each creates a market with yours."
- Simplified Builder economics to "Who gets the fees?" with Holder rewards clearly shown as ON for the current simulation profile.
- Replaced technical "PAR HOLDER VAULT" wording in the primary review UI with "Holder rewards: ON"; technical detail remains expandable.
- Kept arbitrary PAR-eligible quote tokens, $SYNC and USDG in one selection model.
- Kept transaction execution disabled. V2 remains simulation-only.
- Kept Marketplace explicitly front-end only and Labs non-monetized.

## V2 launch candidate — 22 September 2026
- Fixed custom/preset asset checking in Build: the minimal local viem bundle does not export `getAddress()`, which caused every successful token inspection to end with `v.getAddress is not a function`. Valid addresses are now normalized locally before RPC reads.
- Restored the original full SYNC DUEL experience from the pre-V2 build: Practice Ghost, asynchronous Real Duel via shareable seed URL, five-round charted market paths, local record, and off-chain SYNC XP. No wallet, stake, payment, prize, or token transfer.
- Rewrote Marketplace as a clear feasibility/specification page instead of a vague ownership concept.
- Marketplace now distinguishes a pre-launch Project Blueprint from a live Operating Project, states that standard PAR launches are tradable from the first block, and explains that holder-vault fee rights are permanently non-transferable.
- Added an explicit Marketplace process and a moat section: raw ideas are copyable; the proposed transferable value is the accumulated operational layer, provenance, identity, community/assets, and any genuinely transferable economic rights.

## V2 connection-intelligence patch
- Reframed $SYNC and USDG as **Quick connections**, not exclusive modes.
- Made arbitrary eligible-token syncing explicit and prominent.
- Replaced `N / 5 selected` progress framing with `N connections selected · up to 5`.
- Added `+ ADD ANOTHER TOKEN` and clearer input reset behavior.
- Added a live pre-launch **Connection Preview** that visualizes the selected market topology.
- Added contextual guidance: USDG as a stable reference in multi-market setups; $SYNC as the network connection to the $SYNC branch.
- Added the principle: **5 is a limit, not a target.**
- Added a transparent fee-policy preview: $SYNC connection => $0 planned SyncNet network fee; otherwise $10 planned live-launch fee intended to buy & burn $SYNC. The public V2 remains simulation-only and does not charge this fee.


## V2 project-registry patch
- Added `/registry.html`, a searchable catalog of projects with recorded SyncNet provenance.
- Backfilled SYNCAT as `SYNCNET-001 · SYNCNET ORIGIN` while preserving its independent/community-built relationship to CASHCAT.
- Added Registry provenance badges to topology nodes and token/project pages.
- Added a `Built with SyncNet / recorded, not inferred` Registry preview inside Explore.
- Kept automatic PAR relationship discovery separate from SyncNet provenance.
- Explicitly states that V2 simulations are not registered; future live launches should register automatically only after on-chain confirmation plus operator proof.


## V2 launch cleanup · provenance first
- Removed the planned $10 non-$SYNC fee / $SYNC waiver from the public beta. SyncNet beta fee is $0 regardless of selected connections.
- Reframed $SYNC as an optional network-asset connection, not a discount coupon.
- Rewrote USDG copy to avoid implying guaranteed stability or arbitrage.
- Added name/ticker search on Home and Explore using Registry + the current PAR discovery window; contract lookup remains direct.
- Renamed auto-detected topology provenance to `INDEXED FROM CHAIN`.
- Added canonical `/project/<contract>` routes and kept `/token/<contract>` as a compatibility alias.
- Clarified `SYNCNET ORIGIN · #001` as foundational provenance recorded before the V2 live launcher.
- De-emphasized Attention into a collapsed source-first tool and marked Marketplace as coming later / research preview.


### Search hotfix
- Fixed Explore/Home name search ignoring quote-side market assets.
- Search now includes both sides of observed PAR markets, Registry projects, and the PAR token list when available.
- Expanded recent detail processing to the full configured discovery window.

## V2 search metadata hardening
- Rejects malformed token names/symbols that exceed bounded display lengths before they enter name/ticker search.
- Prevents keyword-stuffed malicious metadata from matching arbitrary searches.
- Search-result labels are ellipsized defensively and cannot expand the page layout.
- Token/project pages now apply the same bounded metadata rules to names and symbols.

## Marketplace interactive correction
- Replaced the old research-preview / discussion-style Marketplace page with a product-first interactive Marketplace Lab.
- Marketplace is now a primary navigation item.
- Added BUY / BROWSE and SELL A PROJECT modes at the top of the page.
- Added Pre-launch and Live Project listing types.
- Added Transfer Package configuration with explicit immutable/non-transferred token + locked liquidity rows.
- Added PONSYNC quick-fill for testing the pre-launch flow.
- Added local listing catalog filters and acquisition-flow simulation.
- Removed explanatory conversation-style sections such as “Can a PAR token be launched but kept unbuyable?” and “The idea is not the moat.”
- Preserved live-canary Build, IPFS upload, search safety fixes and Registry work from the previous merged build.
