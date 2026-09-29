# EARLY · real-device wallet matrix (Phase 1 exit gate)

Status: **NOT YET RUN on real devices.** Automated coverage exists (Playwright, `tests/e2e/early-ui.mjs`): the full
phone flow at 320/360/390/430 px with an EIP-1193 mock, the two-prompt happy path, resume after reload at each step,
the ambiguous path, and the wallet-app hand-off links. The rows below must be filled in by hand on physical devices
before a closed pilot is enabled. If the in-wallet-browser path fails materially for the target wallets,
WalletConnect/Reown moves into Phase 1 (owner's rule 7).

Pass criterion: at least two wallets pass every cell on both platforms, including both resume points.

Test script (from a link in a YouTube channel description):
`tap link → (no wallet in Safari/Chrome: "Open in <wallet>") → creator page inside the wallet browser → Connect →
add/switch to chain 4663 → amount → Sign what you mean (prompt 1) → Send (prompt 2) → receipt page → CONFIRMED
(≈13 min) → FINALIZED (≈20 min) → Make card → public page`. Resume points: kill the app after prompt 1, reopen the
link (Send must be offered without re-signing); kill after prompt 2, reopen (receipt must resume).

| Wallet | Platform | Universal link opens page in wallet browser | Chain 4663 add/switch | Sign typed v4 (prompt 1) | ERC-20 send (prompt 2) | Resume after kill (1) | Resume after kill (2) | Notes |
|---|---|---|---|---|---|---|---|---|
| MetaMask Mobile | iOS | | | | | | | `https://metamask.app.link/dapp/<host>/<path>` |
| MetaMask Mobile | Android | | | | | | | |
| Coinbase Wallet | iOS | | | | | | | `https://go.cb-w.com/dapp?cb_url=<url>` |
| Coinbase Wallet | Android | | | | | | | |
| Trust Wallet | iOS | | | | | | | `https://link.trustwallet.com/open_url?coin_id=60&url=<url>` |
| Trust Wallet | Android | | | | | | | |
| Rabby Mobile | iOS | | | | | | | no documented universal-link format: test by opening the URL from the in-app browser |
| Rabby Mobile | Android | | | | | | | |
| Phantom (EVM) | iOS/Android | | expected: no custom chains | | | | | excluded from the chooser |

Record the app versions and the date. Attach screenshots of both wallet prompts (they must show: prompt 1 = typed
data, domain "SyncNet SYNC Proof", receiver = creator wallet, exact amount; prompt 2 = token transfer to the creator,
value 0).
