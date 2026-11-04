// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Stands in for Ascend in the fee router's tests (keeper/test/fees.test.mjs): a trade emits a Uniswap v4 Swap and pays its
/// fee in USDC to the fee wallet, in the same transaction.
contract MockAscendPool {
    event Swap(
        bytes32 indexed id,
        address indexed sender,
        int128 amount0,
        int128 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick,
        uint24 fee
    );

    function trade(bytes32[] calldata pools, uint256[] calldata fees, IERC20 usdc, address feeWallet) external {
        for (uint256 i; i < pools.length; ++i) {
            emit Swap(pools[i], msg.sender, 1, -1, 1, 1, 0, 0);
            if (i < fees.length) usdc.transferFrom(msg.sender, feeWallet, fees[i]);
        }
    }
}
