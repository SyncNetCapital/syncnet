// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey, Hop, Leg} from "../../src/SyncNetProjectHomeTreasuryConverter.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev 6-decimal USDG stand-in with failure switches.
contract MockUsdg {
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public transferReverts;
    bool public transferReturnsFalse;

    function mint(address to, uint256 amount) external { totalSupply += amount; balanceOf[to] += amount; }
    function setTransferReverts(bool v) external { transferReverts = v; }
    function setTransferReturnsFalse(bool v) external { transferReturnsFalse = v; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferReverts) revert("MockUsdg: transfer reverts");
        if (transferReturnsFalse) return false;
        require(balanceOf[msg.sender] >= amount, "MockUsdg: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev PairPadMultiLaunchFactory stand-in: poolKeysFor(token) returns configurable keys.
contract MockParFactory {
    PoolKey[] internal _keys;
    bool public reverts;
    function push(PoolKey memory k) external { _keys.push(k); }
    function setKey(uint256 i, PoolKey memory k) external { _keys[i] = k; }
    function setReverts(bool v) external { reverts = v; }
    function poolKeysFor(address) external view returns (PoolKey[] memory) {
        require(!reverts, "TokenNotFound");
        return _keys;
    }
}

/// @dev PairPadMultiRouter stand-in with the real sellToQuotes shape and semantics that matter to the converter:
///      it pulls only the CONSUMED input from the caller (transferFrom), pays the quote asset to `recipient`, and
///      reverts SlippageExceeded below the per-leg floor. Knobs: price, depth cap, forced revert, short payment.
contract MockParRouter {
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    address public immutable factory;
    address public immutable sync;
    address public immutable usdg;
    uint256 public usdgPerSync = 5e3; // 0.005 USDG (6 dp) per 1 SYNC (18 dp): out = in * 5e3 / 1e18
    uint256 public depthCap = type(uint256).max; // max SYNC the pool can absorb in one call
    bool public reverts;
    bool public payLess; // deliver less than the floor would require but skip the floor check (a broken router)
    address public lastRecipient;
    uint256 public calls;

    constructor(address factory_, address sync_, address usdg_) { factory = factory_; sync = sync_; usdg = usdg_; }
    function setPrice(uint256 p) external { usdgPerSync = p; }
    function setDepthCap(uint256 c) external { depthCap = c; }
    function setReverts(bool v) external { reverts = v; }
    function setPayLess(bool v) external { payLess = v; }

    function sellToQuotes(address token, Leg[] calldata legs, uint256[] calldata minOuts, address recipient) external {
        require(!reverts, "MockParRouter: pool reverted");
        require(token == sync && legs.length == 1 && minOuts.length == 1 && legs[0].hops.length == 0, "MockParRouter: bad call");
        calls++;
        lastRecipient = recipient;
        uint256 consumed = legs[0].amountIn < depthCap ? legs[0].amountIn : depthCap;
        uint256 out = (consumed * usdgPerSync) / 1e18;
        if (!payLess && out < minOuts[0]) revert SlippageExceeded(out, minOuts[0]);
        if (payLess) out = out / 2;
        require(IMintable(sync).transferFrom(msg.sender, address(this), consumed), "MockParRouter: pull");
        IMintable(usdg).mint(recipient, out);
    }
}

/// @dev A router that tries to re-enter convert() and to pull more than approved.
contract HostileRouter {
    address public immutable factory;
    address public immutable sync;
    address public target;
    constructor(address factory_, address sync_) { factory = factory_; sync = sync_; }
    function setTarget(address t) external { target = t; }
    function sellToQuotes(address, Leg[] calldata legs, uint256[] calldata, address) external {
        (bool ok, ) = target.call(abi.encodeWithSignature("convert(uint256,uint256,uint256)", uint256(1), uint256(1), type(uint256).max));
        require(!ok, "HostileRouter: re-entry succeeded");
        IMintable(sync).transferFrom(msg.sender, address(this), legs[0].amountIn + 1); // more than approved: must fail
    }
}
