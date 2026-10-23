// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapFactory} from "../swap/interfaces.sol";
import {NeuriioPlatformToken} from "./NeuriioPlatformToken.sol";

/// @notice Staking for a share of trading fees. One pool per staked token:
///   - every GRADUATED launched token (an X account or an FTF): its stakers share 40% of every fee that token's pool
///     takes, in USDC, and the $NEURIIO those fees mint (NeuriioMinter: 10 per $1 at launch). A token still on its
///     bonding curve can't be staked yet (staking opens at graduation).
///   - $NEURIIO (NeuriioPlatformToken, deployed by this contract): its stakers share, in USDC, 50% of every curve fee and
///     40% of every pool fee, across all tokens. Staking $NEURIIO mints nothing.
/// Stake or unstake any amount at any time, no lockup, and claim whenever you like: USDC goes to your wallet, $NEURIIO
/// is staked for you. Rewards don't land in one go: each payment drips out over `DRIP` (1 hour) to whoever is staked while
/// it drips, so nobody can stake for a moment, catch a big fee and leave. If everyone unstakes mid-drip, the rest waits
/// for the next stakers.
/// Part of the permanent core: it holds users' staked tokens, so it has no owner and nobody can move them.
contract NeuriioStaking is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant DRIP = 1 hours;
    uint256 internal constant RATE = 1e18; // drip rate scale
    uint256 internal constant ACC = 1e36; // reward-per-token scale (staked amounts reach ~1e27)
    uint256 internal constant USDC = 0; // reward streams
    uint256 internal constant NEU = 1;

    struct Drip {
        uint256 rate; // reward base units per second x RATE, while dripping
        uint256 acc; // reward base units earned per staked token-wei so far x ACC
        uint64 lastUpdate;
        uint64 end; // when the current drip runs out
    }

    struct Pool {
        uint256 totalStaked;
        bool open; // stakeable; sticky (a graduated token stays graduated)
        Drip[2] drips; // [USDC, $NEURIIO]
    }

    struct Position {
        uint256 amount;
        uint256[2] accPaid; // each drip's acc when `owed` was last brought up to date
        uint256[2] owed; // earned, not yet claimed
    }

    ISwapFactory public immutable factory;
    IERC20 public immutable quote; // USDC: what fees are paid in, and what every pool is priced in
    NeuriioPlatformToken public immutable neuriio;

    mapping(address token => Pool) internal _pools;
    mapping(address user => mapping(address token => Position)) internal _positions;

    event Staked(address indexed user, address indexed token, uint256 amount);
    event Unstaked(address indexed user, address indexed token, uint256 amount);
    event Claimed(address indexed user, address indexed token, address to, uint256 usdc, uint256 neuriio);
    event RewardAdded(address indexed token, uint256 amount, uint256 dripEnd);
    event NeuriioAdded(address indexed token, uint256 amount, uint256 dripEnd);

    error NotStakeable(address token);
    error NotMinter();
    error ZeroAmount();
    error InsufficientStake();
    error NothingToClaim();

    /// @param neuriioOwner owns the $NEURIIO token (sets its minter, can open transfers later)
    constructor(ISwapFactory factory_, IERC20 quote_, address neuriioOwner) {
        factory = factory_;
        quote = quote_;
        neuriio = new NeuriioPlatformToken(neuriioOwner);
    }

    // ------------------------------------------------------------------ staking

    /// @notice Stake `amount` of `token` (needs an approval, except for $NEURIIO, which is pre-approved).
    function stake(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Pool storage p = _openPool(token);
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

    /// @notice Claims what you've earned in the pools of `tokens`: the USDC goes to `to` in one transfer, the $NEURIIO
    /// is added to your $NEURIIO stake (where it earns its share of the platform's fees right away).
    function claim(address[] calldata tokens, address to) external nonReentrant returns (uint256 usdc, uint256 neu) {
        for (uint256 i; i < tokens.length; ++i) {
            Pool storage p = _pools[tokens[i]];
            Position storage pos = _positions[msg.sender][tokens[i]];
            _update(p);
            _settle(p, pos);
            (uint256 u, uint256 n) = (pos.owed[USDC], pos.owed[NEU]);
            if (u + n == 0) continue;
            pos.owed[USDC] = 0;
            pos.owed[NEU] = 0;
            usdc += u;
            neu += n;
            emit Claimed(msg.sender, tokens[i], to, u, n);
        }
        if (usdc + neu == 0) revert NothingToClaim();
        if (neu > 0) {
            Pool storage np = _openPool(address(neuriio));
            Position storage npos = _positions[msg.sender][address(neuriio)];
            _update(np);
            _settle(np, npos);
            npos.amount += neu;
            np.totalStaked += neu;
            emit Staked(msg.sender, address(neuriio), neu);
        }
        if (usdc > 0) quote.safeTransfer(to, usdc);
    }

    // ------------------------------------------------------------------ rewards

    /// @notice Pulls `amount` USDC from the caller (needs an approval) into `token`'s pool, to drip out over the next
    /// `DRIP` together with whatever was still dripping. Called by the NeuriioFees on every fee it shares; open to anyone.
    function notifyReward(address token, uint256 amount) external {
        if (amount == 0) return;
        Pool storage p = _openPool(token);
        _update(p);
        quote.safeTransferFrom(msg.sender, address(this), amount);
        _addToDrip(p.drips[USDC], amount);
        emit RewardAdded(token, amount, block.timestamp + DRIP);
    }

    /// @notice The NeuriioMinter (the $NEURIIO token's minter) has minted `amount` $NEURIIO to this contract for the
    /// stakers of the X token `token`: it drips out to them alongside their USDC.
    function notifyNeuriio(address token, uint256 amount) external {
        if (msg.sender != neuriio.minter()) revert NotMinter();
        if (token == address(neuriio)) revert NotStakeable(token); // staking $NEURIIO mints nothing
        if (amount == 0) return;
        Pool storage p = _openPool(token);
        _update(p);
        _addToDrip(p.drips[NEU], amount);
        emit NeuriioAdded(token, amount, block.timestamp + DRIP);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether `token` can be staked: $NEURIIO, or a launched token that has graduated. Only a token's own
    /// NeuriioPad can create its pool, and only at graduation (src/swap/v2/UniswapV2Factory.sol), so a pool means both.
    function isStakeable(address token) public view returns (bool) {
        return _pools[token].open || token == address(neuriio) || factory.getPair(token, address(quote)) != address(0);
    }

    function totalStaked(address token) external view returns (uint256) {
        return _pools[token].totalStaked;
    }

    function stakedOf(address user, address token) external view returns (uint256) {
        return _positions[user][token].amount;
    }

    /// @notice USDC and $NEURIIO `user` has earned in `token`'s pool and not yet claimed, up to this second.
    function earned(address user, address token) public view returns (uint256 usdc, uint256 neu) {
        Pool storage p = _pools[token];
        Position storage pos = _positions[user][token];
        usdc = pos.owed[USDC] + Math.mulDiv(pos.amount, _accNow(p.drips[USDC], p.totalStaked) - pos.accPaid[USDC], ACC);
        neu = pos.owed[NEU] + Math.mulDiv(pos.amount, _accNow(p.drips[NEU], p.totalStaked) - pos.accPaid[NEU], ACC);
    }

    /// @notice USDC and $NEURIIO still to drip out of `token`'s pool.
    function dripping(address token) external view returns (uint256 usdc, uint256 neu) {
        Pool storage p = _pools[token];
        return (_remaining(p.drips[USDC], p.totalStaked), _remaining(p.drips[NEU], p.totalStaked));
    }

    // ------------------------------------------------------------------ internals

    function _openPool(address token) internal returns (Pool storage p) {
        p = _pools[token];
        if (!p.open) {
            if (!isStakeable(token)) revert NotStakeable(token);
            p.open = true;
            p.drips[USDC].lastUpdate = uint64(block.timestamp);
            p.drips[NEU].lastUpdate = uint64(block.timestamp);
        }
    }

    function _update(Pool storage p) internal {
        _updateDrip(p.drips[USDC], p.totalStaked);
        _updateDrip(p.drips[NEU], p.totalStaked);
    }

    /// Brings a drip's reward-per-token up to now. With nobody staked nothing is earned: the drip end moves out by the
    /// time that passed, so the rest of the drip goes to the next stakers instead of being lost.
    function _updateDrip(Drip storage d, uint256 staked) internal {
        uint256 last = d.lastUpdate;
        if (block.timestamp == last) return;
        if (d.end > last) {
            if (staked == 0) {
                d.end = uint64(block.timestamp + d.end - last);
            } else {
                d.acc = _accNow(d, staked);
            }
        }
        d.lastUpdate = uint64(block.timestamp);
    }

    /// Adds `amount` to what's still dripping, all of it to drip out over the next DRIP. Call after _update.
    function _addToDrip(Drip storage d, uint256 amount) internal {
        uint256 leftover = d.end > block.timestamp ? (d.end - block.timestamp) * d.rate : 0;
        d.rate = (amount * RATE + leftover) / DRIP;
        d.end = uint64(block.timestamp + DRIP);
    }

    function _accNow(Drip storage d, uint256 staked) internal view returns (uint256) {
        uint256 end = Math.min(block.timestamp, d.end);
        if (end <= d.lastUpdate || staked == 0) return d.acc;
        return d.acc + Math.mulDiv((end - d.lastUpdate) * d.rate, ACC / RATE, staked);
    }

    /// With nobody staked the drip is on hold since its last update, so all of that is still to come.
    function _remaining(Drip storage d, uint256 staked) internal view returns (uint256) {
        uint256 from = staked == 0 ? d.lastUpdate : block.timestamp;
        return d.end > from ? (d.end - from) * d.rate / RATE : 0;
    }

    function _settle(Pool storage p, Position storage pos) internal {
        for (uint256 i; i < 2; ++i) {
            uint256 acc = p.drips[i].acc;
            if (pos.amount > 0) pos.owed[i] += Math.mulDiv(pos.amount, acc - pos.accPaid[i], ACC);
            pos.accPaid[i] = acc;
        }
    }
}
