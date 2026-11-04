// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAscendAdapter} from "./IAscendAdapter.sol";

/// @notice Launching through Neuriio, with the token and its pool living on Ascend (user, 2026-11-01). This contract only
/// does what Ascend can't: it checks a pass signed by our backend after it verifies X logins, and holds us to our launch
/// rules. A token is either one person (`launch`: one token per X account, per wallet and per handle, named at-sign + handle
/// with the handle in caps as the ticker) or an FTF, "Friends Turned Fam" (`launchFtf`: exactly 4 people, fixed at launch,
/// sharing its creator fees equally, with a ticker unique among FTFs; being in one doesn't use up a personal launch).
/// A launch can include the creator's first buy, in Ascend's pool at market, in the same transaction, so nobody gets in
/// ahead of them. There's no curve, pool or fee here: all of that is Ascend's. Holds no funds.
contract NeuriioLauncher is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_HANDLE_LENGTH = 15; // X's limit
    uint256 public constant FTF_MEMBERS = 4;
    uint256 public constant MAX_FTF_NAME_LENGTH = 32;
    uint256 public constant MIN_FTF_TICKER_LENGTH = 2;
    uint256 public constant MAX_FTF_TICKER_LENGTH = 10;
    bytes32 public constant LAUNCH_PASS_TYPEHASH = keccak256(
        "LaunchPass(address creator,uint64 xUserId,string handle,uint8 category,bytes32 profileHash,bytes launchData,uint256 deadline)"
    );
    bytes32 public constant FTF_PASS_TYPEHASH = keccak256(
        "FtfPass(address founder,string name,string ticker,uint64[4] memberXIds,address[4] members,bytes32 profileHash,bytes launchData,uint256 deadline)"
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
        bytes launchData; // whatever else Ascend's launch needs (metadata, a salt...), passed to the adapter as is
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
        bytes launchData; // whatever else Ascend's launch needs (metadata, a salt...), passed to the adapter as is
        uint256 deadline;
    }

    struct Launch {
        address creator; // an FTF: its founder
        uint64 xUserId; // an FTF: 0 (see `ftf`)
        Category category; // an FTF: unused
        bytes32 profileHash;
        bytes32 pool; // the adapter's identifier for its pool on Ascend
        string handle; // an FTF: empty
    }

    struct Ftf {
        string name;
        uint64[4] memberXIds;
        address[4] members;
    }

    IERC20 public immutable quote; // USDC: what a first buy pays with
    /// Makes the launch call on Ascend. Owner-replaceable; address(0) stops all launches.
    IAscendAdapter public adapter;
    address public launchSigner;
    /// May pause at once besides the owner (only pause: unpausing is the owner's). On mainnet the owner is a timelock and
    /// the guardian the multisig, so an emergency stop doesn't wait for the timelock's delay.
    address public guardian;

    mapping(address token => Launch) internal _launches;
    mapping(address token => Ftf) internal _ftfs;
    address[] public allTokens;
    mapping(uint64 xUserId => address token) public tokenOfXUser;
    mapping(address creator => address token) public tokenOfCreator;
    mapping(bytes32 handleKey => address token) public tokenOfHandle; // keccak256(lower-case handle)
    mapping(bytes32 tickerKey => address token) public tokenOfFtfTicker; // keccak256(ticker); FTFs' own namespace
    /// Tickers nobody can launch: keccak256 of the upper-case ticker.
    mapping(bytes32 tickerKey => bool) public reservedTicker;

    event Launched(
        address indexed token,
        address indexed creator,
        uint64 indexed xUserId,
        string handle,
        Category category,
        bytes32 profileHash,
        bytes32 pool
    );
    event FtfLaunched(
        address indexed token,
        address indexed founder,
        string name,
        string ticker,
        uint64[4] memberXIds,
        address[4] members,
        bytes32 profileHash,
        bytes32 pool
    );
    event FirstBuy(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut);
    event AdapterSet(address adapter);
    event LaunchSignerSet(address signer);
    event GuardianSet(address guardian);
    event TickerReserved(string ticker, bool reserved);

    error Expired();
    error InvalidPass();
    error InvalidMetadata();
    error NotPassHolder();
    error InvalidMembers();
    error AlreadyLaunched();
    error TickerTaken();
    error TickerIsReserved();
    error NoAdapter();
    error Slippage(uint256 tokensOut, uint256 minTokensOut);
    error BadAdapterToken();
    error AdapterKeptUsdc();
    error NotOwnerOrGuardian();

    /// The owner and guardian come in at deploy, so the deployer never holds any power (script/DeployAscend.s.sol). There's
    /// no adapter yet: the owner plugs it in once Ascend's contracts are known, and until then launches revert.
    constructor(address owner_, IERC20 quote_, address launchSigner_, address guardian_)
        Ownable(owner_)
        EIP712("Neuriio Launchpad", "1")
    {
        quote = quote_;
        launchSigner = launchSigner_;
        guardian = guardian_;
        emit LaunchSignerSet(launchSigner_);
        emit GuardianSet(guardian_);
        string[19] memory reserved = [
            "HYPE",
            "WHYPE",
            "KHYPE",
            "STHYPE",
            "USDC",
            "USDT",
            "USDH",
            "USDE",
            "USD",
            "DAI",
            "ETH",
            "WETH",
            "BTC",
            "WBTC",
            "UBTC",
            "SOL",
            "KNTQ",
            "PURR",
            "NEURIIO"
        ];
        for (uint256 i; i < reserved.length; ++i) {
            _setReserved(reserved[i], true);
        }
    }

    // ------------------------------------------------------------------ launch

    /// @notice Launch your own token on Ascend with a pass from our backend. `quoteIn` > 0 is your first buy, in USDC (needs
    /// an approval; `minTokensOut` applies).
    function launch(LaunchPass calldata pass, bytes calldata signature, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
        returns (address token)
    {
        (string memory symbol, bytes32 handleKey) = _checkPass(pass, signature);

        address[] memory creators = new address[](1);
        creators[0] = msg.sender;
        bytes32 pool;
        (token, pool) = _launchOnAscend(creators, string.concat("@", pass.handle), symbol, pass.launchData);

        _recordPersonal(token, pool, pass, handleKey);

        if (quoteIn > 0) _firstBuy(token, pool, quoteIn, minTokensOut);
    }

    /// @notice Launch an FTF, one token for 4 people, on Ascend with a pass from our backend (after all 4 accepted). The
    /// founder sends it, and `quoteIn` > 0 is the founder's first buy, in USDC. Members are fixed forever.
    function launchFtf(FtfPass calldata pass, bytes calldata signature, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        whenNotPaused
        returns (address token)
    {
        bytes32 tickerKey = _checkFtfPass(pass, signature);

        address[] memory creators = new address[](FTF_MEMBERS);
        for (uint256 i; i < FTF_MEMBERS; ++i) {
            creators[i] = pass.members[i];
        }
        bytes32 pool;
        (token, pool) = _launchOnAscend(creators, pass.name, pass.ticker, pass.launchData);

        tokenOfFtfTicker[tickerKey] = token;
        _recordFtf(token, pool, pass);

        if (quoteIn > 0) _firstBuy(token, pool, quoteIn, minTokensOut);
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether `token` was launched through here.
    function isLaunched(address token) external view returns (bool) {
        return _launches[token].creator != address(0);
    }

    /// @notice Who launched `token` (for an FTF: its founder); address(0) if it wasn't launched through here.
    function creatorOf(address token) external view returns (address) {
        return _launches[token].creator;
    }

    function isFtf(address token) public view returns (bool) {
        return _ftfs[token].members[0] != address(0);
    }

    function ftf(address token) external view returns (Ftf memory) {
        return _ftfs[token];
    }

    /// @notice Who shares `token`'s creator fees: its creator, or an FTF's 4 members (founder first). Empty if unknown.
    function creatorsOf(address token) external view returns (address[] memory creators) {
        if (isFtf(token)) {
            creators = new address[](FTF_MEMBERS);
            for (uint256 i; i < FTF_MEMBERS; ++i) {
                creators[i] = _ftfs[token].members[i];
            }
        } else if (_launches[token].creator != address(0)) {
            creators = new address[](1);
            creators[0] = _launches[token].creator;
        }
    }

    function launchOf(address token) external view returns (Launch memory) {
        return _launches[token];
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
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
                    keccak256(pass.launchData),
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
                    keccak256(pass.launchData),
                    pass.deadline
                )
            )
        );
    }

    // ------------------------------------------------------------------ owner

    /// @notice Plug in the contract that launches on Ascend (address(0) stops all launches).
    function setAdapter(IAscendAdapter adapter_) external onlyOwner {
        adapter = adapter_;
        emit AdapterSet(address(adapter_));
    }

    /// @notice Rotate the backend key that signs launch passes (address(0) stops all launches).
    function setLaunchSigner(address signer) external onlyOwner {
        launchSigner = signer;
        emit LaunchSignerSet(signer);
    }

    /// @notice Who may pause at once besides the owner (address(0) = nobody).
    function setGuardian(address guardian_) external onlyOwner {
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    /// @notice Reserve (or free) tickers, given in upper case. Tokens already launched are not affected.
    function setReservedTickers(string[] calldata tickers, bool reserved) external onlyOwner {
        for (uint256 i; i < tickers.length; ++i) {
            _setReserved(tickers[i], reserved);
        }
    }

    /// @notice Emergency stop for launches, by the owner or the guardian. Trading is on Ascend and isn't affected. Only
    /// the owner unpauses.
    function pause() external {
        if (msg.sender != owner() && msg.sender != guardian) revert NotOwnerOrGuardian();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ internals

    function _checkPass(LaunchPass calldata pass, bytes calldata signature)
        internal
        view
        returns (string memory symbol, bytes32 handleKey)
    {
        if (block.timestamp > pass.deadline) revert Expired();
        if (msg.sender != pass.creator) revert NotPassHolder();
        if (ECDSA.recover(hashLaunchPass(pass), signature) != launchSigner) revert InvalidPass();
        if (pass.category > uint8(type(Category).max) || pass.xUserId == 0) revert InvalidPass();
        (symbol, handleKey) = _checkHandle(pass.handle);
        if (reservedTicker[keccak256(bytes(symbol))]) revert TickerIsReserved();
        if (
            tokenOfXUser[pass.xUserId] != address(0) || tokenOfCreator[msg.sender] != address(0)
                || tokenOfHandle[handleKey] != address(0)
        ) {
            revert AlreadyLaunched();
        }
    }

    function _checkFtfPass(FtfPass calldata pass, bytes calldata signature) internal view returns (bytes32 tickerKey) {
        if (block.timestamp > pass.deadline) revert Expired();
        if (msg.sender != pass.founder || pass.members[0] != msg.sender) revert NotPassHolder();
        if (ECDSA.recover(hashFtfPass(pass), signature) != launchSigner) revert InvalidPass();
        _checkMembers(pass.memberXIds, pass.members);
        _checkFtfName(pass.name);
        tickerKey = _checkFtfTicker(pass.ticker);
        if (reservedTicker[tickerKey]) revert TickerIsReserved();
        if (tokenOfFtfTicker[tickerKey] != address(0)) revert TickerTaken();
    }

    function _recordPersonal(address token, bytes32 pool, LaunchPass calldata pass, bytes32 handleKey) internal {
        tokenOfXUser[pass.xUserId] = token;
        tokenOfCreator[msg.sender] = token;
        tokenOfHandle[handleKey] = token;
        _launches[token] =
            Launch(msg.sender, pass.xUserId, Category(pass.category), pass.profileHash, pool, pass.handle);
        allTokens.push(token);
        emit Launched(token, msg.sender, pass.xUserId, pass.handle, Category(pass.category), pass.profileHash, pool);
    }

    function _recordFtf(address token, bytes32 pool, FtfPass calldata pass) internal {
        _launches[token] = Launch(msg.sender, 0, Category.Trader, pass.profileHash, pool, "");
        _ftfs[token] = Ftf(pass.name, pass.memberXIds, pass.members);
        allTokens.push(token);
        emit FtfLaunched(
            token, msg.sender, pass.name, pass.ticker, pass.memberXIds, pass.members, pass.profileHash, pool
        );
    }

    function _launchOnAscend(
        address[] memory creators,
        string memory name,
        string memory symbol,
        bytes calldata launchData
    ) internal returns (address token, bytes32 pool) {
        if (address(adapter) == address(0)) revert NoAdapter();
        (token, pool) = adapter.launch(creators, name, symbol, launchData);
        if (token.code.length == 0 || token == address(quote) || _launches[token].creator != address(0)) {
            revert BadAdapterToken();
        }
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

    /// Hands the buyer's USDC to the adapter to buy with, then checks what actually reached the buyer and that the adapter
    /// kept none of it (what a buy doesn't use goes back to the buyer).
    function _firstBuy(address token, bytes32 pool, uint256 quoteIn, uint256 minTokensOut) internal {
        uint256 before = IERC20(token).balanceOf(msg.sender);
        uint256 adapterBefore = quote.balanceOf(address(adapter));
        quote.safeTransferFrom(msg.sender, address(adapter), quoteIn);
        adapter.firstBuy(token, pool, msg.sender, quoteIn);
        if (quote.balanceOf(address(adapter)) > adapterBefore) revert AdapterKeptUsdc();
        uint256 tokensOut = IERC20(token).balanceOf(msg.sender) - before;
        if (tokensOut == 0 || tokensOut < minTokensOut) revert Slippage(tokensOut, minTokensOut);
        emit FirstBuy(token, msg.sender, quoteIn, tokensOut);
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

    function _setReserved(string memory ticker, bool reserved) internal {
        reservedTicker[keccak256(bytes(ticker))] = reserved;
        emit TickerReserved(ticker, reserved);
    }
}
