# v1.1.8 — Simulation-only copy consistency
- Removed the last stale footer sentence that incorrectly described Network Sync wallet execution as enabled.
- Public copy now consistently states that Network Sync is simulation-only and cannot request or broadcast a new launch transaction.

# Changelog

## v1.1.8 — Public beta simulation mode

- Temporarily disabled new Network Sync transaction submission.
- Network Sync still performs live eligibility checks, exact calldata construction, `eth_call` simulation and gas estimation.
- Preserved read-only recovery/verification for transactions started by an earlier build.
- Updated UI, Terms, Risk, Privacy, README and architecture documentation so the public state is explicit and internally consistent.
- Added a static-audit assertion that the public application source does not contain an `eth_sendTransaction` call.

## v1.1.6 — Public repository hardening
- Fixed the `/token/<contract>` route by adding a dedicated token-page shell and responsive styling.
- Corrected the canonical USDG address used by the network explorer.
- Fixed confirmed-launch recovery so a confirmed local record is no longer downgraded to pending on reload.
- Removed the dormant unpublished Identity Engine path from the public build; identity creation is creator-provided in this release.
- Moved the embedded hero logo to a normal static asset.
- Replaced internal release-gate notes with public README, architecture, limitations and security documentation.
- Updated legal/status pages for the public beta without claiming a security audit, regulatory status or guaranteed outcomes.
- Added basic Netlify security headers.

## v1.1.5 — SYNC DUEL PVP
- Reworked Practice into a two-mode SYNC DUEL experience.
- Added free asynchronous player-vs-player challenges using a deterministic shareable URL.
- Added local PVP record and SYNC XP. XP is off-chain, non-transferable, non-redeemable and has no monetary value.
- No wallet, stake, payment, prize, token transfer, burn or blockchain transaction is performed by the duel module.

## v1.1.4 — Automatic live examples
- Network Sync explanatory cards can show a live project example when one is discoverable.
- Registered profile contracts are resolved directly through PAR so known projects are not lost to public-index pagination.
- Improved holder counting and network availability labeling.

## v1.1 — Network directory and market data
- Added live SYNC-connected project discovery from PAR.
- Added project links and ETH-normalized 5-minute charts.
- Added Blockscout-first holder-count sourcing with PAR fallback.
- Added optional static profile overrides through `syncnet-projects.json` without treating market connection as verified provenance.

## v1.0 — Network wallet launch
- Added user-confirmed Network Sync launches with PAR fee reads and holder-vault routing.
- Added simulation, gas estimation, stale-state invalidation, wallet submission, recovery journal, receipt/event verification and two-confirmation success state.
- Bundled viem locally for the transaction path.
