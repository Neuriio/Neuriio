// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Partner staking (user, 2026-11-07): NeuriioTokenStaking for tokens launched ELSEWHERE (e.g. on Ascend's own site)
/// and traded through NeuriioSwap. The only change from NeuriioTokenStaking: which tokens can be staked is an approved list
/// kept by the owner (the timelock the Neuriio Safe runs), not "launched through Neuriio". The fee router pays 40% of our swap
/// fee on each listed token into its pool, in USDC.
/// Delisting stops new stakes and new rewards only: unstake and claim never check the list, so stakers can always leave with
/// their tokens and everything already paid in (what was dripping keeps dripping to them). The owner can't move anyone's
/// tokens or USDC: listing is all it can do. Vet each token before listing it: no rebasing tokens (balances that change on
/// their own break the books); fee-on-transfer tokens are counted by what arrived.
///
/// Below, unchanged from NeuriioTokenStaking: Staking for a share of trading fees, in USDC. One pool per listed token.
/// Stake or unstake any amount at any time, no lockup, and claim whenever you like. Rewards don't land in one go: each
/// payment drips out over `DRIP` (1 hour) to whoever is staked while it drips, so nobody can stake for a moment, catch a big
/// fee and leave. If everyone unstakes mid-drip, the rest waits for the next stakers.
/// It holds users' staked tokens; nobody can move them, the owner included.
contract NeuriioPartnerStaking is ReentrancyGuardTransient, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant DRIP = 1 hours;
    uint256 internal constant RATE = 1e18; // drip rate scale
    uint256 internal constant ACC = 1e36; // reward-per-token scale (staked amounts reach ~1e27)

    struct Pool {
        uint256 totalStaked;
        uint256 rate; // USDC base units per second x RATE, while dripping
        uint256 acc; // USDC base units earned per staked token-wei so far x ACC
        uint64 lastUpdate;
        uint64 end; // when the current drip runs out
    }

    struct Position {
        uint256 amount;
        uint256 accPaid; // the pool's acc when `owed` was last brought up to date
        uint256 owed; // earned, not yet claimed
    }

    IERC20 public immutable quote; // USDC: what rewards are paid in
    mapping(address token => bool) public listed;

    mapping(address token => Pool) internal _pools;
    mapping(address user => mapping(address token => Position)) internal _positions;

    event Staked(address indexed user, address indexed token, uint256 amount);
    event Unstaked(address indexed user, address indexed token, uint256 amount);
    event Claimed(address indexed user, address indexed token, address to, uint256 usdc);
    event RewardAdded(address indexed token, uint256 amount, uint256 dripEnd);
    event Listed(address indexed token, bool listed);

    error NotStakeable(address token);
    error ZeroAmount();
    error InsufficientStake();
    error NothingToClaim();

    constructor(IERC20 quote_, address owner_) Ownable(owner_) {
        quote = quote_;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Lists `token` for staking and rewards, or delists it (new stakes and rewards stop; unstake and claim don't).
    /// USDC itself can't be listed: staked USDC would sit in the same balance as the rewards.
    function setListed(address token, bool listed_) external onlyOwner {
        if (listed_ && token == address(quote)) revert NotStakeable(token);
        listed[token] = listed_;
        emit Listed(token, listed_);
    }

    // ------------------------------------------------------------------ staking

    /// @notice Stake `amount` of `token` (needs an approval).
    function stake(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (!isStakeable(token)) revert NotStakeable(token);
        Pool storage p = _pools[token];
        Position storage pos = _positions[msg.sender][token];
        _update(p);
        _settle(p, pos);
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        pos.amount += received;
        p.totalStaked += received;
        emit Staked(msg.sender, token, received);
    }

    /// @notice Unstake `amount` of `token` back to your wallet. Rewards earned so far stay claimable.
    function unstake(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Pool storage p = _pools[token];
        Position storage pos = _positions[msg.sender][token];
        if (amount > pos.amount) revert InsufficientStake();
        _update(p);
        _settle(p, pos);
        pos.amount -= amount;
        p.totalStaked -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, token, amount);
    }

    /// @notice Claims what you've earned in the pools of `tokens`, to `to` in one transfer.
    function claim(address[] calldata tokens, address to) external nonReentrant returns (uint256 usdc) {
        for (uint256 i; i < tokens.length; ++i) {
            Pool storage p = _pools[tokens[i]];
            Position storage pos = _positions[msg.sender][tokens[i]];
            _update(p);
            _settle(p, pos);
            uint256 owed = pos.owed;
            if (owed == 0) continue;
            pos.owed = 0;
            usdc += owed;
            emit Claimed(msg.sender, tokens[i], to, owed);
        }
        if (usdc == 0) revert NothingToClaim();
        quote.safeTransfer(to, usdc);
    }

    // ------------------------------------------------------------------ rewards

    /// @notice Pulls `amount` USDC from the caller (needs an approval) into `token`'s pool, to drip out over the next
    /// `DRIP` together with whatever was still dripping. Open to anyone: whoever pays decides which token's stakers get it.
    function notifyReward(address token, uint256 amount) external nonReentrant {
        if (amount == 0) return;
        if (!isStakeable(token)) revert NotStakeable(token);
        Pool storage p = _pools[token];
        _update(p);
        quote.safeTransferFrom(msg.sender, address(this), amount);
        uint256 leftover = p.end > block.timestamp ? (p.end - block.timestamp) * p.rate : 0;
        p.rate = (amount * RATE + leftover) / DRIP;
        p.end = uint64(block.timestamp + DRIP);
        emit RewardAdded(token, amount, block.timestamp + DRIP);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether `token` can be staked (and paid rewards): the owner listed it.
    function isStakeable(address token) public view returns (bool) {
        return listed[token];
    }

    function totalStaked(address token) external view returns (uint256) {
        return _pools[token].totalStaked;
    }

    function stakedOf(address user, address token) external view returns (uint256) {
        return _positions[user][token].amount;
    }

    /// @notice USDC `user` has earned in `token`'s pool and not yet claimed, up to this second.
    function earned(address user, address token) public view returns (uint256) {
        Pool storage p = _pools[token];
        Position storage pos = _positions[user][token];
        return pos.owed + Math.mulDiv(pos.amount, _accNow(p) - pos.accPaid, ACC);
    }

    /// @notice USDC still to drip out of `token`'s pool. With nobody staked the drip is on hold since its last update, so
    /// all of that is still to come.
    function dripping(address token) external view returns (uint256) {
        Pool storage p = _pools[token];
        uint256 from = p.totalStaked == 0 ? p.lastUpdate : block.timestamp;
        return p.end > from ? (p.end - from) * p.rate / RATE : 0;
    }

    // ------------------------------------------------------------------ internals

    /// Brings the pool's reward-per-token up to now. With nobody staked nothing is earned: the drip end moves out by the
    /// time that passed, so the rest of the drip goes to the next stakers instead of being lost.
    function _update(Pool storage p) internal {
        uint256 last = p.lastUpdate;
        if (block.timestamp == last) return;
        if (p.end > last) {
            if (p.totalStaked == 0) {
                p.end = uint64(block.timestamp + p.end - last);
            } else {
                p.acc = _accNow(p);
            }
        }
        p.lastUpdate = uint64(block.timestamp);
    }

    function _accNow(Pool storage p) internal view returns (uint256) {
        uint256 end = Math.min(block.timestamp, p.end);
        if (end <= p.lastUpdate || p.totalStaked == 0) return p.acc;
        return p.acc + Math.mulDiv((end - p.lastUpdate) * p.rate, ACC / RATE, p.totalStaked);
    }

    function _settle(Pool storage p, Position storage pos) internal {
        uint256 acc = p.acc;
        if (pos.amount > 0) pos.owed += Math.mulDiv(pos.amount, acc - pos.accPaid, ACC);
        pos.accPaid = acc;
    }
}
