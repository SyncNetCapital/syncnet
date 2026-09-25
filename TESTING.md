# V2 QA checklist

## V2.5 release candidate: automated test battery

```
node tests/run-all.mjs        # every suite below, in order; writes tests/RESULTS.json
```

Requirements: Node ≥ 20, Python 3, and Playwright with Chromium (`PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs` if it is not resolvable). Nothing touches a real network:

- The chain is a stateful mock of PAR on Robinhood Chain: factory, router, pricer, launches, receipts, indexer.
- The wallet is an EIP-1193 mock that signs with real secp256k1 keys (EIP-712 and `personal_sign`) and can be told to broadcast-then-throw, lag, switch accounts or chains, or return no hash.
- Pinata, the IPFS gateways and Upstash are fakes. The Netlify functions are the real code, run in-process.

| Suite | File | What it covers |
|---|---|---|
| Static audit | `tests/static_audit.py` | Structural invariants: record written before `eth_sendTransaction`, signature binding, no approval/permit calls, routes and internal-file 404s, server gate, CSP, no invisible or bidi characters. |
| Core unit | `tests/unit/core.test.mjs` | keccak, secp256k1, EIP-712, ABI encode/decode (launch calldata), UTF-8 byte limits, text policy, confusables. |
| Image sanitizer | `tests/server/image-sanitize.test.mjs` | Decode → re-encode, metadata stripping, polyglots, decompression bombs, dimension/frame limits. |
| Server infrastructure | `tests/server/infra.test.mjs` | Sessions, rate limits, lockouts, store, SSRF guard, PAR data caching, error hygiene. |
| Server endpoint abuse (RC) | `tests/server/rc-server.test.mjs` | Every function under abuse: gate closed/open, upload spam, forged sessions, registry forgeries, launch-guard confusables, generic errors. |
| Audit PoCs (AFTER) | `tests/audit/poc-engine.mjs`, `poc-server.mjs`, `poc-e2e.mjs` | The audit's own attacks against this build. The vulnerability checks must **not** reproduce. Setup and positive-control checks must still pass. The originals and their BEFORE results are in `tests/audit/before/`. |
| E2E | `tests/e2e/run.mjs` | Every page and product flow (home, build, network, registry, marketplace, project pages, kit, labs, rehearsal, uploads, wallet flows). |
| Required regressions | `tests/regression/rc-regressions.mjs` | R01–R20 from the release brief, plus R21 (final review = wallet request), R22 (two-tab race), R23 (imported evidence is neutral), R24 (wallet disconnect and reconnect) and R25 (hostile HTML in metadata stays inert text on every page). |
| Mobile | `tests/regression/rc-mobile.mjs` | The real launch and recovery flow at 320/360/390/430 px: overflow, viewport, tap targets, text size. It also sweeps every page at 320 px. The E2E suite covers every page at 375 px. |

Run a single suite with `node <file>`. `SHOTS=/tmp/shots` saves screenshots for the E2E and mobile suites.

## Clarity
- Home headline is MAKE SYNC A VERB.
- The first concrete explanation is: create a project, choose what it syncs with, each selected token creates a market with yours.
- No IGLOO, parent-token, child-token, Network Sync, Stable Sync or meta-market copy appears in active product pages.
- Primary navigation contains Build, Explore and $SYNC; Marketplace/Labs are secondary.
- SYNCAT example explicitly lists SYNCAT / CASHCAT and SYNCAT / SYNC.

## Explore / topology
- Contract mapper accepts only valid `0x` + 40-hex addresses.
- A searched token shows its own direct quote connections when available.
- Recent launches paired directly with the searched contract appear beneath it.
- Projects sharing one of the searched token's quote connections appear as "Same branch".
- Every mapped node links back into `/network.html?token=<contract>`.
- The topology warns that connection does not imply affiliation and is limited by indexer data.
- Attention Radar opens source pages and never displays a fabricated attention score.

## Builder
- Builder supports $SYNC, USDG and custom eligible tokens in the same selection model.
- Duplicate quote assets are blocked and selection caps at five.
- Every selected asset must pass PAR quote-pricer eligibility before simulation.
- Review displays Fee routing: FEES TO HOLDERS and the total per-trade fee; holder-vault mechanics remain available in technical detail.
- Simulation builds a variable `pairTokens[]` array. Default mode never broadcasts; private an operator-gated live-test mode mode can broadcast only after a successful exact simulation, IPFS metadata preflight and explicit ticker confirmation.

## Other
- `/token/*` renders a direct market-relationship page and links to the topology mapper.
- Labs are non-monetized and do not connect a wallet.
- Marketplace V1 is non-custodial: signed records only, no funds held, no escrow (`tests/server/marketplace.test.mjs` + `tests/regression/rc-marketplace.mjs`).


## Launch clarity patch checks
- Homepage contains a working contract input and in-place topology result using `v2-network.js`.
- Homepage does not auto-map a demo token; Explore still may load the SYNCAT demo when no query is supplied.
- Build UI contains no user-facing “quote asset” or “quote eligibility” language.
- Selection controls disable when five synced assets are selected and re-enable after removal.
- Explore and homepage disclose the up-to-200-launch discovery window and first-degree same-branch limitation.
- Topology nodes expose provenance as VERIFIED PROFILE, SYNCNET PROFILE, or INDEXED FROM CHAIN without implying affiliation.
- Attention section says “CHECK OUTSIDE INTEREST.” and remains source-first.
- No audio or music assets/scripts are present.

