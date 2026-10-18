// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {NeuriioPad} from "../src/launch/NeuriioPad.sol";
import {NeuriioRouter} from "../src/swap/NeuriioRouter.sol";
import {NeuriioBase} from "./Base.t.sol";

/// NeuriioRouter: one door for curve and pool trades in USDC that records who traded.
contract NeuriioRouterTest is NeuriioBase {
    function test_curveBuyAndSellThroughTheRouter() public {
        address token = _launch();
        (uint256 q, uint256 spent) = trade.quoteBuy(token, 100e6);
        (uint256 p,,) = pad.previewBuy(token, 100e6);
        assertEq(q, p);
        assertEq(spent, 100e6);

        vm.expectEmit(address(trade));
        emit NeuriioRouter.CurveTraded(token, alice, true, 100e6, q);
        uint256 out = _tradeBuy(alice, token, 100e6);
        assertEq(out, q);
        assertEq(IERC20(token).balanceOf(alice), out);
        assertEq(IERC20(token).balanceOf(address(trade)), 0);

        uint256 qs = trade.quoteSell(token, out);
        uint256 before = usdc.balanceOf(alice);
        uint256 back = _tradeSell(alice, token, out);
        assertEq(back, qs);
        assertEq(usdc.balanceOf(alice) - before, back);
        assertEq(usdc.balanceOf(address(trade)), 0);
    }

    /// The buy that sells out the curve: only what's needed is taken and the token graduates.
    function test_graduatingBuyTakesOnlyWhatsNeeded() public {
        address token = _launch();
        uint256 need = pad.quoteToGraduate(token);
        (, uint256 spent) = trade.quoteBuy(token, need + 500e6);
        assertEq(spent, need);
        uint256 before = usdc.balanceOf(alice);
        uint256 out = _tradeBuy(alice, token, need + 500e6);
        assertTrue(_curve(token).graduated);
        assertEq(before - usdc.balanceOf(alice), need, "the rest came back");
        assertEq(out, 793_100_000e18);
        assertEq(usdc.balanceOf(address(trade)), 0);
    }

    function test_poolBuyAndSellThroughTheRouter() public {
        address token = _graduated(bob);
        (uint256 q,) = trade.quoteBuy(token, 100e6);
        vm.expectEmit(address(trade));
        emit NeuriioRouter.Swapped(token, alice, alice, true, 100e6, q);
        uint256 out = _tradeBuy(alice, token, 100e6);
        assertEq(out, q);

        uint256 qs = trade.quoteSell(token, out);
        uint256 before = usdc.balanceOf(alice);
        uint256 back = _tradeSell(alice, token, out);
        assertEq(back, qs);
        assertEq(usdc.balanceOf(alice) - before, back);
        assertApproxEqRel(back, 98.01e6, 1e14); // 1% fee each way
        assertEq(usdc.balanceOf(address(trade)), 0);
    }

    function test_revert_slippageDeadlineZeroAndUnknown() public {
        address token = _launch();
        (uint256 q,) = trade.quoteBuy(token, 100e6);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPad.Slippage.selector, q, q + 1));
        trade.buy(token, 100e6, q + 1, block.timestamp);
        vm.expectRevert(NeuriioRouter.Expired.selector);
        trade.buy(token, 100e6, 0, block.timestamp - 1);
        vm.expectRevert(NeuriioRouter.ZeroAmount.selector);
        trade.buy(token, 0, 0, block.timestamp);
        vm.expectRevert(NeuriioRouter.ZeroAmount.selector);
        trade.sell(token, 0, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(NeuriioRouter.UnknownToken.selector, address(0xBEEF)));
        trade.buy(address(0xBEEF), 1e6, 0, block.timestamp);
        vm.stopPrank();

        address graduated = _graduated(bob);
        (q,) = trade.quoteBuy(graduated, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioRouter.Slippage.selector, q, q + 1));
        trade.buy(graduated, 100e6, q + 1, block.timestamp);
    }

    function test_pausedPadStillLetsYouSellThroughTheRouter() public {
        address token = _launch();
        uint256 got = _tradeBuy(alice, token, 100e6);
        vm.prank(owner);
        pad.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        trade.buy(token, 100e6, 0, block.timestamp);
        assertGt(_tradeSell(alice, token, got), 0);
    }

    function test_revert_nativeHypeIsRejected() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(trade).call{value: 1 ether}("");
        assertFalse(ok);
    }
}
