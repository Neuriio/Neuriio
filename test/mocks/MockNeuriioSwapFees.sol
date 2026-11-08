// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// For the fee router's partner tests (keeper/test/partner.test.mjs): emits NeuriioSwap's Bought / Sold events with a chosen
/// quote and fee, and names its fee wallet like NeuriioSwap does. No trading: the partner router pays from a float and only
/// reads these events.
contract MockNeuriioSwapFees {
    address public immutable feeWallet;

    event Bought(address indexed token, address indexed buyer, address to, address quote, uint256 amountIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, address to, address quote, uint256 tokensIn, uint256 amountOut, uint256 fee);

    constructor(address feeWallet_) {
        feeWallet = feeWallet_;
    }

    function buy(address token, address quote, uint256 fee) external {
        emit Bought(token, msg.sender, msg.sender, quote, fee * 200, fee, 1e18);
    }

    function sell(address token, address quote, uint256 fee) external {
        emit Sold(token, msg.sender, msg.sender, quote, 1e18, fee * 199, fee);
    }
}
