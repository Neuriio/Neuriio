// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AscendAdapterBase} from "./AscendAdapterBase.sol";

/// Ascend's launch parameters and payout route (EscrowFactory, Ascend V5 on Elysium mainnet, chain 99901).
struct AscendLaunchParams {
    string name;
    string symbol;
    address quote;
    uint256 devBuyQuote;
    uint256 minDevOut;
    bytes32 salt;
    address creator; // always zero: the factory makes the pool's CreatorEscrow its creator
    uint24 fee; // the creator's fee, in pips (10,000 = 1%)
    uint24 builderFee; // an approved builder's fee on top, in pips
}

struct AscendRoute {
    address recipient; // who the escrow pays the creator allocation to
    address dev; // who receives the dev buy
    address builder;
    bool cto; // whether the pool accepts community takeovers
}

/// The seat factory's payout split (a "Custom mix" coin: here only payees, no holder rewards or buybacks).
struct AscendSeatConfig {
    uint16 holderBpsQuote;
    uint16 holderBpsToken;
    uint16 buybackBps;
    bool burnBought;
    address devBuyTo;
    address[] payees;
    uint16[] bps;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

/// Universal Router 2.2.0's SWAP_EXACT_IN_SINGLE parameters (one more field than older v4 routers: minHopPriceX36).
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

interface IAscendEscrowFactory {
    function launch(AscendLaunchParams calldata p, AscendRoute calldata r)
        external
        returns (address token, bytes32 poolId, address escrow);
    function launchpad() external view returns (address);
}

interface IAscendSeatFactory {
    function launch(AscendLaunchParams calldata p, AscendSeatConfig calldata c, bytes32 seatSalt, address builder)
        external
        returns (address token, bytes32 poolId, address seat, address escrow);
    function escrowFactory() external view returns (address);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice The adapter for Ascend (user, 2026-11-04, from Ascend's developer docs and ABI file ascend-v5-99901-422319.json):
/// our audited AscendAdapterBase plus the two calls into Ascend.
///  - Launch: through Ascend's EscrowFactory, at Ascend's base fee (1%) plus our builder fee (0.5%), with our builder
///    address on the route. The creator's share of Ascend's fee goes to the creator (user, 2026-11-04). An FTF launches
///    through Ascend's seat factory instead, which splits that share equally between its 4 members. No community takeovers:
///    a token belongs to its X account. USDC pairs only (the launcher's quote).
///  - First buy: an exact-input swap of the USDC the launcher sent, through Ascend's Universal Router, with a one-shot
///    Permit2 allowance for exactly that amount. It pays the normal fee (Ascend's own dev buy is free, but the launcher sends
///    the USDC only after the launch). The launcher checks the buyer's minimum.
/// Everything Ascend-specific is fixed at deploy; the owner can only replace the whole adapter through the launcher.
contract AscendAdapter is AscendAdapterBase {
    using SafeERC20 for IERC20;

    uint24 public constant FEE = 10_000; // Ascend's base fee, 1%
    uint24 public constant BUILDER_FEE = 5_000; // ours, 0.5%
    uint24 public constant DYNAMIC_FEE_FLAG = 0x800000; // every Ascend pool's key
    int24 public constant TICK_SPACING = 200;
    uint256 public constant FTF_MEMBERS = 4;
    uint16 public constant FTF_SHARE_BPS = 2_500;

    bytes1 internal constant V4_SWAP = 0x10;
    uint8 internal constant SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant SETTLE_ALL = 0x0c;
    uint8 internal constant TAKE_ALL = 0x0f;

    IAscendEscrowFactory public immutable escrowFactory;
    IAscendSeatFactory public immutable seatFactory;
    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    address public immutable hook; // Ascend's launchpad, the hook on every pool
    address public immutable builder; // where our 0.5% goes (Ascend approved it as a builder)

    error BadSetup();
    error BadCreators();
    error WrongPool();
    error TooMuch();

    constructor(
        address launcher_,
        IAscendEscrowFactory escrowFactory_,
        IAscendSeatFactory seatFactory_,
        IUniversalRouter router_,
        IPermit2 permit2_,
        address builder_
    ) AscendAdapterBase(launcher_) {
        if (seatFactory_.escrowFactory() != address(escrowFactory_) || builder_ == address(0)) {
            revert BadSetup();
        }
        escrowFactory = escrowFactory_;
        seatFactory = seatFactory_;
        router = router_;
        permit2 = permit2_;
        hook = escrowFactory_.launchpad();
        builder = builder_;
    }

    /// The pool key Ascend gives `token`'s USDC pool; its id is keccak256(abi.encode(key)).
    function poolKeyOf(address token) public view returns (PoolKey memory key) {
        (address c0, address c1) = token < address(quote) ? (token, address(quote)) : (address(quote), token);
        key = PoolKey(c0, c1, DYNAMIC_FEE_FLAG, TICK_SPACING, hook);
    }

    function _launchOnAscend(address[] calldata creators, string calldata name, string calldata symbol, bytes calldata)
        internal
        override
        returns (address token, bytes32 pool)
    {
        // a handle or an FTF ticker launches once (the launcher's rule), so this salt is never reused by us; Ascend's
        // token addresses also depend on the payer (this contract), so nobody else can take it
        AscendLaunchParams memory p = AscendLaunchParams(
            name,
            symbol,
            address(quote),
            0,
            0,
            keccak256(abi.encode(creators, name, symbol)),
            address(0),
            FEE,
            BUILDER_FEE
        );
        if (creators.length == 1) (token, pool) = _launchPersonal(p, creators[0]);
        else if (creators.length == FTF_MEMBERS) (token, pool) = _launchFtf(p, creators);
        else revert BadCreators();
        if (keccak256(abi.encode(poolKeyOf(token))) != pool) revert WrongPool();
    }

    /// One creator: Ascend's EscrowFactory, paying the creator's share to the creator.
    function _launchPersonal(AscendLaunchParams memory p, address creator)
        internal
        returns (address token, bytes32 pool)
    {
        if (creator == address(0)) revert BadCreators();
        (token, pool,) = escrowFactory.launch(p, AscendRoute(creator, address(this), builder, false));
    }

    /// An FTF: Ascend's seat factory, splitting the creator's share equally between the 4 members.
    function _launchFtf(AscendLaunchParams memory p, address[] calldata creators)
        internal
        returns (address token, bytes32 pool)
    {
        address[] memory payees = new address[](FTF_MEMBERS);
        uint16[] memory bps = new uint16[](FTF_MEMBERS);
        for (uint256 i; i < FTF_MEMBERS; ++i) {
            if (creators[i] == address(0)) revert BadCreators();
            payees[i] = creators[i];
            bps[i] = FTF_SHARE_BPS;
        }
        AscendSeatConfig memory c = AscendSeatConfig(0, 0, 0, false, address(this), payees, bps);
        (token, pool,,) = seatFactory.launch(p, c, keccak256(abi.encode(p.salt)), builder);
    }

    function _buyOnAscend(address token, bytes32 pool, uint256 quoteIn) internal override {
        if (quoteIn > type(uint128).max) revert TooMuch();
        PoolKey memory key = poolKeyOf(token);
        if (keccak256(abi.encode(key)) != pool) revert WrongPool();

        // Permit2 for exactly this swap, spent in this call (never approve the router directly)
        quote.forceApprove(address(permit2), quoteIn);
        // forge-lint: disable-next-line(unsafe-typecast)
        permit2.approve(address(quote), address(router), uint160(quoteIn), uint48(block.timestamp));

        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            // forge-lint: disable-next-line(unsafe-typecast)
            ExactInputSingleParams(key, key.currency0 == address(quote), uint128(quoteIn), 0, 0, "")
        );
        params[1] = abi.encode(address(quote), quoteIn); // SETTLE_ALL: pay at most quoteIn
        params[2] = abi.encode(token, uint256(0)); // TAKE_ALL: to this contract (the launcher checks the minimum)
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL), params);
        router.execute(abi.encodePacked(V4_SWAP), inputs, block.timestamp);
        // a swap that stops short (a price limit, the end of the curve) leaves part of both allowances unspent: close them
        // (security pass 2026-11-04; the unspent USDC itself goes back to the buyer in AscendAdapterBase.firstBuy)
        quote.forceApprove(address(permit2), 0);
        permit2.approve(address(quote), address(router), 0, 0);
    }
}
