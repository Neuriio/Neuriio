// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {PropAMM} from "../amm/PropAMM.sol";

/// @notice Instant Elysium <-> HyperCore USDC bridge backed by our own inventory on both sides.
///
/// In:  user deposits USDC (or any token with a PropAMM pool, converted to USDC here). A relayer
///      credits the same USDC, minus fee, to the user's own HyperCore account from our HyperCore
///      inventory, then marks the deposit fulfilled. If that doesn't happen within `refundDelay`,
///      the user reclaims the full deposit — funds are never stuck on the relayer.
/// Out: user sends USDC to our HyperCore account; the relayer pays them here from this
///      contract's inventory. Each HyperCore transfer hash can be paid once, and per-transfer and
///      daily caps bound what a compromised relayer key could drain.
///
/// `credit` is how much HyperCore inventory the relayer has vouched for; deposits can't exceed
/// it, so we never accept money we can't deliver. All amounts are USDC base units.
contract FastBridge is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant BPS = 10_000;

    enum Status {
        None,
        Pending,
        Fulfilled,
        Refunded
    }

    struct Deposit {
        address user;
        uint64 createdAt;
        Status status;
        address hlRecipient;
        uint96 amount; // net, credited on HyperCore
        uint96 fee;
    }

    struct Config {
        uint16 feeBps;
        uint64 minFee;
        uint64 maxDeposit; // net USDC per deposit
        uint32 refundDelay; // seconds
        uint64 maxPayout; // gross USDC per payout
        uint64 dailyPayoutCap; // gross USDC per UTC day
    }

    IERC20 public immutable usdc;
    Config public config;

    mapping(address => bool) public isRelayer;
    mapping(address token => PropAMM) public poolFor;

    uint256 public credit;
    uint256 public reserved; // USDC held for pending deposits (refundable)
    uint256 public feesAccrued;
    uint256 public depositCount;
    mapping(uint256 => Deposit) public deposits;
    mapping(bytes32 hlRef => bool) public paidOut;
    mapping(uint256 day => uint256) public paidOnDay;

    event DepositRequested(
        uint256 indexed id,
        address indexed user,
        address indexed hlRecipient,
        address tokenIn,
        uint256 amountIn,
        uint256 amount,
        uint256 fee
    );
    event DepositFulfilled(uint256 indexed id);
    event DepositRefunded(uint256 indexed id, address indexed user, uint256 amount);
    event PaidOut(bytes32 indexed hlRef, address indexed to, uint256 amount, uint256 fee);
    event CreditChanged(uint256 credit);
    event ConfigSet(Config config);
    event RelayerSet(address indexed relayer, bool allowed);
    event PoolSet(address indexed token, address pool);

    error NotRelayer(address caller);
    error UnsupportedToken(address token);
    error InvalidConfig();
    error ZeroAmount();
    error AmountTooSmall(uint256 gross, uint256 fee);
    error DepositTooLarge(uint256 amount, uint256 max);
    error InsufficientCredit(uint256 amount, uint256 credit);
    error NotPending(uint256 id);
    error NotDepositor(uint256 id);
    error RefundNotYet(uint256 id, uint256 availableAt);
    error AlreadyPaid(bytes32 hlRef);
    error PayoutTooLarge(uint256 amount, uint256 max);
    error DailyCapExceeded(uint256 wouldBe, uint256 cap);
    error InsufficientLiquidity(uint256 amount, uint256 available);
    error TransferAmountMismatch(uint256 received, uint256 expected);
    error StaleCredit(uint256 expected, uint256 actual);

    modifier onlyRelayer() {
        if (!isRelayer[msg.sender] && msg.sender != owner()) revert NotRelayer(msg.sender);
        _;
    }

    constructor(address owner_, IERC20 usdc_, Config memory config_) Ownable(owner_) {
        usdc = usdc_;
        _setConfig(config_);
    }

    // ------------------------------------------------------------------ Elysium -> HyperCore

    /// @param token      USDC, or a token with a registered PropAMM pool (converted to USDC)
    /// @param minUsdcOut slippage bound on the conversion (ignored for USDC)
    /// @param hlRecipient HyperCore account to credit; zero = msg.sender
    function deposit(address token, uint256 amountIn, uint256 minUsdcOut, address hlRecipient, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (amountIn == 0) revert ZeroAmount();
        uint256 gross = _collectAsUsdc(token, amountIn, minUsdcOut, deadline);

        Config memory c = config;
        uint256 fee = Math.max(c.minFee, Math.mulDiv(gross, c.feeBps, BPS, Math.Rounding.Ceil));
        if (gross <= fee) revert AmountTooSmall(gross, fee);
        uint256 amount = gross - fee;
        if (amount > c.maxDeposit) revert DepositTooLarge(amount, c.maxDeposit);
        if (amount > credit) revert InsufficientCredit(amount, credit);

        credit -= amount;
        reserved += gross;
        id = ++depositCount;
        if (hlRecipient == address(0)) hlRecipient = msg.sender;
        deposits[id] = Deposit({
            user: msg.sender,
            createdAt: uint64(block.timestamp),
            status: Status.Pending,
            hlRecipient: hlRecipient,
            amount: amount.toUint96(),
            fee: fee.toUint96()
        });
        emit DepositRequested(id, msg.sender, hlRecipient, token, amountIn, amount, fee);
        emit CreditChanged(credit);
    }

    /// @notice Relayer confirms the HyperCore credit landed. Fee becomes protocol revenue and the
    ///         USDC becomes Elysium-side inventory for payouts.
    function markFulfilled(uint256[] calldata ids) external onlyRelayer {
        for (uint256 i; i < ids.length; ++i) {
            Deposit storage d = deposits[ids[i]];
            if (d.status != Status.Pending) revert NotPending(ids[i]);
            d.status = Status.Fulfilled;
            reserved -= uint256(d.amount) + d.fee;
            feesAccrued += d.fee;
            emit DepositFulfilled(ids[i]);
        }
    }

    /// @notice Safety valve: reclaim a deposit the relayer never fulfilled. Full refund incl. fee.
    function refund(uint256 id) external nonReentrant {
        Deposit storage d = deposits[id];
        if (d.status != Status.Pending) revert NotPending(id);
        if (d.user != msg.sender) revert NotDepositor(id);
        uint256 availableAt = uint256(d.createdAt) + config.refundDelay;
        if (block.timestamp < availableAt) revert RefundNotYet(id, availableAt);

        d.status = Status.Refunded;
        uint256 gross = uint256(d.amount) + d.fee;
        reserved -= gross;
        credit += d.amount; // HyperCore inventory was never spent
        usdc.safeTransfer(msg.sender, gross);
        emit DepositRefunded(id, msg.sender, gross);
        emit CreditChanged(credit);
    }

    // ------------------------------------------------------------------ HyperCore -> Elysium

    /// @param hlRef  HyperCore transfer hash of the user's USDC send to our account
    function payout(bytes32 hlRef, address to, uint256 gross) external onlyRelayer nonReentrant whenNotPaused {
        if (paidOut[hlRef]) revert AlreadyPaid(hlRef);
        Config memory c = config;
        if (gross > c.maxPayout) revert PayoutTooLarge(gross, c.maxPayout);
        uint256 day = block.timestamp / 1 days;
        uint256 today = paidOnDay[day] + gross;
        if (today > c.dailyPayoutCap) revert DailyCapExceeded(today, c.dailyPayoutCap);

        uint256 fee = Math.max(c.minFee, Math.mulDiv(gross, c.feeBps, BPS, Math.Rounding.Ceil));
        if (gross <= fee) revert AmountTooSmall(gross, fee);
        uint256 amount = gross - fee;
        uint256 free = freeLiquidity();
        if (amount > free) revert InsufficientLiquidity(amount, free);

        paidOut[hlRef] = true;
        paidOnDay[day] = today;
        feesAccrued += fee;
        usdc.safeTransfer(to, amount);
        emit PaidOut(hlRef, to, amount, fee);
    }

    /// @notice USDC available for payouts: excludes refundable deposits and earned fees.
    function freeLiquidity() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 locked = reserved + feesAccrued;
        return bal > locked ? bal - locked : 0;
    }

    // ------------------------------------------------------------------ credit (relayer)

    /// @notice Compare-and-set: applies only if credit is still what the relayer based its
    ///         calculation on, so a stale read (or a deposit landing mid-calculation) reverts
    ///         instead of over-granting.
    function setCredit(uint256 expected, uint256 newCredit) external onlyRelayer {
        if (credit != expected) revert StaleCredit(expected, credit);
        credit = newCredit;
        emit CreditChanged(newCredit);
    }

    function increaseCredit(uint256 amount) external onlyRelayer {
        credit += amount;
        emit CreditChanged(credit);
    }

    function decreaseCredit(uint256 amount) external onlyRelayer {
        credit = amount >= credit ? 0 : credit - amount;
        emit CreditChanged(credit);
    }

    // ------------------------------------------------------------------ admin

    function setConfig(Config calldata c) external onlyOwner {
        _setConfig(c);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setPool(address token, PropAMM pool) external onlyOwner {
        if (address(pool) != address(0) && (address(pool.base()) != token || pool.quote() != usdc)) {
            revert UnsupportedToken(token);
        }
        poolFor[token] = pool;
        emit PoolSet(token, address(pool));
    }

    /// @notice Move free inventory out for rebalancing to HyperCore via the slow canonical bridge.
    function withdrawLiquidity(uint256 amount, address to) external onlyOwner {
        uint256 free = freeLiquidity();
        if (amount > free) revert InsufficientLiquidity(amount, free);
        usdc.safeTransfer(to, amount);
    }

    function withdrawFees(address to) external onlyOwner {
        uint256 f = feesAccrued;
        feesAccrued = 0;
        usdc.safeTransfer(to, f);
    }

    function pause() external onlyRelayer {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ internals

    function _collectAsUsdc(address token, uint256 amountIn, uint256 minUsdcOut, uint256 deadline)
        internal
        returns (uint256 usdcAmount)
    {
        if (token == address(usdc)) {
            _pullExact(usdc, amountIn);
            return amountIn;
        }
        PropAMM pool = poolFor[token];
        if (address(pool) == address(0)) revert UnsupportedToken(token);
        _pullExact(IERC20(token), amountIn);
        IERC20(token).forceApprove(address(pool), amountIn);
        usdcAmount = pool.sellBase(amountIn, minUsdcOut, address(this), deadline);
    }

    function _pullExact(IERC20 token, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(received, amount);
    }

    function _setConfig(Config memory c) internal {
        if (c.feeBps > 500 || c.refundDelay < 5 minutes || c.maxDeposit == 0) revert InvalidConfig();
        config = c;
        emit ConfigSet(c);
    }
}
