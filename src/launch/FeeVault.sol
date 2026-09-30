// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapFactory, IWHYPE} from "../swap/interfaces.sol";
import {LaunchRegistry} from "./LaunchRegistry.sol";

/// @notice Every fee a launched token generates lands here, in HYPE (an FTF's creator share is split equally between
/// its 4 members):
///   - curve trades: the Launchpad's fee (0.75%), sent with each trade
///   - graduated pool swaps: the pair's 0.25%, taken out as WHYPE and unwrapped here
/// 80% is credited to the token's creator (claim any time); 20% goes to the protocol, split between the
/// community-rewards wallet (60%) and the KNTQ buyback wallet (40%). The creator share is fixed; the protocol
/// split and wallets are owner-set, and the protocol share waits here until both wallets are set.
/// Part of the permanent core: it serves every Launchpad version (a curve fee is accepted only from the token's own
/// Launchpad, per the LaunchRegistry, which also names the creators to pay).
contract FeeVault is Ownable2Step, ReentrancyGuard {
    uint256 public constant CREATOR_BPS = 8_000;

    IWHYPE public immutable whype;
    ISwapFactory public immutable factory;
    LaunchRegistry public immutable registry;

    mapping(address creator => uint256) public creatorBalance;
    mapping(address token => uint256) public creatorEarned; // lifetime, per token (for the UI)
    uint256 public communityBalance;
    uint256 public buybackBalance;
    uint16 public communityBps = 6_000; // of the protocol share; the rest is buyback
    address public communityWallet;
    address public buybackWallet;

    event FeeCredited(address indexed token, address indexed creator, uint256 total, uint256 toCreator, bool fromPool);
    event CreatorClaimed(address indexed creator, address indexed to, uint256 amount);
    event ProtocolPaid(address community, uint256 communityAmount, address buyback, uint256 buybackAmount);
    event WalletsSet(address community, address buyback);
    event CommunityBpsSet(uint16 bps);

    error NotLaunchpad();
    error NotPair();
    error UnknownToken(address token);
    error WalletsNotSet();
    error InvalidParams();
    error NothingToClaim();
    error HypeTransferFailed();
    error UnexpectedHype();

    constructor(address owner_, IWHYPE whype_, ISwapFactory factory_, LaunchRegistry registry_) Ownable(owner_) {
        whype = whype_;
        factory = factory_;
        registry = registry_;
    }

    /// Only WHYPE unwrapping sends plain HYPE here.
    receive() external payable {
        if (msg.sender != address(whype)) revert UnexpectedHype();
    }

    // ------------------------------------------------------------------ fee intake

    /// @notice Curve fee from the token's own Launchpad (any version, approved or retired), in native HYPE.
    function depositCurveFee(address token) external payable {
        if (msg.sender != registry.launchpadOf(token) || msg.sender == address(0)) revert NotLaunchpad();
        _credit(token, msg.value, false);
    }

    /// @notice Pool fee: the token's pair transfers WHYPE here, then calls this. Credits whatever arrived.
    function notifyPoolFee(address token) external nonReentrant {
        if (msg.sender != factory.getPair(token, address(whype)) || msg.sender == address(0)) revert NotPair();
        // the vault never holds WHYPE between calls (it unwraps right away), so the balance is what just arrived
        uint256 received = IERC20(address(whype)).balanceOf(address(this));
        if (received == 0) return;
        whype.withdraw(received);
        _credit(token, received, true);
    }

    // ------------------------------------------------------------------ payouts

    /// @notice Creator withdraws their accrued fees (from every token they launched).
    function claim(address to) external nonReentrant returns (uint256 amount) {
        amount = creatorBalance[msg.sender];
        if (amount == 0) revert NothingToClaim();
        creatorBalance[msg.sender] = 0;
        emit CreatorClaimed(msg.sender, to, amount);
        _send(to, amount);
    }

    /// @notice Sends the protocol share to the community and buyback wallets. Anyone can call it.
    function payProtocol() external nonReentrant {
        (address c, address b) = (communityWallet, buybackWallet);
        if (c == address(0) || b == address(0)) revert WalletsNotSet();
        (uint256 ca, uint256 ba) = (communityBalance, buybackBalance);
        communityBalance = 0;
        buybackBalance = 0;
        emit ProtocolPaid(c, ca, b, ba);
        if (ca > 0) _send(c, ca);
        if (ba > 0) _send(b, ba);
    }

    // ------------------------------------------------------------------ owner

    function setWallets(address community, address buyback) external onlyOwner {
        if (community == address(0) || buyback == address(0)) revert InvalidParams();
        communityWallet = community;
        buybackWallet = buyback;
        emit WalletsSet(community, buyback);
    }

    function setCommunityBps(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert InvalidParams();
        communityBps = bps;
        emit CommunityBpsSet(bps);
    }

    // ------------------------------------------------------------------ internals

    function _credit(address token, uint256 amount, bool fromPool) internal {
        if (amount == 0) return;
        address[] memory creators = registry.creatorsOf(token);
        if (creators.length == 0) revert UnknownToken(token);
        uint256 toCreator = amount * CREATOR_BPS / 10_000;
        uint256 protocol = amount - toCreator;
        uint256 toCommunity = protocol * communityBps / 10_000;
        // equal shares; the rounding remainder (a few wei) goes to the first (the creator / an FTF's founder)
        uint256 share = toCreator / creators.length;
        for (uint256 i; i < creators.length; ++i) creatorBalance[creators[i]] += share;
        creatorBalance[creators[0]] += toCreator - share * creators.length;
        creatorEarned[token] += toCreator;
        communityBalance += toCommunity;
        buybackBalance += protocol - toCommunity;
        emit FeeCredited(token, creators[0], amount, toCreator, fromPool);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert HypeTransferFailed();
    }
}
