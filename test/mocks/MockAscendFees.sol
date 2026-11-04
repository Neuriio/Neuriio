// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Stands in for Ascend V5's fee path in the fee router's tests (keeper/test/fees.test.mjs): it plays both the EscrowFactory
/// (`escrowOf`) and the launchpad (`accruedFees`). A trade leaves the builder's share of its fee waiting at the launchpad;
/// the pool's escrow `settle()`s it in and `claimBuilder()` pays it to the builder with BuilderPaid, as on Ascend.
contract MockAscendFees {
    IERC20 public immutable usdc;
    mapping(bytes32 poolId => address) public escrowOf;
    mapping(bytes32 poolId => uint256) public accruedFees;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    function register(bytes32 poolId, address builder) external returns (address escrow) {
        escrow = address(new MockCreatorEscrow(usdc, this, poolId, builder));
        escrowOf[poolId] = escrow;
    }

    /// A trade whose fee includes `builderFee` USDC for the builder.
    function trade(bytes32 poolId, uint256 builderFee) external {
        usdc.transferFrom(msg.sender, address(this), builderFee);
        accruedFees[poolId] += builderFee;
    }

    function pull(bytes32 poolId) external returns (uint256 amount) {
        require(msg.sender == escrowOf[poolId], "not the escrow");
        amount = accruedFees[poolId];
        accruedFees[poolId] = 0;
        usdc.transfer(msg.sender, amount);
    }
}

contract MockCreatorEscrow {
    IERC20 public immutable usdc;
    MockAscendFees public immutable fees;
    bytes32 public immutable poolId;
    address public immutable builder;
    uint256 public builderOwed;

    event BuilderPaid(address indexed builder, uint256 amount);

    constructor(IERC20 usdc_, MockAscendFees fees_, bytes32 poolId_, address builder_) {
        usdc = usdc_;
        fees = fees_;
        poolId = poolId_;
        builder = builder_;
    }

    function settle() external {
        builderOwed += fees.pull(poolId);
    }

    function claimBuilder() external returns (uint256 amount) {
        amount = builderOwed;
        builderOwed = 0;
        usdc.transfer(builder, amount);
        emit BuilderPaid(builder, amount);
    }
}

/// An attacker's contract that emits a BuilderPaid naming our builder, with no money behind it (keeper/test/fees.test.mjs). It
/// can even claim a real pool's id: only Ascend's factory decides which escrow a pool has.
contract FakeBuilderPaid {
    bytes32 public poolId;

    event BuilderPaid(address indexed builder, uint256 amount);

    function fire(address builder, uint256 amount, bytes32 poolId_) external {
        poolId = poolId_;
        emit BuilderPaid(builder, amount);
    }
}
