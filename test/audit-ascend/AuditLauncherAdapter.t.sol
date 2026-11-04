// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAscendAdapter} from "../../src/launch/IAscendAdapter.sol";
import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";
import {AscendAuditBase, AuditAdapter, AuditToken} from "./AscendAuditBase.sol";

/// Cantina risks 1 and 7, as they apply now (launch atomicity, first-buy slippage and refunds): a launch happens whole or not
/// at all, and even a hostile adapter can only touch the USDC its own caller chose to spend in that call.
contract AuditLauncherAdapterTest is AscendAuditBase {
    uint256 constant BUY = 100e6;

    function _launchWithBuy(uint256 min) internal returns (address) {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        return launcher.launch(p, sig, BUY, min);
    }

    function _assertNothingHappened() internal view {
        assertEq(launcher.allTokensLength(), 0);
        assertEq(launcher.tokenOfXUser(1), address(0));
        assertEq(launcher.tokenOfCreator(alice), address(0));
        assertEq(launcher.tokenOfHandle(keccak256("alice")), address(0));
        assertEq(usdc.balanceOf(alice), BUY);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    // ------------------------------------------------------------------ whole or not at all

    function test_failedLaunchOnAscendLeavesNoTrace() public {
        _fund(alice, BUY);
        adapter.setMode(AuditAdapter.Mode.RevertLaunch);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert("ascend: launch failed");
        launcher.launch(p, sig, BUY, 0);
        _assertNothingHappened();
        adapter.setMode(AuditAdapter.Mode.Normal);
        vm.prank(alice);
        launcher.launch(p, sig, BUY, 0); // the same pass still works
    }

    function test_failedFirstBuyUndoesTheLaunch() public {
        _fund(alice, BUY);
        adapter.setMode(AuditAdapter.Mode.RevertBuy);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert("ascend: buy failed");
        launcher.launch(p, sig, BUY, 0);
        _assertNothingHappened();
    }

    function test_slippageUndoesTheLaunch() public {
        _fund(alice, BUY);
        uint256 out = BUY * adapter.TOKENS_PER_USDC_UNIT();
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, out, out + 1));
        launcher.launch(p, sig, BUY, out + 1);
        _assertNothingHappened();
    }

    function test_ftfFirstBuyFailureUndoesTheLaunch() public {
        _fund(alice, BUY);
        adapter.setMode(AuditAdapter.Mode.RevertBuy);
        NeuriioLauncher.FtfPass memory p = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(alice);
        vm.expectRevert("ascend: buy failed");
        launcher.launchFtf(p, sig, BUY, 0);
        assertEq(launcher.tokenOfFtfTicker(keccak256("DEN")), address(0));
        assertEq(launcher.allTokensLength(), 0);
        assertEq(usdc.balanceOf(alice), BUY);
    }

    // ------------------------------------------------------------------ first buy

    function testFuzz_firstBuyAccounting(uint96 raw) public {
        uint256 buy = bound(raw, 1, 1e15);
        _fund(alice, buy);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        address token = launcher.launch(p, sig, buy, 1);
        assertEq(AuditToken(token).balanceOf(alice), buy * adapter.TOKENS_PER_USDC_UNIT());
        assertEq(usdc.balanceOf(adapter.POOL()), buy);
        assertEq(usdc.balanceOf(address(launcher)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(AuditToken(token).balanceOf(address(launcher)), 0);
    }

    function test_unusedUsdcGoesBackToTheBuyer() public {
        _fund(alice, BUY);
        adapter.setMode(AuditAdapter.Mode.RefundHalf);
        address token = _launchWithBuy(1);
        assertEq(usdc.balanceOf(alice), BUY / 2);
        assertEq(usdc.balanceOf(adapter.POOL()), BUY / 2);
        assertEq(AuditToken(token).balanceOf(alice), BUY / 2 * adapter.TOKENS_PER_USDC_UNIT());
    }

    function test_adapterKeepingUsdcIsRefused() public {
        _fund(alice, BUY);
        adapter.setMode(AuditAdapter.Mode.KeepUsdc);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.AdapterKeptUsdc.selector);
        launcher.launch(p, sig, BUY, 0);
        _assertNothingHappened();
    }

    /// USDC already sitting in the adapter (a donation) can't be used to break anyone's launch.
    function test_donationToTheAdapterDoesntBlockLaunches() public {
        usdc.mint(address(adapter), 5e6);
        _fund(alice, BUY);
        _launchWithBuy(1);
        assertEq(usdc.balanceOf(address(adapter)), 5e6);
    }

    function test_noTokensForTheUsdcIsRefusedEvenWithNoMinimum() public {
        _fund(alice, BUY);
        adapter.setMode(AuditAdapter.Mode.PayNothing);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, 0, 0));
        launcher.launch(p, sig, BUY, 0);
        _assertNothingHappened();
    }

    function test_noApprovalOrBalanceUndoesTheLaunch() public {
        usdc.mint(alice, BUY); // no approval
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert();
        launcher.launch(p, sig, BUY, 0);
        assertEq(launcher.tokenOfXUser(1), address(0));
    }

    // ------------------------------------------------------------------ bad tokens from an adapter

    function test_adapterTokenChecks() public {
        AuditToken already = AuditToken(_launch(alice, 1, "alice"));
        address[3] memory bad = [address(already), address(usdc), makeAddr("not a contract")];
        for (uint256 i; i < 3; ++i) {
            adapter.setGiven(bad[i]);
            NeuriioLauncher.LaunchPass memory p = _pass(bob, 2, "bob");
            bytes memory sig = _sign(p, signerPk);
            vm.prank(bob);
            vm.expectRevert(NeuriioLauncher.BadAdapterToken.selector);
            launcher.launch(p, sig, 0, 0);
        }
        assertEq(launcher.creatorOf(address(already)), alice);
    }

    // ------------------------------------------------------------------ reentrancy

    function test_noReentryIntoAnyLaunchPath() public {
        NeuriioLauncher.LaunchPass memory inner = _pass(bob, 2, "bob");
        bytes memory innerSig = _sign(inner, signerPk);
        NeuriioLauncher.FtfPass memory innerFtf = _ftfPass("Other Den", "OTH");
        bytes memory innerFtfSig = _signFtf(innerFtf, signerPk);
        bytes[2] memory calls = [
            abi.encodeCall(NeuriioLauncher.launch, (inner, innerSig, 0, 0)),
            abi.encodeCall(NeuriioLauncher.launchFtf, (innerFtf, innerFtfSig, 0, 0))
        ];
        _fund(alice, BUY * 8);
        for (uint256 i; i < 2; ++i) {
            for (uint256 phase; phase < 2; ++phase) {
                adapter.setReenter(
                    address(launcher), phase == 0 ? calls[i] : bytes(""), phase == 1 ? calls[i] : bytes("")
                );
                NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
                bytes memory sig = _sign(p, signerPk);
                vm.prank(alice);
                vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
                launcher.launch(p, sig, BUY, 0);
            }
        }
        assertEq(launcher.allTokensLength(), 0);
    }

    // ------------------------------------------------------------------ a hostile adapter

    /// Someone with an unlimited USDC approval on the launcher loses nothing to a hostile adapter: only the launcher can pull,
    /// it only pulls from the caller of the launch in progress, and it has no way to make arbitrary calls.
    function test_hostileAdapterCantTouchOtherPeoplesApprovals() public {
        address victim = makeAddr("victim");
        _fund(victim, 1_000e6);
        _fund(alice, BUY);

        // tries to pull the victim's USDC from inside the launch, directly and through the launcher
        adapter.setReenter(
            address(usdc), abi.encodeCall(usdc.transferFrom, (victim, address(adapter), 1_000e6)), bytes("")
        );
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(); // the adapter has no allowance
        launcher.launch(p, sig, BUY, 0);

        adapter.setReenter(address(0), bytes(""), bytes(""));
        vm.prank(alice);
        launcher.launch(p, sig, BUY, 0);
        assertEq(usdc.balanceOf(victim), 1_000e6);
    }

    /// FINDING I-02: what a hostile adapter CAN do, once the owner has plugged it in through the timelock's delay: take the
    /// first-buy USDC of whoever launches during that time, up to what each chose to spend, by minting a worthless token that
    /// passes every check here (the launcher can't tell Ascend's tokens from fake ones).
    function test_I02_hostileAdapterCanTakeAFirstBuyButNothingElse() public {
        _fund(alice, BUY * 3);
        address worthless = _launchWithBuy(1);
        assertEq(AuditToken(worthless).balanceOf(alice), BUY * adapter.TOKENS_PER_USDC_UNIT());
        assertEq(usdc.balanceOf(adapter.POOL()), BUY); // gone, as far as the launcher can tell a fair buy
        assertEq(usdc.balanceOf(alice), BUY * 2); // the rest of alice's balance, approved and all, is untouched
    }

    // ------------------------------------------------------------------ what the adapter is told

    function test_launchDataReachesTheAdapterOnBothPaths() public {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        p.launchData = hex"c0ffee";
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        launcher.launch(p, sig, 0, 0);
        assertEq(adapter.lastData(), hex"c0ffee");

        NeuriioLauncher.FtfPass memory f = _ftfPass("Degen Den", "DEN");
        f.launchData = hex"bada55";
        sig = _signFtf(f, signerPk);
        vm.prank(alice);
        launcher.launchFtf(f, sig, 0, 0);
        assertEq(adapter.lastData(), hex"bada55");
    }

    // ------------------------------------------------------------------ swapping the adapter

    function test_swappingTheAdapterKeepsEveryRecord() public {
        address token = _launch(alice, 1, "alice");
        AuditAdapter next = new AuditAdapter(usdc);
        vm.prank(owner);
        launcher.setAdapter(next);
        assertEq(launcher.tokenOfXUser(1), token);
        assertTrue(launcher.isLaunched(token));
        NeuriioLauncher.LaunchPass memory again = _pass(alice, 1, "alice");
        bytes memory sig = _sign(again, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
        launcher.launch(again, sig, 0, 0);
        vm.prank(owner);
        launcher.setAdapter(IAscendAdapter(address(0)));
        assertTrue(launcher.isLaunched(token)); // stopping new launches changes nothing for existing tokens
    }
}
