// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapFactory} from "../swap/interfaces.sol";
import {NeuriioRegistry} from "./NeuriioRegistry.sol";
import {NeuriioStaking} from "../stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../stake/NeuriioMinter.sol";

/// @notice Every fee a launched token generates lands here, in USDC, and is shared out at once. Every trade pays 1%:
///   - curve trades: the NeuriioPad's fee
///   - graduated pool swaps: the pair's fee, taken out of the pool
/// The split (user, 2026-10-17; constants on purpose, no owner knob over anyone's income):
///   - curve fee: 80% to $NEURIIO stakers, 10% to the KNTQ buyback wallet, 10% to the treasury
///   - pool fee:  40% to $NEURIIO stakers, 40% to whoever stakes that token, 10% to the creator(s), 10% to the treasury
/// Stakers' shares go straight to NeuriioStaking, where they drip out over an hour; the token stakers' share also mints
/// $NEURIIO for them (NeuriioMinter, told about every fee). A share with nobody to take it moves down the line: a token's
/// stakers' share goes to $NEURIIO stakers while nobody stakes that token, and the $NEURIIO stakers' share goes to the
/// treasury while nobody stakes $NEURIIO (or if NeuriioStaking ever fails, so trading never stops because of staking).
/// An FTF's creator share is split equally between its 4 members; creators claim any time. The treasury and buyback
/// shares wait here until both wallets are set, then anyone can `payProtocol()`.
/// Fees arrive as a USDC transfer followed by a notify, so the vault credits whatever it holds above what it already
/// owes (`held`). Changing the split means deploying a new NeuriioFees (script/replace-feevault.sh), which is public and
/// leaves old balances claimable.
/// Part of the permanent core: it serves every NeuriioPad version (a curve fee is accepted only from the token's own
/// NeuriioPad, per the NeuriioRegistry, which also names the creators to pay).
contract NeuriioFees is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant CURVE_STAKERS_BPS = 8_000;
    uint256 public constant CURVE_BUYBACK_BPS = 1_000;
    uint256 public constant POOL_HOLDERS_BPS = 4_000; // that token's stakers
    uint256 public constant POOL_STAKERS_BPS = 4_000;
    uint256 public constant POOL_CREATOR_BPS = 1_000;
    uint256 public constant TREASURY_BPS = 1_000; // curve and pool

    struct Shares {
        uint256 creator;
        uint256 holders;
        uint256 stakers;
        uint256 treasury;
        uint256 buyback;
    }

    IERC20 public immutable quote; // USDC
    ISwapFactory public immutable factory;
    NeuriioRegistry public immutable registry;
    NeuriioStaking public immutable staking;
    NeuriioMinter public immutable minter;
    address public immutable neuriio; // the $NEURIIO token (its staking pool)

    mapping(address creator => uint256) public creatorBalance;
    mapping(address token => uint256) public feesOf; // lifetime fees, per token
    mapping(address token => uint256) public creatorEarned; // lifetime, per token (for the UI)
    mapping(address token => uint256) public holdersEarned; // lifetime, per token: paid to that token's stakers
    uint256 public totalFees; // lifetime, every token (the platform-fees widget)
    uint256 public stakersEarned; // lifetime: paid to $NEURIIO stakers
    uint256 public treasuryBalance;
    uint256 public buybackBalance;
    uint256 public held; // USDC owed to creators, the treasury and the buyback; anything above it just arrived
    address public treasuryWallet;
    address public buybackWallet;

    event FeeCredited(
        address indexed token,
        address indexed creator,
        uint256 total,
        uint256 toCreator,
        uint256 toHolders,
        uint256 toStakers,
        uint256 toTreasury,
        uint256 toBuyback,
        bool fromPool
    );
    event CreatorClaimed(address indexed creator, address indexed to, uint256 amount);
    event ProtocolPaid(address treasury, uint256 treasuryAmount, address buyback, uint256 buybackAmount);
    event WalletsSet(address treasury, address buyback);
    event StakingFailed(address indexed token, uint256 amount);
    event MinterFailed(address indexed token, uint256 fee);

    error NotLaunchpad();
    error NotPair();
    error UnknownToken(address token);
    error WalletsNotSet();
    error InvalidParams();
    error NothingToClaim();

    constructor(
        address owner_,
        IERC20 quote_,
        ISwapFactory factory_,
        NeuriioRegistry registry_,
        NeuriioStaking staking_,
        NeuriioMinter minter_
    ) Ownable(owner_) {
        quote = quote_;
        factory = factory_;
        registry = registry_;
        staking = staking_;
        minter = minter_;
        neuriio = address(staking_.neuriio());
        quote_.forceApprove(address(staking_), type(uint256).max); // staking pulls each stakers' share
    }

    // ------------------------------------------------------------------ fee intake

    /// @notice Curve fee: the token's own NeuriioPad (any version, approved or retired) transfers USDC here, then calls
    /// this. Credits whatever arrived.
    function notifyCurveFee(address token) external nonReentrant {
        if (msg.sender != registry.launchpadOf(token) || msg.sender == address(0)) revert NotLaunchpad();
        _intake(token, false);
    }

    /// @notice Pool fee: the token's pair transfers USDC here, then calls this. Credits whatever arrived.
    function notifyPoolFee(address token) external nonReentrant {
        if (msg.sender != factory.getPair(token, address(quote)) || msg.sender == address(0)) revert NotPair();
        _intake(token, true);
    }

    // ------------------------------------------------------------------ payouts

    /// @notice Creator withdraws their accrued fees (from every token they launched).
    function claim(address to) external nonReentrant returns (uint256 amount) {
        amount = creatorBalance[msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorBalance[msg.sender] = 0;
        held -= amount;
        emit CreatorClaimed(msg.sender, to, amount);
        quote.safeTransfer(to, amount);
    }

    /// @notice Sends the treasury and buyback shares to their wallets. Anyone can call it.
    function payProtocol() external nonReentrant {
        (address t, address b) = (treasuryWallet, buybackWallet);
        if (t == address(0) || b == address(0)) revert WalletsNotSet();
        (uint256 ta, uint256 ba) = (treasuryBalance, buybackBalance);
        treasuryBalance = 0;
        buybackBalance = 0;
        held -= ta + ba;
        emit ProtocolPaid(t, ta, b, ba);
        if (ta > 0) quote.safeTransfer(t, ta);
        if (ba > 0) quote.safeTransfer(b, ba);
    }

    // ------------------------------------------------------------------ owner

    function setWallets(address treasury, address buyback) external onlyOwner {
        if (treasury == address(0) || buyback == address(0)) revert InvalidParams();
        treasuryWallet = treasury;
        buybackWallet = buyback;
        emit WalletsSet(treasury, buyback);
    }

    // ------------------------------------------------------------------ internals

    function _intake(address token, bool fromPool) internal {
        uint256 amount = quote.balanceOf(address(this)) - held;
        if (amount == 0) return;
        address[] memory creators = registry.creatorsOf(token);
        if (creators.length == 0) revert UnknownToken(token);
        Shares memory s;
        s.treasury = amount * TREASURY_BPS / 10_000;
        if (fromPool) {
            s.creator = amount * POOL_CREATOR_BPS / 10_000;
            s.holders = amount * POOL_HOLDERS_BPS / 10_000;
        } else {
            s.buyback = amount * CURVE_BUYBACK_BPS / 10_000;
        }
        s.stakers = amount - s.treasury - s.creator - s.holders - s.buyback;
        if (s.creator > 0) _payCreators(token, creators, s.creator);
        _payStakers(token, s);
        treasuryBalance += s.treasury;
        buybackBalance += s.buyback;
        held += s.creator + s.treasury + s.buyback;
        feesOf[token] += amount;
        totalFees += amount;
        try minter.onFee(token, amount, s.holders) {}
        catch {
            emit MinterFailed(token, amount);
        }
        emit FeeCredited(token, creators[0], amount, s.creator, s.holders, s.stakers, s.treasury, s.buyback, fromPool);
    }

    /// Equal shares; the rounding remainder (a few base units) goes to the first (the creator / an FTF's founder).
    function _payCreators(address token, address[] memory creators, uint256 toCreator) internal {
        uint256 share = toCreator / creators.length;
        for (uint256 i; i < creators.length; ++i) {
            creatorBalance[creators[i]] += share;
        }
        creatorBalance[creators[0]] += toCreator - share * creators.length;
        creatorEarned[token] += toCreator;
    }

    /// Hands the holders' share to that token's stakers and the stakers' share to $NEURIIO stakers; a share with nobody
    /// to take it moves down the line (holders' -> $NEURIIO stakers -> treasury). Updates `s` to what each actually got.
    function _payStakers(address token, Shares memory s) internal {
        if (s.holders > 0) {
            if (_reward(token, s.holders)) {
                holdersEarned[token] += s.holders;
            } else {
                s.stakers += s.holders;
                s.holders = 0;
            }
        }
        if (s.stakers > 0) {
            if (_reward(neuriio, s.stakers)) {
                stakersEarned += s.stakers;
            } else {
                s.treasury += s.stakers;
                s.stakers = 0;
            }
        }
    }

    /// NeuriioStaking pulls `amount` into `token`'s pool; false (USDC kept here) if nobody is staked or staking fails.
    function _reward(address token, uint256 amount) internal returns (bool) {
        try staking.totalStaked(token) returns (uint256 staked) {
            if (staked == 0) return false;
        } catch {
            emit StakingFailed(token, amount);
            return false;
        }
        try staking.notifyReward(token, amount) {
            return true;
        } catch {
            emit StakingFailed(token, amount);
            return false;
        }
    }
}
