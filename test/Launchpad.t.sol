// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Launchpad, ICurveFeeVault} from "../src/launch/Launchpad.sol";
import {FeeVault} from "../src/launch/FeeVault.sol";
import {LaunchToken} from "../src/launch/LaunchToken.sol";
import {WHYPE} from "../src/swap/WHYPE.sol";
import {SwapRouter} from "../src/swap/SwapRouter.sol";
import {ISwapFactory, ISwapFactoryAdmin, ISwapPair, IWHYPE} from "../src/swap/interfaces.sol";

/// Our Uniswap V2 fork's pair (0.5.16, src/swap/v2), as seen from 0.8 tests.
interface IPair is ISwapPair, IERC20 {
    function name() external view returns (string memory);
    function factory() external view returns (address);
}

contract LaunchpadTest is Test {
    uint256 constant VH = 60 ether; // graduates at ~170 HYPE raised (~822 HYPE market cap)
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    WHYPE whype;
    ISwapFactoryAdmin factory;
    SwapRouter router;
    Launchpad pad;
    FeeVault vault;

    address owner = makeAddr("owner");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address treasury = makeAddr("treasury");
    uint256 signerPk = 0x5157;
    address signer = vm.addr(0x5157);
    uint64 nextXId = 1_000;

    function setUp() public {
        whype = new WHYPE();
        factory = ISwapFactoryAdmin(deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(owner, address(whype))));
        vault = new FeeVault(owner, IWHYPE(address(whype)), ISwapFactory(address(factory)));
        pad = new Launchpad(
            owner, ISwapFactory(address(factory)), IWHYPE(address(whype)), VH, 75, signer, ICurveFeeVault(address(vault))
        );
        router = new SwapRouter(ISwapFactory(address(factory)), IWHYPE(address(whype)));
        vm.startPrank(owner);
        factory.setLaunchpad(address(pad));
        factory.setFeeVault(address(vault));
        vault.setLaunchpad(address(pad));
        vm.stopPrank();
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(creator, 1_000 ether);
    }

    function _pass(address who, uint64 xId, string memory handle) internal view returns (Launchpad.LaunchPass memory) {
        return Launchpad.LaunchPass({
            creator: who,
            xUserId: xId,
            handle: handle,
            category: uint8(Launchpad.Category.Trader),
            profileHash: keccak256("profile"),
            deadline: block.timestamp + 1 hours
        });
    }

    function _sign(Launchpad.LaunchPass memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, pad.hashLaunchPass(p));
        return abi.encodePacked(r, sg, v);
    }

    function _launchAs(address who, uint64 xId, string memory handle, uint256 value) internal returns (address) {
        Launchpad.LaunchPass memory p = _pass(who, xId, handle);
        bytes memory sig = _sign(p, signerPk);
        vm.prank(who);
        return pad.launch{value: value}(p, sig, 0);
    }

    function _launch() internal returns (address token) {
        // a fresh creator + X account each time (one token per X account and per wallet)
        address who = nextXId == 1_000 ? creator : makeAddr(string.concat("creator", vm.toString(nextXId)));
        vm.deal(who, 1_000 ether);
        token = _launchAs(who, nextXId, string.concat("dog", vm.toString(nextXId)), 0);
        nextXId++;
    }

    function _curve(address token) internal view returns (Launchpad.Curve memory c) {
        (c.creator, c.graduated, c.virtualHype, c.virtualToken, c.realHype, c.realToken) = pad.curves(token);
    }

    function _buy(address who, address token, uint256 value) internal returns (uint256) {
        vm.prank(who);
        return pad.buy{value: value}(token, 0, block.timestamp);
    }

    function _sell(address who, address token, uint256 amount) internal returns (uint256) {
        vm.startPrank(who);
        IERC20(token).approve(address(pad), amount);
        uint256 out = pad.sell(token, amount, 0, block.timestamp);
        vm.stopPrank();
        return out;
    }

    // ------------------------------------------------------------------ launch

    function test_launchIsFreeAndHoldsFullSupply() public {
        address token = _launch();
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(IERC20(token).balanceOf(address(pad)), 1_000_000_000e18);
        assertEq(LaunchToken(token).name(), "@dog1000");
        assertEq(LaunchToken(token).symbol(), "DOG1000");
        Launchpad.Curve memory c = _curve(token);
        assertEq(c.creator, creator);
        assertEq(c.virtualHype, VH);
        assertEq(c.virtualToken, 1_073_000_000e18);
        assertEq(c.realToken, 793_100_000e18);
        assertEq(pad.allTokensLength(), 1);
        assertEq(creator.balance, 1_000 ether); // no fee
    }

    function test_launchWithInitialBuy() public {
        address token = _launchAs(creator, 7, "dog", 1 ether);
        assertGt(IERC20(token).balanceOf(creator), 0);
        assertEq(address(vault).balance, uint256(1 ether) * 75 / 10_075); // fee went to the vault
    }

    function test_revert_badHandles() public {
        string[4] memory bad = ["", "sixteen_chars_xx", "has space", "dash-name"];
        for (uint256 i; i < bad.length; i++) {
            Launchpad.LaunchPass memory p = _pass(alice, 42, bad[i]);
            bytes memory sig = _sign(p, signerPk);
            vm.prank(alice);
            vm.expectRevert(Launchpad.InvalidMetadata.selector);
            pad.launch(p, sig, 0);
        }
    }

    // ------------------------------------------------------------------ who can launch

    function test_nameIsAtHandleAndTickerIsCaps() public {
        address token = _launchAs(alice, 42, "Von_Builds9", 0);
        assertEq(LaunchToken(token).name(), "@Von_Builds9");
        assertEq(LaunchToken(token).symbol(), "VON_BUILDS9");
        Launchpad.Profile memory pr = pad.profile(token);
        assertEq(pr.xUserId, 42);
        assertEq(pr.handle, "Von_Builds9");
        assertEq(uint8(pr.category), uint8(Launchpad.Category.Trader));
        assertEq(pr.profileHash, keccak256("profile"));
        assertEq(pad.tokenOfXUser(42), token);
        assertEq(pad.tokenOfCreator(alice), token);
    }

    function test_allCategories() public {
        for (uint8 c; c < 6; c++) {
            address who = makeAddr(string.concat("cat", vm.toString(c)));
            Launchpad.LaunchPass memory p = _pass(who, 500 + c, string.concat("cat", vm.toString(c)));
            p.category = c;
            bytes memory sig = _sign(p, signerPk);
            vm.prank(who);
            address token = pad.launch(p, sig, 0);
            assertEq(uint8(pad.profile(token).category), c);
        }
        Launchpad.LaunchPass memory bad = _pass(alice, 600, "cat6");
        bad.category = 6;
        bytes memory badSig = _sign(bad, signerPk);
        vm.prank(alice);
        vm.expectRevert(Launchpad.InvalidPass.selector);
        pad.launch(bad, badSig, 0);
    }

    function test_revert_oneTokenPerXAccount() public {
        _launchAs(alice, 42, "alice", 0);
        // same X account, new wallet and even a new handle (renamed on X)
        Launchpad.LaunchPass memory p = _pass(bob, 42, "alice_v2");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(Launchpad.AlreadyLaunched.selector);
        pad.launch(p, sig, 0);
    }

    function test_revert_oneTokenPerWallet() public {
        _launchAs(alice, 42, "alice", 0);
        Launchpad.LaunchPass memory p = _pass(alice, 43, "other");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(Launchpad.AlreadyLaunched.selector);
        pad.launch(p, sig, 0);
    }

    function test_revert_handleTakenCaseInsensitive() public {
        _launchAs(alice, 42, "Alice", 0);
        // someone who later gets the handle on X can't launch it again
        Launchpad.LaunchPass memory p = _pass(bob, 43, "aLICE");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(Launchpad.AlreadyLaunched.selector);
        pad.launch(p, sig, 0);
    }

    function test_revert_passFromWrongSigner() public {
        Launchpad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, 0xBAD);
        vm.prank(alice);
        vm.expectRevert(Launchpad.InvalidPass.selector);
        pad.launch(p, sig, 0);
    }

    function test_revert_passUsedByAnotherWallet() public {
        Launchpad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob); // stolen / front-run pass
        vm.expectRevert(Launchpad.NotPassHolder.selector);
        pad.launch(p, sig, 0);
    }

    function test_revert_tamperedPass() public {
        Launchpad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        p.handle = "elonmusk";
        vm.prank(alice);
        vm.expectRevert(Launchpad.InvalidPass.selector);
        pad.launch(p, sig, 0);
    }

    function test_revert_expiredPass() public {
        Launchpad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        vm.expectRevert(Launchpad.Expired.selector);
        pad.launch(p, sig, 0);
    }

    function test_rotateAndDisableSigner() public {
        Launchpad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(owner);
        pad.setLaunchSigner(address(0)); // launches off
        vm.prank(alice);
        vm.expectRevert(Launchpad.InvalidPass.selector);
        pad.launch(p, sig, 0);

        vm.prank(owner);
        pad.setLaunchSigner(vm.addr(0xC0FFEE));
        bytes memory sig2 = _sign(p, 0xC0FFEE);
        vm.prank(alice);
        pad.launch(p, sig2, 0);
        assertEq(pad.tokenOfXUser(42) != address(0), true);
    }

    // ------------------------------------------------------------------ curve trades

    function test_buyMatchesPreviewAndCharges75Bps() public {
        address token = _launch();
        (uint256 expOut, uint256 hypeIn, uint256 fee, uint256 refund) = pad.previewBuy(token, 1.0075 ether);
        assertEq(hypeIn, 1 ether);
        assertEq(fee, 0.0075 ether);
        assertEq(refund, 0);
        uint256 out = _buy(alice, token, 1.0075 ether);
        assertEq(out, expOut);
        assertEq(IERC20(token).balanceOf(alice), out);
        // x*y=k on virtual reserves: 1.073B - 60*1.073B/61
        assertApproxEqAbs(out, 1_073_000_000e18 - uint256(60 * 1_073_000_000e18) / 61, 1);
        assertEq(address(vault).balance, 0.0075 ether);
    }

    function test_sellRoundTripLosesOnlyFees() public {
        address token = _launch();
        uint256 out = _buy(alice, token, 1.0075 ether);
        uint256 back = _sell(alice, token, out);
        // 1 HYPE in; ~1 HYPE gross back (rounding favors the curve) minus 0.75% sell fee
        assertApproxEqRel(back, 0.9925 ether, 1e12);
        assertLe(back, 0.9925 ether);
        Launchpad.Curve memory c = _curve(token);
        assertEq(c.realToken, 793_100_000e18);
        assertEq(address(pad).balance, c.realHype);
    }

    function test_revert_slippageAndDeadline() public {
        address token = _launch();
        (uint256 expOut,,,) = pad.previewBuy(token, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Launchpad.Slippage.selector, expOut, expOut + 1));
        pad.buy{value: 1 ether}(token, expOut + 1, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(Launchpad.Expired.selector);
        pad.buy{value: 1 ether}(token, 0, block.timestamp - 1);
    }

    function test_revert_unknownToken() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Launchpad.UnknownToken.selector, address(0xBEEF)));
        pad.buy{value: 1 ether}(address(0xBEEF), 0, block.timestamp);
    }

    // ------------------------------------------------------------------ graduation

    function test_graduationBurnsLpAndMatchesCurvePrice() public {
        address token = _launch();
        _buy(alice, token, 10 ether);
        uint256 curvePriceBefore;
        uint256 need = pad.hypeToGraduate(token);
        // ~170 HYPE raised in total (2.8335 x 60), plus 0.75%
        assertApproxEqRel(need + 10 ether, 171.2858 ether, 1e14); // total paid incl. 0.75%

        uint256 bobBefore = bob.balance;
        _buy(bob, token, need + 5 ether); // overpay: excess refunded
        assertEq(bobBefore - bob.balance, need);

        Launchpad.Curve memory c = _curve(token);
        assertTrue(c.graduated);
        assertEq(c.realToken, 0);
        assertEq(IERC20(token).balanceOf(address(pad)), 0);
        assertEq(address(pad).balance, 0); // everything went to the pool; fees are in the vault

        IPair pair = IPair(factory.getPair(token, address(whype)));
        assertTrue(address(pair) != address(0));
        // every LP token is burned (V2 locks the first 1,000 units at address(0), the rest went to DEAD)
        assertEq(pair.balanceOf(DEAD) + pair.balanceOf(address(0)), pair.totalSupply());
        assertEq(pair.balanceOf(address(0)), 1_000);
        assertEq(pair.balanceOf(address(pad)), 0);

        // pool opens at the curve's closing price
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rHype, uint256 rTok) = pair.token0() == address(whype) ? (r0, r1) : (r1, r0);
        assertEq(rTok, 206_900_000e18);
        uint256 poolPrice = rHype * 1e18 / rTok;
        curvePriceBefore = uint256(c.virtualHype) * 1e18 / c.virtualToken;
        assertApproxEqRel(poolPrice, curvePriceBefore, 1e14); // within 0.01%
    }

    function test_revert_curveClosedAfterGraduation() public {
        address token = _launch();
        _buy(alice, token, 200 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Launchpad.AlreadyGraduated.selector, token));
        pad.buy{value: 1 ether}(token, 0, block.timestamp);
    }

    function test_graduationIgnoresTokensDonatedToPairAddress() public {
        address token = _launch();
        uint256 got = _buy(alice, token, 20 ether);
        // attacker predicts the pair address and pre-sends tokens + WHYPE to skew the opening price
        address predicted = _predictPair(token);
        vm.startPrank(alice);
        IERC20(token).transfer(predicted, got / 2);
        whype.deposit{value: 3 ether}();
        whype.transfer(predicted, 3 ether);
        vm.stopPrank();

        _buy(bob, token, 200 ether);
        IPair pair = IPair(factory.getPair(token, address(whype)));
        assertEq(address(pair), predicted);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 rTok = pair.token0() == token ? r0 : r1;
        assertEq(rTok, 206_900_000e18); // donation skimmed to DEAD, not in the pool
        assertEq(IERC20(token).balanceOf(DEAD), got / 2);
    }

    function test_revert_nobodyElseCanCreatePairs() public {
        address token = _launch();
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.createPair(token, address(whype));
    }

    // ------------------------------------------------------------------ after graduation: router

    function test_routerBuySellAfterGraduation() public {
        address token = _launch();
        _buy(alice, token, 200 ether);

        uint256 q = router.quoteBuy(token, 1 ether);
        vm.expectEmit(address(router));
        emit SwapRouter.Swapped(token, bob, bob, true, 1 ether, q);
        vm.prank(bob);
        uint256 out = router.buy{value: 1 ether}(token, q, bob, block.timestamp);
        assertEq(out, q);
        assertEq(IERC20(token).balanceOf(bob), out);

        uint256 qs = router.quoteSell(token, out);
        uint256 before = bob.balance;
        vm.startPrank(bob);
        IERC20(token).approve(address(router), out);
        uint256 back = router.sell(token, out, qs, bob, block.timestamp);
        vm.stopPrank();
        assertEq(back, qs);
        assertEq(bob.balance - before, back);
        assertApproxEqRel(back, 0.995 ether, 1e14); // 0.25% fee each way
    }

    // ------------------------------------------------------------------ fees: 80% creator / 20% protocol

    function test_curveFeesSplit80_20() public {
        address token = _launch(); // creator = `creator`
        _buy(alice, token, 1.0075 ether); // fee 0.0075
        assertEq(vault.creatorBalance(creator), 0.006 ether);
        assertEq(vault.creatorEarned(token), 0.006 ether);
        assertEq(vault.communityBalance(), 0.0009 ether); // 60% of 0.0015
        assertEq(vault.buybackBalance(), 0.0006 ether); // 40% of 0.0015

        uint256 before = creator.balance;
        vm.prank(creator);
        vault.claim(creator);
        assertEq(creator.balance - before, 0.006 ether);
        assertEq(vault.creatorBalance(creator), 0);
        vm.prank(creator);
        vm.expectRevert(FeeVault.NothingToClaim.selector);
        vault.claim(creator);
    }

    function test_protocolShareWaitsForWallets() public {
        address token = _launch();
        _buy(alice, token, 10.075 ether); // fee 0.075 -> protocol 0.015
        vm.expectRevert(FeeVault.WalletsNotSet.selector);
        vault.payProtocol();

        address community = makeAddr("community");
        address buyback = makeAddr("buyback");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setWallets(community, buyback);
        vm.prank(owner);
        vault.setWallets(community, buyback);
        vault.payProtocol(); // anyone
        assertEq(community.balance, 0.009 ether);
        assertEq(buyback.balance, 0.006 ether);
        assertEq(vault.communityBalance() + vault.buybackBalance(), 0);
    }

    function test_poolFeesGoToCreatorInHype() public {
        address token = _launch();
        _buy(alice, token, 200 ether); // graduates
        uint256 creatorBefore = vault.creatorBalance(creator);

        // buy: fee = 0.25% of the HYPE in, and the trader gets exactly the V2 quote
        uint256 q = router.quoteBuy(token, 1 ether);
        vm.prank(bob);
        uint256 out = router.buy{value: 1 ether}(token, q, bob, block.timestamp);
        assertEq(out, q);
        assertEq(vault.creatorBalance(creator) - creatorBefore, 0.002 ether); // 80% of 0.0025
        assertEq(IERC20(address(whype)).balanceOf(address(vault)), 0); // unwrapped to HYPE

        // sell: fee = 0.25% of the tokens in, taken out as their HYPE value
        uint256 mid = vault.creatorBalance(creator);
        uint256 qs = router.quoteSell(token, out);
        vm.startPrank(bob);
        IERC20(token).approve(address(router), out);
        uint256 back = router.sell(token, out, qs, bob, block.timestamp);
        vm.stopPrank();
        assertEq(back, qs);
        assertApproxEqRel(vault.creatorBalance(creator) - mid, back * 25 / 9975 * 8 / 10, 0.01e18);
    }

    // ------------------------------------------------------------------ our Uniswap V2 fork (src/swap/v2)

    /// An aggregator swapping on the pair directly (no router) gets V2's 0.25% output and still pays the fee.
    function test_directPairSwapPaysFeeAndMatchesV2Math() public {
        address token = _launch();
        _buy(alice, token, 200 ether);
        IPair pair = IPair(factory.getPair(token, address(whype)));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool whypeIs0 = pair.token0() == address(whype);
        (uint256 rHype, uint256 rTok) = whypeIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 amountIn = 2 ether;
        uint256 out = router.getAmountOut(amountIn, rHype, rTok);
        uint256 creatorBefore = vault.creatorBalance(creator);

        vm.startPrank(bob);
        whype.deposit{value: amountIn}();
        whype.transfer(address(pair), amountIn);
        // one wei more than the 0.25% quote breaks K
        (uint256 a0, uint256 a1) = whypeIs0 ? (uint256(0), out + 1) : (out + 1, uint256(0));
        vm.expectRevert(bytes("UniswapV2: K"));
        pair.swap(a0, a1, bob, "");
        (a0, a1) = whypeIs0 ? (uint256(0), out) : (out, uint256(0));
        pair.swap(a0, a1, bob, "");
        vm.stopPrank();

        assertEq(IERC20(token).balanceOf(bob), out);
        assertEq(vault.creatorBalance(creator) - creatorBefore, amountIn * 25 / 10_000 * 8 / 10);
        (r0, r1,) = pair.getReserves();
        assertEq(whypeIs0 ? r0 : r1, rHype + amountIn - amountIn * 25 / 10_000); // the fee left the pool
    }

    function test_v2ForkAdmin() public {
        IPair pair;
        {
            address token = _launch();
            _buy(alice, token, 200 ether);
            pair = IPair(factory.getPair(token, address(whype)));
        }
        assertEq(pair.name(), "Neuriio LP");
        assertEq(pair.factory(), address(factory));
        assertEq(factory.feeToSetter(), owner);
        assertEq(factory.launchpad(), address(pad));
        assertEq(factory.feeVault(), address(vault));
        assertEq(factory.whype(), address(whype));
        // set-once, owner only
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeVault(alice);
        vm.startPrank(owner);
        vm.expectRevert(bytes("UniswapV2: ALREADY_SET"));
        factory.setFeeVault(alice);
        vm.expectRevert(bytes("UniswapV2: ALREADY_SET"));
        factory.setLaunchpad(alice);
        vm.stopPrank();
    }

    function test_revert_onlyPairsAndLaunchpadFeedTheVault() public {
        address token = _launch();
        vm.expectRevert(FeeVault.NotPair.selector);
        vault.notifyPoolFee(token);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(FeeVault.NotLaunchpad.selector);
        vault.depositCurveFee{value: 1 ether}(token);
    }

    function testFuzz_poolFeeNeverShrinksK(uint256 seed) public {
        address token = _launch();
        _buy(alice, token, 200 ether);
        IPair pair = IPair(factory.getPair(token, address(whype)));
        vm.startPrank(bob);
        IERC20(token).approve(address(router), type(uint256).max);
        for (uint256 i; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            (uint112 r0, uint112 r1,) = pair.getReserves();
            uint256 kBefore = uint256(r0) * r1;
            if (seed % 2 == 0) {
                router.buy{value: bound(seed >> 8, 1e12, 50 ether)}(token, 0, bob, block.timestamp);
            } else {
                uint256 bal = IERC20(token).balanceOf(bob);
                if (bal == 0) continue;
                router.sell(token, bound(seed >> 8, 1, bal), 0, bob, block.timestamp);
            }
            (r0, r1,) = pair.getReserves();
            assertGe(uint256(r0) * r1, kBefore);
            assertEq(IERC20(address(whype)).balanceOf(address(pair)), pair.token0() == address(whype) ? r0 : r1);
        }
        vm.stopPrank();
    }

    /// Pause stops launches and buys, but holders can still sell (always able to exit).
    function test_pauseStopsBuysAndLaunchesButNotSells() public {
        address token = _launch();
        uint256 got = _buy(alice, token, 1 ether);
        vm.prank(owner);
        pad.pause();

        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pad.buy{value: 1 ether}(token, 0, block.timestamp);

        Launchpad.LaunchPass memory p = _pass(bob, 9_999, "pausedlaunch");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pad.launch(p, sig, 0);

        uint256 before = alice.balance;
        uint256 out = _sell(alice, token, got);
        assertGt(out, 0);
        assertEq(alice.balance - before, out);
        assertEq(IERC20(token).balanceOf(alice), 0);
    }

    function test_revert_feeCap() public {
        vm.prank(owner);
        vm.expectRevert(Launchpad.InvalidParams.selector);
        pad.setFee(201);
    }

    // ------------------------------------------------------------------ fuzz: the curve is always solvent

    function testFuzz_randomTradesStaySolvent(uint256 seed) public {
        address token = _launch();
        address[2] memory who = [alice, bob];
        for (uint256 i; i < 25; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address w = who[seed % 2];
            if (_curve(token).graduated) break;
            if ((seed >> 8) % 3 != 0) {
                _buy(w, token, bound(seed >> 16, 1e9, 30 ether));
            } else {
                uint256 bal = IERC20(token).balanceOf(w);
                if (bal > 0) _sell(w, token, bound(seed >> 16, 1, bal));
            }
            Launchpad.Curve memory c = _curve(token);
            if (!c.graduated) {
                // HYPE held covers what was raised + fees, and tokens held cover what's left to sell + LP
                assertGe(address(pad).balance, c.realHype);
                assertGe(IERC20(token).balanceOf(address(pad)), uint256(c.realToken) + pad.LP_SUPPLY());
                // everything bought can always be sold back: raised HYPE >= value of circulating tokens at the curve
                uint256 circulating = 793_100_000e18 - c.realToken;
                uint256 payout = c.virtualHype - uint256(c.virtualHype) * c.virtualToken / (c.virtualToken + circulating);
                assertGe(uint256(c.realHype) + 1, payout);
            }
        }
    }

    function _predictPair(address token) internal view returns (address) {
        (address t0, address t1) = token < address(whype) ? (token, address(whype)) : (address(whype), token);
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff", address(factory), keccak256(abi.encodePacked(t0, t1)), keccak256(vm.getCode("UniswapV2Pair.sol:UniswapV2Pair"))
                        )
                    )
                )
            )
        );
    }
}
