// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AscendAdapterBase} from "../../src/launch/AscendAdapterBase.sol";
import {IAscendAdapter} from "../../src/launch/IAscendAdapter.sol";
import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";
import {AscendAuditBase, AuditToken} from "./AscendAuditBase.sol";

/// Stands in for Ascend: launches a token and sells it for USDC, filling all or part of a buy.
contract MockAscend {
    uint256 public constant TOKENS_PER_USDC_UNIT = 100;

    IERC20 public immutable usdc;
    uint256 public fillBps = 10_000;
    bool public fail;
    address public callback;
    bytes public callbackData;
    address[] internal _creators;
    string public lastName;
    string public lastSymbol;
    bytes public lastData;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    function set(uint256 fillBps_, bool fail_) external {
        fillBps = fillBps_;
        fail = fail_;
    }

    function setCallback(address target, bytes calldata data) external {
        callback = target;
        callbackData = data;
    }

    function creators() external view returns (address[] memory) {
        return _creators;
    }

    function launch(address[] calldata creators_, string calldata name, string calldata symbol, bytes calldata data)
        external
        returns (address token, bytes32 pool)
    {
        require(!fail, "ascend: failed");
        _creators = creators_;
        lastName = name;
        lastSymbol = symbol;
        lastData = data;
        _callBack();
        token = address(new AuditToken(18));
        pool = keccak256(abi.encode("pool", token));
    }

    function buy(address token, uint256 amount) external {
        require(!fail, "ascend: failed");
        _callBack();
        uint256 spent = amount * fillBps / 10_000;
        if (spent > 0) usdc.transferFrom(msg.sender, address(this), spent);
        AuditToken(token).mint(msg.sender, spent * TOKENS_PER_USDC_UNIT);
    }

    function _callBack() internal {
        if (callback == address(0)) return;
        (bool ok, bytes memory ret) = callback.call(callbackData);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// What the real adapter will look like: the base plus the two calls into Ascend.
contract ExampleAdapter is AscendAdapterBase {
    using SafeERC20 for IERC20;

    MockAscend public immutable ascend;

    constructor(address launcher_, MockAscend ascend_) AscendAdapterBase(launcher_) {
        ascend = ascend_;
    }

    function _launchOnAscend(
        address[] calldata creators,
        string calldata name,
        string calldata symbol,
        bytes calldata launchData
    ) internal override returns (address token, bytes32 pool) {
        return ascend.launch(creators, name, symbol, launchData);
    }

    function _buyOnAscend(address token, bytes32, uint256 quoteIn) internal override {
        quote.forceApprove(address(ascend), quoteIn);
        ascend.buy(token, quoteIn);
        quote.forceApprove(address(ascend), 0);
    }
}

/// The adapter base, through the real launcher, with Ascend mocked: only the launcher can use it, so nobody gets around the
/// identity rules, and after a buy it holds nothing.
contract AuditAdapterBaseTest is AscendAuditBase {
    uint256 constant BUY = 100e6;

    MockAscend ascend;
    ExampleAdapter base;
    address stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        ascend = new MockAscend(usdc);
        base = new ExampleAdapter(address(launcher), ascend);
        vm.prank(owner);
        launcher.setAdapter(base);
    }

    function _launchWithBuy(uint256 buy, uint256 min) internal returns (address) {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        return launcher.launch(p, sig, buy, min);
    }

    function _assertHoldsNothing(address token) internal view {
        assertEq(usdc.balanceOf(address(base)), 0);
        assertEq(usdc.balanceOf(address(launcher)), 0);
        assertEq(IERC20(token).balanceOf(address(base)), 0);
        assertEq(IERC20(token).balanceOf(address(launcher)), 0);
        assertEq(usdc.allowance(address(base), address(ascend)), 0);
    }

    // ------------------------------------------------------------------ only the launcher

    /// The rule that matters most: calling the adapter directly would launch around every identity rule.
    function test_onlyTheLauncherCanLaunchOrBuy() public {
        address[5] memory others = [stranger, alice, owner, guardian, address(ascend)];
        address[] memory creators = new address[](1);
        creators[0] = stranger;
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
            base.launch(creators, "@elonmusk", "ELONMUSK", "");
            vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
            base.firstBuy(address(usdc), bytes32(0), others[i], 1);
            vm.stopPrank();
        }
        assertEq(ascend.lastSymbol(), "");
    }

    function testFuzz_nobodyElseCanCallIt(address caller) public {
        vm.assume(caller != address(launcher));
        address[] memory creators = new address[](1);
        vm.startPrank(caller);
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        base.launch(creators, "x", "X", "");
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        base.firstBuy(address(usdc), bytes32(0), caller, 0);
        vm.stopPrank();
    }

    /// USDC sitting in the adapter can't be walked off with by calling it directly.
    function test_nobodyCanDrainItDirectly() public {
        usdc.mint(address(base), 5e6);
        vm.prank(stranger);
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        base.firstBuy(address(usdc), bytes32(0), stranger, 0);
        assertEq(usdc.balanceOf(address(base)), 5e6);
    }

    function test_readsItsSettingsFromTheLauncher() public view {
        assertEq(base.launcher(), address(launcher));
        assertEq(address(base.quote()), address(launcher.quote()));
    }

    function test_needsARealLauncher() public {
        vm.expectRevert();
        new ExampleAdapter(makeAddr("no code here"), ascend);
    }

    // ------------------------------------------------------------------ launching through it

    function test_personalLaunchReachesAscend() public {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        p.launchData = hex"c0ffee";
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        address token = launcher.launch(p, sig, 0, 0);
        assertEq(ascend.lastName(), "@alice");
        assertEq(ascend.lastSymbol(), "ALICE");
        assertEq(ascend.lastData(), hex"c0ffee");
        assertEq(ascend.creators().length, 1);
        assertEq(ascend.creators()[0], alice);
        assertEq(launcher.launchOf(token).pool, keccak256(abi.encode("pool", token)));
    }

    function test_ftfLaunchReachesAscendWithAllFourMembers() public {
        _launchFtf("Degen Den", "DEN");
        address[4] memory members = [alice, bob, carol, dan];
        assertEq(ascend.lastName(), "Degen Den");
        assertEq(ascend.lastSymbol(), "DEN");
        assertEq(ascend.creators().length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(ascend.creators()[i], members[i]);
        }
    }

    function test_identityRulesStillApply() public {
        _launch(alice, 1, "alice");
        NeuriioLauncher.LaunchPass memory p = _pass(bob, 1, "bob");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
        launcher.launch(p, sig, 0, 0);
    }

    function test_ascendFailingLeavesNoTrace() public {
        _fund(alice, BUY);
        ascend.set(10_000, true);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert("ascend: failed");
        launcher.launch(p, sig, BUY, 0);
        assertEq(launcher.tokenOfXUser(1), address(0));
        assertEq(usdc.balanceOf(alice), BUY);
    }

    // ------------------------------------------------------------------ first buy through it

    function test_firstBuyEverythingReachesTheBuyer() public {
        _fund(alice, BUY);
        address token = _launchWithBuy(BUY, 1);
        assertEq(IERC20(token).balanceOf(alice), BUY * ascend.TOKENS_PER_USDC_UNIT());
        assertEq(usdc.balanceOf(address(ascend)), BUY);
        assertEq(usdc.balanceOf(alice), 0);
        _assertHoldsNothing(token);
    }

    /// Whatever fraction Ascend fills: the buyer gets those tokens and the rest of their USDC back, and nothing stays behind.
    function testFuzz_partialFillsAddUp(uint96 rawBuy, uint16 rawFill) public {
        uint256 buy = bound(rawBuy, 1, 1e15);
        uint256 fill = bound(rawFill, 0, 10_000);
        uint256 spent = buy * fill / 10_000;
        vm.assume(spent > 0);
        ascend.set(fill, false);
        _fund(alice, buy);
        address token = _launchWithBuy(buy, 1);
        assertEq(IERC20(token).balanceOf(alice), spent * ascend.TOKENS_PER_USDC_UNIT());
        assertEq(usdc.balanceOf(alice), buy - spent);
        assertEq(usdc.balanceOf(address(ascend)), spent);
        _assertHoldsNothing(token);
    }

    function test_noTokensUndoesTheWholeLaunch() public {
        ascend.set(0, false);
        _fund(alice, BUY);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, 0, 0));
        launcher.launch(p, sig, BUY, 0);
        assertEq(launcher.tokenOfXUser(1), address(0));
        assertEq(usdc.balanceOf(alice), BUY);
    }

    function test_belowTheMinimumUndoesTheWholeLaunch() public {
        _fund(alice, BUY);
        uint256 out = BUY * ascend.TOKENS_PER_USDC_UNIT();
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, out, out + 1));
        launcher.launch(p, sig, BUY, out + 1);
        assertEq(usdc.balanceOf(alice), BUY);
    }

    /// I-06: USDC donated to the adapter goes to the next buyer, and can't be used to block a launch.
    function test_I06_donationsGoToTheNextBuyer() public {
        usdc.mint(address(base), 5e6);
        _fund(alice, BUY);
        address token = _launchWithBuy(BUY, 1);
        assertEq(usdc.balanceOf(alice), 5e6);
        _assertHoldsNothing(token);
    }

    function test_noBuyLeavesDonationsAlone() public {
        usdc.mint(address(base), 5e6);
        _launch(alice, 1, "alice");
        assertEq(usdc.balanceOf(address(base)), 5e6);
    }

    // ------------------------------------------------------------------ Ascend calling back

    function test_ascendCantCallBackIntoTheAdapter() public {
        _fund(alice, BUY);
        address[] memory creators = new address[](1);
        ascend.setCallback(address(base), abi.encodeCall(IAscendAdapter.launch, (creators, "x", "X", "")));
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        launcher.launch(p, sig, 0, 0);

        ascend.setCallback(
            address(base), abi.encodeCall(IAscendAdapter.firstBuy, (address(usdc), bytes32(0), stranger, 0))
        );
        vm.prank(alice);
        vm.expectRevert(AscendAdapterBase.NotLauncher.selector);
        launcher.launch(p, sig, BUY, 0);
    }

    function test_ascendCantCallBackIntoTheLauncher() public {
        NeuriioLauncher.LaunchPass memory inner = _pass(address(ascend), 2, "bob");
        bytes memory innerSig = _sign(inner, signerPk);
        ascend.setCallback(address(launcher), abi.encodeCall(NeuriioLauncher.launch, (inner, innerSig, 0, 0)));
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        launcher.launch(p, sig, 0, 0);
    }
}
