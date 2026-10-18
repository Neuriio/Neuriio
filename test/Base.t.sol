// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioRouter} from "../src/swap/NeuriioRouter.sol";
import {NeuriioStaking} from "../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {NeuriioPlatformToken} from "../src/stake/NeuriioPlatformToken.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {ISwapFactory, ISwapFactoryAdmin, ISwapPair} from "../src/swap/interfaces.sol";

/// Our Uniswap V2 fork's pair (0.5.16, src/swap/v2), as seen from 0.8 tests.
interface IPair is ISwapPair, IERC20 {
    function name() external view returns (string memory);
    function factory() external view returns (address);
}

/// The whole USDC stack on a fresh chain, and the helpers every test file shares.
abstract contract NeuriioBase is Test {
    uint256 constant VQ = 5_000e6; // virtual USDC: graduates at ~14,168 USDC raised (~$68.5k market cap)
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    // the $NEURIIO mint: 100 per $1 X-token stakers earn, flat for $1M of platform fees, then S = $120M (PAPER's)
    uint256 constant MINT_RATE = 100e18;
    uint256 constant FLAT_UNTIL = 1_000_000e18;
    uint256 constant DECAY_SCALE = 120_000_000e18;

    TestUSDC usdc;
    ISwapFactoryAdmin factory;
    NeuriioRouter trade;
    NeuriioPad pad;
    NeuriioFees vault;
    NeuriioRegistry registry;
    NeuriioStaking staking;
    NeuriioPlatformToken neuriio;
    NeuriioMinter minter;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");
    uint256 signerPk = 0x5157;
    address signer = vm.addr(0x5157);
    uint64 nextXId = 1_000;
    address[4] ftfWallets;

    function setUp() public virtual {
        usdc = new TestUSDC(owner);
        vm.prank(owner);
        usdc.setMinter(address(this), true);
        registry = new NeuriioRegistry(owner);
        factory =
            ISwapFactoryAdmin(deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(owner, address(usdc))));
        staking = new NeuriioStaking(ISwapFactory(address(factory)), IERC20(address(usdc)), owner);
        neuriio = staking.neuriio();
        minter = new NeuriioMinter(owner, staking, MINT_RATE, FLAT_UNTIL, DECAY_SCALE);
        vm.prank(owner);
        neuriio.setMinter(address(minter));
        vault = _newVault();
        pad = _newLaunchpad();
        trade = new NeuriioRouter(registry, ISwapFactory(address(factory)));
        vm.startPrank(owner);
        factory.setRegistry(address(registry));
        factory.setFeeVault(address(vault));
        registry.setLaunchpad(address(pad), true);
        vm.stopPrank();
        _fund(alice, 1_000_000e6);
        _fund(bob, 1_000_000e6);
        _fund(creator, 1_000_000e6);
    }

    /// A NeuriioFees approved to report fees to the minter.
    function _newVault() internal returns (NeuriioFees v) {
        v = new NeuriioFees(owner, IERC20(address(usdc)), ISwapFactory(address(factory)), registry, staking, minter);
        vm.prank(owner);
        minter.setVault(address(v), true);
    }

    function _newLaunchpad() internal returns (NeuriioPad) {
        return new NeuriioPad(
            owner,
            ISwapFactory(address(factory)),
            IERC20(address(usdc)),
            VQ,
            100,
            signer,
            ICurveFeeVault(address(vault)),
            registry
        );
    }

    /// Test USDC for `who`, with the router pre-approved (the app approves it once).
    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(trade), type(uint256).max);
    }

    // ------------------------------------------------------------------ launching

    function _pass(address who, uint64 xId, string memory handle) internal view returns (NeuriioPad.LaunchPass memory) {
        return NeuriioPad.LaunchPass({
            creator: who,
            xUserId: xId,
            handle: handle,
            category: uint8(NeuriioPad.Category.Trader),
            profileHash: keccak256("profile"),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(NeuriioPad.LaunchPass memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, pad.hashLaunchPass(p));
        return abi.encodePacked(r, sg, v);
    }

    function _launchAs(address who, uint64 xId, string memory handle, uint256 quoteIn) internal returns (address) {
        NeuriioPad.LaunchPass memory p = _pass(who, xId, handle);
        bytes memory sig = _sign(p, signerPk);
        vm.startPrank(who);
        usdc.approve(address(pad), type(uint256).max);
        address token = pad.launch(p, sig, quoteIn, 0);
        vm.stopPrank();
        return token;
    }

    function _launch() internal returns (address token) {
        // a fresh creator + X account each time (one token per X account and per wallet)
        address who = nextXId == 1_000 ? creator : makeAddr(string.concat("creator", vm.toString(nextXId)));
        if (who != creator) _fund(who, 1_000_000e6);
        token = _launchAs(who, nextXId, string.concat("dog", vm.toString(nextXId)), 0);
        nextXId++;
    }

    function _ftfPass(string memory name, string memory ticker) internal returns (NeuriioPad.FtfPass memory p) {
        uint64[4] memory ids = [uint64(7_001), 7_002, 7_003, 7_004];
        for (uint256 i; i < 4; i++) {
            ftfWallets[i] = makeAddr(string.concat("member", vm.toString(i)));
            if (usdc.balanceOf(ftfWallets[i]) == 0) _fund(ftfWallets[i], 100_000e6);
        }
        p = NeuriioPad.FtfPass({
            founder: ftfWallets[0],
            name: name,
            ticker: ticker,
            memberXIds: ids,
            members: ftfWallets,
            profileHash: keccak256("ftf profile"),
            deadline: block.timestamp + 1 hours
        });
    }

    function _signFtf(NeuriioPad.FtfPass memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, pad.hashFtfPass(p));
        return abi.encodePacked(r, sg, v);
    }

    function _launchFtf(NeuriioPad.FtfPass memory p, uint256 quoteIn) internal returns (address token) {
        bytes memory sig = _signFtf(p, signerPk);
        vm.startPrank(p.founder);
        usdc.approve(address(pad), type(uint256).max);
        token = pad.launchFtf(p, sig, quoteIn, 0);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ trading

    function _curve(address token) internal view returns (NeuriioPad.Curve memory c) {
        (c.creator, c.graduated, c.virtualQuote, c.virtualToken, c.realQuote, c.realToken) = pad.curves(token);
    }

    /// Buys straight from the current `pad` (approving it as needed).
    function _buy(address who, address token, uint256 quoteIn) internal returns (uint256 out) {
        vm.startPrank(who);
        usdc.approve(address(pad), type(uint256).max);
        out = pad.buy(token, quoteIn, 0, block.timestamp);
        vm.stopPrank();
    }

    function _sell(address who, address token, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20(token).approve(address(pad), amount);
        out = pad.sell(token, amount, 0, block.timestamp);
        vm.stopPrank();
    }

    /// Launches a token and sells out its curve (so it has a pool); `who` holds the graduating buy.
    function _graduated(address who) internal returns (address token) {
        token = _launch();
        _buy(who, token, 20_000e6); // takes only what's needed (~14.3k)
        assertTrue(_curve(token).graduated);
    }

    /// Buys / sells through the NeuriioRouter (curve or pool).
    function _tradeBuy(address who, address token, uint256 quoteIn) internal returns (uint256 out) {
        vm.prank(who);
        out = trade.buy(token, quoteIn, 0, block.timestamp);
    }

    function _tradeSell(address who, address token, uint256 amount) internal returns (uint256 out) {
        vm.startPrank(who);
        IERC20(token).approve(address(trade), amount);
        out = trade.sell(token, amount, 0, block.timestamp);
        vm.stopPrank();
    }

    function _stake(address who, address token, uint256 amount) internal {
        vm.startPrank(who);
        if (token != address(neuriio)) IERC20(token).approve(address(staking), amount);
        staking.stake(token, amount);
        vm.stopPrank();
    }

    function _pairOf(address token) internal view returns (IPair) {
        return IPair(factory.getPair(token, address(usdc)));
    }

    function _predictPair(address token) internal view returns (address) {
        (address t0, address t1) = token < address(usdc) ? (token, address(usdc)) : (address(usdc), token);
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            address(factory),
                            keccak256(abi.encodePacked(t0, t1)),
                            keccak256(vm.getCode("UniswapV2Pair.sol:UniswapV2Pair"))
                        )
                    )
                )
            )
        );
    }
}
