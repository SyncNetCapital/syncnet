// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Pre-deployment gate for SyncNetProjectHomeSink. Pure, so the exact rules are unit-tested.
/// @dev    There is NO default treasury anywhere: the treasury must be supplied explicitly and confirmed twice.
library DeployChecks {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant CANONICAL_SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;

    error WrongChain(uint256 actual);
    error ChainIdEnvMismatch(uint256 declared);
    error NotCanonicalSync(address supplied);
    error TreasuryMissing();
    error TreasuryNotConfirmed();
    error TreasuryIsDeployer();
    error TreasuryIsToken();

    function check(
        uint256 actualChainId,
        uint256 declaredChainId,
        address sync,
        address treasury,
        address treasuryConfirmation,
        address deployer
    ) internal pure {
        if (actualChainId != ROBINHOOD_CHAIN_ID) revert WrongChain(actualChainId);
        if (declaredChainId != ROBINHOOD_CHAIN_ID) revert ChainIdEnvMismatch(declaredChainId);
        if (sync != CANONICAL_SYNC) revert NotCanonicalSync(sync);
        if (treasury == address(0)) revert TreasuryMissing();
        if (treasuryConfirmation != treasury) revert TreasuryNotConfirmed();
        // Never an implicit founder/deployer wallet: the protocol treasury is a separate, deliberately chosen address.
        if (treasury == deployer) revert TreasuryIsDeployer();
        if (treasury == sync) revert TreasuryIsToken();
    }
}
