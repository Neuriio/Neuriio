// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioToken} from "../src/launch/NeuriioToken.sol";
import {NeuriioRouter} from "../src/swap/NeuriioRouter.sol";
import {NeuriioBase, IPair} from "./Base.t.sol";

/// The launchpad (priced in USDC), its curve, graduation, our V2 fork (TOKEN/USDC, 1% fee) and the fee vault's creator /
/// treasury shares. The setup and the shared helpers live in Base.t.sol.
contract NeuriioPadTest is NeuriioBase {
    // ------------------------------------------------------------------ launch

    function test_launchIsFreeAndHoldsFullSupply() public {
        address token = _launch();
        assertEq(IERC20(token).totalSupply(), 1_000_000_000e18);
        assertEq(IERC20(token).balanceOf(address(pad)), 1_000_000_000e18);
        assertEq(NeuriioToken(token).name(), "@dog1000");
        assertEq(NeuriioToken(token).symbol(), "DOG1000");
        NeuriioPad.Curve memory c = _curve(token);
        assertEq(c.creator, creator);
        assertEq(c.virtualQuote, VQ);
        assertEq(c.virtualToken, 1_073_000_000e18);
        assertEq(c.realToken, 793_100_000e18);
        assertEq(pad.allTokensLength(), 1);
        assertEq(usdc.balanceOf(creator), 1_000_000e6); // no fee
    }

    function test_launchWithInitialBuy() public {
        address token = _launchAs(creator, 7, "dog", 1_010e6);
        assertGt(IERC20(token).balanceOf(creator), 0);
        assertEq(usdc.balanceOf(address(vault)), 10e6); // the 1% fee went to the vault
        assertEq(vault.totalFees(), 10e6);
    }

    function test_revert_badHandles() public {
        string[4] memory bad = ["", "sixteen_chars_xx", "has space", "dash-name"];
        for (uint256 i; i < bad.length; i++) {
            NeuriioPad.LaunchPass memory p = _pass(alice, 42, bad[i]);
            bytes memory sig = _sign(p, signerPk);
            vm.prank(alice);
            vm.expectRevert(NeuriioPad.InvalidMetadata.selector);
            pad.launch(p, sig, 0, 0);
        }
    }

    // ------------------------------------------------------------------ who can launch

    function test_nameIsAtHandleAndTickerIsCaps() public {
        address token = _launchAs(alice, 42, "Von_Builds9", 0);
        assertEq(NeuriioToken(token).name(), "@Von_Builds9");
        assertEq(NeuriioToken(token).symbol(), "VON_BUILDS9");
        NeuriioPad.Profile memory pr = pad.profile(token);
        assertEq(pr.xUserId, 42);
        assertEq(pr.handle, "Von_Builds9");
        assertEq(uint8(pr.category), uint8(NeuriioPad.Category.Trader));
        assertEq(pr.profileHash, keccak256("profile"));
        assertEq(registry.tokenOfXUser(42), token);
        assertEq(registry.tokenOfCreator(alice), token);
    }

    function test_allCategories() public {
        for (uint8 c; c < 6; c++) {
            address who = makeAddr(string.concat("cat", vm.toString(c)));
            NeuriioPad.LaunchPass memory p = _pass(who, 500 + c, string.concat("cat", vm.toString(c)));
            p.category = c;
            bytes memory sig = _sign(p, signerPk);
            vm.prank(who);
            address token = pad.launch(p, sig, 0, 0);
            assertEq(uint8(pad.profile(token).category), c);
        }
        NeuriioPad.LaunchPass memory bad = _pass(alice, 600, "cat6");
        bad.category = 6;
        bytes memory badSig = _sign(bad, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launch(bad, badSig, 0, 0);
    }

    function test_revert_oneTokenPerXAccount() public {
        _launchAs(alice, 42, "alice", 0);
        // same X account, new wallet and even a new handle (renamed on X)
        NeuriioPad.LaunchPass memory p = _pass(bob, 42, "alice_v2");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(NeuriioRegistry.AlreadyLaunched.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_revert_oneTokenPerWallet() public {
        _launchAs(alice, 42, "alice", 0);
        NeuriioPad.LaunchPass memory p = _pass(alice, 43, "other");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioRegistry.AlreadyLaunched.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_revert_handleTakenCaseInsensitive() public {
        _launchAs(alice, 42, "Alice", 0);
        // someone who later gets the handle on X can't launch it again
        NeuriioPad.LaunchPass memory p = _pass(bob, 43, "aLICE");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(NeuriioRegistry.AlreadyLaunched.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_revert_passFromWrongSigner() public {
        NeuriioPad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, 0xBAD);
        vm.prank(alice);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_revert_passUsedByAnotherWallet() public {
        NeuriioPad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob); // stolen / front-run pass
        vm.expectRevert(NeuriioPad.NotPassHolder.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_revert_tamperedPass() public {
        NeuriioPad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        p.handle = "elonmusk";
        vm.prank(alice);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_revert_expiredPass() public {
        NeuriioPad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(alice);
        vm.expectRevert(NeuriioPad.Expired.selector);
        pad.launch(p, sig, 0, 0);
    }

    function test_rotateAndDisableSigner() public {
        NeuriioPad.LaunchPass memory p = _pass(alice, 42, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(owner);
        pad.setLaunchSigner(address(0)); // launches off
        vm.prank(alice);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launch(p, sig, 0, 0);

        vm.prank(owner);
        pad.setLaunchSigner(vm.addr(0xC0FFEE));
        bytes memory sig2 = _sign(p, 0xC0FFEE);
        vm.prank(alice);
        pad.launch(p, sig2, 0, 0);
        assertEq(registry.tokenOfXUser(42) != address(0), true);
    }

    // ------------------------------------------------------------------ curve trades

    function test_buyMatchesPreviewAndCharges1Pct() public {
        address token = _launch();
        (uint256 expOut, uint256 spent, uint256 fee) = pad.previewBuy(token, 1_010e6);
        assertEq(spent, 1_010e6);
        assertEq(fee, 10e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 out = _buy(alice, token, 1_010e6);
        assertEq(out, expOut);
        assertEq(IERC20(token).balanceOf(alice), out);
        assertEq(before - usdc.balanceOf(alice), 1_010e6);
        // x*y=k on virtual reserves: 1.073B - 5,000 * 1.073B / 6,000
        assertApproxEqAbs(out, 1_073_000_000e18 - uint256(5_000 * 1_073_000_000e18) / 6_000, 1);
        assertEq(usdc.balanceOf(address(vault)), 10e6);
    }

    function test_sellRoundTripLosesOnlyFees() public {
        address token = _launch();
        uint256 out = _buy(alice, token, 1_010e6);
        uint256 back = _sell(alice, token, out);
        // 1,000 USDC in; ~1,000 gross back (rounding favors the curve) minus the 1% sell fee
        assertApproxEqAbs(back, 990e6, 2);
        assertLe(back, 990e6);
        NeuriioPad.Curve memory c = _curve(token);
        assertEq(c.realToken, 793_100_000e18);
        assertEq(usdc.balanceOf(address(pad)), c.realQuote);
    }

    function test_revert_slippageAndDeadline() public {
        address token = _launch();
        (uint256 expOut,,) = pad.previewBuy(token, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(pad), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPad.Slippage.selector, expOut, expOut + 1));
        pad.buy(token, 1_000e6, expOut + 1, block.timestamp);
        vm.expectRevert(NeuriioPad.Expired.selector);
        pad.buy(token, 1_000e6, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_revert_unknownToken() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPad.UnknownToken.selector, address(0xBEEF)));
        pad.buy(address(0xBEEF), 1e6, 0, block.timestamp);
    }

    // ------------------------------------------------------------------ graduation

    function test_graduationBurnsLpAndMatchesCurvePrice() public {
        address token = _launch();
        _buy(alice, token, 1_010e6);
        uint256 need = pad.quoteToGraduate(token);
        // the whole curve raises VQ x 1.073 / 0.2799 - VQ (~14,168 USDC), plus 1%
        uint256 raise = Math.mulDiv(VQ, 1_073_000_000e18, 1_073_000_000e18 - 793_100_000e18) - VQ;
        assertApproxEqRel(need + 1_010e6, raise * 101 / 100, 1e14);

        uint256 bobBefore = usdc.balanceOf(bob);
        _buy(bob, token, need + 500e6); // offers more: only what's needed is taken
        assertEq(bobBefore - usdc.balanceOf(bob), need);

        NeuriioPad.Curve memory c = _curve(token);
        assertTrue(c.graduated);
        assertEq(c.realToken, 0);
        assertEq(IERC20(token).balanceOf(address(pad)), 0);
        assertEq(usdc.balanceOf(address(pad)), 0); // everything went to the pool; fees are in the vault

        IPair pair = _pairOf(token);
        assertTrue(address(pair) != address(0));
        // every LP token is burned (V2 locks the first 1,000 units at address(0), the rest went to DEAD)
        assertEq(pair.balanceOf(DEAD) + pair.balanceOf(address(0)), pair.totalSupply());
        assertEq(pair.balanceOf(address(0)), 1_000);
        assertEq(pair.balanceOf(address(pad)), 0);

        // pool opens at the curve's closing price
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rQuote, uint256 rTok) = pair.token0() == address(usdc) ? (r0, r1) : (r1, r0);
        assertEq(rTok, 206_900_000e18);
        assertApproxEqAbs(rQuote, raise, 2);
        uint256 poolPrice = rQuote * 1e18 / rTok;
        uint256 curvePrice = uint256(c.virtualQuote) * 1e18 / c.virtualToken;
        assertApproxEqRel(poolPrice, curvePrice, 1e14); // within 0.01%
    }

    function test_revert_curveClosedAfterGraduation() public {
        address token = _graduated(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPad.AlreadyGraduated.selector, token));
        pad.buy(token, 1e6, 0, block.timestamp);
    }

    function test_graduationIgnoresTokensDonatedToPairAddress() public {
        address token = _launch();
        uint256 got = _buy(alice, token, 2_000e6);
        // attacker predicts the pair address and pre-sends tokens + USDC to skew the opening price
        address predicted = _predictPair(token);
        vm.startPrank(alice);
        IERC20(token).transfer(predicted, got / 2);
        usdc.transfer(predicted, 300e6);
        vm.stopPrank();

        _buy(bob, token, 20_000e6);
        IPair pair = _pairOf(token);
        assertEq(address(pair), predicted);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        uint256 rTok = pair.token0() == token ? r0 : r1;
        assertEq(rTok, 206_900_000e18); // donation skimmed to DEAD, not in the pool
        assertEq(IERC20(token).balanceOf(DEAD), got / 2);
        assertEq(usdc.balanceOf(DEAD), 300e6);
    }

    function test_revert_nobodyElseCanCreatePairs() public {
        address token = _launch();
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.createPair(token, address(usdc));
    }

    // ------------------------------------------------------------------ after graduation: the router

    function test_routerBuySellAfterGraduation() public {
        address token = _graduated(alice);
        (uint256 q, uint256 spent) = trade.quoteBuy(token, 100e6);
        assertEq(spent, 100e6);
        vm.expectEmit(address(trade));
        emit NeuriioRouter.Swapped(token, bob, bob, true, 100e6, q);
        uint256 out = _tradeBuy(bob, token, 100e6);
        assertEq(out, q);
        assertEq(IERC20(token).balanceOf(bob), out);

        uint256 qs = trade.quoteSell(token, out);
        uint256 before = usdc.balanceOf(bob);
        uint256 back = _tradeSell(bob, token, out);
        assertEq(back, qs);
        assertEq(usdc.balanceOf(bob) - before, back);
        assertApproxEqRel(back, 98.01e6, 1e14); // 1% fee each way
    }

    // ------------------------------------------------------------------ fees (nobody staked here, so stakers' shares fall
    //                                                                      to the treasury; staking: NeuriioStaking.t.sol)

    /// Curve fee: 80% $NEURIIO stakers (nobody yet: falls to the treasury), 10% KNTQ buyback, 10% treasury, no creator.
    function test_curveFeeSplit() public {
        address token = _launch(); // creator = `creator`
        _buy(alice, token, 1_010e6); // fee 10 USDC: 50% stakers / 30% buyback / 10% creator / 10% treasury
        assertEq(vault.creatorBalance(creator), 1e6, "10% to the creator on the curve too");
        assertEq(vault.buybackBalance(), 3e6);
        assertEq(vault.treasuryBalance(), 6e6); // its 10% + the unclaimed stakers' 50%
        assertEq(vault.feesOf(token), 10e6);
        assertEq(vault.totalFees(), 10e6);
        assertEq(vault.held(), 10e6);
        vm.prank(creator);
        assertEq(vault.claim(creator), 1e6);
    }

    function test_treasuryWaitsForWallets() public {
        address token = _launch();
        _buy(alice, token, 10_100e6); // fee 100 -> treasury 60 (its 10% + the unclaimed 50%), buyback 30, creator 10
        vm.expectRevert(NeuriioFees.WalletsNotSet.selector);
        vault.payProtocol();

        address buyback = makeAddr("buyback");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setWallets(treasury, buyback);
        vm.prank(owner);
        vault.setWallets(treasury, buyback);
        vault.payProtocol(); // anyone
        assertEq(usdc.balanceOf(treasury), 60e6);
        assertEq(usdc.balanceOf(buyback), 30e6);
        assertEq(vault.treasuryBalance() + vault.buybackBalance(), 0);
        assertEq(usdc.balanceOf(address(vault)), vault.held());
    }

    function test_poolFeesGoToCreatorInUsdc() public {
        address token = _graduated(alice);
        uint256 creatorBefore = vault.creatorBalance(creator);

        // buy: fee = 1% of the USDC in, and the trader gets exactly the V2 quote
        (uint256 q,) = trade.quoteBuy(token, 100e6);
        uint256 out = _tradeBuy(bob, token, 100e6);
        assertEq(out, q);
        assertEq(vault.creatorBalance(creator) - creatorBefore, 0.1e6); // 10% of 1 USDC
        assertEq(usdc.balanceOf(address(vault)), vault.held());

        // sell: fee = 1% of the tokens in, taken out as their USDC value
        uint256 mid = vault.creatorBalance(creator);
        uint256 back = _tradeSell(bob, token, out);
        assertApproxEqRel(vault.creatorBalance(creator) - mid, back * 100 / 9_900 / 10, 0.01e18);

        // the creator claims in USDC
        uint256 owed = vault.creatorBalance(creator);
        uint256 before = usdc.balanceOf(creator);
        vm.prank(creator);
        vault.claim(creator);
        assertEq(usdc.balanceOf(creator) - before, owed);
        assertEq(vault.creatorBalance(creator), 0);
    }

    // ------------------------------------------------------------------ our Uniswap V2 fork (src/swap/v2)

    /// An aggregator swapping on the pair directly (no router) gets V2's output for a 1% fee and pays the same fee.
    function test_directPairSwapPaysFeeAndMatchesV2Math() public {
        address token = _graduated(alice);
        IPair pair = _pairOf(token);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool quoteIs0 = pair.token0() == address(usdc);
        (uint256 rQuote, uint256 rTok) = quoteIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 amountIn = 200e6;
        uint256 out = trade.getAmountOut(amountIn, rQuote, rTok);
        uint256 creatorBefore = vault.creatorBalance(creator);

        vm.startPrank(bob);
        usdc.transfer(address(pair), amountIn);
        // one wei more than the 1% quote breaks K
        (uint256 a0, uint256 a1) = quoteIs0 ? (uint256(0), out + 1) : (out + 1, uint256(0));
        vm.expectRevert(bytes("UniswapV2: K"));
        pair.swap(a0, a1, bob, "");
        (a0, a1) = quoteIs0 ? (uint256(0), out) : (out, uint256(0));
        pair.swap(a0, a1, bob, "");
        vm.stopPrank();

        assertEq(IERC20(token).balanceOf(bob), out);
        assertEq(vault.creatorBalance(creator) - creatorBefore, amountIn / 100 / 10); // 10% of the 1% fee
        (r0, r1,) = pair.getReserves();
        assertEq(quoteIs0 ? r0 : r1, rQuote + amountIn - amountIn / 100); // the fee left the pool
    }

    function test_v2ForkAdmin() public {
        IPair pair = _pairOf(_graduated(alice));
        assertEq(pair.name(), "Neuriio LP");
        assertEq(pair.factory(), address(factory));
        assertEq(factory.feeToSetter(), owner);
        assertEq(factory.registry(), address(registry));
        assertEq(factory.feeVault(), address(vault));
        assertEq(factory.quote(), address(usdc));
        // owner only; the registry is set once, the fee vault is replaceable (see test_feeVault_*)
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.setFeeVault(alice);
        vm.startPrank(owner);
        vm.expectRevert(bytes("UniswapV2: ALREADY_SET"));
        factory.setRegistry(alice);
        vm.stopPrank();
    }

    function test_revert_onlyPairsAndLaunchpadFeedTheVault() public {
        address token = _launch();
        vm.expectRevert(NeuriioFees.NotPair.selector);
        vault.notifyPoolFee(token);
        vm.prank(alice);
        vm.expectRevert(NeuriioFees.NotLaunchpad.selector);
        vault.notifyCurveFee(token);
    }

    function testFuzz_poolFeeNeverShrinksK(uint256 seed) public {
        address token = _graduated(alice);
        IPair pair = _pairOf(token);
        vm.startPrank(bob);
        IERC20(token).approve(address(trade), type(uint256).max);
        for (uint256 i; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            (uint112 r0, uint112 r1,) = pair.getReserves();
            uint256 kBefore = uint256(r0) * r1;
            if (seed % 2 == 0) {
                trade.buy(token, bound(seed >> 8, 1e3, 5_000e6), 0, block.timestamp);
            } else {
                uint256 bal = IERC20(token).balanceOf(bob);
                if (bal == 0) continue;
                trade.sell(token, bound(seed >> 8, 1e12, bal), 0, block.timestamp);
            }
            (r0, r1,) = pair.getReserves();
            assertGe(uint256(r0) * r1, kBefore);
            assertEq(usdc.balanceOf(address(pair)), pair.token0() == address(usdc) ? r0 : r1);
        }
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ FTF (Friends Turned Fam)

    function test_ftfLaunchOnTheCurve() public {
        NeuriioPad.FtfPass memory p = _ftfPass("Degen Den", "DEN");
        address token = _launchFtf(p, 500e6);
        assertEq(IERC20Metadata(token).name(), "Degen Den");
        assertEq(IERC20Metadata(token).symbol(), "DEN");
        assertTrue(pad.isFtf(token));
        assertEq(registry.tokenOfFtfTicker(keccak256("DEN")), token);
        address[] memory cs = registry.creatorsOf(token);
        assertEq(cs.length, 4);
        for (uint256 i; i < 4; i++) {
            assertEq(cs[i], ftfWallets[i]);
        }
        NeuriioPad.Ftf memory f = pad.ftf(token);
        assertEq(f.memberXIds[3], 7_004);
        assertGt(IERC20(token).balanceOf(ftfWallets[0]), 0, "founder's first buy");
        // same curve as individuals
        NeuriioPad.Curve memory c = _curve(token);
        assertEq(c.creator, ftfWallets[0]);
        assertEq(c.realToken, 793_100_000e18 - IERC20(token).balanceOf(ftfWallets[0]));
        // members didn't use up their individual launches
        assertEq(registry.tokenOfXUser(7_001), address(0));
        assertEq(registry.tokenOfCreator(ftfWallets[0]), address(0));
        address solo = _launchAs(ftfWallets[1], 7_002, "membertwo", 0);
        assertFalse(pad.isFtf(solo));
        assertEq(registry.creatorsOf(solo).length, 1);
    }

    function test_ftfFeesSplitEquallyAndGraduates() public {
        address token = _launchFtf(_ftfPass("Degen Den", "DEN"), 0);
        _buy(bob, token, 20_000e6); // graduates into the V2 pool like any token
        assertTrue(_curve(token).graduated);
        uint256[4] memory before;
        for (uint256 i; i < 4; i++) before[i] = vault.creatorBalance(ftfWallets[i]); // their curve-fee shares
        assertGt(before[1], 0, "creators earn on the curve too");
        _tradeBuy(alice, token, 1_000e6); // pool fee 10 -> creators 1, split 4 ways
        uint256 each = vault.creatorBalance(ftfWallets[1]) - before[1];
        assertEq(each, 0.25e6);
        for (uint256 i = 1; i < 4; i++) {
            assertEq(vault.creatorBalance(ftfWallets[i]) - before[i], each);
        }
        assertApproxEqAbs(vault.creatorBalance(ftfWallets[0]) - before[0], each, 3, "founder gets the rounding units");
        uint256 all;
        for (uint256 i; i < 4; i++) all += vault.creatorBalance(ftfWallets[i]);
        assertEq(vault.creatorEarned(token), all, "lifetime creator fees = the 4 balances (curve + pool)");
        // every member claims their own share
        for (uint256 i; i < 4; i++) {
            uint256 bal = usdc.balanceOf(ftfWallets[i]);
            vm.prank(ftfWallets[i]);
            uint256 got = vault.claim(ftfWallets[i]);
            assertEq(usdc.balanceOf(ftfWallets[i]) - bal, got);
        }
    }

    function test_revert_ftfPassRules() public {
        NeuriioPad.FtfPass memory p = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(p, signerPk);
        // only the founder can send it
        vm.prank(ftfWallets[1]);
        vm.expectRevert(NeuriioPad.NotPassHolder.selector);
        pad.launchFtf(p, sig, 0, 0);
        // wrong signer
        bytes memory bad = _signFtf(p, 0xBAD);
        vm.prank(p.founder);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launchFtf(p, bad, 0, 0);
        // tampered after signing (members swapped)
        NeuriioPad.FtfPass memory t = _ftfPass("Degen Den", "DEN");
        t.members[3] = alice;
        vm.prank(t.founder);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launchFtf(t, sig, 0, 0);
        // expired
        vm.warp(p.deadline + 1);
        vm.prank(p.founder);
        vm.expectRevert(NeuriioPad.Expired.selector);
        pad.launchFtf(p, sig, 0, 0);
    }

    function test_revert_ftfMembersNamesTickers() public {
        NeuriioPad.FtfPass memory p;
        // duplicate member (same X account twice)
        p = _ftfPass("Degen Den", "DEN");
        p.memberXIds[2] = p.memberXIds[1];
        _expectFtfRevert(p, NeuriioPad.InvalidMembers.selector);
        // duplicate wallet
        p = _ftfPass("Degen Den", "DEN");
        p.members[3] = p.members[1];
        _expectFtfRevert(p, NeuriioPad.InvalidMembers.selector);
        // missing member
        p = _ftfPass("Degen Den", "DEN");
        p.members[2] = address(0);
        _expectFtfRevert(p, NeuriioPad.InvalidMembers.selector);
        // founder must be member #1
        p = _ftfPass("Degen Den", "DEN");
        p.founder = p.members[1];
        _expectFtfRevert(p, NeuriioPad.NotPassHolder.selector);
        // bad names
        string[5] memory badNames = [" Den", "Den ", "De  n", "Den<script>", "This name is far too long for an FTF"];
        for (uint256 i; i < 5; i++) {
            p = _ftfPass(badNames[i], "DEN");
            _expectFtfRevert(p, NeuriioPad.InvalidMetadata.selector);
        }
        // bad tickers
        string[4] memory badTickers = ["D", "den", "DEN!", "ABCDEFGHIJK"];
        for (uint256 i; i < 4; i++) {
            p = _ftfPass("Degen Den", badTickers[i]);
            _expectFtfRevert(p, NeuriioPad.InvalidMetadata.selector);
        }
        // ticker unique among FTFs
        _launchFtf(_ftfPass("Degen Den", "DEN"), 0);
        p = _ftfPass("Another Den", "DEN");
        p.memberXIds = [uint64(8_001), 8_002, 8_003, 8_004];
        _expectFtfRevert(p, NeuriioRegistry.TickerTaken.selector);
    }

    function test_reservedTickers() public {
        // seeded at deploy: an FTF can't be $USDC, and an X account named @usdc / @Hype can't launch itself
        assertTrue(registry.reservedTicker(keccak256("USDC")));
        _expectFtfRevert(_ftfPass("Fake Dollars", "USDC"), NeuriioRegistry.TickerIsReserved.selector);
        NeuriioPad.LaunchPass memory lp = _pass(alice, 42, "Hype");
        bytes memory sig = _sign(lp, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioRegistry.TickerIsReserved.selector);
        pad.launch(lp, sig, 0, 0);
        // near-misses are fine
        _launchAs(alice, 42, "hype_fan", 0);

        // owner-only; can add and free tickers
        string[] memory t = new string[](1);
        t[0] = "DEN";
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.setReservedTickers(t, true);
        vm.prank(owner);
        registry.setReservedTickers(t, true);
        _expectFtfRevert(_ftfPass("Degen Den", "DEN"), NeuriioRegistry.TickerIsReserved.selector);
        vm.prank(owner);
        registry.setReservedTickers(t, false);
        _launchFtf(_ftfPass("Degen Den", "DEN"), 0);
    }

    // ------------------------------------------------------------------ upgrades: a new NeuriioPad version

    /// The whole point of the NeuriioRegistry: shipping a new NeuriioPad orphans nothing.
    function test_upgrade_newVersionOrphansNothing() public {
        NeuriioPad v1 = pad;
        address curveTok = _launchAs(alice, 42, "alice", 1_000e6); // still on v1's curve at upgrade time
        address gradTok = _launchAs(creator, 43, "creator", 0);
        _buy(bob, gradTok, 20_000e6); // graduated on v1
        assertTrue(address(_pairOf(gradTok)) != address(0));

        // ship v2, retire v1 for NEW launches
        NeuriioPad v2 = _newLaunchpad();
        vm.startPrank(owner);
        registry.setLaunchpad(address(v2), true);
        registry.setLaunchpad(address(v1), false);
        vm.stopPrank();
        assertEq(registry.launchpadsLength(), 2);

        // v1 can't launch anymore
        _expectLaunchRevert(bob, 44, "bob", NeuriioRegistry.NotLaunchpad.selector);

        // identity is global: alice can't launch again on v2 (same X account, wallet or handle)
        pad = v2;
        _expectLaunchRevert(alice, 42, "alice", NeuriioRegistry.AlreadyLaunched.selector);
        _expectLaunchRevert(bob, 45, "ALICE", NeuriioRegistry.AlreadyLaunched.selector);
        address fresh = _launchAs(bob, 44, "bob", 0);
        assertEq(registry.launchpadOf(fresh), address(v2));
        assertEq(registry.launchpadOf(curveTok), address(v1));

        // v1's curve token keeps trading, earning fees, and graduates on v1 (even though v1 is retired)
        pad = v1;
        uint256 feesBefore = vault.feesOf(curveTok);
        uint256 got = _buy(bob, curveTok, 100e6);
        assertGt(got, 0);
        _sell(bob, curveTok, got / 2);
        assertGt(vault.feesOf(curveTok), feesBefore, "curve fees still credited");
        _buy(bob, curveTok, 20_000e6);
        assertTrue(_curve(curveTok).graduated, "retired version still graduates its tokens");
        assertTrue(address(_pairOf(curveTok)) != address(0));

        // v1's graduated pool keeps trading through the router, fees to the creator
        uint256 creatorBefore = vault.creatorBalance(creator);
        _tradeBuy(alice, gradTok, 100e6);
        assertGt(vault.creatorBalance(creator), creatorBefore, "pool fees still credited");

        // a version can't act for another version's tokens
        vm.prank(address(v2));
        vm.expectRevert(NeuriioFees.NotLaunchpad.selector);
        vault.notifyCurveFee(curveTok);
    }

    function _expectLaunchRevert(address who, uint64 xId, string memory handle, bytes4 sel) internal {
        NeuriioPad.LaunchPass memory p = _pass(who, xId, handle);
        bytes memory sig = _sign(p, signerPk);
        vm.prank(who);
        vm.expectRevert(sel);
        pad.launch(p, sig, 0, 0);
    }

    function test_upgrade_versionsCantTouchEachOthersTokens() public {
        address tok = _launchAs(alice, 42, "alice", 0); // v1
        NeuriioPad v2 = _newLaunchpad();
        vm.prank(owner);
        registry.setLaunchpad(address(v2), true);
        // v2 can't open v1's pool, and nobody but an approved NeuriioPad can register tokens
        vm.prank(address(v2));
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        factory.createPair(tok, address(usdc));
        vm.expectRevert(NeuriioRegistry.NotLaunchpad.selector);
        registry.registerPersonal(tok, alice, 99, "X", keccak256("x"));
        // v2 has no curve for v1's token
        vm.expectRevert(abi.encodeWithSelector(NeuriioPad.UnknownToken.selector, tok));
        v2.previewBuy(tok, 1e6);
        // FTF tickers are global too
        _launchFtf(_ftfPass("Degen Den", "DEN"), 0);
        pad = v2;
        NeuriioPad.FtfPass memory p = _ftfPass("Other Den", "DEN");
        p.memberXIds = [uint64(8_001), 8_002, 8_003, 8_004];
        _expectFtfRevert(p, NeuriioRegistry.TickerTaken.selector);
    }

    // ------------------------------------------------------------------ fee vault: replaceable, never a single point of failure

    function test_feeVault_replaceWithoutOrphaningBalances() public {
        address tok = _launchAs(alice, 42, "alice", 0);
        _buy(bob, tok, 20_000e6); // graduates
        _tradeBuy(bob, tok, 1_000e6);
        uint256 oldBal = vault.creatorBalance(alice);
        assertGt(oldBal, 0);

        NeuriioFees v2 = _newVault();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        pad.setFeeVault(ICurveFeeVault(address(v2)));
        vm.startPrank(owner);
        pad.setFeeVault(ICurveFeeVault(address(v2)));
        factory.setFeeVault(address(v2));
        vm.stopPrank();

        // new fees (pool and curve) land in the new vault; the old balance stays claimable
        _tradeBuy(bob, tok, 1_000e6);
        assertGt(v2.creatorBalance(alice), 0, "pool fee -> new vault");
        address fresh = _launch();
        _buy(bob, fresh, 100e6);
        assertGt(v2.feesOf(fresh), 0, "curve fee -> new vault");
        assertEq(vault.creatorBalance(alice), oldBal, "old vault untouched");
        uint256 was = usdc.balanceOf(alice);
        vm.prank(alice);
        vault.claim(alice);
        assertEq(usdc.balanceOf(alice), was + oldBal, "old balance still claimable");
    }

    function test_feeVault_brokenVaultCantFreezeTrading() public {
        address tok = _launchAs(alice, 42, "alice", 0);
        uint256 got = _buy(bob, tok, 20_000e6); // graduated
        BrokenVault broken = new BrokenVault();
        vm.startPrank(owner);
        factory.setFeeVault(address(broken));
        pad.setFeeVault(ICurveFeeVault(address(broken)));
        vm.stopPrank();
        // a broken vault blocks swaps...
        vm.startPrank(bob);
        IERC20(tok).approve(address(trade), got);
        vm.expectRevert();
        trade.sell(tok, got / 10, 0, block.timestamp);
        vm.stopPrank();
        // ...until the owner flips the emergency switch: fees stay in the pool (like plain V2), trading resumes
        vm.prank(owner);
        factory.setFeeVault(address(0));
        vm.prank(bob);
        uint256 out = trade.sell(tok, got / 10, 0, block.timestamp);
        assertGt(out, 0, "holders can exit");
    }

    function test_registryOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.setLaunchpad(alice, true);
        vm.prank(owner);
        vm.expectRevert(NeuriioRegistry.InvalidParams.selector);
        registry.setLaunchpad(address(0), true);
        // re-approving a known version doesn't list it twice
        vm.startPrank(owner);
        registry.setLaunchpad(address(pad), false);
        registry.setLaunchpad(address(pad), true);
        vm.stopPrank();
        assertEq(registry.launchpadsLength(), 1);
    }

    function _expectFtfRevert(NeuriioPad.FtfPass memory p, bytes4 sel) internal {
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(p.founder);
        vm.expectRevert(sel);
        pad.launchFtf(p, sig, 0, 0);
    }

    /// Pause stops launches and buys, but holders can still sell (always able to exit).
    function test_pauseStopsBuysAndLaunchesButNotSells() public {
        address token = _launch();
        uint256 got = _buy(alice, token, 1_000e6);
        vm.prank(owner);
        pad.pause();

        vm.startPrank(bob);
        usdc.approve(address(pad), type(uint256).max);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pad.buy(token, 1_000e6, 0, block.timestamp);
        vm.stopPrank();

        NeuriioPad.LaunchPass memory p = _pass(bob, 9_999, "pausedlaunch");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        pad.launch(p, sig, 0, 0);

        uint256 before = usdc.balanceOf(alice);
        uint256 out = _sell(alice, token, got);
        assertGt(out, 0);
        assertEq(usdc.balanceOf(alice) - before, out);
        assertEq(IERC20(token).balanceOf(alice), 0);
    }

    function test_revert_feeCap() public {
        assertEq(pad.feeBps(), 100);
        vm.prank(owner);
        vm.expectRevert(NeuriioPad.InvalidParams.selector);
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
                _buy(w, token, bound(seed >> 16, 1e3, 3_000e6));
            } else {
                uint256 bal = IERC20(token).balanceOf(w);
                if (bal > 0) _sell(w, token, bound(seed >> 16, 1e12, bal));
            }
            NeuriioPad.Curve memory c = _curve(token);
            if (!c.graduated) {
                // USDC held covers what was raised, and tokens held cover what's left to sell + LP
                assertGe(usdc.balanceOf(address(pad)), c.realQuote);
                assertGe(IERC20(token).balanceOf(address(pad)), uint256(c.realToken) + pad.LP_SUPPLY());
                // everything bought can always be sold back: raised USDC >= value of circulating tokens at the curve
                uint256 circulating = 793_100_000e18 - c.realToken;
                uint256 payout =
                    c.virtualQuote - uint256(c.virtualQuote) * c.virtualToken / (c.virtualToken + circulating);
                assertGe(uint256(c.realQuote) + 1, payout);
            }
        }
    }
}

/// A NeuriioFees that rejects everything (for the "broken vault" test).
contract BrokenVault {
    function notifyPoolFee(address) external pure {
        revert("broken");
    }

    function notifyCurveFee(address) external pure {
        revert("broken");
    }
}
