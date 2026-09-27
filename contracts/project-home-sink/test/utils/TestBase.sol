// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Minimal subset of the Foundry cheatcode interface (no forge-std dependency).
interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function deal(address, uint256) external;
    function chainId(uint256) external;
    function assume(bool) external;
    function expectEmit(bool, bool, bool, bool) external;
    function load(address, bytes32) external view returns (bytes32);
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 a, uint256 b, string memory why) internal pure {
        if (a != b) revert(string.concat("assertEq(uint) failed: ", why));
    }
    function assertEq(address a, address b, string memory why) internal pure {
        if (a != b) revert(string.concat("assertEq(address) failed: ", why));
    }
    function assertTrue(bool c, string memory why) internal pure {
        if (!c) revert(string.concat("assertTrue failed: ", why));
    }
}
