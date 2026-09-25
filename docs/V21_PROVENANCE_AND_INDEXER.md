> Historical V2.1 design note. The V2.5 release candidate implements signed launch provenance (`syncnet.launch.proof.v2`), live-verified Registry statuses and MY LAUNCHES recovery: see `REGISTRY.md`, `REGISTRY_PROOF_SCHEMA.json` and `ARCHITECTURE.md`. The persistent historical indexer below is still future work.

# V2.1 — Provenance + historical graph indexer

The static V2 build intentionally does **not** claim exhaustive topology or cryptographic launch provenance.

## Next backend layer
1. Ingest PAR launches/markets continuously rather than scanning only the most recent client-side window.
2. Store normalized tokens, launches, markets and graph edges in a persistent database.
3. Add project records separately from market edges.
4. On a future live SyncNet launch, record the confirmed token address + launch tx hash + selected connections + SyncNet release.
5. Ask the launching wallet to sign a provenance statement binding operator, token, tx hash and project metadata.
6. Expose read-only APIs for name/ticker search, historical topology and canonical project pages.

## Trust model
- **INDEXED FROM CHAIN**: observable market data only.
- **BUILT WITH SYNCNET**: launch provenance recorded after confirmed live execution and operator proof.
- **OPERATOR VERIFIED** (future): current project operator control verified separately.
- **SYNCNET ORIGIN**: foundational/backfilled provenance; never presented as a V2 live-launch proof.

A future on-chain registry may anchor immutable proof hashes, but editable metadata and operator recovery should remain in a hybrid layer rather than forcing all project identity into an NFT.
