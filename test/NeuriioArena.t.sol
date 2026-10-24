// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {NeuriioArena} from "../src/arena/NeuriioArena.sol";

/// Rejects HYPE (a contract wallet that can't take a push payout) until told otherwise.
contract Rejecter {
    bool public accept;

    function setAccept(bool a) external {
        accept = a;
    }

    function enter(NeuriioArena arena) external payable {
        arena.enter{value: msg.value}();
    }

    function withdraw(NeuriioArena arena) external {
        arena.withdraw();
    }

    receive() external payable {
        require(accept);
    }
}

/// Tries to re-enter the arena from its payout.
contract Reenterer {
    NeuriioArena public arena;

    function enter(NeuriioArena a) external payable {
        arena = a;
        a.enter{value: msg.value}();
    }

    function leave() external {
        arena.leave();
    }

    receive() external payable {
        arena.enter{value: msg.value}(); // reverts (nonReentrant): the refund is kept as owed instead
    }
}

contract NeuriioArenaTest is Test {
    NeuriioArena arena;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address settler = makeAddr("settler");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    uint256 constant T01 = 0.1 ether;
    uint256 constant T1 = 1 ether;
    uint256 constant T5 = 5 ether;
    uint256 constant T10 = 10 ether;

    function setUp() public {
        uint256[] memory tiers = new uint256[](4);
        tiers[0] = T01;
        tiers[1] = T1;
        tiers[2] = T5;
        tiers[3] = T10;
        arena = new NeuriioArena(owner, treasury, settler, 1_500, tiers);
        address[4] memory ps = [alice, bob, carol, dave];
        for (uint256 i; i < 4; i++) {
            vm.deal(ps[i], 100 ether);
        }
    }

    function _enter(address p, uint256 w) internal {
        vm.prank(p);
        arena.enter{value: w}();
    }

    function _match(uint256 w) internal returns (uint256 id) {
        _enter(alice, w);
        _enter(bob, w);
        id = arena.matchCount();
    }

    // ---------------------------------------------------------------- queue + matchmaking

    function test_firstPlayerQueues() public {
        _enter(alice, T1);
        assertEq(arena.waiting(T1), alice);
        assertEq(arena.queuedTier(alice), T1);
        assertEq(arena.matchCount(), 0);
        assertEq(address(arena).balance, T1);
    }

    function test_secondPlayerMatchesAtOnce() public {
        uint256 id = _match(T1);
        assertEq(id, 1);
        (address a, address b, uint96 wager, uint40 start, uint16 rake, bool done) = arena.matches(id);
        assertEq(a, alice);
        assertEq(b, bob);
        assertEq(wager, T1);
        assertEq(start, block.timestamp);
        assertEq(rake, 1_500);
        assertFalse(done);
        assertEq(arena.waiting(T1), address(0));
        assertEq(arena.queuedTier(alice), 0);
        assertEq(arena.activeMatch(alice), 1);
        assertEq(arena.activeMatch(bob), 1);
        assertEq(address(arena).balance, 2 * T1);
    }

    function test_fifoPerTier() public {
        _match(T1); // alice vs bob
        _enter(carol, T1);
        _enter(dave, T1);
        (address a, address b,,,,) = arena.matches(2);
        assertEq(a, carol);
        assertEq(b, dave);
    }

    function test_tiersAreSeparate() public {
        _enter(alice, T1);
        _enter(bob, T5);
        assertEq(arena.matchCount(), 0);
        assertEq(arena.waiting(T1), alice);
        assertEq(arena.waiting(T5), bob);
    }

    function test_wrongAmountRefused() public {
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.NotTier.selector);
        arena.enter{value: 2 ether}();
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.NotTier.selector);
        arena.enter{value: 0}();
    }

    function test_cannotMatchYourself() public {
        _enter(alice, T1);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.Busy.selector);
        arena.enter{value: T1}();
    }

    function test_oneQueueAtATime() public {
        _enter(alice, T1);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.Busy.selector);
        arena.enter{value: T5}();
    }

    function test_oneMatchAtATime() public {
        _match(T1);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.Busy.selector);
        arena.enter{value: T5}();
    }

    function test_canPlayAgainAfterSettle() public {
        uint256 id = _match(T1);
        skip(24 hours);
        vm.prank(settler);
        arena.settle(id, alice);
        _enter(alice, T1);
        assertEq(arena.waiting(T1), alice);
    }

    // ---------------------------------------------------------------- leave

    function test_leaveRefunds() public {
        _enter(alice, T5);
        uint256 before = alice.balance;
        vm.prank(alice);
        arena.leave();
        assertEq(alice.balance, before + T5);
        assertEq(arena.waiting(T5), address(0));
        assertEq(arena.queuedTier(alice), 0);
        _enter(bob, T5); // the slot is free again: bob queues, no match
        assertEq(arena.matchCount(), 0);
    }

    function test_leaveNeedsQueue() public {
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.NotQueued.selector);
        arena.leave();
        _match(T1);
        vm.prank(alice); // matched players can't leave
        vm.expectRevert(NeuriioArena.NotQueued.selector);
        arena.leave();
    }

    // ---------------------------------------------------------------- settle

    function test_settleWinnerGets85PercentOfPot() public {
        uint256 id = _match(T10);
        skip(24 hours);
        uint256 before = bob.balance;
        vm.prank(settler);
        arena.settle(id, bob);
        assertEq(bob.balance, before + 17 ether); // 85% of 20
        assertEq(treasury.balance, 3 ether); // 15% of 20
        assertEq(address(arena).balance, 0);
        assertEq(arena.activeMatch(alice), 0);
        assertEq(arena.activeMatch(bob), 0);
        (,,,,, bool done) = arena.matches(id);
        assertTrue(done);
    }

    function test_settleDrawRefundsWithoutRake() public {
        uint256 id = _match(T01);
        skip(24 hours);
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        vm.prank(settler);
        arena.settle(id, address(0));
        assertEq(alice.balance, a0 + T01);
        assertEq(bob.balance, b0 + T01);
        assertEq(treasury.balance, 0);
    }

    function test_settleOnlySettler() public {
        uint256 id = _match(T1);
        skip(24 hours);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.NotSettler.selector);
        arena.settle(id, alice);
        vm.prank(owner);
        vm.expectRevert(NeuriioArena.NotSettler.selector);
        arena.settle(id, alice);
    }

    function test_settleNotBefore24h() public {
        uint256 id = _match(T1);
        skip(24 hours - 1);
        vm.prank(settler);
        vm.expectRevert(NeuriioArena.TooEarly.selector);
        arena.settle(id, alice);
    }

    function test_settleNotAfterWindow() public {
        uint256 id = _match(T1);
        skip(24 hours + 48 hours);
        vm.prank(settler);
        vm.expectRevert(NeuriioArena.TooLate.selector);
        arena.settle(id, alice);
    }

    function test_settleWinnerMustBeAPlayer() public {
        uint256 id = _match(T1);
        skip(24 hours);
        vm.prank(settler);
        vm.expectRevert(NeuriioArena.NotAPlayer.selector);
        arena.settle(id, carol);
    }

    function test_settleOnlyOnce() public {
        uint256 id = _match(T1);
        skip(24 hours);
        vm.startPrank(settler);
        arena.settle(id, alice);
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.settle(id, bob);
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.settle(id, address(0));
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.settle(99, alice); // never existed
        vm.stopPrank();
    }

    function test_rakeSnapshotAtMatchTime() public {
        uint256 id = _match(T10);
        vm.prank(owner);
        arena.setRake(2_000); // raised mid-match: this match keeps 15%
        skip(24 hours);
        vm.prank(settler);
        arena.settle(id, alice);
        assertEq(treasury.balance, 3 ether);
    }

    // ---------------------------------------------------------------- reclaim (dead server)

    function test_reclaimAfterWindowRefundsBoth() public {
        uint256 id = _match(T5);
        skip(24 hours + 48 hours);
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        vm.prank(carol); // anyone
        arena.reclaim(id);
        assertEq(alice.balance, a0 + T5);
        assertEq(bob.balance, b0 + T5);
        assertEq(arena.activeMatch(alice), 0);
        vm.prank(settler);
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.settle(id, alice);
    }

    function test_reclaimNotEarly() public {
        uint256 id = _match(T5);
        skip(24 hours + 48 hours - 1);
        vm.expectRevert(NeuriioArena.TooEarly.selector);
        arena.reclaim(id);
    }

    function test_reclaimNotAfterSettle() public {
        uint256 id = _match(T5);
        skip(24 hours);
        vm.prank(settler);
        arena.settle(id, alice);
        skip(48 hours);
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.reclaim(id);
    }

    // ---------------------------------------------------------------- bounced payouts

    function test_bouncedPayoutKeptForWithdraw() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 10 ether);
        r.enter{value: T1}(arena);
        _enter(bob, T1);
        skip(24 hours);
        vm.prank(settler);
        arena.settle(1, address(r)); // the push fails, the settle doesn't
        assertEq(arena.owed(address(r)), 1.7 ether);
        assertEq(treasury.balance, 0.3 ether);

        vm.expectRevert(NeuriioArena.SendFailed.selector);
        r.withdraw(arena);
        r.setAccept(true);
        r.withdraw(arena);
        assertEq(arena.owed(address(r)), 0);
        assertEq(address(arena).balance, 0);

        vm.expectRevert(NeuriioArena.NothingOwed.selector);
        r.withdraw(arena);
    }

    function test_bouncedRefundDoesNotBlockTheOther() public {
        Rejecter r = new Rejecter();
        vm.deal(address(r), 10 ether);
        r.enter{value: T1}(arena);
        _enter(bob, T1);
        skip(24 hours);
        uint256 b0 = bob.balance;
        vm.prank(settler);
        arena.settle(1, address(0));
        assertEq(bob.balance, b0 + T1);
        assertEq(arena.owed(address(r)), T1);
    }

    function test_reentryFromRefundFails() public {
        Reenterer e = new Reenterer();
        vm.deal(address(e), 10 ether);
        e.enter{value: T1}(arena);
        e.leave(); // its receive() tries to enter again: blocked, so the refund is kept as owed
        assertEq(arena.queuedTier(address(e)), 0);
        assertEq(arena.waiting(T1), address(0));
        assertEq(arena.owed(address(e)), T1);
    }

    // ---------------------------------------------------------------- owner

    function test_pauseStopsEntriesOnly() public {
        uint256 id = _match(T1);
        _enter(carol, T5);
        vm.prank(owner);
        arena.pause();

        vm.prank(dave);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arena.enter{value: T5}();

        vm.prank(carol);
        arena.leave(); // still works
        skip(24 hours);
        vm.prank(settler);
        arena.settle(id, alice); // still works
        assertEq(address(arena).balance, 0);
    }

    function test_removedTierStillLetsWaitingPlayerLeave() public {
        _enter(alice, T10);
        vm.prank(owner);
        arena.setTier(T10, false);
        vm.prank(bob);
        vm.expectRevert(NeuriioArena.NotTier.selector);
        arena.enter{value: T10}();
        vm.prank(alice);
        arena.leave();
        assertEq(address(arena).balance, 0);
    }

    function test_ownerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.setTier(2 ether, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.setRake(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.setTreasury(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.setSettler(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        arena.pause();
        vm.stopPrank();
    }

    function test_ownerLimits() public {
        vm.startPrank(owner);
        vm.expectRevert(NeuriioArena.BadRake.selector);
        arena.setRake(2_001);
        vm.expectRevert(NeuriioArena.ZeroAddress.selector);
        arena.setTreasury(address(0));
        vm.expectRevert(NeuriioArena.ZeroAddress.selector);
        arena.setSettler(address(0));
        vm.expectRevert(NeuriioArena.NotTier.selector);
        arena.setTier(0, true);
        vm.stopPrank();
    }

    function test_newSettlerTakesOver() public {
        uint256 id = _match(T1);
        address s2 = makeAddr("settler2");
        vm.prank(owner);
        arena.setSettler(s2);
        skip(24 hours);
        vm.prank(settler);
        vm.expectRevert(NeuriioArena.NotSettler.selector);
        arena.settle(id, alice);
        vm.prank(s2);
        arena.settle(id, alice);
    }

    // ---------------------------------------------------------------- fuzz

    /// The contract always holds exactly what it owes: queued wagers + live pots + owed payouts.
    function testFuzz_payoutsAddUp(uint8 tierIdx, uint16 rake, bool aWins, bool draw) public {
        uint256[4] memory ts = [T01, T1, T5, T10];
        uint256 w = ts[tierIdx % 4];
        rake = uint16(bound(rake, 0, 2_000));
        vm.prank(owner);
        arena.setRake(rake);
        uint256 id = _match(w);
        skip(24 hours);
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        address winner = draw ? address(0) : (aWins ? alice : bob);
        vm.prank(settler);
        arena.settle(id, winner);
        uint256 paid = (alice.balance - a0) + (bob.balance - b0) + treasury.balance;
        assertEq(paid, 2 * w);
        assertEq(address(arena).balance, 0);
        if (!draw) assertEq(treasury.balance, 2 * w * rake / 10_000);
    }
}
