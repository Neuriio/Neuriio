// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapFactory, ISwapPair, IWHYPE} from "./interfaces.sol";

/// @notice Swaps graduated tokens against native HYPE (every pool is TOKEN/WHYPE; wrapping is handled here).
contract SwapRouter {
    using SafeERC20 for IERC20;

    uint256 internal constant FEE_BPS = 25; // SwapPair.FEE_BPS

    ISwapFactory public immutable factory;
    IWHYPE public immutable whype;

    /// Who traded (pair Swap events only see the router); `hypeAmount` is HYPE in (buy) or out (sell).
    event Swapped(
        address indexed token,
        address indexed trader,
        address to,
        bool isBuy,
        uint256 hypeAmount,
        uint256 tokenAmount
    );

    error Expired();
    error NoPool(address token);
    error ZeroAmount();
    error Slippage(uint256 out, uint256 minOut);
    error HypeTransferFailed();
    error OnlyWhype();

    constructor(ISwapFactory factory_, IWHYPE whype_) {
        factory = factory_;
        whype = whype_;
    }

    receive() external payable {
        if (msg.sender != address(whype)) revert OnlyWhype();
    }

    // ------------------------------------------------------------------ quotes

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        uint256 inWithFee = amountIn * (10_000 - FEE_BPS);
        return inWithFee * reserveOut / (reserveIn * 10_000 + inWithFee);
    }

    /// @notice Tokens out for `hypeIn` HYPE.
    function quoteBuy(address token, uint256 hypeIn) external view returns (uint256 tokensOut) {
        (, uint256 rHype, uint256 rToken) = _pool(token);
        return getAmountOut(hypeIn, rHype, rToken);
    }

    /// @notice HYPE out for `tokensIn` tokens.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 hypeOut) {
        (, uint256 rHype, uint256 rToken) = _pool(token);
        return getAmountOut(tokensIn, rToken, rHype);
    }

    // ------------------------------------------------------------------ swaps

    function buy(address token, uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroAmount();
        (ISwapPair pair, uint256 rHype, uint256 rToken) = _pool(token);
        tokensOut = getAmountOut(msg.value, rHype, rToken);
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);
        whype.deposit{value: msg.value}();
        IERC20(address(whype)).safeTransfer(address(pair), msg.value);
        _swapOut(pair, token, tokensOut, to);
        emit Swapped(token, msg.sender, to, true, msg.value, tokensOut);
    }

    function sell(address token, uint256 tokensIn, uint256 minHypeOut, address to, uint256 deadline)
        external
        returns (uint256 hypeOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        (ISwapPair pair, uint256 rHype, uint256 rToken) = _pool(token);
        IERC20(token).safeTransferFrom(msg.sender, address(pair), tokensIn);
        uint256 received = IERC20(token).balanceOf(address(pair)) - rToken; // what the pool actually got
        hypeOut = getAmountOut(received, rToken, rHype);
        if (hypeOut < minHypeOut) revert Slippage(hypeOut, minHypeOut);
        _swapOut(pair, address(whype), hypeOut, address(this));
        whype.withdraw(hypeOut);
        emit Swapped(token, msg.sender, to, false, hypeOut, received);
        (bool ok,) = to.call{value: hypeOut}("");
        if (!ok) revert HypeTransferFailed();
    }

    // ------------------------------------------------------------------ internals

    function _pool(address token) internal view returns (ISwapPair pair, uint256 rHype, uint256 rToken) {
        pair = ISwapPair(factory.getPair(token, address(whype)));
        if (address(pair) == address(0)) revert NoPool(token);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rHype, rToken) = pair.token0() == address(whype) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _swapOut(ISwapPair pair, address tokenOut, uint256 amountOut, address to) internal {
        (uint256 a0, uint256 a1) = pair.token0() == tokenOut ? (amountOut, uint256(0)) : (uint256(0), amountOut);
        pair.swap(a0, a1, to, "");
    }
}
