// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHyperCoreOracle} from "../interfaces/IHyperCoreOracle.sol";
import {HyperCoreReader} from "../libraries/HyperCoreReader.sol";

/// @notice Single-pair proprietary AMM priced off live HyperCore top-of-book.
///
///   ask = coreAsk * (1 + edge - skew + impact)      bid = coreBid * (1 - edge - skew - impact)
///
///   edge   : margin over Core's touch, so every fill can be hedged on Core at a profit
///   skew   : inventory lean; long base => both prices drop to attract buyers (and vice versa)
///   impact : linear in trade size relative to pool value
///
/// No-arb clamp: ask >= coreBid * (1 + minEdge) and bid <= coreAsk * (1 - minEdge), so no one can
/// round-trip the pool against HyperCore profitably no matter how skew is configured.
///
/// Prices are WAD quote per whole base (same convention as IHyperCoreOracle).
contract PropAMM is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant WAD = 1e18;

    /// Refreshed by the quoter (keeper) at high frequency.
    struct QuoteParams {
        uint16 edgeBps; // >= RiskParams.minEdgeBps
        uint16 targetBaseBps; // desired share of pool value held in base
        uint16 skewFactorBps; // skew bps per 100% deviation from target (e.g. 50 = 0.5bps per 1% dev)
        uint16 maxSkewBps;
        uint16 impactBps; // bps charged for a trade the size of the whole pool
    }

    /// Set by the owner (the vault from step 4).
    struct RiskParams {
        uint16 minEdgeBps;
        uint16 maxTradeBps; // max trade value as share of pool value
        uint32 depthFactorBps; // max trade size vs Core touch size (0 = unchecked)
        uint32 maxAgeMs;
        uint32 maxL2BlockLag;
        uint16 maxCoreSpreadBps;
    }

    IERC20 public immutable base;
    IERC20 public immutable quote;
    uint32 public immutable spotIndex;
    uint256 internal immutable baseScale;
    uint256 internal immutable quoteScale;

    IHyperCoreOracle public oracle;
    QuoteParams public quoteParams;
    RiskParams public riskParams;
    mapping(address => bool) public isQuoter;

    // Internal accounting: donations can't move prices or inflate pool value.
    uint128 public baseReserve;
    uint128 public quoteReserve;

    event Swap(
        address indexed sender,
        address indexed recipient,
        bool indexed buyBase,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 priceWad,
        uint256 coreMidWad,
        uint64 coreTimeMs,
        uint128 baseReserve,
        uint128 quoteReserve
    );
    event Deposited(uint256 baseAmount, uint256 quoteAmount);
    event Withdrawn(address indexed to, uint256 baseAmount, uint256 quoteAmount);
    event QuoteParamsSet(QuoteParams params);
    event RiskParamsSet(RiskParams params);
    event QuoterSet(address indexed quoter, bool allowed);
    event OracleSet(address oracle);

    error NotQuoter(address caller);
    error InvalidParams();
    error Expired();
    error ZeroAmount();
    error Slippage(uint256 out, uint256 minOut);
    error TradeTooLarge(uint256 tradeValue, uint256 maxValue);
    error ExceedsCoreDepth(uint256 baseWad, uint256 maxBaseWad);
    error InsufficientReserve(uint256 out, uint256 reserve);
    error EmptyPool();
    error TransferAmountMismatch(uint256 received, uint256 expected);

    modifier onlyQuoter() {
        if (!isQuoter[msg.sender] && msg.sender != owner()) revert NotQuoter(msg.sender);
        _;
    }

    constructor(
        address owner_,
        IERC20Metadata base_,
        IERC20Metadata quote_,
        IHyperCoreOracle oracle_,
        uint32 spotIndex_,
        RiskParams memory riskParams_,
        QuoteParams memory quoteParams_
    ) Ownable(owner_) {
        uint8 bd = base_.decimals();
        uint8 qd = quote_.decimals();
        if (bd > 18 || qd > 18 || address(base_) == address(quote_)) revert InvalidParams();
        base = IERC20(address(base_));
        quote = IERC20(address(quote_));
        baseScale = 10 ** bd;
        quoteScale = 10 ** qd;
        spotIndex = spotIndex_;
        oracle = oracle_;
        emit OracleSet(address(oracle_));
        _setRiskParams(riskParams_);
        _setQuoteParams(quoteParams_);
    }

    // ------------------------------------------------------------------ swaps

    /// @notice Sell `baseIn` base for quote.
    function sellBase(uint256 baseIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        HyperCoreReader.Quote memory q;
        uint256 price;
        (quoteOut, price, q) = _quoteSellBase(baseIn);
        if (quoteOut < minQuoteOut) revert Slippage(quoteOut, minQuoteOut);

        _pullExact(base, baseIn);
        baseReserve += baseIn.toUint128();
        quoteReserve -= quoteOut.toUint128();
        quote.safeTransfer(recipient, quoteOut);

        emit Swap(msg.sender, recipient, false, baseIn, quoteOut, price, q.mid, q.coreTimeMs, baseReserve, quoteReserve);
    }

    /// @notice Buy base with `quoteIn` quote.
    function buyBase(uint256 quoteIn, uint256 minBaseOut, address recipient, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 baseOut)
    {
        if (block.timestamp > deadline) revert Expired();
        HyperCoreReader.Quote memory q;
        uint256 price;
        (baseOut, price, q) = _quoteBuyBase(quoteIn);
        if (baseOut < minBaseOut) revert Slippage(baseOut, minBaseOut);

        _pullExact(quote, quoteIn);
        quoteReserve += quoteIn.toUint128();
        baseReserve -= baseOut.toUint128();
        base.safeTransfer(recipient, baseOut);

        emit Swap(msg.sender, recipient, true, baseOut, quoteIn, price, q.mid, q.coreTimeMs, baseReserve, quoteReserve);
    }

    // ------------------------------------------------------------------ views

    function previewSellBase(uint256 baseIn) external view returns (uint256 quoteOut, uint256 priceWad) {
        (quoteOut, priceWad,) = _quoteSellBase(baseIn);
    }

    function previewBuyBase(uint256 quoteIn) external view returns (uint256 baseOut, uint256 priceWad) {
        (baseOut, priceWad,) = _quoteBuyBase(quoteIn);
    }

    /// @notice Marginal (zero-size) bid/ask the pool is currently showing, plus Core reference.
    function currentQuote() external view returns (uint256 bid, uint256 ask, HyperCoreReader.Quote memory core) {
        core = _readCore();
        uint256 pv = _poolValue(core.mid);
        if (pv == 0) revert EmptyPool();
        bid = _bidPrice(core, pv, 0);
        ask = _askPrice(core, pv, 0);
    }

    /// @notice Pool value in WAD quote units, marked at Core mid.
    function poolValue() external view returns (uint256) {
        return _poolValue(_readCore().mid);
    }

    // ------------------------------------------------------------------ liquidity (owner = vault in step 4)

    function deposit(uint256 baseAmount, uint256 quoteAmount) external onlyOwner {
        if (baseAmount > 0) _pullExact(base, baseAmount);
        if (quoteAmount > 0) _pullExact(quote, quoteAmount);
        baseReserve += baseAmount.toUint128();
        quoteReserve += quoteAmount.toUint128();
        emit Deposited(baseAmount, quoteAmount);
    }

    function withdraw(uint256 baseAmount, uint256 quoteAmount, address to) external onlyOwner nonReentrant {
        baseReserve -= baseAmount.toUint128();
        quoteReserve -= quoteAmount.toUint128();
        if (baseAmount > 0) base.safeTransfer(to, baseAmount);
        if (quoteAmount > 0) quote.safeTransfer(to, quoteAmount);
        emit Withdrawn(to, baseAmount, quoteAmount);
    }

    // ------------------------------------------------------------------ admin

    function setQuoteParams(QuoteParams calldata p) external onlyQuoter {
        _setQuoteParams(p);
    }

    function setRiskParams(RiskParams calldata p) external onlyOwner {
        _setRiskParams(p);
        if (quoteParams.edgeBps < p.minEdgeBps) revert InvalidParams();
    }

    function setQuoter(address quoter, bool allowed) external onlyOwner {
        isQuoter[quoter] = allowed;
        emit QuoterSet(quoter, allowed);
    }

    function setOracle(IHyperCoreOracle oracle_) external onlyOwner {
        oracle = oracle_;
        emit OracleSet(address(oracle_));
    }

    /// Quoters can pull the emergency brake; only the owner can release it.
    function pause() external onlyQuoter {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ internals

    function _quoteSellBase(uint256 baseIn)
        internal
        view
        returns (uint256 quoteOut, uint256 price, HyperCoreReader.Quote memory q)
    {
        if (baseIn == 0) revert ZeroAmount();
        q = _readCore();
        uint256 baseWad = Math.mulDiv(baseIn, WAD, baseScale);
        uint256 tradeValue = Math.mulDiv(baseWad, q.mid, WAD);
        uint256 pv = _checkSize(q, tradeValue, baseWad, q.bidSz);

        price = _bidPrice(q, pv, tradeValue);
        quoteOut = Math.mulDiv(baseIn, price * quoteScale, baseScale * WAD);
        if (quoteOut > quoteReserve) revert InsufficientReserve(quoteOut, quoteReserve);
    }

    function _quoteBuyBase(uint256 quoteIn)
        internal
        view
        returns (uint256 baseOut, uint256 price, HyperCoreReader.Quote memory q)
    {
        if (quoteIn == 0) revert ZeroAmount();
        q = _readCore();
        uint256 tradeValue = Math.mulDiv(quoteIn, WAD, quoteScale);
        uint256 pv = _checkSize(q, tradeValue, Math.mulDiv(tradeValue, WAD, q.mid), q.askSz);

        price = _askPrice(q, pv, tradeValue);
        baseOut = Math.mulDiv(quoteIn, baseScale * WAD, quoteScale * price);
        if (baseOut > baseReserve) revert InsufficientReserve(baseOut, baseReserve);
    }

    function _checkSize(HyperCoreReader.Quote memory q, uint256 tradeValue, uint256 baseWad, uint256 coreSz)
        internal
        view
        returns (uint256 pv)
    {
        RiskParams memory r = riskParams;
        pv = _poolValue(q.mid);
        if (pv == 0) revert EmptyPool();
        uint256 maxValue = pv * r.maxTradeBps / BPS;
        if (tradeValue > maxValue) revert TradeTooLarge(tradeValue, maxValue);
        if (r.depthFactorBps != 0) {
            uint256 maxBase = coreSz * r.depthFactorBps / BPS;
            if (baseWad > maxBase) revert ExceedsCoreDepth(baseWad, maxBase);
        }
    }

    /// @dev Signed skew in bps: positive when the pool holds more base than targeted.
    function _skewBps(uint256 mid, uint256 pv) internal view returns (int256) {
        QuoteParams memory p = quoteParams;
        uint256 baseValue = Math.mulDiv(Math.mulDiv(baseReserve, WAD, baseScale), mid, WAD);
        int256 devBps = int256(baseValue * BPS / pv) - int256(uint256(p.targetBaseBps));
        int256 skew = devBps * int256(uint256(p.skewFactorBps)) / int256(BPS);
        int256 cap = int256(uint256(p.maxSkewBps));
        return skew > cap ? cap : (skew < -cap ? -cap : skew);
    }

    function _impactBps(uint256 tradeValue, uint256 pv) internal view returns (uint256) {
        return Math.mulDiv(quoteParams.impactBps, tradeValue, pv, Math.Rounding.Ceil);
    }

    function _askPrice(HyperCoreReader.Quote memory q, uint256 pv, uint256 tradeValue) internal view returns (uint256) {
        int256 adj = int256(uint256(quoteParams.edgeBps)) - _skewBps(q.mid, pv) + int256(_impactBps(tradeValue, pv));
        uint256 ask = Math.mulDiv(q.ask, uint256(int256(BPS) + adj), BPS, Math.Rounding.Ceil);
        uint256 floor = Math.mulDiv(q.bid, BPS + riskParams.minEdgeBps, BPS, Math.Rounding.Ceil);
        return ask > floor ? ask : floor;
    }

    function _bidPrice(HyperCoreReader.Quote memory q, uint256 pv, uint256 tradeValue) internal view returns (uint256) {
        int256 adj = int256(uint256(quoteParams.edgeBps)) + _skewBps(q.mid, pv) + int256(_impactBps(tradeValue, pv));
        uint256 bid = Math.mulDiv(q.bid, uint256(int256(BPS) - adj), BPS);
        uint256 cap = Math.mulDiv(q.ask, BPS - riskParams.minEdgeBps, BPS);
        return bid < cap ? bid : cap;
    }

    function _poolValue(uint256 mid) internal view returns (uint256) {
        uint256 baseValue = Math.mulDiv(Math.mulDiv(baseReserve, WAD, baseScale), mid, WAD);
        return baseValue + Math.mulDiv(quoteReserve, WAD, quoteScale);
    }

    function _readCore() internal view returns (HyperCoreReader.Quote memory) {
        RiskParams memory r = riskParams;
        return
            HyperCoreReader.read(
                oracle, spotIndex, HyperCoreReader.Guard(r.maxAgeMs, r.maxL2BlockLag, r.maxCoreSpreadBps)
            );
    }

    function _pullExact(IERC20 token, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert TransferAmountMismatch(received, amount);
    }

    function _setQuoteParams(QuoteParams memory p) internal {
        // edge + skew + impact must stay well below 100% so bid never underflows.
        if (
            p.edgeBps < riskParams.minEdgeBps || p.targetBaseBps > BPS
                || uint256(p.edgeBps) + p.maxSkewBps + p.impactBps >= BPS / 2
        ) revert InvalidParams();
        quoteParams = p;
        emit QuoteParamsSet(p);
    }

    function _setRiskParams(RiskParams memory p) internal {
        if (p.maxTradeBps == 0 || p.maxTradeBps > BPS || p.minEdgeBps >= BPS / 2) revert InvalidParams();
        riskParams = p;
        emit RiskParamsSet(p);
    }
}
