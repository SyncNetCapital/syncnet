// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {DeployChecks} from "../script/DeployChecks.sol";

/// @dev External wrapper so reverts from the internal library can be asserted with expectRevert.
contract DeployChecksHarness {
    function check(DeployChecks.Config memory c) external pure { DeployChecks.check(c); }
}

contract DeployChecksTest is TestBase {
    address internal constant SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant ROUTER = 0x458D2a59c2F3dd32775a64eE72004561440d64Df;
    address internal constant FIXTURE_TREASURY = address(0x7EA5); // fixture only
    address internal constant DEPLOYER = address(0xDE9);
    DeployChecksHarness internal h;

    function setUp() public { h = new DeployChecksHarness(); }

    function good() internal pure returns (DeployChecks.Config memory) {
        return DeployChecks.Config(4663, 4663, SYNC, USDG, ROUTER, 1, FIXTURE_TREASURY, FIXTURE_TREASURY, DEPLOYER);
    }

    function test_acceptsExactConfiguration() public view { h.check(good()); }
    function test_rejectsWrongChain() public {
        DeployChecks.Config memory c = good(); c.actualChainId = 1;
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.WrongChain.selector, uint256(1)));
        h.check(c);
    }
    function test_rejectsWrongDeclaredChain() public {
        DeployChecks.Config memory c = good(); c.declaredChainId = 46630;
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.ChainIdEnvMismatch.selector, uint256(46630)));
        h.check(c);
    }
    function test_rejectsNonCanonicalSync() public {
        DeployChecks.Config memory c = good(); c.sync = address(0x9999);
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.NotCanonicalSync.selector, address(0x9999)));
        h.check(c);
    }
    function test_rejectsNonCanonicalUsdg() public {
        DeployChecks.Config memory c = good(); c.usdg = address(0x05D6);
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.NotCanonicalUsdg.selector, address(0x05D6)));
        h.check(c);
    }
    function test_rejectsNonCanonicalRouter() public {
        DeployChecks.Config memory c = good(); c.router = 0xCaf681a66D020601342297493863E78C959E5cb2; // SwapRouter02 is not the PAR route
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.NotCanonicalRouter.selector, c.router));
        h.check(c);
    }
    function test_rejectsWrongMarket() public {
        DeployChecks.Config memory c = good(); c.market = 0;
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.NotCanonicalMarket.selector, uint256(0)));
        h.check(c);
    }
    function test_rejectsZeroTreasury() public {
        DeployChecks.Config memory c = good(); c.treasury = address(0); c.treasuryConfirmation = address(0);
        vm.expectRevert(DeployChecks.TreasuryMissing.selector);
        h.check(c);
    }
    function test_rejectsUnconfirmedTreasury() public {
        DeployChecks.Config memory c = good(); c.treasuryConfirmation = address(0x7EA6);
        vm.expectRevert(DeployChecks.TreasuryNotConfirmed.selector);
        h.check(c);
    }
    function test_rejectsDeployerAsTreasury() public {
        DeployChecks.Config memory c = good(); c.treasury = DEPLOYER; c.treasuryConfirmation = DEPLOYER;
        vm.expectRevert(DeployChecks.TreasuryIsDeployer.selector);
        h.check(c);
    }
    function test_rejectsInfrastructureAsTreasury() public {
        address[3] memory bad = [SYNC, USDG, ROUTER];
        for (uint256 i = 0; i < 3; i++) {
            DeployChecks.Config memory c = good(); c.treasury = bad[i]; c.treasuryConfirmation = bad[i];
            vm.expectRevert(DeployChecks.TreasuryIsInfrastructure.selector);
            h.check(c);
        }
    }
}
