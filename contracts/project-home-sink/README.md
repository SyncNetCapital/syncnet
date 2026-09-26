# SyncNetProjectHomeSink

Isolated Foundry project. Not part of the website runtime and not served (`/contracts/*` → 404).
**Not deployed.** Production deployment is blocked until the real SyncNet protocol treasury is approved.

## What it does

`$SYNC` paid for a Project Home activation (priced at $49 USD, paid in $SYNC — see `lib/syncnet-project-home-pricing.js`)
is transferred to this contract. `settle()` — permissionless, no parameters — settles the sink's **entire** `$SYNC`
balance:

| Share | Destination | How |
|---|---|---|
| `floor(balance × 60 / 100)` | burned | `SYNC.burn(amount)` — `totalSupply` decreases |
| `balance − burn` (40% + every rounding remainder) | immutable `TREASURY` | `SYNC.transfer(TREASURY, amount)` |

Before `settle()`, tokens in the sink are **committed to the Project Home sink** (60% of them **committed to burn**);
they are not burned yet. `totalBurned` only counts amounts that went through `SYNC.burn()`.

Anyone can transfer `$SYNC` to the sink directly. Such **unsolicited** deposits are settled 60/40 like everything else;
the contract never attributes them to Project Home activations (that is the job of the SyncNet activation registry).

## Public ABI

```
constructor(address sync, address treasury)       // both non-zero, treasury != sync; immutable
function settle() external returns (uint256 burned, uint256 toTreasury)
function pending() external view returns (uint256 amount, uint256 toBurn, uint256 toTreasury)
function split(uint256 amount) external pure returns (uint256 toBurn, uint256 toTreasury)
function SYNC() external view returns (address)            // immutable
function TREASURY() external view returns (address)        // immutable
function BURN_PERCENT() external view returns (uint256)    // constant 60
function totalSettled() / totalBurned() / totalTreasury() external view returns (uint256)
event Settled(address indexed caller, uint256 amount, uint256 burned, uint256 toTreasury)
```

No owner, no admin, no proxy, no setter, no rescue, no approval, no arbitrary call, no payable function, no
`receive`/`fallback`, no ETH withdrawal. ETH forced in (e.g. `selfdestruct`) stays irrecoverable by design.

## Tests

```
cd contracts/project-home-sink
forge test                         # 34 tests incl. fuzzing; no external libraries
node ../../tests/project-home/sink-static-audit.mjs   # source + ABI audit (from the repo root works too)
```

Offline sandboxes without a native solc can point forge at any solc 0.8.28 with `--use <path>`.

### Fork rehearsal (local only, never broadcasts)

`fork/SinkFork.t.sol` deploys the sink on an in-memory fork of Robinhood Chain and settles against the **real**
canonical `$SYNC` bytecode. This proves that `SYNC.burn()` called by the sink reduces `totalSupply`, that the treasury
receives the exact remainder, and that no residue is left. The sink's balance is written into the fork's state (the
OpenZeppelin `_balances` slot, confirmed through `balanceOf`), and the test uses a fixture treasury.

```
ROBINHOOD_FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --contracts fork --match-path 'fork/*'
```

The rehearsal passed on 26 Sep 2026. It is not part of `run-all`, because it needs the network.

## Deployment (NOT in this phase)

`script/DeploySyncNetProjectHomeSink.s.sol` refuses to run unless **all** of these are set explicitly:

```
CHAIN_ID=4663
SYNC=0x6368e007b9f0b941560ed1f3bceb20247f5eca37     # must equal the canonical $SYNC
TREASURY=<approved SyncNet protocol treasury>          # no default exists anywhere
TREASURY_CONFIRM=<the same address again>
```

It also refuses a wrong live chain id, a zero treasury, the deployer wallet as treasury, and the token as treasury
(`script/DeployChecks.sol`, unit-tested in `test/DeployChecks.t.sol`), and re-reads the immutables after deployment.
