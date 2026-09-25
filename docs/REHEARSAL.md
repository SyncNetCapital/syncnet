# Founder rehearsal on a local fork (before PONSYNC)

Goal: run the **complete** PONSYNC launch — image upload, simulation, metadata preflight, signed intent,
wallet transaction, receipt, on-chain metadata check and PAR factory-record check — against the **real PAR
contracts**, with fake ETH, on a private copy of Robinhood Chain. Nothing reaches the real chain and nothing costs money.

What a fork **cannot** show you: the PAR indexer (`api.par.family`), how par.family displays the token, and real trading.
Those are the only things left for the real launch.

## Safety design (why it cannot turn into a real launch)

- Rehearsal mode only activates with `?live=canary` **and** a loopback RPC (`http://127.0.0.1:<port>` or `http://localhost:<port>`).
- The fork **must use its own chain id** (not 4663). The builder refuses chain 4663 in rehearsal mode. A wallet still
  connected to the real Robinhood Chain reports 4663, so the builder's chain checks block it before simulating, signing or sending.
- A malformed rehearsal URL disables simulation and launching on the page entirely (it never silently falls back to mainnet).
- Rehearsal launch records are stored under their own browser key (`syncnet_rehearsal_<chain>_launch_records_v1`, next to
  the real `syncnet_launch_records_v1`), so they never appear as real launches in the Registry, project pages or duplicate checks,
  and a rehearsal proof is never submitted to the public Registry. The rehearsal builder page lists them in its own launch-records
  panel; `/launches.html` shows real (chain 4663) launches only.

## 1. Start the fork

Install Foundry (https://book.getfoundry.sh), then:

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 46630 --port 8545
```

The public RPC is rate-limited; the fork may be slow the first time it reads PAR's contracts. That is normal.
Robinhood Chain is an Arbitrum Orbit chain; if a call fails on the fork with an unusual error that the real-chain
simulation does not show, note it — it may be a fork limitation rather than a SyncNet bug.

Give your test wallet fake ETH (replace the address):

```bash
cast rpc anvil_setBalance 0xYOUR_WALLET 0x56BC75E2D63100000 --rpc-url http://127.0.0.1:8545
```

## 2. Run SyncNet locally

```bash
npm i -g netlify-cli
cd syncnet
PINATA_JWT=… SYNCNET_CANARY_KEY=… SYNCNET_UPLOAD_KEY=… netlify dev
```

(Uploading to Pinata during the rehearsal pins a real IPFS file. That is fine — the same image gets the same CID later.)

## 3. Point the wallet at the fork

In MetaMask/Rabby add a network: name `SyncNet rehearsal`, RPC `http://127.0.0.1:8545`, chain id `46630`, symbol `ETH`.
Use a **test account**, never the wallet that holds real funds. After restarting Anvil, reset the account's activity
(MetaMask → Settings → Advanced → Clear activity) so nonces match.

## 4. Open the rehearsal builder

```
http://localhost:8888/build.html?live=canary&rpc=http://127.0.0.1:8545&chain=46630
```

An amber **REHEARSAL · LOCAL FORK** banner must be visible. If it is red, fix the URL.

## 5. Run the exact PONSYNC flow

1. Step 01: name, ticker, description, image — exactly as planned for the real launch.
2. Step 02: add PONS **by contract** and $SYNC. Check the symbols the builder reads back.
3. Step 03: choose the creator tax and the fee destination deliberately.
4. Step 04: unlock founder access, connect the rehearsal wallet, RUN LAUNCH SIMULATION.
5. Sign the launch intent, type the ticker, LAUNCH LIVE (on the fork).

## 6. What must be true afterwards

- `LIVE LAUNCH CONFIRMED ✓`, `On-chain metadata: VERIFIED ✓`, `PAR factory record (fee recipient, tax, markets): VERIFIED ✓`.
- `PAR indexer: not returned` is **expected** on a fork.
- Export the proof JSON and check `feeMode`, `creatorFeeRecipient`, `intentRecord.connections`, `recordHash`, `salt`.
- Optional cross-check with Foundry:

```bash
cast call 0x3ea29975a79900179F3e1aEF93347Ba4210c29C1 "getLaunchedToken(address)(address,address,address,uint24,int24,uint16,uint16,uint16,address,uint64,uint8,bool)" <TOKEN> --rpc-url http://127.0.0.1:8545
cast call <TOKEN> "logo()(string)" --rpc-url http://127.0.0.1:8545
```

If any verification step reports a mismatch on the fork, **do not do the real launch** until it is understood —
the same check runs after the real launch.

## 6b. Rehearse the opening buy too (if you plan one)

If PONSYNC will include an opening buy, rehearse it **with the same amount**: step 03 → Opening buy. The transaction then goes to
PAR's router (`0x458D2a59…`) instead of the factory, carrying launch fee + buy. After launch the status must show
`Opening buy: … wallet holds … tokens (…% of supply) ✓`. Check with Foundry:

```bash
cast call <TOKEN> "balanceOf(address)(uint256)" 0xYOUR_WALLET --rpc-url http://127.0.0.1:8545
```

## 7. Then the real launch

Remove `rpc` and `chain` from the URL, switch the wallet back to Robinhood Chain, run a **fresh** simulation, and repeat.
