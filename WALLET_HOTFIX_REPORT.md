# Marketplace V1 — wallet-selection hotfix report

**Release:** `v2.5-marketplace-v1-wallet-hotfix` · 24 September 2026
**Baseline:** `syncnet_v2.5_MARKETPLACE_V1.zip` (sha256 `1f20c2fd…`), used as the source of truth.
**Scope:** one wallet-discovery/chooser fix on `/marketplace.html` and one hero-copy line. Nothing else.

## Files changed (deployable)

| File | Change |
|---|---|
| `marketplace-v2.js` | Wallet block only (discovery, chooser, connect, silent reconnect). Every other line is identical. |
| `marketplace.html` | Hero badge text; the wallet-chooser modal markup (`#mpWalletModal`, reusing the existing `.modal/.provider` styles). |
| `netlify.toml`, `_redirects` | One 404 rule each for this report file. |

Non-deployable: `tests/regression/rc-wallet-select.mjs` (new), `tests/run-all.mjs` (wires it in), three hero-copy assertions in `tests/static_audit.py`, `tests/e2e/run.mjs`, `tests/regression/rc-marketplace.mjs`; `CHANGELOG.md`, `MARKETPLACE_DEPLOY_CHECKLIST.md`, this report.

## The wallet-discovery change (exact)

Before: `const p = providers[0] || window.ethereum;` — the first EIP-6963 announcer (Phantom, in the QA browser) was the only wallet ever used.

After, the Builder's proven model (`builder-v2.js`), reused as-is:

- `providerLabel()` — advertised EIP-6963 name first; otherwise flags in the order Brave Wallet → Phantom → Rabby → MetaMask (Brave and Phantom also set `isMetaMask`, so MetaMask is checked last).
- `addProvider()` — deduplicates by provider object **and** by rdns.
- EIP-6963 `announceProvider` listener + `requestProvider` dispatch; legacy fallback (`window.ethereum.providers[]`, else `window.ethereum`) after 450 ms or on the first click, only if nothing was announced.
- **CONNECT WALLET / CHANGE WALLET** → `openWallet()`: 0 providers → the existing "No EVM wallet was found…" note; exactly 1 → connects it directly; 2+ → explicit chooser (buttons named per provider; Cancel/Escape/backdrop close it; focus trapped and returned).
- `connectTo(p)` → `eth_requestAccounts` + `eth_chainId` only. No `personal_sign`, no `eth_signTypedData`, no `eth_sendTransaction`, no approvals/permits, no `wallet_switchEthereumChain` (the marketplace never switches chains; the existing chain note after connection is unchanged).
- **Silent reconnect** after a refresh: `eth_accounts` (never prompts) is asked of every discovered provider; the wallet is restored only when **exactly one** had authorised the page. With several authorised wallets nothing is auto-selected — the user chooses.

## The hero-copy change (exact)

`marketplace.html` hero badge: “NON-CUSTODIAL · SETTLEMENT IS MANUAL · SYNCNET NEVER HOLDS FUNDS” → **“SIGNED LISTINGS · VERIFIED HANDOVERS · NON-CUSTODIAL”**. Headline unchanged. The settlement facts remain, unchanged, in: the three rule cards (“NON-CUSTODIAL. NO ESCROW.” — never holds funds, no escrow, wallet-to-wallet ETH verified on-chain, both-party confirmation), the deal room (“SyncNet V1 does not escrow funds…”, MANUAL / OFF-CHAIN items), the sell form, `terms.html` and `risk.html`.

## Tests run (`node tests/run-all.mjs`, ALL SUITES PASSED)

| Suite | Result |
|---|---|
| Static audit | PASS |
| Core unit | 333/333 |
| Image sanitizer | 129/129 |
| Server infrastructure | 434/434 |
| Server endpoint abuse | 82/82 |
| `/api/ipfs-check` | 100/100 |
| `/api/marketplace` abuse suite | 77/77 |
| Audit PoCs (engine / server / pages) | 0 vulnerabilities reproduced (engine suite's 11 design-fact confirmations unchanged) |
| E2E product suites | 297/297 |
| Required regressions R01–R28 (launch engine) | 206/206 |
| IPFS display | 23/23 |
| Marketplace walkthrough (two browsers, full deal) | 45/45 |
| **Marketplace wallet selection (new)** | **32/32** — Phantom+MetaMask (chooser, either choice, no providers[0] bias, CHANGE WALLET, Escape), MetaMask+Rabby, Brave+MetaMask (EIP-6963 and legacy flags: never mislabelled), duplicate/proxied announcements listed once, legacy `window.ethereum.providers`, one provider (direct connect + direct change), no provider (existing error), two authorised wallets (no auto-selection; `eth_accounts` only), one authorised among two (restored silently, never prompts), no forbidden wallet methods during any chooser action |
| Mobile 320/360/390/430 | 112/112 |

Manual QA (scenario F, Phantom + MetaMask, screenshots taken): chooser shows both → MetaMask connects → CHANGE WALLET reopens the chooser → Phantom connects; the wallet log for the whole scenario is `eth_accounts, eth_requestAccounts, eth_chainId` only; no page errors. One-provider behaviour: direct connect, no chooser.

## Secrets

**No secret values are included in the ZIP** — no `.env`, no key material, no live tokens; environment variables are referenced by name only. Environment-variable requirements are unchanged.
