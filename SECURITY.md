# Security

SyncNet is experimental software and has not had an independent third-party security audit. The V2.5 release candidate closes every finding of the internal adversarial audit of 23 Sep 2026 (`AUDIT_FINDINGS_CLOSED.md`). PAR's contracts are not audited either, according to PAR's docs.

## Reporting

Please report suspected vulnerabilities privately to the project team before public disclosure. Until a dedicated security mailbox is published, contact `@sync_on_par` on X and ask for a private reporting channel. Do not include private keys, seed phrases, API keys or other secrets in a public issue.

## Wallet safety

- SyncNet never needs your seed phrase or private key.
- SyncNet asks the wallet for exactly two things:
  - A gas-free **signature** over the launch intent (EIP-712 `LaunchIntent`, or `personal_sign` as a fallback).
  - One **launch transaction** to the PAR multi factory `0x3ea29975a79900179F3e1aEF93347Ba4210c29C1` or the PAR multi router `0x458D2a59c2F3dd32775a64eE72004561440d64Df`.
- SyncNet never asks for token approvals or permits. Reject anything else.
- Compare the wallet popup with the final review before confirming: network, destination, value.
- Do not start a second launch while a previous one is unresolved. MY LAUNCHES and RE-VERIFY settle it from the chain.
- A successful simulation is not a guarantee of successful execution.

## Server-side controls (summary)

- **Rollout gate.** Public live controls, public uploads and registry submissions are off unless the corresponding environment flag is exactly `true` and a durable store (Upstash) is configured. See `docs/DEPLOYMENT.md`.
- **Secrets.** `SYNCNET_CANARY_KEY` and `SYNCNET_UPLOAD_KEY` must be ≥ 32 characters, otherwise the related features are refused. They are compared in constant time and never sent to the browser.
- **Sessions.** Sessions are scoped and short (founder 2 h, wallet 30 min). Changing `SYNCNET_SESSION_EPOCH` revokes all of them.
- **Uploads.**
  - Session-bound only. Images are decoded and re-encoded server-side, with metadata stripped and size and pixel limits applied.
  - Limits: per wallet, per IP, global and per founder.
  - `SYNCNET_UPLOADS_DISABLED=true` is the kill switch.
  - The Pinata key should be scoped to `pinFileToIPFS`.
- **Rate limits and lockouts** on founder unlock, uploads, launch guard, site check, registry and PAR data functions.
- **Responses.** Errors are generic JSON with `nosniff` and a CSP of `default-src 'none'`. Details are logged server-side with hashed identifiers.
- **SSRF.** DNS is resolved once, the connection is pinned to the validated IP, full IPv4/IPv6 blocklists apply, bodies are streamed with a size cap, and redirects are refused.

## Key rotation

Rotate `SYNCNET_CANARY_KEY` after the first live launch and whenever it has been shared, and change `SYNCNET_SESSION_EPOCH` at the same time. Replace the Pinata key if it was ever exposed. See `RECOVERY_GUIDE.md` for incident actions.
