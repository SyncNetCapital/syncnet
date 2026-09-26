// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {DeployChecks} from "../script/DeployChecks.sol";

/// @dev External wrapper so reverts from the internal library can be asserted with expectRevert.
contract DeployChecksHarness {
    function check(uint256 a, uint256 d, address s, address t, address c, address dep) external pure {
        DeployChecks.check(a, d, s, t, c, dep);
    }
}

contract DeployChecksTest is TestBase {
    address internal constant SYNC = 0x6368e007B9F0B941560eD1f3bceb20247F5Eca37;
    address internal constant FIXTURE_TREASURY = address(0x7EA5); // fixture only
    address internal constant DEPLOYER = address(0xDE9);
    DeployChecksHarness internal h;

    function setUp() public { h = new DeployChecksHarness(); }

    function test_acceptsExactConfiguration() public view {
        h.check(4663, 4663, SYNC, FIXTURE_TREASURY, FIXTURE_TREASURY, DEPLOYER);
    }
    function test_rejectsWrongChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.WrongChain.selector, uint256(1)));
        h.check(1, 4663, SYNC, FIXTURE_TREASURY, FIXTURE_TREASURY, DEPLOYER);
    }
    function test_rejectsWrongDeclaredChain() public {
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.ChainIdEnvMismatch.selector, uint256(46630)));
        h.check(4663, 46630, SYNC, FIXTURE_TREASURY, FIXTURE_TREASURY, DEPLOYER);
    }
    function test_rejectsNonCanonicalSync() public {
        address fake = address(0x9999999999999999999999999999999999999999);
        vm.expectRevert(abi.encodeWithSelector(DeployChecks.NotCanonicalSync.selector, fake));
        h.check(4663, 4663, fake, FIXTURE_TREASURY, FIXTURE_TREASURY, DEPLOYER);
    }
    function test_rejectsZeroTreasury() public {
        vm.expectRevert(DeployChecks.TreasuryMissing.selector);
        h.check(4663, 4663, SYNC, address(0), address(0), DEPLOYER);
    }
    function test_rejectsUnconfirmedTreasury() public {
        vm.expectRevert(DeployChecks.TreasuryNotConfirmed.selector);
        h.check(4663, 4663, SYNC, FIXTURE_TREASURY, address(0x7EA6), DEPLOYER);
    }
    function test_rejectsDeployerAsTreasury() public {
        vm.expectRevert(DeployChecks.TreasuryIsDeployer.selector);
        h.check(4663, 4663, SYNC, DEPLOYER, DEPLOYER, DEPLOYER);
    }
    function test_rejectsTokenAsTreasury() public {
        vm.expectRevert(DeployChecks.TreasuryIsToken.selector);
        h.check(4663, 4663, SYNC, SYNC, SYNC, DEPLOYER);
    }
}
