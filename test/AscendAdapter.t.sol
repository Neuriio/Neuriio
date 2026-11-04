// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioLauncher} from "../src/launch/NeuriioLauncher.sol";
import {AscendAdapterBase} from "../src/launch/AscendAdapterBase.sol";
import {
    AscendAdapter,
    AscendLaunchParams,
    AscendRoute,
    ExactInputSingleParams,
    IAscendEscrowFactory,
    IAscendSeatFactory,
    IPermit2,
    IUniversalRouter
} from "../src/launch/AscendAdapter.sol";
import {MockEscrowFactoryV5, MockPermit2, MockSeatFactoryV5, MockUniversalRouter} from "./mocks/MockAscendV5.sol";

contract USDC6 is ERC20("USD Coin", "USDC") {
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// The real AscendAdapter against stand-ins for Ascend V5 (test/mocks/MockAscendV5.sol), through the real launcher.
contract AscendAdapterTest is Test {
    address constant BUILDER = 0xB153AA503a2C95fC175275D6b93415869A77e3d1; // ours, approved by Ascend (user, 2026-11-04)
    address hookAddr = makeAddr("ascend launchpad");
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    uint256 signerPk = 0xA11CE;

    USDC6 usdc;
    NeuriioLauncher launcher;
    MockPermit2 permit2;
    MockUniversalRouter router;
    MockEscrowFactoryV5 factory;
    MockSeatFactoryV5 seats;
    AscendAdapter adapter;

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new USDC6();
        launcher = new NeuriioLauncher(owner, usdc, vm.addr(signerPk), owner);
        permit2 = new MockPermit2();
        router = new MockUniversalRouter(permit2, hookAddr);
        factory = new MockEscrowFactoryV5(hookAddr, address(usdc), address(router));
        seats = new MockSeatFactoryV5(address(factory), hookAddr, address(usdc), address(router));
        adapter = _adapter(address(seats));
        vm.prank(owner);
        launcher.setAdapter(adapter);
    }

    function _adapter(address seatFactory) internal returns (AscendAdapter) {
        return new AscendAdapter(
            address(launcher),
            IAscendEscrowFactory(address(factory)),
            IAscendSeatFactory(seatFactory),
            IUniversalRouter(address(router)),
            IPermit2(address(permit2)),
            BUILDER
        );
    }

    function _launch(address creator, uint64 xId, string memory handle, uint256 quoteIn)
        internal
        returns (address token)
    {
        NeuriioLauncher.LaunchPass memory p = NeuriioLauncher.LaunchPass(
            creator, xId, handle, 1, keccak256("profile"), "", block.timestamp + 15 minutes
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashLaunchPass(p));
        if (quoteIn > 0) {
            usdc.mint(creator, quoteIn);
            vm.prank(creator);
            usdc.approve(address(launcher), quoteIn);
        }
        vm.prank(creator);
        token = launcher.launch(p, abi.encodePacked(r, s, v), quoteIn, 1);
    }

    function test_launch_ascendsBaseFeePlusOurBuilderFee_creatorIsPaid() public {
        address token = _launch(alice, 1, "alice", 0);
        (
            string memory name,
            string memory symbol,
            address quote,
            uint256 devBuy,,,
            address creator,
            uint24 fee,
            uint24 bfee
        ) = factory.lastP();
        assertEq(name, "@alice");
        assertEq(symbol, "ALICE");
        assertEq(quote, address(usdc));
        assertEq(devBuy, 0);
        assertEq(creator, address(0)); // the escrow is the creator
        assertEq(fee, 10_000); // 1%
        assertEq(bfee, 5_000); // 0.5%, ours
        (address recipient, address dev, address builder, bool cto) = factory.lastR();
        assertEq(recipient, alice); // the creator's share of Ascend's fee
        assertEq(dev, address(adapter));
        assertEq(builder, BUILDER);
        assertFalse(cto); // a token belongs to its X account
        assertEq(launcher.launchOf(token).pool, keccak256(abi.encode(adapter.poolKeyOf(token))));
        assertTrue(launcher.isLaunched(token));
    }

    function test_ftf_splitsTheCreatorShareFourWays() public {
        address[4] memory m = [alice, makeAddr("bob"), makeAddr("carol"), makeAddr("dan")];
        NeuriioLauncher.FtfPass memory p = NeuriioLauncher.FtfPass(
            alice, "Degen Den", "DEN", [uint64(1), 2, 3, 4], m, keccak256("profile"), "", block.timestamp + 15 minutes
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashFtfPass(p));
        vm.prank(alice);
        address token = launcher.launchFtf(p, abi.encodePacked(r, s, v), 0, 0);
        (address[] memory payees, uint16[] memory bps) = seats.payees();
        assertEq(payees.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(payees[i], m[i]);
            assertEq(bps[i], 2_500);
        }
        assertEq(seats.lastBuilder(), BUILDER);
        (,,,,,,, uint24 fee, uint24 bfee) = seats.lastP();
        assertEq(fee, 10_000);
        assertEq(bfee, 5_000);
        assertTrue(launcher.isLaunched(token));
    }

    function test_firstBuy_swapsExactlyTheUsdcThroughPermit2_andLeavesNothing() public {
        address token = _launch(alice, 1, "alice", 100e6);
        assertEq(IERC20(token).balanceOf(alice), 100e6 * 1e12);
        ExactInputSingleParams memory s = router.last();
        assertEq(s.amountIn, 100e6);
        assertEq(s.zeroForOne, s.poolKey.currency0 == address(usdc)); // paying USDC
        assertEq(s.hookData.length, 0);
        assertEq(router.settleMax(), 100e6);
        // nothing stays: no USDC, no tokens, no allowance left over
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(IERC20(token).balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(permit2)), 0);
        (uint160 left,) = permit2.allowance(address(adapter), address(usdc), address(router));
        assertEq(left, 0);
    }

    /// attack/hygiene: a first buy the pool only half fills leaves no allowance open and refunds the rest of the USDC
    function test_firstBuy_partialFill_refundsAndClosesAllowances() public {
        router.setStopHalfway(true);
        address token = _launch(alice, 1, "alice", 100e6);
        assertEq(IERC20(token).balanceOf(alice), 50e6 * 1e12, "half the tokens");
        assertEq(usdc.balanceOf(alice), 50e6, "the unspent half refunded");
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.allowance(address(adapter), address(permit2)), 0, "USDC -> Permit2 left open");
        (uint160 left,) = permit2.allowance(address(adapter), address(usdc), address(router));
        assertEq(left, 0, "Permit2 -> router left open");
    }

    /// attack: USDC donated to the adapter beforehand can't be kept or taken by anyone but the next buyer
    function test_firstBuy_donationGoesToTheBuyer() public {
        usdc.mint(address(adapter), 7e6);
        _launch(alice, 1, "alice", 10e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(alice), 7e6);
    }

    function test_firstBuy_worksWhicheverSideUsdcSorts() public {
        // launch until we've seen the token sort both before and after USDC
        bool seenBefore;
        bool seenAfter;
        for (uint64 i = 1; i <= 20 && !(seenBefore && seenAfter); ++i) {
            address creator = makeAddr(string.concat("c", vm.toString(i)));
            address token = _launch(creator, i, string.concat("c", vm.toString(i)), 1e6);
            assertEq(IERC20(token).balanceOf(creator), 1e6 * 1e12);
            if (token < address(usdc)) seenBefore = true;
            else seenAfter = true;
        }
        assertTrue(seenBefore && seenAfter, "both orders");
    }

    function test_wrongPoolId_reverts() public {
        factory.setWrongPool(true);
        NeuriioLauncher.LaunchPass memory p =
            NeuriioLauncher.LaunchPass(alice, 1, "alice", 1, keccak256("profile"), "", block.timestamp + 15 minutes);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashLaunchPass(p));
        vm.prank(alice);
        vm.expectRevert(AscendAdapter.WrongPool.selector);
        launcher.launch(p, abi.encodePacked(r, s, v), 0, 0);
    }

    function test_onlyTheLauncher() public {
        address[] memory creators = new address[](1);
        creators[0] = alice;
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        adapter.launch(creators, "@x", "X", "");
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        adapter.firstBuy(address(usdc), bytes32(0), alice, 1);
    }

    function test_setup_refusesAMismatchedSeatFactory() public {
        MockSeatFactoryV5 other =
            new MockSeatFactoryV5(makeAddr("other factory"), hookAddr, address(usdc), address(router));
        vm.expectRevert(AscendAdapter.BadSetup.selector);
        _adapter(address(other));
    }

    function test_setup_readsTheHookFromTheFactory() public view {
        assertEq(adapter.hook(), hookAddr);
        assertEq(adapter.builder(), BUILDER);
    }
}
