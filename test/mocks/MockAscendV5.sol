// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    AscendLaunchParams,
    AscendRoute,
    AscendSeatConfig,
    ExactInputSingleParams,
    PoolKey
} from "../../src/launch/AscendAdapter.sol";

/// Stand-ins for Ascend V5's EscrowFactory, seat factory, Permit2 and Universal Router (test/AscendAdapter.t.sol). They
/// record what they're called with and check it against Ascend's documented shapes; the real contracts are checked by
/// test/fork/AscendMainnet.t.sol once we have a mainnet RPC.

contract V5Token is ERC20 {
    constructor(string memory n, string memory s, address to) ERC20(n, s) {
        _mint(to, 1_000_000_000e18);
    }
}

abstract contract V5Pools {
    address public immutable launchpad;
    address public immutable usdc;
    bool public wrongPool; // return a pool id that doesn't match the key

    constructor(address launchpad_, address usdc_) {
        launchpad = launchpad_;
        usdc = usdc_;
    }

    function setWrongPool(bool v) external {
        wrongPool = v;
    }

    function _deploy(AscendLaunchParams calldata p, address holder) internal returns (address token, bytes32 poolId) {
        require(p.creator == address(0) && p.quote == usdc && p.devBuyQuote == 0, "params");
        token = address(new V5Token(p.name, p.symbol, holder));
        (address c0, address c1) = token < usdc ? (token, usdc) : (usdc, token);
        poolId = wrongPool ? bytes32(uint256(1)) : keccak256(abi.encode(PoolKey(c0, c1, 0x800000, 200, launchpad)));
    }
}

contract MockEscrowFactoryV5 is V5Pools {
    AscendLaunchParams public lastP;
    AscendRoute public lastR;
    address public router; // the launched supply sits with the router, which "sells" it

    constructor(address launchpad_, address usdc_, address router_) V5Pools(launchpad_, usdc_) {
        router = router_;
    }

    function launch(AscendLaunchParams calldata p, AscendRoute calldata r)
        external
        returns (address token, bytes32 poolId, address escrow)
    {
        (token, poolId) = _deploy(p, router);
        lastP = p;
        lastR = r;
        escrow = address(uint160(uint256(poolId)));
    }
}

contract MockSeatFactoryV5 is V5Pools {
    address public escrowFactory;
    address public router;
    address public lastBuilder;
    address[] internal _payees;
    uint16[] internal _bps;
    AscendLaunchParams public lastP;

    constructor(address escrowFactory_, address launchpad_, address usdc_, address router_) V5Pools(launchpad_, usdc_) {
        escrowFactory = escrowFactory_;
        router = router_;
    }

    function launch(AscendLaunchParams calldata p, AscendSeatConfig calldata c, bytes32, address builder)
        external
        returns (address token, bytes32 poolId, address seat, address escrow)
    {
        require(c.holderBpsQuote == 0 && c.holderBpsToken == 0 && c.buybackBps == 0, "seat: payees only");
        (token, poolId) = _deploy(p, router);
        lastP = p;
        lastBuilder = builder;
        _payees = c.payees;
        _bps = c.bps;
        seat = address(1);
        escrow = address(2);
    }

    function payees() external view returns (address[] memory, uint16[] memory) {
        return (_payees, _bps);
    }
}

contract MockPermit2 {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
    }

    mapping(address owner => mapping(address token => mapping(address spender => Allowance))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(amount, expiration);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage a = allowance[from][token][msg.sender];
        require(block.timestamp <= a.expiration, "permit2: expired");
        require(a.amount >= amount, "permit2: allowance");
        a.amount -= amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}

/// Decodes a V4_SWAP the way Universal Router 2.2.0 does, then pays out tokens at a fixed rate (1 USDC unit -> 1e12 wei).
contract MockUniversalRouter {
    MockPermit2 public immutable permit2;
    address public immutable launchpad;
    ExactInputSingleParams internal _last;
    bytes public lastActions;
    uint256 public settleMax;
    bool public stopHalfway; // fill only half the input (a price limit or the end of the curve)

    function setStopHalfway(bool v) external {
        stopHalfway = v;
    }

    constructor(MockPermit2 permit2_, address launchpad_) {
        permit2 = permit2_;
        launchpad = launchpad_;
    }

    function last() external view returns (ExactInputSingleParams memory) {
        return _last;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "router: deadline");
        require(commands.length == 1 && commands[0] == 0x10 && inputs.length == 1, "router: one V4_SWAP");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(keccak256(actions) == keccak256(hex"060c0f") && params.length == 3, "router: actions");
        ExactInputSingleParams memory s = abi.decode(params[0], (ExactInputSingleParams));
        (address payIn, uint256 maxIn) = abi.decode(params[1], (address, uint256));
        (address takeOut,) = abi.decode(params[2], (address, uint256));
        require(
            s.poolKey.hooks == launchpad && s.poolKey.fee == 0x800000 && s.poolKey.tickSpacing == 200, "router: key"
        );
        address payToken = s.zeroForOne ? s.poolKey.currency0 : s.poolKey.currency1;
        address outToken = s.zeroForOne ? s.poolKey.currency1 : s.poolKey.currency0;
        require(payIn == payToken && takeOut == outToken && maxIn >= s.amountIn, "router: settle/take");
        _last = s;
        lastActions = actions;
        settleMax = maxIn;
        uint160 used = stopHalfway ? s.amountIn / 2 : s.amountIn;
        permit2.transferFrom(msg.sender, address(this), used, payToken);
        IERC20(outToken).transfer(msg.sender, uint256(used) * 1e12);
    }
}
