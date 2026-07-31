// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Every mock here exists to attack ZeroHarvester in a specific documented way. A test suite of
///      only friendly targets proves nothing about a contract whose whole job is calling hostile code.

/// @notice Minimal ERC20 that returns a bool, like most tokens.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function transfer(address to, uint256 amt) external virtual returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        require(balanceOf[f] >= a, "bal");
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// @notice USDT-style token: transfer returns NOTHING. A naive sweep using the ERC20 interface
///         reverts on these; ZeroHarvester must handle them.
contract MockERC20NoReturn is MockERC20 {
    function transfer(address to, uint256 amt) external override returns (bool) {
        require(balanceOf[msg.sender] >= amt, "bal");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        assembly {
            return(0, 0) // returns no data at all
        }
    }
}

/// @notice A token whose transfer returns `false` instead of reverting. The sweep must treat this as
///         a failure, not silently continue.
contract MockERC20ReturnsFalse is MockERC20 {
    function transfer(address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @notice Stands in for a bounty (e.g. a Beefy strategy's harvest()): pays the caller when it has
///         something to pay, reverts when it does not — which is the normal case in production.
contract MockBounty {
    uint256 public payout;
    bool public dry;
    uint256 public harvestCount;

    constructor(uint256 payout_) payable {
        payout = payout_;
    }

    function setDry(bool d) external {
        dry = d;
    }

    receive() external payable {}

    /// @notice Pays msg.sender — the contract — so the sweep is what gets it to the beneficiary.
    function harvest() external {
        require(!dry, "nothing to harvest");
        harvestCount++;
        (bool ok,) = msg.sender.call{value: payout}("");
        require(ok, "pay");
    }

    /// @notice Pays a named recipient directly, the other real-world shape.
    function harvest(address recipient) external {
        require(!dry, "nothing to harvest");
        harvestCount++;
        (bool ok,) = recipient.call{value: payout}("");
        require(ok, "pay");
    }

    /// @notice Pays in ERC20 rather than ETH.
    function harvestToken(address token) external {
        require(!dry, "nothing to harvest");
        harvestCount++;
        MockERC20(token).mint(msg.sender, payout);
    }
}

/// @notice ATTACK: returns an enormous blob, trying to make the caller pay for memory expansion.
contract ReturnDataBomb {
    function boom() external pure {
        assembly {
            // Claim a ~256KB return buffer. A caller that copies return data eats the memory cost.
            return(0, 262144)
        }
    }
}

/// @notice ATTACK: burns every drop of forwarded gas, trying to leave the caller unable to finish.
contract GasBurner {
    uint256 public x;

    function burn() external {
        while (true) {
            x++;
        }
    }
}

/// @notice ATTACK: calls back into the harvester mid-batch to confuse profit accounting.
contract Reenterer {
    address public harvester;
    bytes public payload;
    bool public tried;
    bool public succeeded;

    function arm(address h, bytes calldata p) external {
        harvester = h;
        payload = p;
    }

    function poke() external {
        tried = true;
        (bool ok,) = harvester.call(payload);
        succeeded = ok;
    }
}

/// @notice ATTACK: a beneficiary that refuses ETH, to prove the sweep failure is loud, not silent.
contract RejectingBeneficiary {
    receive() external payable {
        revert("no");
    }
}

/// @notice A beneficiary that consumes far more than the 2300-gas stipend — proves the sweep uses
///         `call` and not `transfer`, or a real smart account would be locked out.
contract GreedyBeneficiary {
    uint256 public slot;
    uint256 public received;

    receive() external payable {
        // Cold SSTORE (~20k gas) — well past the 2300 stipend `transfer` would allow.
        slot = block.timestamp;
        received += msg.value;
    }
}
