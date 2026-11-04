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

    function deposit(NeuriioArena arena, NeuriioArena.Ticket calldata t, bytes calldata sig) external payable {
        arena.deposit{value: msg.value}(t, sig);
    }

    function withdraw(NeuriioArena arena) external {
        arena.withdraw();
    }

    receive() external payable {
        require(accept);
    }
}

/// Tries to re-enter the arena from its refund.
contract Reenterer {
    NeuriioArena public arena;
    NeuriioArena.Ticket public next;
    bytes public nextSig;

    function deposit(NeuriioArena a, NeuriioArena.Ticket calldata t, bytes calldata sig) external payable {
        arena = a;
        a.deposit{value: msg.value}(t, sig);
    }

    function arm(NeuriioArena.Ticket calldata t, bytes calldata sig) external {
        next = t;
        nextSig = sig;
    }

    receive() external payable {
        arena.deposit{value: msg.value}(next, nextSig); // reverts (nonReentrant): the refund is kept as owed instead
    }
}

contract NeuriioArenaTest is Test {
    NeuriioArena arena;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address settler = makeAddr("settler");
    uint256 mmKey = 0xA11CE;
    address matchmaker;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint256 constant T01 = 0.1 ether;
    uint256 constant T1 = 1 ether;
    uint256 constant T5 = 5 ether;
    uint256 constant T10 = 10 ether;
    uint256 constant WINDOW = 60; // the deposit window the matchmaker gives

    uint256 nextId = 1;

    function setUp() public {
        matchmaker = vm.addr(mmKey);
        uint256[] memory tiers = new uint256[](4);
        tiers[0] = T01;
        tiers[1] = T1;
        tiers[2] = T5;
        tiers[3] = T10;
        arena = new NeuriioArena(owner, treasury, matchmaker, settler, 1_500, tiers);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _ticket(address a, address b, uint256 w) internal returns (NeuriioArena.Ticket memory t) {
        t = NeuriioArena.Ticket({id: nextId++, a: a, b: b, wager: w, deadline: block.timestamp + WINDOW});
    }

    function _sign(NeuriioArena.Ticket memory t, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, arena.hashTicket(t));
        return abi.encodePacked(r, s, v);
    }

    function _deposit(address p, NeuriioArena.Ticket memory t) internal {
        bytes memory sig = _sign(t, mmKey);
        vm.prank(p);
        arena.deposit{value: t.wager}(t, sig);
    }

    /// a started match between alice and bob
    function _match(uint256 w) internal returns (uint256 id) {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, w);
        _deposit(alice, t);
        _deposit(bob, t);
        id = t.id;
    }

    function _m(uint256 id) internal view returns (NeuriioArena.Match memory) {
        return arena.getMatch(id);
    }

    // ---------------------------------------------------------------- deposits

    function test_nothingHeldUntilMatched() public view {
        assertEq(address(arena).balance, 0); // the queue is off-chain: no contract call to wait
    }

    function test_firstDepositRecordsTicket() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        _deposit(alice, t);
        NeuriioArena.Match memory m = _m(t.id);
        assertEq(m.a, alice);
        assertEq(m.b, bob);
        assertEq(m.wager, T1);
        assertEq(m.deadline, t.deadline);
        assertEq(m.start, 0); // not started until both are in
        assertEq(m.rakeBps, 1_500);
        assertTrue(m.aIn);
        assertFalse(m.bIn);
        assertEq(arena.activeMatch(alice), t.id);
        assertEq(address(arena).balance, T1);
    }

    function test_secondDepositStartsMatch() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        _deposit(alice, t);
        skip(20);
        _deposit(bob, t);
        NeuriioArena.Match memory m = _m(t.id);
        assertEq(m.start, block.timestamp);
        assertTrue(m.aIn && m.bIn);
        assertEq(arena.activeMatch(bob), t.id);
        assertEq(address(arena).balance, 2 * T1);
    }

    function test_eitherPlayerCanGoFirst() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T5);
        _deposit(bob, t);
        _deposit(alice, t);
        assertGt(_m(t.id).start, 0);
    }

    function test_onlyTheTwoPlayers() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(carol);
        vm.expectRevert(NeuriioArena.NotAPlayer.selector);
        arena.deposit{value: T1}(t, sig);
    }

    function test_forgedTicketRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        bytes memory sig = _sign(t, 0xBAD);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.BadTicket.selector);
        arena.deposit{value: T1}(t, sig);
    }

    function test_alteredTicketRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        bytes memory sig = _sign(t, mmKey);
        t.wager = T01; // cheaper than signed
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.BadTicket.selector);
        arena.deposit{value: T01}(t, sig);
    }

    function test_secondPlayerMustUseSameTicket() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        _deposit(alice, t);
        // a different, validly signed ticket reusing the id can't change the match
        NeuriioArena.Ticket memory u =
            NeuriioArena.Ticket({id: t.id, a: alice, b: bob, wager: T5, deadline: t.deadline});
        bytes memory sig = _sign(u, mmKey);
        vm.prank(bob);
        vm.expectRevert(NeuriioArena.BadTicket.selector);
        arena.deposit{value: T5}(u, sig);
    }

    function test_wrongAmountRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.WrongAmount.selector);
        arena.deposit{value: T01}(t, sig);
    }

    function test_unknownTierRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, 2 ether);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.NotTier.selector);
        arena.deposit{value: 2 ether}(t, sig);
    }

    function test_selfMatchRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, alice, T1);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.BadTicket.selector);
        arena.deposit{value: T1}(t, sig);
    }

    function test_longDepositWindowRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        t.deadline = block.timestamp + arena.MAX_DEPOSIT_WINDOW() + 1;
        bytes memory sig = _sign(t, mmKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.BadTicket.selector);
        arena.deposit{value: T1}(t, sig);
    }

    function test_expiredTicketRefused() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        bytes memory sig = _sign(t, mmKey);
        skip(WINDOW + 1);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.Expired.selector);
        arena.deposit{value: T1}(t, sig);
    }

    function test_cannotDepositTwice() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        _deposit(alice, t);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.AlreadyIn.selector);
        arena.deposit{value: T1}(t, sig);
    }

    function test_oneMatchAtATime() public {
        _match(T1);
        NeuriioArena.Ticket memory t = _ticket(alice, carol, T5);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.Busy.selector);
        arena.deposit{value: T5}(t, sig);
    }

    function test_canPlayAgainAfterSettle() public {
        uint256 id = _match(T1);
        skip(24 hours);
        vm.prank(settler);
        arena.settle(id, alice);
        _match(T1); // alice and bob again, a new ticket
    }

    // ---------------------------------------------------------------- cancel (no-show)

    function test_noShowRefundsTheDepositor() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T5);
        _deposit(alice, t);
        uint256 before = alice.balance;
        skip(WINDOW + 1);
        vm.prank(carol); // anyone (the watcher)
        arena.cancel(t.id);
        assertEq(alice.balance, before + T5);
        assertEq(arena.activeMatch(alice), 0);
        assertEq(address(arena).balance, 0);
        assertTrue(_m(t.id).done);
        // the dead ticket can't be used afterwards
        bytes memory sig = _sign(t, mmKey);
        vm.prank(bob);
        vm.expectRevert(NeuriioArena.Expired.selector);
        arena.deposit{value: T5}(t, sig);
    }

    function test_cancelNotBeforeDeadline() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T5);
        _deposit(alice, t);
        skip(WINDOW);
        vm.expectRevert(NeuriioArena.TooEarly.selector);
        arena.cancel(t.id);
    }

    function test_cancelNotAfterStart() public {
        uint256 id = _match(T1);
        skip(WINDOW + 1);
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.cancel(id);
    }

    function test_cancelUnknownId() public {
        vm.expectRevert(NeuriioArena.NotLive.selector);
        arena.cancel(99);
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
        assertTrue(_m(id).done);
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
        vm.prank(matchmaker);
        vm.expectRevert(NeuriioArena.NotSettler.selector);
        arena.settle(id, alice);
    }

    function test_settleNeedsAStartedMatch() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        _deposit(alice, t);
        skip(24 hours);
        vm.prank(settler);
        vm.expectRevert(NeuriioArena.NotStarted.selector);
        arena.settle(t.id, alice);
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
        arena.settle(99, alice); // never existed
        vm.stopPrank();
    }

    function test_rakeSnapshotAtTicketTime() public {
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
        NeuriioArena.Ticket memory t = _ticket(address(r), bob, T1);
        r.deposit{value: T1}(arena, t, _sign(t, mmKey));
        _deposit(bob, t);
        skip(24 hours);
        vm.prank(settler);
        arena.settle(t.id, address(r)); // the push fails, the settle doesn't
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
        NeuriioArena.Ticket memory t = _ticket(address(r), bob, T1);
        r.deposit{value: T1}(arena, t, _sign(t, mmKey));
        _deposit(bob, t);
        skip(24 hours);
        uint256 b0 = bob.balance;
        vm.prank(settler);
        arena.settle(t.id, address(0));
        assertEq(bob.balance, b0 + T1);
        assertEq(arena.owed(address(r)), T1);
    }

    function test_reentryFromCancelRefundFails() public {
        Reenterer e = new Reenterer();
        vm.deal(address(e), 10 ether);
        NeuriioArena.Ticket memory t = _ticket(address(e), bob, T1);
        e.deposit{value: T1}(arena, t, _sign(t, mmKey));
        NeuriioArena.Ticket memory u = _ticket(address(e), carol, T1);
        e.arm(u, _sign(u, mmKey));
        skip(WINDOW + 1);
        arena.cancel(t.id); // its receive() tries to deposit again: blocked, so the refund is kept as owed
        assertEq(arena.owed(address(e)), T1);
        assertEq(arena.activeMatch(address(e)), 0);
    }

    // ---------------------------------------------------------------- owner

    function test_pauseStopsDepositsOnly() public {
        uint256 id = _match(T1);
        NeuriioArena.Ticket memory t = _ticket(carol, bob, T5);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(carol);
        arena.deposit{value: T5}(t, sig);
        vm.prank(owner);
        arena.pause();

        NeuriioArena.Ticket memory u = _ticket(alice, carol, T01);
        bytes memory usig = _sign(u, mmKey);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        arena.deposit{value: T01}(u, usig);

        skip(WINDOW + 1);
        arena.cancel(t.id); // still works
        skip(24 hours);
        vm.prank(settler);
        arena.settle(id, alice); // still works
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
        arena.setMatchmaker(alice);
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
        arena.setMatchmaker(address(0));
        vm.expectRevert(NeuriioArena.ZeroAddress.selector);
        arena.setSettler(address(0));
        vm.expectRevert(NeuriioArena.NotTier.selector);
        arena.setTier(0, true);
        vm.stopPrank();
    }

    function test_newMatchmakerInvalidatesOldSignatures() public {
        NeuriioArena.Ticket memory t = _ticket(alice, bob, T1);
        bytes memory sig = _sign(t, mmKey);
        vm.prank(owner);
        arena.setMatchmaker(makeAddr("mm2"));
        vm.prank(alice);
        vm.expectRevert(NeuriioArena.BadTicket.selector);
        arena.deposit{value: T1}(t, sig);
    }

    // ---------------------------------------------------------------- fuzz

    /// The contract always pays out exactly what came in.
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
