// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Pre-deployment gate for the Project Home contracts. Pure, so the exact rules are unit-tested.
/// @dev    There is NO default treasury anywhere: the treasury must be supplied explicitly and confirmed twice.
///         Every infrastructure address must equal the reviewed canonical value (verified live on 26 Sep 2026):
///         USDG from the PAR SDK address book and its on-chain name/symbol/decimals; the PAR multi-market router by
///         reproducing its runtime bytecode from pardotfamily/par (commit ab64911); market 1 = the SYNC/USDG PAR v4 pool.
library DeployChecks {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant CANONICAL_SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;
    address internal constant CANONICAL_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant CANONICAL_PAR_MULTI_ROUTER = 0x458D2a59c2F3dd32775a64eE72004561440d64Df;
    uint8 internal constant SYNC_USDG_MARKET = 1;

    error WrongChain(uint256 actual);
    error ChainIdEnvMismatch(uint256 declared);
    error NotCanonicalSync(address supplied);
    error NotCanonicalUsdg(address supplied);
    error NotCanonicalRouter(address supplied);
    error NotCanonicalMarket(uint256 supplied);
    error TreasuryMissing();
    error TreasuryNotConfirmed();
    error TreasuryIsDeployer();
    error TreasuryIsInfrastructure();
    error TreasuryKindUndeclared(uint256 declared);
    error TreasuryHasCode(uint256 codeLength);
    error TreasuryExpectedContract();

    struct Config {
        uint256 actualChainId;
        uint256 declaredChainId;
        address sync;
        address usdg;
        address router;
        uint256 market;
        address treasury;
        address treasuryConfirmation;
        address deployer;
    }

    function check(Config memory c) internal pure {
        if (c.actualChainId != ROBINHOOD_CHAIN_ID) revert WrongChain(c.actualChainId);
        if (c.declaredChainId != ROBINHOOD_CHAIN_ID) revert ChainIdEnvMismatch(c.declaredChainId);
        if (c.sync != CANONICAL_SYNC) revert NotCanonicalSync(c.sync);
        if (c.usdg != CANONICAL_USDG) revert NotCanonicalUsdg(c.usdg);
        if (c.router != CANONICAL_PAR_MULTI_ROUTER) revert NotCanonicalRouter(c.router);
        if (c.market != SYNC_USDG_MARKET) revert NotCanonicalMarket(c.market);
        if (c.treasury == address(0)) revert TreasuryMissing();
        if (c.treasuryConfirmation != c.treasury) revert TreasuryNotConfirmed();
        // Never an implicit founder/deployer wallet: the protocol treasury is a separate, dedicated wallet.
        if (c.treasury == c.deployer) revert TreasuryIsDeployer();
        if (c.treasury == c.sync || c.treasury == c.usdg || c.treasury == c.router) revert TreasuryIsInfrastructure();
    }

    /// @notice Treasury code gate. The operator must DECLARE what the treasury is (no default):
    ///         expectEoa = 1 → a plain externally owned account: it must have NO code (this also refuses an EIP-7702
    ///         delegated account, whose code is 0xef0100…); expectEoa = 0 → a contract wallet (e.g. a multisig): it must
    ///         have code. `codeLength` is `treasury.code.length` read live by the deploy script, so this stays pure.
    function checkTreasuryCode(uint256 expectEoa, uint256 codeLength) internal pure {
        if (expectEoa > 1) revert TreasuryKindUndeclared(expectEoa);
        if (expectEoa == 1 && codeLength != 0) revert TreasuryHasCode(codeLength);
        if (expectEoa == 0 && codeLength == 0) revert TreasuryExpectedContract();
    }
}
