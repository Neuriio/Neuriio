// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUsdcPool} from "../../src/interfaces/IUsdcPool.sol";

/// Fixed-price base -> USDC pool for bridge/account tests (stands in for the archived PropAMM).
contract MockUsdcPool is IUsdcPool {
    using SafeERC20 for IERC20;

    IERC20 public immutable base;
    IERC20 public immutable quote;
    uint256 public immutable quotePerBase; // quote units per 1e18 base units
    uint256 public baseReserve;

    error Slippage(uint256 out, uint256 minOut);

    constructor(IERC20 base_, IERC20 quote_, uint256 quotePerBase_) {
        base = base_;
        quote = quote_;
        quotePerBase = quotePerBase_;
    }

    function previewSellBase(uint256 baseIn) public view returns (uint256 quoteOut, uint256 priceWad) {
        return (baseIn * quotePerBase / 1e18, quotePerBase);
    }

    function sellBase(uint256 baseIn, uint256 minQuoteOut, address recipient, uint256)
        external
        returns (uint256 quoteOut)
    {
        (quoteOut,) = previewSellBase(baseIn);
        if (quoteOut < minQuoteOut) revert Slippage(quoteOut, minQuoteOut);
        base.safeTransferFrom(msg.sender, address(this), baseIn);
        baseReserve += baseIn;
        quote.safeTransfer(recipient, quoteOut);
    }
}
