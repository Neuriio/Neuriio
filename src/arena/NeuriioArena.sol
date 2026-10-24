// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @notice Trade Arena escrow (TRADE_ARENA.md): 1v1 paper-perps duels for a HYPE wager.
/// A player `enter`s with exactly one tier's wager. Each tier is a 1v1 FIFO queue, which is at most one player long:
/// the next player to enter that tier is matched with them at once, on-chain, and the 24 h match starts. Trading
/// happens off-chain on synthetic money; after 24 h the settler (our server) names the winner, who gets the pot less
/// the rake (taken from the total pot, snapshotted at match time), or names nobody (a draw or nobody qualified), and
/// both are refunded with no rake. If the settler hasn't settled within SETTLE_WINDOW of the end, anyone can
/// `reclaim` and both are refunded, so a dead server never locks wagers.
/// One player, one match: you can't enter while you're queued or in a live match. Waiting players can `leave` for a
/// full refund. The owner sets tiers, rake (capped), treasury, settler and pause; it can never move players' HYPE.
/// Pause only stops new entries: leave, settle, reclaim and withdraw keep working.
/// Payouts are pushed; a payout that can't be delivered (a recipient that rejects HYPE) is kept for `withdraw`.
contract NeuriioArena is Ownable2Step, Pausable, ReentrancyGuardTransient {
    uint256 public constant MATCH_LENGTH = 24 hours;
    uint256 public constant SETTLE_WINDOW = 48 hours; // after the match ends
    uint256 public constant MAX_RAKE_BPS = 2_000;

    struct Match {
        address a;
        address b;
        uint96 wager;
        uint40 start;
        uint16 rakeBps;
        bool done;
    }

    address public treasury;
    address public settler;
    uint16 public rakeBps;

    mapping(uint256 wager => bool) public isTier;
    mapping(uint256 wager => address) public waiting; // the player queued in that tier, if any
    mapping(address player => uint256) public queuedTier; // the wager they're queued with; 0 = not queued
    mapping(address player => uint256) public activeMatch; // their live match's id; 0 = none
    mapping(address => uint256) public owed; // payouts that couldn't be pushed
    mapping(uint256 id => Match) public matches; // ids start at 1
    uint256 public matchCount;

    event TierSet(uint256 wager, bool enabled);
    event RakeSet(uint16 bps);
    event TreasurySet(address treasury);
    event SettlerSet(address settler);
    event Queued(address indexed player, uint256 wager);
    event Left(address indexed player, uint256 wager);
    event MatchMade(uint256 indexed id, address indexed a, address indexed b, uint256 wager, uint256 start);
    event Settled(uint256 indexed id, address indexed winner, uint256 payout, uint256 rake);
    event Refunded(uint256 indexed id);
    event Owed(address indexed to, uint256 amount);

    error NotTier();
    error Busy();
    error NotQueued();
    error NotSettler();
    error NotLive();
    error TooEarly();
    error TooLate();
    error NotAPlayer();
    error BadRake();
    error ZeroAddress();
    error NothingOwed();
    error SendFailed();

    constructor(address owner_, address treasury_, address settler_, uint16 rakeBps_, uint256[] memory tiers)
        Ownable(owner_)
    {
        _setTreasury(treasury_);
        _setSettler(settler_);
        _setRake(rakeBps_);
        for (uint256 i; i < tiers.length; i++) {
            _setTier(tiers[i], true);
        }
    }

    // ---------------------------------------------------------------- players

    /// @notice Join a tier's queue with exactly its wager, or start a match with whoever is waiting there.
    function enter() external payable nonReentrant whenNotPaused {
        uint256 wager = msg.value;
        if (!isTier[wager]) revert NotTier();
        if (queuedTier[msg.sender] != 0 || activeMatch[msg.sender] != 0) revert Busy();

        address opponent = waiting[wager];
        if (opponent == address(0)) {
            waiting[wager] = msg.sender;
            queuedTier[msg.sender] = wager;
            emit Queued(msg.sender, wager);
            return;
        }
        delete waiting[wager];
        delete queuedTier[opponent];
        uint256 id = ++matchCount;
        matches[id] = Match({
            a: opponent,
            b: msg.sender,
            wager: uint96(wager),
            start: uint40(block.timestamp),
            rakeBps: rakeBps,
            done: false
        });
        activeMatch[opponent] = id;
        activeMatch[msg.sender] = id;
        emit MatchMade(id, opponent, msg.sender, wager, block.timestamp);
    }

    /// @notice Leave the queue before you're matched: full refund.
    function leave() external nonReentrant {
        uint256 wager = queuedTier[msg.sender];
        if (wager == 0) revert NotQueued();
        delete queuedTier[msg.sender];
        delete waiting[wager];
        emit Left(msg.sender, wager);
        _pay(msg.sender, wager);
    }

    /// @notice Refund both players of a match the settler didn't settle within SETTLE_WINDOW of its end. Anyone can call.
    function reclaim(uint256 id) external nonReentrant {
        Match storage m = _live(id);
        if (block.timestamp < uint256(m.start) + MATCH_LENGTH + SETTLE_WINDOW) revert TooEarly();
        _refund(id, m);
    }

    /// @notice Collect a payout that couldn't be pushed to you.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert SendFailed();
    }

    // ---------------------------------------------------------------- settler

    /// @notice After the 24 h, pay `winner` (one of the two players) the pot less the rake, or refund both when
    /// `winner` is address(0) (a draw, or nobody qualified). Only before the reclaim window opens.
    function settle(uint256 id, address winner) external nonReentrant {
        if (msg.sender != settler) revert NotSettler();
        Match storage m = _live(id);
        uint256 end = uint256(m.start) + MATCH_LENGTH;
        if (block.timestamp < end) revert TooEarly();
        if (block.timestamp >= end + SETTLE_WINDOW) revert TooLate();
        if (winner == address(0)) {
            _refund(id, m);
            return;
        }
        if (winner != m.a && winner != m.b) revert NotAPlayer();

        m.done = true;
        delete activeMatch[m.a];
        delete activeMatch[m.b];
        uint256 pot = 2 * uint256(m.wager);
        uint256 rake = pot * m.rakeBps / 10_000;
        emit Settled(id, winner, pot - rake, rake);
        _pay(winner, pot - rake);
        if (rake != 0) _pay(treasury, rake);
    }

    // ---------------------------------------------------------------- owner

    function setTier(uint256 wager, bool enabled) external onlyOwner {
        _setTier(wager, enabled);
    }

    function setRake(uint16 bps) external onlyOwner {
        _setRake(bps);
    }

    function setTreasury(address treasury_) external onlyOwner {
        _setTreasury(treasury_);
    }

    function setSettler(address settler_) external onlyOwner {
        _setSettler(settler_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------- internal

    function _live(uint256 id) private view returns (Match storage m) {
        m = matches[id];
        if (m.a == address(0) || m.done) revert NotLive();
    }

    function _refund(uint256 id, Match storage m) private {
        m.done = true;
        delete activeMatch[m.a];
        delete activeMatch[m.b];
        emit Refunded(id);
        _pay(m.a, m.wager);
        _pay(m.b, m.wager);
    }

    /// @dev Push HYPE without copying return data (no return-data bomb); keep it for `withdraw` if it bounces, so one
    /// bad recipient can't block a settle or a refund.
    function _pay(address to, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
        if (!ok) {
            owed[to] += amount;
            emit Owed(to, amount);
        }
    }

    function _setTier(uint256 wager, bool enabled) private {
        if (wager == 0 || wager > type(uint96).max) revert NotTier();
        isTier[wager] = enabled;
        emit TierSet(wager, enabled);
    }

    function _setRake(uint16 bps) private {
        if (bps > MAX_RAKE_BPS) revert BadRake();
        rakeBps = bps;
        emit RakeSet(bps);
    }

    function _setTreasury(address treasury_) private {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function _setSettler(address settler_) private {
        if (settler_ == address(0)) revert ZeroAddress();
        settler = settler_;
        emit SettlerSet(settler_);
    }
}
