# SyncNet V2.5 — audit PoCs

Copy this folder to `tests/audit/` in the SyncNet project root. Nothing here touches a real network:
the browser suites reuse the project's own mocks (`tests/e2e/harness.mjs`), and the server suite
mocks outbound `fetch`.

```bash
node tests/audit/poc-engine.mjs      # launch-engine-v2.js in a VM: calldata shape, validation gaps   (27 checks)
node tests/audit/poc-server.mjs      # Netlify functions: uploads, site-check, canary-auth, fan-out    (11 checks)
node tests/audit/poc-e2e.mjs         # real pages in headless Chromium: races, provenance, labels      (35 checks)

# independent calldata check (pure-Python keccak + ABI encoder, no JS involved)
node tests/audit/dump-calldata.mjs
cd tests/audit && python3 keccak.py && python3 abi_check.py calldata.json   # expect: ALL IDENTICAL
```

Each check prints `CONFIRMED` when the issue reproduces. After a fix, the matching check should
print `not-reproduced` (for the positive "calldata shape" checks in poc-engine the opposite:
they must stay CONFIRMED).

| Check prefix | Finding in the report |
|---|---|
| F-R1, F-R1/N1 | H1 lost tx hash → duplicate launch |
| F-S2 | H2 public uploads |
| F-P6 | M1 stale intent signature |
| F-R3 | M2 provenance lost on post-send failure |
| F-P7 | M3 false assurances on /project/<any address> |
| F-P3 | M4 fake SYNC listed as "$SYNC connection" |
| F-UX1 | L1 Review stale after account switch |
| F-TX1 | L2 expectedEconomics = 0 |
| F-RH1 | L3 rehearsal parameters misspelled → mainnet |
| F-P1 | L4 VERIFIED TRANSFERABLE for contract recipients |
| F-TX2 | L5 char vs byte limits |
| F-TX3 | L6 fee recipient = system contract / burn address |
| F-C1 | L7 bidi / zero-width characters on-chain |
| F-S1 | L9 canary-auth / upload session |
| F-S4 | L10 site-check |
| F-S5 | L11 par-launches-all fan-out |
| F-S3 | L12 error pass-through |
| F-P4, F-P5 | L13 project page misstates metadata |
