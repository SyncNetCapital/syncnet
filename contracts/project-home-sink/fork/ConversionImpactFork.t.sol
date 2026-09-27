// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SyncNetProjectHomeTreasuryConverter} from "../src/SyncNetProjectHomeTreasuryConverter.sol";

interface VmFork2 {
    function envString(string calldata) external view returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function store(address, bytes32, bytes32) external;
    function prank(address) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

/// @notice LOCAL FORK, INFORMATIONAL: how much USDG the live SYNC/USDG pool pays for treasury batches of several sizes
///         (each quoted from the same pre-trade state). Shows why conversion is batched/chunked by the treasury
///         with a slippage floor and never forced per activation. Never broadcasts.
contract ConversionImpactForkTest {
    VmFork2 internal constant vm = VmFork2(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ROUTER = 0x458D2a59c2F3dd32775a64eE72004561440d64Df;
    address internal constant FIXTURE_TREASURY = address(0x7EA5);

    event Quote(uint256 syncIn, uint256 usdgOut);

    function test_fork_quoteSizes() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_FORK_URL"));
        SyncNetProjectHomeTreasuryConverter conv = new SyncNetProjectHomeTreasuryConverter(SYNC, USDG, FIXTURE_TREASURY, ROUTER, 1);
        uint256[5] memory sizes = [uint256(1_000e18), 10_000e18, 100_000e18, 320_000e18, 1_000_000e18];
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.store(SYNC, keccak256(abi.encode(address(conv), uint256(0))), bytes32(sizes[i]));
            vm.prank(FIXTURE_TREASURY);
            (, uint256 out, ) = conv.convert(sizes[i], 1, block.timestamp);
            emit Quote(sizes[i], out);
            vm.revertToState(snap);
        }
    }
}
