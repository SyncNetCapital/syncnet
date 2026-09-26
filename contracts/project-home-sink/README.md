# SyncNet Project Home contracts

Isolated Foundry project. Not part of the website runtime and not served (`/contracts/*` → 404).
**Not deployed.** Deployment is blocked until the dedicated SyncNet protocol treasury wallet address is supplied.

| Contract | Role |
|---|---|
| `SyncNetProjectHomeSink` | Receives Project Home payments in `$SYNC`. `settle()` burns floor(60%) and forwards the rest **as SYNC** to the converter. It has no DEX, price or slippage logic |
| `SyncNetProjectHomeTreasuryConverter` | Holds the treasury share in SYNC and converts it to canonical **USDG** through one fixed PAR route. **All USDG goes to the immutable treasury wallet** |

The full economics and lifecycle are in `docs/PROJECT_HOME.md` §4. Project Home activation is priced at $39 USD and paid
in $SYNC (`lib/syncnet-project-home-pricing.js`), and it **never** depends on settlement or conversion.

## Sink

```
constructor(address sync, address treasuryConverter)     // both non-zero, converter != token; immutable
function settle() external returns (uint256 burned, uint256 forwarded)   // permissionless, no parameters
function pending() external view returns (uint256 amount, uint256 toBurn, uint256 toConverter)
function split(uint256 amount) external pure returns (uint256 toBurn, uint256 toConverter)
function SYNC() / TREASURY_CONVERTER() external view returns (address)
function BURN_PERCENT() external view returns (uint256)  // constant 60
function totalSettledSync() / totalBurnedSync() / totalTreasurySyncForwarded() external view returns (uint256)
event Settled(address indexed caller, uint256 amount, uint256 burned, uint256 forwardedToConverter)
```

Before `settle()`, tokens are **committed to the Project Home sink**, and 60% of them are **committed to burn**.
`totalBurnedSync` counts only executed `SYNC.burn()`. Unsolicited SYNC is settled 60/40 like everything else.

## Treasury converter

```
constructor(address sync, address usdg, address treasury, address router, uint8 market)
    // all non-zero, no aliased roles, all immutable; reverts unless the live PAR factory's
    // poolKeysFor(sync)[market] is the hook-less SYNC/USDG pool
function convert(uint256 syncAmount, uint256 minUsdgOut, uint256 deadline)
    external returns (uint256 syncSold, uint256 usdgOut, uint256 delivered)
    // ONLY the treasury wallet; minUsdgOut > 0; deadline enforced; route re-verified;
    // PairPadMultiRouter.sellToQuotes(SYNC, [{market, hops: [], syncAmount}], [minUsdgOut], address(this));
    // allowance reset to 0; floor re-checked on the measured USDG; ALL USDG held -> treasury
function pendingSync() external view returns (uint256)
function SYNC() / USDG() / TREASURY() / ROUTER() external view returns (address)
function MARKET() external view returns (uint8)
function totalSyncConverted() / totalUsdgFromConversions() / totalUsdgDelivered() external view returns (uint256)
event Converted(address indexed executor, uint256 syncRequested, uint256 syncSold, uint256 usdgOut, uint256 usdgDelivered)
```

Neither contract has an owner, admin, setter, rescue, sweep, withdrawal, proxy, arbitrary call, recipient parameter,
generic swap, receive, fallback or payable function. The treasury wallet is the converter's only executor. That gives
it execution timing and slippage authority, never custody over the destination.

## Canonical route (verified 26 Sep 2026, read-only)

| | Address | How it was verified |
|---|---|---|
| SYNC | `0x6368e007B9F0B941560eD1f3bceb20247F5Eca37` | Canonical; live PAR multi-market launch with 2 markets |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | PAR SDK address book and this repo; on-chain "Global Dollar" / USDG / 6 decimals; SYNC's market 1 |
| PAR multi router | `0x458D2a59c2F3dd32775a64eE72004561440d64Df` | Live bytecode = `pardotfamily/par@ab64911` `PairPadMultiRouter` compiled with solc 0.8.26 via-IR (immutables and metadata aside) |
| Pool | market 1: `(USDG, SYNC, fee 20000, tickSpacing 10, hooks 0)` in PoolManager `0x8366a39C…0951` | `multiFactory.poolKeysFor(SYNC)`; the PAR-created SYNC/USDG Uniswap v4 pool, direct |

## Tests

```
cd contracts/project-home-sink
forge test                          # 70 tests: sink (28), converter (31), deploy gate (11), incl. fuzzing
node ../../tests/project-home/sink-static-audit.mjs   # source + ABI audit of both contracts (113 checks)
```

Offline sandboxes without a native solc can point forge at any solc 0.8.28 with `--use <path>`.

### Fork rehearsals (local only, never broadcast)

```
ROBINHOOD_FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --contracts fork --match-path 'fork/*' -vv
```

- `fork/SinkFork.t.sol` runs the full lifecycle on real bytecode and state:
  1. deploy the converter (its constructor verifies the live route), then the sink;
  2. `settle()` burns exact floor(60%) through the real `SYNC.burn()` and totalSupply drops by that amount;
  3. the converter receives the exact remainder;
  4. a stranger's conversion reverts;
  5. the conversion is quoted by simulation;
  6. a floor one unit above the quote reverts and the SYNC stays;
  7. the real conversion with a 1% floor sends the USDG to the treasury fixture, and nothing remains in the converter.

  The sink's SYNC balance is written into the fork's state (the OpenZeppelin `_balances` slot, confirmed through
  `balanceOf`).
- `fork/ConversionImpactFork.t.sol` is informational: it shows the USDG output for 1k to 1M SYNC from the same
  pre-trade state.

Both passed on 26 Sep 2026. They are not part of `run-all`, because they need the network.

## Deployment (NOT in this phase)

`script/DeployProjectHome.s.sol` deploys the **converter first**, then the **sink pointing at it**. It refuses to run
unless **all** of these are set explicitly:

```
CHAIN_ID=4663
SYNC=0x6368e007b9f0b941560ed1f3bceb20247f5eca37
USDG=0x5fc5360d0400a0fd4f2af552add042d716f1d168
PAR_MULTI_ROUTER=0x458d2a59c2f3dd32775a64ee72004561440d64df
SYNC_USDG_MARKET=1
TREASURY=<dedicated SyncNet protocol treasury wallet>     # no default exists anywhere
TREASURY_CONFIRM=<the same address again>
```

It also refuses a wrong live chain, a non-canonical SYNC, USDG, router or market, a zero or unconfirmed treasury, the
deployer as treasury, and any infrastructure address as treasury (`script/DeployChecks.sol`, unit-tested). After
deploying it re-reads every immutable and the sink → converter wiring.
