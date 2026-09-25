# First live launch: checklist

Build `v2.5-rc`. Open this file right before you launch. Nothing below sends a transaction until step 7.

## 0. Before you open the builder (once per deploy)

- [ ] Deploy with the Netlify CLI or Git, so the Functions are deployed too (`docs/DEPLOYMENT.md`).
- [ ] Netlify env vars:
  - `SYNCNET_CANARY_KEY`: ≥ 32 random characters.
  - `SYNCNET_UPLOAD_KEY`: ≥ 32 random characters, different from the canary key.
  - `PINATA_JWT`: a key scoped to `pinFileToIPFS` only.
- [ ] `SYNCNET_PUBLIC_LAUNCH`, `SYNCNET_PUBLIC_UPLOADS` and `SYNCNET_REGISTRY_SUBMISSIONS` are **unset**.
- [ ] `https://<site>/api/config` shows `"version":"v2.5-rc"` and `publicLaunch`, `publicUploads` and `registrySubmissions` all `false`.
- [ ] `https://<site>/FINAL_RELEASE_REPORT.md` returns 404, and the response headers include the CSP (`script-src 'self'`). See `docs/DEPLOYMENT.md` §3.
- [ ] `https://<site>/api/launch-guard?deployer=<your wallet>&symbol=<TICKER>` returns `"indexer":"ok"`. If it says `unavailable`, look up the ticker on par.family yourself before launching.
- [ ] Use one browser and one tab. Use a desktop browser with your wallet extension, or your wallet's in-app browser on a phone.

## 1. What to verify

- [ ] Open `https://<site>/build.html?live=canary`.
- [ ] In step 04, enter the operator key and press UNLOCK. The FOUNDER LIVE LAUNCH panel appears.
- [ ] Step 01:
  - Name, ticker and description show no byte-counter error.
  - Upload the image. The logo becomes `ipfs://…`.
  - X and website are `https://` or empty.
- [ ] Step 02: choose markets by **contract address**, not by ticker.
  - $SYNC is `0x6368e007b9f0b941560ed1f3bceb20247f5eca37`.
  - USDG is `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`.
- [ ] Step 03: choose the fee destination, creator tax and opening buy (0 = none) on purpose.

## 2. Wallet and network you must see

- [ ] The top banner reads **MAINNET · REAL FUNDS**, followed by "Robinhood Chain (4663) · RPC confirmed · wallet on 4663 ✓".
- [ ] The wallet is on Robinhood Chain, chain id 4663 (`0x1237`).
- [ ] The connected account is the wallet that should be the **deployer** of this token. It cannot be changed later.
- [ ] The balance covers: PAR launch fee (0.0005 ETH today, read live) + opening buy + gas.

## 3. Values to check (simulation output)

- [ ] Predicted token address is shown.
- [ ] Markets: `TICKER / QUOTE` with the exact quote addresses you chose.
- [ ] Creator tax, PAR base fee and protocol share: today PAR's values are 1% base fee and 50% protocol share, max tax 10%. SyncNet reads them live, so if they differ, **stop and find out why**.
- [ ] Creator-fee destination and recipient address are what you intend. In creator mode, this is your wallet unless you typed another address.
- [ ] Sent from wallet = launch fee + opening buy exactly.

## 4. Simulation result required

- [ ] `SIMULATION PASSED ✓` and `Metadata preflight: PASS ✓`.
- [ ] **PAR LIVE PREFLIGHT · read from the chain now** shows ✓ on every line: 15 lines, or 16 with a holders, burn or floor destination.
  - Lines include chain id, factory code, quote pricer, WETH, `launchForwarder`, router links, launch config 0, fee, base fee, protocol share, max tax, `canLaunch` for your wallet, and the vault link.
  - A ✕ blocks the launch by itself.
  - Treat a `!` as a stop too, and find out why.
- [ ] Duplicate check shows `PASS ✓`. If it says `WARNINGS`, read each line. Launch only if you understand them. `BLOCKED` or `EXISTS` means stop.

## 5. What to sign

- [ ] Press SIGN LAUNCH INTENT. The wallet must show a **signature request with no transaction and no gas**:
  - EIP-712 domain: `SyncNet Launch Provenance` v1, chain 4663.
  - `LaunchIntent { operator = your wallet, token = the predicted address, recordHash, salt }`.
  - On wallets without EIP-712, a text starting with the same fields.
- [ ] If the wallet shows a transaction, an **approval**, a `permit` or another chain, **reject**. SyncNet never asks for token approvals.

## 6. The final review must match

- [ ] Check FINAL REVIEW · IMMUTABLE:
  - Network is MAINNET · REAL FUNDS.
  - Wallet, predicted token, name, ticker, description, logo, markets, recipient and tax are exactly right.
  - Signed intent reads `SIGNED ✓ … (verified for this exact launch)`.
  - PAR live preflight shows `N/N checks passed`.
  - Duplicate check reads `no duplicate found`.
