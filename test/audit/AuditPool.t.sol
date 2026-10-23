// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioBase, IPair} from "../Base.t.sol";

/// Calls a pair's `swap` directly with any outputs and, in the flash-swap callback, pays back any USDC and tokens.
contract AuditPoolTrader {
    IERC20 usdc;
    IERC20 token;
    uint256 payUsdc;
    uint256 payTokens;

    function swap(
        IPair pair,
        IERC20 usdc_,
        IERC20 token_,
        uint256 usdcOut,
        uint256 tokensOut,
        uint256 usdcIn,
        uint256 tokensIn
    ) external {
        (usdc, token, payUsdc, payTokens) = (usdc_, token_, usdcIn, tokensIn);
        (uint256 a0, uint256 a1) = pair.token0() == address(usdc_) ? (usdcOut, tokensOut) : (tokensOut, usdcOut);
        pair.swap(a0, a1, address(this), hex"01");
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        if (payUsdc > 0) usdc.transfer(msg.sender, payUsdc);
        if (payTokens > 0) token.transfer(msg.sender, payTokens);
    }
}

/// The pair's Neuriio fee code (`_feeAndK`, `_sellFee`, `_checkK`, `_takeFee`), called directly.
contract AuditPoolTest is NeuriioBase {
    address token;
    IPair pair;
    AuditPoolTrader trader;

    function setUp() public override {
        super.setUp();
        token = _graduated(alice);
        pair = _pairOf(token);
        trader = new AuditPoolTrader();
        usdc.mint(address(trader), 10_000_000e6);
        uint256 held = IERC20(token).balanceOf(alice);
        vm.prank(alice);
        IERC20(token).transfer(address(trader), held);
    }

    function _reserves() internal view returns (uint256 rq, uint256 rt) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rq, rt) = pair.token0() == address(usdc) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /// A token flash swap (borrow tokens, repay tokens) should pay 1% of the tokens repaid, as USDC. Taking out 1 base
    /// unit of USDC with it switches the K check to the sell formula, which charges nothing on the tokens: the borrower
    /// repays almost exactly what they borrowed and the fee vault gets 1 base unit instead of ~1%.
    function test_Audit_dustUsdcOutSkipsTheTokenFlashFee() public {
        (uint256 rq, uint256 rt) = _reserves();
        uint256 borrow = rt / 2; // half the pool's tokens
        uint256 kBefore = rq * rt;

        // the intended path: repaying the loan plus 0.5% isn't enough (1% is due)
        vm.expectRevert(bytes("UniswapV2: K"));
        trader.swap(pair, usdc, IERC20(token), 0, borrow, 0, borrow + borrow / 200);

        // ...but add a 1-base-unit USDC withdrawal and a top-up of ~2 base units' worth of tokens is enough
        uint256 topUp = 2 * rt / (rq - 2) + 1;
        uint256 feesBefore = vault.totalFees();
        trader.swap(pair, usdc, IERC20(token), 1, borrow, 0, borrow + topUp);
        uint256 feePaid = vault.totalFees() - feesBefore;

        (uint256 rq2, uint256 rt2) = _reserves();
        assertGe(rq2 * rt2, kBefore, "K still holds");
        assertEq(feePaid, 1, "1 base unit of fee");
        // what the token-side fee would have been: 1% of the tokens repaid, at the pool's price
        uint256 intended = ((borrow + topUp) / 100) * rq / rt;
        emit log_named_decimal_uint("borrowed (tokens)", borrow, 18);
        emit log_named_decimal_uint("fee due on the token path (USDC)", intended, 6);
        emit log_named_decimal_uint("fee paid with 1 base unit of USDC out (USDC)", feePaid, 6);
        assertGt(intended, 60e6);
        assertLt(topUp, 1e17); // < 0.1 token extra repaid on a 103M-token loan
    }

    /// The same flash swap without the dust withdrawal pays the intended ~1%.
    function test_Audit_tokenFlashPaysOnePercentWithoutTheDust() public {
        (uint256 rq, uint256 rt) = _reserves();
        uint256 borrow = rt / 2;
        uint256 repay = borrow * 10_000 / 9_900 + 1e18;
        uint256 feesBefore = vault.totalFees();
        trader.swap(pair, usdc, IERC20(token), 0, borrow, 0, repay);
        uint256 feePaid = vault.totalFees() - feesBefore;
        assertApproxEqRel(feePaid, (repay / 100) * rq / (rt - borrow + repay), 0.001e18);
        assertGt(feePaid, 60e6);
    }

    /// Random direct swaps of every shape (USDC and/or tokens out, USDC and/or tokens paid back in the callback):
    /// whenever the pair accepts one, K doesn't drop and the vault gets exactly the intended fee.
    function testFuzz_Audit_directSwapsKeepKAndChargeTheFormula(
        uint256 usdcOut,
        uint256 tokensOut,
        uint256 usdcIn,
        uint256 tokensIn
    ) public {
        (uint256 rq, uint256 rt) = _reserves();
        usdcOut = _maybe(usdcOut, rq - 1);
        tokensOut = _maybe(tokensOut, rt - 1);
        usdcIn = _maybe(usdcIn, 5_000_000e6);
        tokensIn = _maybe(tokensIn, IERC20(token).balanceOf(address(trader)));
        vm.assume(usdcOut > 0 || tokensOut > 0);
        uint256 feesBefore = vault.totalFees();
        bool accepted;
        try trader.swap(pair, usdc, IERC20(token), usdcOut, tokensOut, usdcIn, tokensIn) {
            accepted = true;
        } catch {}
        vm.assume(accepted); // only swaps the pair accepts count (the run fails if too few are)
        (uint256 rq2, uint256 rt2) = _reserves();
        assertGe(rq2 * rt2, rq * rt, "K dropped");
        // the formula of _feeAndK / _takeFee, with balances after the trader's flows
        uint256 y = rq - usdcOut + usdcIn;
        uint256 x = rt - tokensOut + tokensIn;
        uint256 sellFee = tokensIn > 0 && usdcOut > 0 ? (usdcOut + 98) / 99 : 0;
        uint256 fee = usdcIn / 100;
        fee += sellFee > 0 ? sellFee : (tokensIn / 100) * (y - fee) / x;
        assertEq(vault.totalFees() - feesBefore, fee, "fee");
    }

    /// 0 half the time (so every shape of swap shows up), otherwise anything up to `max`.
    function _maybe(uint256 v, uint256 max) internal pure returns (uint256) {
        if (v % 2 == 0) return 0;
        return bound(v >> 1, 1, max);
    }
}
