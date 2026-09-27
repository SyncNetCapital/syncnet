// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {MockSync} from "./utils/MockSync.sol";
import {MockUsdg, MockParFactory, MockParRouter, HostileRouter} from "./utils/MockPar.sol";
import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";
import {SyncNetProjectHomeTreasuryConverter, PoolKey} from "../src/SyncNetProjectHomeTreasuryConverter.sol";

interface VmExtra {
    function warp(uint256) external;
}

contract SyncNetProjectHomeTreasuryConverterTest is TestBase {
    event Converted(address indexed executor, uint256 syncRequested, uint256 syncSold, uint256 usdgOut, uint256 usdgDelivered);

    address internal constant TREASURY = address(0x7EA5); // fixture treasury wallet — never a real address
    address internal constant PAYER = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);
    uint8 internal constant MARKET = 1;

    MockSync internal sync;
    MockUsdg internal usdg;
    MockParFactory internal factory;
    MockParRouter internal router;
    SyncNetProjectHomeTreasuryConverter internal conv;
    SyncNetProjectHomeSink internal sink;

    function key(address a, address b) internal pure returns (PoolKey memory) {
        return PoolKey({currency0: a < b ? a : b, currency1: a < b ? b : a, fee: 20000, tickSpacing: 10, hooks: address(0)});
    }

    function setUp() public {
        sync = new MockSync();
        usdg = new MockUsdg();
        factory = new MockParFactory();
        factory.push(key(address(sync), address(0xCA9C))); // market 0: some other quote asset
        factory.push(key(address(sync), address(usdg))); // market 1: SYNC/USDG, like the live launch
        router = new MockParRouter(address(factory), address(sync), address(usdg));
        conv = new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(router), MARKET);
        sink = new SyncNetProjectHomeSink(address(sync), address(conv));
        sync.mint(PAYER, 1_000_000_000e18);
    }

    function activation(uint256 amount) internal {
        vm.prank(PAYER);
        sync.transfer(address(sink), amount);
        sink.settle();
    }

    function convertAs(address who, uint256 amount, uint256 minOut, uint256 deadline) internal returns (bool ok) {
        vm.prank(who);
        (ok, ) = address(conv).call(abi.encodeWithSelector(conv.convert.selector, amount, minOut, deadline));
    }

    // ------------------------------------------------------------------ constructor
    function test_constructor_setsImmutables() public view {
        assertEq(address(conv.SYNC()), address(sync), "SYNC");
        assertEq(address(conv.USDG()), address(usdg), "USDG");
        assertEq(conv.TREASURY(), TREASURY, "TREASURY");
        assertEq(address(conv.ROUTER()), address(router), "ROUTER");
        assertEq(conv.MARKET(), MARKET, "MARKET");
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.ZeroAddress.selector);
        new SyncNetProjectHomeTreasuryConverter(address(0), address(usdg), TREASURY, address(router), MARKET);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.ZeroAddress.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(0), TREASURY, address(router), MARKET);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.ZeroAddress.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), address(0), address(router), MARKET);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.ZeroAddress.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(0), MARKET);
    }

    function test_constructor_rejectsAliasedRoles() public {
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.InvalidConfiguration.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(sync), TREASURY, address(router), MARKET);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.InvalidConfiguration.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), address(usdg), address(router), MARKET);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.InvalidConfiguration.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), address(router), address(router), MARKET);
    }

    function test_constructor_rejectsWrongMarket() public {
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.RouteMismatch.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(router), 0); // SYNC/other
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.RouteMismatch.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(router), 2); // no such market
    }

    function test_constructor_rejectsWrongUsdg() public {
        MockUsdg fake = new MockUsdg();
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.RouteMismatch.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(fake), TREASURY, address(router), MARKET);
    }

    function test_constructor_rejectsHookedPool() public {
        PoolKey memory k = key(address(sync), address(usdg));
        k.hooks = address(0x400C);
        factory.setKey(1, k);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.RouteMismatch.selector);
        new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(router), MARKET);
    }

    // ------------------------------------------------------------------ happy path
    function test_convert_deliversAllUsdgToTreasury() public {
        activation(1_000_000e18); // 400,000 SYNC forwarded
        assertEq(conv.pendingSync(), 400_000e18, "pending = forwarded treasury share");
        vm.expectEmit(true, false, false, true);
        emit Converted(TREASURY, 400_000e18, 400_000e18, 2_000e6, 2_000e6);
        assertTrue(convertAs(TREASURY, 400_000e18, 1_990e6, block.timestamp), "treasury converts");
        assertEq(usdg.balanceOf(TREASURY), 2_000e6, "treasury received the real USDG output");
        assertEq(usdg.balanceOf(address(conv)), 0, "converter retains no USDG");
        assertEq(sync.balanceOf(address(conv)), 0, "all SYNC sold");
        assertEq(conv.totalSyncConverted(), 400_000e18, "totalSyncConverted");
        assertEq(conv.totalUsdgFromConversions(), 2_000e6, "totalUsdgFromConversions");
        assertEq(conv.totalUsdgDelivered(), 2_000e6, "totalUsdgDelivered");
        assertEq(router.lastRecipient(), address(conv), "router pays the converter, which forwards to the treasury");
        assertEq(sync.allowance(address(conv), address(router)), 0, "no allowance left behind");
    }

    function test_convert_accumulatesSeveralAllocations() public {
        activation(1_000e18);
        activation(2_000e18);
        activation(7);
        uint256 pending = conv.pendingSync();
        assertEq(pending, 400e18 + 800e18 + 3, "three treasury shares accumulate");
        assertTrue(convertAs(TREASURY, pending, 1, block.timestamp), "one conversion for all");
        assertEq(conv.totalSyncConverted(), pending, "all converted");
        assertEq(sink.totalTreasurySyncForwarded(), pending, "sink forwarded == converted");
    }

    function test_convert_partialAmountLeavesRestPending() public {
        activation(1_000_000e18);
        assertTrue(convertAs(TREASURY, 100_000e18, 1, block.timestamp), "partial");
        assertEq(conv.pendingSync(), 300_000e18, "rest waits");
        assertTrue(convertAs(TREASURY, 300_000e18, 1, block.timestamp), "rest");
        assertEq(conv.totalSyncConverted(), 400_000e18, "cumulative");
        assertEq(conv.totalUsdgDelivered(), usdg.balanceOf(TREASURY), "delivered == treasury balance");
    }

    function test_convert_shallowPoolSellsOnlyWhatFillsAndResetsAllowance() public {
        activation(1_000_000e18);
        router.setDepthCap(150_000e18);
        assertTrue(convertAs(TREASURY, 400_000e18, 1, block.timestamp), "fills what the pool can take");
        assertEq(conv.totalSyncConverted(), 150_000e18, "accounting uses the SYNC actually sold");
        assertEq(conv.pendingSync(), 250_000e18, "unfilled SYNC stays safely in the converter");
        assertEq(sync.allowance(address(conv), address(router)), 0, "no dangling allowance");
    }

    function test_convert_unsolicitedSyncFollowsTheSameTreasuryOnlyPath() public {
        sync.mint(STRANGER, 5e18);
        vm.prank(STRANGER);
        sync.transfer(address(conv), 5e18);
        assertTrue(convertAs(TREASURY, 5e18, 1, block.timestamp), "converted like any allocation");
        assertEq(usdg.balanceOf(TREASURY), 25_000, "USDG to the treasury only");
        assertEq(sync.balanceOf(STRANGER), 0, "no refund path");
    }

    function test_convert_directUsdgIsForwardedToTreasury() public {
        activation(1_000e18);
        usdg.mint(address(conv), 123);
        assertTrue(convertAs(TREASURY, 400e18, 1, block.timestamp), "convert");
        assertEq(usdg.balanceOf(address(conv)), 0, "stray USDG not retained");
        assertEq(conv.totalUsdgFromConversions(), 2e6, "conversion output counted separately");
        assertEq(conv.totalUsdgDelivered(), 2e6 + 123, "delivered includes the stray USDG, to the treasury");
        assertEq(usdg.balanceOf(TREASURY), 2e6 + 123, "treasury got both");
    }

    // ------------------------------------------------------------------ authority
    function test_convert_onlyTreasury() public {
        activation(1_000_000e18);
        assertTrue(!convertAs(STRANGER, 400_000e18, 1, block.timestamp), "stranger cannot convert");
        assertTrue(!convertAs(PAYER, 400_000e18, 1, block.timestamp), "payer cannot convert");
        assertTrue(!convertAs(address(sink), 400_000e18, 1, block.timestamp), "sink cannot convert");
        assertTrue(!convertAs(address(router), 400_000e18, 1, block.timestamp), "router cannot convert");
        assertEq(conv.pendingSync(), 400_000e18, "nothing moved");
    }

    function test_convert_revertsNotTreasurySelector() public {
        activation(1_000e18);
        vm.prank(STRANGER);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.NotTreasury.selector);
        conv.convert(400e18, 1, block.timestamp);
    }

    function test_thirdPartyCannotForceLowMinOut() public {
        activation(1_000_000e18);
        assertTrue(!convertAs(STRANGER, 400_000e18, 1, block.timestamp), "a third party cannot trigger a dump at minOut=1");
        assertEq(router.calls(), 0, "the router was never reached");
    }

    // ------------------------------------------------------------------ slippage / deadline / zero
    function test_convert_zeroMinOutRejected() public {
        activation(1_000e18);
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.ZeroMinOut.selector);
        conv.convert(400e18, 0, block.timestamp);
    }

    function test_convert_minOutNotMetReverts() public {
        activation(1_000_000e18);
        vm.prank(TREASURY);
        vm.expectRevert(abi.encodeWithSelector(MockParRouter.SlippageExceeded.selector, uint256(2_000e6), uint256(2_001e6)));
        conv.convert(400_000e18, 2_001e6, block.timestamp);
        assertEq(conv.pendingSync(), 400_000e18, "SYNC stays after a failed conversion");
        assertEq(usdg.balanceOf(TREASURY), 0, "nothing delivered");
    }

    function test_convert_converterEnforcesItsOwnFloorEvenIfRouterDoesNot() public {
        activation(1_000_000e18);
        router.setPayLess(true);
        vm.prank(TREASURY);
        vm.expectRevert(abi.encodeWithSelector(SyncNetProjectHomeTreasuryConverter.SlippageExceeded.selector, uint256(1_000e6), uint256(1_500e6)));
        conv.convert(400_000e18, 1_500e6, block.timestamp);
        assertEq(conv.pendingSync(), 400_000e18, "reverted as a whole");
    }

    function test_convert_deadlineExpired() public {
        activation(1_000e18);
        VmExtra(address(vm)).warp(1_000_000);
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.DeadlineExpired.selector);
        conv.convert(400e18, 1, 999_999);
    }

    function test_convert_zeroBalanceAndZeroAmount() public {
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.InsufficientSync.selector);
        conv.convert(1, 1, block.timestamp);
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.ZeroAmount.selector);
        conv.convert(0, 1, block.timestamp);
    }

    function test_convert_moreThanPendingRejected() public {
        activation(1_000e18);
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.InsufficientSync.selector);
        conv.convert(400e18 + 1, 1, block.timestamp);
    }

    function test_convert_repeatedCallAfterEmptyIsSafe() public {
        activation(1_000e18);
        assertTrue(convertAs(TREASURY, 400e18, 1, block.timestamp), "first");
        assertTrue(!convertAs(TREASURY, 1, 1, block.timestamp), "nothing left to convert");
        assertEq(conv.totalSyncConverted(), 400e18, "no double count");
    }

    // ------------------------------------------------------------------ failures leave funds in place
    function test_convert_routerRevertLeavesSync() public {
        activation(1_000_000e18);
        router.setReverts(true);
        assertTrue(!convertAs(TREASURY, 400_000e18, 1, block.timestamp), "router revert propagates");
        assertEq(conv.pendingSync(), 400_000e18, "SYNC safe");
        assertEq(sync.allowance(address(conv), address(router)), 0, "approval rolled back with the revert");
    }

    function test_convert_insufficientLiquidityOutputBelowFloor() public {
        activation(1_000_000e18);
        router.setDepthCap(1e18); // a nearly empty pool
        assertTrue(!convertAs(TREASURY, 400_000e18, 1_000e6, block.timestamp), "floor protects against a drained pool");
        assertEq(conv.pendingSync(), 400_000e18, "SYNC safe");
    }

    function test_convert_usdgTransferFailureRevertsEverything() public {
        activation(1_000_000e18);
        usdg.setTransferReverts(true);
        assertTrue(!convertAs(TREASURY, 400_000e18, 1, block.timestamp), "delivery failure reverts the swap too");
        assertEq(conv.pendingSync(), 400_000e18, "SYNC safe");
        assertEq(conv.totalSyncConverted(), 0, "no accounting");
        usdg.setTransferReverts(false);
        usdg.setTransferReturnsFalse(true);
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.UsdgTransferFailed.selector);
        conv.convert(400_000e18, 1, block.timestamp);
    }

    function test_convert_routeChangedAfterDeploymentFailsClosed() public {
        activation(1_000e18);
        factory.setKey(1, key(address(sync), address(0xE11)));
        vm.prank(TREASURY);
        vm.expectRevert(SyncNetProjectHomeTreasuryConverter.RouteMismatch.selector);
        conv.convert(400e18, 1, block.timestamp);
        factory.setReverts(true);
        assertTrue(!convertAs(TREASURY, 400e18, 1, block.timestamp), "unreadable factory fails closed");
        assertEq(conv.pendingSync(), 400e18, "SYNC safe");
    }

    function test_hostileRouterCannotReenterOrOverpull() public {
        HostileRouter hr = new HostileRouter(address(factory), address(sync));
        SyncNetProjectHomeTreasuryConverter c2 = new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(hr), MARKET);
        hr.setTarget(address(c2));
        sync.mint(address(c2), 10e18);
        vm.prank(TREASURY);
        (bool ok, ) = address(c2).call(abi.encodeWithSelector(c2.convert.selector, 10e18, 1, block.timestamp));
        assertTrue(!ok, "re-entry blocked and over-pull impossible");
        assertEq(sync.balanceOf(address(c2)), 10e18, "SYNC safe");
    }

    // ------------------------------------------------------------------ no admin / rescue / generic surface
    function test_noAdminRescueOrGenericSwapSurface() public {
        activation(1_000_000e18);
        bytes[] memory calls = new bytes[](18);
        calls[0] = abi.encodeWithSignature("owner()");
        calls[1] = abi.encodeWithSignature("setOwner(address)", STRANGER);
        calls[2] = abi.encodeWithSignature("setTreasury(address)", STRANGER);
        calls[3] = abi.encodeWithSignature("setExecutor(address)", STRANGER);
        calls[4] = abi.encodeWithSignature("setRouter(address)", STRANGER);
        calls[5] = abi.encodeWithSignature("setToken(address)", STRANGER);
        calls[6] = abi.encodeWithSignature("setUSDG(address)", STRANGER);
        calls[7] = abi.encodeWithSignature("upgradeTo(address)", STRANGER);
        calls[8] = abi.encodeWithSignature("rescue(address,address,uint256)", address(sync), STRANGER, 1);
        calls[9] = abi.encodeWithSignature("sweep(address)", address(sync));
        calls[10] = abi.encodeWithSignature("withdraw(address,uint256)", address(sync), 1);
        calls[11] = abi.encodeWithSignature("execute(address,bytes)", address(sync), "");
        calls[12] = abi.encodeWithSignature("swap(address,address,uint256,uint256,address)", address(sync), address(usdg), 1, 1, STRANGER);
        calls[13] = abi.encodeWithSignature("convert(uint256,uint256,uint256,address)", 1, 1, type(uint256).max, STRANGER);
        calls[14] = abi.encodeWithSignature("convertTo(address,uint256,uint256,uint256)", STRANGER, 1, 1, type(uint256).max);
        calls[15] = abi.encodeWithSignature("approve(address,uint256)", STRANGER, 1);
        calls[16] = abi.encodeWithSignature("setMarket(uint8)", 0);
        calls[17] = abi.encodeWithSignature("multicall(bytes[])", new bytes[](0));
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(TREASURY); // even the treasury has no such power
            (bool ok, ) = address(conv).call(calls[i]);
            assertTrue(!ok, "admin-like / generic call must not exist");
        }
        assertEq(conv.pendingSync(), 400_000e18, "nothing moved");
        assertEq(sync.allowance(address(conv), STRANGER), 0, "no approvals");
    }

    function test_noPayableSurface() public {
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        (bool ok, ) = address(conv).call{value: 1}("");
        assertTrue(!ok, "no receive");
        vm.prank(STRANGER);
        (bool ok2, ) = address(conv).call{value: 1}(abi.encodeWithSelector(conv.convert.selector, 1, 1, block.timestamp));
        assertTrue(!ok2, "convert is not payable");
    }

    function test_noOutputRecipientParameter() public {
        activation(1_000_000e18);
        assertTrue(convertAs(TREASURY, 400_000e18, 1, block.timestamp), "convert");
        assertEq(usdg.balanceOf(STRANGER), 0, "stranger received nothing");
        assertEq(usdg.balanceOf(TREASURY), 2_000e6, "the treasury is the only possible destination");
    }

    function testFuzz_convert_accountingMatchesBalances(uint96 paid, uint96 sellPart, uint32 price) public {
        vm.assume(paid > 100 && paid <= 1_000_000_000e18 && price > 0);
        activation(paid);
        uint256 pending = conv.pendingSync();
        uint256 amount = bound(sellPart, 1, pending);
        router.setPrice(uint256(price) * 1e12);
        uint256 expectedOut = (amount * uint256(price) * 1e12) / 1e18;
        vm.assume(expectedOut > 0);
        assertTrue(convertAs(TREASURY, amount, expectedOut, block.timestamp), "convert");
        assertEq(conv.totalSyncConverted() + conv.pendingSync(), pending, "sold + pending == forwarded");
        assertEq(usdg.balanceOf(TREASURY), conv.totalUsdgDelivered(), "delivered == treasury balance");
        assertEq(conv.totalUsdgFromConversions(), expectedOut, "real output recorded");
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}
