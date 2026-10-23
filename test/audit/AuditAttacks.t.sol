// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioFees} from "../../src/launch/NeuriioFees.sol";
import {NeuriioPad} from "../../src/launch/NeuriioPad.sol";
import {NeuriioStaking} from "../../src/stake/NeuriioStaking.sol";
import {NeuriioRouter} from "../../src/swap/NeuriioRouter.sol";
import {NeuriioBase, IPair} from "../Base.t.sol";

/// Flash-swap borrower that, inside the pair's callback, tries everything it can reach before paying back.
contract AuditCallbackProbe {
    IPair public pair;
    IERC20 public usdc;
    IERC20 public token;
    NeuriioFees public vault;
    NeuriioStaking public staking;
    NeuriioPad public pad;
    address public otherToken;
    bool public reenteredPair;
    bool public calledVault;

    constructor(
        IPair pair_,
        IERC20 usdc_,
        IERC20 token_,
        NeuriioFees vault_,
        NeuriioStaking staking_,
        NeuriioPad pad_,
        address other
    ) {
        (pair, usdc, token, vault, staking, pad, otherToken) = (pair_, usdc_, token_, vault_, staking_, pad_, other);
        usdc_.approve(address(pad_), type(uint256).max);
        token_.approve(address(staking_), type(uint256).max);
    }

    /// Borrows `tokensOut` tokens; pays back `tokensBack` in the callback.
    function run(uint256 tokensOut, uint256 tokensBack) external {
        (uint256 a0, uint256 a1) = pair.token0() == address(token) ? (tokensOut, uint256(0)) : (uint256(0), tokensOut);
        pair.swap(a0, a1, address(this), abi.encode(tokensBack));
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata data) external {
        // 1. the pair is locked: no second swap, sync or skim mid-swap
        try pair.sync() {
            reenteredPair = true;
        } catch {}
        try pair.skim(address(this)) {
            reenteredPair = true;
        } catch {}
        // 2. nobody but the pair can report its fee
        try vault.notifyPoolFee(address(token), 1) {
            calledVault = true;
        } catch {}
        // 3. ordinary actions elsewhere still work and settle their own fees: a curve buy, and staking the borrowed tokens
        pad.buy(otherToken, 100e6, 0, block.timestamp);
        staking.stake(address(token), token.balanceOf(address(this)) / 2);
        staking.unstake(address(token), staking.stakedOf(address(this), address(token)));
        token.transfer(msg.sender, abi.decode(data, (uint256)));
    }
}

/// Attacker-angle checks behind "checked and found fine" in audit/SECURITY_AUDIT.md.
contract AuditAttacksTest is NeuriioBase {
    /// NeuriioFees calls staking and the minter inside try/catch. A trader who picks the transaction's gas limit could
    /// try to make those inner calls run out of gas while the trade itself succeeds (diverting the stakers' shares to
    /// the treasury, or skipping the $NEURIIO mint). From the smallest gas limit at which a pool sell succeeds up to
    /// 300k above it, in 200-gas steps, every successful sell paid the token stakers, the $NEURIIO stakers and the
    /// minter: the work left after a catch needs far more than the 1/64 of gas the caller keeps.
    function test_Audit_gasLimitCantSilenceStakingOrMinter() public {
        address token = _graduated(alice);
        _stake(alice, token, IERC20(token).balanceOf(alice) / 2); // token stakers: the holders' share and a mint
        vm.prank(address(minter));
        neuriio.mint(bob, 1_000e18);
        _stake(bob, address(neuriio), 1_000e18); // $NEURIIO stakers: the stakers' share
        vm.prank(alice);
        IERC20(token).approve(address(trade), type(uint256).max);
        bytes memory sell = abi.encodeCall(NeuriioRouter.sell, (token, 1_000_000e18, 0, block.timestamp));

        // the smallest gas limit at which the sell goes through
        (uint256 lo, uint256 hi) = (50_000, 3_000_000);
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            if (_sellWithGas(sell, mid)) hi = mid;
            else lo = mid + 1;
            vm.revertToState(snap);
        }
        emit log_named_uint("smallest gas limit for a pool sell", lo);

        uint256 checked;
        for (uint256 g = lo; g <= lo + 300_000; g += 200) {
            uint256 snap = vm.snapshotState();
            (uint256 holders, uint256 stakers, uint256 mintFees) =
                (vault.holdersEarned(token), vault.stakersEarned(), minter.totalFees());
            if (_sellWithGas(sell, g)) {
                checked++;
                assertGt(vault.holdersEarned(token), holders, "token stakers skipped");
                assertGt(vault.stakersEarned(), stakers, "$NEURIIO stakers skipped");
                assertGt(minter.totalFees(), mintFees, "minter skipped");
            }
            vm.revertToState(snap);
        }
        assertGt(checked, 1_400);
    }

    /// Alice's sell through the router with exactly `g` gas (no return data copied, so memory stays flat).
    function _sellWithGas(bytes memory data, uint256 g) internal returns (bool ok) {
        address target = address(trade);
        vm.prank(alice);
        assembly {
            ok := call(g, target, 0, add(data, 32), mload(data), 0, 0)
        }
    }

    /// A flash-swap borrower's callback runs before the pair takes its fee. From there it can't re-enter the pair (locked)
    /// or report a fee itself, and what it can do (trade a curve, stake and unstake the borrowed tokens) settles normally:
    /// the pool still gets its 1% and NeuriioFees still holds exactly what it owes.
    function test_Audit_flashSwapCallbackCantBreakAnything() public {
        address token = _graduated(alice);
        address other = _launch();
        IPair pair = _pairOf(token);
        AuditCallbackProbe probe = new AuditCallbackProbe(pair, usdc, IERC20(token), vault, staking, pad, other);
        usdc.mint(address(probe), 1_000e6);
        uint256 extra = IERC20(token).balanceOf(alice);
        vm.prank(alice);
        IERC20(token).transfer(address(probe), extra);

        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 kBefore = uint256(r0) * r1;
        uint256 feesBefore = vault.totalFees();
        uint256 borrow = 50_000_000e18;
        probe.run(borrow, borrow * 10_000 / 9_900 + 1e18);

        assertFalse(probe.reenteredPair(), "pair re-entered mid-swap");
        assertFalse(probe.calledVault(), "a non-pair reported a pool fee");
        (r0, r1,) = pair.getReserves();
        assertGe(uint256(r0) * r1, kBefore);
        assertGt(vault.totalFees() - feesBefore, 1e6, "the curve buy's and the flash swap's fees were both credited");
        assertGe(usdc.balanceOf(address(vault)), vault.held());
        assertEq(staking.totalStaked(token), 0);
    }
}
