// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {KeeperHyperCoreOracle} from "../src/oracle/KeeperHyperCoreOracle.sol";
import {HyperCoreReader} from "../src/libraries/HyperCoreReader.sol";
import {PropAMM} from "../src/amm/PropAMM.sol";
import {MockERC20, FeeOnTransferERC20} from "./mocks/MockERC20.sol";

contract PropAMMTest is Test {
    uint32 constant SPOT = 1035;
    uint64 constant T0 = 1_790_000_000;
    uint256 constant CORE_BID = 25e18;
    uint256 constant CORE_ASK = 25.01e18;

    MockERC20 hype;
    MockERC20 usdc;
    KeeperHyperCoreOracle oracle;
    PropAMM amm;

    address owner = makeAddr("owner");
    address quoter = makeAddr("quoter");
    address trader = makeAddr("trader");

    function _risk() internal pure returns (PropAMM.RiskParams memory) {
        return PropAMM.RiskParams({
            minEdgeBps: 2,
            maxTradeBps: 1_000, // 10% of pool value
            depthFactorBps: 20_000, // 2x Core touch size
            maxAgeMs: 2_000,
            maxL2BlockLag: 10,
            maxCoreSpreadBps: 50
        });
    }

    function _quote() internal pure returns (PropAMM.QuoteParams memory) {
        return
            PropAMM.QuoteParams({edgeBps: 5, targetBaseBps: 5_000, skewFactorBps: 100, maxSkewBps: 50, impactBps: 20});
    }

    function setUp() public {
        vm.warp(T0);
        hype = new MockERC20("Hype", "HYPE", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        oracle = new KeeperHyperCoreOracle(address(this), 500);
        oracle.setUpdater(address(this), true);
        _pushCore(CORE_BID, CORE_ASK, 1_000e18, 1_000e18);

        amm = new PropAMM(
            owner, IERC20Metadata(address(hype)), IERC20Metadata(address(usdc)), oracle, SPOT, _risk(), _quote()
        );
        vm.prank(owner);
        amm.setQuoter(quoter, true);

        // Balanced pool: 1000 HYPE + 25,005 USDC (= 1000 * mid)
        _seed(1_000e18, 25_005e6);

        hype.mint(trader, 1_000_000e18);
        usdc.mint(trader, 100_000_000e6);
        vm.startPrank(trader);
        hype.approve(address(amm), type(uint256).max);
        usdc.approve(address(amm), type(uint256).max);
        vm.stopPrank();
    }

    uint64 coreTime = T0 * 1000;

    function _pushCore(uint256 bid, uint256 ask, uint256 bidSz, uint256 askSz) internal {
        KeeperHyperCoreOracle.Update[] memory u = new KeeperHyperCoreOracle.Update[](1);
        u[0] = KeeperHyperCoreOracle.Update(SPOT, bid, ask, bidSz, askSz, 0, ++coreTime);
        oracle.push(u);
    }

    function _seed(uint256 baseAmt, uint256 quoteAmt) internal {
        hype.mint(owner, baseAmt);
        usdc.mint(owner, quoteAmt);
        vm.startPrank(owner);
        hype.approve(address(amm), baseAmt);
        usdc.approve(address(amm), quoteAmt);
        amm.deposit(baseAmt, quoteAmt);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ pricing

    function test_neutralQuoteIsCoreTouchPlusEdge() public view {
        (uint256 bid, uint256 ask,) = amm.currentQuote();
        assertEq(bid, 24.9875e18); // 25.00 * (1 - 5bps)
        assertEq(ask, 25.022505e18); // 25.01 * (1 + 5bps)
        assertEq(amm.poolValue(), 50_010e18);
    }

    function test_sellBase_exactMath() public {
        // impact = ceil(20bps * 25.005 / 50010) = 1bps -> bid = 25 * (1 - 6bps) = 24.985
        vm.expectEmit(address(amm));
        emit PropAMM.Swap(
            trader, trader, false, 1e18, 24_985_000, 24.985e18, 25.005e18, coreTime, 1_001e18, 25_005e6 - 24_985_000
        );
        vm.prank(trader);
        uint256 out = amm.sellBase(1e18, 24_985_000, trader, block.timestamp);

        assertEq(out, 24_985_000);
        assertEq(amm.baseReserve(), 1_001e18);
        assertEq(amm.quoteReserve(), 25_005e6 - 24_985_000);
        assertEq(hype.balanceOf(address(amm)), amm.baseReserve());
        assertEq(usdc.balanceOf(address(amm)), amm.quoteReserve());
    }

    function test_buyBase_exactMath() public {
        // impact = ceil(20bps * 100 / 50010) = 1bps -> ask = 25.01 * (1 + 6bps) = 25.025006
        uint256 expectedPrice = 25.025006e18;
        uint256 expectedOut = Math.mulDiv(100e6, 1e18 * 1e18, 1e6 * expectedPrice);
        (uint256 previewOut, uint256 previewPx) = amm.previewBuyBase(100e6);
        assertEq(previewPx, expectedPrice);
        assertEq(previewOut, expectedOut);

        vm.prank(trader);
        uint256 out = amm.buyBase(100e6, expectedOut, trader, block.timestamp);
        assertEq(out, expectedOut);
        assertEq(hype.balanceOf(trader), 1_000_000e18 + expectedOut);
    }

    function test_skew_longBaseLowersBothPrices() public {
        (uint256 bid0, uint256 ask0,) = amm.currentQuote();
        _seed(1_000e18, 0); // now ~66.7% base vs 50% target -> +16.7% dev -> skew 16bps
        (uint256 bid1, uint256 ask1,) = amm.currentQuote();
        assertLt(bid1, bid0);
        assertLt(ask1, ask0);
        // bid = 25 * (1 - 5 - 16 bps); ask would be 25.01 * (1 + 5 - 16 bps) = 24.9825 < coreBid,
        // so the no-arb clamp floors it at coreBid * (1 + minEdge 2bps).
        assertEq(bid1, 24.9475e18);
        assertEq(ask1, 25.005e18);
    }

    function test_skew_shortBaseRaisesBothPrices() public {
        (uint256 bid0, uint256 ask0,) = amm.currentQuote();
        _seed(0, 50_010e6);
        (uint256 bid1, uint256 ask1,) = amm.currentQuote();
        assertGt(bid1, bid0);
        assertGt(ask1, ask0);
    }

    function test_noArbClamp_bindsUnderExtremeSkew() public {
        vm.prank(quoter);
        amm.setQuoteParams(
            PropAMM.QuoteParams({edgeBps: 5, targetBaseBps: 0, skewFactorBps: 10_000, maxSkewBps: 4_000, impactBps: 0})
        );
        // target 0% base, pool is 50% base -> skew would push ask ~40% below Core; clamp holds it.
        (uint256 bid, uint256 ask,) = amm.currentQuote();
        assertEq(ask, Math.mulDiv(CORE_BID, 10_002, 10_000, Math.Rounding.Ceil), "ask floored at coreBid*(1+minEdge)");
        assertLt(bid, CORE_BID);
    }

    function test_donationDoesNotMovePrice() public {
        (uint256 bid0, uint256 ask0,) = amm.currentQuote();
        hype.mint(address(amm), 10_000e18);
        (uint256 bid1, uint256 ask1,) = amm.currentQuote();
        assertEq(bid0, bid1);
        assertEq(ask0, ask1);
    }

    function test_pricesTrackCore() public {
        _pushCore(30e18, 30.01e18, 1_000e18, 1_000e18);
        (uint256 bid, uint256 ask,) = amm.currentQuote();
        assertLt(bid, 30e18);
        assertGt(ask, 30.01e18);
        assertGt(bid, 29.9e18);
    }

    // ------------------------------------------------------------------ fuzz: economic safety

    /// Nobody can buy from the pool and sell on Core (or vice versa) at a profit, whatever
    /// the quoter's params, inventory, or trade size.
    function testFuzz_noArbAgainstCore(
        uint16 edge,
        uint16 target,
        uint16 skewFactor,
        uint16 maxSkew,
        uint16 impact,
        uint96 extraBase,
        uint96 extraQuote,
        uint64 size,
        bool buy
    ) public {
        edge = uint16(bound(edge, 2, 1_000));
        maxSkew = uint16(bound(maxSkew, 0, 2_000));
        impact = uint16(bound(impact, 0, 1_000));
        vm.prank(quoter);
        amm.setQuoteParams(PropAMM.QuoteParams(edge, uint16(bound(target, 0, 10_000)), skewFactor, maxSkew, impact));
        _seed(bound(extraBase, 0, 100_000e18), bound(extraQuote, 0, 2_500_000e6));

        if (buy) {
            uint256 quoteIn = bound(size, 1e6, 1_000e6);
            (uint256 baseOut,) = amm.previewBuyBase(quoteIn);
            // Selling baseOut on Core at the bid must not return more than quoteIn.
            assertLe(Math.mulDiv(baseOut, CORE_BID, 1e18 * 1e12), quoteIn);
            assertLe(Math.mulDiv(baseOut, CORE_BID * 10_002, 1e18 * 1e12 * 10_000), quoteIn);
        } else {
            uint256 baseIn = bound(size, 1e15, 20e18);
            (uint256 quoteOut,) = amm.previewSellBase(baseIn);
            // Buying baseIn back on Core at the ask must cost at least quoteOut.
            assertGe(Math.mulDiv(baseIn, CORE_ASK, 1e18 * 1e12, Math.Rounding.Ceil), quoteOut);
        }
    }

    /// Buying then immediately selling back to the pool always loses.
    function testFuzz_roundTripLoses(uint64 quoteIn) public {
        quoteIn = uint64(bound(quoteIn, 1e6, 4_000e6));
        vm.startPrank(trader);
        uint256 baseOut = amm.buyBase(quoteIn, 0, trader, block.timestamp);
        uint256 quoteBack = amm.sellBase(baseOut, 0, trader, block.timestamp);
        vm.stopPrank();
        assertLt(quoteBack, quoteIn);
    }

    // ------------------------------------------------------------------ reverts

    function test_revert_staleCore() public {
        vm.warp(T0 + 3);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.StaleByTime.selector, SPOT, 3_000 - 1, 2_000));
        vm.prank(trader);
        amm.sellBase(1e18, 0, trader, block.timestamp);
    }

    function test_revert_wideCoreSpread() public {
        _pushCore(25e18, 26e18, 1_000e18, 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.SpreadTooWide.selector, SPOT, 393, 50));
        vm.prank(trader);
        amm.sellBase(1e18, 0, trader, block.timestamp);
    }

    function test_revert_slippage() public {
        vm.expectRevert(abi.encodeWithSelector(PropAMM.Slippage.selector, 24_985_000, 25_000_000));
        vm.prank(trader);
        amm.sellBase(1e18, 25_000_000, trader, block.timestamp);
    }

    function test_revert_deadline() public {
        vm.expectRevert(PropAMM.Expired.selector);
        vm.prank(trader);
        amm.sellBase(1e18, 0, trader, block.timestamp - 1);
    }

    function test_revert_zeroAmount() public {
        vm.expectRevert(PropAMM.ZeroAmount.selector);
        vm.prank(trader);
        amm.buyBase(0, 0, trader, block.timestamp);
    }

    function test_revert_tradeTooLarge() public {
        // 10% of 50,010 = 5,001 USDC
        vm.expectRevert(abi.encodeWithSelector(PropAMM.TradeTooLarge.selector, 5_002e18, 5_001e18));
        vm.prank(trader);
        amm.buyBase(5_002e6, 0, trader, block.timestamp);
    }

    function test_revert_exceedsCoreDepth() public {
        _pushCore(CORE_BID, CORE_ASK, 50e18, 50e18); // hedgeable size = 2x50 = 100 HYPE
        vm.expectRevert(abi.encodeWithSelector(PropAMM.ExceedsCoreDepth.selector, 101e18, 100e18));
        vm.prank(trader);
        amm.sellBase(101e18, 0, trader, block.timestamp);
    }

    function test_revert_insufficientReserve() public {
        vm.startPrank(owner);
        amm.setRiskParams(
            PropAMM.RiskParams({
                minEdgeBps: 2,
                maxTradeBps: 10_000,
                depthFactorBps: 0,
                maxAgeMs: 2_000,
                maxL2BlockLag: 10,
                maxCoreSpreadBps: 50
            })
        );
        amm.withdraw(0, 25_000e6, owner); // 5 USDC left; pool ~100% base -> skew 49bps
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(PropAMM.InsufficientReserve.selector, 24_862_500, 5e6));
        vm.prank(trader);
        amm.sellBase(1e18, 0, trader, block.timestamp);
    }

    function test_revert_emptyPool() public {
        vm.startPrank(owner);
        amm.withdraw(1_000e18, 25_005e6, owner);
        vm.stopPrank();
        vm.expectRevert(PropAMM.EmptyPool.selector);
        amm.currentQuote();
    }

    function test_revert_feeOnTransfer() public {
        FeeOnTransferERC20 fot = new FeeOnTransferERC20();
        PropAMM fotAmm = new PropAMM(
            address(this), IERC20Metadata(address(fot)), IERC20Metadata(address(usdc)), oracle, SPOT, _risk(), _quote()
        );
        fot.mint(address(this), 100e18);
        fot.approve(address(fotAmm), 100e18);
        vm.expectRevert(abi.encodeWithSelector(PropAMM.TransferAmountMismatch.selector, 99e18, 100e18));
        fotAmm.deposit(100e18, 0);
    }

    // ------------------------------------------------------------------ access control

    function test_quoterCanSetParamsWithinMinEdge() public {
        PropAMM.QuoteParams memory p = _quote();
        p.edgeBps = 1; // below minEdge 2
        vm.prank(quoter);
        vm.expectRevert(PropAMM.InvalidParams.selector);
        amm.setQuoteParams(p);

        p.edgeBps = 3;
        vm.prank(quoter);
        amm.setQuoteParams(p);
        (uint16 edge,,,,) = amm.quoteParams();
        assertEq(edge, 3);
    }

    function test_strangersCannotAdmin() public {
        vm.startPrank(trader);
        vm.expectRevert(abi.encodeWithSelector(PropAMM.NotQuoter.selector, trader));
        amm.setQuoteParams(_quote());
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        amm.withdraw(1, 0, trader);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        amm.deposit(1, 0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, trader));
        amm.setOracle(oracle);
        vm.stopPrank();
    }

    function test_quoterPausesOwnerUnpauses() public {
        vm.prank(quoter);
        amm.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(trader);
        amm.sellBase(1e18, 0, trader, block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, quoter));
        vm.prank(quoter);
        amm.unpause();

        vm.prank(owner);
        amm.unpause();
        vm.prank(trader);
        amm.sellBase(1e18, 0, trader, block.timestamp);
    }

    function test_raisingMinEdgeAboveCurrentEdgeReverts() public {
        PropAMM.RiskParams memory r = _risk();
        r.minEdgeBps = 6; // current edge is 5
        vm.prank(owner);
        vm.expectRevert(PropAMM.InvalidParams.selector);
        amm.setRiskParams(r);
    }
}
