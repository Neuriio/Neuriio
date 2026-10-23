// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioPad} from "../../src/launch/NeuriioPad.sol";
import {NeuriioBase} from "../Base.t.sol";

/// The money math at the edges of its settings: the curve at any allowed virtual reserve (1 USDC .. uint96 max) and
/// fee (0 .. 2%), and staking with stakes from 1 wei to 1B tokens and rewards up to 1B USDC.
contract AuditExtremesTest is NeuriioBase {
    uint256 constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 constant LP_SUPPLY = 206_900_000e18;

    /// A log-uniform pick in [lo, hi].
    function _logPick(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 bits = bound(seed % 97, 0, 96);
        uint256 v = bound(seed >> 8, 0, (uint256(1) << bits) - 1) + (uint256(1) << bits);
        return bound(v, lo, hi);
    }

    /// Random buys and sells, then everyone sells back or the curve graduates, at any virtual reserve and fee: no
    /// overflow, k never drops, the pad stays solvent, and a graduation always succeeds and opens the pool at the
    /// curve's final price.
    function testFuzz_Audit_curveAtAnySetting(uint256 vqSeed, uint16 fee, uint256[6] calldata steps, bool graduate)
        public
    {
        uint256 vq = _logPick(vqSeed, 1e6, type(uint96).max);
        vm.startPrank(owner);
        pad.setVirtualQuote(vq);
        pad.setFee(uint16(bound(fee, 0, 200)));
        vm.stopPrank();
        address token = _launch();
        usdc.mint(alice, vq * 4 + 1e6);
        usdc.mint(bob, vq * 4 + 1e6);
        uint256 kLast = vq * VIRTUAL_TOKENS;

        for (uint256 i; i < steps.length; ++i) {
            address who = i % 2 == 0 ? alice : bob;
            if (steps[i] % 3 != 0) {
                uint256 amount = bound(steps[i], 1, vq); // up to one virtual reserve per buy
                vm.startPrank(who);
                usdc.approve(address(pad), amount);
                try pad.buy(token, amount, 0, block.timestamp) {}
                catch (bytes memory err) {
                    assertEq(bytes4(err), NeuriioPad.ZeroAmount.selector);
                }
                vm.stopPrank();
            } else {
                uint256 amount = IERC20(token).balanceOf(who) * bound(steps[i], 1, 100) / 100;
                if (amount == 0) continue;
                vm.startPrank(who);
                IERC20(token).approve(address(pad), amount);
                try pad.sell(token, amount, 0, block.timestamp) {}
                catch (bytes memory err) {
                    assertEq(bytes4(err), NeuriioPad.ZeroAmount.selector);
                }
                vm.stopPrank();
            }
            NeuriioPad.Curve memory c = _curve(token);
            if (c.graduated) return _checkPoolOpensAtCurvePrice(token); // three buys can sell it out
            uint256 k = uint256(c.virtualQuote) * c.virtualToken;
            assertGe(k, kLast, "k dropped");
            kLast = k;
            assertGe(usdc.balanceOf(address(pad)), c.realQuote, "pad short of USDC");
            assertEq(IERC20(token).balanceOf(address(pad)), LP_SUPPLY + c.realToken, "pad tokens");
        }

        if (graduate) {
            uint256 cost = pad.quoteToGraduate(token);
            usdc.mint(alice, cost);
            vm.startPrank(alice);
            usdc.approve(address(pad), cost);
            pad.buy(token, cost, 0, block.timestamp);
            vm.stopPrank();
            _checkPoolOpensAtCurvePrice(token);
        } else {
            // everyone sells everything back: never refused for lack of USDC
            for (uint256 j; j < 2; ++j) {
                address who = j == 0 ? alice : bob;
                uint256 bal = IERC20(token).balanceOf(who);
                if (bal == 0) continue;
                vm.startPrank(who);
                IERC20(token).approve(address(pad), bal);
                try pad.sell(token, bal, 0, block.timestamp) {}
                catch (bytes memory err) {
                    assertEq(bytes4(err), NeuriioPad.ZeroAmount.selector);
                }
                vm.stopPrank();
            }
            assertGe(usdc.balanceOf(address(pad)), _curve(token).realQuote);
        }
    }

    /// Graduated: the pool holds LP_SUPPLY tokens and every USDC raised, at the curve's final price (within 0.01%).
    function _checkPoolOpensAtCurvePrice(address token) internal view {
        NeuriioPad.Curve memory c = _curve(token);
        assertTrue(c.graduated);
        (uint112 r0, uint112 r1,) = _pairOf(token).getReserves();
        (uint256 rq, uint256 rt) = _pairOf(token).token0() == address(usdc) ? (r0, r1) : (r1, r0);
        assertEq(rt, LP_SUPPLY);
        assertEq(rq, uint256(c.virtualQuote) - pad.virtualQuote(), "every USDC raised");
        // rq / rt vs virtualQuote / virtualToken, compared as cross-products (no rounding of the prices)
        assertApproxEqRel(rq * c.virtualToken, uint256(c.virtualQuote) * rt, 0.0001e18);
    }

    /// Two stakers from 1 wei to 1B tokens, rewards from 1 base unit to 1B USDC, random waits: no overflow, and the
    /// two claims never add up to more than was paid in (rounding favours the contract).
    function testFuzz_Audit_stakingAtTheEdges(uint256 aSeed, uint256 bSeed, uint256[4] calldata rewards, uint256 waits)
        public
    {
        address token = _graduated(alice);
        uint256 supply = IERC20(token).balanceOf(alice);
        uint256 a = _logPick(aSeed, 1, supply / 2);
        uint256 b = _logPick(bSeed, 1, supply / 2);
        vm.prank(alice);
        IERC20(token).transfer(bob, b);
        _stake(alice, token, a);
        _stake(bob, token, b);
        vm.warp(block.timestamp + 2 hours); // the graduation's own fees have dripped
        address[] memory pools = new address[](1);
        pools[0] = token;
        vm.prank(alice);
        try staking.claim(pools, alice) {} catch {}
        vm.prank(bob);
        try staking.claim(pools, bob) {} catch {}
        uint256 aliceStart = usdc.balanceOf(alice);
        uint256 bobStart = usdc.balanceOf(bob);

        uint256 paid;
        for (uint256 i; i < rewards.length; ++i) {
            uint256 r = _logPick(rewards[i], 1, 1_000_000_000e6);
            usdc.mint(address(this), r);
            usdc.approve(address(staking), r);
            staking.notifyReward(token, r);
            paid += r;
            vm.warp(block.timestamp + bound(waits >> (i * 16), 1, 3 hours));
        }
        vm.warp(block.timestamp + 10 hours); // everything has dripped
        vm.prank(alice);
        try staking.claim(pools, alice) {} catch {}
        vm.prank(bob);
        try staking.claim(pools, bob) {} catch {}
        uint256 claimed = usdc.balanceOf(alice) - aliceStart + usdc.balanceOf(bob) - bobStart;
        assertLe(claimed, paid, "paid out more than came in");
        // and almost nothing is lost: under 1 base unit per staker per claim (the drip's own rounding is ~1e-9)
        assertGe(claimed + 4, paid, "rewards lost");
    }
}
