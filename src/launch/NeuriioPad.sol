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
import {NeuriioToken} from "./NeuriioToken.sol";
import {NeuriioRegistry} from "./NeuriioRegistry.sol";
import {ISwapFactory, ISwapPair} from "../swap/interfaces.sol";

/// The NeuriioFees side a curve fee goes to: the pad transfers the fee (USDC), then calls this with its amount.
interface ICurveFeeVault {
    function notifyCurveFee(address token, uint256 amount) external;
}

/// @notice "Tokenize Accounts": a pump.fun-style launchpad priced in USDC. A token is either one person
/// (`launch`, named at-sign + X handle) or an FTF, "Friends Turned Fam" (`launchFtf`): exactly 4 people who agreed to launch
/// one group token together, all 4 fixed at launch, sharing its creator fees equally. Both kinds use the same curve.
///
/// Launching needs a LaunchPass signed by our backend (`launchSigner`) after it verifies the creator's X login.
/// One token per X account (keyed by the permanent X user ID) and per wallet, named after the creator (at-sign + handle) with the
/// handle in caps as the ticker; the pass also fixes the creator's category and the hash of their profile (who they
/// are + links to their work; the profile itself lives off-chain). Tokens are memes: no promises. Launching is free:
/// 1B supply, all held here. 793.1M are sold on a bonding curve, a constant-product curve over *virtual* reserves
/// (`virtualQuote` USDC : 1.073B tokens at launch), so no seed liquidity is needed. Every trade pays a fee (`feeBps`, 1%
/// at deploy) to the NeuriioFees, in USDC, split there: on the curve 50% $NEURIIO stakers / 30% KNTQ buyback / 10%
/// creator / 10% treasury; in the pool after graduation (the pool takes the same 1%) 40% that token's stakers / 40%
/// $NEURIIO stakers / 10% creator / 10% treasury. The buy that sells the last curve token graduates the token in the same
/// tx: every USDC raised plus the remaining 206.9M tokens go into our pool on our Uniswap V2 fork (TOKEN/USDC,
/// src/swap/v2) and the LP tokens are sent to the dead address (burned), so that liquidity is locked forever. The
/// curve's final price equals the pool's opening price.
///
/// Upgrades: this contract is one replaceable version. Identity (one token per X account / wallet / handle, FTF
/// tickers, reserved tickers) and each token's NeuriioPad + creators live in the permanent NeuriioRegistry, so a new
/// version never orphans tokens or lets anyone launch twice; a retired version keeps serving its own curves.
contract NeuriioPad is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 793_100_000e18;
    uint256 public constant LP_SUPPLY = TOTAL_SUPPLY - CURVE_SUPPLY; // 206.9M
    uint256 public constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 public constant MAX_FEE_BPS = 200;
    uint256 public constant MIN_VIRTUAL_QUOTE = 1e6; // 1 USDC
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_HANDLE_LENGTH = 15; // X's limit
    uint256 public constant FTF_MEMBERS = 4;
    uint256 public constant MAX_FTF_NAME_LENGTH = 32;
    uint256 public constant MIN_FTF_TICKER_LENGTH = 2;
    uint256 public constant MAX_FTF_TICKER_LENGTH = 10;
    bytes32 public constant LAUNCH_PASS_TYPEHASH = keccak256(
        "LaunchPass(address creator,uint64 xUserId,string handle,uint8 category,bytes32 profileHash,uint256 deadline)"
    );
    bytes32 public constant FTF_PASS_TYPEHASH = keccak256(
        "FtfPass(address founder,string name,string ticker,uint64[4] memberXIds,address[4] members,bytes32 profileHash,uint256 deadline)"
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

    /// Signed by `launchSigner` once the backend has verified all 4 members' X logins and that each accepted.
    struct FtfPass {
        address founder; // launches it (must be msg.sender and members[0])
        string name; // display name, e.g. "Degen Den"
        string ticker; // A-Z 0-9, unique among FTFs
        uint64[4] memberXIds; // permanent X user IDs, founder first
        address[4] members; // their Neuriio wallets (fee recipients), same order
        bytes32 profileHash; // keccak256 of the FTF's profile document stored off-chain
        uint256 deadline;
    }

    struct Ftf {
        string name;
        bytes32 profileHash;
        uint64[4] memberXIds;
        address[4] members;
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
        uint128 virtualQuote; // curve USDC reserve (virtual + raised)
        uint128 virtualToken; // curve token reserve (virtual)
        uint128 realQuote; // USDC actually raised and held here (moves to the pool at graduation)
        uint128 realToken; // curve tokens still for sale
    }

    ISwapFactory public immutable factory;
    IERC20 public immutable quote; // USDC
    NeuriioRegistry public immutable registry;

    /// Starting virtual USDC reserve for NEW launches. Graduation raises ~2.8335x this, at a market cap of ~13.7x it.
    uint256 public virtualQuote;
    uint16 public feeBps;
    /// Receives every curve fee. Owner-replaceable (`setFeeVault`), so a NeuriioFees fix or a new fee split never needs
    /// a new NeuriioPad, and a broken vault can't freeze trading.
    ICurveFeeVault public feeVault;

    mapping(address token => Curve) public curves;
    address[] public allTokens;

    address public launchSigner;
    /// May pause at once besides the owner (only pause: unpausing is the owner's). On mainnet the owner is a timelock
    /// and the guardian the multisig, so an emergency stop doesn't wait for the timelock's delay.
    address public guardian;
    mapping(address token => Profile) internal _profiles;
    mapping(address token => Ftf) internal _ftfs;

    event Launched(
        address indexed token,
        address indexed creator,
        uint64 indexed xUserId,
        string handle,
        Category category,
        bytes32 profileHash,
        uint256 virtualQuote
    );
    event FtfLaunched(
        address indexed token,
        address indexed founder,
        string name,
        string ticker,
        uint64[4] memberXIds,
        address[4] members,
        bytes32 profileHash,
        uint256 virtualQuote
    );
    event LaunchSignerSet(address signer);
    event GuardianSet(address guardian);
    event Trade(
        address indexed token,
        address indexed trader,
        bool isBuy,
        uint256 quoteAmount, // USDC into (buy) / out of (sell) the curve, excluding the fee
        uint256 tokenAmount,
        uint256 fee,
        uint256 virtualQuote,
        uint256 virtualToken
    );
    event Graduated(
        address indexed token, address indexed pair, uint256 quote, uint256 tokens, uint256 liquidityBurned
    );
    event VirtualQuoteSet(uint256 virtualQuote);
    event FeeSet(uint16 feeBps);
    event FeeVaultSet(address feeVault);

    error UnknownToken(address token);
    error AlreadyGraduated(address token);
    error Expired();
    error ZeroAmount();
    error Slippage(uint256 out, uint256 minOut);
    error InvalidParams();
    error InvalidMetadata();
    error InvalidPass();
    error NotPassHolder();
    error InvalidMembers();
    error NotOwnerOrGuardian();

    constructor(
        address owner_,
        ISwapFactory factory_,
        IERC20 quote_,
        uint256 virtualQuote_,
        uint16 feeBps_,
        address launchSigner_,
        ICurveFeeVault feeVault_,
        NeuriioRegistry registry_
    ) Ownable(owner_) EIP712("Neuriio Launchpad", "1") {
        factory = factory_;
        quote = quote_;
        feeVault = feeVault_;
        registry = registry_;
        _setLaunchSigner(launchSigner_);
        _setVirtualQuote(virtualQuote_);
        _setFee(feeBps_);
    }

    // ------------------------------------------------------------------ launch + trade

    /// @notice Launch your own token with a pass from our backend. `quoteIn` > 0 is an initial buy for the creator, in
    /// USDC (needs an approval; `minTokensOut` applies).
    function launch(LaunchPass calldata pass, bytes calldata signature, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
        returns (address token)
    {
        if (block.timestamp > pass.deadline) revert Expired();
        if (msg.sender != pass.creator) revert NotPassHolder();
        if (ECDSA.recover(hashLaunchPass(pass), signature) != launchSigner) revert InvalidPass();
        if (pass.category > uint8(type(Category).max) || pass.xUserId == 0) revert InvalidPass();
        (string memory symbol, bytes32 handleKey) = _checkHandle(pass.handle);

        uint256 vq;
        (token, vq) = _newCurve(string.concat("@", pass.handle), symbol);
        _profiles[token] = Profile(pass.xUserId, Category(pass.category), pass.profileHash, pass.handle);
        // one per X account / wallet / handle across every NeuriioPad version, and no reserved tickers (reverts)
        registry.registerPersonal(token, msg.sender, pass.xUserId, symbol, handleKey);
        emit Launched(token, msg.sender, pass.xUserId, pass.handle, Category(pass.category), pass.profileHash, vq);

        if (quoteIn > 0) _buy(token, quoteIn, minTokensOut);
    }

    /// @notice Launch an FTF: one token for 4 people, on the same bonding curve, with a pass from our backend
    /// (after all 4 accepted). The founder sends it; `quoteIn` > 0 is the founder's initial buy, in USDC. Members are
    /// fixed forever and share the creator fees equally. Being in an FTF doesn't use up anyone's individual launch.
    function launchFtf(FtfPass calldata pass, bytes calldata signature, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
        returns (address token)
    {
        if (block.timestamp > pass.deadline) revert Expired();
        if (msg.sender != pass.founder || pass.members[0] != msg.sender) revert NotPassHolder();
        if (ECDSA.recover(hashFtfPass(pass), signature) != launchSigner) revert InvalidPass();
        _checkMembers(pass.memberXIds, pass.members);
        _checkFtfName(pass.name);
        _checkFtfTicker(pass.ticker);

        uint256 vq;
        (token, vq) = _newCurve(pass.name, pass.ticker);
        _ftfs[token] = Ftf(pass.name, pass.profileHash, pass.memberXIds, pass.members);
        registry.registerFtf(token, pass.ticker, pass.members); // ticker unique among FTFs, not reserved (reverts)
        emit FtfLaunched(token, msg.sender, pass.name, pass.ticker, pass.memberXIds, pass.members, pass.profileHash, vq);

        if (quoteIn > 0) _buy(token, quoteIn, minTokensOut);
    }

    /// @notice Buy with up to `quoteIn` USDC (needs an approval). If this sells out the curve, only what's needed is
    /// taken and the token graduates in this tx.
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        tokensOut = _buy(token, quoteIn, minTokensOut);
    }

    /// @notice Sell tokens back to the curve for USDC (needs an approval of `tokensIn`). Works even while paused:
    /// a pause stops launches and buys, but holders can always exit.
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        Curve storage c = _live(token);
        uint256 gross;
        uint256 fee;
        (quoteOut, gross, fee) = _quoteSell(c, tokensIn);
        if (quoteOut == 0) revert ZeroAmount();
        if (quoteOut < minQuoteOut) revert Slippage(quoteOut, minQuoteOut);

        c.virtualQuote -= gross.toUint128();
        c.virtualToken += tokensIn.toUint128();
        c.realQuote -= gross.toUint128();
        c.realToken += tokensIn.toUint128();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        emit Trade(token, msg.sender, false, gross, tokensIn, fee, c.virtualQuote, c.virtualToken);
        _payFee(token, fee);
        quote.safeTransfer(msg.sender, quoteOut);
    }

    // ------------------------------------------------------------------ views

    /// @return tokensOut tokens received for up to `quoteIn` USDC
    /// @return spent     USDC actually taken, fee included (less than `quoteIn` only when this buy sells out the curve)
    /// @return fee       the fee within `spent`
    function previewBuy(address token, uint256 quoteIn)
        external
        view
        returns (uint256 tokensOut, uint256 spent, uint256 fee)
    {
        uint256 net;
        (tokensOut, net, fee) = _quoteBuy(_live(token), quoteIn);
        spent = net + fee;
    }

    /// @return quoteOut USDC received for `tokensIn`, after the fee
    /// @return fee      fee taken
    function previewSell(address token, uint256 tokensIn) external view returns (uint256 quoteOut, uint256 fee) {
        (quoteOut,, fee) = _quoteSell(_live(token), tokensIn);
    }

    /// @notice USDC (all-in, including the fee) that buys every remaining curve token and graduates it.
    function quoteToGraduate(address token) external view returns (uint256) {
        Curve storage c = _live(token);
        uint256 net = _quoteForTokens(c, c.realToken);
        return net + _fee(net, true);
    }

    /// @notice Spot price: USDC base units per whole token (1e18 base units).
    function price(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken(token);
        return Math.mulDiv(c.virtualQuote, 1e18, c.virtualToken);
    }

    /// @notice Who launched `token` (for an FTF: its founder); address(0) if unknown.
    function creatorOf(address token) external view returns (address) {
        return curves[token].creator;
    }

    function isFtf(address token) external view returns (bool) {
        return _ftfs[token].members[0] != address(0);
    }

    function ftf(address token) external view returns (Ftf memory) {
        return _ftfs[token];
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

    /// @notice EIP-712 digest the backend signs for an FTF pass.
    function hashFtfPass(FtfPass calldata pass) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FTF_PASS_TYPEHASH,
                    pass.founder,
                    keccak256(bytes(pass.name)),
                    keccak256(bytes(pass.ticker)),
                    keccak256(abi.encodePacked(pass.memberXIds)),
                    keccak256(abi.encodePacked(pass.members)),
                    pass.profileHash,
                    pass.deadline
                )
            )
        );
    }

    // ------------------------------------------------------------------ owner

    function setVirtualQuote(uint256 virtualQuote_) external onlyOwner {
        _setVirtualQuote(virtualQuote_);
    }

    /// @notice Point curve fees at a new NeuriioFees (it must accept this NeuriioPad's tokens via the NeuriioRegistry).
    /// Creators' balances already in the old vault stay claimable there.
    function setFeeVault(ICurveFeeVault feeVault_) external onlyOwner {
        if (address(feeVault_) == address(0)) revert InvalidParams();
        feeVault = feeVault_;
        emit FeeVaultSet(address(feeVault_));
    }

    function setFee(uint16 feeBps_) external onlyOwner {
        _setFee(feeBps_);
    }

    /// @notice Rotate the backend key that signs launch passes (address(0) stops all launches).
    function setLaunchSigner(address signer) external onlyOwner {
        _setLaunchSigner(signer);
    }

    /// @notice Who may pause at once besides the owner (address(0) = nobody).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Emergency stop for launches and buys (and so graduations), by the owner or the guardian. Sells stay open
    /// so holders can always exit. Only the owner unpauses.
    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ internals

    /// A new token (all 1B held here) and its fresh curve at the current `virtualQuote`.
    function _newCurve(string memory name, string memory symbol) internal returns (address token, uint256 vq) {
        token = address(new NeuriioToken(name, symbol, TOTAL_SUPPLY));
        vq = virtualQuote;
        curves[token] = Curve({
            creator: msg.sender,
            graduated: false,
            virtualQuote: vq.toUint128(),
            virtualToken: uint128(VIRTUAL_TOKENS),
            realQuote: 0,
            realToken: uint128(CURVE_SUPPLY)
        });
        allTokens.push(token);
    }

    function _buy(address token, uint256 quoteIn, uint256 minTokensOut) internal returns (uint256 tokensOut) {
        Curve storage c = _live(token);
        uint256 net;
        uint256 fee;
        (tokensOut, net, fee) = _quoteBuy(c, quoteIn);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);

        c.virtualQuote += net.toUint128();
        c.virtualToken -= tokensOut.toUint128();
        c.realQuote += net.toUint128();
        c.realToken -= tokensOut.toUint128();

        quote.safeTransferFrom(msg.sender, address(this), net + fee); // only what's used
        IERC20(token).safeTransfer(msg.sender, tokensOut);
        emit Trade(token, msg.sender, true, net, tokensOut, fee, c.virtualQuote, c.virtualToken);
        _payFee(token, fee);

        if (c.realToken == 0) _graduate(token, c);
    }

    function _payFee(address token, uint256 fee) internal {
        if (fee == 0) return;
        quote.safeTransfer(address(feeVault), fee);
        feeVault.notifyCurveFee(token, fee);
    }

    /// Curve sold out: all raised USDC + LP_SUPPLY tokens into a new V2 pair, LP tokens burned.
    function _graduate(address token, Curve storage c) internal {
        c.graduated = true;
        uint256 raised = c.realQuote;
        c.realQuote = 0;

        address pair = factory.createPair(token, address(quote));
        // Tokens sent to the (predictable) pair address before now would skew the opening price: clear them.
        ISwapPair(pair).skim(DEAD);
        IERC20(token).safeTransfer(pair, LP_SUPPLY);
        quote.safeTransfer(pair, raised);
        uint256 liquidity = ISwapPair(pair).mint(DEAD);
        emit Graduated(token, pair, raised, LP_SUPPLY, liquidity);
    }

    /// Fee comes off the top; tokens out on the curve, capped at what's left for sale.
    function _quoteBuy(Curve storage c, uint256 quoteIn)
        internal
        view
        returns (uint256 tokensOut, uint256 net, uint256 fee)
    {
        fee = _fee(quoteIn, false);
        net = quoteIn - fee;
        uint256 vq = c.virtualQuote;
        uint256 vt = c.virtualToken;
        tokensOut = vt - Math.mulDiv(vq, vt, vq + net, Math.Rounding.Ceil);
        if (tokensOut >= c.realToken) {
            tokensOut = c.realToken;
            net = _quoteForTokens(c, tokensOut);
            fee = _fee(net, true);
            if (net + fee > quoteIn) fee = quoteIn - net; // rounding edge: never charge more than offered
        }
    }

    function _quoteSell(Curve storage c, uint256 tokensIn)
        internal
        view
        returns (uint256 quoteOut, uint256 gross, uint256 fee)
    {
        uint256 vq = c.virtualQuote;
        uint256 vt = c.virtualToken;
        gross = vq - Math.mulDiv(vq, vt, vt + tokensIn, Math.Rounding.Ceil);
        gross = Math.min(gross, c.realQuote); // can't pay out more than was raised
        fee = _fee(gross, true);
        quoteOut = gross - fee;
    }

    /// USDC into the curve (excluding fee) to take `tokens` out.
    function _quoteForTokens(Curve storage c, uint256 tokens) internal view returns (uint256) {
        uint256 vq = c.virtualQuote;
        uint256 vt = c.virtualToken;
        return Math.mulDiv(vq, vt, vt - tokens, Math.Rounding.Ceil) - vq;
    }

    /// `ofNet`: fee on an amount that excludes it (ceil); otherwise the fee inside a gross amount (floor).
    function _fee(uint256 amount, bool ofNet) internal view returns (uint256) {
        return
            ofNet
                ? Math.mulDiv(amount, feeBps, 10_000, Math.Rounding.Ceil)
                : Math.mulDiv(amount, feeBps, 10_000 + feeBps);
    }

    function _live(address token) internal view returns (Curve storage c) {
        c = curves[token];
        if (c.creator == address(0)) revert UnknownToken(token);
        if (c.graduated) revert AlreadyGraduated(token);
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

    /// 4 distinct members: nonzero X IDs and wallets, no repeats.
    function _checkMembers(uint64[4] calldata xIds, address[4] calldata wallets) internal pure {
        for (uint256 i; i < FTF_MEMBERS; ++i) {
            if (xIds[i] == 0 || wallets[i] == address(0)) revert InvalidMembers();
            for (uint256 j; j < i; ++j) {
                if (xIds[i] == xIds[j] || wallets[i] == wallets[j]) revert InvalidMembers();
            }
        }
    }

    /// FTF name: 1-32 chars of letters, digits, spaces and - _ . & ', no leading/trailing/double spaces.
    function _checkFtfName(string calldata name) internal pure {
        bytes calldata b = bytes(name);
        uint256 n = b.length;
        if (n == 0 || n > MAX_FTF_NAME_LENGTH || b[0] == 0x20 || b[n - 1] == 0x20) revert InvalidMetadata();
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c == 0x20
                || c == 0x2d || c == 0x5f || c == 0x2e || c == 0x26 || c == 0x27;
            if (!ok || (c == 0x20 && b[i - 1] == 0x20)) revert InvalidMetadata();
        }
    }

    /// FTF ticker: 2-10 chars of A-Z 0-9 (already upper case). Returns its uniqueness key.
    function _checkFtfTicker(string calldata ticker) internal pure returns (bytes32) {
        bytes calldata b = bytes(ticker);
        uint256 n = b.length;
        if (n < MIN_FTF_TICKER_LENGTH || n > MAX_FTF_TICKER_LENGTH) revert InvalidMetadata();
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            if (!((c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39))) revert InvalidMetadata();
        }
        return keccak256(b);
    }

    function _setLaunchSigner(address signer) internal {
        launchSigner = signer;
        emit LaunchSignerSet(signer);
    }

    function _setVirtualQuote(uint256 v) internal {
        if (v < MIN_VIRTUAL_QUOTE || v > type(uint96).max) revert InvalidParams();
        virtualQuote = v;
        emit VirtualQuoteSet(v);
    }

    function _setFee(uint16 f) internal {
        if (f > MAX_FEE_BPS) revert InvalidParams();
        feeBps = f;
        emit FeeSet(f);
    }
}
