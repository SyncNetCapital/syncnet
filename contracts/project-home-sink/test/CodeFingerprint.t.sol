// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {MockSync} from "./utils/MockSync.sol";
import {MockUsdg, MockParFactory, MockParRouter} from "./utils/MockPar.sol";
import {SyncNetProjectHomeSink} from "../src/SyncNetProjectHomeSink.sol";
import {SyncNetProjectHomeTreasuryConverter, PoolKey} from "../src/SyncNetProjectHomeTreasuryConverter.sol";

/// @notice Proves the server's immutable-aware code identity check against code produced by the REAL constructors:
///         deployed runtime with every immutable range zeroed hashes to the fingerprint pinned in
///         syncnet-project-home-deployment.json (the static audit asserts these constants equal that file), and the
///         immutable words sit exactly at the pinned offsets. Any source/compiler change breaks this test.
contract CodeFingerprintTest is TestBase {
    uint256 internal constant SINK_LENGTH = 1778;
    bytes32 internal constant SINK_FINGERPRINT = 0x1c47a73e49c4b108b38d9bef6be50afbdc9bbf2bbace210b545111458f2bde2b;
    uint256 internal constant CONVERTER_LENGTH = 5803;
    bytes32 internal constant CONVERTER_FINGERPRINT = 0x4a08834b625063e43d4df726ac525e44bd70b9e3ad15c7d01da848a02ca68944;
    address internal constant TREASURY = address(0x7EA5);

    function sinkOffsets() internal pure returns (uint256[5] memory sync_, uint256[2] memory conv_) {
        sync_ = [uint256(380), 487, 750, 977, 1373];
        conv_ = [uint256(234), 930];
    }

    function wordAt(bytes memory code, uint256 at) internal pure returns (bytes32 w) {
        assembly { w := mload(add(add(code, 32), at)) }
    }

    function zeroAt(bytes memory code, uint256 at) internal pure {
        assembly { mstore(add(add(code, 32), at), 0) }
    }

    function test_sinkRuntimeMatchesPinnedFingerprint() public {
        MockSync sync = new MockSync();
        address converter = address(0xC0417E27);
        SyncNetProjectHomeSink sink = new SyncNetProjectHomeSink(address(sync), converter);
        bytes memory code = address(sink).code;
        assertEq(code.length, SINK_LENGTH, "sink runtime length");
        (uint256[5] memory s, uint256[2] memory c) = sinkOffsets();
        for (uint256 i = 0; i < s.length; i++) {
            assertTrue(wordAt(code, s[i]) == bytes32(uint256(uint160(address(sync)))), "SYNC immutable at pinned offset");
            zeroAt(code, s[i]);
        }
        for (uint256 i = 0; i < c.length; i++) {
            assertTrue(wordAt(code, c[i]) == bytes32(uint256(uint160(converter))), "TREASURY_CONVERTER immutable at pinned offset");
            zeroAt(code, c[i]);
        }
        assertTrue(keccak256(code) == SINK_FINGERPRINT, "sink normalised runtime == pinned fingerprint");
    }

    function test_converterRuntimeMatchesPinnedFingerprint() public {
        MockSync sync = new MockSync();
        MockUsdg usdg = new MockUsdg();
        MockParFactory factory = new MockParFactory();
        factory.push(PoolKey({currency0: address(sync), currency1: address(0xCA9C), fee: 20000, tickSpacing: 10, hooks: address(0)}));
        factory.push(PoolKey({currency0: address(usdg), currency1: address(sync), fee: 20000, tickSpacing: 10, hooks: address(0)}));
        MockParRouter router = new MockParRouter(address(factory), address(sync), address(usdg));
        SyncNetProjectHomeTreasuryConverter conv = new SyncNetProjectHomeTreasuryConverter(address(sync), address(usdg), TREASURY, address(router), 1);
        bytes memory code = address(conv).code;
        assertEq(code.length, CONVERTER_LENGTH, "converter runtime length");
        uint256[4] memory market = [uint256(478), 1847, 3954, 4047];
        uint256[5] memory routerAt = [uint256(275), 1544, 2148, 2343, 3601];
        uint256[10] memory syncAt = [uint256(439), 586, 1115, 1594, 2193, 2389, 2597, 3801, 4110, 4378];
        uint256[3] memory treasuryAt = [uint256(194), 808, 3298];
        uint256[7] memory usdgAt = [uint256(314), 1357, 2805, 3040, 3345, 4199, 4289];
        for (uint256 i = 0; i < 4; i++) { assertTrue(wordAt(code, market[i]) == bytes32(uint256(1)), "MARKET"); zeroAt(code, market[i]); }
        for (uint256 i = 0; i < 5; i++) { assertTrue(wordAt(code, routerAt[i]) == bytes32(uint256(uint160(address(router)))), "ROUTER"); zeroAt(code, routerAt[i]); }
        for (uint256 i = 0; i < 10; i++) { assertTrue(wordAt(code, syncAt[i]) == bytes32(uint256(uint160(address(sync)))), "SYNC"); zeroAt(code, syncAt[i]); }
        for (uint256 i = 0; i < 3; i++) { assertTrue(wordAt(code, treasuryAt[i]) == bytes32(uint256(uint160(TREASURY))), "TREASURY"); zeroAt(code, treasuryAt[i]); }
        for (uint256 i = 0; i < 7; i++) { assertTrue(wordAt(code, usdgAt[i]) == bytes32(uint256(uint160(address(usdg)))), "USDG"); zeroAt(code, usdgAt[i]); }
        assertTrue(keccak256(code) == CONVERTER_FINGERPRINT, "converter normalised runtime == pinned fingerprint");
    }
}
