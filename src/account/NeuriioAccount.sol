// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {SignerERC7702} from "@openzeppelin/contracts/utils/cryptography/signers/SignerERC7702.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FastBridge} from "../bridge/FastBridge.sol";

/// @notice EIP-7702 delegate: a user's own wallet points here to get one-click buys.
///
/// The user (the EOA itself) keeps full control: `execute` (ERC-7821 batching), session management
/// and ERC-1271 signatures all require the EOA's own key. On top of that the user can register
/// **session keys** (a key kept on their device) that can do exactly one thing: sign a `Buy`, which
/// sends the user's tokens through FastBridge to the user's OWN HyperCore account (recipient is
/// hard-coded to this address). Session keys are capped per buy and per UTC day in USDC, expire,
/// and are revocable one by one or all at once. Anyone (our gas sponsor) may submit a signed buy,
/// so users never need HYPE for gas.
///
/// Worst case if a device is stolen: capped buys into the user's own HyperCore account.
///
/// 7702 safety: no constructor-set storage and no initializer (nothing to front-run). All state
/// lives in an ERC-7201 namespace so it cannot collide with another delegate the wallet used
/// before or after. EIP712 name/version are short, so they stay in bytecode, not storage.
contract NeuriioAccount is ERC7821, SignerERC7702, EIP712, IERC1271, ERC721Holder, ERC1155Holder {
    using SafeERC20 for IERC20;

    struct Session {
        uint48 validUntil; // unix seconds
        uint32 epoch; // must equal the account's epoch (revokeAllSessions bumps it)
        uint64 maxPerBuy; // gross USDC units (6 dp) per buy
        uint64 maxPerDay; // gross USDC units per UTC day
        uint32 day; // UTC day of `spentToday`
        uint64 spentToday;
    }

    struct Buy {
        address token; // USDC or a token FastBridge converts through a PropAMM pool
        uint256 amountIn;
        uint256 minUsdcOut; // slippage bound on the conversion (ignored for USDC)
        uint256 deadline;
        uint256 nonce; // any unused value (unordered, so the app can sign buys in parallel)
    }

    /// @custom:storage-location erc7201:neuriio.account
    struct AccountStorage {
        uint32 epoch;
        mapping(address key => Session) sessions;
        mapping(uint256 nonce => bool) usedNonces;
    }

    // keccak256(abi.encode(uint256(keccak256("neuriio.account")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT = 0x2d9a5c4936161c04d0a93a6d0b011ce0c318fa5ade4d53a04ff8ce46e246ee00;

    bytes32 public constant BUY_TYPEHASH =
        keccak256("Buy(address token,uint256 amountIn,uint256 minUsdcOut,uint256 deadline,uint256 nonce)");
    bytes32 public constant ADD_SESSION_TYPEHASH = keccak256(
        "AddSession(address key,uint48 validUntil,uint64 maxPerBuy,uint64 maxPerDay,uint32 epoch,uint256 nonce)"
    );

    FastBridge public immutable bridge;

    event SessionAdded(address indexed key, uint48 validUntil, uint64 maxPerBuy, uint64 maxPerDay);
    event SessionRevoked(address indexed key);
    event AllSessionsRevoked(uint32 newEpoch);
    event Bought(address indexed key, uint256 indexed depositId, address token, uint256 amountIn, uint256 usdcGross);

    error OnlySelf();
    error BadSignature();
    error InvalidSession(address key);
    error InvalidParams();
    error Expired();
    error NonceUsed(uint256 nonce);
    error StaleEpoch(uint32 signed, uint32 current);
    error OverPerBuyCap(uint256 gross, uint256 cap);
    error OverDailyCap(uint256 wouldBe, uint256 cap);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    constructor(FastBridge bridge_) EIP712("Neuriio Account", "1") {
        bridge = bridge_;
    }

    /// Delegated wallets must still accept plain HYPE transfers.
    receive() external payable {}

    // ------------------------------------------------------------------ sessions (owner only)

    function addSession(address key, uint48 validUntil, uint64 maxPerBuy, uint64 maxPerDay) external onlySelf {
        _addSession(key, validUntil, maxPerBuy, maxPerDay);
    }

    /// @notice Gas-free setup: the user signs, our sponsor submits (usually in the same type-4
    ///         transaction that carries the 7702 authorization).
    function addSessionWithSig(
        address key,
        uint48 validUntil,
        uint64 maxPerBuy,
        uint64 maxPerDay,
        uint32 epoch_,
        uint256 nonce,
        bytes calldata signature
    ) external {
        AccountStorage storage $ = _s();
        // bound to the epoch so a signature can't resurrect a session after revokeAllSessions
        if (epoch_ != $.epoch) revert StaleEpoch(epoch_, $.epoch);
        _useNonce($, nonce);
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ADD_SESSION_TYPEHASH, key, validUntil, maxPerBuy, maxPerDay, epoch_, nonce))
        );
        if (!_rawSignatureValidation(digest, signature)) revert BadSignature();
        _addSession(key, validUntil, maxPerBuy, maxPerDay);
    }

    function revokeSession(address key) external onlySelf {
        delete _s().sessions[key];
        emit SessionRevoked(key);
    }

    /// @notice Kill switch: invalidates every session key at once.
    function revokeAllSessions() external onlySelf {
        AccountStorage storage $ = _s();
        emit AllSessionsRevoked(++$.epoch);
    }

    // ------------------------------------------------------------------ one-click buy

    /// @notice Executes a buy signed by a session key. Anyone may submit it (gas sponsor).
    ///         Tokens go through FastBridge to THIS address's HyperCore account, nowhere else.
    function buy(Buy calldata b, bytes calldata signature) external returns (uint256 depositId) {
        if (block.timestamp > b.deadline) revert Expired();
        AccountStorage storage $ = _s();
        _useNonce($, b.nonce);
        address key = ECDSA.recover(
            _hashTypedDataV4(
                keccak256(abi.encode(BUY_TYPEHASH, b.token, b.amountIn, b.minUsdcOut, b.deadline, b.nonce))
            ),
            signature
        );
        Session storage s = $.sessions[key];
        if (s.maxPerBuy == 0 || s.epoch != $.epoch || block.timestamp > s.validUntil) revert InvalidSession(key);

        IERC20(b.token).forceApprove(address(bridge), b.amountIn);
        depositId = bridge.deposit(b.token, b.amountIn, b.minUsdcOut, address(this), b.deadline);
        (,,,, uint96 amount, uint96 fee) = bridge.deposits(depositId);
        uint256 gross = uint256(amount) + fee;

        if (gross > s.maxPerBuy) revert OverPerBuyCap(gross, s.maxPerBuy);
        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = (s.day == today ? s.spentToday : 0) + gross;
        if (spent > s.maxPerDay) revert OverDailyCap(spent, s.maxPerDay);
        s.day = today;
        // casting to 'uint64' is safe because spent <= maxPerDay, a uint64
        // forge-lint: disable-next-line(unsafe-typecast)
        s.spentToday = uint64(spent);

        emit Bought(key, depositId, b.token, b.amountIn, gross);
    }

    // ------------------------------------------------------------------ views

    function session(address key) external view returns (Session memory) {
        return _s().sessions[key];
    }

    function epoch() external view returns (uint32) {
        return _s().epoch;
    }

    function nonceUsed(uint256 nonce) external view returns (bool) {
        return _s().usedNonces[nonce];
    }

    /// @notice ERC-1271: valid only for the wallet's own key, exactly like a plain EOA signature.
    ///         Session keys can never sign on the wallet's behalf (no permits, no logins).
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _rawSignatureValidation(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    // ------------------------------------------------------------------ internals

    function _addSession(address key, uint48 validUntil, uint64 maxPerBuy, uint64 maxPerDay) internal {
        if (key == address(0) || key == address(this) || maxPerBuy == 0 || maxPerDay < maxPerBuy) {
            revert InvalidParams();
        }
        if (validUntil <= block.timestamp) revert InvalidParams();
        AccountStorage storage $ = _s();
        $.sessions[key] = Session({
            validUntil: validUntil, epoch: $.epoch, maxPerBuy: maxPerBuy, maxPerDay: maxPerDay, day: 0, spentToday: 0
        });
        emit SessionAdded(key, validUntil, maxPerBuy, maxPerDay);
    }

    function _useNonce(AccountStorage storage $, uint256 nonce) internal {
        if ($.usedNonces[nonce]) revert NonceUsed(nonce);
        $.usedNonces[nonce] = true;
    }

    function _s() private pure returns (AccountStorage storage $) {
        assembly {
            $.slot := STORAGE_SLOT
        }
    }
}
