// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The two functions of the canonical $SYNC token (plain ERC-20 + ERC20Burnable, 18 decimals, no transfer
///         tax, not upgradeable) that the sink uses, plus balanceOf.
interface ISyncToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function burn(uint256 amount) external;
}

/// @title  SyncNetProjectHomeSink
/// @notice Receives $SYNC paid for SyncNet Project Home activations and settles EVERYTHING it holds, permanently:
///           60% burned with SYNC.burn() (totalSupply decreases),
///           40% (plus every rounding remainder) forwarded AS SYNC to the immutable treasury converter, which later
///           converts it to USDG for the SyncNet protocol treasury.
///         settle() is permissionless and takes no parameters. There is no owner, no admin, no setter, no rescue,
///         no proxy, no arbitrary call, no approval, no payable function, no ETH withdrawal path — and no DEX, price
///         or slippage logic: the sink knows only SYNC and its converter.
/// @dev    Tokens held here before settle() are COMMITTED to the sink, not yet burned. Only amounts that went through
///         SYNC.burn() inside settle() are counted in totalBurnedSync. Anyone can transfer $SYNC here directly; such
///         unsolicited deposits are settled 60/40 like everything else — attribution to Project Home activations is
///         an off-chain matter (the SyncNet activation registry), never assumed by this contract.
contract SyncNetProjectHomeSink {
    /// @notice Share of every settlement that is burned, in percent. The remainder goes to the treasury converter.
    uint256 public constant BURN_PERCENT = 60;

    /// @notice The canonical $SYNC token. Immutable.
    ISyncToken public immutable SYNC;
    /// @notice The SyncNet Project Home treasury converter (receives the treasury share in SYNC). Immutable.
    address public immutable TREASURY_CONVERTER;

    /// @notice Cumulative $SYNC settled (burned + forwarded to the converter).
    uint256 public totalSettledSync;
    /// @notice Cumulative $SYNC actually burned through SYNC.burn().
    uint256 public totalBurnedSync;
    /// @notice Cumulative $SYNC forwarded to the treasury converter (NOT yet USDG, NOT yet in the treasury wallet).
    uint256 public totalTreasurySyncForwarded;

    event Settled(address indexed caller, uint256 amount, uint256 burned, uint256 forwardedToConverter);

    error ZeroAddress();
    error ConverterIsToken();
    error ConverterTransferFailed();

    constructor(address sync, address treasuryConverter) {
        if (sync == address(0) || treasuryConverter == address(0)) revert ZeroAddress();
        if (treasuryConverter == sync) revert ConverterIsToken();
        SYNC = ISyncToken(sync);
        TREASURY_CONVERTER = treasuryConverter;
    }

    /// @notice The split settle() would apply to the current balance. View only.
    function pending() external view returns (uint256 amount, uint256 toBurn, uint256 toConverter) {
        amount = SYNC.balanceOf(address(this));
        (toBurn, toConverter) = split(amount);
    }

    /// @notice Pure 60/40 split. burn = floor(amount * 60 / 100) computed without overflow; converter = the rest.
    function split(uint256 amount) public pure returns (uint256 toBurn, uint256 toConverter) {
        toBurn = (amount / 100) * BURN_PERCENT + ((amount % 100) * BURN_PERCENT) / 100;
        toConverter = amount - toBurn;
    }

    /// @notice Settles the sink's entire $SYNC balance. Permissionless, parameterless. A zero balance is a no-op.
    function settle() external returns (uint256 burned, uint256 forwarded) {
        uint256 amount = SYNC.balanceOf(address(this));
        if (amount == 0) return (0, 0);
        (burned, forwarded) = split(amount);

        totalSettledSync += amount;
        totalBurnedSync += burned;
        totalTreasurySyncForwarded += forwarded;

        if (burned != 0) SYNC.burn(burned);
        if (forwarded != 0 && !SYNC.transfer(TREASURY_CONVERTER, forwarded)) revert ConverterTransferFailed();

        emit Settled(msg.sender, amount, burned, forwarded);
    }
}
