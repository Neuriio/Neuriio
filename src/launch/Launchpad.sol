// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {ISwapFactory, ISwapPair, IWHYPE} from "../swap/interfaces.sol";

interface ICurveFeeVault {
    function depositCurveFee(address token) external payable;
}

/// @notice "Tokenize yourself": a pump.fun-style launchpad priced in native HYPE where every token is a person.
///
/// Launching needs a LaunchPass signed by our backend (`launchSigner`) after it verifies the creator's X login.
/// One token per X account (keyed by the permanent X user ID) and per wallet, named after the creator (at-sign + handle) with the
/// handle in caps as the ticker; the pass also fixes the creator's category and the hash of their profile (who they
/// are + links to their work; the profile itself lives off-chain). Tokens are memes: no promises, no revenue share. Launching is free: 1B supply, all held here. 793.1M are sold on a bonding curve, a
/// constant-product curve over *virtual* reserves (`virtualHype` HYPE : 1.073B tokens at launch), so no
/// seed liquidity is needed. Each curve trade pays a fee (`feeBps`, 0.75% at deploy) to the FeeVault: 80% to the
/// creator, 20% to the protocol. The buy that sells the last curve token
/// graduates the token in the same tx: every HYPE raised plus the remaining 206.9M tokens go into our
/// SwapPair (TOKEN/WHYPE) and the LP tokens are sent to the dead address (burned), so that liquidity is
/// locked forever. The curve's final price equals the pool's opening price.
contract Launchpad is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 793_100_000e18;
    uint256 public constant LP_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY; // 206.9M
    uint256 public constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 public constant MAX_FEE_BPS = 200;
    uint256 public constant MIN_VIRTUAL_HYPE = 1e15;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_HANDLE_LENGTH = 15; // X's limit
    bytes32 public constant LAUNCH_PASS_TYPEHASH = keccak256(
        "LaunchPass(address creator,uint64 xUserId,string handle,uint8 category,bytes32 profileHash,uint256 deadline)"
    );

    enum Category {
        Trader,
        MemeTrader,
        Researcher,
        Influencer,
        Builder,
        Creator
    }

    /// Signed by `launchSigner` once the backend has verified the creator's X account.
    struct LaunchPass {
        address creator; // wallet that launches (must be msg.sender)
        uint64 xUserId; // permanent X user ID: one token per X account
        string handle; // X handle without "@", as verified at signing time
        uint8 category; // Category
        bytes32 profileHash; // keccak256 of the creator's profile document stored off-chain
        uint256 deadline;
    }

    struct Profile {
        uint64 xUserId;
        Category category;
        bytes32 profileHash;
        string handle;
    }

    struct Curve {
        address creator;
        bool graduated;
        uint128 virtualHype; // curve HYPE reserve (virtual + raised)
        uint128 virtualToken; // curve token reserve (virtual)
        uint128 realHype; // HYPE actually raised and held here (moves to the pool at graduation)
        uint128 realToken; // curve tokens still for sale
    }

    ISwapFactory public immutable factory;
    IWHYPE public immutable whype;

    /// Starting virtual HYPE reserve for NEW launches. Graduation raises ~2.8335x this.
    uint256 public virtualHype;
    uint16 public feeBps;
    /// Receives every curve fee (80% to the token's creator, 20% to the protocol).
    ICurveFeeVault public immutable feeVault;

    mapping(address token => Curve) public curves;
    address[] public allTokens;

    address public launchSigner;
    mapping(address token => Profile) internal _profiles;
    mapping(uint64 xUserId => address token) public tokenOfXUser;
    mapping(address creator => address token) public tokenOfCreator;
    mapping(bytes32 handleKey => address token) public tokenOfHandle; // keccak256(lowercased handle)

    event Launched(
        address indexed token,
        address indexed creator,
        uint64 indexed xUserId,
        string handle,
        Category category,
        bytes32 profileHash,
        uint256 virtualHype
    );
    event LaunchSignerSet(address signer);
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 hypeAmount, // HYPE into (buy) / out of (sell) the curve, excluding the fee
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualHype,
        uint256 virtualToken
    );
    event Graduated(address indexed token, address indexed pair, uint256 hype, uint256 tokens, uint256 liquidityBurned);
    event VirtualHypeSet(uint256 virtualHype);
    event FeeSet(uint16 feeBps);

    error UnknownToken(address token);
    error AlreadyGraduated(address token);
    error Expired();
    error ZeroAmount();
    error Slippage(uint256 out, uint256 minOut);
    error InvalidParams();
    error InvalidMetadata();
    error HypeTransferFailed();
    error InvalidPass();
    error NotPassHolder();
    error AlreadyLaunched();

    constructor(
        address owner_,
        ISwapFactory factory_,
        IWHYPE whype_,
        uint256 virtualHype_,
        uint16 feeBps_,
        address launchSigner_,
        ICurveFeeVault feeVault_
    ) Ownable(owner_) EIP712("Neuriio Launchpad", "1") {
        factory = factory_;
        whype = whype_;
        feeVault = feeVault_;
        _setLaunchSigner(launchSigner_);
        _setVirtualHype(virtualHype_);
        _setFee(feeBps_);
    }

    // ------------------------------------------------------------------ launch + trade

    /// @notice Launch your own token with a pass from our backend. Any HYPE sent is an initial buy for the
    /// creator (`minTokensOut` applies).
    function launch(LaunchPass calldata pass, bytes calldata signature, uint256 minTokensOut)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (address token)
    {
        if (block.timestamp > pass.deadline) revert Expired();
        if (msg.sender != pass.creator) revert NotPassHolder();
        if (ECDSA.recover(hashLaunchPass(pass), signature) != launchSigner) revert InvalidPass();
        if (pass.category > uint8(type(Category).max) || pass.xUserId == 0) revert InvalidPass();
        (string memory symbol, bytes32 handleKey) = _checkHandle(pass.handle);
        if (
            tokenOfXUser[pass.xUserId] != address(0) || tokenOfCreator[msg.sender] != address(0)
                || tokenOfHandle[handleKey] != address(0)
        ) revert AlreadyLaunched();

        token = address(new LaunchToken(string.concat("@", pass.handle), symbol, TOTAL_SUPPLY));
        uint256 vh = virtualHype;
        curves[token] = Curve({
            creator: msg.sender,
            graduated: false,
            virtualHype: vh.toUint128(),
            virtualToken: uint128(VIRTUAL_TOKENS),
            realHype: 0,
            realToken: uint128(CURVE_SUPPLY)
        });
        _profiles[token] = Profile(pass.xUserId, Category(pass.category), pass.profileHash, pass.handle);
        tokenOfXUser[pass.xUserId] = token;
        tokenOfCreator[msg.sender] = token;
        tokenOfHandle[handleKey] = token;
        allTokens.push(token);
        emit Launched(token, msg.sender, pass.xUserId, pass.handle, Category(pass.category), pass.profileHash, vh);

        if (msg.value > 0) _buy(token, msg.value, minTokensOut);
    }

    /// @notice Buy with all HYPE sent. If this sells out the curve, only what's needed is used (the rest is
    /// refunded) and the token graduates in this tx.
    function buy(address token, uint256 minTokensOut, uint256 deadline)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        tokensOut = _buy(token, msg.value, minTokensOut);
    }

    /// @notice Sell tokens back to the curve for HYPE (needs an approval of `tokensIn`).
    function sell(address token, uint256 tokensIn, uint256 minHypeOut, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 hypeOut)
    {
        if (block.timestamp > deadline) revert Expired();
        Curve storage c = _live(token);
        uint256 gross;
        uint256 fee;
        (hypeOut, gross, fee) = _quoteSell(c, tokensIn);
        if (hypeOut == 0) revert ZeroAmount();
        if (hypeOut < minHypeOut) revert Slippage(hypeOut, minHypeOut);

        c.virtualHype -= gross.toUint128();
        c.virtualToken += tokensIn.toUint128();
        c.realHype -= gross.toUint128();
        c.realToken += tokensIn.toUint128();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        emit Trade(token, msg.sender, false, gross, tokensIn, fee, c.virtualHype, c.virtualToken);
        if (fee > 0) feeVault.depositCurveFee{value: fee}(token);
        _sendHype(msg.sender, hypeOut);
    }

    // ------------------------------------------------------------------ views

    /// @return tokensOut tokens received for sending `value` HYPE
    /// @return hypeIn    HYPE that goes into the curve
    /// @return fee       fee on `hypeIn`
    /// @return refund    HYPE returned (only when this buy sells out the curve)
    function previewBuy(address token, uint256 value)
        external
        view
        returns (uint256 tokensOut, uint256 hypeIn, uint256 fee, uint256 refund)
    {
        (tokensOut, hypeIn, fee) = _quoteBuy(_live(token), value);
        refund = value - hypeIn - fee;
    }

    /// @return hypeOut HYPE received for `tokensIn`, after the fee
    /// @return fee     fee taken
    function previewSell(address token, uint256 tokensIn) external view returns (uint256 hypeOut, uint256 fee) {
        (hypeOut,, fee) = _quoteSell(_live(token), tokensIn);
    }

    /// @notice HYPE (all-in, including the fee) that buys every remaining curve token and graduates it.
    function hypeToGraduate(address token) external view returns (uint256) {
        Curve storage c = _live(token);
        uint256 hypeIn = _hypeForTokens(c, c.realToken);
        return hypeIn + _fee(hypeIn, true);
    }

    /// @notice Spot price in HYPE per token, 18 decimals.
    function price(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken(token);
        return Math.mulDiv(c.virtualHype, 1e18, c.virtualToken);
    }

    /// @notice Who launched `token` (receives 80% of its fees via the FeeVault); address(0) if unknown.
    function creatorOf(address token) external view returns (address) {
        return curves[token].creator;
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    function profile(address token) external view returns (Profile memory) {
        return _profiles[token];
    }

    /// @notice EIP-712 digest the backend signs for `pass`.
    function hashLaunchPass(LaunchPass calldata pass) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LAUNCH_PASS_TYPEHASH,
                    pass.creator,
                    pass.xUserId,
                    keccak256(bytes(pass.handle)),
                    pass.category,
                    pass.profileHash,
                    pass.deadline
                )
            )
        );
    }

    // ------------------------------------------------------------------ owner

    function setVirtualHype(uint256 virtualHype_) external onlyOwner {
        _setVirtualHype(virtualHype_);
    }

    function setFee(uint16 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    /// @notice Rotate the backend key that signs launch passes (address(0) stops all launches).
    function setLaunchSigner(address signer) external onlyOwner {
        _setLaunchSigner(signer);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ internals

    function _buy(address token, uint256 value, uint256 minTokensOut) internal returns (uint256 tokensOut) {
        Curve storage c = _live(token);
        uint256 hypeIn;
        uint256 fee;
        (tokensOut, hypeIn, fee) = _quoteBuy(c, value);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);

        c.virtualHype += hypeIn.toUint128();
        c.virtualToken -= tokensOut.toUint128();
        c.realHype += hypeIn.toUint128();
        c.realToken -= tokensOut.toUint128();

        IERC20(token).safeTransfer(msg.sender, tokensOut);
        emit Trade(token, msg.sender, true, hypeIn, tokensOut, fee, c.virtualHype, c.virtualToken);
        if (fee > 0) feeVault.depositCurveFee{value: fee}(token);

        if (c.realToken == 0) _graduate(token, c);
        uint256 refund = value - hypeIn - fee;
        if (refund > 0) _sendHype(msg.sender, refund);
    }

    /// Curve sold out: all raised HYPE + LP_SUPPLY tokens into a new SwapPair, LP tokens burned.
    function _graduate(address token, Curve storage c) internal {
        c.graduated = true;
        uint256 hype = c.realHype;
        c.realHype = 0;

        whype.deposit{value: hype}();
        address pair = factory.createPair(token, address(whype));
        // Tokens sent to the (predictable) pair address before now would skew the opening price: clear them.
        ISwapPair(pair).skim(DEAD);
        IERC20(token).safeTransfer(pair, LP_SUPPLY);
        IERC20(address(whype)).safeTransfer(pair, hype);
        uint256 liquidity = ISwapPair(pair).mint(DEAD);
        emit Graduated(token, pair, hype, LP_SUPPLY, liquidity);
    }

    /// Fee comes off the top; tokens out on the curve, capped at what's left for sale.
    function _quoteBuy(Curve storage c, uint256 value)
        internal
        view
        returns (uint256 tokensOut, uint256 hypeIn, uint256 fee)
    {
        fee = _fee(value, false);
        hypeIn = value - fee;
        uint256 vh = c.virtualHype;
        uint256 vt = c.virtualToken;
        tokensOut = vt - Math.mulDiv(vh, vt, vh + hypeIn, Math.Rounding.Ceil);
        if (tokensOut >= c.realToken) {
            tokensOut = c.realToken;
            hypeIn = _hypeForTokens(c, tokensOut);
            fee = _fee(hypeIn, true);
            if (hypeIn + fee > value) fee = value - hypeIn; // rounding edge: never charge more than sent
        }
    }

    function _quoteSell(Curve storage c, uint256 tokensIn)
        internal
        view
        returns (uint256 hypeOut, uint256 gross, uint256 fee)
    {
        uint256 vh = c.virtualHype;
        uint256 vt = c.virtualToken;
        gross = vh - Math.mulDiv(vh, vt, vt + tokensIn, Math.Rounding.Ceil);
        gross = Math.min(gross, c.realHype); // can't pay out more than was raised
        fee = _fee(gross, true);
        hypeOut = gross - fee;
    }

    /// HYPE into the curve (excluding fee) to take `tokens` out.
    function _hypeForTokens(Curve storage c, uint256 tokens) internal view returns (uint256) {
        uint256 vh = c.virtualHype;
        uint256 vt = c.virtualToken;
        return Math.mulDiv(vh, vt, vt - tokens, Math.Rounding.Ceil) - vh;
    }

    /// `ofNet`: fee on an amount that excludes it (ceil); otherwise the fee inside a gross amount (floor).
    function _fee(uint256 amount, bool ofNet) internal view returns (uint256) {
        return ofNet
            ? Math.mulDiv(amount, feeBps, 10_000, Math.Rounding.Ceil)
            : Math.mulDiv(amount, feeBps, 10_000 + feeBps);
    }

    function _live(address token) internal view returns (Curve storage c) {
        c = curves[token];
        if (c.creator == address(0)) revert UnknownToken(token);
        if (c.graduated) revert AlreadyGraduated(token);
    }

    function _sendHype(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert HypeTransferFailed();
    }

    /// X handle rules: 1-15 chars of A-Z a-z 0-9 _. Returns the ticker (handle in caps) and a
    /// case-insensitive key (X handles are case-insensitive).
    function _checkHandle(string calldata handle) internal pure returns (string memory symbol, bytes32 key) {
        bytes calldata h = bytes(handle);
        uint256 n = h.length;
        if (n == 0 || n > MAX_HANDLE_LENGTH) revert InvalidMetadata();
        bytes memory upper = new bytes(n);
        bytes memory lower = new bytes(n);
        for (uint256 i; i < n; ++i) {
            bytes1 c = h[i];
            bool isLower = c >= 0x61 && c <= 0x7a;
            bool isUpper = c >= 0x41 && c <= 0x5a;
            if (!(isLower || isUpper || (c >= 0x30 && c <= 0x39) || c == 0x5f)) revert InvalidMetadata();
            upper[i] = isLower ? bytes1(uint8(c) - 32) : c;
            lower[i] = isUpper ? bytes1(uint8(c) + 32) : c;
        }
        return (string(upper), keccak256(lower));
    }

    function _setLaunchSigner(address signer) internal {
        launchSigner = signer;
        emit LaunchSignerSet(signer);
    }

    function _setVirtualHype(uint256 v) internal {
        if (v < MIN_VIRTUAL_HYPE || v > type(uint96).max) revert InvalidParams();
        virtualHype = v;
        emit VirtualHypeSet(v);
    }

    function _setFee(uint16 f) internal {
        if (f > MAX_FEE_BPS) revert InvalidParams();
        feeBps = f;
        emit FeeSet(f);
    }
}
