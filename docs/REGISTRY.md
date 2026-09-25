# SyncNet Project Registry (V2.5 release candidate)

The Registry keeps **market discovery** and **SyncNet provenance** apart. Every status says what was checked, and the check is repeated live in the visitor's browser against Robinhood Chain. A stored label is never trusted. The logic is in `lib/syncnet-provenance.js`.

## Statuses

| Status | Meaning | Evidence checked |
|---|---|---|
| **SYNCNET ORIGIN** | A curated record of a foundational project launched before the V2 live launcher (SYNCAT, `SYNCNET-001`). | Curated. It is not a cryptographic proof, and the page says so. |
| **BUILT WITH SYNCNET · VERIFIED** | A launch prepared and signed with SyncNet. | A `syncnet.launch.proof.v2` (see `REGISTRY_PROOF_SCHEMA.json`), fully verified on-chain: intent → recordHash → salt, the deployer's signature (ECDSA or EIP-1271), the launch tx from the deployer to PAR carrying that salt with the same metadata, fees and markets, the TokenLaunched log, the factory record and the token metadata. |
| **OPERATOR VERIFIED** | The deployer or the current creator-fee recipient signed a SyncNet operator claim for the token. | The signature, checked live. It proves control of that wallet, not project quality. |
| **PAR INDEXED** | A PAR launch with no SyncNet provenance. | The PAR factory record, read on-chain. |
| **PROFILE ONLY** | Curated profile information only. | None asserted. |
| **UNVERIFIED** | Evidence exists but failed its checks, or could not be checked right now. | The failing checks are listed. |

Two more labels are separate from provenance:

- **CANONICAL · BY CONTRACT ADDRESS**: official SyncNet identities such as $SYNC. They are matched by address only, never by ticker.
- **THIS BROWSER ONLY · NOT PUBLIC**: local launch records. They are never counted or styled as public provenance.

## Sources

1. `syncnet-projects.json`: curated entries. An entry that carries a `proof` is shown as BUILT WITH SYNCNET · VERIFIED only while that proof verifies.
2. `GET /api/registry`: submissions verified by the server. They exist only while `SYNCNET_REGISTRY_SUBMISSIONS=true` and Upstash is configured. `POST /api/registry {proof}` runs the same on-chain verification before storing anything. The limits are 10 submissions per hour per IP and 200 per hour in total, with a 64 KB maximum.
3. Browser-local records from MY LAUNCHES, shown in their own section.

## Publishing a launch

See `RECOVERY_GUIDE.md` § "Publish a launch to the public Registry". Simulations and unverified records never enter the Registry.

## Canonical identities and impersonation

- Canonical entries (`registry.canonical: true`) are compared by contract address everywhere: map, search, project page and builder.
- The builder and `/api/launch-guard` refuse to launch a ticker or name whose confusable skeleton matches a canonical identity. For example, `SYNC`, `ＳＹＮＣ` and `SyncΝet` with a Greek Ν all match.
- Tokens that merely share a ticker with a canonical asset are labelled **NOT THE CANONICAL $SYMBOL**, for example "NOT THE CANONICAL $SYNC".
- Unrelated projects that share a non-canonical ticker are allowed, but get a collision warning that must be acknowledged.
