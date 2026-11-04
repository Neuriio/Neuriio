// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";
import {NeuriioTokenStaking, ILaunchedTokens} from "../../src/stake/NeuriioTokenStaking.sol";
import {
    AscendAdapter,
    ExactInputSingleParams,
    IAscendEscrowFactory,
    IAscendSeatFactory,
    IPermit2,
    IUniversalRouter,
    PoolKey
} from "../../src/launch/AscendAdapter.sol";

interface IAscendLaunchpadView {
    function currentFee(bytes32 poolId) external view returns (uint24);
    function paused() external view returns (bool);
}

interface IEscrowFactoryView {
    function escrowOf(bytes32 poolId) external view returns (address);
}

interface ICreatorEscrow {
    function builder() external view returns (address);
    function recipient() external view returns (address);
    function builderFee() external view returns (uint24);
    function builderOwed() external view returns (uint256);
    function settle() external;
    function claimBuilder() external returns (uint256);
}

/// The real AscendAdapter against Ascend's LIVE contracts on a fork of Elysium mainnet (chain 99901; addresses from
/// ascendlaunch.gitbook.io/docs/developers/mainnet-contracts, 2026-11-04). Launches a person and an FTF through our launcher
/// with a first buy, checks the fee is 1.5% with our 0.5% as the builder fee and the creator as the recipient, has a
/// trader trade, then settles the escrow and claims the builder fee to our builder address. Needs a mainnet RPC:
///   ELYSIUM_MAINNET_RPC=<url> forge test --match-path test/fork/AscendMainnet.t.sol -vv
/// Without it, every test is skipped.
contract AscendMainnetForkTest is Test {
    address constant ESCROW_FACTORY = 0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19;
    address constant SEAT_FACTORY = 0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1;
    address constant LAUNCHPAD = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address constant ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant BUILDER = 0xB153AA503a2C95fC175275D6b93415869A77e3d1;

    bool live;
    uint256 signerPk = 0xA11CE;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address trader = makeAddr("trader");
    NeuriioLauncher launcher;
    NeuriioTokenStaking staking;
    AscendAdapter adapter;

    function setUp() public {
        string memory url = vm.envOr("ELYSIUM_MAINNET_RPC", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        require(block.chainid == 99_901, "not Elysium mainnet");
        live = true;
        launcher = new NeuriioLauncher(owner, IERC20(USDC), vm.addr(signerPk), owner);
        staking = new NeuriioTokenStaking(IERC20(USDC), ILaunchedTokens(address(launcher)));
        adapter = new AscendAdapter(
            address(launcher),
            IAscendEscrowFactory(ESCROW_FACTORY),
            IAscendSeatFactory(SEAT_FACTORY),
            IUniversalRouter(ROUTER),
            IPermit2(PERMIT2),
            BUILDER
        );
        vm.prank(owner);
        launcher.setAdapter(adapter);
    }

    function _launch(uint256 quoteIn) internal returns (address token, bytes32 pool) {
        string memory handle = string.concat("nfork", vm.toString(block.number % 1e6));
        NeuriioLauncher.LaunchPass memory p = NeuriioLauncher.LaunchPass(
            alice, 9_999_001, handle, 1, keccak256("profile"), "", block.timestamp + 1 hours
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashLaunchPass(p));
        deal(USDC, alice, quoteIn);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(launcher), quoteIn);
        token = launcher.launch(p, abi.encodePacked(r, s, v), quoteIn, 1);
        vm.stopPrank();
        pool = launcher.launchOf(token).pool;
    }

    function test_fork_launch_feeAndRoute() public {
        vm.skip(!live);
        assertFalse(IAscendLaunchpadView(LAUNCHPAD).paused(), "Ascend launches paused");
        (address token, bytes32 pool) = _launch(10e6);
        assertGt(IERC20(token).balanceOf(alice), 0, "first buy got no tokens");
        assertEq(IERC20(USDC).balanceOf(address(adapter)), 0);
        assertEq(IERC20(token).balanceOf(address(adapter)), 0);
        assertEq(IAscendLaunchpadView(LAUNCHPAD).currentFee(pool), 15_000, "fee is not 1.5%");
        ICreatorEscrow escrow = ICreatorEscrow(IEscrowFactoryView(ESCROW_FACTORY).escrowOf(pool));
        assertEq(escrow.builder(), BUILDER);
        assertEq(escrow.builderFee(), 5_000);
        assertEq(escrow.recipient(), alice);
        assertTrue(staking.isStakeable(token));
    }

    function test_fork_ftf_launches() public {
        vm.skip(!live);
        address[4] memory m = [alice, makeAddr("bob"), makeAddr("carol"), makeAddr("dan")];
        NeuriioLauncher.FtfPass memory p = NeuriioLauncher.FtfPass(
            alice, "Fork Den", "FDEN", [uint64(1), 2, 3, 4], m, keccak256("profile"), "", block.timestamp + 1 hours
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashFtfPass(p));
        deal(USDC, alice, 5e6);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(launcher), 5e6);
        address token = launcher.launchFtf(p, abi.encodePacked(r, s, v), 5e6, 1);
        vm.stopPrank();
        bytes32 pool = launcher.launchOf(token).pool;
        assertEq(IAscendLaunchpadView(LAUNCHPAD).currentFee(pool), 15_000);
        assertGt(IERC20(token).balanceOf(alice), 0);
    }

    /// A trader buys 1,000 USDC; settling the escrow and claiming pays our builder address 0.5% of it.
    function test_fork_builderFee_reachesOurAddress() public {
        vm.skip(!live);
        (address token, bytes32 pool) = _launch(0);
        _buy(token, 1_000e6);
        ICreatorEscrow escrow = ICreatorEscrow(IEscrowFactoryView(ESCROW_FACTORY).escrowOf(pool));
        uint256 before = IERC20(USDC).balanceOf(BUILDER);
        escrow.settle();
        uint256 owed = escrow.builderOwed();
        escrow.claimBuilder();
        uint256 got = IERC20(USDC).balanceOf(BUILDER) - before;
        emit log_named_uint("builder fee on a 1,000 USDC buy (USDC base units)", got);
        assertGt(owed, 0);
        assertApproxEqAbs(got, 5e6, 1, "builder fee is not 0.5%");
    }

    /// The same swap the adapter's first buy sends, from a trader.
    function _buy(address token, uint256 usdcIn) internal {
        PoolKey memory key = adapter.poolKeyOf(token);
        deal(USDC, trader, usdcIn);
        vm.startPrank(trader);
        IERC20(USDC).approve(PERMIT2, usdcIn);
        IPermit2(PERMIT2).approve(USDC, ROUTER, uint160(usdcIn), uint48(block.timestamp));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams(key, key.currency0 == USDC, uint128(usdcIn), 0, 0, ""));
        params[1] = abi.encode(USDC, usdcIn);
        params[2] = abi.encode(token, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(hex"060c0f", params);
        IUniversalRouter(ROUTER).execute(hex"10", inputs, block.timestamp);
        vm.stopPrank();
        assertGt(IERC20(token).balanceOf(trader), 0, "trader got no tokens");
    }
}
