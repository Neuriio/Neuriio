// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Trade Arena escrow (TRADE_ARENA.md): 1v1 paper-perps duels for a HYPE wager.
/// No HYPE is held while players wait (user, 2026-10-25): the queue lives off-chain (free to join and leave). When two
/// players are paired, the matchmaker (our server) signs a ticket naming both players, the wager and a deposit
/// deadline. Each player `deposit`s exactly the wager against that ticket; the 24 h match starts the moment the second
/// deposit lands. If the deadline passes before both are in, anyone can `cancel` and whoever deposited is refunded.
/// After 24 h the settler (our server) names the winner, who gets the pot less the rake (taken from the total pot,
/// snapshotted when the ticket is first used), or names nobody (a draw or nobody qualified), and both are refunded with
/// no rake. If the settler hasn't settled within SETTLE_WINDOW of the end, anyone can `reclaim` and both are refunded,
/// so a dead server never locks wagers.
/// One player, one match: you can't deposit while you're in another unfinished match. The owner sets tiers, rake
/// (capped), treasury, matchmaker, settler and pause; it can never move players' HYPE. Pause only stops new deposits:
/// cancel, settle, reclaim and withdraw keep working.
/// Payouts are pushed; a payout that can't be delivered (a recipient that rejects HYPE) is kept for `withdraw`.
contract NeuriioArena is Ownable2Step, Pausable, ReentrancyGuardTransient, EIP712 {
    uint256 public constant MATCH_LENGTH = 24 hours;
    uint256 public constant SETTLE_WINDOW = 48 hours; // after the match ends
    uint256 public constant MAX_RAKE_BPS = 2_000;
    uint256 public constant MAX_DEPOSIT_WINDOW = 10 minutes; // a ticket can't hold a deposit longer than this

    bytes32 public constant TICKET_TYPEHASH =
        keccak256("Ticket(uint256 id,address a,address b,uint256 wager,uint256 deadline)");

    /// @dev signed by the matchmaker when it pairs two queued players
    struct Ticket {
        uint256 id;
        address a;
        address b;
        uint256 wager;
        uint256 deadline; // last second either player can deposit
    }

    struct Match {
        address a;
        address b;
        uint96 wager;
        uint40 deadline;
        uint40 start; // 0 until both have deposited
        uint16 rakeBps;
        bool aIn;
        bool bIn;
        bool done;
    }

    address public treasury;
    address public matchmaker;
    address public settler;
    uint16 public rakeBps;

    mapping(uint256 wager => bool) public isTier;
    mapping(address player => uint256) public activeMatch; // the unfinished match they deposited into; 0 = none
    mapping(address => uint256) public owed; // payouts that couldn't be pushed
    mapping(uint256 id => Match) public matches; // ids are chosen by the matchmaker, never 0

    event TierSet(uint256 wager, bool enabled);
    event RakeSet(uint16 bps);
    event TreasurySet(address treasury);
    event MatchmakerSet(address matchmaker);
    event SettlerSet(address settler);
    event Deposited(uint256 indexed id, address indexed player, uint256 wager);
    event MatchStarted(uint256 indexed id, address indexed a, address indexed b, uint256 wager, uint256 start);
    event Cancelled(uint256 indexed id);
    event Settled(uint256 indexed id, address indexed winner, uint256 payout, uint256 rake);
    event Refunded(uint256 indexed id);
    event Owed(address indexed to, uint256 amount);

    error NotTier();
    error BadTicket();
    error Expired();
    error NotAPlayer();
    error WrongAmount();
    error AlreadyIn();
    error Busy();
    error NotSettler();
    error NotLive();
    error NotStarted();
    error TooEarly();
    error TooLate();
    error BadRake();
    error ZeroAddress();
    error NothingOwed();
    error SendFailed();

    constructor(
        address owner_,
        address treasury_,
        address matchmaker_,
        address settler_,
        uint16 rakeBps_,
        uint256[] memory tiers
    ) Ownable(owner_) EIP712("NeuriioArena", "1") {
        _setTreasury(treasury_);
        _setMatchmaker(matchmaker_);
        _setSettler(settler_);
        _setRake(rakeBps_);
        for (uint256 i; i < tiers.length; i++) {
            _setTier(tiers[i], true);
        }
    }

    // ---------------------------------------------------------------- players

    /// @notice Put in your wager for a match the matchmaker paired you into. The match starts when both are in.
    function deposit(Ticket calldata t, bytes calldata sig) external payable nonReentrant whenNotPaused {
        if (msg.sender != t.a && msg.sender != t.b) revert NotAPlayer();
        if (block.timestamp > t.deadline) revert Expired();
        if (msg.value != t.wager) revert WrongAmount();
        uint256 current = activeMatch[msg.sender];
        if (current == t.id) revert AlreadyIn();
        if (current != 0) revert Busy();

        Match storage m = matches[t.id];
        if (m.a == address(0)) {
            // first deposit against this ticket: check it and record the match
            if (t.id == 0 || t.a == t.b || t.a == address(0) || t.b == address(0)) revert BadTicket();
            if (t.deadline > block.timestamp + MAX_DEPOSIT_WINDOW) revert BadTicket();
            if (!isTier[t.wager]) revert NotTier();
            if (ECDSA.recover(hashTicket(t), sig) != matchmaker) revert BadTicket();
            m.a = t.a;
            m.b = t.b;
            m.wager = uint96(t.wager);
            m.deadline = uint40(t.deadline);
            m.rakeBps = rakeBps;
        } else if (m.a != t.a || m.b != t.b || m.wager != t.wager || m.deadline != t.deadline || m.done) {
            revert BadTicket(); // the second player must use the same ticket, while it's still open
        }

        bool isA = msg.sender == m.a;
        if (isA) m.aIn = true;
        else m.bIn = true;
        activeMatch[msg.sender] = t.id;
        emit Deposited(t.id, msg.sender, t.wager);

        if (m.aIn && m.bIn) {
            m.start = uint40(block.timestamp);
            emit MatchStarted(t.id, m.a, m.b, t.wager, block.timestamp);
        }
    }

    /// @notice After a ticket's deadline, if the match never started: refund whoever deposited. Anyone can call.
    function cancel(uint256 id) external nonReentrant {
        Match storage m = matches[id];
        if (m.a == address(0) || m.done || m.start != 0) revert NotLive();
        if (block.timestamp <= m.deadline) revert TooEarly();
        m.done = true;
        emit Cancelled(id);
        if (m.aIn) {
            delete activeMatch[m.a];
            _pay(m.a, m.wager);
        }
        if (m.bIn) {
            delete activeMatch[m.b];
            _pay(m.b, m.wager);
        }
    }

    /// @notice Refund both players of a match the settler didn't settle within SETTLE_WINDOW of its end. Anyone can call.
    function reclaim(uint256 id) external nonReentrant {
        Match storage m = _started(id);
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

    /// @notice A match as one struct (the app and the watcher read this).
    function getMatch(uint256 id) external view returns (Match memory) {
        return matches[id];
    }

    /// @notice The EIP-712 digest the matchmaker signs for a ticket.
    function hashTicket(Ticket calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TICKET_TYPEHASH, t.id, t.a, t.b, t.wager, t.deadline)));
    }

    // ---------------------------------------------------------------- settler

    /// @notice After the 24 h, pay `winner` (one of the two players) the pot less the rake, or refund both when
    /// `winner` is address(0) (a draw, or nobody qualified). Only before the reclaim window opens.
    function settle(uint256 id, address winner) external nonReentrant {
        if (msg.sender != settler) revert NotSettler();
        Match storage m = _started(id);
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

    function setMatchmaker(address matchmaker_) external onlyOwner {
        _setMatchmaker(matchmaker_);
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

    function _started(uint256 id) private view returns (Match storage m) {
        m = matches[id];
        if (m.a == address(0) || m.done) revert NotLive();
        if (m.start == 0) revert NotStarted();
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
    /// bad recipient can't block a settle, a refund or a cancel.
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

    function _setMatchmaker(address matchmaker_) private {
        if (matchmaker_ == address(0)) revert ZeroAddress();
        matchmaker = matchmaker_;
        emit MatchmakerSet(matchmaker_);
    }

    function _setSettler(address settler_) private {
        if (settler_ == address(0)) revert ZeroAddress();
        settler = settler_;
        emit SettlerSet(settler_);
    }
}
