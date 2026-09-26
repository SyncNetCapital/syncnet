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
///           40% (plus every rounding remainder) transferred to the immutable SyncNet protocol treasury.
///         settle() is permissionless and takes no parameters. There is no owner, no admin, no setter, no rescue,
///         no proxy, no arbitrary call, no approval, no payable function and no ETH withdrawal path.
/// @dev    Tokens held here before settle() are COMMITTED to the sink, not yet burned. Only amounts that went through
///         SYNC.burn() inside settle() are counted in totalBurned. Anyone can transfer $SYNC here directly; such
///         unsolicited deposits are settled 60/40 like everything else — attribution to Project Home activations is
///         an off-chain matter (the SyncNet activation registry), never assumed by this contract.
contract SyncNetProjectHomeSink {
    /// @notice Share of every settlement that is burned, in percent. The remainder goes to the treasury.
    uint256 public constant BURN_PERCENT = 60;

    /// @notice The canonical $SYNC token. Immutable.
    ISyncToken public immutable SYNC;
    /// @notice The SyncNet protocol treasury. Immutable.
    address public immutable TREASURY;

    /// @notice Cumulative $SYNC settled (burned + sent to the treasury).
    uint256 public totalSettled;
    /// @notice Cumulative $SYNC actually burned through SYNC.burn().
    uint256 public totalBurned;
    /// @notice Cumulative $SYNC transferred to the treasury.
    uint256 public totalTreasury;

    event Settled(address indexed caller, uint256 amount, uint256 burned, uint256 toTreasury);

    error ZeroAddress();
    error TreasuryIsToken();
    error TreasuryTransferFailed();

    constructor(address sync, address treasury) {
        if (sync == address(0) || treasury == address(0)) revert ZeroAddress();
        if (treasury == sync) revert TreasuryIsToken();
        SYNC = ISyncToken(sync);
        TREASURY = treasury;
    }

    /// @notice The split settle() would apply to the current balance. View only.
    function pending() external view returns (uint256 amount, uint256 toBurn, uint256 toTreasury) {
        amount = SYNC.balanceOf(address(this));
        (toBurn, toTreasury) = split(amount);
    }

    /// @notice Pure 60/40 split. burn = floor(amount * 60 / 100) computed without overflow; treasury = the rest.
    function split(uint256 amount) public pure returns (uint256 toBurn, uint256 toTreasury) {
        toBurn = (amount / 100) * BURN_PERCENT + ((amount % 100) * BURN_PERCENT) / 100;
        toTreasury = amount - toBurn;
    }

    /// @notice Settles the sink's entire $SYNC balance. Permissionless, parameterless. A zero balance is a no-op.
    function settle() external returns (uint256 burned, uint256 toTreasury) {
        uint256 amount = SYNC.balanceOf(address(this));
        if (amount == 0) return (0, 0);
        (burned, toTreasury) = split(amount);

        totalSettled += amount;
        totalBurned += burned;
        totalTreasury += toTreasury;

        if (burned != 0) SYNC.burn(burned);
        if (toTreasury != 0 && !SYNC.transfer(TREASURY, toTreasury)) revert TreasuryTransferFailed();

        emit Settled(msg.sender, amount, burned, toTreasury);
    }
}
