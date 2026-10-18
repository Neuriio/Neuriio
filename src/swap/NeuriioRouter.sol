// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {NeuriioRegistry} from "../launch/NeuriioRegistry.sol";
import {ISwapFactory, ISwapPair} from "./interfaces.sol";

/// What the router uses of a NeuriioPad (every version has these).
interface ICurvePad {
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        external
        returns (uint256 quoteOut);
    function previewBuy(address token, uint256 quoteIn)
        external
        view
        returns (uint256 tokensOut, uint256 spent, uint256 fee);
    function previewSell(address token, uint256 tokensIn) external view returns (uint256 quoteOut, uint256 fee);
}

/// @notice The one door for every trade the Neuriio app makes, in USDC: on a token's bonding curve before graduation
/// (through the token's own NeuriioPad, so its fee, slippage and pause rules apply), in its pool after. It records who
/// traded (the pad and the pair only see the router), charges nothing itself and never holds funds between calls.
contract NeuriioRouter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant POOL_FEE_BPS = 100; // the pair's 1% (src/swap/v2/UniswapV2Pair.sol)
    NeuriioRegistry public immutable registry;
    ISwapFactory public immutable factory;
    IERC20 public immutable quote; // USDC, every pool's quote token
    event CurveTraded(
        address indexed token, address indexed trader, bool isBuy, uint256 quoteAmount, uint256 tokenAmount
    );
    /// Pool trades: who traded (the pair's Swap event only sees the router); `quoteAmount` is USDC in or out.
    event Swapped(
        address indexed token, address indexed trader, address to, bool isBuy, uint256 quoteAmount, uint256 tokenAmount
    );
    error Expired();
    error ZeroAmount();
    error Slippage(uint256 out, uint256 minOut);
    error UnknownToken(address token);

    constructor(NeuriioRegistry registry_, ISwapFactory factory_) {
        registry = registry_;
        factory = factory_;
        quote = IERC20(factory_.quote());
    }

    // ------------------------------------------------------------------ trades

    /// @notice Buy `token` with up to `quoteIn` USDC (needs an approval of this router): on its curve before graduation
    /// (if this sells the curve out, only what's needed is used, the rest comes back, and the token graduates), in its
    /// pool after.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (quoteIn == 0) revert ZeroAmount();
        ISwapPair pair = _pairOf(token);
        if (address(pair) == address(0)) {
            ICurvePad pad = _padOf(token);
            quote.safeTransferFrom(msg.sender, address(this), quoteIn);
            _allow(quote, address(pad), quoteIn);
            uint256 before = quote.balanceOf(address(this));
            tokensOut = pad.buy(token, quoteIn, minTokensOut, deadline);
            uint256 spent = before - quote.balanceOf(address(this));
            emit CurveTraded(token, msg.sender, true, spent, tokensOut);
            IERC20(token).safeTransfer(msg.sender, tokensOut);
            if (quoteIn > spent) quote.safeTransfer(msg.sender, quoteIn - spent);
        } else {
            (uint256 rQuote, uint256 rToken) = _reserves(pair);
            tokensOut = getAmountOut(quoteIn, rQuote, rToken);
            if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);
            quote.safeTransferFrom(msg.sender, address(pair), quoteIn);
            _swapOut(pair, token, tokensOut, msg.sender);
            emit Swapped(token, msg.sender, msg.sender, true, quoteIn, tokensOut);
        }
    }

    /// @notice Sell `tokensIn` of `token` for USDC (needs an approval of this router), on its curve or in its pool.
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        ISwapPair pair = _pairOf(token);
        if (address(pair) == address(0)) {
            ICurvePad pad = _padOf(token);
            IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
            _allow(IERC20(token), address(pad), tokensIn);
            quoteOut = pad.sell(token, tokensIn, minQuoteOut, deadline);
            emit CurveTraded(token, msg.sender, false, quoteOut, tokensIn);
            quote.safeTransfer(msg.sender, quoteOut);
        } else {
            (uint256 rQuote, uint256 rToken) = _reserves(pair);
            IERC20(token).safeTransferFrom(msg.sender, address(pair), tokensIn);
            uint256 received = IERC20(token).balanceOf(address(pair)) - rToken; // what the pool actually got
            quoteOut = getAmountOut(received, rToken, rQuote);
            if (quoteOut < minQuoteOut) revert Slippage(quoteOut, minQuoteOut);
            _swapOut(pair, address(quote), quoteOut, msg.sender);
            emit Swapped(token, msg.sender, msg.sender, false, quoteOut, received);
        }
    }

    // ------------------------------------------------------------------ views

    /// @notice Tokens out for up to `quoteIn` USDC where `token` trades now, and the USDC that would actually be spent
    /// (less than `quoteIn` only when it would sell out the curve).
    function quoteBuy(address token, uint256 quoteIn) external view returns (uint256 tokensOut, uint256 spent) {
        ISwapPair pair = _pairOf(token);
        if (address(pair) == address(0)) {
            (tokensOut, spent,) = _padOf(token).previewBuy(token, quoteIn);
        } else {
            (uint256 rQuote, uint256 rToken) = _reserves(pair);
            (tokensOut, spent) = (getAmountOut(quoteIn, rQuote, rToken), quoteIn);
        }
    }

    /// @notice USDC out for `tokensIn` where `token` trades now.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256 quoteOut) {
        ISwapPair pair = _pairOf(token);
        if (address(pair) == address(0)) {
            (quoteOut,) = _padOf(token).previewSell(token, tokensIn);
        } else {
            (uint256 rQuote, uint256 rToken) = _reserves(pair);
            quoteOut = getAmountOut(tokensIn, rToken, rQuote);
        }
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        uint256 inWithFee = amountIn * (10_000 - POOL_FEE_BPS);
        return inWithFee * reserveOut / (reserveIn * 10_000 + inWithFee);
    }

    /// The router never holds funds between calls, so a standing approval to a NeuriioPad (only ever pulling from the
    /// router, during a trade the router started) is safe and saves an approval per trade.
    function _allow(IERC20 t, address spender, uint256 amount) internal {
        if (t.allowance(address(this), spender) < amount) t.forceApprove(spender, type(uint256).max);
    }

    function _pairOf(address token) internal view returns (ISwapPair) {
        return ISwapPair(factory.getPair(token, address(quote)));
    }

    function _padOf(address token) internal view returns (ICurvePad pad) {
        pad = ICurvePad(registry.launchpadOf(token));
        if (address(pad) == address(0)) revert UnknownToken(token);
    }

    function _reserves(ISwapPair pair) internal view returns (uint256 rQuote, uint256 rToken) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rQuote, rToken) = pair.token0() == address(quote) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _swapOut(ISwapPair pair, address tokenOut, uint256 amountOut, address to) internal {
        (uint256 a0, uint256 a1) = pair.token0() == tokenOut ? (amountOut, uint256(0)) : (uint256(0), amountOut);
        pair.swap(a0, a1, to, "");
    }
}
