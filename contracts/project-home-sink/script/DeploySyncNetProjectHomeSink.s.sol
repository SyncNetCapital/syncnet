// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";
import {DeployChecks} from "./DeployChecks.sol";

interface VmScript {
    function envUint(string calldata) external view returns (uint256);
    function envAddress(string calldata) external view returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys SyncNetProjectHomeSink. NOT RUN in this phase — production deployment is blocked until the real
///         SyncNet protocol treasury is approved. Every variable is required; a missing one reverts (no defaults):
///           CHAIN_ID=4663
///           SYNC=0x6368e007b9f0b941560ed1f3bceb20247f5eca37
///           TREASURY=<approved SyncNet protocol treasury>
///           TREASURY_CONFIRM=<the same address again>
///         forge script script/DeploySyncNetProjectHomeSink.s.sol --rpc-url <robinhood rpc> --sender <deployer> ...
contract DeploySyncNetProjectHomeSink {
    VmScript internal constant vm = VmScript(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (SyncNetProjectHomeSink sink) {
        uint256 declaredChainId = vm.envUint("CHAIN_ID");
        address sync = vm.envAddress("SYNC");
        address treasury = vm.envAddress("TREASURY");
        address confirm = vm.envAddress("TREASURY_CONFIRM");
        DeployChecks.check(block.chainid, declaredChainId, sync, treasury, confirm, msg.sender);
        DeployChecks.check(block.chainid, declaredChainId, sync, treasury, confirm, tx.origin);

        vm.startBroadcast();
        sink = new SyncNetProjectHomeSink(sync, treasury);
        vm.stopBroadcast();

        require(address(sink.SYNC()) == sync, "post-deploy: SYNC mismatch");
        require(sink.TREASURY() == treasury, "post-deploy: TREASURY mismatch");
        require(sink.BURN_PERCENT() == 60, "post-deploy: split mismatch");
    }
}