- [ ] Note the **Total value sent from your wallet** in wei, and the **Transaction** target:
  - With no opening buy, the target is PAR multi-market factory `0x3ea29975a79900179F3e1aEF93347Ba4210c29C1`.
  - With an opening buy, the target is PAR multi-market router `0x458D2a59c2F3dd32775a64eE72004561440d64Df`.

## 7. When it is safe to press LAUNCH LIVE

Press only when every one of these is true:

- [ ] "I UNDERSTAND THIS LAUNCH IS REAL AND IRREVERSIBLE." is ticked.
- [ ] The exact ticker is typed.
- [ ] The line under the button reads **"All checks complete. LAUNCH LIVE sends exactly the transaction in the final review."**
- [ ] In the wallet popup, before confirming, check:
  - Network: Robinhood Chain.
  - **To** is the target from step 6.
  - **Value** is the value from step 6.
  - It is a normal contract call, not an approval.
- [ ] If anything differs, reject in the wallet. That is safe: the attempt stays recorded and nothing was sent.
- [ ] After confirming, do not switch account or network, and do not close the tab until you see a transaction hash.

## 8. Record right after submission

- [ ] Transaction hash (shown in the status box, with an explorer link).
- [ ] Predicted token address and Intent recordHash.
- [ ] Screenshot the final review and the status box.
- [ ] Once confirmed, export and keep these files. Browser data is not a backup.
  - **EXPORT LAUNCH EVIDENCE (JSON)**, under the status box.
  - In MY LAUNCHES: **EXPORT PROOF** on the launch card, and **EXPORT ALL RECORDS**.

## 9. If the provider or wallet errors

- [ ] **Do not press LAUNCH again and do not start a new launch.** SyncNet treats the launch as SENT until the chain proves otherwise, and it blocks a second $TICKER from this wallet.
- [ ] Check your wallet's activity for a sent or pending transaction.
- [ ] Open `/launches.html` (MY LAUNCHES) and press RE-VERIFY on the card. Or paste the tx hash or the predicted token into RECOVER A LAUNCH and press FIND.
- [ ] Use MARK AS NOT SENT only when your wallet shows no sent or pending transaction and SyncNet finds no token at the predicted address. SyncNet re-checks the chain before accepting it.
- [ ] More cases: `RECOVERY_GUIDE.md`.

## 10. Verify afterwards

- [ ] The status reads `LIVE LAUNCH CONFIRMED ✓`, with state `ONCHAIN_VERIFIED` or `FULLY_VERIFIED` and "On-chain factory record + markets + metadata: VERIFIED ✓".
- [ ] If the state is `INDEXER_PENDING`, that is fine: the on-chain check is authoritative. RE-VERIFY later upgrades it.
- [ ] `/project/<token>` shows the PAR launch facts. The explorer tx is from your wallet to the target above. The PAR token page lists the markets.
- [ ] If you launched with an opening buy, the status shows your token balance ≥ the minimum.
- [ ] To publish provenance, add the exported proof to `syncnet-projects.json` (`RECOVERY_GUIDE.md` § Publish) and redeploy. `/registry.html` must then show **BUILT WITH SYNCNET · VERIFIED** with the check lines ticked.

### Optional: independent read-only checks (Foundry `cast`)

```bash
RPC=https://rpc.mainnet.chain.robinhood.com; F=0x3ea29975a79900179F3e1aEF93347Ba4210c29C1; ME=<your wallet>
cast chain-id --rpc-url $RPC                                              # 4663
cast call $F "launchForwarder()(address)" --rpc-url $RPC                  # 0x458D2a59c2F3dd32775a64eE72004561440d64Df
cast call $F "launchFee()(uint256)" --rpc-url $RPC                        # 500000000000000 today
cast call $F "baseFeeBps()(uint256)" --rpc-url $RPC                       # 100 today
cast call $F "protocolFeeShareBps()(uint256)" --rpc-url $RPC              # 5000 today
cast call $F "maxCreatorTaxBps()(uint256)" --rpc-url $RPC                 # 1000 today
cast call $F "canLaunch(address)(bool)" $ME --rpc-url $RPC                # true
cast call $F "getLaunchedToken(address)(address,address,address,uint24,int24,uint16,uint16,uint16,address,uint64,uint8,bool)" <token> --rpc-url $RPC   # after launch: deployer = ME, exists = true
# If you pair with $SYNC: its PAR record must show the SyncNet deployer wallet (one of these two returns exists = true)
cast call $F "getLaunchedToken(address)(address,address,address,uint24,int24,uint16,uint16,uint16,address,uint64,uint8,bool)" 0x6368e007b9f0b941560ed1f3bceb20247f5eca37 --rpc-url $RPC
cast call 0x9d33Ba78389c8772bC114Cba47Dc1985E933e76F "getLaunchedToken(address)(address,address,address,address,uint256,uint24,int24,int24,int24,uint128,uint256,uint16,uint16,uint16,address,uint64,bool)" 0x6368e007b9f0b941560ed1f3bceb20247f5eca37 --rpc-url $RPC
```
