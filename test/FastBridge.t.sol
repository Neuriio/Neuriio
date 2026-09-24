// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {KeeperHyperCoreOracle} from "../src/oracle/KeeperHyperCoreOracle.sol";
import {PropAMM} from "../src/amm/PropAMM.sol";
import {FastBridge} from "../src/bridge/FastBridge.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract FastBridgeTest is Test {
    uint64 constant T0 = 1_790_000_000;

    MockERC20 usdc;
    MockERC20 hype;
    MockERC20 kntq;
    PropAMM pool;
    FastBridge bridge;

    address owner = makeAddr("owner");
    address relayer = makeAddr("relayer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function _config() internal pure returns (FastBridge.Config memory) {
        return FastBridge.Config({
            feeBps: 5, // 0.05%
            minFee: 0.5e6,
            maxDeposit: 50_000e6,
            refundDelay: 1 hours,
            maxPayout: 20_000e6,
            dailyPayoutCap: 30_000e6
        });
    }

    function setUp() public {
        vm.warp(T0);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        hype = new MockERC20("Hype", "HYPE", 18);
        kntq = new MockERC20("Kinetiq", "KNTQ", 18);

        KeeperHyperCoreOracle oracle = new KeeperHyperCoreOracle(address(this), 500);
        oracle.setUpdater(address(this), true);
        KeeperHyperCoreOracle.Update[] memory u = new KeeperHyperCoreOracle.Update[](1);
        u[0] = KeeperHyperCoreOracle.Update(107, 93.6e18, 93.61e18, 1_000e18, 1_000e18, 0, T0 * 1000);
        oracle.push(u);

        pool = new PropAMM(
            address(this),
            IERC20Metadata(address(hype)),
            IERC20Metadata(address(usdc)),
            oracle,
            107,
            PropAMM.RiskParams(6, 1_000, 20_000, 5_000, 50, 50),
            PropAMM.QuoteParams(10, 5_000, 100, 50, 20)
        );
        hype.mint(address(this), 1_000e18);
        usdc.mint(address(this), 93_605e6);
        hype.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(1_000e18, 93_605e6);

        bridge = new FastBridge(owner, IERC20(address(usdc)), _config());
        vm.startPrank(owner);
        bridge.setRelayer(relayer, true);
        bridge.setPool(address(hype), pool);
        vm.stopPrank();
        vm.prank(relayer);
        bridge.increaseCredit(100_000e6);

        for (uint256 i; i < 2; ++i) {
            address a = i == 0 ? alice : bob;
            usdc.mint(a, 1_000_000e6);
            hype.mint(a, 10_000e18);
            vm.startPrank(a);
            usdc.approve(address(bridge), type(uint256).max);
            hype.approve(address(bridge), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _depositUsdc(address who, uint256 amt) internal returns (uint256 id) {
        vm.prank(who);
        id = bridge.deposit(address(usdc), amt, 0, address(0), block.timestamp);
    }

    function _dep(uint256 id) internal view returns (FastBridge.Deposit memory d) {
        (d.user, d.createdAt, d.status, d.hlRecipient, d.amount, d.fee) = bridge.deposits(id);
    }

    // ------------------------------------------------------------------ deposits

    function test_depositUsdc() public {
        vm.expectEmit(address(bridge));
        emit FastBridge.DepositRequested(1, alice, alice, address(usdc), 1_000e6, 999.5e6, 0.5e6);
        uint256 id = _depositUsdc(alice, 1_000e6);

        FastBridge.Deposit memory d = _dep(id);
        assertEq(uint8(d.status), uint8(FastBridge.Status.Pending));
        assertEq(d.amount, 999.5e6);
        assertEq(d.fee, 0.5e6); // max(0.5 min, 0.05% of 1000 = 0.5)
        assertEq(bridge.credit(), 100_000e6 - 999.5e6);
        assertEq(bridge.reserved(), 1_000e6);
        assertEq(bridge.freeLiquidity(), 0, "pending deposits are not spendable");
    }

    function test_percentFeeAboveMinimum() public {
        uint256 id = _depositUsdc(alice, 10_000e6);
        assertEq(_dep(id).fee, 5e6);
    }

    function test_depositHypeConvertsThroughPool() public {
        (uint256 expectedUsdc,) = pool.previewSellBase(10e18);
        vm.prank(alice);
        uint256 id = bridge.deposit(address(hype), 10e18, expectedUsdc, bob, block.timestamp);

        FastBridge.Deposit memory d = _dep(id);
        assertEq(uint256(d.amount) + d.fee, expectedUsdc);
        assertEq(d.hlRecipient, bob);
        assertEq(usdc.balanceOf(address(bridge)), expectedUsdc);
        assertEq(pool.baseReserve(), 1_010e18);
    }

    function test_revert_conversionSlippage() public {
        (uint256 expectedUsdc,) = pool.previewSellBase(10e18);
        vm.expectRevert(abi.encodeWithSelector(PropAMM.Slippage.selector, expectedUsdc, expectedUsdc + 1));
        vm.prank(alice);
        bridge.deposit(address(hype), 10e18, expectedUsdc + 1, address(0), block.timestamp);
    }

    function test_revert_unsupportedToken() public {
        vm.expectRevert(abi.encodeWithSelector(FastBridge.UnsupportedToken.selector, address(kntq)));
        vm.prank(alice);
        bridge.deposit(address(kntq), 1e18, 0, address(0), block.timestamp);
    }

    function test_setPoolRejectsMismatchedPool() public {
        vm.expectRevert(abi.encodeWithSelector(FastBridge.UnsupportedToken.selector, address(kntq)));
        vm.prank(owner);
        bridge.setPool(address(kntq), pool); // pool's base is HYPE
    }

    function test_revert_insufficientCredit() public {
        vm.prank(relayer);
        bridge.decreaseCredit(99_000e6); // 1,000 left
        vm.expectRevert(abi.encodeWithSelector(FastBridge.InsufficientCredit.selector, 1_999e6, 1_000e6));
        _depositUsdc(alice, 2_000e6);
    }

    function test_revert_tooLargeAndTooSmall() public {
        vm.expectRevert(abi.encodeWithSelector(FastBridge.DepositTooLarge.selector, 60_000e6 - 30e6, 50_000e6));
        _depositUsdc(alice, 60_000e6);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.AmountTooSmall.selector, 0.5e6, 0.5e6));
        _depositUsdc(alice, 0.5e6);
    }

    // ------------------------------------------------------------------ fulfil / refund

    function test_markFulfilled() public {
        uint256 a = _depositUsdc(alice, 1_000e6);
        uint256 b = _depositUsdc(bob, 10_000e6);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        vm.prank(relayer);
        bridge.markFulfilled(ids);

        assertEq(uint8(_dep(a).status), uint8(FastBridge.Status.Fulfilled));
        assertEq(bridge.reserved(), 0);
        assertEq(bridge.feesAccrued(), 5.5e6);
        assertEq(bridge.freeLiquidity(), 11_000e6 - 5.5e6, "fulfilled deposits become payout inventory");

        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotPending.selector, a));
        vm.prank(relayer);
        bridge.markFulfilled(ids);
    }

    function test_onlyRelayerMarks() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = _depositUsdc(alice, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotRelayer.selector, alice));
        vm.prank(alice);
        bridge.markFulfilled(ids);
    }

    function test_refundAfterDelay() public {
        uint256 id = _depositUsdc(alice, 1_000e6);
        uint256 before = usdc.balanceOf(alice);

        vm.expectRevert(abi.encodeWithSelector(FastBridge.RefundNotYet.selector, id, T0 + 1 hours));
        vm.prank(alice);
        bridge.refund(id);

        vm.warp(T0 + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotDepositor.selector, id));
        vm.prank(bob);
        bridge.refund(id);

        vm.prank(alice);
        bridge.refund(id);
        assertEq(usdc.balanceOf(alice), before + 1_000e6, "full refund incl. fee");
        assertEq(bridge.credit(), 100_000e6, "credit restored");
        assertEq(bridge.reserved(), 0);

        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotPending.selector, id));
        vm.prank(alice);
        bridge.refund(id);
    }

    function test_cannotRefundFulfilled() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = _depositUsdc(alice, 1_000e6);
        vm.prank(relayer);
        bridge.markFulfilled(ids);
        vm.warp(T0 + 2 hours);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotPending.selector, ids[0]));
        vm.prank(alice);
        bridge.refund(ids[0]);
    }

    function test_setCreditIsCompareAndSet() public {
        vm.prank(relayer);
        bridge.setCredit(100_000e6, 80_000e6);
        assertEq(bridge.credit(), 80_000e6);

        _depositUsdc(alice, 1_000e6); // credit moves under the relayer's feet
        vm.expectRevert(abi.encodeWithSelector(FastBridge.StaleCredit.selector, 80_000e6, 79_000.5e6));
        vm.prank(relayer);
        bridge.setCredit(80_000e6, 90_000e6);

        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotRelayer.selector, alice));
        vm.prank(alice);
        bridge.setCredit(79_000.5e6, 1e12);
    }

    // ------------------------------------------------------------------ payouts

    function _seedLiquidity(uint256 amt) internal {
        usdc.mint(address(bridge), amt);
    }

    function test_payout() public {
        _seedLiquidity(50_000e6);
        vm.expectEmit(address(bridge));
        emit FastBridge.PaidOut(keccak256("hl1"), bob, 9_995e6, 5e6);
        vm.prank(relayer);
        bridge.payout(keccak256("hl1"), bob, 10_000e6);
        assertEq(usdc.balanceOf(bob), 1_000_000e6 + 9_995e6);
        assertEq(bridge.feesAccrued(), 5e6);
    }

    function test_payoutOncePerHlTransfer() public {
        _seedLiquidity(50_000e6);
        vm.startPrank(relayer);
        bridge.payout(keccak256("hl1"), bob, 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.AlreadyPaid.selector, keccak256("hl1")));
        bridge.payout(keccak256("hl1"), bob, 1_000e6);
        vm.stopPrank();
    }

    function test_payoutCaps() public {
        _seedLiquidity(100_000e6);
        vm.startPrank(relayer);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.PayoutTooLarge.selector, 20_001e6, 20_000e6));
        bridge.payout(keccak256("a"), bob, 20_001e6);

        bridge.payout(keccak256("b"), bob, 20_000e6);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.DailyCapExceeded.selector, 30_001e6, 30_000e6));
        bridge.payout(keccak256("c"), bob, 10_001e6);
        bridge.payout(keccak256("d"), bob, 10_000e6);

        vm.warp(T0 + 1 days); // new UTC day
        bridge.payout(keccak256("e"), bob, 20_000e6);
        vm.stopPrank();
    }

    function test_payoutCantSpendPendingDepositsOrFees() public {
        _depositUsdc(alice, 5_000e6); // reserved, refundable
        vm.expectRevert(abi.encodeWithSelector(FastBridge.InsufficientLiquidity.selector, 999.5e6, 0));
        vm.prank(relayer);
        bridge.payout(keccak256("x"), bob, 1_000e6);
    }

    function test_onlyRelayerPaysOut() public {
        _seedLiquidity(10_000e6);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.NotRelayer.selector, alice));
        vm.prank(alice);
        bridge.payout(keccak256("x"), alice, 1_000e6);
    }

    // ------------------------------------------------------------------ admin

    function test_pauseBlocksDepositsAndPayoutsButNotRefunds() public {
        uint256 id = _depositUsdc(alice, 1_000e6);
        _seedLiquidity(10_000e6);
        vm.prank(relayer);
        bridge.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        _depositUsdc(alice, 1_000e6);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(relayer);
        bridge.payout(keccak256("x"), bob, 1_000e6);

        vm.warp(T0 + 1 hours);
        vm.prank(alice);
        bridge.refund(id); // users can always exit

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vm.prank(relayer);
        bridge.unpause();
    }

    function test_withdrawLiquidityAndFees() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = _depositUsdc(alice, 10_000e6);
        _depositUsdc(bob, 1_000e6); // stays pending
        vm.prank(relayer);
        bridge.markFulfilled(ids);

        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(FastBridge.InsufficientLiquidity.selector, 9_996e6, 9_995e6));
        bridge.withdrawLiquidity(9_996e6, owner);
        bridge.withdrawLiquidity(9_995e6, owner);
        bridge.withdrawFees(owner);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 10_000e6);
        assertEq(usdc.balanceOf(address(bridge)), 1_000e6, "only the pending deposit remains");
    }

    function test_zeroFeeSubscriptionConfig() public {
        FastBridge.Config memory c = _config();
        (c.feeBps, c.minFee) = (0, 0);
        vm.prank(owner);
        bridge.setConfig(c);

        uint256 id = _depositUsdc(alice, 1_000e6);
        assertEq(_dep(id).amount, 1_000e6, "full amount credited");
        assertEq(_dep(id).fee, 0);

        _seedLiquidity(10_000e6);
        uint256 before = usdc.balanceOf(bob);
        vm.prank(relayer);
        bridge.payout(keccak256("z"), bob, 500e6);
        assertEq(usdc.balanceOf(bob) - before, 500e6, "full amount paid out");
        assertEq(bridge.feesAccrued(), 0);
    }

    function test_configBounds() public {
        FastBridge.Config memory c = _config();
        c.feeBps = 501;
        vm.expectRevert(FastBridge.InvalidConfig.selector);
        vm.prank(owner);
        bridge.setConfig(c);
        c = _config();
        c.refundDelay = 60;
        vm.expectRevert(FastBridge.InvalidConfig.selector);
        vm.prank(owner);
        bridge.setConfig(c);
    }

    // ------------------------------------------------------------------ invariant (fuzz)

    /// Whatever mix of deposits, fulfilments, refunds and payouts happens, the contract always
    /// holds enough USDC to honour every pending refund and all earned fees.
    function testFuzz_solvency(uint256 seed) public {
        _seedLiquidity(20_000e6);
        uint256 n;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 action = seed % 4;
            uint256 amt = 1e6 + (seed >> 8) % 5_000e6;
            if (action == 0 && amt - 0.5e6 <= bridge.credit()) {
                _depositUsdc(seed % 2 == 0 ? alice : bob, amt);
                n++;
            } else if (action == 1 && n > 0) {
                uint256 id = 1 + (seed >> 16) % n;
                (,, FastBridge.Status s,,,) = bridge.deposits(id);
                if (s == FastBridge.Status.Pending) {
                    uint256[] memory ids = new uint256[](1);
                    ids[0] = id;
                    vm.prank(relayer);
                    bridge.markFulfilled(ids);
                }
            } else if (action == 2 && n > 0) {
                uint256 id = 1 + (seed >> 16) % n;
                (address user,, FastBridge.Status s,,,) = bridge.deposits(id);
                if (s == FastBridge.Status.Pending) {
                    vm.warp(block.timestamp + 1 hours);
                    vm.prank(user);
                    bridge.refund(id);
                }
            } else if (action == 3) {
                uint256 net = amt - _max(0.5e6, (amt * 5 + 9_999) / 10_000);
                if (net <= bridge.freeLiquidity() && amt <= 20_000e6) {
                    vm.warp(block.timestamp + 1 days); // stay under the daily cap
                    vm.prank(relayer);
                    bridge.payout(bytes32(seed), bob, amt);
                }
            }
            assertGe(usdc.balanceOf(address(bridge)), bridge.reserved() + bridge.feesAccrued(), "insolvent");
        }
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