## V2 launch candidate regression checks
- Build never calls the absent `viem.getAddress()` export.
- A regex-valid contract is lower-case normalized before `getBytecode`, metadata, and priceability reads.
- The vendored viem module exposes every direct helper still referenced by Builder/Launch Engine (`defineChain`, `createPublicClient`, `http`, `encodeFunctionData`, `decodeFunctionResult`, `formatEther`).
- SYNC DUEL contains both PRACTICE and REAL DUEL modes.
- Every DOM id referenced by `labs-v2.js` exists exactly once in `labs.html`.
- The deterministic SYNC DUEL test surface initializes and returns five rounds.
- Marketplace states the non-custodial model plainly (SyncNet never holds funds; settlement is manual) and never fakes completion.
- Marketplace does not claim a standard PAR token can be launched while trading is disabled.

## Connection-intelligence checks
- Any PAR-priceable Robinhood Chain token can be added through the custom contract input, up to 5 total connections.
- $SYNC and USDG are shortcuts only; neither is required by the builder.
- Connection count is informational, not a progress target.
- USDG convergence copy appears only as contextual explanation; a USDG-only market does not claim cross-market arbitrage.
- $SYNC copy describes network adjacency and does not claim direct NET/USDG rewards to the new project.
- Public beta SyncNet network fee is $0 for every configuration; no buy/swap/burn fee flow is implemented.


## Project Registry checks
- `/registry.html` loads `syncnet-projects.json` and renders recorded-provenance entries.
- SYNCAT displays `SYNCNET ORIGIN · #001`.
- Explore displays the same Registry record separately from auto-detected topology.
- `/token/<SYNCAT>` displays SyncNet provenance and PAR market data independently.
- Simulation results explicitly state that simulations are not added to the public Registry.

### Launch-cleanup checks
- Search accepts a full contract for direct mapping and name/ticker for best-effort discovery from Registry + current PAR window.
- $SYNC selection does not alter the SyncNet beta fee.
- USDG copy describes a direct USDG market and only discusses arbitrage when another project market exists.
- `/project/<contract>` and `/token/<contract>` both resolve to the canonical project context page.
- Origin provenance explicitly predates the V2 live launcher.

## Animated homepage mark

- Homepage hero uses inline SVG; the previous raster image is no longer used in the hero.
- Loop is CSS/SMIL-free SVG + CSS and does not add a JavaScript or media dependency.
- `prefers-reduced-motion: reduce` disables the animated flow and pulse.
- Existing PNG remains available for favicon/metadata/other static uses.


## Search index fix
- Name/ticker search indexes both launched tokens and quote/connection assets observed in PAR markets.
- PAR tokenlist is used when reachable so older PAR-launched assets remain searchable beyond the recent topology window.
- Full contract lookup remains authoritative; name/ticker search is explicitly best-effort until the persistent SyncNet indexer is live.
- Regression case: a quote asset such as CASHCAT must be discoverable by ticker when it appears on the quote side of an indexed market.

## Search metadata hardening
- Search ignores symbols longer than 32 characters and names longer than 96 characters.
- Control characters and pathological whitespace are normalized before matching/rendering.
- Search terms longer than 64 characters are rejected.
- Result rows ellipsize labels instead of allowing untrusted metadata to overflow the layout.
- A malicious keyword-stuffed token label must not appear merely because it contains a common ticker inside an enormous string.


## Private live-canary regression checks
- `build.html` exposes live controls only when the URL has an operator-gated live-test mode.
- A project image can be pinned through the server-side Netlify `ipfs-upload` function; the browser never contains the Pinata JWT.
- Live canary mode requires an `ipfs://` image and confirms it is reachable before enabling launch.
- The live transaction reuses the exact `to`, `data`, `value`, salt and gas-ceiling request returned by the successful simulation; it does not prepare a second launch with a new salt.
- The confirmation field must exactly match the current ticker before the live button enables.
- After mining, the UI verifies token code, name, symbol, logo URI, description, socials, deployer and launch factory on-chain.
- The UI polls PAR’s indexer after confirmation but treats indexer delay separately from on-chain success.
- A local provenance proof is stored only after a successful receipt and metadata verification.
- If a transaction hash exists, any later failure message tells the user to inspect Blockscout before retrying.


## V2.2 end-to-end suite

```
python3 tests/static_audit.py
node tests/e2e/run.mjs          # needs Playwright + Chromium; all network is mocked
SHOTS=/tmp/shots node tests/e2e/run.mjs   # also writes screenshots
```

The mocks live in `tests/e2e/harness.mjs` (PAR API, Robinhood Chain RPC incl. launchToken/getLaunchedToken, IPFS gateways, EIP-1193 wallet, Netlify functions). Results are written to `tests/e2e/last-run.json`.

V2.3 adds suites for rehearsal mode (mocked fork RPC at 127.0.0.1:8545, chain 46630), the Project Kit and the Passport panel. For a real fork rehearsal see `docs/REHEARSAL.md`.
