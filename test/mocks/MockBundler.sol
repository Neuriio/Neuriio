// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// For the launch check's tests: stands in for a pool or a bundling contract, paying out a token it holds.
contract MockBundler {
    /// One transaction, tokens to several wallets.
    function payOut(IERC20 token, address[] calldata wallets, uint256 amount) external {
        for (uint256 i; i < wallets.length; ++i) {
            token.transfer(wallets[i], amount);
        }
    }
}
