// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {MockSync, ReentrantSync} from "./utils/MockSync.sol";
import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";

contract SyncNetProjectHomeSinkTest is TestBase {
    event Settled(address indexed caller, uint256 amount, uint256 burned, uint256 toTreasury);

    // Fixture addresses only — never a real treasury.
    address internal constant TREASURY = address(0x7EA5);
    address internal constant PAYER = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);

    MockSync internal sync;
    SyncNetProjectHomeSink internal sink;

    function setUp() public {
        sync = new MockSync();
        sink = new SyncNetProjectHomeSink(address(sync), TREASURY);
        sync.mint(PAYER, 1_000_000_000e18);
    }

    function pay(uint256 amount) internal {
        vm.prank(PAYER);
        sync.transfer(address(sink), amount);
    }

    // ------------------------------------------------------------------ constructor
    function test_constructor_rejectsZeroSync() public {
        vm.expectRevert(SyncNetProjectHomeSink.ZeroAddress.selector);
        new SyncNetProjectHomeSink(address(0), TREASURY);
    }

    function test_constructor_rejectsZeroTreasury() public {
        vm.expectRevert(SyncNetProjectHomeSink.ZeroAddress.selector);
        new SyncNetProjectHomeSink(address(sync), address(0));
    }

    function test_constructor_rejectsTreasuryEqualToToken() public {
        vm.expectRevert(SyncNetProjectHomeSink.TreasuryIsToken.selector);
        new SyncNetProjectHomeSink(address(sync), address(sync));
    }

    function test_constructor_setsImmutables() public view {
        assertEq(address(sink.SYNC()), address(sync), "SYNC");
        assertEq(sink.TREASURY(), TREASURY, "TREASURY");
        assertEq(sink.BURN_PERCENT(), 60, "BURN_PERCENT");
        assertEq(sink.totalSettled() + sink.totalBurned() + sink.totalTreasury(), 0, "fresh totals");
    }

    // ------------------------------------------------------------------ split
    function test_split_exact6040() public {
        pay(1_000_000e18);
        uint256 supplyBefore = sync.totalSupply();
        (uint256 burned, uint256 toTreasury) = sink.settle();
        assertEq(burned, 600_000e18, "burn 60%");
        assertEq(toTreasury, 400_000e18, "treasury 40%");
        assertEq(sync.totalSupply(), supplyBefore - 600_000e18, "totalSupply decreased by the burn");
        assertEq(sync.balanceOf(TREASURY), 400_000e18, "treasury received 40%");
        assertEq(sync.balanceOf(address(sink)), 0, "sink emptied");
    }

    function test_split_tinyBalances() public view {
        (uint256 b, uint256 t) = sink.split(0);
        assertEq(b + t, 0, "0");
        (b, t) = sink.split(1);
        assertEq(b, 0, "1 wei: nothing burned");
        assertEq(t, 1, "1 wei: remainder to treasury");
        (b, t) = sink.split(2);
        assertEq(b, 1, "2 wei burn floor(1.2)");
        assertEq(t, 1, "2 wei treasury");
        (b, t) = sink.split(5);
        assertEq(b, 3, "5 wei burn");
        assertEq(t, 2, "5 wei treasury");
        (b, t) = sink.split(99);
        assertEq(b, 59, "99 wei burn floor(59.4)");
        assertEq(t, 40, "99 wei treasury");
        (b, t) = sink.split(100);
        assertEq(b, 60, "100 wei burn");
        assertEq(t, 40, "100 wei treasury");
    }

    function test_split_oddBalanceSettles() public {
        pay(7);
        uint256 supplyBefore = sync.totalSupply();
        sink.settle();
        assertEq(supplyBefore - sync.totalSupply(), 4, "floor(4.2) burned");
        assertEq(sync.balanceOf(TREASURY), 3, "remainder 3 to treasury");
        assertEq(sync.balanceOf(address(sink)), 0, "no residue");
    }

    function test_split_maxUintNoOverflow() public view {
        (uint256 b, uint256 t) = sink.split(type(uint256).max);
        assertEq(b + t, type(uint256).max, "conserves amount");
        assertEq(b, (type(uint256).max / 100) * 60 + ((type(uint256).max % 100) * 60) / 100, "floor 60%");
    }

    function testFuzz_split_conservesAndFloors(uint256 amount) public view {
        (uint256 b, uint256 t) = sink.split(amount);
        assertEq(b + t, amount, "burn + treasury == amount");
        if (amount <= type(uint256).max / 60) assertEq(b, (amount * 60) / 100, "equals floor(amount*60/100)");
        assertTrue(t >= b / 2 || amount < 100, "treasury never starved");
    }

    function testFuzz_settle_noResidue(uint96 amount) public {
        vm.assume(amount <= 1_000_000_000e18);
        pay(amount);
        uint256 supplyBefore = sync.totalSupply();
        sink.settle();
        (uint256 b, uint256 t) = sink.split(amount);
        assertEq(sync.balanceOf(address(sink)), 0, "sink empty after settle");
        assertEq(supplyBefore - sync.totalSupply(), b, "burned == split burn");
        assertEq(sync.balanceOf(TREASURY), t, "treasury == split remainder");
        assertEq(sink.totalSettled(), amount, "totalSettled");
    }

    // ------------------------------------------------------------------ zero balance / repeats
    function test_settle_zeroBalanceIsNoop() public {
        uint256 supplyBefore = sync.totalSupply();
        (uint256 b, uint256 t) = sink.settle();
        assertEq(b + t, 0, "nothing settled");
        assertEq(sync.burnCalls(), 0, "burn not called");
        assertEq(sync.totalSupply(), supplyBefore, "supply unchanged");
        assertEq(sink.totalSettled(), 0, "totals unchanged");
    }

    function test_settle_repeatedAfterZeroIsSafe() public {
        pay(1000);
        sink.settle();
        sink.settle();
        sink.settle();
        assertEq(sink.totalSettled(), 1000, "no double count");
        assertEq(sink.totalBurned(), 600, "burned once");
        assertEq(sink.totalTreasury(), 400, "treasury once");
    }

    function test_settle_cumulativeTotals() public {
        pay(1000);
        sink.settle();
        pay(7);
        sink.settle();
        pay(1e18 + 3);
        sink.settle();
        uint256 settled = 1000 + 7 + 1e18 + 3;
        assertEq(sink.totalSettled(), settled, "totalSettled");
        assertEq(sink.totalBurned() + sink.totalTreasury(), settled, "totals add up");
        uint256 big = 1e18 + 3;
        assertEq(sink.totalBurned(), 600 + 4 + (big * 60) / 100, "totalBurned");
        assertEq(sync.balanceOf(TREASURY), sink.totalTreasury(), "treasury balance == totalTreasury");
    }

    function test_settle_emitsSettled() public {
        pay(1000);
        vm.expectEmit(true, false, false, true);
        emit Settled(STRANGER, 1000, 600, 400);
        vm.prank(STRANGER);
        sink.settle();
    }

    // ------------------------------------------------------------------ permissionless, no redirection
    function test_settle_anyoneCanSettle() public {
        pay(500);
        vm.prank(STRANGER);
        sink.settle();
        assertEq(sync.balanceOf(STRANGER), 0, "caller receives nothing");
        assertEq(sync.balanceOf(TREASURY), 200, "treasury receives");
    }

    function test_settle_callerCannotRedirectFunds() public {
        pay(500);
        // settle takes no parameters: extra calldata is ignored and funds still go to the immutable treasury.
        vm.prank(STRANGER);
        (bool ok, ) = address(sink).call(abi.encodePacked(SyncNetProjectHomeSink.settle.selector, abi.encode(STRANGER)));
        assertTrue(ok, "settle with junk calldata still settles");
        assertEq(sync.balanceOf(STRANGER), 0, "stranger got nothing");
        assertEq(sync.balanceOf(TREASURY), 200, "treasury got the 40%");
    }

    function test_unsolicitedTransfersAreSettledToo() public {
        pay(1000); // "activation"
        sync.mint(STRANGER, 50);
        vm.prank(STRANGER);
        sync.transfer(address(sink), 50); // unsolicited
        (uint256 amount, uint256 toBurn, uint256 toTreasury) = sink.pending();
        assertEq(amount, 1050, "pending counts every token held");
        assertEq(toBurn, 630, "committed to burn");
        assertEq(toTreasury, 420, "committed to treasury");
        sink.settle();
        assertEq(sink.totalSettled(), 1050, "all received SYNC settled 60/40");
        assertEq(sync.balanceOf(address(sink)), 0, "no residue");
    }

    function test_pendingIsNotBurned() public {
        pay(1000);
        uint256 supplyBefore = sync.totalSupply();
        sink.pending();
        assertEq(sync.totalSupply(), supplyBefore, "tokens in the sink are committed, not burned");
        assertEq(sink.totalBurned(), 0, "totalBurned counts only executed burns");
    }

    // ------------------------------------------------------------------ failures revert atomically
    function test_settle_revertingBurnRevertsEverything() public {
        pay(1000);
        sync.setBurnReverts(true);
        vm.expectRevert(bytes("MockSync: burn reverts"));
        sink.settle();
        assertEq(sync.balanceOf(address(sink)), 1000, "balance untouched");
        assertEq(sink.totalSettled(), 0, "no accounting on failure");
        assertEq(sink.totalBurned(), 0, "no burn counted");
    }

    function test_settle_revertingTransferRevertsEverything() public {
        pay(1000);
        uint256 supplyBefore = sync.totalSupply();
        sync.setTransferReverts(true);
        vm.expectRevert(bytes("MockSync: transfer reverts"));
        sink.settle();
        assertEq(sync.totalSupply(), supplyBefore, "burn rolled back");
        assertEq(sink.totalSettled(), 0, "no accounting on failure");
    }

    function test_settle_falseTransferReverts() public {
        pay(1000);
        sync.setTransferReturnsFalse(true);
        vm.expectRevert(SyncNetProjectHomeSink.TreasuryTransferFailed.selector);
        sink.settle();
        assertEq(sync.balanceOf(address(sink)), 1000, "balance untouched");
    }

    function test_settle_reentryCannotDoubleCount() public {
        ReentrantSync evil = new ReentrantSync();
        SyncNetProjectHomeSink s = new SyncNetProjectHomeSink(address(evil), TREASURY);
        evil.setSink(address(s));
        evil.mint(address(s), 1000);
        s.settle();
        assertEq(s.totalSettled(), 1000, "settled once");
        assertEq(s.totalBurned() + s.totalTreasury(), 1000, "totals consistent");
        assertEq(evil.balanceOf(address(s)), 0, "empty");
    }

    // ------------------------------------------------------------------ no admin / rescue / upgrade / ETH paths
    function _callFails(bytes memory data) internal returns (bool) {
        (bool ok, ) = address(sink).call(data);
        return !ok;
    }

    function test_noAdminOrRescueSurface() public {
        pay(1000);
        bytes[] memory calls = new bytes[](16);
        calls[0] = abi.encodeWithSignature("owner()");
        calls[1] = abi.encodeWithSignature("admin()");
        calls[2] = abi.encodeWithSignature("transferOwnership(address)", STRANGER);
        calls[3] = abi.encodeWithSignature("renounceOwnership()");
        calls[4] = abi.encodeWithSignature("setTreasury(address)", STRANGER);
        calls[5] = abi.encodeWithSignature("setToken(address)", STRANGER);
        calls[6] = abi.encodeWithSignature("setSplit(uint256)", 0);
        calls[7] = abi.encodeWithSignature("rescueToken(address,uint256)", address(sync), 1000);
        calls[8] = abi.encodeWithSignature("rescue(address,address,uint256)", address(sync), STRANGER, 1000);
        calls[9] = abi.encodeWithSignature("withdraw()");
        calls[10] = abi.encodeWithSignature("withdraw(uint256)", 1);
        calls[11] = abi.encodeWithSignature("upgradeTo(address)", STRANGER);
        calls[12] = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", STRANGER, "");
        calls[13] = abi.encodeWithSignature("execute(address,bytes)", address(sync), "");
        calls[14] = abi.encodeWithSignature("approve(address,uint256)", STRANGER, 1000);
        calls[15] = abi.encodeWithSignature("settle(address)", STRANGER);
        for (uint256 i = 0; i < calls.length; i++) {
            if (i == 15) continue; // settle(address) has a different selector: covered below
            vm.prank(STRANGER);
            assertTrue(_callFails(calls[i]), "admin-like call must not exist");
        }
        vm.prank(STRANGER);
        assertTrue(_callFails(calls[15]), "no parameterised settle");
        assertEq(sync.balanceOf(address(sink)), 1000, "nothing moved");
        assertEq(sync.allowance(address(sink), STRANGER), 0, "no approvals ever granted");
    }

    function test_noPayableReceiveOrFallback() public {
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        (bool ok1, ) = address(sink).call{value: 1 wei}("");
        assertTrue(!ok1, "plain ETH transfer rejected");
        vm.prank(STRANGER);
        (bool ok2, ) = address(sink).call{value: 1 wei}(abi.encodeWithSignature("settle()"));
        assertTrue(!ok2, "settle is not payable");
        vm.prank(STRANGER);
        (bool ok3, ) = address(sink).call(hex"deadbeef");
        assertTrue(!ok3, "no fallback");
        assertEq(address(sink).balance, 0, "no ETH held");
    }

    function test_immutablesLiveInCodeNotStorage() public view {
        // Storage slots 0..2 are the three cumulative totals; token/treasury are code-embedded immutables,
        // so no storage write can ever change them.
        for (uint256 slot = 0; slot < 8; slot++) {
            bytes32 v = vm.load(address(sink), bytes32(slot));
            assertTrue(v == bytes32(0), "fresh sink has no non-zero storage (immutables are not in storage)");
        }
    }

    function test_treasuryAndTokenUnchangedAfterActivity() public {
        pay(12345);
        vm.prank(STRANGER);
        sink.settle();
        assertEq(address(sink.SYNC()), address(sync), "token unchanged");
        assertEq(sink.TREASURY(), TREASURY, "treasury unchanged");
        assertEq(sink.BURN_PERCENT(), 60, "split unchanged");
    }
}
