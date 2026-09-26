// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";

interface VmFork {
    function envString(string calldata) external view returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function store(address, bytes32, bytes32) external;
    function load(address, bytes32) external view returns (bytes32);
}

interface IERC20View {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @notice LOCAL FORK REHEARSAL ONLY (never broadcasts): deploys the sink on an in-memory fork of Robinhood Chain and
///         settles against the REAL canonical $SYNC bytecode, proving SYNC.burn() from the sink reduces totalSupply.
///         Run: ROBINHOOD_FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-path 'fork/*' --contracts fork
contract SinkForkTest {
    VmFork internal constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;
    address internal constant FIXTURE_TREASURY = address(0x7EA5); // fixture only

    function test_fork_settleBurnsRealSync() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_FORK_URL"));
        require(block.chainid == 4663, "not Robinhood Chain");
        SyncNetProjectHomeSink sink = new SyncNetProjectHomeSink(SYNC, FIXTURE_TREASURY);
        // Give the sink a fork-local balance by writing the token's balance mapping (OpenZeppelin ERC20 layout, slot 0),
        // and confirm the write through balanceOf so a wrong layout guess fails loudly instead of passing vacuously.
        uint256 amount = 1_000_000e18 + 7;
        bytes32 slot = keccak256(abi.encode(address(sink), uint256(0)));
        vm.store(SYNC, slot, bytes32(amount));
        require(IERC20View(SYNC).balanceOf(address(sink)) == amount, "balance slot layout differs: rehearsal inconclusive");
        uint256 supplyBefore = IERC20View(SYNC).totalSupply();
        (uint256 burned, uint256 toTreasury) = sink.settle();
        require(burned == 600_000e18 + 4, "burn share");
        require(toTreasury == 400_000e18 + 3, "treasury share");
        require(IERC20View(SYNC).totalSupply() == supplyBefore - burned, "real SYNC.burn reduced totalSupply");
        require(IERC20View(SYNC).balanceOf(FIXTURE_TREASURY) == toTreasury, "treasury received remainder");
        require(IERC20View(SYNC).balanceOf(address(sink)) == 0, "no residue");
        require(sink.totalBurned() == burned && sink.totalTreasury() == toTreasury && sink.totalSettled() == amount, "totals");
    }
}
