# Architecture

SyncNet is a static browser application. It reads public market and token information from PAR, Robinhood Chain RPC and explorer/indexer services.

In public beta v1.1.7, Network Sync is **simulation only**. The client can connect to a wallet, validate chain/account state, build exact PAR launch calldata, perform an `eth_call` simulation and estimate gas. It does not request or broadcast a new launch transaction.

## Boundaries

**SyncNet-owned application layer:** UI, quote-eligibility checks, launch preparation/simulation, project discovery, local project/profile previews, legacy launch-receipt verification, market monitoring, and SYNC DUEL.

**Third-party infrastructure:** Robinhood Chain, PAR launch contracts and indexer, wallet providers, Blockscout, Uniswap v4 infrastructure and token contracts selected by users.

The public `syncnet-projects.json` file is an optional off-chain profile/provenance registry. A project merely having a SYNC market does not mean it was launched through SyncNet.
