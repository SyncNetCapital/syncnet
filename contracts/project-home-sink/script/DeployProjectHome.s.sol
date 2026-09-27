// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";
import {SyncNetProjectHomeTreasuryConverter} from "../src/SyncNetProjectHomeTreasuryConverter.sol";
import {DeployChecks} from "./DeployChecks.sol";

interface VmScript {
    function envUint(string calldata) external view returns (uint256);
    function envAddress(string calldata) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys, IN THIS ORDER, (1) SyncNetProjectHomeTreasuryConverter and (2) SyncNetProjectHomeSink pointing at
///         it. NOT RUN in this phase — deployment is blocked until the dedicated SyncNet protocol treasury wallet is
///         supplied. Every variable is required; a missing one reverts (no defaults anywhere):
///           CHAIN_ID=4663
///           SYNC=0x6368e007b9f0b941560ed1f3bceb20247f5eca37
///           USDG=0x5fc5360d0400a0fd4f2af552add042d716f1d168
///           PAR_MULTI_ROUTER=0x458d2a59c2f3dd32775a64ee72004561440d64df
///           SYNC_USDG_MARKET=1
///           TREASURY=<dedicated SyncNet protocol treasury wallet>
///           TREASURY_CONFIRM=<the same address again>
///           TREASURY_EXPECT_EOA=1 (plain wallet: must have no code) or 0 (contract wallet: must have code)
///         Deployment stays blocked until the owner explicitly authorises it. The treasury is supplied at deploy time
///         only; it is never hard-coded here or in application logic.
///         The converter constructor additionally re-reads the live PAR factory: market 1 must be the hook-less
///         SYNC/USDG pool, or deployment reverts.
contract DeployProjectHome {
    VmScript internal constant vm = VmScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (SyncNetProjectHomeTreasuryConverter converter, SyncNetProjectHomeSink sink) {
        DeployChecks.Config memory c = DeployChecks.Config({
            actualChainId: block.chainid,
            declaredChainId: vm.envUint("CHAIN_ID"),
            sync: vm.envAddress("SYNC"),
            usdg: vm.envAddress("USDG"),
            router: vm.envAddress("PAR_MULTI_ROUTER"),
            market: vm.envUint("SYNC_USDG_MARKET"),
            treasury: vm.envAddress("TREASURY"),
            treasuryConfirmation: vm.envAddress("TREASURY_CONFIRM"),
            deployer: msg.sender
        });
        DeployChecks.check(c);
        c.deployer = tx.origin;
        DeployChecks.check(c);
        DeployChecks.checkTreasuryCode(vm.envUint("TREASURY_EXPECT_EOA"), c.treasury.code.length);

        vm.startBroadcast();
        converter = new SyncNetProjectHomeTreasuryConverter(c.sync, c.usdg, c.treasury, c.router, uint8(c.market));
        sink = new SyncNetProjectHomeSink(c.sync, address(converter));
        vm.stopBroadcast();

        require(address(converter).code.length != 0, "post-deploy: converter missing");
        require(address(converter.SYNC()) == c.sync && address(converter.USDG()) == c.usdg, "post-deploy: converter tokens");
        require(converter.TREASURY() == c.treasury && address(converter.ROUTER()) == c.router, "post-deploy: converter roles");
        require(converter.MARKET() == c.market, "post-deploy: converter market");
        require(address(sink.SYNC()) == c.sync && sink.TREASURY_CONVERTER() == address(converter), "post-deploy: sink wiring");
        require(sink.BURN_PERCENT() == 60, "post-deploy: split");
    }
}
