// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHyperCoreOracle} from "../src/interfaces/IHyperCoreOracle.sol";
import {KeeperHyperCoreOracle} from "../src/oracle/KeeperHyperCoreOracle.sol";
import {HyperCoreReader} from "../src/libraries/HyperCoreReader.sol";
import {ElysiumBlock} from "../src/libraries/ElysiumBlock.sol";

contract MockArbSys {
    uint256 public arbBlockNumber;

    function set(uint256 n) external {
        arbBlockNumber = n;
    }
}

/// External wrapper so library reverts can be asserted.
contract ReaderHarness {
    function read(IHyperCoreOracle o, uint32 idx, HyperCoreReader.Guard memory g)
        external
        view
        returns (HyperCoreReader.Quote memory)
    {
        return HyperCoreReader.read(o, idx, g);
    }
}

contract HyperCoreOracleTest is Test {
    uint32 constant HYPE_USDC = 1035;
    uint64 constant T0_SEC = 1_790_000_000;

    KeeperHyperCoreOracle oracle;
    ReaderHarness reader;
    MockArbSys arbSys;
    address owner = makeAddr("owner");
    address keeper = makeAddr("keeper");

    HyperCoreReader.Guard guard = HyperCoreReader.Guard({maxAgeMs: 2_000, maxL2BlockLag: 10, maxSpreadBps: 100});

    function setUp() public {
        vm.warp(T0_SEC);
        vm.etch(ElysiumBlock.ARB_SYS, address(new MockArbSys()).code);
        arbSys = MockArbSys(ElysiumBlock.ARB_SYS);
        arbSys.set(1_000);

        oracle = new KeeperHyperCoreOracle(owner, 500);
        reader = new ReaderHarness();
        vm.prank(owner);
        oracle.setUpdater(keeper, true);
    }

    function _u(uint32 idx, uint256 bid, uint256 ask, uint64 tMs)
        internal
        pure
        returns (KeeperHyperCoreOracle.Update[] memory ups)
    {
        ups = new KeeperHyperCoreOracle.Update[](1);
        ups[0] = KeeperHyperCoreOracle.Update(idx, bid, ask, 10e18, 12e18, 777, tMs);
    }

    function _push(uint256 bid, uint256 ask, uint64 tMs) internal {
        vm.prank(keeper);
        oracle.push(_u(HYPE_USDC, bid, ask, tMs));
    }

    // ---------------------------------------------------------------- oracle

    function test_pushAndRead() public {
        vm.expectEmit(address(oracle));
        emit KeeperHyperCoreOracle.BboUpdated(HYPE_USDC, 25e18, 25.01e18, 777, T0_SEC * 1000 - 100);
        _push(25e18, 25.01e18, T0_SEC * 1000 - 100);

        IHyperCoreOracle.Bbo memory b = oracle.bbo(HYPE_USDC);
        assertEq(b.bid, 25e18);
        assertEq(b.ask, 25.01e18);
        assertEq(b.bidSz, 10e18);
        assertEq(b.askSz, 12e18);
        assertEq(b.coreBlock, 777);
        assertEq(b.l2Block, 1_000, "must use ArbSys L2 block, not parent block.number");

        HyperCoreReader.Quote memory q = reader.read(oracle, HYPE_USDC, guard);
        assertEq(q.mid, 25.005e18);
        assertEq(q.spreadBps, 4); // 0.01/25.005 = 3.999bps, rounded up
    }

    function test_unknownMarketReturnsZero() public view {
        assertEq(oracle.bbo(42).coreTimeMs, 0);
    }

    function test_onlyUpdater() public {
        vm.expectRevert(abi.encodeWithSelector(KeeperHyperCoreOracle.NotUpdater.selector, address(this)));
        oracle.push(_u(HYPE_USDC, 1e18, 2e18, T0_SEC * 1000));
    }

    function test_onlyOwnerAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vm.prank(keeper);
        oracle.setUpdater(keeper, false);

        vm.prank(owner);
        oracle.setUpdater(keeper, false);
        vm.expectRevert(abi.encodeWithSelector(KeeperHyperCoreOracle.NotUpdater.selector, keeper));
        _push(1e18, 2e18, T0_SEC * 1000);
    }

    function test_rejectsCrossedLockedAndZero() public {
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(KeeperHyperCoreOracle.InvalidBook.selector, HYPE_USDC, 2e18, 1e18));
        oracle.push(_u(HYPE_USDC, 2e18, 1e18, T0_SEC * 1000));
        vm.expectRevert(abi.encodeWithSelector(KeeperHyperCoreOracle.InvalidBook.selector, HYPE_USDC, 1e18, 1e18));
        oracle.push(_u(HYPE_USDC, 1e18, 1e18, T0_SEC * 1000));
        vm.expectRevert(abi.encodeWithSelector(KeeperHyperCoreOracle.InvalidBook.selector, HYPE_USDC, 0, 1e18));
        oracle.push(_u(HYPE_USDC, 0, 1e18, T0_SEC * 1000));
    }

    function test_rejectsOverflow() public {
        uint256 tooBig = uint256(type(uint96).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintDowncast.selector, 96, tooBig));
        _push(tooBig, tooBig + 1, T0_SEC * 1000);
    }

    function test_rejectsFutureTimestamp() public {
        // allowed: now + 1000 (second resolution) + 500 drift
        _push(1e18, 2e18, T0_SEC * 1000 + 1_500);
        uint64 bad = T0_SEC * 1000 + 1_501;
        vm.expectRevert(
            abi.encodeWithSelector(KeeperHyperCoreOracle.TimestampInFuture.selector, HYPE_USDC, bad, T0_SEC * 1000)
        );
        _push(1e18, 2e18, bad);
    }

    function test_skipsOutOfOrderWithoutRevertingBatch() public {
        _push(25e18, 26e18, T0_SEC * 1000);

        KeeperHyperCoreOracle.Update[] memory ups = new KeeperHyperCoreOracle.Update[](2);
        ups[0] = KeeperHyperCoreOracle.Update(HYPE_USDC, 1e18, 2e18, 0, 0, 0, T0_SEC * 1000 - 1); // older
        ups[1] = KeeperHyperCoreOracle.Update(1137, 4000e18, 4001e18, 0, 0, 0, T0_SEC * 1000); // other market

        vm.expectEmit(address(oracle));
        emit KeeperHyperCoreOracle.UpdateSkipped(HYPE_USDC, T0_SEC * 1000 - 1, T0_SEC * 1000);
        vm.prank(keeper);
        oracle.push(ups);

        assertEq(oracle.bbo(HYPE_USDC).bid, 25e18, "stale update must not overwrite");
        assertEq(oracle.bbo(1137).bid, 4000e18, "rest of batch still applied");
    }

    // ---------------------------------------------------------------- reader guards

    function test_reader_noData() public {
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.NoData.selector, HYPE_USDC));
        reader.read(oracle, HYPE_USDC, guard);
    }

    function test_reader_staleByTime() public {
        _push(25e18, 25.01e18, T0_SEC * 1000);
        vm.warp(T0_SEC + 2);
        reader.read(oracle, HYPE_USDC, guard); // age 2000 == max, ok
        vm.warp(T0_SEC + 3);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.StaleByTime.selector, HYPE_USDC, 3_000, 2_000));
        reader.read(oracle, HYPE_USDC, guard);
    }

    function test_reader_staleByBlocks() public {
        _push(25e18, 25.01e18, T0_SEC * 1000);
        arbSys.set(1_010);
        reader.read(oracle, HYPE_USDC, guard);
        arbSys.set(1_011);
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.StaleByBlocks.selector, HYPE_USDC, 11, 10));
        reader.read(oracle, HYPE_USDC, guard);
    }

    function test_reader_spreadTooWide() public {
        _push(25e18, 26e18, T0_SEC * 1000); // ~392 bps
        vm.expectRevert(abi.encodeWithSelector(HyperCoreReader.SpreadTooWide.selector, HYPE_USDC, 393, 100));
        reader.read(oracle, HYPE_USDC, guard);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_quoteInvariants(uint96 bid, uint96 gap) public {
        bid = uint96(bound(bid, 1, type(uint96).max - 1));
        gap = uint96(bound(gap, 1, type(uint96).max - bid));
        _push(bid, uint256(bid) + gap, T0_SEC * 1000);

        HyperCoreReader.Guard memory open = HyperCoreReader.Guard(type(uint32).max, type(uint32).max, type(uint16).max);
        IHyperCoreOracle.Bbo memory b = oracle.bbo(HYPE_USDC);
        uint256 s = HyperCoreReader.spreadBps(b.bid, b.ask);
        vm.assume(s <= type(uint16).max);

        HyperCoreReader.Quote memory q = reader.read(oracle, HYPE_USDC, open);
        assertGe(q.mid, q.bid);
        assertLt(q.mid, q.ask);
        assertGt(q.spreadBps, 0);
        // rounded-up spread never understates the true spread
        assertGe(q.spreadBps * q.mid, (q.ask - q.bid) * 10_000);
    }

    function testFuzz_latestTimestampWins(uint64 t1, uint64 t2) public {
        uint64 nowMs = T0_SEC * 1000;
        t1 = uint64(bound(t1, 1, nowMs));
        t2 = uint64(bound(t2, 1, nowMs));
        _push(1e18, 2e18, t1);
        _push(3e18, 4e18, t2);
        IHyperCoreOracle.Bbo memory b = oracle.bbo(HYPE_USDC);
        assertEq(b.coreTimeMs, t2 > t1 ? t2 : t1);
        assertEq(b.bid, t2 > t1 ? 3e18 : 1e18);
    }
}
