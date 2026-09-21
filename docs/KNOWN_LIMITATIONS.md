# Known limitations

- Network Sync transaction execution is temporarily disabled in public beta v1.1.8. The build can validate, construct and simulate a launch but cannot request or broadcast a new transaction.
- Receipt-recovery code remains available only to inspect a transaction started in an earlier build; it does not submit a replacement or new launch.
- Stable Sync is preview only; its proposed SYNC burn path is not enabled.
- Local avatar/banner/launch-card uploads are previews and are not automatically persisted on-chain.
- Verified SyncNet provenance requires an explicit registry entry; market connection alone is not provenance.
- Live data depends on third-party RPC, indexer and explorer availability.
- The public client has not received an independent third-party security audit.
- The Social Kit ZIP helper loads pinned JSZip 3.10.1 from jsDelivr with Subresource Integrity only when the user explicitly requests a ZIP download. The locally bundled viem build is used for chain reads and simulations.
