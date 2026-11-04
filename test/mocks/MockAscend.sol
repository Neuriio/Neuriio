// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AscendAdapterBase} from "../../src/launch/AscendAdapterBase.sol";
import {MockAscendFees, MockCreatorEscrow} from "./MockAscendFees.sol";

/// Test USDC for the deploy rehearsal (script/rehearse-ascend.sh): 6 decimals, anyone can mint.
contract RehearsalUSDC is ERC20("Rehearsal USDC", "USDC") {
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A launched token on the stand-in Ascend: 1B, all minted to Ascend's pool at launch.
contract MockAscendToken is ERC20 {
    constructor(string memory name_, string memory symbol_, address pool) ERC20(name_, symbol_) {
        _mint(pool, 1_000_000_000e18);
    }
}

/// Stands in for Ascend until its contracts arrive (user, 2026-11-04): launches a token into a USDC pool and trades it, the
/// way Ascend does (docs, 2026-11-04). A pool is constant product over a virtual USDC reserve plus what buyers paid in. Every
/// trade pays 1.5% of its USDC side: 1% to Ascend, and our 0.5% builder fee waits here for the pool (`accruedFees`) until the
/// pool's escrow (`escrowOf`) settles it and `claimBuilder()` pays our builder address with BuilderPaid. So this plays
/// Ascend's launchpad and EscrowFactory for the fee router. NOT Ascend's real pool maths or contracts: the real adapter and
/// fee router are checked against those by test/fork/AscendMainnet.t.sol.
contract MockAscend {
    using SafeERC20 for IERC20;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint256 public constant VIRTUAL_USDC = 5_000e6;
    uint256 public constant ASCEND_FEE_BPS = 100;
    uint256 public constant OUR_FEE_BPS = 50;

    struct Pool {
        address token;
        address feeWallet;
        uint256 usdc; // real USDC in the pool
        uint256 tokens; // tokens in the pool
    }

    IERC20 public immutable usdc;
    address public immutable ascendWallet;
    mapping(bytes32 id => Pool) public pools;
    mapping(bytes32 id => address) public escrowOf;
    mapping(bytes32 id => uint256) public accruedFees; // our builder fee, waiting for the escrow

    event Launched(address indexed token, bytes32 indexed id, address feeWallet);
    event Swap(
        bytes32 indexed id,
        address indexed sender,
        int128 amount0,
        int128 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick,
        uint24 fee
    );

    constructor(IERC20 usdc_, address ascendWallet_) {
        usdc = usdc_;
        ascendWallet = ascendWallet_;
    }

    function launch(string calldata name, string calldata symbol, address feeWallet)
        external
        returns (address token, bytes32 id)
    {
        token = address(new MockAscendToken(name, symbol, address(this)));
        id = keccak256(abi.encode(token));
        pools[id] = Pool(token, feeWallet, 0, SUPPLY);
        escrowOf[id] = address(new MockCreatorEscrow(usdc, MockAscendFees(address(this)), id, feeWallet));
        emit Launched(token, id, feeWallet);
    }

    /// USDC in, tokens out to `to`. The fee comes off the USDC paid.
    function buy(bytes32 id, uint256 usdcIn, uint256 minOut, address to) external returns (uint256 out) {
        Pool storage p = pools[id];
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        uint256 net = usdcIn - _payFees(p, usdcIn);
        uint256 x = VIRTUAL_USDC + p.usdc;
        out = p.tokens - (x * p.tokens) / (x + net);
        require(out >= minOut, "slippage");
        p.usdc += net;
        p.tokens -= out;
        IERC20(p.token).safeTransfer(to, out);
        emit Swap(
            id,
            msg.sender,
            -int128(int256(usdcIn)),
            int128(int256(out)),
            0,
            0,
            0,
            uint24(ASCEND_FEE_BPS + OUR_FEE_BPS) * 100
        );
    }

    /// Tokens in, USDC out to `to`. The fee comes off the USDC paid out.
    function sell(bytes32 id, uint256 tokensIn, uint256 minOut, address to) external returns (uint256 out) {
        Pool storage p = pools[id];
        IERC20(p.token).safeTransferFrom(msg.sender, address(this), tokensIn);
        uint256 x = VIRTUAL_USDC + p.usdc;
        uint256 gross = x - (x * p.tokens) / (p.tokens + tokensIn);
        if (gross > p.usdc) gross = p.usdc;
        p.usdc -= gross;
        p.tokens += tokensIn;
        out = gross - _payFees(p, gross);
        require(out >= minOut, "slippage");
        usdc.safeTransfer(to, out);
        emit Swap(
            id,
            msg.sender,
            int128(int256(out)),
            -int128(int256(tokensIn)),
            0,
            0,
            0,
            uint24(ASCEND_FEE_BPS + OUR_FEE_BPS) * 100
        );
    }

    function _payFees(Pool storage p, uint256 amount) internal returns (uint256 total) {
        uint256 ascendCut = (amount * ASCEND_FEE_BPS) / 10_000;
        uint256 ours = (amount * OUR_FEE_BPS) / 10_000;
        usdc.safeTransfer(ascendWallet, ascendCut);
        accruedFees[keccak256(abi.encode(p.token))] += ours;
        return ascendCut + ours;
    }

    /// The escrow's settle() pulls what its pool collected for the builder (MockCreatorEscrow).
    function pull(bytes32 id) external returns (uint256 amount) {
        require(msg.sender == escrowOf[id], "not the escrow");
        amount = accruedFees[id];
        accruedFees[id] = 0;
        usdc.safeTransfer(msg.sender, amount);
    }
}

/// The adapter for the stand-in Ascend: our audited AscendAdapterBase plus the two calls into MockAscend. The real adapter
/// will have the same shape against Ascend's real contracts.
contract MockAscendAdapter is AscendAdapterBase {
    using SafeERC20 for IERC20;

    MockAscend public immutable ascend;
    address public immutable feeWallet;

    constructor(address launcher_, MockAscend ascend_, address feeWallet_) AscendAdapterBase(launcher_) {
        ascend = ascend_;
        feeWallet = feeWallet_;
    }

    function _launchOnAscend(address[] calldata, string calldata name, string calldata symbol, bytes calldata)
        internal
        override
        returns (address token, bytes32 pool)
    {
        return ascend.launch(name, symbol, feeWallet);
    }

    function _buyOnAscend(address, bytes32 pool, uint256 quoteIn) internal override {
        quote.forceApprove(address(ascend), quoteIn);
        ascend.buy(pool, quoteIn, 0, address(this));
    }
}
