// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice The permanent core of launching: deployed once, never replaced. NeuriioPad versions come and go (new curve
/// logic, bug fixes), but every token any version ever launched is recorded here, so:
///   - identity is global: one personal token per X account, per wallet and per handle, and one FTF per ticker,
///     across every NeuriioPad version (a new version can't let someone launch twice)
///   - tickers that look like real assets ($USDC, $HYPE, ...) are reserved in one place
///   - every token knows its NeuriioPad (`launchpadOf`, used by the swap factory and the NeuriioFees to accept only the
///     token's own NeuriioPad) and its creators (`creatorsOf`, used by the NeuriioFees to pay them)
/// The owner approves NeuriioPad versions (`setLaunchpad`). Revoking one only stops NEW launches on it: its tokens keep
/// trading on its curve, graduate, and earn fees, because those checks use `launchpadOf`, not approval.
contract NeuriioRegistry is Ownable2Step {
    uint256 public constant FTF_MEMBERS = 4;

    mapping(address launchpad => bool) public isLaunchpad; // approved to register NEW tokens
    address[] public launchpads; // every version ever approved, oldest first (indexers follow all of them)

    mapping(address token => address) public launchpadOf;
    mapping(address token => bool) public isFtf;
    mapping(address token => address[]) internal _creators;
    address[] public allTokens;

    mapping(uint64 xUserId => address token) public tokenOfXUser;
    mapping(address creator => address token) public tokenOfCreator;
    mapping(bytes32 handleKey => address token) public tokenOfHandle; // keccak256(lower-case handle)
    mapping(bytes32 tickerKey => address token) public tokenOfFtfTicker; // keccak256(ticker); FTFs' own namespace
    /// Tickers nobody can launch (personal: the handle in caps; FTF: its ticker). keccak256 of the upper-case ticker.
    mapping(bytes32 tickerKey => bool) public reservedTicker;

    event LaunchpadSet(address indexed launchpad, bool approved);
    event TokenRegistered(address indexed token, address indexed launchpad, address indexed creator, bool ftf);
    event TickerReserved(string ticker, bool reserved);

    error NotLaunchpad();
    error AlreadyRegistered();
    error AlreadyLaunched();
    error TickerTaken();
    error TickerIsReserved();
    error InvalidParams();

    constructor(address owner_) Ownable(owner_) {
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

    modifier onlyLaunchpad() {
        if (!isLaunchpad[msg.sender]) revert NotLaunchpad();
        _;
    }

    // ------------------------------------------------------------------ registering (approved Launchpads only)

    /// @notice A personal token. `symbol` is the handle in caps (the ticker); `handleKey` is keccak256 of the
    /// lower-case handle. The NeuriioPad has already checked the handle's characters.
    function registerPersonal(address token, address creator, uint64 xUserId, string calldata symbol, bytes32 handleKey)
        external
        onlyLaunchpad
    {
        if (reservedTicker[keccak256(bytes(symbol))]) revert TickerIsReserved();
        if (
            tokenOfXUser[xUserId] != address(0) || tokenOfCreator[creator] != address(0)
                || tokenOfHandle[handleKey] != address(0)
        ) {
            revert AlreadyLaunched();
        }
        tokenOfXUser[xUserId] = token;
        tokenOfCreator[creator] = token;
        tokenOfHandle[handleKey] = token;
        _record(token, creator, false);
        _creators[token].push(creator);
    }

    /// @notice An FTF: 4 members (founder first) share its creator fees. `ticker` is already upper case A-Z 0-9.
    /// Being in an FTF doesn't use up anyone's personal launch.
    function registerFtf(address token, string calldata ticker, address[FTF_MEMBERS] calldata members)
        external
        onlyLaunchpad
    {
        bytes32 key = keccak256(bytes(ticker));
        if (reservedTicker[key]) revert TickerIsReserved();
        if (tokenOfFtfTicker[key] != address(0)) revert TickerTaken();
        tokenOfFtfTicker[key] = token;
        _record(token, members[0], true);
        address[] storage c = _creators[token];
        for (uint256 i; i < FTF_MEMBERS; ++i) {
            c.push(members[i]);
        }
    }

    // ------------------------------------------------------------------ views

    /// @notice Who shares `token`'s creator fees: its creator, or an FTF's 4 members (founder first). Empty if unknown.
    function creatorsOf(address token) external view returns (address[] memory) {
        return _creators[token];
    }

    function launchpadsLength() external view returns (uint256) {
        return launchpads.length;
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    // ------------------------------------------------------------------ owner

    /// @notice Approve a NeuriioPad version for new launches, or revoke one (its existing tokens are unaffected).
    function setLaunchpad(address launchpad, bool approved) external onlyOwner {
        if (launchpad == address(0)) revert InvalidParams();
        if (approved && !_known(launchpad)) launchpads.push(launchpad);
        isLaunchpad[launchpad] = approved;
        emit LaunchpadSet(launchpad, approved);
    }

    /// @notice Reserve (or free) tickers, given in upper case. Tokens already launched are not affected.
    function setReservedTickers(string[] calldata tickers, bool reserved) external onlyOwner {
        for (uint256 i; i < tickers.length; ++i) {
            _setReserved(tickers[i], reserved);
        }
    }

    // ------------------------------------------------------------------ internals

    function _record(address token, address creator, bool ftf) internal {
        if (token == address(0)) revert InvalidParams();
        if (launchpadOf[token] != address(0)) revert AlreadyRegistered();
        launchpadOf[token] = msg.sender;
        isFtf[token] = ftf;
        allTokens.push(token);
        emit TokenRegistered(token, msg.sender, creator, ftf);
    }

    function _known(address launchpad) internal view returns (bool) {
        for (uint256 i; i < launchpads.length; ++i) {
            if (launchpads[i] == launchpad) return true;
        }
        return false;
    }

    function _setReserved(string memory ticker, bool reserved) internal {
        reservedTicker[keccak256(bytes(ticker))] = reserved;
        emit TickerReserved(ticker, reserved);
    }
}
