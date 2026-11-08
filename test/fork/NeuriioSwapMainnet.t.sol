// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioSwap} from "../../src/trade/NeuriioSwap.sol";
import {IPermit2, IUniversalRouter, PoolKey} from "../../src/launch/AscendAdapter.sol";

/// NeuriioSwap against LIVE pools on an Elysium mainnet fork (user, 2026-11-07), one of each pair type:
///  - WHYPE: Ascend's top tokens (e/acc, Ascend Cat): the user pays and receives plain HYPE, wrapped/unwrapped here
///  - native HYPE: a Montra pool (CHAMELEON)
///  - an ERC-20 pair: an Ascend USDC pool
/// Each checks our 0.5% (in, on buys; out, on sells), that the user gets everything else, and that nothing is left behind.
///   ELYSIUM_MAINNET_RPC=<url> forge test --match-path test/fork/NeuriioSwapMainnet.t.sol -vv
/// Without it, every test is skipped.
contract NeuriioSwapMainnetForkTest is Test {
    address constant ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a; // Uniswap UniversalRouter 2.2.0
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address constant FEE_WALLET = 0xB153AA503a2C95fC175275D6b93415869A77e3d1;
    address constant SAFE = 0x68Ed49C77dF7fB4928510d5Ac65C6074674D264E;
    address constant TIMELOCK = 0x784439860cD5c58dAad8fDcfB96c2Bba901e6eA9;
    address constant ASCEND_HOOK = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC; // Ascend's launchpad
    address constant MONTRA_HOOK = 0x6b1216A40B65c83e9c9e18a562C446697B8cf8EC;
    address constant EACC = 0x8df4f39d592de2aAee15838B265C2392d19A4128; // Ascend, WHYPE pair, top of the list
    address constant ACAT = 0x193Ea6f034112491749c64556931345076d995F6; // Ascend, WHYPE pair
    address constant CHAMELEON = 0xd662D66eC991A3eae4EcBdA34327264c53d4cF38; // Montra, native HYPE pair
    address constant USDC_COIN = 0x0223C17eB2cc141750a7C608d5CEb6db9368F606; // Ascend, USDC pair

    NeuriioSwap swap;
    bool live;
    address alice = makeAddr("alice");

    /// Ascend's pool for a token and its pair: sorted currencies, dynamic fee, tick spacing 200, Ascend's launchpad as the hook.
    function _ascendKey(address token, address quote) internal pure returns (PoolKey memory) {
        (address c0, address c1) = token < quote ? (token, quote) : (quote, token);
        return PoolKey(c0, c1, 0x800000, 200, ASCEND_HOOK);
    }

    function setUp() public {
        string memory url = vm.envOr("ELYSIUM_MAINNET_RPC", string(""));
        live = bytes(url).length > 0;
        if (!live) return;
        vm.createSelectFork(url);
        swap = new NeuriioSwap(TIMELOCK, IUniversalRouter(ROUTER), IPermit2(PERMIT2), WHYPE, FEE_WALLET, SAFE);
        vm.startPrank(TIMELOCK);
        swap.setPool(_ascendKey(EACC, WHYPE), EACC, true);
        swap.setPool(_ascendKey(ACAT, WHYPE), ACAT, true);
        swap.setPool(PoolKey(address(0), CHAMELEON, 0x800000, 200, MONTRA_HOOK), CHAMELEON, true);
        swap.setPool(_ascendKey(USDC_COIN, USDC), USDC_COIN, true);
        vm.stopPrank();
        vm.deal(alice, 100 ether);
    }

    function _nothingLeft(address token) internal view {
        assertEq(address(swap).balance, 0, "no HYPE left in the contract");
        assertEq(IERC20(WHYPE).balanceOf(address(swap)), 0, "no WHYPE left in the contract");
        assertEq(IERC20(token).balanceOf(address(swap)), 0, "no tokens left in the contract");
        assertEq(IERC20(WHYPE).allowance(address(swap), PERMIT2), 0, "no WHYPE allowance left open");
        assertEq(IERC20(token).allowance(address(swap), PERMIT2), 0, "no token allowance left open");
    }

    /// Buy with 1 HYPE then sell everything back, for a token paid in HYPE (a WHYPE or a native-HYPE pool).
    function _roundTripInHype(address token) internal returns (uint256 got, uint256 back) {
        uint256 fee0 = FEE_WALLET.balance;
        vm.prank(alice);
        got = swap.buy{value: 1 ether}(token, 1 ether, 1, alice, block.timestamp + 60);
        assertEq(FEE_WALLET.balance - fee0, 0.005 ether, "buy: our fee is 0.5% of the HYPE in, in HYPE");
        assertEq(IERC20(token).balanceOf(alice), got, "buy: the buyer got every token");
        _nothingLeft(token);

        uint256 fee1 = FEE_WALLET.balance;
        uint256 a0 = alice.balance;
        vm.startPrank(alice);
        IERC20(token).approve(address(swap), got);
        back = swap.sell(token, got, 1, alice, block.timestamp + 60);
        vm.stopPrank();
        uint256 fee = FEE_WALLET.balance - fee1;
        assertEq(alice.balance - a0, back, "sell: the seller got plain HYPE");
        assertEq(fee, (back + fee) * 50 / 10_000, "sell: our fee is 0.5% of the HYPE out");
        _nothingLeft(token);
    }

    function test_fork_ascend_whype_pair_eacc() public {
        vm.skip(!live);
        (uint256 got, uint256 back) = _roundTripInHype(EACC);
        emit log_named_uint("e/acc for 1 HYPE", got);
        emit log_named_uint("HYPE back (wei)", back);
        assertGt(back, 0.9 ether, "round trip: Ascend's fee each way + ours 0.5% each way");
    }

    function test_fork_ascend_whype_pair_acat() public {
        vm.skip(!live);
        (uint256 got, uint256 back) = _roundTripInHype(ACAT);
        emit log_named_uint("ACAT for 1 HYPE", got);
        emit log_named_uint("HYPE back (wei)", back);
        assertGt(back, 0.9 ether);
    }

    function test_fork_montra_native_pair_chameleon() public {
        vm.skip(!live);
        (, uint256 back) = _roundTripInHype(CHAMELEON);
        assertGt(back, 0.95 ether, "Montra ~1% each way + ours 0.5% each way");
    }

    function test_fork_ascend_usdc_pair() public {
        vm.skip(!live);
        deal(USDC, alice, 10e6);
        uint256 fee0 = IERC20(USDC).balanceOf(FEE_WALLET);
        vm.startPrank(alice);
        IERC20(USDC).approve(address(swap), 1e6);
        uint256 got = swap.buy(USDC_COIN, 1e6, 1, alice, block.timestamp + 60);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(FEE_WALLET) - fee0, 5000, "buy: our fee is 0.5% of the USDC in, in USDC");
        assertGt(got, 0);
        _nothingLeft(USDC_COIN);
        assertEq(IERC20(USDC).balanceOf(address(swap)), 0, "no USDC left");

        uint256 fee1 = IERC20(USDC).balanceOf(FEE_WALLET);
        uint256 u0 = IERC20(USDC).balanceOf(alice);
        vm.startPrank(alice);
        IERC20(USDC_COIN).approve(address(swap), got);
        uint256 back = swap.sell(USDC_COIN, got, 1, alice, block.timestamp + 60);
        vm.stopPrank();
        uint256 fee = IERC20(USDC).balanceOf(FEE_WALLET) - fee1;
        assertEq(IERC20(USDC).balanceOf(alice) - u0, back, "sell: the seller got USDC");
        assertEq(fee, (back + fee) * 50 / 10_000, "sell: our fee is 0.5% of the USDC out");
        assertEq(IERC20(USDC).balanceOf(address(swap)), 0, "no USDC left");
        emit log_named_uint("USDC back for 1 USDC (6 dec)", back);
    }

    function test_fork_value_must_match_the_pair() public {
        vm.skip(!live);
        vm.startPrank(alice);
        vm.expectRevert(NeuriioSwap.WrongValue.selector); // HYPE pair: value must equal amountIn
        swap.buy{value: 0.5 ether}(EACC, 1 ether, 1, alice, block.timestamp + 60);
        vm.expectRevert(NeuriioSwap.WrongValue.selector); // USDC pair: no HYPE may be sent
        swap.buy{value: 1 ether}(USDC_COIN, 1e6, 1, alice, block.timestamp + 60);
        vm.stopPrank();
    }

    function test_fork_minimums_deadline_approval_pause() public {
        vm.skip(!live);
        vm.startPrank(alice);
        vm.expectRevert();
        swap.buy{value: 1 ether}(EACC, 1 ether, type(uint256).max, alice, block.timestamp + 60);
        vm.expectRevert(NeuriioSwap.Expired.selector);
        swap.buy{value: 1 ether}(EACC, 1 ether, 1, alice, block.timestamp - 1);
        vm.stopPrank();

        vm.prank(TIMELOCK);
        swap.setPool(_ascendKey(EACC, WHYPE), EACC, false);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioSwap.NotApproved.selector, EACC));
        swap.buy{value: 1 ether}(EACC, 1 ether, 1, alice, block.timestamp + 60);

        vm.prank(SAFE);
        swap.pause();
        vm.prank(alice);
        vm.expectRevert();
        swap.buy{value: 1 ether}(ACAT, 1 ether, 1, alice, block.timestamp + 60);
    }
}
