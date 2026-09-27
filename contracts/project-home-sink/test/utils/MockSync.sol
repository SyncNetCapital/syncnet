// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Behaves like the canonical $SYNC (plain ERC-20 + ERC20Burnable, 18 decimals, transfer to zero reverts,
///      no tax, no hooks). Failure switches exist only to test the sink's error handling.
contract MockSync {
    string public constant name = "SyncNet";
    string public constant symbol = "SYNC";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public burnReverts;
    bool public transferReverts;
    bool public transferReturnsFalse;
    uint256 public burnCalls;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function setBurnReverts(bool v) external { burnReverts = v; }
    function setTransferReverts(bool v) external { transferReverts = v; }
    function setTransferReturnsFalse(bool v) external { transferReturnsFalse = v; }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (transferReverts) revert("MockSync: transfer reverts");
        if (transferReturnsFalse) return false;
        _move(msg.sender, to, amount);
        return true;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ERC20InsufficientAllowance");
        allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }
    function burn(uint256 amount) external {
        if (burnReverts) revert("MockSync: burn reverts");
        burnCalls++;
        require(balanceOf[msg.sender] >= amount, "ERC20InsufficientBalance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }
    function _move(address from, address to, uint256 amount) internal {
        require(to != address(0), "ERC20InvalidReceiver");
        require(balanceOf[from] >= amount, "ERC20InsufficientBalance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev A hostile token that tries to re-enter settle() from transfer(), to show re-entry cannot double-count.
contract ReentrantSync {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    address public sink;
    bool internal entered;

    function setSink(address s) external { sink = s; }
    function mint(address to, uint256 amount) external { totalSupply += amount; balanceOf[to] += amount; }
    function burn(uint256 amount) external { balanceOf[msg.sender] -= amount; totalSupply -= amount; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (!entered && sink != address(0)) {
            entered = true;
            (bool ok, ) = sink.call(abi.encodeWithSignature("settle()"));
            ok; // result ignored: the point is the accounting afterwards
        }
        return true;
    }
}
