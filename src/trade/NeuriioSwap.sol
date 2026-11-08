// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ExactInputSingleParams, IPermit2, IUniversalRouter, PoolKey} from "../launch/AscendAdapter.sol";

/// Wrapped HYPE (WETH9-style): HYPE in -> WHYPE, WHYPE back -> HYPE.
interface IWHYPE {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @notice Neuriio's swap for tokens launched by other teams (user, 2026-11-07: "Universal Frontend", now for Ascend's tokens). A trade
/// made through Neuriio pays our fee on top of the pool's own: 0.5% of what is paid in on a buy, 0.5% of what comes out on a sell,
/// sent straight to our fee wallet (the fee router converts it to USDC and splits it). The token stays in its own Uniswap v4 pool
/// (with its hook and fees, e.g. Ascend's); this contract only routes the trade through Uniswap's UniversalRouter, the same route as
/// the AscendAdapter's audited first buy.
///  - The pair ("quote") can be native HYPE (address(0)), WHYPE, or any other ERC-20 (e.g. USDC). With native HYPE or WHYPE pairs the
///    user always pays and receives plain HYPE: WHYPE is wrapped before a buy and unwrapped after a sell, here.
///  - Only pools the owner approved can be traded (the owner is the timelock the Neuriio Safe runs): one pool per token.
///  - Holds nothing between calls: every trade pays out in the same transaction, and every allowance it gives is closed after the
///    swap. HYPE is accepted only while a sell is running.
///  - The guardian (the Safe) can pause at once; only the owner unpauses, approves pools or changes the guardian.
contract NeuriioSwap is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 50; // 0.5%
    uint256 internal constant BPS = 10_000;
    address internal constant NATIVE = address(0);

    bytes1 internal constant V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE_ALL = 0x0f;

    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    address public immutable whype; // wrapped HYPE: its pairs trade in plain HYPE for the user
    address public immutable feeWallet; // where our 0.5% goes (the fee router's wallet)
    address public guardian; // may pause at once besides the owner
    bool internal _selling; // HYPE may arrive only during a sell (the PoolManager or WHYPE pays it out)

    struct Pool {
        PoolKey key;
        address quote; // the pool's other currency: what is paid in on a buy and out on a sell (address(0) = native HYPE)
    }

    mapping(address token => Pool) internal _pools;
    mapping(address token => bool) public approved;

    event PoolSet(address indexed token, PoolKey key, address quote, bool approved);
    event GuardianSet(address guardian);
    /// @dev `quote` is the pool's pair (address(0) = native HYPE; WHYPE pairs also settle in HYPE for the user, fee in HYPE).
    /// `fee` is our 0.5%, in the quote's units (HYPE for native and WHYPE pairs). The fee router attributes it to `token`.
    event Bought(address indexed token, address indexed buyer, address to, address quote, uint256 amountIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, address to, address quote, uint256 tokensIn, uint256 amountOut, uint256 fee);

    error BadSetup();
    error BadPool();
    error NotApproved(address token);
    error ZeroAmount();
    error WrongValue();
    error Expired();
    error TooLittleReceived(uint256 got, uint256 min);
    error PayFailed();
    error NotSelling();
    error NotOwnerOrGuardian();

    constructor(
        address owner_,
        IUniversalRouter router_,
        IPermit2 permit2_,
        address whype_,
        address feeWallet_,
        address guardian_
    ) Ownable(owner_) {
        if (
            address(router_) == address(0) || address(permit2_) == address(0) || whype_ == address(0)
                || feeWallet_ == address(0)
        ) revert BadSetup();
        router = router_;
        permit2 = permit2_;
        whype = whype_;
        feeWallet = feeWallet_;
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    // ------------------------------------------------------------------ trading

    /// @notice Buy `token` with `amountIn` of its pool's quote: 0.5% to our fee wallet, the rest swapped in the token's approved pool.
    /// Native HYPE and WHYPE pairs are paid in HYPE (send exactly `amountIn` as value); other pairs in the quote token (approve it to
    /// this contract first, send no value). At least `minOut` tokens go to `to`, or it reverts.
    function buy(address token, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokensOut)
    {
        Pool memory p = _approvedPool(token, deadline);
        if (amountIn == 0) revert ZeroAmount();
        bool inHype = _paysInHype(p.quote);
        if (inHype ? msg.value != amountIn : msg.value != 0) revert WrongValue();

        uint256 paid = amountIn;
        if (!inHype) paid = _pull(p.quote, amountIn); // what actually arrived
        uint256 fee = paid * FEE_BPS / BPS;
        uint256 swapIn = paid - fee;
        if (inHype) {
            _payHype(feeWallet, fee);
            if (p.quote == whype) IWHYPE(whype).deposit{value: swapIn}();
        } else {
            IERC20(p.quote).safeTransfer(feeWallet, fee);
        }

        uint256 before = IERC20(token).balanceOf(address(this));
        _swap(p.key, p.quote, token, swapIn, deadline);
        tokensOut = IERC20(token).balanceOf(address(this)) - before;
        if (tokensOut < minOut) revert TooLittleReceived(tokensOut, minOut);
        IERC20(token).safeTransfer(to, tokensOut);
        emit Bought(token, msg.sender, to, p.quote, paid, fee, tokensOut);
    }

    /// @notice Sell `amountIn` of `token` (approve it to this contract first) for its pool's quote: swapped in the approved pool,
    /// then 0.5% of what comes out to our fee wallet. Native HYPE and WHYPE pairs pay out in HYPE. At least `minOut` goes to `to`.
    function sell(address token, uint256 amountIn, uint256 minOut, address to, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        Pool memory p = _approvedPool(token, deadline);
        if (amountIn == 0) revert ZeroAmount();
        uint256 received = _pull(token, amountIn); // what actually arrived (a token that takes a cut delivers less)
        if (received == 0) revert ZeroAmount();
        bool inHype = _paysInHype(p.quote);

        uint256 gross;
        _selling = true;
        if (p.quote == NATIVE) {
            uint256 b = address(this).balance;
            _swap(p.key, token, NATIVE, received, deadline);
            gross = address(this).balance - b;
        } else {
            uint256 b = IERC20(p.quote).balanceOf(address(this));
            _swap(p.key, token, p.quote, received, deadline);
            gross = IERC20(p.quote).balanceOf(address(this)) - b;
            if (p.quote == whype) IWHYPE(whype).withdraw(gross); // pay out plain HYPE
        }
        _selling = false;

        uint256 fee = gross * FEE_BPS / BPS;
        amountOut = gross - fee;
        if (amountOut < minOut) revert TooLittleReceived(amountOut, minOut);
        if (inHype) {
            _payHype(feeWallet, fee);
            _payHype(to, amountOut);
        } else {
            IERC20(p.quote).safeTransfer(feeWallet, fee);
            IERC20(p.quote).safeTransfer(to, amountOut);
        }
        emit Sold(token, msg.sender, to, p.quote, received, amountOut, fee);
    }

    /// @dev HYPE only comes in as a sell's proceeds, while that sell is running (the PoolManager pays native HYPE out to the router's
    /// caller, this contract; WHYPE pays out on withdraw). Anything sent at any other time is refused, so nothing can get stuck here.
    receive() external payable {
        if (!_selling) revert NotSelling();
    }

    // ------------------------------------------------------------------ owner

    /// @notice Approve (or stop) trading `token` through Neuriio, in the pool `key` (the token must be one of its two currencies; the
    /// other is the quote).
    function setPool(PoolKey calldata key, address token, bool approved_) external onlyOwner {
        if (token == NATIVE || key.tickSpacing <= 0 || key.currency0 == key.currency1) revert BadPool();
        address quote;
        if (token == key.currency0) quote = key.currency1;
        else if (token == key.currency1) quote = key.currency0;
        else revert BadPool();
        approved[token] = approved_;
        if (approved_) _pools[token] = Pool(key, quote);
        else delete _pools[token];
        emit PoolSet(token, key, quote, approved_);
    }

    /// @notice Who may pause at once besides the owner (address(0) = nobody).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Emergency stop for all trading here (the pools themselves are unaffected), by the owner or the guardian.
    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ views

    function poolOf(address token) external view returns (PoolKey memory) {
        return _pools[token].key;
    }

    /// @notice What `token` is bought with and sold for: address(0) = native HYPE; WHYPE also means plain HYPE for the user.
    function quoteOf(address token) external view returns (address) {
        return _pools[token].quote;
    }

    // ------------------------------------------------------------------ internals

    function _approvedPool(address token, uint256 deadline) internal view returns (Pool memory p) {
        if (block.timestamp > deadline) revert Expired();
        if (!approved[token]) revert NotApproved(token);
        p = _pools[token];
    }

    function _paysInHype(address quote) internal view returns (bool) {
        return quote == NATIVE || quote == whype;
    }

    /// @dev Pulls `amount` of `token` from the caller; returns what actually arrived.
    function _pull(address token, uint256 amount) internal returns (uint256) {
        uint256 b = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        return IERC20(token).balanceOf(address(this)) - b;
    }

    /// @dev One exact-input swap of `amountIn` of `currencyIn` for `currencyOut` through the UniversalRouter: V4_SWAP with
    /// SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL (the AscendAdapter's encoding). Native HYPE in is sent with the call; an ERC-20 in
    /// gets a one-shot Permit2 allowance that is closed right after.
    function _swap(PoolKey memory key, address currencyIn, address currencyOut, uint256 amountIn, uint256 deadline) internal {
        bool zeroForOne = currencyIn == key.currency0;
        if (currencyIn != NATIVE) {
            IERC20(currencyIn).forceApprove(address(permit2), amountIn);
            // forge-lint: disable-next-line(unsafe-typecast)
            permit2.approve(currencyIn, address(router), uint160(amountIn), uint48(block.timestamp));
        }
        bytes[] memory params = new bytes[](3);
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(ExactInputSingleParams(key, zeroForOne, uint128(amountIn), 0, 0, ""));
        params[1] = abi.encode(currencyIn, amountIn);
        params[2] = abi.encode(currencyOut, uint256(0)); // the minimum is checked here, after our fee
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        router.execute{value: currencyIn == NATIVE ? amountIn : 0}(abi.encodePacked(V4_SWAP), inputs, deadline);
        if (currencyIn != NATIVE) {
            IERC20(currencyIn).forceApprove(address(permit2), 0);
            permit2.approve(currencyIn, address(router), 0, 0);
        }
    }

    function _payHype(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert PayFailed();
    }
}
