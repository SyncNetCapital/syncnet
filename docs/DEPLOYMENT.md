# Deployment (V2.5 release candidate)

SyncNet is a static site with Netlify Functions. It has no build step, and the functions have no npm dependencies. The ZIP's root is the site root.

**Deploy in a way that also deploys the Functions:**

- **Netlify CLI**, from the unzipped folder: `npx netlify-cli deploy --prod --dir . --functions netlify/functions`
- **Git**: connect a repository with this content. Set the publish directory to `.` and leave the build command empty. `netlify.toml` already names the functions directory.

Netlify's drag-and-drop has historically deployed static files only, without Functions. If you use it anyway, check that `GET /api/config` returns JSON afterwards. Without the Functions, founder unlock, uploads, the duplicate guard and the Registry do not work, and the site degrades to simulation-only.

## 1. Environment variables

Set these in Netlify under Site configuration → Environment variables. **Redeploy after every change**, because functions read them at start-up.

| Variable | Needed for | Value |
|---|---|---|
| `SYNCNET_CANARY_KEY` | Founder unlock (`/build.html?live=canary`) | ≥ 32 random characters, e.g. `openssl rand -base64 48`. With a shorter key, founder access is off (503). |
| `SYNCNET_UPLOAD_KEY` | Signing upload sessions and wallet challenges | ≥ 32 random characters, different from the canary key. The browser never sees it. |
| `PINATA_JWT` | Image pinning | Use a **scoped** Pinata API key with only `pinFileToIPFS`. No admin, unpin or list rights. |
| `SYNCNET_PIN_SECONDARY_URL` + `SYNCNET_PIN_SECONDARY_TOKEN` | Redundant pin (recommended) | An IPFS Pinning Service API endpoint, e.g. a second provider's `https://…/psa`. Every uploaded CID is also pinned there. A failure is logged, and the upload still succeeds. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or `SYNCNET_UPSTASH_URL`/`_TOKEN`) | Durable rate limits, quotas, lockouts, registry | Upstash Redis REST credentials. **Required for every public feature.** Without them, limits are per function instance and public features stay closed. |
| `SYNCNET_SESSION_EPOCH` | Revoking sessions | Any string (default `1`). Changing it revokes every founder/wallet session and challenge at once. |
| `SYNCNET_LOG_SALT` | Log pseudonymisation | Optional random string used to hash IPs and wallets in logs. |
| `SYNCNET_RPC_URL` | Server-side chain reads (registry verification) | Optional private `https` RPC. Defaults to the public Robinhood Chain RPC. |

## 2. Server-side rollout gate (keep closed for the first launch)

| Flag | Opens | Also requires |
|---|---|---|
| `SYNCNET_PUBLIC_LAUNCH=true` | Live-launch controls for every visitor (no operator key) | Upstash |
| `SYNCNET_PUBLIC_UPLOADS=true` | Wallet-signed image uploads for every visitor | `PINATA_JWT`, `SYNCNET_UPLOAD_KEY` (≥ 32), Upstash, kill switch off |
| `SYNCNET_REGISTRY_SUBMISSIONS=true` | `POST /api/registry` (proofs are verified on-chain before they are stored) | Upstash |
| `SYNCNET_UPLOADS_DISABLED=true` | Kill switch: refuses every upload, founder uploads included | — |
| `SYNCNET_MARKETPLACE_DISABLED=true` | Kill switch: closes `/api/marketplace` (reads answer `enabled:false`, writes refuse 503) | — |

The Marketplace itself has no opening flag: it is on exactly when a durable store (Upstash) is configured and the kill switch is off. Without Upstash it fails closed and the page says the Marketplace is not enabled.

A flag is on only when its value is exactly `true` **and** its prerequisites are present. Otherwise it stays off, and the function logs `public-feature-closed` naming what is missing. `GET /api/config` shows the effective state. No URL parameter or browser setting can open a gate.

What the gate controls, and what it cannot:

- A launch is a transaction from the creator's own wallet to PAR. The gate decides whether *SyncNet* shows live controls to the public and whether *SyncNet's services* (uploads, registry submissions) serve the public.
- It cannot stop anyone from calling PAR's contracts directly, and nothing can.
- The client-side founder gate is UI only. Every SyncNet service enforces its own server-side check.

## 3. After each deploy: smoke checks (2 minutes)

1. `GET /api/config` returns `"version":"v2.5-rc"` and the gate values you expect.
2. `/`, `/build.html`, `/network.html`, `/registry.html`, `/launches.html`, `/marketplace.html`, `/labs.html`, `/kit.html` and `/sync.html` load.
3. `/project/<any address>` loads `token.html`. `/tests/…`, `/docs/…`, `/netlify/…` and every `*.md` report return 404.
4. Response headers include the CSP (`script-src 'self'`), `X-Frame-Options: DENY` and `nosniff`.
5. `GET /api/launch-guard?deployer=<your wallet>&symbol=TEST` returns `"indexer":"ok"`. If it returns `unavailable`, PAR's indexer is unreachable from Netlify: the builder still works and asks for an explicit acknowledgement.
6. `/api/par-tokenlist` returns JSON with `content-type: application/json` and a CSP of `default-src 'none'`.

## 4. First live launch

Follow `FIRST_LIVE_LAUNCH_CHECKLIST.md`. Keep every `SYNCNET_PUBLIC_*` flag and `SYNCNET_REGISTRY_SUBMISSIONS` unset.

## 5. Opening to the public later (no code change)

1. Configure Upstash, a scoped `PINATA_JWT` and the secondary pin.
2. Set `SYNCNET_PUBLIC_UPLOADS=true` and redeploy. From two different IPs, check that uploads need a wallet signature and that the 6th upload from one wallet within an hour gets `429`.
3. Set `SYNCNET_REGISTRY_SUBMISSIONS=true` and redeploy. Publish your first launch from MY LAUNCHES. `/registry.html` must show **BUILT WITH SYNCNET · VERIFIED**.
4. Set `SYNCNET_PUBLIC_LAUNCH=true` and redeploy. `/api/config` shows `publicLaunch:true`, and `/build.html` shows the live panel without the operator key.

To close everything again: unset the flags and redeploy, or set `SYNCNET_UPLOADS_DISABLED=true` for uploads only.

## Rotation

- **Operator key:** rotate `SYNCNET_CANARY_KEY` after the first launch and whenever it was shared, and change `SYNCNET_SESSION_EPOCH`.
- **Upload key:** rotating `SYNCNET_UPLOAD_KEY` invalidates all sessions.
- **Pinata:** create a new scoped key, then revoke the old one.
