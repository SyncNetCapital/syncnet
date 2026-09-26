// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Uniswap v4 PoolKey and PAR's Hop, in the exact ABI shape of PairPadMultiRouter (pardotfamily/par, commit ab64911).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct Hop {
    PoolKey key;
    bool v3;
}

/// @dev One PairPadMultiRouter leg: sell `amountIn` of the launch token through launch market `market`.
struct Leg {
    uint8 market;
    Hop[] hops;
    uint256 amountIn;
}

/// @notice The two functions of the canonical PAR multi-market router the converter uses. sellToQuotes looks the
///         pool up from the PAR factory itself (factory.poolKeysFor(token)[market]); a caller cannot name a pool.
interface IPairPadMultiRouter {
    function factory() external view returns (address);
    function sellToQuotes(address token, Leg[] calldata legs, uint256[] calldata minOuts, address recipient) external;
}

interface IPairPadMultiLaunchFactory {
    function poolKeysFor(address token) external view returns (PoolKey[] memory keys);
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @title  SyncNetProjectHomeTreasuryConverter
/// @notice Holds the treasury share of Project Home payments (in SYNC, forwarded by SyncNetProjectHomeSink) and converts
///         it to canonical USDG through ONE fixed route — the PAR SYNC/USDG Uniswap v4 market, via the canonical PAR
///         multi-market router — delivering ALL USDG to the immutable SyncNet protocol treasury wallet.
///
///         Execution authority, not custody authority: only TREASURY may trigger a conversion, choosing how much
///         SYNC, a NON-ZERO minimum USDG out and a deadline. It cannot choose the route, the pool, the tokens or the
///         recipient, and cannot withdraw SYNC. A third party can never force a sale at an arbitrary price.
///
///         No owner, no admin, no setter, no proxy, no rescue, no withdrawal, no arbitrary call, no generic swap, no
///         payable function. SYNC waits here safely until converted; any failure reverts and leaves it here.
/// @dev    Actual USDG received is whatever the pool pays (pool fee, depth, price). It is NOT the SyncNet reference
///         rate and NOT a guaranteed USD amount; the accounting records only real balances.
contract SyncNetProjectHomeTreasuryConverter {
    /// @notice The canonical $SYNC token (input). Immutable.
    IERC20Minimal public immutable SYNC;
    /// @notice Canonical USDG (output). Immutable.
    IERC20Minimal public immutable USDG;
    /// @notice The SyncNet protocol treasury wallet: the ONLY USDG destination and the ONLY conversion executor.
    address public immutable TREASURY;
    /// @notice The canonical PAR multi-market router. Immutable.
    IPairPadMultiRouter public immutable ROUTER;
    /// @notice Index of the SYNC/USDG market among SYNC's PAR markets. Immutable, re-verified on every conversion.
    uint8 public immutable MARKET;

    /// @notice Cumulative SYNC actually sold (measured from this contract's balance).
    uint256 public totalSyncConverted;
    /// @notice Cumulative USDG actually produced by conversions (measured from this contract's balance).
    uint256 public totalUsdgFromConversions;
    /// @notice Cumulative USDG transferred to TREASURY (conversion output plus any USDG sent here directly).
    uint256 public totalUsdgDelivered;

    uint256 private _entered;

    event Converted(address indexed executor, uint256 syncRequested, uint256 syncSold, uint256 usdgOut, uint256 usdgDelivered);

    error ZeroAddress();
    error InvalidConfiguration();
    error RouteMismatch();
    error NotTreasury();
    error ZeroAmount();
    error InsufficientSync();
    error ZeroMinOut();
    error DeadlineExpired();
    error SlippageExceeded(uint256 usdgOut, uint256 minUsdgOut);
    error ApproveFailed();
    error UsdgTransferFailed();
    error Reentrancy();

    constructor(address sync, address usdg, address treasury, address router, uint8 market) {
        if (sync == address(0) || usdg == address(0) || treasury == address(0) || router == address(0)) revert ZeroAddress();
        if (sync == usdg || treasury == sync || treasury == usdg || treasury == router || router == sync || router == usdg) {
            revert InvalidConfiguration();
        }
        SYNC = IERC20Minimal(sync);
        USDG = IERC20Minimal(usdg);
        TREASURY = treasury;
        ROUTER = IPairPadMultiRouter(router);
        MARKET = market;
        _checkRoute(); // a misconfigured market/router/token set cannot even be deployed
    }

    /// @notice SYNC awaiting conversion (treasury allocations plus any SYNC sent here directly).
    function pendingSync() external view returns (uint256) {
        return SYNC.balanceOf(address(this));
    }

    /// @notice Converts `syncAmount` SYNC to USDG through the fixed PAR SYNC/USDG market and delivers ALL USDG held
    ///         here to TREASURY. Only TREASURY may call. Reverts — leaving every token where it was — if the deadline
    ///         passed, the output is below `minUsdgOut`, the route changed, or anything in the swap fails.
    /// @param syncAmount  SYNC to sell now (<= pendingSync). Partial conversions allow gradual execution.
    /// @param minUsdgOut  Minimum USDG (6 decimals) this conversion must produce. Must be non-zero.
    /// @param deadline    Latest block timestamp at which the conversion may execute.
    function convert(uint256 syncAmount, uint256 minUsdgOut, uint256 deadline)
        external
        returns (uint256 syncSold, uint256 usdgOut, uint256 delivered)
    {
        if (_entered != 0) revert Reentrancy();
        _entered = 1;
        if (msg.sender != TREASURY) revert NotTreasury();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (syncAmount == 0) revert ZeroAmount();
        if (minUsdgOut == 0) revert ZeroMinOut();
        uint256 syncBefore = SYNC.balanceOf(address(this));
        if (syncAmount > syncBefore) revert InsufficientSync();
        _checkRoute();

        uint256 usdgBefore = USDG.balanceOf(address(this));
        if (!SYNC.approve(address(ROUTER), syncAmount)) revert ApproveFailed();

        Leg[] memory legs = new Leg[](1);
        legs[0] = Leg({market: MARKET, hops: new Hop[](0), amountIn: syncAmount});
        uint256[] memory minOuts = new uint256[](1);
        minOuts[0] = minUsdgOut;
        ROUTER.sellToQuotes(address(SYNC), legs, minOuts, address(this));

        if (!SYNC.approve(address(ROUTER), 0)) revert ApproveFailed(); // an unfilled remainder leaves no allowance behind
        syncSold = syncBefore - SYNC.balanceOf(address(this));
        usdgOut = USDG.balanceOf(address(this)) - usdgBefore;
        if (usdgOut < minUsdgOut) revert SlippageExceeded(usdgOut, minUsdgOut);

        delivered = USDG.balanceOf(address(this));
        totalSyncConverted += syncSold;
        totalUsdgFromConversions += usdgOut;
        totalUsdgDelivered += delivered;
        if (!USDG.transfer(TREASURY, delivered)) revert UsdgTransferFailed();

        emit Converted(msg.sender, syncAmount, syncSold, usdgOut, delivered);
        _entered = 0;
    }

    /// @dev The route must still be the PAR market pairing exactly SYNC and USDG in a hook-less v4 pool, as read from
    ///      the factory the router itself uses.
    function _checkRoute() private view {
        PoolKey[] memory keys = IPairPadMultiLaunchFactory(ROUTER.factory()).poolKeysFor(address(SYNC));
        if (MARKET >= keys.length) revert RouteMismatch();
        PoolKey memory k = keys[MARKET];
        bool pairOk = (k.currency0 == address(SYNC) && k.currency1 == address(USDG))
            || (k.currency0 == address(USDG) && k.currency1 == address(SYNC));
        if (!pairOk || k.hooks != address(0)) revert RouteMismatch();
    }
}
