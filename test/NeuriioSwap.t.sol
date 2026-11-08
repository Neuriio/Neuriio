// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NeuriioSwap} from "../src/trade/NeuriioSwap.sol";
import {IPermit2, IUniversalRouter, PoolKey} from "../src/launch/AscendAdapter.sol";

/// NeuriioSwap's rules that need no live pool (the trades themselves: test/fork/NeuriioSwapMontra.t.sol).
contract NeuriioSwapTest is Test {
    address owner = makeAddr("timelock");
    address guardian = makeAddr("safe");
    address router = makeAddr("router");
    address permit2 = makeAddr("permit2");
    address whype = makeAddr("whype");
    address feeWallet = makeAddr("feeWallet");
    address token = makeAddr("token");
    address stranger = makeAddr("stranger");
    NeuriioSwap swap;

    function setUp() public {
        swap = new NeuriioSwap(owner, IUniversalRouter(router), IPermit2(permit2), whype, feeWallet, guardian);
    }

    function _key(address c0, address c1) internal pure returns (PoolKey memory) {
        return PoolKey(c0, c1, 0x800000, 200, address(0xBEEF));
    }

    function test_constructor_refuses_missing_addresses() public {
        vm.expectRevert(NeuriioSwap.BadSetup.selector);
        new NeuriioSwap(owner, IUniversalRouter(address(0)), IPermit2(permit2), whype, feeWallet, guardian);
        vm.expectRevert(NeuriioSwap.BadSetup.selector);
        new NeuriioSwap(owner, IUniversalRouter(router), IPermit2(address(0)), whype, feeWallet, guardian);
        vm.expectRevert(NeuriioSwap.BadSetup.selector);
        new NeuriioSwap(owner, IUniversalRouter(router), IPermit2(permit2), address(0), feeWallet, guardian);
        vm.expectRevert(NeuriioSwap.BadSetup.selector);
        new NeuriioSwap(owner, IUniversalRouter(router), IPermit2(permit2), whype, address(0), guardian);
    }

    function test_only_the_owner_approves_pools() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        swap.setPool(_key(address(0), token), token, true);
        vm.prank(guardian); // the guardian can only pause
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        swap.setPool(_key(address(0), token), token, true);

        vm.prank(owner);
        swap.setPool(_key(address(0), token), token, true);
        assertTrue(swap.approved(token));
        assertEq(swap.poolOf(token).hooks, address(0xBEEF));

        vm.prank(owner);
        swap.setPool(_key(address(0), token), token, false);
        assertFalse(swap.approved(token));
        assertEq(swap.poolOf(token).currency1, address(0), "an unapproved pool is forgotten");
    }

    function test_pool_must_contain_the_token_and_be_sane() public {
        address usdc = makeAddr("usdc");
        vm.startPrank(owner);
        vm.expectRevert(NeuriioSwap.BadPool.selector);
        swap.setPool(_key(usdc, makeAddr("other")), token, true); // the token isn't in this pool
        vm.expectRevert(NeuriioSwap.BadPool.selector);
        swap.setPool(_key(address(0), token), address(0), true); // native HYPE isn't a token to trade
        vm.expectRevert(NeuriioSwap.BadPool.selector);
        swap.setPool(_key(token, token), token, true);
        PoolKey memory k = _key(address(0), token);
        k.tickSpacing = 0;
        vm.expectRevert(NeuriioSwap.BadPool.selector);
        swap.setPool(k, token, true);
        // the quote is whichever side the token isn't on
        swap.setPool(_key(token, usdc), token, true);
        assertEq(swap.quoteOf(token), usdc);
        swap.setPool(_key(address(0), token), token, true);
        assertEq(swap.quoteOf(token), address(0));
        vm.stopPrank();
    }

    function test_trading_refuses_unapproved_tokens_and_zero_amounts() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NeuriioSwap.NotApproved.selector, token));
        swap.buy{value: 1 ether}(token, 1 ether, 1, stranger, block.timestamp);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NeuriioSwap.NotApproved.selector, token));
        swap.sell(token, 1, 1, stranger, block.timestamp);

        vm.prank(owner);
        swap.setPool(_key(address(0), token), token, true);
        vm.prank(stranger);
        vm.expectRevert(NeuriioSwap.ZeroAmount.selector);
        swap.buy{value: 0}(token, 0, 1, stranger, block.timestamp);
        vm.prank(stranger);
        vm.expectRevert(NeuriioSwap.ZeroAmount.selector);
        swap.sell(token, 0, 1, stranger, block.timestamp);
    }

    function test_hype_sent_outside_a_sell_is_refused() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(swap).call{value: 1 ether}("");
        assertFalse(ok, "nothing can be parked in the contract");
        vm.deal(router, 1 ether);
        vm.prank(router); // not even from the router, outside a sell
        (ok,) = address(swap).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(swap).balance, 0);
    }

    function test_pause_by_owner_or_guardian_unpause_by_owner_only() public {
        vm.prank(stranger);
        vm.expectRevert(NeuriioSwap.NotOwnerOrGuardian.selector);
        swap.pause();
        vm.prank(guardian);
        swap.pause();
        assertTrue(swap.paused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        swap.unpause();
        vm.prank(owner);
        swap.unpause();
        assertFalse(swap.paused());

        vm.prank(owner);
        swap.setGuardian(address(0));
        vm.prank(guardian);
        vm.expectRevert(NeuriioSwap.NotOwnerOrGuardian.selector);
        swap.pause();
    }

    function test_fee_is_half_a_percent() public view {
        assertEq(swap.FEE_BPS(), 50);
    }
}
