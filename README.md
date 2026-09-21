# SyncNet

SyncNet is an application layer built on top of public on-chain infrastructure on Robinhood Chain. It provides project discovery, a creator-facing two-market project builder, live launch-eligibility checks, launch simulation, local project identity/social tooling, market monitoring, and the non-monetized SYNC DUEL experiment.

> **Public beta status:** Network Sync is currently **simulation only**. The public build can connect a wallet, read current PAR state, build the exact launch calldata, simulate the launch and estimate gas, but it does **not** request or broadcast a new launch transaction.

## What this repository contains

This repository contains the SyncNet website and client-side application code. It does **not** claim authorship of PAR's underlying launch contracts, AMM infrastructure, Robinhood Chain, or Uniswap v4. SyncNet integrates with that infrastructure from the application layer.

### Core public addresses

- SYNC: `0x6368e007b9f0b941560ed1f3bceb20247f5eca37`
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- PAR Multi Launch Factory: `0x3ea29975a79900179F3e1aEF93347Ba4210c29C1`
- PAR Quote Pricer: `0x9EfC6EFA4c5F31e2BEC6CC174Ba7bB8f0b57d563`
- SyncNet Holder Vault: `0x4B79B8298cd890A82dC9De1dE5dBb745Cf04353C`
- Robinhood Chain ID: `4663`

## Network Sync simulation flow

The browser verifies the selected quote assets, reads current contract state, constructs the launch parameters and calldata, runs an `eth_call` against the PAR Multi Launch Factory, and estimates the gas that would be required if execution is enabled later. No token is created and the public v1.1.8 build does not call `eth_sendTransaction`.

The wallet connection is used only to identify the current account/network and to simulate the call from the intended account. SyncNet never requests a seed phrase or private key.

The client retains receipt-verification and recovery logic for a transaction that may have been started in an earlier SyncNet build; that recovery path does not request a new transaction.

## Stable Sync

Stable Sync is currently **preview only**. Its proposed platform fee is approximately $20 in SYNC with a 100% burn / 0% treasury design. That burn execution path is not enabled in this public build.

## SYNC DUEL

SYNC DUEL is a local/off-chain skill experiment. It has no wallet connection, stake, payment, prize, token transfer, burn, or redeemable reward. SYNC XP is local, non-transferable, and has no monetary value.

## Local development

The project is a static web application. Serve the repository root with any static HTTP server. For example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Live wallet/network checks require the relevant browser wallet and third-party RPC/indexer access.

## Security and limitations

This public client has not received an independent third-party security audit. See `SECURITY.md`, `risk.html`, and `docs/KNOWN_LIMITATIONS.md`.

## Source status

The source is published for transparency and technical review. No open-source license is granted by this repository unless a license file is added later.
