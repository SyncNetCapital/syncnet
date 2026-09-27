// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";
import {SyncNetProjectHomeTreasuryConverter} from "../src/SyncNetProjectHomeTreasuryConverter.sol";

interface VmFork {
    function envString(string calldata) external view returns (string memory);
    function createSelectFork(string calldata) external returns (uint256);
    function store(address, bytes32, bytes32) external;
    function prank(address) external;
    function snapshotState() external returns (uint256);
    function revertToState(uint256) external returns (bool);
}

interface IERC20View {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @notice LOCAL FORK REHEARSAL ONLY (never broadcasts). Deploys the converter and the sink on an in-memory fork of
///         Robinhood Chain and runs the full lifecycle against REAL live bytecode and state: canonical SYNC, canonical
///         USDG, the PAR multi-market router and the PAR SYNC/USDG Uniswap v4 pool.
///         Run: ROBINHOOD_FORK_URL=https://rpc.mainnet.chain.robinhood.com forge test --contracts fork --match-path 'fork/*' -vv
contract SinkForkTest {
    VmFork internal constant vm = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ROUTER = 0x458D2a59c2F3dd32775a64eE72004561440d64Df;
    address internal constant FIXTURE_TREASURY = address(0x7EA5); // fixture only
    address internal constant STRANGER = address(0xBAD);

    event Log(string what, uint256 value);

    function test_fork_fullLifecycleOnTheRealRoute() public {
        vm.createSelectFork(vm.envString("ROBINHOOD_FORK_URL"));
        require(block.chainid == 4663, "not Robinhood Chain");
        // Deployment order: converter (constructor re-reads the live PAR factory: market 1 == SYNC/USDG), then sink.
        SyncNetProjectHomeTreasuryConverter conv = new SyncNetProjectHomeTreasuryConverter(SYNC, USDG, FIXTURE_TREASURY, ROUTER, 1);
        SyncNetProjectHomeSink sink = new SyncNetProjectHomeSink(SYNC, address(conv));

        // Small simulated payments: give the sink a fork-local balance (OpenZeppelin ERC20 _balances at slot 0, checked).
        uint256 amount = 2_000e18 + 7;
        vm.store(SYNC, keccak256(abi.encode(address(sink), uint256(0))), bytes32(amount));
        require(IERC20View(SYNC).balanceOf(address(sink)) == amount, "balance slot layout differs: rehearsal inconclusive");

        uint256 supplyBefore = IERC20View(SYNC).totalSupply();
        (uint256 burned, uint256 forwarded) = sink.settle();
        require(burned == 1_200e18 + 4, "sink burns exact floor(60%)");
        require(forwarded == 800e18 + 3, "converter receives the exact remainder");
        require(IERC20View(SYNC).totalSupply() == supplyBefore - burned, "totalSupply decreased by the burn");
        require(IERC20View(SYNC).balanceOf(address(conv)) == forwarded, "treasury share waits in the converter, as SYNC");
        require(IERC20View(USDG).balanceOf(FIXTURE_TREASURY) == 0, "treasury fixture starts empty");

        // A third party cannot convert, whatever minOut it offers.
        vm.prank(STRANGER);
        (bool strangerOk, ) = address(conv).call(abi.encodeWithSelector(conv.convert.selector, forwarded, uint256(1), block.timestamp));
        require(!strangerOk, "stranger conversion must fail");

        // Quote by simulation (what an operator does with eth_call), then roll back.
        uint256 snap = vm.snapshotState();
        vm.prank(FIXTURE_TREASURY);
        (, uint256 quoted, ) = conv.convert(forwarded, 1, block.timestamp);
        vm.revertToState(snap);
        emit Log("quoted USDG (6 dp) for 800 SYNC", quoted);
        require(quoted > 0, "the live pool produces USDG");

        // A floor above what the pool pays reverts and leaves the SYNC in place.
        vm.prank(FIXTURE_TREASURY);
        (bool tooGreedy, ) = address(conv).call(abi.encodeWithSelector(conv.convert.selector, forwarded, quoted + 1, block.timestamp + 600));
        require(!tooGreedy, "minOut above execution must revert");
        require(IERC20View(SYNC).balanceOf(address(conv)) == forwarded, "SYNC safe after a failed conversion");

        // Real conversion with a 1% slippage floor.
        vm.prank(FIXTURE_TREASURY);
        (uint256 sold, uint256 out, uint256 delivered) = conv.convert(forwarded, (quoted * 99) / 100, block.timestamp + 600);
        emit Log("USDG delivered (6 dp)", delivered);
        require(sold == forwarded && out == quoted && delivered == out, "exact real execution");
        require(IERC20View(USDG).balanceOf(FIXTURE_TREASURY) == out, "USDG went to the treasury fixture");
        require(IERC20View(USDG).balanceOf(address(conv)) == 0, "converter retains no USDG");
        require(IERC20View(SYNC).balanceOf(address(conv)) == 0, "nothing left pending");
        require(conv.totalSyncConverted() == sold && conv.totalUsdgDelivered() == out, "actual accounting");
        require(conv.TREASURY() == FIXTURE_TREASURY, "destination unchanged");
    }
}
